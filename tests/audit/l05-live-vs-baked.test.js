/**
 * @file tests/audit/l05-live-vs-baked.test.js
 * @description Lot L05 — §T3 « Divergences runtime ≠ offline (live vs baked) »,
 * déclaré **100 % fermé** dans `docs/V0.9_ROADMAP.md`. Ce fichier ré-instruit
 * chaque item T3.1→T3.4 et étend la comparaison aux transformations que la
 * roadmap ne couvre pas.
 *
 * **Protocole.** Pour un même fichier et une même configuration d'instrument :
 *   - chemin LIVE   : fichier ORIGINAL + paramètres de routage runtime
 *                     (`channelTransposition`, `channelNoteRemapping`,
 *                     capacités) → `MidiPlayer` → `PlaybackScheduler` ;
 *   - chemin BAKÉ   : fichier ADAPTÉ hors-ligne (`MidiTransposer`), rejoué
 *                     SANS paramètre runtime (`adaptationBaked`).
 * Les deux traces d'octets doivent être identiques.
 *
 * Rappel de cadrage : un fichier baké est **rejoué par le même scheduler**.
 * L'enforcement runtime (repli de plage, snap de gamme, polyphonie, gardes de
 * timing) s'applique donc DANS LES DEUX CAS ; la question est de savoir si
 * l'étape hors-ligne ajoute, retire ou déplace quelque chose.
 */
import { describe, test, expect } from '@jest/globals';
import { parseMidi } from 'midi-file';
import MidiTransposer from '../../src/midi/adaptation/MidiTransposer.js';
import JsonMidiConverter from '../../src/files/JsonMidiConverter.js';
import {
  clampNote,
  foldIntoRange,
  selectPolyphonyVictim
} from '../../src/midi/adaptation/NoteEnforcement.js';
import { replay, buildMidi, serializeBytes, silentLogger } from './l05-replay-harness.test.js';

const PPQ = 480;
const logger = silentLogger();
const transposer = new MidiTransposer(logger);
const converter = new JsonMidiConverter(logger);

/** Applique la chaîne d'adaptation HORS-LIGNE et renvoie un nouveau buffer. */
function bakeOffline(buffer, transpositions, { compress = null } = {}) {
  const json = converter.midiToJson(buffer);
  let result = transposer.transposeChannels(json, transpositions);
  let data = result.midiData;
  if (compress) {
    data = transposer.compressChannel(data, compress.channel, compress.min, compress.max).midiData;
  }
  return { buffer: converter.jsonToMidi(data), stats: result.stats };
}

/** Piste simple de notes montantes. */
function scaleFile(notes, { channel = 0, dur = 120, spacing = 240 } = {}) {
  const track = [];
  let last = 0;
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
  for (const a of abs) {
    track.push({ ...a.ev, deltaTime: a.tick - last });
    last = a.tick;
  }
  return buildMidi({ ppq: PPQ, tracks: [track] });
}

const ROUTING = { 0: { device: 'devA', targetChannel: 0 } };
const NOTES = [40, 48, 55, 60, 61, 64, 67, 72, 79, 84, 96];

// ---------------------------------------------------------------------------
// Cas 1 — transposition
// ---------------------------------------------------------------------------

describe('L05 · T3 — cas 1 : transposition de canal', () => {
  test('live (channelTransposition) === baké (MidiTransposer.transposeChannels)', async () => {
    const buffer = scaleFile(NOTES);
    const live = await replay({
      buffer,
      routing: ROUTING,
      mutate: (p) => p.channelTransposition.set(0, 12)
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { semitones: 12 } }).buffer,
      routing: ROUTING
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });

  test('divergence au BORD : live écrête à 127, l’offline écrête aussi — mais la note reste', async () => {
    const buffer = scaleFile([120, 122, 124]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      mutate: (p) => p.channelTransposition.set(0, 12)
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { semitones: 12 } }).buffer,
      routing: ROUTING
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
    // Les 3 notes se replient toutes sur 127 : trois voix distinctes deviennent
    // la MÊME hauteur, dans les deux chemins (perte identique, donc « parité »).
    const ons = live.trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
    expect(ons.map((e) => e.data1)).toEqual([127, 127, 127]);
  });
});

