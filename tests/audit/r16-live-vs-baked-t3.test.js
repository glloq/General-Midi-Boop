/**
 * @file tests/audit/r16-live-vs-baked-t3.test.js
 * @description **R16 — fermeture de T3 « live ≠ baké »** (audit
 * `05_PLAYBACK.md` §5, finding **F-60**).
 *
 * Le lot L05 a établi que la table réelle des divergences compte **9 axes**,
 * là où `docs/V0.9_ROADMAP.md` §T3 n'en instruisait que 4, et que **trois
 * divergences restaient ouvertes** :
 *
 * | Axe | Divergence mesurée pendant l'audit | Décision R16 |
 * |-----|------------------------------------|--------------|
 * | 4 — `suppressOutOfRange` | l'offline SUPPRIME, le live REPLIE | le choix de l'opérateur atteint désormais les DEUX chaînes |
 * | 6 — filtrage `supported_ccs` | runtime seulement ; `ccMapping` renumérote sans filtrer | prédicat partagé, appliqué aussi hors-ligne |
 * | 7b — éviction polyphonique | la voix médiane sonne puis est coupée en live, jamais émise en baké | l'offline reproduit l'éviction du runtime |
 *
 * Une quatrième divergence, **non répertoriée par l'audit**, a été trouvée en
 * instruisant R13 : les CC de position de main « au plus tôt » (`note_on
 * précédent + 0,1 ms`) tombaient **sous la résolution du tick**, et le baker
 * les plaçait donc du mauvais côté de la note. Elle est fermée ici aussi.
 *
 * Protocole (identique à `l05-live-vs-baked.test.js`) :
 *   - LIVE  : fichier ORIGINAL + paramètres runtime ;
 *   - BAKÉ  : fichier ADAPTÉ hors-ligne, rejoué SANS paramètre runtime ;
 *   - comparaison **octet à octet** via le harnais de rejeu déterministe L05.
 */
import { describe, test, expect } from '@jest/globals';
import { parseMidi } from 'midi-file';
import MidiTransposer from '../../src/midi/adaptation/MidiTransposer.js';
import JsonMidiConverter from '../../src/files/JsonMidiConverter.js';
import MidiRouter from '../../src/midi/routing/MidiRouter.js';
import PlaybackScheduler from '../../src/midi/playback/PlaybackScheduler.js';
import MidiBaker from '../../src/files/MidiBaker.js';
import {
  foldIntoRange,
  isCCAllowed,
  isOutOfRange,
  isActuatorCC
} from '../../src/midi/adaptation/NoteEnforcement.js';
import { replay, buildMidi, serializeBytes, silentLogger } from './l05-replay-harness.test.js';

const PPQ = 480;
const logger = silentLogger();
const transposer = new MidiTransposer(logger);
const converter = new JsonMidiConverter(logger);
const ROUTING = { 0: { device: 'devA', targetChannel: 0 } };

/** Chaîne d'adaptation HORS-LIGNE → nouveau buffer. */
function bakeOffline(buffer, transpositions) {
  const json = converter.midiToJson(buffer);
  const { midiData, stats } = transposer.transposeChannels(json, transpositions);
  return { buffer: converter.jsonToMidi(midiData), stats };
}

function scaleFile(notes, { channel = 0, dur = 120, spacing = 240 } = {}) {
  const abs = [];
  notes.forEach((n, i) => {
    abs.push({ tick: i * spacing, ev: { type: 'noteOn', channel, noteNumber: n, velocity: 100 } });
    abs.push({
      tick: i * spacing + dur,
      ev: { type: 'noteOff', channel, noteNumber: n, velocity: 0 }
    });
  });
  abs.forEach((a, i) => (a._i = i));
  abs.sort((a, b) => a.tick - b.tick || a._i - b._i);
  let last = 0;
  const track = abs.map((a) => {
    const deltaTime = a.tick - last;
    last = a.tick;
    return { ...a.ev, deltaTime };
  });
  return buildMidi({ ppq: PPQ, tracks: [track] });
}

const ons = (t) => t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0).map((e) => e.data1);
const offs = (t) => t.filter((e) => (e.status & 0xf0) === 0x80).map((e) => e.data1);
const ccNums = (t) => t.filter((e) => (e.status & 0xf0) === 0xb0).map((e) => e.data1);

