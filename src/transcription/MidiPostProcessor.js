/**
 * @file src/transcription/MidiPostProcessor.js
 * @description Musical clean-up of a {@link TranscriptionResultShape},
 * between the engine and the MIDI encoder (§13).
 *
 * It is deliberately independent of any backend: every engine produces the
 * same artefacts — ghost notes an octave off, 8 ms fragments, the same pitch
 * detected twice a few milliseconds apart, notes that overlap themselves —
 * and fixing them once here means a new engine inherits the clean-up for
 * free.
 *
 * Three presets (§13):
 *
 * | | `raw` | `balanced` (default) | `clean` |
 * |---|---|---|---|
 * | confidence filter | off | off | 0.4 |
 * | minimum duration | off | 30 ms | 60 ms |
 * | de-duplication | off | 10 ms | 25 ms |
 * | merge repeats | off | off | 30 ms |
 * | velocity normalisation | off | off | on |
 * | quantisation | off | off | **off** |
 * | curve simplification | off | 0.02 | 0.05 |
 *
 * Quantisation stays off even in `clean`: snapping a human performance to a
 * grid is destructive and irreversible, so it is opt-in per job, never a
 * preset default (§48).
 *
 * Overlap repair is the one thing that runs in EVERY preset, `raw`
 * included — two simultaneous Note Ons for the same pitch on the same
 * channel have no defined meaning in MIDI, so leaving them is not
 * "preserving the performance", it is emitting a broken file.
 */
import { createTranscriptionResult } from './TranscriptionResult.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** Shortest gap we bother representing; below it two notes are one event. */
const EPSILON_SECONDS = 0.001;

/**
 * @typedef {Object} PostProcessingOptions
 * @property {?number} minConfidence - Drop notes below this (0..1). Notes
 *   with no confidence reported are never dropped by this filter.
 * @property {number} minDurationSeconds - Drop shorter notes.
 * @property {number} dedupeWindowSeconds - Same pitch starting within this
 *   window is one note.
 * @property {number} mergeGapSeconds - Same pitch separated by less than
 *   this is merged into one sustained note. 0 disables.
 * @property {boolean} fixOverlaps - Always true; see the file header.
 * @property {boolean} normalizeVelocities
 * @property {number} velocityFloor
 * @property {number} velocityCeiling
 * @property {?number} quantizeGrid - Fraction of a beat (0.25 = sixteenth).
 *   null disables — the default in every preset.
 * @property {?number} curveTolerance - Simplification tolerance for
 *   expression curves; null disables.
 */

/** @type {Readonly<Object<string, PostProcessingOptions>>} */
export const PRESETS = Object.freeze({
  raw: Object.freeze({
    minConfidence: null,
    minDurationSeconds: 0,
    dedupeWindowSeconds: 0,
    mergeGapSeconds: 0,
    fixOverlaps: true,
    normalizeVelocities: false,
    velocityFloor: 1,
    velocityCeiling: 127,
    quantizeGrid: null,
    curveTolerance: null
  }),
  balanced: Object.freeze({
    minConfidence: null,
    minDurationSeconds: 0.03,
    dedupeWindowSeconds: 0.01,
    mergeGapSeconds: 0,
    fixOverlaps: true,
    normalizeVelocities: false,
    velocityFloor: 1,
    velocityCeiling: 127,
    quantizeGrid: null,
    curveTolerance: 0.02
  }),
  clean: Object.freeze({
    minConfidence: 0.4,
    minDurationSeconds: 0.06,
    dedupeWindowSeconds: 0.025,
    mergeGapSeconds: 0.03,
    fixOverlaps: true,
    normalizeVelocities: true,
    velocityFloor: 40,
    velocityCeiling: 120,
    quantizeGrid: null,
    curveTolerance: 0.05
  })
});

