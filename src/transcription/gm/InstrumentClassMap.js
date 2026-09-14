/**
 * @file src/transcription/gm/InstrumentClassMap.js
 * @description Translates the instrument label a transcription engine
 * produced ("piano", "electric bass", "voice") into a General MIDI program.
 *
 * Deliberately a plain, flat table (§15): every engine names instruments
 * differently, so this file is the one place to edit when a new engine's
 * vocabulary shows up. It is data, not logic.
 *
 * Two rules the table obeys:
 *
 *  - **An unknown label stays unknown.** The resolver returns `null`, never a
 *    plausible-looking piano. GMB's own matcher then treats the track as
 *    unassigned and the auto-assigner does what it always does — which is a
 *    better answer than a confident wrong one (§15).
 *  - **Percussion is not resolved here.** A drum track is routed to
 *    {@link module:src/transcription/gm/DrumMapper}, because GM percussion is
 *    a note map, not a program.
 *
 * The GM family a program belongs to is NOT duplicated here: it comes from
 * `shared/instrument-families.json` through `src/midi/gm/InstrumentFamilies.js`.
 */
import { getFamilyForProgram } from '../../midi/gm/InstrumentFamilies.js';

/**
 * Canonical class → GM program. Keys are normalised labels (lowercase,
 * single spaces). Values are GM program numbers (0-based, as in the MIDI
 * wire format — `programNumber` in `midi-file`).
 *
 * Keep this sorted by GM family so a reviewer can see the gaps.
 * @type {Readonly<Object<string, number>>}
 */
export const INSTRUMENT_CLASS_TO_PROGRAM = Object.freeze({
  // Keyboards
  piano: 0,
  'acoustic piano': 0,
  'grand piano': 0,
  'acoustic grand piano': 0,
  'upright piano': 0,
  keyboard: 0,
  'electric piano': 4,
  rhodes: 4,
  wurlitzer: 5,
  harpsichord: 6,
  clavinet: 7,
  celesta: 8,
  organ: 19,
  'electric organ': 16,
  'hammond organ': 16,
  'drawbar organ': 16,
  'church organ': 19,
  'pipe organ': 19,
  accordion: 21,
  harmonica: 22,

  // Chromatic percussion
  glockenspiel: 9,
  'music box': 10,
  vibraphone: 11,
  vibes: 11,
  marimba: 12,
  xylophone: 13,
  'tubular bells': 14,
  dulcimer: 15,

  // Plucked strings
  guitar: 25,
  'acoustic guitar': 25,
  'nylon guitar': 24,
  'classical guitar': 24,
  'steel guitar': 25,
  'electric guitar': 27,
  'clean guitar': 27,
  'jazz guitar': 26,
  'muted guitar': 28,
  'overdriven guitar': 29,
  'distortion guitar': 30,
  'distorted guitar': 30,
  bass: 33,
  'bass guitar': 33,
  'electric bass': 33,
  'acoustic bass': 32,
  'double bass': 43,
  'fretless bass': 35,
  'slap bass': 36,
  'synth bass': 38,
  harp: 46,
  banjo: 105,
  sitar: 104,
  shamisen: 106,
  koto: 107,

  // Bowed strings
  violin: 40,
  fiddle: 110,
  viola: 41,
  cello: 42,
  contrabass: 43,
  'string ensemble': 48,
  strings: 48,
  'pizzicato strings': 45,

  // Ensembles / voice
  choir: 52,
  'choir aahs': 52,
  voice: 53,
  vocals: 53,
  vocal: 53,
  singer: 53,
  'voice oohs': 53,
  'synth voice': 54,
  orchestra: 48,
  'orchestra hit': 55,

  // Brass
  trumpet: 56,
  cornet: 56,
  trombone: 57,
  tuba: 58,
  'muted trumpet': 59,
  'french horn': 60,
  horn: 60,
  'brass section': 61,
  brass: 61,

  // Reeds
  'soprano sax': 64,
  'alto sax': 65,
  saxophone: 65,
  sax: 65,
  'tenor sax': 66,
  'baritone sax': 67,
  oboe: 68,
  'english horn': 69,
  bassoon: 70,
  clarinet: 71,

  // Winds
  piccolo: 72,
  flute: 73,
  recorder: 74,
  'pan flute': 75,
  whistle: 78,
  ocarina: 79,

  // Synths
  synth: 80,
  'synth lead': 80,
  lead: 80,
  'synth pad': 88,
  pad: 88,
  'synth strings': 50,
  'synth brass': 62
});

/**
 * Keyword fallbacks, tried in order when no exact entry matches. Each entry
 * is `[substring, program]`; the first substring found in the normalised
 * label wins. Ordered from most specific to least, so `electric bass` is not
 * shadowed by `bass`.
 * @type {ReadonlyArray<[string, number]>}
 */
