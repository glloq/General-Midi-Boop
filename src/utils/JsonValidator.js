/**
 * @file src/utils/JsonValidator.js
 * @description Static façade over the {@link SchemaCompiler} engine plus a
 * handful of legacy free-form validators (MIDI message, base64, JSON
 * string, sanitisation) that do not yet have a declarative schema.
 *
 * The `validate*Command(command, data)` family looks up the precompiled
 * schema for `command` in {@link COMPILED_SCHEMAS}. Commands without a
 * registered schema currently return `{ valid: true, errors: [] }` —
 * effectively a permissive default (ADR-004 migration).
 *
 * TODO: migrate `validateMidiMessage`, `validateSession`, `validatePlaylist`,
 * `validateInstrument`, `validateSystemCommand` to declarative schemas so
 * this file becomes a thin façade only.
 */
import { compileSchema } from './SchemaCompiler.js';
import playbackSchemas from '../api/commands/schemas/playback.schemas.js';
import routingSchemas from '../api/commands/schemas/routing.schemas.js';
import deviceSchemas from '../api/commands/schemas/device.schemas.js';
import fileSchemas from '../api/commands/schemas/file.schemas.js';
import latencySchemas from '../api/commands/schemas/latency.schemas.js';

/**
 * Map of command name -> compiled validator (`(data) => string[]`).
 * Built once at module load so per-request validation costs only a map
 * lookup (ADR-004 §Plan de migration).
 * @type {Object<string, Function>}
 */
const COMPILED_SCHEMAS = {};
for (const schemas of [
  playbackSchemas,
  routingSchemas,
  deviceSchemas,
  fileSchemas,
  latencySchemas
]) {
  for (const [cmd, schema] of Object.entries(schemas)) {
    COMPILED_SCHEMAS[cmd] = compileSchema(schema);
  }
}

/**
 * Static validator façade. Methods are mapped from command names by
 * `CommandRegistry.COMMAND_VALIDATORS`. All `validate*` methods return
 * the canonical `{ valid: boolean, errors: string[] }` shape.
 */
