/**
 * @file tests/audit/r13-hand-overrides-engine.test.js
 * @description **R13 — `hand_anchors` / `disabled_notes` ne sont plus une
 * capacité morte** (audit `13_FEATURE_COMPLETENESS.md` §F-139, P1).
 *
 * Avant ce lot : l'opérateur épinglait une ancre de main ou désactivait une
 * note dans les éditeurs de position, c'était **validé, persisté (migration
 * 009), relu au rechargement et redessiné à l'écran** — et le moteur ne le
 * lisait jamais. Pire, le seul champ que le moteur *croyait* lire
 * (`note_assignments`) était inerte lui aussi : `MidiPlayer.buildEventList`
 * ne posait aucun `tick` sur les événements, donc la clé `${tick}:${note}` du
 * `HandAssigner` ne pouvait jamais correspondre.
 *
 * Ce fichier instruit les deux chemins **ensemble** — c'est la condition posée
 * par le lot : câbler seulement le playback aurait recréé la divergence
 * live ≠ baké que R16 ferme.
 *
 * Protocole de parité : trace d'octets du harnais L05
 * (`l05-replay-harness.test.js`, horloge virtuelle injectée) pour le chemin
 * LIVE, et rejeu du buffer produit par `MidiBaker` pour le chemin BAKÉ.
 */
import { describe, test, expect } from '@jest/globals';
import { parseMidi } from 'midi-file';
import MidiBaker from '../../src/files/MidiBaker.js';
import HandPositionPlanner from '../../src/midi/adaptation/HandPositionPlanner.js';
import LongitudinalPlanner from '../../src/midi/adaptation/LongitudinalPlanner.js';
import {
  indexHandOverrides,
  isNoteDisabled,
  plannerAnchors
} from '../../src/midi/adaptation/HandOverrides.js';
import { replay, buildMidi, serializeBytes, silentLogger } from './l05-replay-harness.test.js';

const PPQ = 480;
const logger = silentLogger();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Instrument clavier à deux mains, CC 23 (gauche) / CC 24 (droite). */
const KEYBOARD_HANDS = {
  enabled: true,
  mode: 'semitones',
  // Assignation déterministe : < 64 → main gauche (CC 23), >= 64 → droite (CC 24).
  assignment: { mode: 'pitch_split', pitch_split_note: 64, pitch_split_hysteresis: 0 },
  hand_move_semitones_per_sec: 60,
  hands: [
    { id: 'left', cc_position_number: 23, hand_span_semitones: 12 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 12 }
  ]
};

const CAPABILITIES = {
  hands_config: KEYBOARD_HANDS,
  note_range_min: 36,
  note_range_max: 96,
  min_note_interval: 0
};

/** Piste mono-canal : notes `{tick, note, dur}`. */
function noteFile(notes, { channel = 0, ppq = PPQ } = {}) {
  const abs = [];
  notes.forEach((n, i) => {
    abs.push({
      tick: n.tick,
      _i: 2 * i,
      ev: { type: 'noteOn', channel, noteNumber: n.note, velocity: n.vel ?? 100 }
    });
    abs.push({
      tick: n.tick + (n.dur ?? 240),
      _i: 2 * i + 1,
      ev: { type: 'noteOff', channel, noteNumber: n.note, velocity: 0 }
    });
  });
  abs.sort((a, b) => a.tick - b.tick || a._i - b._i);
  let last = 0;
  const track = abs.map((a) => {
    const deltaTime = a.tick - last;
    last = a.tick;
    return { ...a.ev, deltaTime };
  });
  return buildMidi({ ppq, tracks: [track] });
}

/** Base de données double, partagée par le lecteur live et le baker. */
function fakeDb(buffer, overrides, { capabilities = CAPABILITIES } = {}) {
  return {
    getFile: (id) => ({ id, filename: `f${id}.mid`, blob_path: 'x' }),
    getRoutingsByFile: () => [
      {
        id: 1,
        midi_file_id: 1,
        channel: 0,
        device_id: 'devA',
        target_channel: 0,
        enabled: 1,
        hand_position_overrides: overrides
      }
    ],
    getTablaturesByFile: () => [],
    getInstrumentCapabilities: () => capabilities,
    getInstrumentSettings: () => null,
    _buffer: buffer
  };
}

/** Rejoue le chemin LIVE : fichier original + overrides posés sur le routage. */
function replayLive(buffer, overrides, opts = {}) {
  return replay({
    buffer,
    database: fakeDb(buffer, overrides, opts),
    routing: { 0: { device: 'devA', targetChannel: 0, handOverrides: overrides } },
    ...opts.replay
  });
}