// ===========================================================================
// AXE 4 — suppressOutOfRange
// ===========================================================================

describe('R16 · axe 4 — `suppressOutOfRange` : le choix atteint les deux chaînes', () => {
  const CAPS = { 'devA:0': { noteRangeMin: 48, noteRangeMax: 72 } };

  test('le runtime SUPPRIME quand la politique le demande (au lieu de replier)', async () => {
    const buffer = scaleFile([40, 60, 96]);
    const folded = await replay({ buffer, routing: ROUTING, capabilities: CAPS });
    const suppressed = await replay({
      buffer,
      routing: ROUTING,
      capabilities: CAPS,
      mutate: (p) => p.setChannelOutOfRangePolicy(0, 'suppress')
    });
    expect(ons(folded.trace)).toEqual([52, 60, 72]); // comportement historique
    expect(ons(suppressed.trace)).toEqual([60]);
  });

  test('PARITÉ octet à octet avec le fichier baké `suppressOutOfRange`', async () => {
    const buffer = scaleFile([40, 48, 60, 72, 96]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: CAPS,
      mutate: (p) => p.setChannelOutOfRangePolicy(0, 'suppress')
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, {
        0: { suppressOutOfRange: true, noteRangeMin: 48, noteRangeMax: 72 }
      }).buffer,
      routing: ROUTING,
      capabilities: CAPS
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
    expect(ons(live.trace)).toEqual([48, 60, 72]);
  });

  test('le Note Off de la note supprimée part avec elle (aucune note orpheline)', async () => {
    const buffer = scaleFile([40, 60]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: CAPS,
      mutate: (p) => p.setChannelOutOfRangePolicy(0, 'suppress')
    });
    expect(ons(live.trace)).toEqual([60]);
    expect(offs(live.trace)).toEqual([60]);
  });

  test('la suppression suit la transposition, comme hors-ligne', async () => {
    // 45 est hors [48,72] ; +12 le fait ENTRER dans la plage : il doit survivre
    // des deux côtés (la garde s'évalue APRÈS transposition/remap).
    const buffer = scaleFile([45]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: CAPS,
      mutate: (p) => {
        p.channelTransposition.set(0, 12);
        p.setChannelOutOfRangePolicy(0, 'suppress');
      }
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, {
        0: { semitones: 12, suppressOutOfRange: true, noteRangeMin: 48, noteRangeMax: 72 }
      }).buffer,
      routing: ROUTING,
      capabilities: CAPS
    });
    expect(ons(live.trace)).toEqual([57]);
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });

  test('sans plage déclarée la politique est inerte (comme hors-ligne)', async () => {
    const buffer = scaleFile([10, 60, 120]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      mutate: (p) => p.setChannelOutOfRangePolicy(0, 'suppress')
    });
    expect(ons(live.trace)).toEqual([10, 60, 120]);
    expect(isOutOfRange(10, { noteRangeMin: null, noteRangeMax: null })).toBe(false);
  });

  test('la politique est révocable et par canal', async () => {
    const buffer = scaleFile([40, 60]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: CAPS,
      mutate: (p) => {
        p.setChannelOutOfRangePolicy(0, 'suppress');
        p.setChannelOutOfRangePolicy(1, 'suppress'); // autre canal, sans effet ici
        p.setChannelOutOfRangePolicy(0, 'fold'); // révoquée
      }
    });
    expect(ons(live.trace)).toEqual([52, 60]); // repli restauré
  });
});

// ===========================================================================
// AXE 6 — filtrage `supported_ccs`
// ===========================================================================