class JsonValidator {
  /**
   * Validate data against a declarative schema (ADR-004).
   * Returns { valid, errors } like the legacy validators so callers can
   * treat both paths uniformly.
   * @param {object} schema - see ADR-004 §Format de schéma retenu.
   * @param {object} data
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validateBySchema(schema, data) {
    const compiled = compileSchema(schema);
    const errors = compiled(data);
    return { valid: errors.length === 0, errors };
  }

  /**
   * Structural check on the WebSocket message envelope (not the
   * per-command payload). Confirms `message` is an object with a
   * non-empty string `command` and an optional object `data`.
   *
   * @param {*} message - Raw decoded WS frame.
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateCommand(message) {
    const errors = [];

    // Check if message is object
    if (typeof message !== 'object' || message === null) {
      errors.push('Message must be an object');
      return { valid: false, errors };
    }

    // Check required fields
    if (!message.command || typeof message.command !== 'string') {
      errors.push('Command field is required and must be a string');
    }

    if (message.data !== undefined && typeof message.data !== 'object') {
      errors.push('Data field must be an object');
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate the payload of a `device_*` command against its declarative
   * schema, if registered.
   *
   * @param {string} command - Command name (e.g. `"device_enable"`).
   * @param {Object} data - Command payload.
   * @returns {{valid: boolean, errors: string[]}} Permissive default
   *   `{valid:true, errors:[]}` when no schema is registered for `command`.
   */
  static validateDeviceCommand(command, data) {
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Validate the payload of a routing command (`route_*`, `filter_*`,
   * `channel_map`, `monitor_*`) against its declarative schema.
   *
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateRoutingCommand(command, data) {
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Validate the payload of a file command (`file_*`) against its
   * declarative schema.
   *
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateFileCommand(command, data) {
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Validate the payload of a playback command (`playback_*`) against its
   * declarative schema. The legacy switch-based fallback was removed in
   * ADR-004 P1-3.2a since every current playback command has a schema.
   *
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validatePlaybackCommand(command, data) {
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Validate the payload of a latency command (`latency_*`) against its
   * declarative schema.
   *
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateLatencyCommand(command, data) {
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Imperative validator for the in-memory MIDI message shape used by the
   * router and player (note on/off, CC, program, pitchbend). Channel
   * field is checked for every type.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateMidiMessage(data) {
    const errors = [];

    if (!data.type) {
      errors.push('type is required');
    }

    if (!data.deviceId) {
      errors.push('deviceId is required');
    }

    // Type-specific validation
    switch (data.type) {
      case 'noteon':
      case 'noteoff':
        if (data.note === undefined || data.note < 0 || data.note > 127) {
          errors.push('note must be 0-127');
        }
        if (data.velocity === undefined || data.velocity < 0 || data.velocity > 127) {
          errors.push('velocity must be 0-127');
        }
        break;

      case 'cc':
        if (data.controller === undefined || data.controller < 0 || data.controller > 127) {
          errors.push('controller must be 0-127');
        }
        if (data.value === undefined || data.value < 0 || data.value > 127) {
          errors.push('value must be 0-127');
        }
        break;

      case 'program':
        if (data.program === undefined || data.program < 0 || data.program > 127) {
          errors.push('program must be 0-127');
        }
        break;

      case 'pitchbend':
        if (data.value === undefined || data.value < -8192 || data.value > 8191) {
          errors.push('value must be -8192 to 8191');
        }
        break;
    }

    // Channel validation
    if (data.channel !== undefined && (data.channel < 0 || data.channel > 15)) {
      errors.push('channel must be 0-15');
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Cheap base64 well-formedness check. Does NOT decode — only verifies
   * the input matches `[A-Za-z0-9+/]*={0,2}` and has a length that is a
   * multiple of 4. Used to gate file uploads before allocating a buffer.
   *
   * @param {*} str
   * @returns {boolean}
   */
  static isValidBase64(str) {
    if (typeof str !== 'string') {
      return false;
    }

    const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Pattern.test(str)) {
      return false;
    }

    if (str.length % 4 !== 0) {
      return false;
    }

    return true;
  }

  /**
   * @param {string} str
   * @returns {boolean} True iff `str` parses as JSON.
   */
  static isValidJson(str) {
    try {
      JSON.parse(str);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Trim, length-cap, and strip ASCII control characters from a user-
   * supplied string. Returns `""` for non-string input. Does NOT escape
   * HTML — callers rendering output in a UI must still encode.
   *
   * @param {*} str
   * @param {number} [maxLength=255]
   * @returns {string}
   */
  static sanitizeString(str, maxLength = 255) {
    if (typeof str !== 'string') {
      return '';
    }

    str = str.trim().substring(0, maxLength);
    // Drop ASCII control bytes (0x00-0x1F, 0x7F) which can break log
    // viewers and DB drivers if persisted.
    str = str.replace(/[\x00-\x1F\x7F]/g, '');

    return str;
  }

  /**
   * Validate the payload of a `system_*` command. Currently only checks
   * `system_backup.path` is a string when present — unrecognised
   * subcommands pass through.
   *
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateSystemCommand(command, data) {
    const errors = [];

    switch (command) {
      case 'system_backup':
        if (data.path && typeof data.path !== 'string') {
          errors.push('path must be a string');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate a session record before persistence. Requires a string
   * `name`; if `data` is provided it must be a JSON-encoded string.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateSession(data) {
    const errors = [];

    if (!data.name || typeof data.name !== 'string') {
      errors.push('name is required and must be a string');
    }

    if (data.data && typeof data.data !== 'string') {
      errors.push('data must be a JSON string');
    }

    if (data.data && !this.isValidJson(data.data)) {
      errors.push('data must be valid JSON');
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate a playlist record before persistence. Only checks `name`
   * is a non-empty string; ordering of items is validated elsewhere.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validatePlaylist(data) {
    const errors = [];

    if (!data.name || typeof data.name !== 'string') {
      errors.push('name is required and must be a string');
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate an instrument record before persistence. Requires a string
   * `name`; checks `midi_channel` (0-15) and `program_number` (0-127)
   * when present.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateInstrument(data) {
    const errors = [];

    if (!data.name || typeof data.name !== 'string') {
      errors.push('name is required and must be a string');
    }

    if (data.midi_channel !== undefined) {
      if (!Number.isInteger(data.midi_channel) || data.midi_channel < 0 || data.midi_channel > 15) {
        errors.push('midi_channel must be 0-15');
      }
    }

    if (data.program_number !== undefined) {
      if (!Number.isInteger(data.program_number) || data.program_number < 0 || data.program_number > 127) {
        errors.push('program_number must be 0-127');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }
}

export default JsonValidator;