// ---------------------------------------------------------------------------
// Cas 2 — remap de notes (batterie)
// ---------------------------------------------------------------------------

describe('L05 · T3 — cas 2 : remap de notes', () => {
  test('live (channelNoteRemapping) === baké (noteRemapping)', async () => {
    const mapping = { 40: 38, 48: 45, 55: 47 };
    const buffer = scaleFile([40, 48, 55, 60]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      mutate: (p) => p.setChannelNoteRemapping(0, mapping)
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { noteRemapping: mapping } }).buffer,
      routing: ROUTING
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });

  test('ordre transposition→remap identique des deux côtés', async () => {
    // Le remap porte sur la note DÉJÀ transposée dans les deux chemins.
    const mapping = { 72: 36 }; // 60 + 12 = 72 → 36
    const buffer = scaleFile([60]);
    const live = await replay({
      buffer,
      routing: ROUTING,
      mutate: (p) => {
        p.channelTransposition.set(0, 12);
        p.setChannelNoteRemapping(0, mapping);
      }
    });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { semitones: 12, noteRemapping: mapping } }).buffer,
      routing: ROUTING
    });
    expect(serializeBytes(live.trace)).toContain('90 36');
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });
});

// ---------------------------------------------------------------------------
// Cas 3 — repli de plage (T3.2)
// ---------------------------------------------------------------------------

describe('L05 · T3.2 — repli de plage', () => {
  test('les deux implémentations de repli sont algorithmiquement identiques', () => {
    // `NoteEnforcement.foldIntoRange` (live) et
    // `MidiTransposer.compressNoteToRange` (offline) : même résultat sur
    // les 128 notes × plusieurs fenêtres — mais ce sont DEUX COPIES du
    // même algorithme, pas un helper partagé (risque de dérive → F-59).
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

  test('live (clampNote runtime) === baké (compressChannel) sur un fichier réel', async () => {
    const buffer = scaleFile(NOTES);
    const caps = { 'devA:0': { noteRangeMin: 48, noteRangeMax: 72 } };
    const live = await replay({ buffer, routing: ROUTING, capabilities: caps });
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: {} }, { compress: { channel: 0, min: 48, max: 72 } }).buffer,
      routing: ROUTING,
      capabilities: caps
    });
    expect(serializeBytes(baked.trace)).toBe(serializeBytes(live.trace));
  });
});

// ---------------------------------------------------------------------------
// Cas 4 — suppressOutOfRange : divergence structurelle
// ---------------------------------------------------------------------------

describe('L05 · T3 — cas 4 : suppressOutOfRange (offline) vs repli (live)', () => {
  test('DIVERGENCE : l’offline SUPPRIME la note, le live la REPLIE dans la plage', async () => {
    const buffer = scaleFile([40, 60, 96]);
    const caps = { 'devA:0': { noteRangeMin: 48, noteRangeMax: 72 } };
    const live = await replay({ buffer, routing: ROUTING, capabilities: caps });
    const baked = await replay({
      buffer: bakeOffline(buffer, {
        0: { suppressOutOfRange: true, noteRangeMin: 48, noteRangeMax: 72 }
      }).buffer,
      routing: ROUTING,
      capabilities: caps
    });
    const ons = (t) =>
      t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0).map((e) => e.data1);
    expect(ons(live.trace)).toEqual([52, 60, 72]); // 40→52, 96→72 (repli d'octave)
    expect(ons(baked.trace)).toEqual([60]); // 40 et 96 supprimées
    expect(serializeBytes(baked.trace)).not.toBe(serializeBytes(live.trace));
  });
});