describe('R16 · axe 6 — `supported_ccs` : un seul prédicat pour les trois chaînes', () => {
  const CC_TRACK = [
    { deltaTime: 0, type: 'controller', channel: 0, controllerType: 1, value: 40 },
    { deltaTime: 0, type: 'controller', channel: 0, controllerType: 74, value: 90 },
    { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 100 },
    { deltaTime: 0, type: 'controller', channel: 0, controllerType: 0, value: 1 },
    { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
    { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
  ];

  test('les CC non déclarés disparaissent DES OCTETS bakés', () => {
    const buffer = buildMidi({ ppq: PPQ, tracks: [CC_TRACK] });
    const { buffer: baked, stats } = bakeOffline(buffer, { 0: { supportedCcs: [7] } });
    const kept = parseMidi(baked)
      .tracks[0].filter((e) => e.type === 'controller')
      .map((e) => e.controllerType);
    // CC 7 déclaré + CC 0 (Bank Select) jamais filtré ; CC 1 et 74 retirés.
    expect(kept).toEqual([7, 0]);
    expect(stats.ccsFiltered).toBe(2);
  });

  test('PARITÉ octet à octet live ↔ baké', async () => {
    const buffer = buildMidi({ ppq: PPQ, tracks: [CC_TRACK] });
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { supportedCcs: [7] } }
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { supportedCcs: [7] } }).buffer,
      routing: ROUTING
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
    // Bank Select (CC 0) précède les CC ordinaires (priorité d'ordonnancement),
    // puis le CC 7 déclaré, puis l'All Notes Off de fin.
    expect(ccNums(live.trace)).toEqual([0, 7, 123]);
  });

  test('le filtre s’applique APRÈS la renumérotation `ccMapping`, comme au runtime', () => {
    const buffer = buildMidi({ ppq: PPQ, tracks: [CC_TRACK] });
    // CC 1 → 7 (supporté) doit SURVIVRE ; CC 7 → 74 (non supporté) doit partir.
    const { buffer: baked } = bakeOffline(buffer, {
      0: { ccMapping: { 1: 7, 7: 74 }, supportedCcs: [7] }
    });
    const kept = parseMidi(baked)
      .tracks[0].filter((e) => e.type === 'controller')
      .map((e) => e.controllerType);
    expect(kept).toEqual([7, 0]);
  });

  test('les CC de sécurité et de banque ne sont jamais filtrés, nulle part', () => {
    for (const cc of [0, 32, 120, 121, 122, 123, 124, 125, 126, 127]) {
      expect(isCCAllowed(cc, { supportedCcs: [7] })).toBe(true);
    }
    expect(isCCAllowed(1, { supportedCcs: [7] })).toBe(false);
    // Les CC de position de main de l'instrument passent toujours (sinon
    // l'actionneur ne bouge plus — correctif L06 conservé).
    expect(isCCAllowed(23, { supportedCcs: [7], handCcs: [22, 23] })).toBe(true);
    // Liste non déclarée ⇒ tout passe (rétro-compatible).
    expect(isCCAllowed(74, { supportedCcs: null })).toBe(true);
    expect(isCCAllowed(74, {})).toBe(true);
  });

  test('CC 20/21 restent gouvernés par la porte cordes, pas par supported_ccs', () => {
    expect(isActuatorCC(20)).toBe(true);
    expect(isActuatorCC(21)).toBe(true);
    expect(isActuatorCC(22)).toBe(false);
    const buffer = buildMidi({
      ppq: PPQ,
      tracks: [
        [
          { deltaTime: 0, type: 'controller', channel: 0, controllerType: 20, value: 3 },
          { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
        ]
      ]
    });
    // Destination non-cordes : le CC 20 est retiré des octets, comme le
    // runtime le retire au vol.
    const kept = parseMidi(bakeOffline(buffer, { 0: { stringCCAllowed: false } }).buffer)
      .tracks[0].filter((e) => e.type === 'controller')
      .map((e) => e.controllerType);
    expect(kept).toEqual([]);
    // Destination cordes : il survit.
    const keptString = parseMidi(bakeOffline(buffer, { 0: { stringCCAllowed: true } }).buffer)
      .tracks[0].filter((e) => e.type === 'controller')
      .map((e) => e.controllerType);
    expect(keptString).toEqual([20]);
  });

  test('les trois chaînes appellent le MÊME prédicat (plus de copies)', () => {
    // La preuve la moins contournable : la source des deux gardes runtime ne
    // ré-implémente plus la règle, elle délègue.
    expect(String(PlaybackScheduler.prototype._isCCSupported)).toContain('isCCAllowed');
    expect(String(MidiRouter.prototype._enforceLiveLimits)).toContain('isCCAllowed');
    expect(String(transposer.transposeChannels)).toContain('isCCAllowed');
  });
});

