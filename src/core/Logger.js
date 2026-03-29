import fs from 'fs';
import path from 'path';

// Log rotation defaults
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;
const ROTATION_CHECK_INTERVAL = 100; // Check rotation every N writes (not every write)

class Logger {
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
   */
  _openStream() {
    if (this._stream) {
      this._stream.end();
    }
    this._stream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this._stream.on('error', (err) => {
      console.error('Log stream error:', err.message);
    });
  }

  shouldLog(level) {
    return this.levels[level] >= this.levels[this.level];
  }

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

  write(level, message, data = null) {
    if (!this.shouldLog(level)) return;

    // Console output with human-readable colors
    const logMessage = this.format(level, message, data);
    const colors = {
      debug: '\x1b[36m', // Cyan
      info: '\x1b[32m', // Green
      warn: '\x1b[33m', // Yellow
      error: '\x1b[31m' // Red
    };
    const reset = '\x1b[0m';
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

  debug(message, data = null) {
    this.write('debug', message, data);
  }

  info(message, data = null) {
    this.write('info', message, data);
  }

  warn(message, data = null) {
    this.write('warn', message, data);
  }

  error(message, data = null) {
    this.write('error', message, data);
  }

  /**
   * Check if log file exceeds max size and rotate if needed.
   */
  _checkRotation() {
    if (this._rotating || !this.logFile) return;

    try {
      const stats = fs.statSync(this.logFile);
      if (stats.size >= this.maxLogSize) {
        this._rotate();
      }
    } catch (_) {
      // File may not exist yet
    }
  }

  /**
   * Rotate log files: app.log -> app.log.1 -> app.log.2 -> ... -> deleted
   * Closes and reopens the write stream around the rotation.
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
      console.error('Log rotation failed:', error.message);
    } finally {
      this._rotating = false;
    }
  }

  /**
   * Flush and close the log stream. Call during graceful shutdown.
   */
  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }

  // Utility methods
  logRequest(req) {
    this.info(`${req.method} ${req.url}`, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  }

  logWebSocket(event, clientId, data = null) {
    this.debug(`WS [${clientId}] ${event}`, data);
  }

  logMidi(event, device, data = null) {
    this.debug(`MIDI [${device}] ${event}`, data);
  }
}

export default Logger;
