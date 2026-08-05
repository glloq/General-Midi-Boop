/**
 * @file src/midi/adaptation/NoteEnforcement.js
 * @description Stateless note-clamping shared by the file-playback engine
 * ({@link PlaybackScheduler}) and the live route-through ({@link MidiRouter}).
 * Folds an out-of-range pitch into the instrument's window and snaps it to the
 * instrument's physically playable set — the explicit `selected_notes` when
 * present, otherwise the diatonic/pentatonic scale derived from
 * `octave_mode` + `scale_root`.
 *
 * Stateful enforcement (polyphony gating, min-note interval/duration) lives in
 * the scheduler and is NOT part of this module — it needs per-stream note
 * state that the live router does not yet track (audit P2-3).
 */

import { scaleNotes, restrictsScale } from './ScaleSnapper.js';

/**
 * Fold `note` into `[min,max]` by whole octaves (pitch-class preserving). When
 * no octave of the pitch class fits (range narrower than an octave), clamp to
 * the nearest bound. Returns the note unchanged when no range is declared.
 *
 * @param {number} note
 * @param {?number} min
 * @param {?number} max
 * @returns {number}
 */
export function foldIntoRange(note, min, max) {
  if (min == null && max == null) return note;
  const lo = min == null ? 0 : min;
  const hi = max == null ? 127 : max;
  if (lo > hi) return note; // misconfigured range — leave untouched
  let n = note;
  while (n < lo) n += 12;
  while (n > hi) n -= 12;
  if (n < lo) n = lo;
  if (n > hi) n = hi;
  return n;
}

/**
 * Snap `note` to the nearest value in `list`. Ties break downward. Returns the
 * note unchanged when the list is empty.
 *
 * @param {number} note
 * @param {number[]} list
 * @returns {number}
 */
export function snapToNearest(note, list) {
  if (!Array.isArray(list) || list.length === 0) return note;
  let best = list[0];
  let bestDist = Math.abs(note - best);
  for (let i = 1; i < list.length; i++) {
    const d = Math.abs(note - list[i]);
    if (d < bestDist || (d === bestDist && list[i] < best)) {
      best = list[i];
      bestDist = d;
    }
  }
  return best;
}

/**
 * Clamp `note` to what an instrument can physically play, given its resolved
 * timing/capability constraints: octave-fold into range, then snap to the
 * explicit discrete set (`selectedNotes`) if any, else to the diatonic/
 * pentatonic scale (`octaveMode` + `scaleRoot`). Callers must skip the GM drum
 * channel (9), whose "notes" are voice selectors, not pitches.
 *
 * @param {number} note
 * @param {Object} [constraints] - as returned by CapabilityResolver.getTimingConstraints
 * @returns {number}
 */
export function clampNote(note, constraints) {
  const c = constraints || {};
  let n = note;
  const hasRange = c.noteRangeMin != null || c.noteRangeMax != null;
  if (hasRange) {
    n = foldIntoRange(n, c.noteRangeMin, c.noteRangeMax);
  }
  if (Array.isArray(c.selectedNotes) && c.selectedNotes.length > 0) {
    n = snapToNearest(n, c.selectedNotes);
  } else if (restrictsScale(c.octaveMode) && hasRange) {
    const inScale = scaleNotes(
      c.noteRangeMin ?? 0,
      c.noteRangeMax ?? 127,
      c.octaveMode,
      c.scaleRoot ?? 0
    );
    if (inScale.length > 0) n = snapToNearest(n, inScale);
  }
  return n;
}
