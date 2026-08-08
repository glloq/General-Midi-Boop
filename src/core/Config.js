/**
 * @file src/core/Config.js
 * @description Runtime config loader. Resolution order (low→high): hard-coded
 * defaults → `config.json` → `GMBOOP_*` env vars. Values flowing through
 * {@link Config#set} are validated (range + path-traversal protection).
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

/** In-memory config store; DI container key `config`. */
class Config {
  /**
   * @param {?string} [configPath=null] - JSON config file path; defaults to
   *   `config.json` at the repo root.
   */
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, '../../config.json');
    this.config = this.loadConfig();
    this._applyEnvOverrides();
  }

  /**
   * Read/parse the JSON config file, falling back to defaults when missing
   * or unparseable (logged, non-fatal).
   * @returns {Object} Loaded or default config.
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
   * Built-in fallback config (also the shape the {@link Config#set}
   * validators assume).
   * @returns {Object} Fresh defaults object (callers may mutate).
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
        path: './data/gmboop.db'
      },
      logging: {
        level: 'info',
        file: './logs/gmboop.log',
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
      },
      sf2: {
        // L1 (in-process) SF2 preset cache budget. Default tuned for
        // Pi 3B+ where Node heap is capped at 384 MB (ecosystem.config.cjs).
        // See src/files/SF2PresetService.js for the consumer.
        cacheMaxBytes: 128 * 1024 * 1024,
        cacheMaxEntries: 256
      }
    };
  }

  /**
   * Apply `GMBOOP_*` env-var overrides after JSON load, coercing each value
   * to the type currently held at its dotted path. Invalid coercions are
   * logged and skipped (never abort boot). Bare `PORT` alias is kept for
   * hosting platforms.
   * @returns {void}
   * @private
   */
  _applyEnvOverrides() {
    const envMap = {
      PORT: 'server.port',
      GMBOOP_SERVER_PORT: 'server.port',
      GMBOOP_SERVER_WS_PORT: 'server.wsPort',
      GMBOOP_DATABASE_PATH: 'database.path',
      GMBOOP_LOG_LEVEL: 'logging.level',
      GMBOOP_LOG_FILE: 'logging.file',
      GMBOOP_BLE_ENABLED: 'ble.enabled',
      GMBOOP_SERIAL_ENABLED: 'serial.enabled',
      GMBOOP_SERIAL_BAUD_RATE: 'serial.baudRate',
      GMBOOP_SSL_CERT: 'server.sslCert',
      GMBOOP_SSL_KEY: 'server.sslKey',
      GMBOOP_SF2_CACHE_MAX_BYTES: 'sf2.cacheMaxBytes',
      GMBOOP_SF2_CACHE_MAX_ENTRIES: 'sf2.cacheMaxEntries',
      GMBOOP_SECURITY_MODE: 'security.mode',
      GMBOOP_RTP_MIDI_PORT: 'network.rtpMidiPort'
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
   * Set a value by dotted path. Known keys are validated (type, range,
   * path-traversal); unknown keys are accepted verbatim.
   * @param {string} key - Dotted path, e.g. `"server.port"`.
   * @param {*} value
   * @returns {void}
   * @throws {Error} When a known `key`'s `value` fails its validator.
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
      // Absolute paths ARE allowed here: an operator pointing the DB/log at
      // external storage (e.g. GMBOOP_DATABASE_PATH=/mnt/ssd/gmboop.db) is a
      // normal appliance request, and silently ignoring it looked like "data
      // doesn't persist" (audit B3 M6). Only relative traversal (`..`) is
      // rejected — these are operator-owned env values.
      'database.path': (v) =>
        typeof v === 'string' && v.length > 0 && !path.normalize(v).startsWith('..'),
      'logging.level': (v) => ['error', 'warn', 'info', 'debug'].includes(v),
      'logging.file': (v) =>
        typeof v === 'string' && v.length > 0 && !path.normalize(v).startsWith('..'),
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
   * Persist the config to disk as pretty-printed JSON. Non-throwing.
   * @returns {boolean} True on success; false (logged) on write failure.
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
   * Re-read the file and re-apply env overrides (hot-reload == fresh boot).
   * @returns {void}
   */
  reload() {
    this.config = this.loadConfig();
    this._applyEnvOverrides();
  }

  /** @returns {Object} Shallow clone of the full config tree. */
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

  /**
   * @returns {Object} `network` section (RTP-MIDI). Falls back to the
   *   default port so callers can read `.rtpMidiPort` without null-checks.
   */
  get network() {
    return this.config.network || { rtpMidiPort: 5004 };
  }

  /**
   * @returns {Object} `security` section. Falls back to `trusted-lan` so
   *   `config.security.mode` is always readable (the direct-property access
   *   used by HttpServer relies on this getter existing — without it the
   *   config path was dead and only GMBOOP_SECURITY_MODE worked).
   */
  get security() {
    return this.config.security || { mode: 'trusted-lan' };
  }
}

export default Config;