export const INSTRUMENT_KEYWORDS = Object.freeze([
  ['electric piano', 4],
  ['grand piano', 0],
  ['piano', 0],
  ['harpsichord', 6],
  ['organ', 19],
  ['accordion', 21],
  ['harmonica', 22],
  ['vibraphone', 11],
  ['marimba', 12],
  ['xylophone', 13],
  ['glockenspiel', 9],
  ['acoustic guitar', 25],
  ['electric guitar', 27],
  ['guitar', 25],
  ['double bass', 43],
  ['upright bass', 43],
  ['synth bass', 38],
  ['bass', 33],
  ['violin', 40],
  ['viola', 41],
  ['cello', 42],
  ['string', 48],
  ['choir', 52],
  ['vocal', 53],
  ['voice', 53],
  ['sing', 53],
  ['trumpet', 56],
  ['trombone', 57],
  ['tuba', 58],
  ['horn', 60],
  ['brass', 61],
  ['sax', 65],
  ['clarinet', 71],
  ['oboe', 68],
  ['bassoon', 70],
  ['flute', 73],
  ['piccolo', 72],
  ['recorder', 74],
  ['whistle', 78],
  ['harp', 46],
  ['banjo', 105],
  ['sitar', 104],
  ['pad', 88],
  ['lead', 80],
  ['synth', 80]
]);

/**
 * Labels that mean "this is percussion". Percussion does not get a program:
 * it gets channel 10 and a note map (see DrumMapper).
 * @type {ReadonlyArray<string>}
 */
export const DRUM_LABELS = Object.freeze([
  'drum',
  'drums',
  'drum kit',
  'drumkit',
  'drum set',
  'drumset',
  'percussion',
  'percussive',
  'kick',
  'snare',
  'hi-hat',
  'hihat',
  'cymbal',
  'tom',
  'beat',
  'beats'
]);

/**
 * Normalise a label for lookup: lowercase, collapse separators, strip the
 * decorations engines add (`_1`, `(solo)`, `track 3 - `).
 *
 * @param {*} label
 * @returns {string} Normalised label, `''` when unusable.
 */
export function normalizeLabel(label) {
  if (typeof label !== 'string') return '';
  return label
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/^track\s*\d+\s*[-:]?\s*/, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {*} label
 * @returns {boolean} True when the label denotes percussion.
 */
export function isDrumLabel(label) {
  const normalized = normalizeLabel(label);
  if (!normalized) return false;
  if (DRUM_LABELS.includes(normalized)) return true;
  // Anything an engine spells starting with "drum" is percussion —
  // drumset, drumloop, drum bus… Listing every compound would be a losing
  // game, and no melodic GM instrument starts with those letters.
  if (normalized.startsWith('drum')) return true;
  return DRUM_LABELS.some((drum) => {
    // Word-boundary match so "trombone" does not match "tom".
    const pattern = new RegExp(`(^|\\s)${drum.replace(/[-]/g, '[- ]?')}(s)?($|\\s)`);
    return pattern.test(normalized);
  });
}

/**
 * Resolve an engine's instrument label to a GM program.
 *
 * @param {*} label - Whatever the engine called it.
 * @returns {?{program: number, matchedBy: string, familySlug: ?string}}
 *   `null` when nothing matches — the caller must NOT substitute a default.
 */
export function resolveInstrumentClass(label) {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;
  if (isDrumLabel(normalized)) return null;

  const exact = INSTRUMENT_CLASS_TO_PROGRAM[normalized];
  if (exact !== undefined) return describe(exact, 'exact');

  // Singular/plural tolerance ("strings" is in the table, "violins" is not).
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : `${normalized}s`;
  const alternate = INSTRUMENT_CLASS_TO_PROGRAM[singular];
  if (alternate !== undefined) return describe(alternate, 'plural');

  for (const [keyword, program] of INSTRUMENT_KEYWORDS) {
    if (normalized.includes(keyword)) return describe(program, `keyword:${keyword}`);
  }
  return null;
}

/**
 * @param {number} program
 * @param {string} matchedBy
 * @returns {{program: number, matchedBy: string, familySlug: ?string}}
 */
function describe(program, matchedBy) {
  const family = getFamilyForProgram(program, null);
  return { program, matchedBy, familySlug: family ? family.slug : null };
}

export default {
  INSTRUMENT_CLASS_TO_PROGRAM,
  INSTRUMENT_KEYWORDS,
  DRUM_LABELS,
  normalizeLabel,
  isDrumLabel,
  resolveInstrumentClass
};
