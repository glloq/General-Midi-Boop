/**
 * @file src/transcription/utils/ProcessRunner.js
 * @description Hardened wrapper around `child_process.spawn` for everything
 * the transcription pipeline shells out to (FFmpeg, ffprobe, Python runners).
 *
 * It exists because the failure modes of a long-running external process are
 * the ones that hurt an appliance: a wedged FFmpeg pinning a core forever, a
 * Python interpreter that ignores SIGTERM, a subprocess that keeps running
 * after its job was cancelled, or gigabytes of stderr buffered into a 1 GB
 * Pi. Every one of those is handled here, once.
 *
 * Guarantees:
 *   - **never `shell: true`** — arguments are passed as an array, so a
 *     filename can never become shell syntax (§20/§40);
 *   - **filtered environment** — the child gets an explicit allow-list, not
 *     the server's whole `process.env` (which holds `GMBOOP_API_TOKEN`);
 *   - **bounded capture** — stdout/stderr are truncated past a byte budget
 *     and over-long lines are dropped rather than buffered;
 *   - **no survivors** — the child is spawned in its own process group and
 *     the group is signalled, so a Python process that forked workers does
 *     not outlive the job (§18);
 *   - **SIGTERM then SIGKILL** — a grace period, then the hammer.
 */
import { spawn as nodeSpawn } from 'child_process';
import { TranscriptionError, TRANSCRIPTION_REASONS } from '../TranscriptionError.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** Defaults chosen to be generous for FFmpeg yet bounded on a Pi. */
export const PROCESS_DEFAULTS = Object.freeze({
  /** Wall-clock cap for one process. */
  timeoutMs: 10 * 60 * 1000,
  /** Delay between SIGTERM and SIGKILL. */
  killGraceMs: 3000,
  /** Captured stdout budget; past it, output is truncated. */
  maxStdoutBytes: 4 * 1024 * 1024,
  /** Captured stderr budget — diagnostics only, never the payload. */
  maxStderrBytes: 256 * 1024,
  /** Longest single line forwarded to a line handler. */
  maxLineLength: 64 * 1024
});

/**
 * Environment variables a child may inherit. Everything else (tokens, DB
 * paths, PM2 internals) is withheld: a transcription runner has no business
 * reading them, and a compromised model script would.
 */
const INHERITED_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR'
]);

/**
 * Variables a PACKAGE INSTALLER may additionally inherit — and nothing else
 * may.
 *
 * The strict list above is right for everything that runs during a
 * transcription: FFmpeg reads a local file and the engine runs a local model,
 * so neither has any business reaching the network. Installing an engine is
 * the one operation that must. Without these, an installer behind a proxy or
 * a private CA fails with a TLS or DNS error while the very same `pip` run
 * from the operator's own shell succeeds — a difference nothing in the error
 * explains.
 *
 * Both cases of the proxy variables are listed because the tools disagree
 * about which they read.
 *
 * These carry secrets of their own (a proxy URL routinely embeds
 * `user:password`), which is exactly why they are opt-in per call site rather
 * than added to the list above: see {@link networkEnv}.
 */
export const NETWORK_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'PIP_CERT',
  'PIP_CLIENT_CERT',
  'PIP_CONFIG_FILE',
  'PIP_INDEX_URL',
  'PIP_EXTRA_INDEX_URL',
  'PIP_TRUSTED_HOST',
  'PIP_RETRIES',
  'PIP_TIMEOUT'
]);

/**
 * The proxy, CA and index settings present in this process's environment.
 *
 * Merge it into the `env` of a package install and nothing else. It is a
 * function rather than a constant so that a variable exported after startup
 * is still picked up, and so that the call sites that grant it are greppable.
 *
 * @returns {Object<string,string>} Only the variables that are actually set.
 */
