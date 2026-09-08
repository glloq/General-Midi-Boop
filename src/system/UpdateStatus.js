/**
 * @file src/system/UpdateStatus.js
 * @description Reader for the two files `scripts/update.sh` writes while an
 * in-place update runs: `logs/update-status` (one short line) and
 * `logs/update.log` (the whole transcript).
 *
 * This is the backing logic of `GET /api/update-status`, the one endpoint
 * that must stay reachable *without authentication* — the dashboard polls it
 * while the server is restarting under it, which is exactly when a token
 * round-trip is not available. "Public" is a design decision; it is not a
 * licence to be unbounded or permanent (audit L10 F-115, L11 F-122):
 *
 *   - **Bounded.** Only the tail of the log is read ({@link TAIL_MAX_BYTES}),
 *     via `openSync`/`readSync` at an offset — never `readFileSync` on the
 *     whole file. `npm install` output on a Pi runs to megabytes and an
 *     anonymous client could otherwise make the box re-read it in a loop.
 *   - **Closed when idle.** The status file is never deleted, so the naive
 *     reader served the last update's transcript forever. Here a status is
 *     only reported while it is *fresh*: an active step within
 *     {@link ACTIVE_WINDOW_MS}, or a terminal one (`done` / `failed`) within
 *     {@link TERMINAL_GRACE_MS} so the SPA still gets to see how it ended.
 *     Outside those windows the endpoint answers `{status:null, logTail:null}`.
 *   - **Log tail only while running.** The transcript carries absolute paths,
 *     the git log, `git status --short`, the LAN IP and possibly application
 *     log lines. It is exposed only during the update window it belongs to;
 *     the authenticated `system_logs` command is the way to read logs at rest.
 */
import { openSync, closeSync, fstatSync, readSync, statSync } from 'fs';

/** Steps written by `update.sh` while an update is actually in flight. */
export const UPDATE_ACTIVE_STATES = Object.freeze([
  'script_started',
  'started',
  'pulling',
  'installing',
  'migrating',
  'restarting',
  'verifying',
  'rolling_back'
]);

/** Steps written once the update is over, one way or the other. */
export const UPDATE_TERMINAL_STATES = Object.freeze(['done', 'failed']);

/**
 * An update that has not written a step for this long is dead (power cut,
 * `kill -9`, host reboot). Generous on purpose: `npm install` on a Pi 3 can
 * sit inside a single step for a long time.
 */
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/**
 * How long a finished update keeps answering. Long enough for the SPA to
 * observe `done`/`failed` and reload, short enough that the endpoint is not
 * a permanent read-out of the last update.
 */
export const TERMINAL_GRACE_MS = 10 * 60 * 1000;

/** Never read more than this many trailing bytes of `update.log`. */
export const TAIL_MAX_BYTES = 64 * 1024;

/** Lines of `update.log` returned to the dashboard. */
export const TAIL_MAX_LINES = 30;

/** The status file holds a single short line; anything bigger is not ours. */
export const STATUS_MAX_BYTES = 4 * 1024;

const ACTIVE = new Set(UPDATE_ACTIVE_STATES);
const TERMINAL = new Set(UPDATE_TERMINAL_STATES);

/**
 * Reduce a raw status line to its step token.
 *
 * `update.sh` writes either a bare step (`"pulling"`), a step with trailing
 * detail (`"2026-09-08 10:00:00 script_started pid=42 …"`) or a failure with
 * its reason (`"failed: npm install failed (rolled back to 1a2b3c4)"`).
 *
 * @param {?string} raw - Raw content of `logs/update-status`.
 * @returns {?string} Step token, or `null` when there is nothing usable.
 */
export function parseUpdateStep(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const token of trimmed.split(/\s+/)) {
    const step = token.replace(/:$/, '');
    if (ACTIVE.has(step) || TERMINAL.has(step)) return step;
  }
  // Unknown vocabulary: keep the first token so callers can still log it.
  return trimmed.split(/\s+/)[0].replace(/:$/, '');
}

/** @param {?string} step @returns {boolean} */
export function isActiveStep(step) {
  return step !== null && ACTIVE.has(step);
}

/** @param {?string} step @returns {boolean} */
export function isTerminalStep(step) {
  return step !== null && TERMINAL.has(step);
}

/**
 * Read at most {@link TAIL_MAX_BYTES} from the end of a file and keep its
 * last {@link TAIL_MAX_LINES} lines. Memory stays bounded whatever the file
 * size (same technique as `system_logs`, audit A2 M3).
 *
 * @param {string} file - Absolute path.
 * @returns {?string} Tail of the file, or `null` when unreadable.
 */
export function readBoundedTail(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const readBytes = Math.min(size, TAIL_MAX_BYTES);
    if (readBytes <= 0) return '';
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, size - readBytes);
    const lines = buf.toString('utf8').split('\n');
    // A partial first line is an artefact of slicing mid-file, drop it.
    if (size > readBytes && lines.length > 1) lines.shift();
    return lines.slice(-TAIL_MAX_LINES).join('\n');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Build the `/api/update-status` payload.
 *
 * @param {Object} opts
 * @param {string} opts.statusFile - Path to `logs/update-status`.
 * @param {string} opts.logFile - Path to `logs/update.log`.
 * @param {number} [opts.now] - Clock injection point for tests.
 * @returns {{status: ?string, logTail: ?string}} `status` is the raw status
 *   line (the SPA parses the step and the failure reason out of it) while the
 *   update window is open, `null` otherwise. `logTail` is populated only while
 *   an update is actually running.
 */
export function readUpdateStatus({ statusFile, logFile, now = Date.now() }) {
  const closed = { status: null, logTail: null };

  let raw = null;
  let mtimeMs = 0;
  try {
    const st = statSync(statusFile);
    if (!st.isFile() || st.size > STATUS_MAX_BYTES) return closed;
    mtimeMs = st.mtimeMs;
    const tail = readBoundedTail(statusFile);
    raw = tail === null ? null : tail.trim();
  } catch {
    return closed; // no update has ever run, or the file is unreadable
  }
  if (!raw) return closed;

  const step = parseUpdateStep(raw);
  const age = now - mtimeMs;

  if (isActiveStep(step)) {
    // A step that stopped advancing long ago is a dead update, not a running
    // one: report nothing rather than a status that will never change.
    if (age > ACTIVE_WINDOW_MS) return closed;
    return { status: raw, logTail: readBoundedTail(logFile) };
  }

  if (isTerminalStep(step)) {
    if (age > TERMINAL_GRACE_MS) return closed;
    // Finished: the outcome is public, the transcript is not.
    return { status: raw, logTail: null };
  }

  return closed;
}