/** @type {ReadonlyArray<string>} */
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/** Cleans a transcription result before it becomes MIDI. */
export class MidiPostProcessor {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.logger]
   */
  constructor(deps = {}) {
    this.logger = deps.logger || NULL_LOGGER;
  }

  /**
   * Clean a result. The input is never mutated — the caller keeps the raw
   * engine output, which is the whole point of storing it (§12).
   *
   * @param {Object} result - A normalised transcription result.
   * @param {{preset?: string, options?: Partial<PostProcessingOptions>}} [config]
   * @returns {{result: Object, stats: Object, preset: string, options: PostProcessingOptions}}
   */
  process(result, config = {}) {
    const presetName = PRESETS[config.preset] ? config.preset : 'balanced';
    const options = { ...PRESETS[presetName], ...(config.options || {}) };

    const stats = {
      notesIn: 0,
      notesOut: 0,
      droppedLowConfidence: 0,
      droppedShort: 0,
      droppedDuplicate: 0,
      merged: 0,
      overlapsFixed: 0,
      quantized: 0,
      tracksDropped: 0,
      curvePointsIn: 0,
      curvePointsOut: 0
    };

    const beatsPerSecond = tempoAt(result.tempoMap, 0) / 60;
    const tracks = [];

    for (const track of result.tracks || []) {
      stats.notesIn += track.notes.length;
      let notes = track.notes.map(cloneNote);

      if (options.minConfidence !== null && options.minConfidence > 0) {
        const before = notes.length;
        notes = notes.filter((n) => n.confidence === null || n.confidence >= options.minConfidence);
        stats.droppedLowConfidence += before - notes.length;
      }

      if (options.minDurationSeconds > 0) {
        const before = notes.length;
        notes = notes.filter((n) => n.end - n.start >= options.minDurationSeconds);
        stats.droppedShort += before - notes.length;
      }

      if (options.dedupeWindowSeconds > 0) {
        const before = notes.length;
        notes = dedupe(notes, options.dedupeWindowSeconds);
        stats.droppedDuplicate += before - notes.length;
      }

      if (options.mergeGapSeconds > 0) {
        const before = notes.length;
        notes = mergeRepeats(notes, options.mergeGapSeconds);
        stats.merged += before - notes.length;
      }

      if (options.quantizeGrid) {
        stats.quantized += quantize(notes, options.quantizeGrid, beatsPerSecond);
      }

      if (options.fixOverlaps) {
        stats.overlapsFixed += fixOverlaps(notes);
      }

      if (options.normalizeVelocities) {
        normalizeVelocities(notes, options.velocityFloor, options.velocityCeiling);
      }

      if (options.curveTolerance !== null && options.curveTolerance > 0) {
        for (const note of notes) {
          if (!note.expression) continue;
          stats.curvePointsIn += note.expression.pitchCurve.length;
          stats.curvePointsIn += note.expression.amplitudeCurve.length;
          note.expression = {
            pitchCurve: simplifyCurve(note.expression.pitchCurve, options.curveTolerance),
            amplitudeCurve: simplifyCurve(note.expression.amplitudeCurve, options.curveTolerance)
          };
          stats.curvePointsOut += note.expression.pitchCurve.length;
          stats.curvePointsOut += note.expression.amplitudeCurve.length;
          if (
            note.expression.pitchCurve.length === 0 &&
            note.expression.amplitudeCurve.length === 0
          ) {
            note.expression = null;
          }
        }
      }

      // A track emptied by the filters carries no music; keeping it would
      // create an empty MIDI track and an instrument row in the UI for
      // nothing.
      if (notes.length === 0) {
        stats.tracksDropped++;
        continue;
      }
      stats.notesOut += notes.length;
      tracks.push({ ...track, notes });
    }

    const warnings = describeStats(stats);
    // Re-running the normaliser keeps the output a valid result (sorting,
    // clamping) instead of "whatever the filters left behind".
    const cleaned = createTranscriptionResult({
      ...result,
      tracks,
      warnings: [...(result.warnings || []), ...warnings]
    });

    if (stats.notesIn !== stats.notesOut) {
      this.logger.info(
        `MidiPostProcessor[${presetName}]: ${stats.notesIn} → ${stats.notesOut} notes ` +
          `(short:${stats.droppedShort} dup:${stats.droppedDuplicate} ` +
          `low-confidence:${stats.droppedLowConfidence} merged:${stats.merged} ` +
          `overlaps:${stats.overlapsFixed})`
      );
    }

    return { result: cleaned, stats, preset: presetName, options };
  }
}