// ===========================================================================
// AXE 7b — éviction polyphonique
// ===========================================================================

describe('R16 · axe 7b — éviction polyphonique : la voix médiane', () => {
  const CHORD = [
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
    { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 67, velocity: 100 },
    { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
    { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
    { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 67, velocity: 0 }
  ];

  test('PARITÉ octet à octet : la voix évincée est frappée puis relâchée des deux côtés', async () => {
    const buffer = buildMidi({ ppq: PPQ, tracks: [CHORD] });
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 2 } }
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { maxPolyphony: 2, polyStrategy: 'drop' } }).buffer,
      routing: ROUTING
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
    expect(ons(live.trace)).toEqual([60, 64, 67]);
  });

  test('les octets bakés portent le Note Off d’éviction au tick de la note évinçante', () => {
    const buffer = buildMidi({ ppq: PPQ, tracks: [CHORD] });
    const parsed = parseMidi(bakeOffline(buffer, { 0: { maxPolyphony: 2 } }).buffer);
    let abs = 0;
    const seq = [];
    for (const e of parsed.tracks[0]) {
      abs += e.deltaTime;
      if (e.type === 'noteOn' || e.type === 'noteOff') {
        seq.push(`${abs}:${e.type === 'noteOn' && e.velocity > 0 ? 'on' : 'off'}${e.noteNumber}`);
      }
    }
    // 64 est relâchée au tick 240 (celui de 67), pas à sa fin naturelle (720).
    expect(seq).toEqual(['0:on60', '0:on64', '240:off64', '240:on67', '720:off60', '720:off67']);
  });

  test('quand la victime EST la note entrante, elle n’est jamais frappée (les deux côtés)', async () => {
    // 60 et 72 tenues, 64 arrive : médiane de [60,64,72] = 64 = la note entrante.
    const track = [
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 72, velocity: 100 },
      { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
      { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 72, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 2 } }
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { maxPolyphony: 2 } }).buffer,
      routing: ROUTING
    });
    expect(ons(live.trace)).toEqual([60, 72]);
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });

  test('unisson : la comptabilisation par voix reste celle de P2-10', () => {
    const midiData = {
      header: { format: 1, numTracks: 1, ticksPerBeat: PPQ },
      tracks: [
        {
          events: [
            { type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100, deltaTime: 0 },
            { type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100, deltaTime: 0 },
            { type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0, deltaTime: 100 },
            { type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0, deltaTime: 100 }
          ]
        }
      ]
    };
    const res = transposer.transposeChannels(midiData, { 0: { maxPolyphony: 1 } });
    expect(res.stats.notesDropped).toBe(1);
    const evs = res.midiData.tracks[0].events;
    expect(evs.filter((e) => e.type === 'noteOn')).toHaveLength(1);
    expect(evs.filter((e) => e.type === 'noteOff')).toHaveLength(1);
  });
});

// ===========================================================================
// AXE 3b — F-59 : une seule implémentation du repli
// ===========================================================================

describe('R16 · axe 3b (F-59) — le repli de plage n’existe plus qu’en un exemplaire', () => {
  test('`compressNoteToRange` délègue au `foldIntoRange` partagé', () => {
    expect(String(transposer.compressNoteToRange)).toContain('foldIntoRange');
  });

  test('identité conservée sur 128 notes × 5 fenêtres', () => {
    for (const [min, max] of [
      [48, 72],
      [60, 65],
      [0, 127],
      [36, 36],
      [21, 108]
    ]) {
      for (let n = 0; n <= 127; n++) {
        expect(transposer.compressNoteToRange(n, min, max)).toBe(foldIntoRange(n, min, max));
      }
    }
  });

  test('plage dégénérée (max < min) : les deux chemins restent définis', () => {
    expect(transposer.compressNoteToRange(60, 72, 48)).toBe(72);
  });
});

// ===========================================================================
// Divergence hors-table trouvée par R13 : ordonnancement des CC de main
// ===========================================================================

