/**
 * @file src/transcription/TranscriptionError.js
 * @description Typed errors for the audio → MIDI transcription domain.
 *
 * Every failure the feature can surface to a user is one of the reasons in
 * {@link TRANSCRIPTION_REASONS} — the UI switches on `reason` to pick a
 * human message, so the list is a contract, not a convenience.
 *
 * The class extends {@link ApplicationError} on purpose: only
 * `ApplicationError` instances are forwarded verbatim by
 * {@link module:src/api/CommandRegistry} (everything else is masked behind
 * "Internal server error"), and the HTTP layer reads `statusCode`.
 */
import { ApplicationError } from '../core/errors/index.js';

/**
 * Machine-readable failure reasons. Values are the names themselves so a
 * log line, a WS payload and this table always read the same.
 * @enum {string}
 */
export const TRANSCRIPTION_REASONS = Object.freeze({
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  AUDIO_TOO_LONG: 'AUDIO_TOO_LONG',
  FFMPEG_MISSING: 'FFMPEG_MISSING',
  BACKEND_NOT_INSTALLED: 'BACKEND_NOT_INSTALLED',
  BACKEND_FAILED: 'BACKEND_FAILED',
  BACKEND_TIMEOUT: 'BACKEND_TIMEOUT',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  DISK_FULL: 'DISK_FULL',
  TRANSCRIPTION_CANCELLED: 'TRANSCRIPTION_CANCELLED',
  MIDI_GENERATION_FAILED: 'MIDI_GENERATION_FAILED',
  MIDI_IMPORT_FAILED: 'MIDI_IMPORT_FAILED'
});

/**
 * Per-reason metadata: the `ERR_*` code carried to the client (GMB
 * convention, see `src/core/errors/index.js`) and the HTTP-style status the
 * REST layer should answer with.
 *
 * `retryable` tells the UI whether offering "try again" makes sense without
 * the user changing anything (a timeout: yes; an unsupported format: no).
 * @type {Object<string, {code: string, statusCode: number, retryable: boolean}>}
 */
const REASON_META = Object.freeze({
  UNSUPPORTED_FORMAT: {
    code: 'ERR_TRANSCRIPTION_UNSUPPORTED_FORMAT',
    statusCode: 415,
    retryable: false
  },
  FILE_TOO_LARGE: { code: 'ERR_TRANSCRIPTION_FILE_TOO_LARGE', statusCode: 413, retryable: false },
  AUDIO_TOO_LONG: { code: 'ERR_TRANSCRIPTION_AUDIO_TOO_LONG', statusCode: 413, retryable: false },
  FFMPEG_MISSING: { code: 'ERR_TRANSCRIPTION_FFMPEG_MISSING', statusCode: 503, retryable: false },
  BACKEND_NOT_INSTALLED: {
    code: 'ERR_TRANSCRIPTION_BACKEND_NOT_INSTALLED',
    statusCode: 409,
    retryable: false
  },
  BACKEND_FAILED: { code: 'ERR_TRANSCRIPTION_BACKEND_FAILED', statusCode: 500, retryable: true },
  BACKEND_TIMEOUT: { code: 'ERR_TRANSCRIPTION_BACKEND_TIMEOUT', statusCode: 504, retryable: true },
  OUT_OF_MEMORY: { code: 'ERR_TRANSCRIPTION_OUT_OF_MEMORY', statusCode: 507, retryable: false },
  DISK_FULL: { code: 'ERR_TRANSCRIPTION_DISK_FULL', statusCode: 507, retryable: false },
  TRANSCRIPTION_CANCELLED: {
    code: 'ERR_TRANSCRIPTION_CANCELLED',
    statusCode: 409,
    retryable: true
  },
  MIDI_GENERATION_FAILED: {
    code: 'ERR_TRANSCRIPTION_MIDI_GENERATION_FAILED',
    statusCode: 500,
    retryable: true
  },
  MIDI_IMPORT_FAILED: {
    code: 'ERR_TRANSCRIPTION_MIDI_IMPORT_FAILED',
    statusCode: 500,
    retryable: true
  }
});

