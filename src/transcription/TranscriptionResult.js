/**
 * @file src/transcription/TranscriptionResult.js
 * @description The pivot format of the transcription pipeline: everything a
 * backend understood about the audio, before any musical decision is taken.
 *
 * ## Why this exists
 *
 * The obvious design — `audio → model → MIDI` — throws away exactly what the
 * interesting features need later: per-note confidence, pitch/amplitude
 * contours, the instrument the model *thought* it heard. Those are cheap to
 * carry and impossible to recover once a Standard MIDI File has been written.
 * Keeping them in one normalised structure (§11/§12) is what makes manual
 * correction, low-confidence highlighting, MPE / MIDI 2.0 export, partial
 * re-transcription and engine comparison possible without another pipeline.
 *
 * ## What it is not
 *
 * It is NOT MIDI. Times are **seconds** (not ticks), tempo is informational,
 * and nothing here is channel- or program-mapped: `MidiPostProcessor` and
 * `MidiEncoder` (PR 4) own that translation. A backend that knows nothing
 * about tempo leaves `tempoMap` empty rather than inventing 120 BPM.
 */
import { TranscriptionError, TRANSCRIPTION_REASONS } from './TranscriptionError.js';

/**
 * Schema version of the structure below. Bump on any breaking change; a
 * persisted or cached result carrying an older version must be migrated or
 * discarded rather than read optimistically.
 * @type {number}
 */
export const TRANSCRIPTION_RESULT_VERSION = 1;

/** Hard ceilings. A malformed or hostile backend answer must not OOM the Pi. */
export const RESULT_LIMITS = Object.freeze({
  MAX_TRACKS: 64,
  MAX_NOTES_PER_TRACK: 200000,
  MAX_TOTAL_NOTES: 500000,
  MAX_CURVE_POINTS: 4096,
  MAX_WARNINGS: 200
});

/** Longest per-note / per-track label kept from an engine. */
const MAX_LABEL_LENGTH = 64;

/**
 * @typedef {Object} CurvePoint
 * @property {number} t - Seconds, absolute (same clock as note start/end).
 * @property {number} value - Semitone offset for a pitch curve, linear
 *   amplitude in [0..1] for an amplitude curve.
 */

/**
 * @typedef {Object} NoteExpression
 * @property {CurvePoint[]} pitchCurve - Empty when the backend has none.
 * @property {CurvePoint[]} amplitudeCurve - Empty when the backend has none.
 */

/**
 * @typedef {Object} TranscribedNote
 * @property {number} start - Seconds from the beginning of the audio.
 * @property {number} end - Seconds; strictly greater than `start`.
 * @property {number} pitch - MIDI note number 0..127.
 * @property {number} velocity - 1..127.
 * @property {?number} confidence - 0..1, or null when not reported.
 * @property {?string} label - What the engine called THIS hit — a drum name
 *   (`"kick"`, `"closed hi-hat"`) or an articulation. Carried because a
 *   percussion model names its outputs rather than numbering them in GM
 *   order, and that naming is the only thing the drum mapper can work from
 *   (§16); dropping it here would make drum transcription impossible
 *   downstream. null when the engine named nothing.
 * @property {?NoteExpression} expression - null when the backend reports none.
 */

/**
 * @typedef {Object} TrackInstrument
 * @property {?string} family - Free-form source class as heard by the model
 *   (`"piano"`, `"voice"`, `"bass"`…). NOT a GM family slug: the mapping to
 *   `shared/instrument-families.json` happens in the GM mapper (PR 4).
 * @property {?string} label - Human label for the UI.
 * @property {?number} confidence - 0..1, or null.
 * @property {?number} gmProgram - 0..127 when the backend already knows the
 *   General MIDI program; null means "unknown, let GMB decide" — never guess.
 * @property {boolean} isDrums - True only when the backend genuinely detected
 *   percussion; a backend without drum support always reports false (§16).
 */

/**
 * @typedef {Object} TranscribedTrack
 * @property {string} id
 * @property {?string} name
 * @property {TrackInstrument} instrument
 * @property {TranscribedNote[]} notes - Sorted by `start`, then `pitch`.
 */

/**
 * @typedef {Object} TranscriptionResultShape
 * @property {number} version
 * @property {{filename: ?string, duration: ?number, sampleRate: ?number,
 *   channels: ?number}} source
 * @property {{id: ?string, version: ?string, protocolVersion: ?number}} backend
 * @property {Array<{time: number, bpm: number}>} tempoMap - Times in seconds.
 * @property {Array<{time: number, numerator: number, denominator: number}>} timeSignatures
 * @property {TranscribedTrack[]} tracks
 * @property {string[]} warnings
 * @property {string} createdAt - ISO-8601.
 */

