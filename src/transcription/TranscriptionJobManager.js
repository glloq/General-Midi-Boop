/**
 * @file src/transcription/TranscriptionJobManager.js
 * @description Queue, lifecycle, progress and cancellation for transcription
 * jobs (§17/§18/§25).
 *
 * A transcription takes seconds to minutes. Running it inside a WebSocket
 * command would hold the connection, and running several at once on a Pi
 * would swap the box to death — so a command *creates* a job and returns
 * immediately, and everything after that is an event.
 *
 * What this class owns:
 *   - a FIFO queue with a concurrency of `maxParallelJobs` (1 on a Pi);
 *   - one `AbortController` per job, so cancelling really reaches FFmpeg and
 *     the model runner (§18);
 *   - a wall-clock timeout per job;
 *   - throttled progress events — the UI needs a moving bar, not 400
 *     WebSocket frames a second (§25);
 *   - bounded retention, so a week of uptime does not accumulate results in
 *     memory.
 *
 * What it does NOT own: the work itself. The caller passes a `run(context)`
 * function, which keeps the queue testable without FFmpeg, a model, or a
 * database.
 */
import { randomUUID } from 'crypto';
import { TranscriptionError, TRANSCRIPTION_REASONS, isCancellation } from './TranscriptionError.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * Job lifecycle (§17). `queued` → one of the working stages → a terminal
 * state. The working stages double as the UI's progress labels (§31).
 * @enum {string}
 */
export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  PREPROCESSING: 'preprocessing',
  TRANSCRIBING: 'transcribing',
  POSTPROCESSING: 'postprocessing',
  GENERATING_MIDI: 'generating_midi',
  IMPORTING: 'importing',
  COMPLETE: 'complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

/** @type {ReadonlySet<string>} States from which a job never moves again. */
export const TERMINAL_STATUSES = Object.freeze(
  new Set([JOB_STATUS.COMPLETE, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED])
);

/** Ordered working stages, used to sanity-check progress reporting. */
export const WORKING_STAGES = Object.freeze([
  JOB_STATUS.PREPROCESSING,
  JOB_STATUS.TRANSCRIBING,
  JOB_STATUS.POSTPROCESSING,
  JOB_STATUS.GENERATING_MIDI,
  JOB_STATUS.IMPORTING
]);

/** Defaults for the bits that are not operator-configurable. */
export const JOB_MANAGER_DEFAULTS = Object.freeze({
  /** Minimum interval between two progress broadcasts for one job. */
  progressThrottleMs: 250,
  /** How long a finished job stays listable. */
  retentionMs: 30 * 60 * 1000,
  /** Hard cap on jobs held in memory (running + finished). */
  maxJobs: 50,
  /** Finished jobs whose full result is kept for `transcription_result`. */
  maxRetainedResults: 5,
  /** Refuse new work past this queue depth. */
  maxQueued: 20
});

/**
 * @typedef {Object} JobRecord
 * @property {string} id
 * @property {string} status - A {@link JOB_STATUS} value.
 * @property {?string} stage - Current working stage; null once terminal.
 * @property {?number} progress - 0..1, or null when indeterminate (§31).
 * @property {number} createdAt
 * @property {?number} startedAt
 * @property {?number} finishedAt
 * @property {?string} backendId
 * @property {string} sourceName
 * @property {?Object} error - `{reason, message, retryable}`.
 * @property {string[]} warnings
 * @property {?Object} summary - Small digest for the UI.
 */

/** Runs transcription jobs one (or a few) at a time. */
export class TranscriptionJobManager {
  /**
   * @param {Object} [deps] - Service-container facade: `logger`, `eventBus`,
   *   and `settings` (resolved transcription config) are read.
   * @param {Object} [deps.settings]
   */
  constructor(deps = {}) {
    this._deps = deps;
    this.logger = deps.logger || NULL_LOGGER;
    this.eventBus = deps.eventBus || null;

    const settings = deps.settings || {};
    this.maxParallelJobs = positive(settings.maxParallelJobs, 1);
    this.jobTimeoutMs = positive(settings.jobTimeoutMs, 15 * 60 * 1000);
    this.progressThrottleMs = positive(
      settings.progressThrottleMs,
      JOB_MANAGER_DEFAULTS.progressThrottleMs
    );
    this.retentionMs = positive(settings.retentionMs, JOB_MANAGER_DEFAULTS.retentionMs);
    this.maxJobs = positive(settings.maxJobs, JOB_MANAGER_DEFAULTS.maxJobs);
    this.maxQueued = positive(settings.maxQueued, JOB_MANAGER_DEFAULTS.maxQueued);
    this.maxRetainedResults = positive(
      settings.maxRetainedResults,
      JOB_MANAGER_DEFAULTS.maxRetainedResults
    );

    /** @type {Map<string, Object>} Internal job state, by id. */
    this._jobs = new Map();
    /**
     * Monotonic creation counter. Ordering by `createdAt` alone is ambiguous
     * — two jobs created in the same millisecond (which is the normal case
     * when a user drops several files at once) would then sort arbitrarily,
     * and "keep the most recent results" would drop the wrong ones.
     */
    this._sequence = 0;
    /** @type {string[]} Ids waiting to start, oldest first. */
    this._queue = [];
    /** @type {Set<string>} Ids currently running. */
    this._running = new Set();
    this._destroyed = false;
  }

