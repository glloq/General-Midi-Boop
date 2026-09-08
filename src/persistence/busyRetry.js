/**
 * @file src/persistence/busyRetry.js
 * @description `SQLITE_BUSY` classification + an **async** retry wrapper for
 * contended writes.
 *
 * Why this exists (audit F-78 / F-130). `better-sqlite3` is synchronous: while
 * SQLite waits for a lock, the Node event loop does not run — no WebSocket
 * frames, no HTTP, and above all **no MIDI scheduler tick**. Raising
 * `busy_timeout` therefore does not make the box more robust, it makes the
 * freeze *longer*: the measured 5 015 ms event-loop gap and the 10 095 ms
 * `/api/health` are both that timeout, not a slow query.
 *
 * The remedy is two-part and this file is the second half:
 *   1. a **short** explicit `busy_timeout` (see
 *      {@link module:src/persistence/DatabaseLifecycle.DEFAULT_BUSY_TIMEOUT_MS}) —
 *      caps a single freeze;
 *   2. **retrying across `await`** — the loop below yields between attempts, so
 *      the scheduler runs during the gaps. Total tolerance to an external lock
 *      becomes `attempts × busy_timeout + backoff` while the *longest single
 *      freeze* stays at `busy_timeout`.
 *
 * It does not make the writes asynchronous: each attempt still blocks for up to
 * `busy_timeout`. It converts one long freeze into a few short ones, and turns
 * a masked "Internal server error" into a named {@link DatabaseBusyError}.
 */
import { DatabaseBusyError } from '../core/errors/index.js';

/** Default number of attempts (1 initial + 3 retries). */
const DEFAULT_ATTEMPTS = 4;
/** Base pause between attempts, doubled each time (30, 60, 120 ms…). */
const DEFAULT_BACKOFF_MS = 30;

/**
 * True when `err` is SQLite's "database is locked / busy" family.
 *
 * Matches both the driver's `code` (`SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`,
 * `SQLITE_PROTOCOL`…) and the message, because a wrapper layer sometimes
 * rethrows a plain `Error` with the text preserved.
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isBusyError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code.startsWith('SQLITE_BUSY') || code === 'SQLITE_PROTOCOL') return true;
  return /database is locked|database table is locked/i.test(String(err.message || ''));
}

/**
 * Run a synchronous DB write, retrying `SQLITE_BUSY` across `await` points.
 *
 * @template T
 * @param {() => T} fn - Synchronous write (typically a `db.transaction(...)`
 *   wrapper). Called again from scratch on each retry, so it MUST be safe to
 *   re-run — a SQLite transaction that failed to acquire its lock wrote nothing.
 * @param {{attempts?:number, backoffMs?:number, logger?:Object,
 *   operation?:string}} [options]
 * @returns {Promise<T>}
 * @throws {DatabaseBusyError} When every attempt hit `SQLITE_BUSY`.
 */
export async function runWithBusyRetry(fn, options = {}) {
  const attempts =
    Number.isFinite(options.attempts) && options.attempts > 0
      ? Math.floor(options.attempts)
      : DEFAULT_ATTEMPTS;
  const backoffMs =
    Number.isFinite(options.backoffMs) && options.backoffMs >= 0
      ? options.backoffMs
      : DEFAULT_BACKOFF_MS;
  const operation = options.operation || 'write';

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastError = err;
      options.logger?.warn?.(
        `[busyRetry] ${operation}: database locked (attempt ${attempt}/${attempts})`
      );
      if (attempt === attempts) break;
      // The only place the event loop — and the MIDI scheduler — gets to run.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, backoffMs * 2 ** (attempt - 1));
        if (t.unref) t.unref();
      });
    }
  }
  throw new DatabaseBusyError(
    `Database is locked by another process; ${operation} was not applied after ${attempts} attempts`,
    operation,
    { cause: lastError }
  );
}