export function networkEnv() {
  const env = {};
  for (const key of NETWORK_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

/**
 * Build the child environment: the allow-list above, plus explicit extras,
 * plus the locale pinning that keeps FFmpeg/ffprobe output parseable.
 *
 * @param {Object} [extra] - Variables the caller explicitly grants.
 * @returns {Object<string,string>}
 */
export function buildChildEnv(extra = {}) {
  const env = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Deterministic, ASCII output from tools that localise their messages.
  env.LC_ALL = 'C';
  env.LANG = 'C';
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    env[String(key)] = String(value);
  }
  return env;
}

/**
 * Split a stream into complete lines.
 *
 * Stateful on purpose: once a line grows past `maxLineLength` the splitter
 * enters a discarding mode and stays there until the next newline. Dropping
 * only the buffered prefix would emit the tail of that monster line as if it
 * were a line of its own — which, for a JSON-Lines protocol, means handing a
 * truncated fragment to the parser.
 *
 * @param {number} maxLineLength
 * @param {(line: string) => void} onLine
 * @returns {{push: (chunk: string) => void}}
 */
export function createLineSplitter(maxLineLength, onLine) {
  let rest = '';
  let discarding = false;

  return {
    push(chunk) {
      rest += chunk;
      let index = rest.indexOf('\n');
      while (index !== -1) {
        const line = rest.slice(0, index).replace(/\r$/, '');
        rest = rest.slice(index + 1);
        if (discarding) {
          // The rest of the over-long line — swallow it and resynchronise.
          discarding = false;
        } else if (line.length <= maxLineLength) {
          onLine(line);
        }
        index = rest.indexOf('\n');
      }
      // A "line" that never ends is an attack or a bug; drop it rather than
      // grow the buffer without bound.
      if (rest.length > maxLineLength) {
        rest = '';
        discarding = true;
      }
    }
  };
}

/**
 * @typedef {Object} ProcessResult
 * @property {number|null} code - Exit code, null when killed by a signal.
 * @property {string|null} signal - Terminating signal, when any.
 * @property {string} stdout - Captured stdout (possibly truncated).
 * @property {string} stderr - Captured stderr (possibly truncated).
 * @property {boolean} stdoutTruncated
 * @property {boolean} stderrTruncated
 * @property {number} durationMs
 */

/** Spawns and supervises external processes. */
export class ProcessRunner {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.logger]
   * @param {Function} [deps.spawn] - Injectable `child_process.spawn`, so
   *   tests drive the whole lifecycle without touching the OS.
   */
  constructor(deps = {}) {
    this.logger = deps.logger || NULL_LOGGER;
    this._spawn = deps.spawn || nodeSpawn;
    /** @type {Set<import('child_process').ChildProcess>} Live children. */
    this._running = new Set();
  }

  /** @returns {number} Number of processes currently supervised. */
  get runningCount() {
    return this._running.size;
  }

  /**
   * Run a command to completion.
   *
   * A non-zero exit is **not** an exception — the caller knows what a given
   * exit code means for its own tool. A timeout, a cancellation or a spawn
   * failure are, because no caller can do anything useful with a half-run
   * process.
   *
   * @param {string} command - Executable name or absolute path. Never a
   *   shell string.
   * @param {string[]} args - Arguments, one per element.
   * @param {Object} [options]
   * @param {string} [options.cwd]
   * @param {Object} [options.env] - Extra variables on top of the allow-list.
   * @param {number} [options.timeoutMs]
   * @param {number} [options.killGraceMs]
   * @param {AbortSignal} [options.signal] - Cancellation.
   * @param {(line: string) => void} [options.onStdoutLine]
   * @param {(line: string) => void} [options.onStderrLine]
   * @param {number} [options.maxStdoutBytes]
   * @param {number} [options.maxStderrBytes]
   * @param {string} [options.input] - Written to stdin, then closed.
   * @param {string} [options.reasonOnTimeout] - Error reason to raise on a
   *   timeout (FFmpeg and a model runner mean different things to the user).
   * @returns {Promise<ProcessResult>}
   * @throws {TranscriptionError} On spawn failure, timeout or cancellation.
   */
  async run(command, args = [], options = {}) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError('ProcessRunner.run requires a command name');
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      // Passing a non-string here would stringify an object into the command
      // line; refuse rather than build a surprising argv.
      throw new TypeError('ProcessRunner.run requires an array of string arguments');
    }

    const {
      cwd,
      env,
      timeoutMs = PROCESS_DEFAULTS.timeoutMs,
      killGraceMs = PROCESS_DEFAULTS.killGraceMs,
      signal,
      onStdoutLine,
      onStderrLine,
      maxStdoutBytes = PROCESS_DEFAULTS.maxStdoutBytes,
      maxStderrBytes = PROCESS_DEFAULTS.maxStderrBytes,
      maxLineLength = PROCESS_DEFAULTS.maxLineLength,
      input = null,
      reasonOnTimeout = TRANSCRIPTION_REASONS.BACKEND_TIMEOUT
    } = options;

    if (signal?.aborted) {
      throw TranscriptionError.cancelled();
    }

    const startedAt = Date.now();
    let child;
    try {
      child = this._spawn(command, args, {
        cwd,
        env: buildChildEnv(env),
        // Own process group: killing -pid reaches every descendant, so a
        // runner that forked workers cannot leave orphans behind (§18).
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });
    } catch (error) {
      throw wrapSpawnError(error, command);
    }

    this._running.add(child);
    this.logger.debug?.(`ProcessRunner: spawned ${command} (pid=${child.pid ?? '?'})`);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let killTimer = null;
      let graceTimer = null;

      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        if (graceTimer) clearTimeout(graceTimer);
        signal?.removeEventListener?.('abort', onAbort);
        this._running.delete(child);
      };

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      /** SIGTERM the group, then SIGKILL it if it is still there. */
      const terminate = () => {
        killProcessTree(child, 'SIGTERM', this.logger);
        graceTimer = setTimeout(() => {
          killProcessTree(child, 'SIGKILL', this.logger);
        }, killGraceMs);
        if (graceTimer.unref) graceTimer.unref();
      };

      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          timedOut = true;
          this.logger.warn(`ProcessRunner: ${command} exceeded ${timeoutMs}ms — terminating`);
          terminate();
        }, timeoutMs);
        if (killTimer.unref) killTimer.unref();
      }

      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');

      // A handler that throws must not take the run down with it: the caller
      // is parsing untrusted subprocess output.
      const guard = (handler, stream) => (line) => {
        try {
          handler(line);
        } catch (error) {
          this.logger.warn(`ProcessRunner: ${stream} handler threw: ${error.message}`);
        }
      };
      const stdoutSplitter = onStdoutLine
        ? createLineSplitter(maxLineLength, guard(onStdoutLine, 'stdout'))
        : null;
      const stderrSplitter = onStderrLine
        ? createLineSplitter(maxLineLength, guard(onStderrLine, 'stderr'))
        : null;

      child.stdout?.on?.('data', (chunk) => {
        const text = String(chunk);
        if (stdout.length < maxStdoutBytes) {
          const room = maxStdoutBytes - stdout.length;
          stdout += text.slice(0, room);
          if (text.length > room) stdoutTruncated = true;
        } else {
          stdoutTruncated = true;
        }
        stdoutSplitter?.push(text);
      });

      child.stderr?.on?.('data', (chunk) => {
        const text = String(chunk);
        if (stderr.length < maxStderrBytes) {
          const room = maxStderrBytes - stderr.length;
          stderr += text.slice(0, room);
          if (text.length > room) stderrTruncated = true;
        } else {
          stderrTruncated = true;
        }
        stderrSplitter?.push(text);
      });

      child.on('error', (error) => {
        settle(reject, wrapSpawnError(error, command));
      });

      child.on('close', (code, closeSignal) => {
        const durationMs = Date.now() - startedAt;
        if (cancelled) {
          return settle(reject, TranscriptionError.cancelled());
        }
        if (timedOut) {
          return settle(
            reject,
            new TranscriptionError(reasonOnTimeout, `${command} timed out after ${timeoutMs}ms`, {
              command,
              timeoutMs,
              stderr: tail(stderr)
            })
          );
        }
        settle(resolve, {
          code,
          signal: closeSignal ?? null,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs
        });
      });

      if (input !== null && child.stdin) {
        // EPIPE is normal when the child exits before reading stdin.
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      } else {
        child.stdin?.end?.();
      }
    });
  }

  /**
   * Signal every supervised process. Called on shutdown so a `stop()` does
   * not leave an FFmpeg running (the container would keep the CPU busy).
   * @param {string} [signalName='SIGTERM']
   * @returns {number} Number of processes signalled.
   */
  killAll(signalName = 'SIGTERM') {
    let count = 0;
    for (const child of this._running) {
      killProcessTree(child, signalName, this.logger);
      count++;
    }
    return count;
  }
}