/**
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {*} value
 * @returns {boolean} True for a real, finite number (rejects NaN/Infinity and
 *   the numeric strings a JSON-producing backend should never emit).
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * @param {*} value
 * @returns {?number} `value` clamped to [0..1], or null when absent/invalid.
 */
function normalizeConfidence(value) {
  if (value === undefined || value === null) return null;
  if (!isFiniteNumber(value)) return null;
  return clamp(value, 0, 1);
}

/**
 * Normalise one expression curve: finite points only, sorted by time, capped
 * in length. Curve *simplification* (tolerance-based decimation, §14) is a
 * post-processing concern and deliberately not done here.
 *
 * @param {*} points
 * @param {string} path - Error path prefix for diagnostics.
 * @param {string[]} errors - Collected errors (mutated).
 * @returns {CurvePoint[]}
 */
function normalizeCurve(points, path, errors) {
  if (points === undefined || points === null) return [];
  if (!Array.isArray(points)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (points.length > RESULT_LIMITS.MAX_CURVE_POINTS) {
    errors.push(`${path} has ${points.length} points (max ${RESULT_LIMITS.MAX_CURVE_POINTS})`);
    return [];
  }
  const out = [];
  for (const point of points) {
    if (!isPlainObject(point)) continue;
    if (!isFiniteNumber(point.t) || !isFiniteNumber(point.value)) continue;
    out.push({ t: point.t, value: point.value });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * @param {*} raw
 * @param {string} path
 * @param {string[]} errors
 * @returns {?NoteExpression}
 */
function normalizeExpression(raw, path, errors) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const pitchCurve = normalizeCurve(raw.pitchCurve, `${path}.pitchCurve`, errors);
  const amplitudeCurve = normalizeCurve(raw.amplitudeCurve, `${path}.amplitudeCurve`, errors);
  if (pitchCurve.length === 0 && amplitudeCurve.length === 0) return null;
  return { pitchCurve, amplitudeCurve };
}

/**
 * Normalise a single note. Out-of-range values are clamped rather than
 * rejected (a model emitting velocity 131 is common and harmless); a note
 * with no usable position in time IS rejected, because silently keeping it
 * would corrupt every downstream assumption.
 *
 * @param {*} raw
 * @param {string} path
 * @param {string[]} errors
 * @returns {?TranscribedNote}
 */
function normalizeNote(raw, path, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  if (!isFiniteNumber(raw.start) || !isFiniteNumber(raw.end)) {
    errors.push(`${path} must have finite numeric start/end (seconds)`);
    return null;
  }
  if (raw.start < 0) {
    errors.push(`${path}.start must be >= 0`);
    return null;
  }
  if (raw.end <= raw.start) {
    errors.push(`${path}.end must be greater than start`);
    return null;
  }
  if (!isFiniteNumber(raw.pitch)) {
    errors.push(`${path}.pitch must be a MIDI note number`);
    return null;
  }
  const pitch = clamp(Math.round(raw.pitch), 0, 127);
  // Velocity 0 is a Note Off in MIDI, so an audible note can never carry it.
  const velocity = isFiniteNumber(raw.velocity) ? clamp(Math.round(raw.velocity), 1, 127) : 64;
  // `drum` is accepted as an alias because several percussion models spell it
  // that way; one normalised field downstream.
  const rawLabel = raw.label ?? raw.drum;
  return {
    start: raw.start,
    end: raw.end,
    pitch,
    velocity,
    confidence: normalizeConfidence(raw.confidence),
    label:
      typeof rawLabel === 'string' && rawLabel.length > 0
        ? rawLabel.slice(0, MAX_LABEL_LENGTH)
        : null,
    expression: normalizeExpression(raw.expression, `${path}.expression`, errors)
  };
}

/**
 * @param {*} raw
 * @param {string} path
 * @param {string[]} errors
 * @returns {TrackInstrument}
 */
function normalizeInstrument(raw, path, errors) {
  const input = isPlainObject(raw) ? raw : {};
  let gmProgram = null;
  if (input.gmProgram !== undefined && input.gmProgram !== null) {
    if (!isFiniteNumber(input.gmProgram)) {
      errors.push(`${path}.gmProgram must be a number 0..127 or null`);
    } else {
      gmProgram = clamp(Math.round(input.gmProgram), 0, 127);
    }
  }
  return {
    family: typeof input.family === 'string' && input.family ? input.family : null,
    label: typeof input.label === 'string' && input.label ? input.label : null,
    confidence: normalizeConfidence(input.confidence),
    gmProgram,
    isDrums: input.isDrums === true
  };
}

/**
 * @param {*} raw
 * @param {number} index
 * @param {string[]} errors
 * @param {{total: number}} counters - Running note total across tracks.
 * @returns {?TranscribedTrack}
 */
function normalizeTrack(raw, index, errors, counters) {
  const path = `tracks[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const rawNotes = raw.notes === undefined || raw.notes === null ? [] : raw.notes;
  if (!Array.isArray(rawNotes)) {
    errors.push(`${path}.notes must be an array`);
    return null;
  }
  if (rawNotes.length > RESULT_LIMITS.MAX_NOTES_PER_TRACK) {
    errors.push(
      `${path}.notes holds ${rawNotes.length} notes (max ${RESULT_LIMITS.MAX_NOTES_PER_TRACK})`
    );
    return null;
  }

  const notes = [];
  for (let i = 0; i < rawNotes.length; i++) {
    const note = normalizeNote(rawNotes[i], `${path}.notes[${i}]`, errors);
    if (note) notes.push(note);
  }
  counters.total += notes.length;
  if (counters.total > RESULT_LIMITS.MAX_TOTAL_NOTES) {
    errors.push(`result holds more than ${RESULT_LIMITS.MAX_TOTAL_NOTES} notes`);
    return null;
  }

  // Deterministic order: downstream diffing, encoding and UI rendering all
  // assume it, and backends emit notes in whatever order their model did.
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `track-${index + 1}`,
    name: typeof raw.name === 'string' && raw.name ? raw.name : null,
    instrument: normalizeInstrument(raw.instrument, `${path}.instrument`, errors),
    notes
  };
}

/**
 * @param {*} raw
 * @param {string[]} errors
 * @returns {Array<{time: number, bpm: number}>}
 */
function normalizeTempoMap(raw, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push('tempoMap must be an array');
    return [];
  }
  const out = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (!isFiniteNumber(entry.time) || entry.time < 0) continue;
    if (!isFiniteNumber(entry.bpm) || entry.bpm <= 0 || entry.bpm > 999) continue;
    out.push({ time: entry.time, bpm: entry.bpm });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * @param {*} raw
 * @param {string[]} errors
 * @returns {Array<{time: number, numerator: number, denominator: number}>}
 */
function normalizeTimeSignatures(raw, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push('timeSignatures must be an array');
    return [];
  }
  const out = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (!isFiniteNumber(entry.time) || entry.time < 0) continue;
    const numerator = Math.round(entry.numerator);
    const denominator = Math.round(entry.denominator);
    if (!Number.isInteger(numerator) || numerator < 1 || numerator > 32) continue;
    // SMF encodes the denominator as a power of two.
    if (![1, 2, 4, 8, 16, 32].includes(denominator)) continue;
    out.push({ time: entry.time, numerator, denominator });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * @param {*} raw
 * @returns {string[]} At most {@link RESULT_LIMITS}.MAX_WARNINGS strings.
 */
function normalizeWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w) => typeof w === 'string' && w.length > 0)
    .slice(0, RESULT_LIMITS.MAX_WARNINGS);
}

/**
 * Build a normalised {@link TranscriptionResultShape} from whatever a backend
 * produced, collecting every problem instead of stopping at the first.
 *
 * Missing information stays missing: absent fields become `null` / `[]`, they
 * are never invented (§11, §15 "do not fabricate precision").
 *
 * @param {Object} input - Raw backend output.
 * @returns {{result: ?TranscriptionResultShape, errors: string[]}} `result` is
 *   null when the structure is unusable.
 */
export function normalizeTranscriptionResult(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { result: null, errors: ['transcription result must be an object'] };
  }

  const rawTracks = input.tracks === undefined || input.tracks === null ? [] : input.tracks;
  if (!Array.isArray(rawTracks)) {
    return { result: null, errors: ['tracks must be an array'] };
  }
  if (rawTracks.length > RESULT_LIMITS.MAX_TRACKS) {
    return {
      result: null,
      errors: [`result holds ${rawTracks.length} tracks (max ${RESULT_LIMITS.MAX_TRACKS})`]
    };
  }

  const counters = { total: 0 };
  const tracks = [];
  let fatal = false;
  for (let i = 0; i < rawTracks.length; i++) {
    const track = normalizeTrack(rawTracks[i], i, errors, counters);
    if (track) tracks.push(track);
    else fatal = true;
  }
  if (fatal) return { result: null, errors };

  const source = isPlainObject(input.source) ? input.source : {};
  const backend = isPlainObject(input.backend) ? input.backend : {};

  const result = {
    version: TRANSCRIPTION_RESULT_VERSION,
    source: {
      filename: typeof source.filename === 'string' ? source.filename : null,
      duration: isFiniteNumber(source.duration) && source.duration >= 0 ? source.duration : null,
      sampleRate: isFiniteNumber(source.sampleRate) ? Math.round(source.sampleRate) : null,
      channels: isFiniteNumber(source.channels) ? Math.round(source.channels) : null
    },
    backend: {
      id: typeof backend.id === 'string' ? backend.id : null,
      version: typeof backend.version === 'string' ? backend.version : null,
      protocolVersion: isFiniteNumber(backend.protocolVersion) ? backend.protocolVersion : null
    },
    tempoMap: normalizeTempoMap(input.tempoMap, errors),
    timeSignatures: normalizeTimeSignatures(input.timeSignatures, errors),
    tracks,
    warnings: normalizeWarnings(input.warnings),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString()
  };

  return { result, errors };
}

/**
 * Strict constructor: normalise and throw when the structure is unusable.
 *
 * Non-fatal problems (a dropped malformed note, a rejected curve) do not
 * throw — they are appended to `result.warnings` so the user sees that the
 * engine's output was imperfect instead of silently losing material.
 *
 * @param {Object} input - Raw backend output.
 * @param {{backendId?: string}} [options]
 * @returns {TranscriptionResultShape}
 * @throws {TranscriptionError} reason `BACKEND_FAILED` when unusable.
 */
export function createTranscriptionResult(input, options = {}) {
  const { result, errors } = normalizeTranscriptionResult(input);
  if (!result) {
    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.BACKEND_FAILED,
      `Backend returned an unusable transcription result: ${errors.slice(0, 5).join('; ')}`,
      { errors: errors.slice(0, 20) },
      { backendId: options.backendId ?? null }
    );
  }
  if (errors.length > 0) {
    result.warnings = normalizeWarnings([
      ...result.warnings,
      ...errors.map((e) => `discarded malformed data: ${e}`)
    ]);
  }
  return result;
}

/**
 * Human-facing digest of a result: what was detected, how confidently, and
 * how much of it is shaky. Feeds the result screen (§32), the job payload
 * and the structured log line (§38) — none of which should walk the note
 * arrays themselves.
 *
 * @param {TranscriptionResultShape} result
 * @param {{lowConfidenceThreshold?: number}} [options]
 * @returns {Object} Summary safe to send over WebSocket.
 */
export function summarizeTranscriptionResult(result, options = {}) {
  const threshold = isFiniteNumber(options.lowConfidenceThreshold)
    ? options.lowConfidenceThreshold
    : 0.5;
  const tracks = Array.isArray(result?.tracks) ? result.tracks : [];

  let noteCount = 0;
  let lowConfidenceNotes = 0;
  let lastOffset = 0;
  const instruments = [];

  for (const track of tracks) {
    let trackConfidenceSum = 0;
    let trackConfidenceCount = 0;
    for (const note of track.notes) {
      noteCount++;
      if (note.end > lastOffset) lastOffset = note.end;
      if (note.confidence !== null) {
        trackConfidenceSum += note.confidence;
        trackConfidenceCount++;
        if (note.confidence < threshold) lowConfidenceNotes++;
      }
    }
    instruments.push({
      trackId: track.id,
      label: track.instrument.label || track.instrument.family || null,
      family: track.instrument.family,
      gmProgram: track.instrument.gmProgram,
      isDrums: track.instrument.isDrums,
      // Prefer the backend's own instrument confidence; fall back to the mean
      // note confidence so the UI can still rank tracks.
      confidence:
        track.instrument.confidence !== null
          ? track.instrument.confidence
          : trackConfidenceCount > 0
            ? trackConfidenceSum / trackConfidenceCount
            : null,
      noteCount: track.notes.length
    });
  }

  return {
    trackCount: tracks.length,
    noteCount,
    lowConfidenceNotes,
    lowConfidenceThreshold: threshold,
    duration: result?.source?.duration ?? (noteCount > 0 ? lastOffset : 0),
    tempoMapPoints: Array.isArray(result?.tempoMap) ? result.tempoMap.length : 0,
    hasDrums: instruments.some((i) => i.isDrums),
    instruments,
    warnings: Array.isArray(result?.warnings) ? result.warnings : []
  };
}

/**
 * Empty, valid result — the starting point for a backend that found nothing,
 * and a convenient fixture for tests.
 *
 * @param {{filename?: string, duration?: number, backendId?: string,
 *   backendVersion?: string}} [meta]
 * @returns {TranscriptionResultShape}
 */
export function emptyTranscriptionResult(meta = {}) {
  return createTranscriptionResult({
    source: { filename: meta.filename ?? null, duration: meta.duration ?? null },
    backend: { id: meta.backendId ?? null, version: meta.backendVersion ?? null },
    tracks: []
  });
}

export default {
  TRANSCRIPTION_RESULT_VERSION,
  RESULT_LIMITS,
  normalizeTranscriptionResult,
  createTranscriptionResult,
  summarizeTranscriptionResult,
  emptyTranscriptionResult
};
