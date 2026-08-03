/**
 * @file src/files/UploadQueue.js
 * @description Thin in-process serial queue for upload post-processing
 * (hash, parse, analyse, DB insert). Concurrency is 1 — better-sqlite3
 * is synchronous and the Pi is single-core-bound for this work, so a
 * FIFO single-worker queue both serialises writes and keeps the event
 * loop responsive for WebSocket traffic.
 *
 * Emits optional progress events via `onProgress({ uploadId, stage })`
 * so the HTTP route can forward them to the client over WebSocket.
 *
 * Stages (convention): received | hashed | parsed | analyzed | stored
 */

// Pi-safe defaults. Each queued upload pins its whole request body in memory
// until the single worker drains the FIFO, so the queue must bound BOTH the
// task count and the total bytes in flight. On a 1 GB Pi the old count-only
// depth of 100 × 10 MB MIDI allowed ~1 GB of pinned buffers → OOM. 8 tasks and
// a 64 MB byte budget keep the worst case well within a 1 GB envelope.
const DEFAULT_MAX_PENDING = 8;
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;

class UploadQueue {
  constructor({ logger, onProgress, maxPending = DEFAULT_MAX_PENDING, maxPendingBytes } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this._chain = Promise.resolve();
    this._pending = 0;
    this._pendingBytes = 0;
    // Bound the queue depth so a burst of concurrent uploads cannot pin
    // unbounded MIDI buffers in memory while the single worker drains the
    // FIFO (audit P2 — unbounded queue). Overflow rejects with a typed
    // error the HTTP route maps to 503 "try again".
    this.maxPending =
      Number.isFinite(maxPending) && maxPending > 0 ? maxPending : DEFAULT_MAX_PENDING;
    this.maxPendingBytes =
      Number.isFinite(maxPendingBytes) && maxPendingBytes > 0
        ? maxPendingBytes
        : DEFAULT_MAX_PENDING_BYTES;
  }

  /** Current queue depth (tasks waiting + running). */
  get pending() {
    return this._pending;
  }

  /** Current bytes pinned by queued/running tasks (when sizes are supplied). */
  get pendingBytes() {
    return this._pendingBytes;
  }

  /**
   * Enqueue an async task. The task receives a `report(stage)` helper.
   * Returns a Promise that resolves / rejects with the task's result.
   *
   * @template T
   * @param {string} uploadId - Opaque id used for progress events.
   * @param {(report: (stage: string) => void) => Promise<T>} task
   * @param {number} [sizeBytes=0] - Payload size to charge against the byte
   *   budget; 0 (default) only counts against the task-count limit.
   * @returns {Promise<T>}
   */
  add(uploadId, task, sizeBytes = 0) {
    const bytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
    // Admit a task only if BOTH the count and the byte budget allow it; a
    // single in-flight task is always admitted so an oversized-but-legal file
    // can never deadlock the queue.
    const wouldExceedBytes = this._pending > 0 && this._pendingBytes + bytes > this.maxPendingBytes;
    if (this._pending >= this.maxPending || wouldExceedBytes) {
      const err = new Error(
        `Upload queue full (${this._pending}/${this.maxPending}, ${this._pendingBytes}/${this.maxPendingBytes} bytes); try again shortly`
      );
      err.code = 'UPLOAD_QUEUE_FULL';
      return Promise.reject(err);
    }
    this._pending++;
    this._pendingBytes += bytes;
    const report = (stage) => {
      if (this.onProgress) {
        try {
          this.onProgress({ uploadId, stage });
        } catch (err) {
          this.logger.warn(`UploadQueue.onProgress threw: ${err.message}`);
        }
      }
    };

    const next = this._chain.then(() => task(report));
    // Swallow errors in the chain so one failure does not poison later tasks.
    this._chain = next.catch(() => {});
    return next.finally(() => {
      this._pending--;
      this._pendingBytes -= bytes;
    });
  }
}

export default UploadQueue;