/**
 * Signal a child's whole process group, falling back to the child alone when
 * the group is not addressable (Windows, or a child that already exited).
 *
 * @param {import('child_process').ChildProcess} child
 * @param {string} signalName
 * @param {Object} logger
 * @returns {void}
 */
export function killProcessTree(child, signalName, logger = NULL_LOGGER) {
  // Deliberately NOT guarded on `child.killed`: Node sets that flag as soon
  // as a signal has been DELIVERED, not when the process died. Guarding on it
  // would mean a process that ignores SIGTERM never receives the SIGKILL that
  // follows — exactly the zombie the grace period exists to prevent (§18).
  if (!child) return;
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  if (child.signalCode) return;
  const pid = child.pid;
  try {
    if (pid && process.platform !== 'win32') {
      process.kill(-pid, signalName);
      return;
    }
  } catch (error) {
    // ESRCH: the group is already gone. Anything else falls through to the
    // direct kill below.
    if (error.code !== 'ESRCH') {
      logger.debug?.(`killProcessTree: group kill failed (${error.message}), killing child`);
    }
  }
  try {
    child.kill(signalName);
  } catch (error) {
    logger.debug?.(`killProcessTree: kill failed: ${error.message}`);
  }
}

/**
 * Translate a spawn failure into a typed error, keeping `errno`/`code` in
 * `details` so a caller can turn ENOENT into "FFmpeg is not installed".
 *
 * @param {Error} error
 * @param {string} command
 * @returns {TranscriptionError}
 */
function wrapSpawnError(error, command) {
  const missing = error && (error.code === 'ENOENT' || error.code === 'EACCES');
  return new TranscriptionError(
    TRANSCRIPTION_REASONS.BACKEND_FAILED,
    missing
      ? `Command not found or not executable: ${command}`
      : `Failed to run ${command}: ${error.message}`,
    { command, code: error?.code ?? null },
    { cause: error }
  );
}

/**
 * @param {*} error
 * @returns {boolean} True when the failure means "the binary is not there",
 *   which callers map to their own reason (FFMPEG_MISSING, …).
 */
export function isMissingBinaryError(error) {
  return !!error?.details && (error.details.code === 'ENOENT' || error.details.code === 'EACCES');
}

/**
 * Last lines of a captured stream, for an error message that stays readable.
 * @param {string} text
 * @param {number} [lines=5]
 * @returns {string}
 */
export function tail(text, lines = 5) {
  if (!text) return '';
  return text.trim().split('\n').slice(-lines).join('\n');
}

export default ProcessRunner;