  /** @returns {number} Jobs waiting to start. */
  get queuedCount() {
    return this._queue.length;
  }

  /** @returns {number} Jobs currently running. */
  get runningCount() {
    return this._running.size;
  }

  /**
   * Enqueue a job. Returns as soon as it is queued — the work happens later,
   * and the caller follows it through events.
   *
   * @param {Object} options
   * @param {string} options.sourceName - Original file name, for the UI.
   * @param {?string} [options.backendId]
   * @param {Object} [options.options] - Opaque per-job options, echoed back.
   * @param {(context: JobContext) => Promise<Object>} options.run - The work.
   * @returns {JobRecord} The public view of the freshly created job.
   * @throws {TranscriptionError} When the queue is full.
   */
  create({ sourceName, backendId = null, options = {}, run }) {
    if (this._destroyed) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        'The transcription service is shutting down'
      );
    }
    if (typeof run !== 'function') {
      throw new TypeError('TranscriptionJobManager.create requires a run() function');
    }
    if (this._queue.length >= this.maxQueued) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        `Too many transcriptions are already waiting (${this._queue.length}); try again once some finish`,
        { queued: this._queue.length, limit: this.maxQueued }
      );
    }

    const job = {
      id: `job-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      status: JOB_STATUS.QUEUED,
      stage: null,
      progress: null,
      createdAt: Date.now(),
      sequence: ++this._sequence,
      startedAt: null,
      finishedAt: null,
      backendId,
      sourceName: String(sourceName || 'audio'),
      error: null,
      warnings: [],
      summary: null,
      options,
      // Internals, never exposed through the API.
      _run: run,
      _controller: new AbortController(),
      _timer: null,
      _lastProgressAt: 0,
      _result: null,
      _fileId: null
    };

    this._jobs.set(job.id, job);
    this._queue.push(job.id);
    this._prune();

    this.logger.info(
      `Transcription job created: ${job.id} (${job.sourceName}${backendId ? `, backend=${backendId}` : ''})`
    );
    this._emit('transcription_created', {
      jobId: job.id,
      sourceName: job.sourceName,
      backendId,
      status: job.status,
      queuePosition: this._queue.indexOf(job.id)
    });

    // Start on the next tick so `create()` returns the queued job before any
    // synchronous stage transition could fire an event for it.
    setImmediate(() => this._drain());
    return toPublicJob(job);
  }

  /**
   * @param {string} jobId
   * @returns {?JobRecord}
   */
  get(jobId) {
    const job = this._jobs.get(jobId);
    return job ? toPublicJob(job) : null;
  }

  /**
   * @param {string} jobId
   * @returns {?Object} The full transcription result, while retained.
   */
  getResult(jobId) {
    const job = this._jobs.get(jobId);
    return job?._result ?? null;
  }

  /**
   * @returns {JobRecord[]} Newest first.
   */
  list() {
    return [...this._jobs.values()].sort((a, b) => b.sequence - a.sequence).map(toPublicJob);
  }

  /**
   * Cancel a job. A queued job is cancelled immediately; a running one is
   * asked to stop through its AbortSignal and settles as `cancelled` when
   * its work unwinds.
   *
   * @param {string} jobId
   * @returns {boolean} False when the job is unknown or already finished.
   */
  cancel(jobId) {
    const job = this._jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return false;

    this.logger.info(`Transcription job cancelled: ${jobId} (was ${job.status})`);
    const queueIndex = this._queue.indexOf(jobId);
    if (queueIndex !== -1) this._queue.splice(queueIndex, 1);

    job._controller.abort();

    // A queued job has no work in flight to unwind, so settle it here.
    if (!this._running.has(jobId)) this._settleCancelled(job);
    return true;
  }

  /**
   * Forget a finished job (and its result).
   * @param {string} jobId
   * @returns {boolean}
   */
  delete(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return false;
    if (!TERMINAL_STATUSES.has(job.status)) return false;
    this._jobs.delete(jobId);
    return true;
  }

  /**
   * Cancel everything and stop accepting work. Called from
   * `Application.stop()`; leaving a job running would leave an FFmpeg or a
   * Python process behind.
   * @returns {void}
   */
  destroy() {
    this._destroyed = true;
    for (const job of this._jobs.values()) {
      if (!TERMINAL_STATUSES.has(job.status)) {
        job._controller.abort();
        if (job._timer) clearTimeout(job._timer);
      }
    }
    this._queue = [];
  }

  /**
   * Start queued jobs up to the concurrency limit.
   * @returns {void}
   * @private
   */
  _drain() {
    while (
      !this._destroyed &&
      this._running.size < this.maxParallelJobs &&
      this._queue.length > 0
    ) {
      const jobId = this._queue.shift();
      const job = this._jobs.get(jobId);
      if (!job || TERMINAL_STATUSES.has(job.status)) continue;
      this._start(job);
    }
  }

  /**
   * @param {Object} job
   * @returns {void}
   * @private
   */
  _start(job) {
    this._running.add(job.id);
    job.startedAt = Date.now();
    this._setStage(job, JOB_STATUS.PREPROCESSING);

    if (this.jobTimeoutMs > 0) {
      job._timer = setTimeout(() => {
        this.logger.warn(`Transcription job ${job.id} exceeded ${this.jobTimeoutMs}ms — aborting`);
        job._timedOut = true;
        job._controller.abort();
      }, this.jobTimeoutMs);
      if (job._timer.unref) job._timer.unref();
    }

    /**
     * @typedef {Object} JobContext
     * @property {string} jobId
     * @property {AbortSignal} signal
     * @property {(stage: string, progress?: ?number) => void} setStage
     * @property {(progress: ?number) => void} setProgress
     * @property {(warning: string) => void} addWarning
     */
    const context = {
      jobId: job.id,
      signal: job._controller.signal,
      setStage: (stage, progress = null) => this._setStage(job, stage, progress),
      setProgress: (progress) => this._setProgress(job, progress),
      addWarning: (warning) => {
        if (typeof warning === 'string' && warning) job.warnings.push(warning);
      }
    };

    Promise.resolve()
      .then(() => job._run(context))
      .then((outcome) => this._settleComplete(job, outcome))
      .catch((error) => this._settleFailed(job, error))
      .finally(() => {
        this._running.delete(job.id);
        if (job._timer) clearTimeout(job._timer);
        job._timer = null;
        this._drain();
      });
  }

  /**
   * @param {Object} job
   * @param {string} stage
   * @param {?number} progress
   * @returns {void}
   * @private
   */
  _setStage(job, stage, progress = null) {
    if (TERMINAL_STATUSES.has(job.status)) return;
    if (!WORKING_STAGES.includes(stage)) {
      this.logger.warn(`Transcription job ${job.id}: ignoring unknown stage "${stage}"`);
      return;
    }
    job.status = stage;
    job.stage = stage;
    job.progress = normalizeProgress(progress);
    this.logger.debug?.(`Transcription job ${job.id}: ${stage}`);
    // A stage change is always worth an event, whatever the throttle says:
    // it is what moves the UI from "Transcribing" to "Generating MIDI".
    this._emitProgress(job, { force: true });
  }

  /**
   * @param {Object} job
   * @param {?number} progress
   * @returns {void}
   * @private
   */
  _setProgress(job, progress) {
    if (TERMINAL_STATUSES.has(job.status)) return;
    job.progress = normalizeProgress(progress);
    this._emitProgress(job);
  }

  /**
   * @param {Object} job
   * @param {{force?: boolean}} [options]
   * @returns {void}
   * @private
   */
  _emitProgress(job, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - job._lastProgressAt < this.progressThrottleMs) return;
    job._lastProgressAt = now;
    // Minimal payload (§25): the UI has the rest from `transcription_status`.
    this._emit('transcription_progress', {
      jobId: job.id,
      stage: job.stage,
      progress: job.progress
    });
  }

  /**
   * @param {Object} job
   * @param {Object} outcome - `{result?, summary?, fileId?, warnings?}`.
   * @returns {void}
   * @private
   */
  _settleComplete(job, outcome = {}) {
    // A job aborted at the very end still counts as cancelled: the user asked
    // for it to stop, and reporting "complete" would be a lie even if the
    // work happened to finish.
    if (job._controller.signal.aborted) return this._settleCancelled(job);

    job.status = JOB_STATUS.COMPLETE;
    job.stage = null;
    job.progress = 1;
    job.finishedAt = Date.now();
    job.summary = outcome.summary ?? null;
    job._result = outcome.result ?? null;
    job._fileId = outcome.fileId ?? null;
    if (Array.isArray(outcome.warnings)) job.warnings.push(...outcome.warnings);
    this._forgetOldResults();

    this.logger.info(
      `Transcription job complete: ${job.id} in ${job.finishedAt - job.startedAt}ms` +
        (job._fileId ? ` (fileId=${job._fileId})` : '')
    );
    this._emit('transcription_complete', {
      jobId: job.id,
      fileId: job._fileId,
      summary: job.summary,
      warnings: job.warnings
    });
  }

  /**
   * @param {Object} job
   * @param {*} error
   * @returns {void}
   * @private
   */
  _settleFailed(job, error) {
    if (isCancellation(error) || job._controller.signal.aborted) {
      if (job._timedOut) return this._settleTimedOut(job, error);
      return this._settleCancelled(job);
    }

    const typed = TranscriptionError.from(
      error,
      TRANSCRIPTION_REASONS.BACKEND_FAILED,
      {},
      {
        backendId: job.backendId
      }
    );
    job.status = JOB_STATUS.FAILED;
    job.stage = null;
    job.finishedAt = Date.now();
    job.error = {
      reason: typed.reason,
      message: typed.message,
      retryable: typed.retryable,
      details: typed.details
    };

    this.logger.error(`Transcription job failed: ${job.id} — ${typed.reason}: ${typed.message}`);
    this._emit('transcription_failed', {
      jobId: job.id,
      reason: typed.reason,
      message: typed.message,
      retryable: typed.retryable
    });
  }

  /**
   * A timeout is a failure, not a cancellation: nobody asked for it, and the
   * user needs a different message ("it took too long") from "you stopped it".
   * @param {Object} job
   * @param {*} error
   * @returns {void}
   * @private
   */
  _settleTimedOut(job, error) {
    job.status = JOB_STATUS.FAILED;
    job.stage = null;
    job.finishedAt = Date.now();
    job.error = {
      reason: TRANSCRIPTION_REASONS.BACKEND_TIMEOUT,
      message: `Transcription took longer than ${Math.round(this.jobTimeoutMs / 1000)}s and was stopped`,
      retryable: true,
      details: { timeoutMs: this.jobTimeoutMs, cause: error?.message ?? null }
    };
    this.logger.error(`Transcription job timed out: ${job.id}`);
    this._emit('transcription_failed', {
      jobId: job.id,
      reason: job.error.reason,
      message: job.error.message,
      retryable: true
    });
  }

  /**
   * @param {Object} job
   * @returns {void}
   * @private
   */
  _settleCancelled(job) {
    if (TERMINAL_STATUSES.has(job.status)) return;
    job.status = JOB_STATUS.CANCELLED;
    job.stage = null;
    job.finishedAt = Date.now();
    this._emit('transcription_cancelled', { jobId: job.id });
  }

  /**
   * Drop old finished jobs so a long-running server does not accumulate
   * them, and never exceed `maxJobs` whatever the retention window says.
   * @returns {void}
   * @private
   */
  _prune() {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this._jobs) {
      if (TERMINAL_STATUSES.has(job.status) && job.finishedAt && job.finishedAt < cutoff) {
        this._jobs.delete(id);
      }
    }
    if (this._jobs.size <= this.maxJobs) return;

    const finished = [...this._jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => a.sequence - b.sequence);
    while (this._jobs.size > this.maxJobs && finished.length > 0) {
      this._jobs.delete(finished.shift().id);
    }
  }

  /**
   * Keep the full result of only the most recent completed jobs — a result
   * holds every note of a piece, and holding fifty of them is how a Pi runs
   * out of heap.
   * @returns {void}
   * @private
   */
  _forgetOldResults() {
    const withResults = [...this._jobs.values()]
      .filter((job) => job._result)
      .sort((a, b) => b.sequence - a.sequence);
    for (const job of withResults.slice(this.maxRetainedResults)) {
      job._result = null;
    }
  }

  /**
   * @param {string} event
   * @param {Object} payload
   * @returns {void}
   * @private
   */
  _emit(event, payload) {
    this.eventBus?.emit?.(event, payload);
  }
}

/**
 * Strip the internals before a job crosses the API boundary — an
 * AbortController, a timer handle and a full note list have no business in a
 * WebSocket payload.
 *
 * @param {Object} job
 * @returns {JobRecord}
 */
export function toPublicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    backendId: job.backendId,
    sourceName: job.sourceName,
    error: job.error,
    warnings: [...job.warnings],
    summary: job.summary,
    fileId: job._fileId ?? null,
    hasResult: !!job._result
  };
}

/**
 * @param {*} value
 * @returns {?number} 0..1, or null for "indeterminate" (§31 — never fake it).
 */
function normalizeProgress(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export default TranscriptionJobManager;
