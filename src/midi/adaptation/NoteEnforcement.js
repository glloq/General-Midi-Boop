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
 * Pick which voice to drop when an instrument's polyphony cap is exceeded,
 * using the same policy as the offline adapter ({@link MidiTransposer}
 * `reducePolyphony`): keep the outer voices (lowest + highest, harmonically
 * the most important) and drop the middle one. Given the set of currently
 * sounding pitches **including** the incoming note, the victim is the median
 * of the sorted pitches. When the victim equals the incoming note the caller
 * should simply gate it; otherwise the caller evicts the already-sounding
 * victim and admits the incoming note, so live playback matches the baked
 * (offline-adapted) result (audit P3-b).
 *
 * @param {number[]} soundingNotes - active pitches incl. the incoming note
 *   (length === polyphony + 1 when called at the cap)
 * @returns {?number} the pitch to drop, or null when nothing to drop
 */
export function selectPolyphonyVictim(soundingNotes) {
  if (!Array.isArray(soundingNotes) || soundingNotes.length === 0) return null;
  const sorted = [...soundingNotes].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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
    // Snap only to selected notes that also fall inside the declared
    // [min,max] window, so a `selected_notes` entry outside the range can't
    // push the result back out of the instrument's physical window (audit
    // P3-d: the fold precedes the snap, so an out-of-range selected note used
    // to win). When no selected note is in range, keep the folded in-range
    // note rather than escaping the range.
    const pool =
      hasRange && (c.noteRangeMin != null || c.noteRangeMax != null)
        ? c.selectedNotes.filter(
            (x) => x >= (c.noteRangeMin ?? 0) && x <= (c.noteRangeMax ?? 127)
          )
        : c.selectedNotes;
    if (pool.length > 0) n = snapToNearest(n, pool);
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
