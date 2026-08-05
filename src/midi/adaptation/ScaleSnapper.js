/**
 * @file src/midi/adaptation/ScaleSnapper.js
 * @description Diatonic / pentatonic scale materialisation for the playback
 * engine and the live router. Mirrors the frontend's
 * `InstrumentSettingsModal.computePlayableNotes` (public/js/features/
 * InstrumentSettingsModal.js — keep the interval tables in sync) so that a
 * range-mode instrument whose `octave_mode` is 'diatonic'/'pentatonic' is
 * snapped to its in-scale pitches by the backend too, not only when the
 * settings modal happened to materialise them into `selected_notes`.
 *
 * Audit P2-5: `octave_mode` / `scale_root` had no backend consumer — the
 * playback pipeline ignored them entirely, so any non-UI writer (auto-assign
 * editor, API, future descriptor) that set a scale in range mode played every
 * chromatic note.
 */

/** Pitch-class intervals per octave mode, relative to the scale root (0-11). */
export const SCALE_INTERVALS = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  diatonic: [0, 2, 4, 5, 7, 9, 11],
  pentatonic: [0, 2, 4, 7, 9]
};

/**
 * Whether `octaveMode` actually restricts the chromatic set — i.e. is a known
 * non-chromatic scale. A chromatic / absent / unknown mode is a no-op.
 *
 * @param {string} [octaveMode]
 * @returns {boolean}
 */
export function restrictsScale(octaveMode) {
  return octaveMode != null && octaveMode !== 'chromatic' && SCALE_INTERVALS[octaveMode] != null;
}

/**
 * The MIDI notes in [min,max] that belong to `octaveMode` built on `scaleRoot`
 * (pitch class 0-11). Chromatic / unknown modes return every note in the range.
 * Bounds are clamped to 0-127 and truncated to integers.
 *
 * @param {number} min
 * @param {number} max
 * @param {string} octaveMode
 * @param {number} [scaleRoot=0]
 * @returns {number[]}
 */
export function scaleNotes(min, max, octaveMode, scaleRoot = 0) {
  const lo = Math.max(0, Math.min(127, Math.trunc(min ?? 0)));
  const hi = Math.max(0, Math.min(127, Math.trunc(max ?? 127)));
  if (hi < lo) return [];
  const intervals = SCALE_INTERVALS[octaveMode];
  const notes = [];
  if (!intervals || octaveMode === 'chromatic') {
    for (let n = lo; n <= hi; n++) notes.push(n);
    return notes;
  }
  const r = Number.isInteger(scaleRoot) ? ((scaleRoot % 12) + 12) % 12 : 0;
  for (let n = lo; n <= hi; n++) {
    const semitone = (((n - r) % 12) + 12) % 12;
    if (intervals.includes(semitone)) notes.push(n);
  }
  return notes;
}