describe('R16 · hors-table — ordre des CC de position de main sur la grille de ticks', () => {
  const HANDS = {
    enabled: true,
    mode: 'semitones',
    assignment: { mode: 'pitch_split', pitch_split_note: 127 }, // une seule main utile
    hand_move_semitones_per_sec: 60,
    hands: [
      { id: 'left', cc_position_number: 23, hand_span_semitones: 6 },
      { id: 'right', cc_position_number: 24, hand_span_semitones: 6 }
    ]
  };
  const CAPS = { hands_config: HANDS, note_range_min: 21, note_range_max: 108 };

  function db(overrides = null) {
    return {
      getFile: (id) => ({ id, filename: 'f.mid', blob_path: 'x' }),
      getRoutingsByFile: () => [
        {
          id: 1,
          channel: 0,
          device_id: 'devA',
          target_channel: 0,
          enabled: 1,
          hand_position_overrides: overrides
        }
      ],
      getTablaturesByFile: () => [],
      getInstrumentCapabilities: () => CAPS,
      getInstrumentSettings: () => null
    };
  }

  test('un décalage AUTO tombe du même côté de la note en live et en baké', async () => {
    // 60 puis 80 : 80 sort de la fenêtre de 6 demi-tons ⇒ décalage, dont le CC
    // est émis « au plus tôt », c.-à-d. juste APRÈS le note-on de 60. Cet
    // epsilon (0,1 ms) est sous la résolution du tick : arrondi naïvement, il
    // repassait AVANT la note dans le fichier baké.
    const buffer = scaleFile([60, 80], { spacing: 960, dur: 240 });
    const live = await replay({
      buffer,
      database: db(),
      routing: { 0: { device: 'devA', targetChannel: 0 } }
    });
    const baker = new MidiBaker({ database: db(), blobStore: { read: () => buffer }, logger });
    const { buffer: baked } = await baker.bake(1);
    const bakedRun = await replay({ buffer: baked, routing: ROUTING });
    expect(serializeBytes(bakedRun.trace)).toBe(serializeBytes(live.trace));
    // Et l'ordre est bien « CC initial, note, CC de décalage, note ».
    const kinds = live.trace
      .filter((e) => (e.status & 0xf0) === 0xb0 || (e.status & 0xf0) === 0x90)
      .filter((e) => e.data1 !== 123)
      .map((e) => ((e.status & 0xf0) === 0xb0 ? `cc${e.data2}` : `on${e.data1}`));
    expect(kinds).toEqual(['cc60', 'on60', 'cc80', 'on80']);
  });
});

// ===========================================================================
// Divergences ASSUMÉES — documentées, pas masquées
// ===========================================================================

describe('R16 · divergences assumées (axes 5, 8, 9) — runtime seulement, convergentes', () => {
  test('axe 5 — le snap de gamme / `selected_notes` reste un enforcement runtime', async () => {
    // Le fichier baké N'EST PAS snappé ; il l'est au rejeu, donc les deux
    // chemins CONVERGENT à la sortie. Ce qui diffère, c'est l'aperçu/export du
    // fichier adapté, pas ce que l'instrument reçoit.
    const buffer = scaleFile([60, 61, 62]);
    const caps = { 'devA:0': { noteRangeMin: 48, noteRangeMax: 72, selectedNotes: [60, 64, 67] } };
    const live = await replay({ buffer, routing: ROUTING, capabilities: caps });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: {} }).buffer,
      routing: ROUTING,
      capabilities: caps
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
    // Aucun paramètre hors-ligne n'existe pour cet axe :
    expect(String(transposer.transposeChannels)).not.toContain('selectedNotes');
    expect(String(transposer.transposeChannels)).not.toContain('octaveMode');
  });

  test('axes 8 et 9 — `min_note_interval` / `min_note_duration` restent runtime', async () => {
    const buffer = scaleFile([60, 60, 60, 60], { spacing: 24, dur: 12 });
    const caps = { 'devA:0': { polyphony: 1, minNoteInterval: 80 } };
    const live = await replay({ buffer, routing: ROUTING, capabilities: caps });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: {} }).buffer,
      routing: ROUTING,
      capabilities: caps
    });
    // Le baké rejoué AVEC les mêmes capacités donne exactement le live :
    // l'axe est runtime-seulement mais convergent, donc pas une divergence.
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
    expect(String(transposer.transposeChannels)).not.toContain('minNoteInterval');
    expect(String(transposer.transposeChannels)).not.toContain('minNoteDuration');
  });
});
