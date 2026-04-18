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

class UploadQueue {
  constructor({ logger, onProgress } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this._chain = Promise.resolve();
    this._pending = 0;
  }

  /** Current queue depth (tasks waiting + running). */
  get pending() {
    return this._pending;
  }

  /**
   * Enqueue an async task. The task receives a `report(stage)` helper.
   * Returns a Promise that resolves / rejects with the task's result.
   *
   * @template T
   * @param {string} uploadId - Opaque id used for progress events.
   * @param {(report: (stage: string) => void) => Promise<T>} task
   * @returns {Promise<T>}
   */
  add(uploadId, task) {
    this._pending++;
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
    });
  }
}

export default UploadQueue;