/** Bake le fichier avec les mêmes overrides, puis le rejoue SANS paramètre runtime. */
async function bakeAndReplay(buffer, overrides, opts = {}) {
  const baker = new MidiBaker({
    database: fakeDb(buffer, overrides, opts),
    blobStore: { read: () => buffer },
    logger
  });
  const { buffer: baked, stats } = await baker.bake(1);
  const result = await replay({
    buffer: baked,
    routing: { 0: { device: 'devA', targetChannel: 0 } },
    ...opts.replay
  });
  return { ...result, baked, stats };
}

const noteOns = (trace) =>
  trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0).map((e) => e.data1);
const ccs = (trace) =>
  trace.filter((e) => (e.status & 0xf0) === 0xb0 && e.data1 !== 123).map((e) => [e.data1, e.data2]);

// ---------------------------------------------------------------------------
// 1. Normalisation partagée
// ---------------------------------------------------------------------------

describe('R13 · HandOverrides — indexation partagée live / baké', () => {
  test('les trois listes sont indexées comme la simulation client', () => {
    const idx = indexHandOverrides({
      version: 1,
      hand_anchors: [
        { tick: 0, handId: 'left', anchor: 48 },
        { tick: 960, handId: 'right', anchor: 72 },
        { tick: 480, handId: 'left' } // incomplet → ignoré
      ],
      disabled_notes: [
        { tick: 480, note: 64 },
        { tick: 'x', note: 1 }
      ],
      note_assignments: [
        { tick: 0, note: 60, handId: 'right' },
        { tick: 240, note: 62, string: 2, fret: 5 },
        { tick: 240, note: 63 } // ni handId ni (string,fret) → ignoré
      ]
    });
    expect(idx.anchors.get('left').get(0)).toBe(48);
    expect(idx.anchors.get('left').has(480)).toBe(false);
    expect(idx.anchors.get('right').get(960)).toBe(72);
    expect(isNoteDisabled(idx, 480, 64)).toBe(true);
    expect(isNoteDisabled(idx, 480, 65)).toBe(false);
    expect(idx.handPins).toEqual([{ tick: 0, note: 60, handId: 'right' }]);
    expect(idx.stringPins.get('240:62')).toEqual({ string: 2, fret: 5 });
    expect(idx.isEmpty).toBe(false);
  });

  test('payload absent / illisible / vide ⇒ index vide et `plannerAnchors` null', () => {
    for (const bad of [null, undefined, '', 'not json', {}, { hand_anchors: [] }]) {
      const idx = indexHandOverrides(bad);
      expect(idx.isEmpty).toBe(true);
      expect(plannerAnchors(idx)).toBeNull();
      expect(isNoteDisabled(idx, 0, 60)).toBe(false);
    }
  });

  test('accepte la chaîne JSON brute comme l’objet déjà parsé', () => {
    const raw = '{"hand_anchors":[{"tick":0,"handId":"left","anchor":50}],"version":1}';
    expect(indexHandOverrides(raw).anchors.get('left').get(0)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 2. Les planificateurs consomment les ancres
// ---------------------------------------------------------------------------

describe('R13 · HandPositionPlanner — les ancres épinglées contraignent la fenêtre', () => {
  const notes = [
    { time: 0, tick: 0, note: 60, channel: 0, velocity: 100, hand: 'left' },
    { time: 1, tick: 480, note: 62, channel: 0, velocity: 100, hand: 'left' },
    { time: 2, tick: 960, note: 64, channel: 0, velocity: 100, hand: 'left' }
  ];
  const planner = () =>
    new HandPositionPlanner(KEYBOARD_HANDS, { noteRangeMin: 36, noteRangeMax: 96 });

  test('sans ancre : sortie inchangée (une seule fenêtre auto)', () => {
    const { ccEvents, stats } = planner().plan(notes);
    expect(ccEvents.map((c) => c.value)).toEqual([60]);
    expect(stats.pinned).toBe(0);
  });

  test('avec ancre : la main va où l’opérateur l’a mise, et y reste', () => {
    const anchors = new Map([['left', new Map([[0, 48]])]]);
    const { ccEvents, stats } = planner().plan(notes, { anchors });
    // 48 épinglé au tick 0 ; la fenêtre [48,60] couvre 60/62/64 ? 64 > 60 ⇒
    // un décalage AUTO suit, exactement comme la simulation client.
    expect(ccEvents[0]).toMatchObject({ value: 48, source: 'override', controller: 23 });
    expect(stats.pinned).toBe(1);
  });

  test('une ancre à chaque accord épingle toute la trajectoire', () => {
    const anchors = new Map([
      [
        'left',
        new Map([
          [0, 48],
          [480, 55],
          [960, 40]
        ])
      ]
    ]);
    const { ccEvents, stats } = planner().plan(notes, { anchors });
    expect(ccEvents.map((c) => c.value)).toEqual([48, 55, 40]);
    expect(ccEvents.every((c) => c.source === 'override')).toBe(true);
    expect(stats.pinned).toBe(3);
  });

  test('une ancre hors plage est ramenée dans la plage ET signalée', () => {
    const anchors = new Map([['left', new Map([[0, 200]])]]);
    const { ccEvents, warnings } = planner().plan(notes, { anchors });
    expect(ccEvents[0].value).toBe(96); // note_range_max
    expect(warnings.map((w) => w.code)).toContain('anchor_out_of_reach');
  });

  test('une ancre qui ne couvre pas l’accord est honorée mais signalée', () => {
    const anchors = new Map([['left', new Map([[0, 36]])]]);
    const { ccEvents, warnings } = planner().plan(notes, { anchors });
    expect(ccEvents[0].value).toBe(36); // le pin n'est PAS re-recalé sur l'accord
    expect(warnings.map((w) => w.code)).toContain('anchor_unplayable');
  });

  test('une ancre posée sur une autre main ne déplace pas celle-ci', () => {
    const anchors = new Map([['right', new Map([[0, 90]])]]);
    const { ccEvents } = planner().plan(notes, { anchors });
    expect(ccEvents.map((c) => c.value)).toEqual([60]); // inchangé
  });
});

describe('R13 · LongitudinalPlanner — les ancres épinglées contraignent la position P', () => {
  const HANDS = {
    enabled: true,
    mode: 'frets',
    mechanism: 'string_sliding_fingers',
    hand_move_mm_per_sec: 250,
    hands: [
      {
        id: 'fretting',
        cc_position_number: 22,
        hand_span_mm: 90,
        max_fingers: 4,
        hand_span_frets: 5
      }
    ]
  };
  const ctx = { unit: 'frets', noteRangeMin: 0, noteRangeMax: 22, scaleLengthMm: 648 };
  const notes = [
    { time: 0, tick: 0, note: 45, fretPosition: 2, string: 1, channel: 0, velocity: 90 },
    { time: 1, tick: 480, note: 50, fretPosition: 5, string: 2, channel: 0, velocity: 90 },
    { time: 2, tick: 960, note: 55, fretPosition: 9, string: 3, channel: 0, velocity: 90 }
  ];

  test('sans ancre : valeurs auto', () => {
    const { ccEvents, stats } = new LongitudinalPlanner(HANDS, ctx).plan(notes);
    expect(ccEvents.length).toBeGreaterThan(0);
    expect(stats.pinned).toBe(0);
  });

  test('avec ancres : la valeur CC émise EST la frette épinglée', () => {
    const anchors = new Map([
      [
        'fretting',
        new Map([
          [0, 1],
          [960, 7]
        ])
      ]
    ]);
    const { ccEvents, stats } = new LongitudinalPlanner(HANDS, ctx).plan(notes, { anchors });
    expect(stats.pinned).toBe(2);
    expect(ccEvents[0].value).toBe(1);
    expect(ccEvents[ccEvents.length - 1].value).toBe(7);
  });

  test('une ancre irréalisable pour l’accord est appliquée ET signalée', () => {
    const anchors = new Map([['fretting', new Map([[960, 0]])]]);
    const { warnings } = new LongitudinalPlanner(HANDS, ctx).plan(notes, { anchors });
    expect(warnings.map((w) => w.code)).toContain('anchor_unplayable');
  });
});

// ---------------------------------------------------------------------------
// 3. Le moteur pose enfin un `tick` — sans quoi rien ne peut correspondre
// ---------------------------------------------------------------------------

describe('R13 · MidiPlayer — les événements portent leur tick absolu', () => {
  test('chaque note du timeline porte le tick du fichier', async () => {
    const buffer = noteFile([
      { tick: 0, note: 60 },
      { tick: 480, note: 64 },
      { tick: 960, note: 67 }
    ]);
    const { player } = await replay({
      buffer,
      routing: { 0: { device: 'devA', targetChannel: 0 } }
    });
    const ons = player.events.filter((e) => e.type === 'noteOn');
    expect(ons.map((e) => e.tick)).toEqual([0, 480, 960]);
  });
});

// ---------------------------------------------------------------------------
// 4. `disabled_notes` : la note ne sort plus, live ET baké
// ---------------------------------------------------------------------------

describe('R13 · disabled_notes — la note désactivée n’est réellement plus jouée', () => {
  const FILE = () =>
    noteFile([
      { tick: 0, note: 60 },
      { tick: 480, note: 64 },
      { tick: 960, note: 67 }
    ]);
  const OVERRIDES = { version: 1, hand_anchors: [], disabled_notes: [{ tick: 480, note: 64 }] };

  test('LIVE : ni Note On ni Note Off pour la note désactivée', async () => {
    const withOverrides = await replayLive(FILE(), OVERRIDES);
    expect(noteOns(withOverrides.trace)).toEqual([60, 67]);
    // Le Note Off apparié disparaît aussi : pas de note orpheline.
    const offs = withOverrides.trace.filter((e) => (e.status & 0xf0) === 0x80).map((e) => e.data1);
    expect(offs).toEqual([60, 67]);
  });

  test('témoin : sans override la note est bien jouée (le défaut F-139)', async () => {
    const none = await replayLive(FILE(), { version: 1, hand_anchors: [], disabled_notes: [] });
    expect(noteOns(none.trace)).toEqual([60, 64, 67]);
  });

  test('BAKÉ : les deux événements sont retirés des octets du fichier', async () => {
    const { baked, stats } = await bakeAndReplay(FILE(), OVERRIDES);
    expect(stats.note_events_removed).toBe(2);
    const parsed = parseMidi(baked);
    const pitches = parsed.tracks[0]
      .filter((e) => e.type === 'noteOn' || e.type === 'noteOff')
      .map((e) => e.noteNumber);
    expect(pitches).not.toContain(64);
  });

  test('PARITÉ : live et baké produisent exactement les mêmes octets', async () => {
    const live = await replayLive(FILE(), OVERRIDES);
    const baked = await bakeAndReplay(FILE(), OVERRIDES);
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });

  test('la grille temporelle des notes survivantes est préservée dans le baké', async () => {
    const { baked } = await bakeAndReplay(FILE(), OVERRIDES);
    const parsed = parseMidi(baked);
    let abs = 0;
    const onTicks = [];
    for (const e of parsed.tracks[0]) {
      abs += e.deltaTime;
      if (e.type === 'noteOn' && e.velocity > 0) onTicks.push(abs);
    }
    expect(onTicks).toEqual([0, 960]);
  });

  test('unisson au même tick : les deux voix partent, live et baké à l’identique', async () => {
    const buffer = buildMidi({
      ppq: PPQ,
      tracks: [
        [
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
        ]
      ]
    });
    const overrides = { version: 1, disabled_notes: [{ tick: 0, note: 60 }] };
    const live = await replayLive(buffer, overrides);
    const baked = await bakeAndReplay(buffer, overrides);
    // La clé d'une entrée est `(tick, note)` : elle ne distingue pas deux
    // instances d'unisson au MÊME tick — ni à l'écran, ni au moteur. Les deux
    // voix partent donc, et les deux Note Off appariés aussi (aucune note
    // orpheline). Ce qui compte ici : les deux chemins font EXACTEMENT pareil.
    expect(noteOns(live.trace)).toEqual([]);
    expect(live.trace.filter((e) => (e.status & 0xf0) === 0x80)).toEqual([]);
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });

  test('la note désactivée ne contraint plus la planification de main', async () => {
    // 96 est très au-dessus des autres : sans exclusion, la main droite doit
    // se déplacer pour l'atteindre. Désactivée, ce déplacement disparaît.
    const buffer = noteFile([
      { tick: 0, note: 60 },
      { tick: 480, note: 96 },
      { tick: 960, note: 62 }
    ]);
    const withNote = await replayLive(buffer, { version: 1, disabled_notes: [] });
    const without = await replayLive(buffer, {
      version: 1,
      disabled_notes: [{ tick: 480, note: 96 }]
    });
    expect(ccs(withNote.trace).length).toBeGreaterThan(ccs(without.trace).length);
  });
});

// ---------------------------------------------------------------------------
// 5. `hand_anchors` : le CC émis suit l'ancre, live ET baké
// ---------------------------------------------------------------------------

describe('R13 · hand_anchors — le CC de position suit l’ancre épinglée', () => {
  // Toutes sous le point de split (64) ⇒ main gauche, CC 23.
  const FILE = () =>
    noteFile([
      { tick: 0, note: 60 },
      { tick: 480, note: 61 },
      { tick: 960, note: 62 }
    ]);

  test('LIVE : sans ancre le moteur choisit 60 ; avec ancre il envoie 48', async () => {
    const auto = await replayLive(FILE(), { version: 1, hand_anchors: [] });
    const pinned = await replayLive(FILE(), {
      version: 1,
      hand_anchors: [{ tick: 0, handId: 'left', anchor: 48 }]
    });
    expect(ccs(auto.trace)[0]).toEqual([23, 60]);
    expect(ccs(pinned.trace)[0]).toEqual([23, 48]);
  });

  test('BAKÉ : la même ancre est gravée dans les octets', async () => {
    const overrides = {
      version: 1,
      hand_anchors: [{ tick: 0, handId: 'left', anchor: 48 }]
    };
    const { baked } = await bakeAndReplay(FILE(), overrides);
    const parsed = parseMidi(baked);
    const cc23 = parsed.tracks[0].filter((e) => e.type === 'controller' && e.controllerType === 23);
    expect(cc23.length).toBeGreaterThan(0);
    expect(cc23[0].value).toBe(48);
  });

  test('PARITÉ : live et baké produisent exactement les mêmes octets', async () => {
    const overrides = {
      version: 1,
      hand_anchors: [
        { tick: 0, handId: 'left', anchor: 48 },
        { tick: 960, handId: 'left', anchor: 52 }
      ],
      disabled_notes: [{ tick: 480, note: 61 }]
    };
    const live = await replayLive(FILE(), overrides);
    const baked = await bakeAndReplay(FILE(), overrides);
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
    // et l'ancre est bien celle de l'opérateur, pas celle du planificateur auto
    expect(ccs(live.trace).map((c) => c[1])).toEqual([48, 52]);
  });
});

// ---------------------------------------------------------------------------
// 6. `note_assignments` (pins de main) : inertes avant R13, faute de tick
// ---------------------------------------------------------------------------

describe('R13 · note_assignments — les pins de main sont enfin appariés', () => {
  test('le pin déplace la note vers l’autre main, live et baké à l’identique', async () => {
    const buffer = noteFile([
      { tick: 0, note: 40 },
      { tick: 480, note: 90 }
    ]);
    const overrides = {
      version: 1,
      note_assignments: [{ tick: 0, note: 40, handId: 'right' }]
    };
    const auto = await replayLive(buffer, { version: 1, note_assignments: [] });
    const pinned = await replayLive(buffer, overrides);
    // Sans pin : 40 revient à la main gauche (CC 23) ; avec pin, à la droite (CC 24).
    expect(ccs(auto.trace).map((c) => c[0])).toContain(23);
    expect(ccs(pinned.trace).map((c) => c[0])).not.toContain(23);

    const baked = await bakeAndReplay(buffer, overrides);
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(pinned.trace));
  });
});

// ---------------------------------------------------------------------------
// 7. Idempotence / non-régression
// ---------------------------------------------------------------------------

describe('R13 · non-régression', () => {
  test('aucun override ⇒ sortie strictement identique à l’avant-R13', async () => {
    const buffer = noteFile([
      { tick: 0, note: 60 },
      { tick: 480, note: 64 }
    ]);
    const plain = await replay({
      buffer,
      routing: { 0: { device: 'devA', targetChannel: 0 } }
    });
    const withEmpty = await replayLive(buffer, null, {
      capabilities: null
    });
    expect(serializeBytes(withEmpty.trace)).toBe(serializeBytes(plain.trace));
  });

  test('la passe de désactivation est idempotente (deux `start()` de suite)', async () => {
    const buffer = noteFile([
      { tick: 0, note: 60 },
      { tick: 480, note: 64 }
    ]);
    const overrides = { version: 1, disabled_notes: [{ tick: 480, note: 64 }] };
    const first = await replayLive(buffer, overrides);
    // Rejoue le MÊME player : _applyDisabledNotes nettoie ses marques avant
    // de les reposer, donc la seconde lecture est identique à la première.
    first.player.currentEventIndex = 0;
    const before = first.player.events.filter((e) => e._handDisabled).length;
    first.player._applyDisabledNotes();
    const after = first.player.events.filter((e) => e._handDisabled).length;
    expect(after).toBe(before);
    expect(after).toBe(2);
  });

  test('retirer l’override rend la note : les marques sont effacées', async () => {
    const buffer = noteFile([
      { tick: 0, note: 60 },
      { tick: 480, note: 64 }
    ]);
    const overrides = { version: 1, disabled_notes: [{ tick: 480, note: 64 }] };
    const { player } = await replayLive(buffer, overrides);
    expect(player.events.filter((e) => e._handDisabled).length).toBe(2);
    player.channelRouting.get(0).handOverrides = null;
    player._applyDisabledNotes();
    expect(player.events.filter((e) => e._handDisabled).length).toBe(0);
  });
});
