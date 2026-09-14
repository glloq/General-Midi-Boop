/**
 * @file src/transcription/BackendInstaller.js
 * @description Installs and removes transcription engines (§34).
 *
 * The engine-specific work (create a venv, run pip, verify) belongs to the
 * backend. What lives here is everything that must be true for EVERY engine,
 * whoever wrote it:
 *
 *  - **consent before download.** A backend whose licensing says
 *    `requiresConsent` cannot be installed without an explicit acceptance
 *    carrying the licence the user was shown — a stale UI that shows an old
 *    licence cannot consent on the user's behalf (§8/§9).
 *  - **one at a time.** These installs are hundreds of megabytes and pin the
 *    CPU; two at once on a Pi is how a box falls over.
 *  - **room to land.** Disk is checked against the engine's own estimate
 *    before anything is downloaded, because running out halfway leaves the
 *    worst kind of mess.
 *  - **rollback.** A failed install removes what it created, so the next
 *    attempt starts clean rather than on top of a half-built environment.
 *  - **the truth afterwards.** The registry is force-re-probed, so "Ready"
 *    means the engine really imports — never "the installer exited 0".
 */
import fs from 'fs/promises';
import { TranscriptionError, TRANSCRIPTION_REASONS, isCancellation } from './TranscriptionError.js';
import { BACKEND_STATUS } from './TranscriptionCapabilities.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** Stages an install reports, in order. */
export const INSTALL_STAGES = Object.freeze([
  'checking',
  'creating_environment',
  'downloading',
  'verifying'
]);

/** Free space required on top of the engine's own estimate. */
export const DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

/** Installs engines, one at a time. */
export class BackendInstaller {
  /**
   * @param {Object} [deps] - Service-container facade: `logger`, `eventBus`
   *   and `transcriptionBackendRegistry` are read (the registry lazily, since
   *   it may register after this service).
   */
  constructor(deps = {}) {
    this._deps = deps;
    this.logger = deps.logger || NULL_LOGGER;
    this.eventBus = deps.eventBus || null;
    /** @type {?{backendId: string, stage: string, startedAt: number}} */
    this._current = null;
    /** @type {?AbortController} */
    this._controller = null;
  }

  /** @returns {?Object} Late-bound. */
  get registry() {
    return this._deps.transcriptionBackendRegistry ?? null;
  }

  /** @returns {?Object} Late-bound: it registers after this service. */
  get wsServer() {
    return this._deps.wsServer ?? null;
  }

  /**
   * Announce an install event to the server AND to the browser. The EventBus
   * alone never reaches the UI — GMB has no generic bridge — so a Settings
   * install would otherwise show no progress and never say it finished.
   *
   * @param {string} event
   * @param {Object} payload
   * @returns {void}
   * @private
   */
  _announce(event, payload) {
    this.eventBus?.emit?.(event, payload);
    this.wsServer?.broadcast?.(event, payload);
  }

  /** @returns {boolean} True while an install or removal is running. */
  get busy() {
    return this._current !== null;
  }

  /**
   * @returns {?Object} The running operation, for the UI.
   */
  getCurrent() {
    return this._current ? { ...this._current } : null;
  }

