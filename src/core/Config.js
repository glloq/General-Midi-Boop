/**
 * @file src/core/Config.js
 * @description Runtime configuration loader for MidiMind.
 *
 * Resolution order (lowest to highest priority):
 *   1. {@link Config#getDefaultConfig} hard-coded defaults.
 *   2. JSON file at `config.json` (or the path passed to the constructor).
 *   3. Environment variables listed in {@link Config#_applyEnvOverrides}
 *      (loaded via dotenv from `.env` at module-load time).
 *
 * All values flowing through {@link Config#set} are validated against the
 * per-key schema embedded in that method, including range checks and
 * path-traversal protection for filesystem-bound keys.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env at import time so env overrides are visible by the time the
// first Config instance is constructed (callers may pass `configPath`
// before any other module reads process.env).
dotenv.config({ path: path.join(__dirname, '../../.env') });

/**
 * In-memory configuration store. Constructed once by `Application` and
 * registered in the DI container under the key `config`.
 */
class Config {
  /**
   * @param {?string} [configPath=null] - Optional explicit path to a
   *   JSON config file. When omitted, `config.json` at the repo root is used.
   */
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, '../../config.json');
    this.config = this.loadConfig();
    this._applyEnvOverrides();
  }

  /**
   * Read and parse the JSON config file. Falls back to defaults when the
   * file is missing OR when parsing fails (logged but non-fatal so the
   * process can still boot with safe defaults).
   *
   * @returns {Object} Loaded or default configuration object.
   */
  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(data);
      } else {
        return this.getDefaultConfig();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to load config: ${error.message}`);
      return this.getDefaultConfig();
    }
  }

  /**
   * Built-in fallback configuration used when no `config.json` is present
   * or the file is unreadable. The shape here is the source of truth for
   * the validators in {@link Config#set}.
   *
   * @returns {Object} A fresh defaults object (callers may mutate freely).
   */
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
   * Apply env-var overrides to config values after JSON load.
   *
   * Each known env var is mapped to a dotted config path; the env value is
   * coerced to the type currently held at that path (number / boolean /
   * string). Invalid coercions are logged and skipped — they never abort
   * boot.
   *
   * Convention: env var names follow `MAESTRO_SECTION_KEY`
   * (e.g. `MAESTRO_SERVER_PORT=3000`). The bare `PORT` alias is preserved
   * for hosting platforms that always inject it.
   *
   * @returns {void}
   * @private
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

      // Coerce env string -> typeof current value so JSON-loaded numbers
      // remain numbers (avoids surprises like server.port becoming "3000").
      const currentValue = this.get(configKey);
      let typedValue;

      if (typeof currentValue === 'number') {
        typedValue = Number(envValue);
        if (isNaN(typedValue)) {
          // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.warn(`Config: env var ${envKey} rejected: ${e.message}`);
      }
    }
  }

  /**
   * Read a configuration value by dotted path, returning `defaultValue`
   * when any segment is missing.
   *
   * @param {string} key - Dotted path, e.g. `"server.port"`.
   * @param {*} [defaultValue=null] - Value returned when the path is absent.
   * @returns {*} The configured value or `defaultValue`.
   */
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

  /**
   * Set a configuration value by dotted path. Known keys are validated
   * (type, range, path-traversal protection); unknown keys are accepted
   * verbatim so callers can stash ad-hoc state.
   *
   * @param {string} key - Dotted path, e.g. `"server.port"`.
   * @param {*} value - New value.
   * @returns {void}
   * @throws {Error} If `key` is a known key and `value` fails its validator.
   */
  set(key, value) {
    // Per-key validators. Path-bound keys reject absolute paths and `..`
    // segments to prevent operator typos from escaping the project root.
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

  /**
   * Persist the current config to disk as pretty-printed JSON.
   *
   * @returns {boolean} True on success, false when the write failed (the
   *   reason is logged to the console; this is intentionally non-throwing
   *   so a failed save cannot crash the process).
   */
  save() {
    try {
      const data = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, data, 'utf8');
      return true;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to save config: ${error.message}`);
      return false;
    }
  }

  /**
   * Re-read the config file from disk and re-apply the environment
   * overrides so a hot-reload behaves exactly like a fresh boot.
   *
   * @returns {void}
   */
  reload() {
    this.config = this.loadConfig();
    this._applyEnvOverrides();
  }

  /**
   * @returns {Object} A shallow clone of the full config tree (mutating
   *   the returned object does not affect the live config).
   */
  getAll() {
    return { ...this.config };
  }

  /** @returns {Object} `server` config section. */
  get server() {
    return this.config.server;
  }

  /** @returns {Object} `midi` config section. */
  get midi() {
    return this.config.midi;
  }

  /** @returns {Object} `database` config section. */
  get database() {
    return this.config.database;
  }

  /** @returns {Object} `logging` config section. */
  get logging() {
    return this.config.logging;
  }

  /** @returns {Object} `playback` config section. */
  get playback() {
    return this.config.playback;
  }

  /** @returns {Object} `latency` config section. */
  get latency() {
    return this.config.latency;
  }

  /** @returns {Object} `ble` config section. */
  get ble() {
    return this.config.ble;
  }

  /**
   * @returns {Object} `serial` section, falling back to a safe
   *   "disabled" record so callers can read fields without null-checks.
   */
  get serial() {
    return this.config.serial || { enabled: false, autoDetect: true, baudRate: 31250, ports: [] };
  }
}

export default Config;