/** Fallback used when a caller passes an unknown reason. */
const FALLBACK_META = Object.freeze({
  code: 'ERR_TRANSCRIPTION',
  statusCode: 500,
  retryable: false
});

/**
 * A failure inside the transcription pipeline.
 *
 * @example
 *   throw new TranscriptionError(
 *     TRANSCRIPTION_REASONS.AUDIO_TOO_LONG,
 *     'Audio is 18m20s; the limit is 10m00s',
 *     { duration: 1100, limit: 600 }
 *   );
 */
export class TranscriptionError extends ApplicationError {
  /**
   * @param {string} reason - One of {@link TRANSCRIPTION_REASONS}.
   * @param {string} message - Human-readable, already user-presentable.
   * @param {Object} [details] - Structured context for the UI/logs.
   * @param {Object} [options]
   * @param {Error} [options.cause] - Underlying error, kept for logs only —
   *   it is deliberately absent from {@link TranscriptionError#toJSON}.
   * @param {?string} [options.backendId] - Backend involved, when relevant.
   */
  constructor(reason, message, details = {}, options = {}) {
    const meta = REASON_META[reason] || FALLBACK_META;
    super(message, meta.code, meta.statusCode);
    this.name = 'TranscriptionError';
    /** @type {string} One of {@link TRANSCRIPTION_REASONS}. */
    this.reason = TRANSCRIPTION_REASONS[reason] || reason;
    /** @type {boolean} Whether retrying unchanged could succeed. */
    this.retryable = meta.retryable;
    /** @type {?string} */
    this.backendId = options.backendId ?? null;
    /** @type {Object} */
    this.details = details && typeof details === 'object' ? details : {};
    if (options.cause) this.cause = options.cause;
  }

  /**
   * @returns {boolean} True when this error is a user-requested cancellation
   *   rather than a failure — the job manager reports those as `cancelled`,
   *   never as `failed`.
   */
  get isCancellation() {
    return this.reason === TRANSCRIPTION_REASONS.TRANSCRIPTION_CANCELLED;
  }

  /**
   * @returns {Object} Base JSON plus `reason`, `retryable`, `backendId` and
   *   `details`. The `cause` is intentionally omitted: it may carry paths or
   *   subprocess output that must not reach the client.
   */
  toJSON() {
    return {
      ...super.toJSON(),
      reason: this.reason,
      retryable: this.retryable,
      backendId: this.backendId,
      details: this.details
    };
  }

  /**
   * Wrap an arbitrary throw into a typed transcription error, preserving the
   * original as `cause`. A {@link TranscriptionError} is returned unchanged
   * so a precise reason raised deep in the pipeline is never flattened.
   *
   * @param {*} error - Anything a `catch` block received.
   * @param {string} [reason=BACKEND_FAILED]
   * @param {Object} [details]
   * @param {{backendId?: string}} [options]
   * @returns {TranscriptionError}
   */
  static from(error, reason = TRANSCRIPTION_REASONS.BACKEND_FAILED, details = {}, options = {}) {
    if (error instanceof TranscriptionError) return error;
    const message = error && error.message ? error.message : String(error);
    return new TranscriptionError(reason, message, details, {
      ...options,
      cause: error instanceof Error ? error : undefined
    });
  }

  /**
   * Canonical cancellation error (job cancelled by the user, §18).
   * @param {?string} [jobId]
   * @returns {TranscriptionError}
   */
  static cancelled(jobId = null) {
    return new TranscriptionError(
      TRANSCRIPTION_REASONS.TRANSCRIPTION_CANCELLED,
      'Transcription cancelled',
      jobId ? { jobId } : {}
    );
  }
}

/**
 * @param {*} error
 * @returns {boolean} True when `error` is a cancellation in any of its forms
 *   (typed error, or an `AbortController` abort surfacing as `AbortError`).
 */
export function isCancellation(error) {
  if (error instanceof TranscriptionError) return error.isCancellation;
  return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

export default TranscriptionError;