  /**
   * Install an engine.
   *
   * @param {string} backendId
   * @param {Object} [options]
   * @param {boolean} [options.acceptLicense=false] - The user accepted the
   *   licence they were shown.
   * @param {?string} [options.acceptedModelLicense] - WHICH licence they were
   *   shown. When given it must match the backend's current one.
   * @returns {Promise<Object>} The refreshed backend descriptor.
   * @throws {TranscriptionError}
   */
  async install(backendId, { acceptLicense = false, acceptedModelLicense = null } = {}) {
    const backend = this._requireBackend(backendId);
    const metadata = backend.getMetadata();
    const licensing = metadata.licensing || {};

    if (!backend.supportsInstall?.()) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        `${metadata.name} cannot be installed automatically — see docs/AUDIO_TRANSCRIPTION.md`,
        { backendId },
        { backendId }
      );
    }

    // Consent, before anything is fetched (§8).
    if (licensing.requiresConsent && !acceptLicense) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        `${metadata.name} requires accepting its licence before installation`,
        {
          backendId,
          requiresConsent: true,
          licensing: {
            codeLicense: licensing.codeLicense,
            modelLicense: licensing.modelLicense,
            commercialUse: licensing.commercialUse,
            licenseUrl: licensing.licenseUrl,
            notice: licensing.notice
          }
        },
        { backendId }
      );
    }
    // A consent that names a licence must name the CURRENT one: otherwise a
    // page left open since before an engine changed its terms would consent
    // to terms nobody read.
    if (acceptedModelLicense && acceptedModelLicense !== (licensing.modelLicense ?? null)) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        'The licence shown has changed — review it again before installing',
        {
          backendId,
          accepted: acceptedModelLicense,
          current: licensing.modelLicense ?? null
        },
        { backendId }
      );
    }

    if (this.busy) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        `Another engine is already being installed (${this._current.backendId})`,
        { running: this._current.backendId }
      );
    }

    this._controller = new AbortController();
    this._current = { backendId, stage: 'checking', startedAt: Date.now(), operation: 'install' };
    this._emitProgress('checking', null);
    this.logger.info(`Installing transcription backend "${backendId}"…`);

    try {
      await this._assertDiskSpace(backend, metadata);

      const report = await backend.install({
        signal: this._controller.signal,
        acceptedLicense: true,
        onProgress: ({ stage, progress }) => {
          if (this._current) this._current.stage = stage || this._current.stage;
          this._emitProgress(stage, progress);
        }
      });

      // Trust nothing: ask the registry to re-probe for real.
      this._emitProgress('verifying', null);
      const [descriptor] = (await this.registry.refresh(backendId)) || [];

      if (!descriptor || descriptor.status !== BACKEND_STATUS.AVAILABLE) {
        throw new TranscriptionError(
          TRANSCRIPTION_REASONS.BACKEND_FAILED,
          descriptor?.detail ||
            `${metadata.name} installed but does not start — the environment was removed`,
          { backendId, report },
          { backendId }
        );
      }

      this.logger.info(
        `Transcription backend "${backendId}" installed (${descriptor.installedVersion ?? 'version unknown'})`
      );
      this._emitFinished('installed', backendId, null);
      return descriptor;
    } catch (error) {
      const typed = TranscriptionError.from(
        error,
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        {},
        {
          backendId
        }
      );
      // Roll back whatever was created, so a retry starts clean.
      await this._rollback(backend, backendId);
      this._emitFinished(isCancellation(typed) ? 'cancelled' : 'failed', backendId, typed.message);
      this.logger.error(`Transcription backend "${backendId}" install failed: ${typed.message}`);
      throw typed;
    } finally {
      this._current = null;
      this._controller = null;
    }
  }

  /**
   * Remove an engine. Idempotent: removing something absent succeeds.
   *
   * @param {string} backendId
   * @returns {Promise<Object>} The refreshed descriptor.
   */
  async uninstall(backendId) {
    const backend = this._requireBackend(backendId);
    if (this.busy) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        `Another engine operation is already running (${this._current.backendId})`
      );
    }

    this._current = { backendId, stage: 'removing', startedAt: Date.now(), operation: 'uninstall' };
    try {
      await backend.uninstall({});
      const [descriptor] = (await this.registry.refresh(backendId)) || [];
      this.logger.info(`Transcription backend "${backendId}" removed`);
      this._emitFinished('removed', backendId, null);
      return descriptor || null;
    } catch (error) {
      const typed = TranscriptionError.from(
        error,
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        {},
        {
          backendId
        }
      );
      this._emitFinished('failed', backendId, typed.message);
      throw typed;
    } finally {
      this._current = null;
    }
  }

  /**
   * Ask the running install to stop. The backend sees it through its signal.
   * @returns {boolean} False when nothing is running.
   */
  cancel() {
    if (!this._controller) return false;
    this._controller.abort();
    return true;
  }

  /**
   * @param {string} backendId
   * @returns {Object}
   * @throws {TranscriptionError} When the engine is unknown.
   * @private
   */
  _requireBackend(backendId) {
    const backend = this.registry?.get(backendId);
    if (!backend) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        `Unknown transcription engine: ${backendId}`,
        { backendId }
      );
    }
    return backend;
  }

  /**
   * Refuse to start when the disk cannot hold the result. Running out
   * halfway leaves a half-built environment and an SD card with no room to
   * clean it up.
   *
   * @param {Object} backend
   * @param {Object} metadata
   * @returns {Promise<void>}
   * @private
   */
  async _assertDiskSpace(backend, metadata) {
    const required = Number(backend.estimatedInstallBytes ?? metadata.installBytes ?? 0);
    if (!(required > 0)) return;

    const target = backend.installRoot || backend.venvDir;
    if (!target) return;

    let free;
    try {
      // Check the nearest EXISTING ancestor: the target itself usually does
      // not exist yet, which is the whole point of installing.
      const stats = await statfsNearest(target);
      free = stats.bsize * stats.bavail;
    } catch (error) {
      // No statfs (an exotic platform, a container): proceed rather than
      // refuse an install we cannot prove is impossible.
      this.logger.debug?.(`Disk-space check skipped: ${error.message}`);
      return;
    }

    if (free < required + DISK_HEADROOM_BYTES) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.DISK_FULL,
        `Not enough free space: ${formatMb(free)} available, ${formatMb(required + DISK_HEADROOM_BYTES)} needed`,
        { freeBytes: free, requiredBytes: required + DISK_HEADROOM_BYTES }
      );
    }
  }

  /**
   * @param {Object} backend
   * @param {string} backendId
   * @returns {Promise<void>}
   * @private
   */
  async _rollback(backend, backendId) {
    try {
      await backend.uninstall({ rollback: true });
      this.logger.info(`Rolled back the partial install of "${backendId}"`);
    } catch (error) {
      // Rollback is best-effort; the operator is told in the error that
      // follows, and the engine will report `broken` until it is cleaned.
      this.logger.warn(`Could not roll back "${backendId}": ${error.message}`);
    }
    try {
      await this.registry?.refresh(backendId);
    } catch {
      /* the status will be refreshed on the next probe */
    }
  }

  /**
   * @param {string} stage
   * @param {?number} progress
   * @returns {void}
   * @private
   */
  _emitProgress(stage, progress) {
    this._announce('transcription_install_progress', {
      backendId: this._current?.backendId ?? null,
      stage: stage ?? null,
      progress: Number.isFinite(progress) ? progress : null
    });
  }

  /**
   * @param {string} outcome - `installed` | `removed` | `failed` | `cancelled`.
   * @param {string} backendId
   * @param {?string} message
   * @returns {void}
   * @private
   */
  _emitFinished(outcome, backendId, message) {
    this._announce('transcription_install_complete', { backendId, outcome, message });
  }
}

/**
 * `statfs` on the nearest existing ancestor of `target`.
 *
 * @param {string} target
 * @returns {Promise<{bsize: number, bavail: number}>}
 */
export async function statfsNearest(target) {
  const { dirname } = await import('path');
  let candidate = target;
  for (let depth = 0; depth < 16; depth++) {
    try {
      return await fs.statfs(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
  throw new Error(`no existing ancestor for ${target}`);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export default BackendInstaller;
