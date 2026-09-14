/**
 * @file src/transcription/gm/DrumMapper.js
 * @description Maps the percussion labels an engine emits ("kick", "snare",
 * "closed hi-hat") onto General MIDI percussion notes on channel 10 (§16).
 *
 * Not to be confused with `src/midi/adaptation/DrumNoteMapper.js`, which
 * solves the opposite problem: a GM drum note the *hardware* cannot play,
 * substituted for one it can. This module goes label → GM note; that one goes
 * GM note → reachable GM note. They compose, they do not overlap.
 *
 * The mapper is independent of any engine, and it does **not** invent
 * percussion: when a backend cannot name a hit, the note is passed through
 * unchanged if it already sits in the GM percussion range, and reported as
 * unmapped otherwise. Simulating drum detection an engine does not have
 * would be worse than leaving the track as-is (§16).
 */

/** GM percussion occupies notes 35..81 on channel 10 (index 9). */
export const GM_DRUM_CHANNEL = 9;
export const GM_DRUM_NOTE_MIN = 35;
export const GM_DRUM_NOTE_MAX = 81;

/**
 * Canonical percussion label → GM note. Keys are normalised (lowercase,
 * spaces). Plain data: add a row when an engine uses a new word.
 * @type {Readonly<Object<string, number>>}
 */
export const DRUM_LABEL_TO_NOTE = Object.freeze({
  // Kicks
  kick: 36,
  'kick drum': 36,
  'bass drum': 36,
  bd: 36,
  'acoustic bass drum': 35,

  // Snares
  snare: 38,
  'snare drum': 38,
  sd: 38,
  'acoustic snare': 38,
  'electric snare': 40,
  rimshot: 37,
  'rim shot': 37,
  'side stick': 37,
  crossstick: 37,
  'cross stick': 37,
  clap: 39,
  'hand clap': 39,

  // Hi-hats
  hihat: 42,
  'hi hat': 42,
  'closed hi hat': 42,
  'closed hihat': 42,
  hhc: 42,
  'pedal hi hat': 44,
  'foot hi hat': 44,
  'open hi hat': 46,
  'open hihat': 46,
  hho: 46,

  // Toms
  tom: 45,
  'low tom': 45,
  'low floor tom': 41,
  'floor tom': 43,
  'high floor tom': 43,
  'mid tom': 47,
  'low mid tom': 47,
  'hi mid tom': 48,
  'high tom': 50,
  'rack tom': 48,

  // Cymbals
  crash: 49,
  'crash cymbal': 49,
  'crash cymbal 2': 57,
  'chinese cymbal': 52,
  'splash cymbal': 55,
  splash: 55,
  ride: 51,
  'ride cymbal': 51,
  'ride bell': 53,
  'ride cymbal 2': 59,
  cymbal: 49,

  // Hand / latin percussion
  tambourine: 54,
  cowbell: 56,
  vibraslap: 58,
  'high bongo': 60,
  bongo: 60,
  'low bongo': 61,
  'mute high conga': 62,
  'open high conga': 63,
  conga: 63,
  'low conga': 64,
  'high timbale': 65,
  timbale: 65,
  'low timbale': 66,
  'high agogo': 67,
  agogo: 67,
  'low agogo': 68,
  cabasa: 69,
  maracas: 70,
  'short whistle': 71,
  'long whistle': 72,
  'short guiro': 73,
  'long guiro': 74,
  guiro: 74,
  claves: 75,
  'high wood block': 76,
  'wood block': 76,
  'low wood block': 77,
  'mute cuica': 78,
  'open cuica': 79,
  'mute triangle': 80,
  triangle: 81,
  'open triangle': 81,
  shaker: 70,
  woodblock: 76
});

/**
 * Keyword fallbacks, most specific first — the same shape as the melodic
 * table so both read alike.
 * @type {ReadonlyArray<[string, number]>}
 */
export const DRUM_KEYWORDS = Object.freeze([
  ['open hi', 46],
  ['pedal hi', 44],
  ['closed hi', 42],
  ['hi hat', 42],
  ['hihat', 42],
  ['kick', 36],
  ['bass drum', 36],
  ['snare', 38],
  ['clap', 39],
  ['rim', 37],
  ['floor tom', 43],
  ['tom', 45],
  ['crash', 49],
  ['ride', 51],
  ['splash', 55],
  ['china', 52],
  ['cymbal', 49],
  ['tambourine', 54],
  ['cowbell', 56],
  ['conga', 63],
  ['bongo', 60],
  ['timbale', 65],
  ['agogo', 67],
  ['cabasa', 69],
  ['maraca', 70],
  ['shaker', 70],
  ['guiro', 74],
  ['clave', 75],
  ['block', 76],
  ['cuica', 78],
  ['triangle', 81]
]);

/**
 * Normalise a percussion label for lookup.
 * @param {*} label
 * @returns {string}
 */
export function normalizeDrumLabel(label) {
  if (typeof label !== 'string') return '';
  return label
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a percussion label to a GM note.
 *
 * @param {*} label
 * @returns {?{note: number, matchedBy: string}} null when the label means
 *   nothing to us — the caller decides what to do, it must not guess.
 */
export function resolveDrumLabel(label) {
  const normalized = normalizeDrumLabel(label);
  if (!normalized) return null;

  const exact = DRUM_LABEL_TO_NOTE[normalized];
  if (exact !== undefined) return { note: exact, matchedBy: 'exact' };

  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : `${normalized}s`;
  const alternate = DRUM_LABEL_TO_NOTE[singular];
  if (alternate !== undefined) return { note: alternate, matchedBy: 'plural' };

  for (const [keyword, note] of DRUM_KEYWORDS) {
    if (normalized.includes(keyword)) return { note, matchedBy: `keyword:${keyword}` };
  }
  return null;
}

/**
 * @param {number} note
 * @returns {boolean} True when the note is inside the GM percussion range.
 */
export function isGmDrumNote(note) {
  return Number.isInteger(note) && note >= GM_DRUM_NOTE_MIN && note <= GM_DRUM_NOTE_MAX;
}

/**
 * Map one detected hit onto a GM percussion note.
 *
 * Resolution order — label first, because a name carries the engine's
 * intent, whereas a note number may just be the index of a model output bin:
 *   1. the hit's own label (`note.label` / `note.drum`);
 *   2. the track's instrument label, when every hit shares it;
 *   3. the raw pitch, if it already is a GM percussion note;
 *   4. nothing — reported as unmapped.
 *
 * @param {{pitch: number, label?: string, drum?: string}} note
 * @param {{trackLabel?: string}} [context]
 * @returns {{note: ?number, matchedBy: string}}
 */
export function mapDrumNote(note, context = {}) {
  const fromLabel = resolveDrumLabel(note?.label ?? note?.drum);
  if (fromLabel) return { note: fromLabel.note, matchedBy: `label:${fromLabel.matchedBy}` };

  const fromTrack = resolveDrumLabel(context.trackLabel);
  if (fromTrack) return { note: fromTrack.note, matchedBy: `track:${fromTrack.matchedBy}` };

  if (isGmDrumNote(note?.pitch)) return { note: note.pitch, matchedBy: 'pitch' };

  return { note: null, matchedBy: 'unmapped' };
}

export default {
  GM_DRUM_CHANNEL,
  GM_DRUM_NOTE_MIN,
  GM_DRUM_NOTE_MAX,
  DRUM_LABEL_TO_NOTE,
  DRUM_KEYWORDS,
  normalizeDrumLabel,
  resolveDrumLabel,
  isGmDrumNote,
  mapDrumNote
};
