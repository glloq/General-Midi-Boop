/**
 * @file src/core/Logger.js
 * @description Dependency-free leveled logger (DI key `logger`). Colorised
 * console output plus optional non-blocking file sink with size-based
 * rotation checked every {@link ROTATION_CHECK_INTERVAL} writes.
 */
import fs from 'fs';
import path from 'path';

/** Default rotation threshold in bytes (10 MB). */
const MAX_LOG_SIZE = 10 * 1024 * 1024;
/** Default number of rotated files to retain (oldest is deleted). */
const MAX_LOG_FILES = 5;
/** Writes between size checks (keeps `fs.stat` off the per-message path). */
const ROTATION_CHECK_INTERVAL = 100;

/**
 * Severity-ordered logger (debug < info < warn < error); a configured
 * `level` filters out everything below it. Convention: `warn` = degradation
 * the caller still recovers from with a usable value; `error` = the
 * operation failed and that surfaced to the caller.
 */
class Logger {
  /**
   * @param {Object} [config] - Logger configuration (typically
   *   `Config#logging`).
   * @param {('debug'|'info'|'warn'|'error')} [config.level='info'] - Minimum
   *   level that gets written.
   * @param {?string} [config.file=null] - Absolute or cwd-relative log file
   *   path. When omitted, only console output is produced.
   * @param {boolean} [config.jsonFormat=false] - When true, file output is
   *   one JSON object per line (console stays colorised text).
   * @param {number} [config.maxLogSize] - Rotation size threshold in bytes.
   * @param {number} [config.maxLogFiles] - Number of rotated files retained.
   */
  constructor(config = {}) {
    this.logFile = config.file || null;
    this.jsonFormat = config.jsonFormat || false;
    this.maxLogSize = config.maxLogSize > 0 ? config.maxLogSize : MAX_LOG_SIZE;
    this.maxLogFiles = config.maxLogFiles >= 1 ? config.maxLogFiles : MAX_LOG_FILES;
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    // Cached numeric level so hot-path callers can branch in O(1) without a
    // map lookup. Stays in sync via the `level` accessor below: any later
    // `logger.level = 'debug'` recomputes the cache.
    this._level = config.level || 'info';
    this._levelNum = this.levels[this._level] ?? 1;
    this._rotating = false;
    this._stream = null;
    this._writeCount = 0;

    // Ensure log directory exists and open write stream
    if (this.logFile) {
      const logDir = path.dirname(this.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      this._openStream();
    }
  }

  /**
   * Open (or reopen) the log file stream; ends any previous stream first
   * so no descriptor leaks across rotations.
   * @returns {void}
   * @private
   */
  _openStream() {
    if (this._stream) {
      this._stream.end();
    }
    this._stream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this._stream.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('Log stream error:', err.message);
    });
  }

  /**
   * Minimum level. Setting it recomputes the cached numeric form so the
   * hot-path branch helpers stay coherent on runtime level changes.
   * @type {('debug'|'info'|'warn'|'error')}
   */
  get level() {
    return this._level;
  }
  set level(v) {
    this._level = v;
    this._levelNum = this.levels[v] ?? 1;
  }

  /**
   * @param {('debug'|'info'|'warn'|'error')} level
   * @returns {boolean} True when `level` is at or above the configured
   *   minimum and should therefore be written.
   */
  shouldLog(level) {
    return this.levels[level] >= this._levelNum;
  }

  /**
   * Hot-path branch helper: true when debug output is enabled. Gate
   * debug-message construction in critical loops on this.
   * @returns {boolean}
   */
  isDebugEnabled() {
    return this._levelNum <= 0;
  }

  /** @returns {boolean} True when warn output is enabled. */
  isWarnEnabled() {
    return this._levelNum <= 2;
  }

  /**
   * Build a single-line log entry. Errors expand with stack; objects are
   * pretty-printed. Falsy payloads (0, '', false) are kept; only
   * null/undefined are skipped.
   * @param {string} level
   * @param {string} message
   * @param {*} [data]
   * @returns {string} Formatted line (no trailing newline).
   */
  format(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    let logMessage = `[${timestamp}] ${levelStr} ${message}`;

    if (data !== null && data !== undefined) {
      if (data instanceof Error) {
        logMessage += `\n  Error: ${data.message}\n  Stack: ${data.stack}`;
      } else if (typeof data === 'object') {
        // Never let a circular reference / BigInt / throwing toJSON in the
        // payload crash the caller — logging must be side-effect-safe (audit
        // B3 M1).
        let json;
        try {
          json = JSON.stringify(data, null, 2);
        } catch (err) {
          json = `[unserializable log payload: ${err.message}]`;
        }
        logMessage += `\n  ${json}`;
      } else {
        logMessage += ` ${data}`;
      }
    }

    return logMessage;
  }

  /**
   * Like {@link Logger#format} but emits one JSON object per line for log
   * aggregators. Used for file output when `jsonFormat` is enabled.
   * @param {string} level
   * @param {string} message
   * @param {*} [data]
   * @returns {string} Single-line JSON entry.
   */
  formatJson(level, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message
    };

    if (data !== null && data !== undefined) {
      if (data instanceof Error) {
        entry.error = { message: data.message, stack: data.stack };
      } else {
        entry.data = data;
      }
    }

    try {
      return JSON.stringify(entry);
    } catch (err) {
      // Circular/BigInt payload — emit a valid JSON line instead of throwing
      // into the caller (audit B3 M1).
      return JSON.stringify({
        timestamp: entry.timestamp,
        level,
        message,
        data: `[unserializable log payload: ${err.message}]`
      });
    }
  }

  /**
   * Core write path: level filter → colorised console → optional file
   * stream (rotation checked at a sub-rate).
   * @param {('debug'|'info'|'warn'|'error')} level
   * @param {string} message
   * @param {*} [data]
   * @returns {void}
   */
  write(level, message, data = null) {
    if (!this.shouldLog(level)) return;

    const logMessage = this.format(level, message, data);
    // ANSI only on an interactive TTY; otherwise it pollutes PM2/systemd logs.
    if (process.stdout && process.stdout.isTTY) {
      const colors = {
        debug: '\x1b[36m', // Cyan
        info: '\x1b[32m', // Green
        warn: '\x1b[33m', // Yellow
        error: '\x1b[31m' // Red
      };
      const reset = '\x1b[0m';
      // eslint-disable-next-line no-console
      console.log(`${colors[level]}${logMessage}${reset}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(logMessage);
    }

    // File output via non-blocking WriteStream
    if (this._stream && !this._stream.destroyed) {
      // Only check rotation periodically to avoid costly statSync on every write
      if (++this._writeCount >= ROTATION_CHECK_INTERVAL) {
        this._writeCount = 0;
        this._checkRotation();
      }
      const fileContent = this.jsonFormat ? this.formatJson(level, message, data) : logMessage;
      this._stream.write(fileContent + '\n');
    }
  }

  /** @param {string} message @param {*} [data] @returns {void} */
  debug(message, data = null) {
    this.write('debug', message, data);
  }

  /** @param {string} message @param {*} [data] @returns {void} */
  info(message, data = null) {
    this.write('info', message, data);
  }

  /** @param {string} message @param {*} [data] @returns {void} */
  warn(message, data = null) {
    this.write('warn', message, data);
  }

  /** @param {string} message @param {*} [data] @returns {void} */
  error(message, data = null) {
    this.write('error', message, data);
  }

  /**
   * Rotate when the active log file exceeds `maxLogSize`. Uses async
   * `fs.stat` so the event loop is never blocked by the size check.
   * @returns {void}
   * @private
   */
  _checkRotation() {
    if (this._rotating || !this.logFile) return;

    fs.stat(this.logFile, (err, stats) => {
      if (!err && stats.size >= this.maxLogSize) {
        this._rotate();
      }
    });
  }

  /**
   * Rotation cycle: unlink the oldest file, shift `app.log.N` →
   * `app.log.(N+1)`, the active file becomes `app.log.1`, reopen a fresh
   * stream. Synchronous — rotation is rare and must not interleave writes.
   * @returns {void}
   * @private
   */
  _rotate() {
    this._rotating = true;
    try {
      if (this._stream) {
        this._stream.end();
        this._stream = null;
      }

      const oldest = `${this.logFile}.${this.maxLogFiles}`;
      if (fs.existsSync(oldest)) {
        fs.unlinkSync(oldest);
      }

      // Shift existing rotated files
      for (let i = this.maxLogFiles - 1; i >= 1; i--) {
        const src = `${this.logFile}.${i}`;
        const dest = `${this.logFile}.${i + 1}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, dest);
        }
      }

      // Rotate current log
      if (fs.existsSync(this.logFile)) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }

      // Reopen stream for the new log file
      this._openStream();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Log rotation failed:', error.message);
      // The stream was already nulled above; if a mid-rotation error (EPERM,
      // EBUSY, disk full) skipped the reopen, file logging would be silently
      // dead until restart. Re-open so the file sink survives (audit B3 M2).
      if (!this._stream) {
        try {
          this._openStream();
        } catch (reopenErr) {
          // eslint-disable-next-line no-console
          console.error('Log stream reopen after failed rotation failed:', reopenErr.message);
        }
      }
    } finally {
      this._rotating = false;
    }
  }

  /**
   * Flush and close the file stream. Call on graceful shutdown so buffered
   * lines are not lost.
   * @returns {void}
   */
  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }

  /**
   * Truncate the active log file and reopen the stream. Safe to call while
   * in use. Console output is unaffected.
   * @returns {boolean} True on success; false when no log file is
   *   configured (console-only loggers).
   */
  clear() {
    if (!this.logFile) return false;
    try {
      if (this._stream) {
        this._stream.end();
        this._stream = null;
      }
      // Open with 'w' to truncate to zero bytes; close immediately so
      // the writable-stream reopen below owns the descriptor.
      fs.closeSync(fs.openSync(this.logFile, 'w'));
      this._openStream();
      this._writeCount = 0;
      return true;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Log clear failed:', error.message);
      // Best-effort reopen so logging can resume even if truncation failed.
      try {
        this._openStream();
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  /**
   * Log an Express request at `info` (method, URL, IP, User-Agent).
   * @param {import('express').Request} req
   * @returns {void}
   */
  logRequest(req) {
    this.info(`${req.method} ${req.url}`, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  }

  /**
   * Log a WebSocket event tagged with the client id.
   * @param {string} event
   * @param {string|number} clientId
   * @param {*} [data]
   * @returns {void}
   */
  logWebSocket(event, clientId, data = null) {
    this.debug(`WS [${clientId}] ${event}`, data);
  }

  /**
   * Log a MIDI event tagged with the device name/id.
   * @param {string} event
   * @param {string} device
   * @param {*} [data]
   * @returns {void}
   */
  logMidi(event, device, data = null) {
    this.debug(`MIDI [${device}] ${event}`, data);
  }
}

export default Logger;
