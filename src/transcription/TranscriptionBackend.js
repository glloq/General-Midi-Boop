/**
 * @file src/transcription/TranscriptionBackend.js
 * @description Abstract contract every transcription engine implements.
 *
 * The core of GMB must never know which model is installed (§6): it holds
 * backends only through this interface, and a new engine is a new file under
 * `backends/` plus nothing else. Concrete backends live in
 * `src/transcription/backends/` and are auto-discovered by
 * {@link module:src/transcription/TranscriptionBackendRegistry}.
 *
 * ## Lifecycle
 *
 *   getMetadata()        → static descriptor (id, capabilities, licence…)
 *   checkAvailability()  → can it run *right now* on this host?
 *   transcribe()         → audio file → TranscriptionResult
 *   install()/uninstall()→ optional, opt-in, consent-gated (PR 11)
 *
 * ## Contract notes
 *
 * - `transcribe()` receives a path to audio **already normalised** by the
 *   preprocessor to the format the backend declared in
 *   `metadata.audioFormat`. A backend never decodes user bytes itself.
 * - It must honour `context.signal` (an `AbortSignal`) promptly: kill the
 *   subprocess, drop temporary files, reject with a cancellation error.
 * - It must report progress through `context.onProgress` when it declares
 *   `capabilities.progress`; a backend that cannot must leave the flag false
 *   so the UI shows an indeterminate bar rather than a fake one (§31).
 * - It must return the raw result object; validation/normalisation into a
 *   {@link TranscriptionResultShape} is the caller's job, so a backend can
 *   never smuggle an unvalidated structure downstream.
 */
import { TranscriptionError, TRANSCRIPTION_REASONS } from './TranscriptionError.js';
import { BACKEND_STATUS, normalizeBackendMetadata } from './TranscriptionCapabilities.js';

/** Used when no logger is injected (tests, standalone use). */
const NULL_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {}
});

/**
 * @typedef {Object} AvailabilityReport
 * @property {string} status - A {@link BACKEND_STATUS} value.
 * @property {?string} detail - One sentence explaining a non-available
 *   status, shown in Settings.
 * @property {?string} version - Installed engine version, when known.
 * @property {?string} modelVersion - Installed model/weights version.
 * @property {?string} modelChecksum - Checksum of the installed weights, so
 *   an operator can tell which artefact is on disk (§35).
 */

/**
 * @typedef {Object} TranscribeContext
 * @property {AbortSignal} [signal] - Cancellation (§18).
 * @property {(progress: {stage: string, progress: ?number}) => void} [onProgress]
 * @property {string} [workDir] - Per-job scratch directory, already created
 *   and removed for the backend (§21).
 * @property {Object} [logger]
 */

/**
 * Base class for every transcription backend. Subclasses must override
 * {@link TranscriptionBackend#getMetadata},
 * {@link TranscriptionBackend#checkAvailability} and
 * {@link TranscriptionBackend#transcribe}.
 */
export class TranscriptionBackend {
  /**
   * @param {Object} [deps] - Service-container facade. Only `logger` is read
   *   eagerly; anything else must be reached through `this._deps` so a
   *   backend constructed early still sees late-registered services.
   */
  constructor(deps = {}) {
    /** @protected */
    this._deps = deps;
    this.logger = deps.logger || NULL_LOGGER;
  }

  /**
   * Static descriptor of this engine. Must be cheap and side-effect free:
   * the registry calls it at registration time and the Settings UI renders
   * it without touching the filesystem.
   *
   * @returns {Object} See {@link normalizeBackendMetadata} for the shape.
   * @abstract
   */
  getMetadata() {
    throw new Error(`${this.constructor.name} must implement getMetadata()`);
  }

  /** @returns {string} Backend id, from the metadata. */
  get id() {
    return this.getMetadata().id;
  }

  /**
   * Probe the host: is the runtime present, the model installed, the
   * platform supported? Must never throw — an unexpected failure is itself
   * an answer (`broken`) and must not break the Settings page.
   *
   * @returns {Promise<AvailabilityReport>}
   * @abstract
   */
  async checkAvailability() {
    throw new Error(`${this.constructor.name} must implement checkAvailability()`);
  }

  /**
   * Transcribe one normalised audio file.
   *
   * @param {string} _inputPath - Absolute path to the normalised audio.
   * @param {Object} _options - Per-job options (quality profile, feature
   *   toggles). Unknown options must be ignored, not rejected.
   * @param {TranscribeContext} _context
   * @returns {Promise<Object>} Raw result, to be passed through
   *   `createTranscriptionResult()` by the caller.
   * @abstract
   */
  async transcribe(_inputPath, _options, _context) {
    throw new Error(`${this.constructor.name} must implement transcribe()`);
  }

  /**
   * @returns {boolean} True when this backend implements automated
   *   installation. Default false — installing is opt-in per backend (§34).
   */
  supportsInstall() {
    return false;
  }

  /**
   * Install the engine and (when licensing allows) its model.
   *
   * @param {{consentAccepted?: boolean, onProgress?: Function, signal?: AbortSignal}} _context
   * @returns {Promise<AvailabilityReport>}
   */
  async install(_context = {}) {
    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
      `${this.getMetadata().name} does not support automated installation`,
      {},
      { backendId: this.id }
    );
  }

  /**
   * Remove everything this backend installed. Must be idempotent.
   * @param {Object} _context
   * @returns {Promise<void>}
   */
  async uninstall(_context = {}) {
    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
      `${this.getMetadata().name} does not support automated uninstallation`,
      {},
      { backendId: this.id }
    );
  }

  /**
   * Release anything held between transcriptions (warm processes, caches).
   * Called by the registry on shutdown. Default: nothing to do.
   * @returns {void|Promise<void>}
   */
  destroy() {}

  /**
   * Normalised descriptor + last known availability, as rendered by the API
   * and the Settings UI. The registry passes the availability it cached so
   * this stays synchronous and I/O-free.
   *
   * @param {?AvailabilityReport} [availability]
   * @returns {Object}
   */
  describe(availability = null) {
    const metadata = normalizeBackendMetadata(this.getMetadata());
    const status = availability?.status || BACKEND_STATUS.NOT_INSTALLED;
    return {
      ...metadata,
      status,
      available: status === BACKEND_STATUS.AVAILABLE,
      installed: status === BACKEND_STATUS.AVAILABLE || status === BACKEND_STATUS.BROKEN,
      detail: availability?.detail ?? null,
      installedVersion: availability?.version ?? null,
      modelVersion: availability?.modelVersion ?? null,
      modelChecksum: availability?.modelChecksum ?? null,
      checkedAt: availability?.checkedAt ?? null
    };
  }
}

export default TranscriptionBackend;