/**
 * @param {Object} note
 * @returns {Object} Deep-enough copy (expression curves included).
 */
function cloneNote(note) {
  return {
    ...note,
    expression: note.expression
      ? {
          pitchCurve: note.expression.pitchCurve.map((p) => ({ ...p })),
          amplitudeCurve: note.expression.amplitudeCurve.map((p) => ({ ...p }))
        }
      : null
  };
}

/**
 * Drop notes of the same pitch starting within `window` of one another,
 * keeping the most confident (then the longest) of each cluster.
 *
 * @param {Object[]} notes - Sorted by start.
 * @param {number} window - Seconds.
 * @returns {Object[]}
 */
export function dedupe(notes, window) {
  const kept = [];
  const lastByPitch = new Map();
  for (const note of notes) {
    const previous = lastByPitch.get(note.pitch);
    if (previous && note.start - previous.start <= window) {
      const previousScore = (previous.confidence ?? 0.5) * 1000 + (previous.end - previous.start);
      const score = (note.confidence ?? 0.5) * 1000 + (note.end - note.start);
      if (score > previousScore) {
        // Replace the weaker duplicate in place, keeping the earlier onset:
        // the onset is what a listener hears, the tail is what differs.
        previous.end = Math.max(previous.end, note.end);
        previous.velocity = note.velocity;
        previous.confidence = note.confidence;
        previous.expression = note.expression;
      } else {
        previous.end = Math.max(previous.end, note.end);
      }
      continue;
    }
    const copy = note;
    kept.push(copy);
    lastByPitch.set(note.pitch, copy);
  }
  return kept;
}

/**
 * Merge same-pitch notes separated by less than `gap` into one sustained
 * note — a model re-triggering a held note every analysis frame.
 *
 * @param {Object[]} notes - Sorted by start.
 * @param {number} gap - Seconds.
 * @returns {Object[]}
 */
export function mergeRepeats(notes, gap) {
  const kept = [];
  const openByPitch = new Map();
  for (const note of notes) {
    const open = openByPitch.get(note.pitch);
    if (open && note.start - open.end <= gap && note.start >= open.start) {
      open.end = Math.max(open.end, note.end);
      open.velocity = Math.max(open.velocity, note.velocity);
      if (note.confidence !== null) {
        open.confidence =
          open.confidence === null ? note.confidence : Math.max(open.confidence, note.confidence);
      }
      continue;
    }
    kept.push(note);
    openByPitch.set(note.pitch, note);
  }
  return kept;
}

/**
 * Truncate a note that is still sounding when the same pitch restarts on the
 * same track. Mutates in place; returns how many were repaired.
 *
 * @param {Object[]} notes - Sorted by start.
 * @returns {number}
 */
export function fixOverlaps(notes) {
  let fixed = 0;
  const openByPitch = new Map();
  for (const note of notes) {
    const open = openByPitch.get(note.pitch);
    if (open && open.end > note.start) {
      open.end = Math.max(note.start - EPSILON_SECONDS, open.start + EPSILON_SECONDS);
      fixed++;
    }
    openByPitch.set(note.pitch, note);
  }
  return fixed;
}

/**
 * Stretch the velocity distribution into `[floor..ceiling]`. A track whose
 * notes all share one velocity is left alone: there is no dynamic to
 * normalise, and inventing one would be a lie about the performance.
 *
 * @param {Object[]} notes - Mutated in place.
 * @param {number} floor
 * @param {number} ceiling
 * @returns {void}
 */
export function normalizeVelocities(notes, floor, ceiling) {
  if (notes.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const note of notes) {
    if (note.velocity < min) min = note.velocity;
    if (note.velocity > max) max = note.velocity;
  }
  if (max - min < 2) return;
  const scale = (ceiling - floor) / (max - min);
  for (const note of notes) {
    note.velocity = Math.max(1, Math.min(127, Math.round(floor + (note.velocity - min) * scale)));
  }
}

