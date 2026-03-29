// src/config/Config.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file if present
dotenv.config({ path: path.join(__dirname, '../../.env') });

class Config {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, '../../config.json');
    this.config = this.loadConfig();
    this._applyEnvOverrides();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(data);
      } else {
        // Return default configuration
        return this.getDefaultConfig();
      }
    } catch (error) {
      console.error(`Failed to load config: ${error.message}`);
      return this.getDefaultConfig();
    }
  }

  getDefaultConfig() {
    return {
      server: {
        port: 8080,
        wsPort: 8080,
        staticPath: './public',
        sslCert: null,
        sslKey: null
      },
      midi: {
        bufferSize: 1024,
        sampleRate: 44100,
        defaultLatency: 10
      },
      database: {
        path: './data/midimind.db'
      },
      logging: {
        level: 'info',
        file: './logs/midimind.log',
        console: true
      },
      playback: {
        defaultTempo: 120,
        defaultVolume: 100,
        lookahead: 100 // ms
      },
      latency: {
        defaultIterations: 5,
        recalibrationDays: 7
      },
      ble: {
        enabled: false,
        scanDuration: 10000 // ms
      },
      serial: {
        enabled: false,
        autoDetect: true,
        baudRate: 31250,
        ports: []
      }
    };
  }

  /**
   * Apply environment variable overrides to config values.
   * Env vars follow the pattern: MAESTRO_SECTION_KEY (e.g., MAESTRO_SERVER_PORT=3000)
   */
  _applyEnvOverrides() {
    const envMap = {
      PORT: 'server.port',
      MAESTRO_SERVER_PORT: 'server.port',
      MAESTRO_SERVER_WS_PORT: 'server.wsPort',
      MAESTRO_DATABASE_PATH: 'database.path',
      MAESTRO_LOG_LEVEL: 'logging.level',
      MAESTRO_LOG_FILE: 'logging.file',
      MAESTRO_BLE_ENABLED: 'ble.enabled',
      MAESTRO_SERIAL_ENABLED: 'serial.enabled',
      MAESTRO_SERIAL_BAUD_RATE: 'serial.baudRate',
      MAESTRO_SSL_CERT: 'server.sslCert',
      MAESTRO_SSL_KEY: 'server.sslKey'
    };

    for (const [envKey, configKey] of Object.entries(envMap)) {
      const envValue = process.env[envKey];
      if (envValue === undefined) continue;

      // Type coercion based on current config type
      const currentValue = this.get(configKey);
      let typedValue;

      if (typeof currentValue === 'number') {
        typedValue = Number(envValue);
        if (isNaN(typedValue)) {
          console.warn(`Config: ignoring invalid numeric env var ${envKey}=${envValue}`);
          continue;
        }
      } else if (typeof currentValue === 'boolean') {
        typedValue = envValue === 'true' || envValue === '1';
      } else {
        typedValue = envValue;
      }

      try {
        this.set(configKey, typedValue);
      } catch (e) {
        console.warn(`Config: env var ${envKey} rejected: ${e.message}`);
      }
    }
  }

  get(key, defaultValue = null) {
    const keys = key.split('.');
    let value = this.config;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }

    return value;
  }

  set(key, value) {
    // Validate known keys with type/range constraints
    const validators = {
      'server.port': (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
      'server.wsPort': (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
      'midi.bufferSize': (v) => Number.isInteger(v) && v > 0,
      'midi.sampleRate': (v) => Number.isInteger(v) && v > 0,
      'midi.defaultLatency': (v) => typeof v === 'number' && v >= 0,
      'database.path': (v) =>
        typeof v === 'string' &&
        v.length > 0 &&
        !path.isAbsolute(v) &&
        !path.normalize(v).startsWith('..'),
      'logging.level': (v) => ['error', 'warn', 'info', 'debug'].includes(v),
      'logging.file': (v) =>
        typeof v === 'string' &&
        v.length > 0 &&
        !path.isAbsolute(v) &&
        !path.normalize(v).startsWith('..'),
      'playback.defaultTempo': (v) => typeof v === 'number' && v > 0 && v <= 999,
      'playback.defaultVolume': (v) => Number.isInteger(v) && v >= 0 && v <= 127,
      'latency.defaultIterations': (v) => Number.isInteger(v) && v >= 1 && v <= 100,
      'latency.recalibrationDays': (v) => Number.isInteger(v) && v >= 1,
      'ble.scanDuration': (v) => Number.isInteger(v) && v > 0,
      'serial.baudRate': (v) => Number.isInteger(v) && v > 0
    };

    if (validators[key] && !validators[key](value)) {
      throw new Error(`Invalid value for config key '${key}': ${JSON.stringify(value)}`);
    }

    const keys = key.split('.');
    let obj = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in obj) || typeof obj[k] !== 'object') {
        obj[k] = {};
      }
      obj = obj[k];
    }

    obj[keys[keys.length - 1]] = value;
  }

  save() {
    try {
      const data = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, data, 'utf8');
      return true;
    } catch (error) {
      console.error(`Failed to save config: ${error.message}`);
      return false;
    }
  }

  reload() {
    this.config = this.loadConfig();
  }

  getAll() {
    return { ...this.config };
  }

  // Convenience getters
  get server() {
    return this.config.server;
  }

  get midi() {
    return this.config.midi;
  }

  get database() {
    return this.config.database;
  }

  get logging() {
    return this.config.logging;
  }

  get playback() {
    return this.config.playback;
  }

  get latency() {
    return this.config.latency;
  }

  get ble() {
    return this.config.ble;
  }

  get serial() {
    return this.config.serial || { enabled: false, autoDetect: true, baudRate: 31250, ports: [] };
  }
}

export default Config;