// ---------------------------------------------------------------------------
// Cas 5 — snap de gamme / selected_notes : runtime uniquement
// ---------------------------------------------------------------------------

describe('L05 · T3.3 — snap sur selected_notes / gamme', () => {
  test('le snap est un enforcement RUNTIME : aucune contrepartie hors-ligne', async () => {
    const buffer = scaleFile([60, 61, 62, 63, 64]);
    const caps = {
      'devA:0': { noteRangeMin: 48, noteRangeMax: 72, selectedNotes: [60, 64, 67] }
    };
    const live = await replay({ buffer, routing: ROUTING, capabilities: caps });
    const ons = live.trace
      .filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0)
      .map((e) => e.data1);
    expect(ons).toEqual([60, 60, 60, 64, 64]);
    // La chaîne hors-ligne n'expose AUCUN paramètre `selected_notes` :
    // `transposeChannels` ne connaît que semitones / remap / range / poly / CC.
    const offlineKnobs = Object.keys({
      semitones: 0,
      noteRemapping: null,
      suppressOutOfRange: false,
      noteRangeMin: 0,
      noteRangeMax: 127,
      maxPolyphony: null,
      polyStrategy: 'drop',
      ccMapping: null
    });
    expect(offlineKnobs).not.toContain('selectedNotes');
    expect(offlineKnobs).not.toContain('octaveMode');
  });

  test('T3.3 confirmé : un selected_note HORS plage ne peut plus faire sortir la note', () => {
    // 90 est hors de [48,72] : il doit être ignoré au profit du repli in-range.
    expect(
      clampNote(85, { noteRangeMin: 48, noteRangeMax: 72, selectedNotes: [90] })
    ).toBeLessThanOrEqual(72);
    expect(clampNote(85, { noteRangeMin: 48, noteRangeMax: 72, selectedNotes: [90] })).toBe(61);
  });
});

// ---------------------------------------------------------------------------
// Cas 6 — filtrage des CC non supportés : runtime uniquement
// ---------------------------------------------------------------------------

describe('L05 · T3 — cas 6 : filtrage des CC', () => {
  test('DIVERGENCE : `supported_ccs` filtre au runtime, l’offline ne le connaît pas', async () => {
    const track = [
      { deltaTime: 0, type: 'controller', channel: 0, controllerType: 1, value: 40 },
      { deltaTime: 0, type: 'controller', channel: 0, controllerType: 74, value: 90 },
      { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 100 },
      { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const unfiltered = await replay({ buffer, routing: ROUTING });
    const filtered = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { supportedCcs: [7] } }
    });
    const ccs = (t) => t.filter((e) => (e.status & 0xf0) === 0xb0).map((e) => e.data1);
    expect(ccs(unfiltered.trace)).toEqual(expect.arrayContaining([1, 74, 7]));
    // CC 1 et 74 sont supprimés ; CC 7 et le CC 123 de sécurité passent.
    expect(ccs(filtered.trace)).not.toContain(1);
    expect(ccs(filtered.trace)).not.toContain(74);
    expect(ccs(filtered.trace)).toContain(7);
    expect(ccs(filtered.trace)).toContain(123);
    // Le mapping CC hors-ligne (`ccMapping`) RENUMÉROTE, il ne filtre pas.
    const baked = bakeOffline(buffer, { 0: { ccMapping: { 1: 11 } } });
    const parsed = parseMidi(baked.buffer);
    const bakedCcs = parsed.tracks[0]
      .filter((e) => e.type === 'controller')
      .map((e) => e.controllerType);
    expect(bakedCcs).toEqual([11, 74, 7]); // 74 toujours présent dans les octets
  });
});

// ---------------------------------------------------------------------------
// Cas 7 — polyphonie (T3.1)
// ---------------------------------------------------------------------------