/**
 * Snap onsets and offsets to a grid. Opt-in only.
 *
 * @param {Object[]} notes - Mutated in place.
 * @param {number} grid - Fraction of a beat (0.25 = sixteenth note).
 * @param {number} beatsPerSecond
 * @returns {number} Number of notes moved.
 */
export function quantize(notes, grid, beatsPerSecond) {
  if (!(grid > 0) || !(beatsPerSecond > 0)) return 0;
  const step = grid / beatsPerSecond;
  let moved = 0;
  for (const note of notes) {
    const start = Math.round(note.start / step) * step;
    let end = Math.round(note.end / step) * step;
    // Never quantise a note out of existence.
    if (end <= start) end = start + step;
    if (start !== note.start || end !== note.end) moved++;
    note.start = start;
    note.end = end;
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return moved;
}

/**
 * Ramer–Douglas–Peucker simplification of an expression curve.
 *
 * A 200-point pitch contour per note turns into thousands of MIDI events
 * that no instrument can follow and that bloat the file; the curve is kept,
 * just described with fewer points (§14).
 *
 * @param {Array<{t:number, value:number}>} points
 * @param {number} tolerance - Maximum deviation, in the curve's own units.
 * @returns {Array<{t:number, value:number}>}
 */
export function simplifyCurve(points, tolerance) {
  if (!Array.isArray(points) || points.length <= 2) return points ? [...points] : [];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative RDP: a recursive one blows the stack on a pathological curve.
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;

    const a = points[first];
    const b = points[last];
    const dt = b.t - a.t;
    const dv = b.value - a.value;
    const norm = Math.hypot(dt, dv) || 1;

    let maxDistance = 0;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const distance = Math.abs(dv * (p.t - a.t) - dt * (p.value - a.value)) / norm;
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }

    if (maxDistance > tolerance && maxIndex > 0) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push({ ...points[i] });
  }
  // A curve that reduces to its two endpoints and barely moves says nothing
  // — drop it rather than emit two pointless MIDI events.
  if (out.length === 2 && Math.abs(out[1].value - out[0].value) <= tolerance) return [];
  return out;
}

/**
 * BPM in effect at `time`, defaulting to 120 when the engine detected no
 * tempo. Used only for quantisation maths — nothing is written to the file.
 *
 * @param {Array<{time:number,bpm:number}>} tempoMap
 * @param {number} time - Seconds.
 * @returns {number}
 */
export function tempoAt(tempoMap, time) {
  if (!Array.isArray(tempoMap) || tempoMap.length === 0) return 120;
  let bpm = tempoMap[0].bpm;
  for (const entry of tempoMap) {
    if (entry.time <= time) bpm = entry.bpm;
    else break;
  }
  return bpm;
}

/**
 * Turn the statistics into the short, user-readable warnings the result
 * screen shows (§32).
 *
 * @param {Object} stats
 * @returns {string[]}
 */
export function describeStats(stats) {
  const warnings = [];
  if (stats.droppedLowConfidence > 0) {
    warnings.push(`${stats.droppedLowConfidence} low-confidence notes removed`);
  }
  if (stats.droppedShort > 0) warnings.push(`${stats.droppedShort} very short notes removed`);
  if (stats.droppedDuplicate > 0)
    warnings.push(`${stats.droppedDuplicate} duplicate notes removed`);
  if (stats.merged > 0) warnings.push(`${stats.merged} repeated notes merged`);
  if (stats.overlapsFixed > 0) warnings.push(`${stats.overlapsFixed} overlapping notes shortened`);
  if (stats.quantized > 0) warnings.push(`${stats.quantized} notes quantized`);
  if (stats.tracksDropped > 0) warnings.push(`${stats.tracksDropped} empty tracks removed`);
  return warnings;
}

export default MidiPostProcessor;
