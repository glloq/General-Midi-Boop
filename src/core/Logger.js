/**
 * @file src/core/Logger.js
 * @description Lightweight, dependency-free leveled logger with optional
 * file output and size-based rotation. Used by every backend component via
 * the DI container key `logger`.
 *
 * Design notes:
 * - Console output is colorised for human consumption.
 * - File output goes through a non-blocking `fs.WriteStream` so log writes
 *   never stall the MIDI hot path.
 * - Rotation is checked only every {@link ROTATION_CHECK_INTERVAL} writes
 *   to keep the cost of `stat` away from the per-message critical path.
 *
 * TODO: replace with a structured logger (pino/winston) once a perf budget
 * for serialization is established — current console.log + raw file writes
 * are simple but lose context tags (correlation IDs, child loggers).
 */
import fs from 'fs';
import path from 'path';

/** Default rotation threshold in bytes (10 MB). */
const MAX_LOG_SIZE = 10 * 1024 * 1024;
/** Default number of rotated files to retain (oldest is deleted). */
const MAX_LOG_FILES = 5;
/**
 * How many writes between size checks. Avoids calling `fs.stat` on every
 * message while still rotating promptly enough for typical traffic.
 */
const ROTATION_CHECK_INTERVAL = 100;

/**
 * Severity-ordered logger with console + optional file sink.
 *
 * Levels (ascending): `debug` < `info` < `warn` < `error`. A configured
 * `level` filters out everything below it.
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
    this.level = config.level || 'info';
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
   * Open (or reopen) the log file write stream for non-blocking I/O.
   * Any previously open stream is end()ed first so no descriptor leaks
   * across rotations.
   *
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
   * @param {('debug'|'info'|'warn'|'error')} level
   * @returns {boolean} True when `level` is at or above the configured
   *   minimum and should therefore be written.
   */
  shouldLog(level) {
    return this.levels[level] >= this.levels[this.level];
  }

  /**
   * Build a single-line, human-readable log entry. Errors are expanded
   * with stack trace; plain objects are pretty-printed.
   *
   * @param {string} level - Severity (already known to pass `shouldLog`).
   * @param {string} message - Primary message.
   * @param {*} [data] - Optional payload (Error, object, primitive).
   * @returns {string} Formatted log line (no trailing newline).
   */
  format(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    let logMessage = `[${timestamp}] ${levelStr} ${message}`;

    if (data) {
      if (data instanceof Error) {
        logMessage += `\n  Error: ${data.message}\n  Stack: ${data.stack}`;
      } else if (typeof data === 'object') {
        logMessage += `\n  ${JSON.stringify(data, null, 2)}`;
      } else {
        logMessage += ` ${data}`;
      }
    }

    return logMessage;
  }

  /**
   * Same inputs as {@link Logger#format} but produces a single JSON object
   * suitable for log aggregators (e.g. Loki, ELK). Used only for file
   * output when `jsonFormat` is enabled.
   *
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

    if (data) {
      if (data instanceof Error) {
        entry.error = { message: data.message, stack: data.stack };
      } else if (typeof data === 'object') {
        entry.data = data;
      } else {
        entry.data = data;
      }
    }

    return JSON.stringify(entry);
  }

  /**
   * Core write path. Filters by level, prints colorised text to the console
   * and (optionally) appends to the file stream. Rotation is checked at a
   * sub-rate to avoid `fs.stat` on every call.
   *
   * @param {('debug'|'info'|'warn'|'error')} level
   * @param {string} message
   * @param {*} [data]
   * @returns {void}
   */
  write(level, message, data = null) {
    if (!this.shouldLog(level)) return;

    const logMessage = this.format(level, message, data);
    const colors = {
      debug: '\x1b[36m', // Cyan
      info: '\x1b[32m', // Green
      warn: '\x1b[33m', // Yellow
      error: '\x1b[31m' // Red
    };
    const reset = '\x1b[0m';
    // eslint-disable-next-line no-console
    console.log(`${colors[level]}${logMessage}${reset}`);

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

  /**
   * @param {string} message
   * @param {*} [data]
   * @returns {void}
   */
  debug(message, data = null) {
    this.write('debug', message, data);
  }

  /**
   * @param {string} message
   * @param {*} [data]
   * @returns {void}
   */
  info(message, data = null) {
    this.write('info', message, data);
  }

  /**
   * @param {string} message
   * @param {*} [data]
   * @returns {void}
   */
  warn(message, data = null) {
    this.write('warn', message, data);
  }

  /**
   * @param {string} message
   * @param {*} [data]
   * @returns {void}
   */
  error(message, data = null) {
    this.write('error', message, data);
  }

  /**
   * Trigger rotation when the active log file has grown past
   * `maxLogSize`. Uses async `fs.stat` so the event loop is never
   * blocked by the size check itself.
   *
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
   * Perform the rotation cycle: oldest file is unlinked, every remaining
   * `app.log.N` is shifted to `app.log.(N+1)`, the active file becomes
   * `app.log.1`, and a fresh stream is opened. Synchronous on purpose —
   * rotation is rare and avoids interleaving partial writes mid-shift.
   *
   * @returns {void}
   * @private
   */
  _rotate() {
    this._rotating = true;
    try {
      // Close current stream before renaming files
      if (this._stream) {
        this._stream.end();
        this._stream = null;
      }

      // Remove oldest log file
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
    } finally {
      this._rotating = false;
    }
  }

  /**
   * Flush and close the file stream. Must be called during graceful
   * shutdown to avoid losing buffered log lines.
   *
   * @returns {void}
   */
  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }

  /**
   * Log an Express-style HTTP request at `info`. Captures method, URL, IP
   * and User-Agent for basic access tracing.
   *
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
   * Log a WebSocket event tagged with the originating client id.
   *
   * @param {string} event - Event name (e.g. `connect`, `command`).
   * @param {string|number} clientId
   * @param {*} [data]
   * @returns {void}
   */
  logWebSocket(event, clientId, data = null) {
    this.debug(`WS [${clientId}] ${event}`, data);
  }

  /**
   * Log a MIDI event tagged with the originating device name/id.
   *
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
