/**
 * @file src/files/FileWriteLock.js
 * @description In-process, per-key async mutex for read-modify-write flows on
 * a single MIDI file.
 *
 * Why (audit F-76 / F-77). `apply_assignments` reads a file's bytes, transforms
 * them, and writes them back — with `await` points in between
 * (`replaceFileBytes`, `createDerivedFile`, `bakeAndSave`). Two clients on the
 * same file therefore interleave read and write, and the audit measured the
 * result: `+5` then `+7` produced a file at `+12`, with `success: true` sent to
 * *both* clients (and `+5` / `−5` silently restoring the original).
 *
 * This lock does two jobs:
 *   1. it makes the whole read→transform→write→routings sequence one critical
 *      section, so no second apply can slip between the read and the write;
 *   2. **`acquire()` always yields** (it is `async`), which is what makes the
 *      optimistic version check upstream meaningful: two applies that arrive in
 *      the same batch both snapshot the file *before* either of them writes, so
 *      the loser's snapshot is genuinely stale and the conflict is detected
 *      instead of being applied on top.
 *
 * Same shape as {@link UploadQueue}'s promise chain, but keyed and released
 * explicitly. Scope is one process: it is not a cross-process lock — that job
 * belongs to SQLite (see `busy_timeout`, F-78/F-130).
 */

/** Default ceiling on how long a waiter blocks before giving up. */
const DEFAULT_TIMEOUT_MS = 30000;

/** @type {WeakMap<Object, FileWriteLock>} app facade → lock. */
const lockCache = new WeakMap();

/**
 * Resolve the per-process file write lock for an `app` facade, creating it on
 * first use. Prefers a lock registered in the DI container (`app.fileWriteLock`)
 * so the composition root can own it; otherwise caches one per facade in a
 * WeakMap, exactly like {@link module:midiConverterCache}.
 *
 * @param {Object} app
 * @returns {FileWriteLock}
 */
export function getFileWriteLock(app) {
  if (app?.fileWriteLock instanceof FileWriteLock) return app.fileWriteLock;
  if (!lockCache.has(app)) {
    lockCache.set(app, new FileWriteLock({ logger: app?.logger }));
  }
  return lockCache.get(app);
}

export default class FileWriteLock {
  /**
   * @param {{timeoutMs?:number, logger?:Object}} [options]
   */
  constructor({ timeoutMs, logger } = {}) {
    /** @type {Map<string, Promise<void>>} tail of the wait chain per key */
    this._chains = new Map();
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.logger = logger || null;
  }

  /** Number of keys currently held or queued (diagnostics / tests). */
  get activeKeys() {
    return this._chains.size;
  }

  /**
   * Acquire the lock for `key`, resolving once every earlier holder released.
   *
   * @param {string|number} key - Typically a file id.
   * @returns {Promise<() => void>} `release`, idempotent, must be called in a
   *   `finally`.
   */
  async acquire(key) {
    const k = String(key);
    const previous = this._chains.get(k) || Promise.resolve();

    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    // Chain BEFORE awaiting so a second caller in the same tick queues behind
    // us rather than racing us.
    this._chains.set(
      k,
      previous.then(
        () => held,
        () => held
      )
    );

    await this._waitWithTimeout(previous, k);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      // Drop the map entry once we are the tail: keeps the map from growing
      // one entry per file for the life of the process.
      queueMicrotask(() => {
        const tail = this._chains.get(k);
        if (!tail) return;
        tail.then(
          () => {
            if (this._chains.get(k) === tail) this._chains.delete(k);
          },
          () => {
            if (this._chains.get(k) === tail) this._chains.delete(k);
          }
        );
      });
    };
  }

  /**
   * Run `fn` while holding the lock for `key`.
   *
   * @template T
   * @param {string|number} key
   * @param {() => (T|Promise<T>)} fn
   * @returns {Promise<T>}
   */
  async withLock(key, fn) {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Wait for the previous holder, but never forever: a holder that wedges
   * (a never-settling await inside a handler) must not make every later apply
   * on that file hang until restart. Mirrors UploadQueue's task timeout.
   * @private
   */
  async _waitWithTimeout(previous, key) {
    let timer;
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => {
        this.logger?.warn?.(
          `[FileWriteLock] waited ${this.timeoutMs}ms for file ${key}; proceeding without the lock`
        );
        resolve();
      }, this.timeoutMs);
      if (timer.unref) timer.unref();
    });
    try {
      await Promise.race([previous, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }
}