describe('L05 · T3.1 — politique de polyphonie live vs offline', () => {
  test('même victime choisie par les deux chemins (keep-outer / médiane)', () => {
    // Offline : `sorted[floor(len/2)]` sur la liste des voix actives.
    // Live : `selectPolyphonyVictim` — même formule, helper partagé.
    for (const set of [
      [60, 64, 67, 72],
      [36, 48, 60],
      [60, 60, 64, 72],
      [90, 30, 60, 45, 75]
    ]) {
      const sorted = [...set].sort((a, b) => a - b);
      expect(selectPolyphonyVictim(set)).toBe(sorted[Math.floor(sorted.length / 2)]);
    }
  });

  test('DIVERGENCE RÉSIDUELLE : l’offline supprime la note, le live la fait sonner puis la coupe', async () => {
    const track = [
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
      { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 67, velocity: 100 },
      { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 67, velocity: 0 },
      { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 36, velocity: 1 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 36, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });

    // LIVE : plafond porté par la capacité de l'instrument.
    const live = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 2 } }
    });
    // BAKÉ : plafond appliqué hors-ligne, aucune contrainte au runtime.
    const baked = await replay({
      buffer: bakeOffline(buffer, { 0: { maxPolyphony: 2, polyStrategy: 'drop' } }).buffer,
      routing: ROUTING
    });

    const seq = (t) =>
      t
        .filter((e) => (e.status & 0xf0) === 0x90 || (e.status & 0xf0) === 0x80)
        .map((e) => `${(e.status & 0xf0) === 0x90 ? 'on' : 'off'}${e.data1}`);

    // Le live ÉMET la note 64 puis la coupe pour libérer une voix ;
    // l'offline ne l'émet jamais. Les deux respectent le plafond, mais la
    // sortie MIDI diffère : 64 sonne ~0,25 s dans un cas, pas dans l'autre.
    expect(seq(live.trace)).toContain('on64');
    expect(seq(live.trace)).toContain('off64');
    expect(seq(baked.trace)).not.toContain('on64');
    expect(serializeBytes(baked.trace)).not.toBe(serializeBytes(live.trace));
  });
});

// ---------------------------------------------------------------------------
// Cas 8 — gardes de timing : runtime uniquement
// ---------------------------------------------------------------------------

describe('L05 · T3.4 — min_note_interval / min_note_duration', () => {
  test('aucune contrepartie hors-ligne : le baké ne peut pas reproduire le gate', async () => {
    const buffer = scaleFile([60, 60, 60, 60], { spacing: 24, dur: 12 }); // 25 ms d'écart
    const caps = { 'devA:0': { polyphony: 1, minNoteInterval: 80 } };
    const live = await replay({ buffer, routing: ROUTING, capabilities: caps });
    const bakedNoCaps = await replay({
      buffer: bakeOffline(buffer, { 0: {} }).buffer,
      routing: ROUTING
    });
    const ons = (t) => t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0).length;
    expect(ons(live.trace)).toBeLessThan(ons(bakedNoCaps.trace));
    // `transposeChannels` n'expose ni minNoteInterval ni minNoteDuration :
    // la seule stratégie temporelle hors-ligne est `polyStrategy:'shorten'`.
    expect(typeof transposer.reducePolyphonyGentle).toBe('function');
    expect(String(transposer.transposeChannels)).not.toContain('minNoteInterval');
    expect(String(transposer.transposeChannels)).not.toContain('minNoteDuration');
  });

  test('T3.4 confirmé : le garde est PAR CANAL en monophonique, PAR HAUTEUR sinon', async () => {
    // Deux hauteurs DIFFÉRENTES en succession rapide.
    const track = [
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 12, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
      { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 72, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 72, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const mono = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 1, minNoteInterval: 100 } }
    });
    const poly = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 8, minNoteInterval: 100 } }
    });
    const ons = (t) =>
      t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0).map((e) => e.data1);
    expect(ons(mono.trace)).not.toContain(64); // bridé par canal
    expect(ons(poly.trace)).toContain(64); // accord préservé
  });
});
