import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Logger {
  constructor(config = {}) {
    this.level = config.level || 'info';
    this.logFile = config.file || null;
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };

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

  write(level, message, data = null) {
    if (!this.shouldLog(level)) return;

    const logMessage = this.format(level, message, data);
    
    // Console output with colors
    const colors = {
      debug: '\x1b[36m', // Cyan
      info: '\x1b[32m',  // Green
      warn: '\x1b[33m',  // Yellow
      error: '\x1b[31m'  // Red
    };
    const reset = '\x1b[0m';
    console.log(`${colors[level]}${logMessage}${reset}`);

    // File output (async to avoid blocking event loop)
    if (this.logFile) {
      fs.appendFile(this.logFile, logMessage + '\n', 'utf8', (error) => {
        if (error) {
          console.error('Failed to write to log file:', error);
        }
      });
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