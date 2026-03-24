import fs from 'fs';
import path from 'path';

// Log rotation defaults
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;

class Logger {
  constructor(config = {}) {
    this.level = config.level || 'info';
    this.logFile = config.file || null;
    this.jsonFormat = config.jsonFormat || false;
    this.maxLogSize = config.maxLogSize || MAX_LOG_SIZE;
    this.maxLogFiles = config.maxLogFiles || MAX_LOG_FILES;
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    this._rotating = false;

    // Ensure log directory exists
    if (this.logFile) {
      const logDir = path.dirname(this.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }
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

    // File output (sync to avoid write/rotation race conditions)
    if (this.logFile) {
      this._checkRotation();
      const fileContent = this.jsonFormat ? this.formatJson(level, message, data) : logMessage;
      try {
        fs.appendFileSync(this.logFile, fileContent + '\n', 'utf8');
      } catch (error) {
        console.error('Failed to write to log file:', error.message);
      }
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
   */
  _rotate() {
    this._rotating = true;
    try {
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
    } catch (error) {
      console.error('Log rotation failed:', error.message);
    } finally {
      this._rotating = false;
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
