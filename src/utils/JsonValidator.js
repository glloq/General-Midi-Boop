/**
 * @file src/utils/JsonValidator.js
 * @description Static façade over the {@link SchemaCompiler} engine.
 *
 * Every validator now runs through the same engine:
 *   - `validateByCommand(command, data)` is the canonical entry point
 *     consumed by `CommandRegistry`; it looks up the precompiled
 *     schema for `command` in {@link COMPILED_SCHEMAS}.
 *   - The historical per-category helpers (`validateDeviceCommand`,
 *     `validateFileCommand`, ...) are now thin delegations to
 *     `validateByCommand` and preserved for backward compatibility.
 *   - The data-only validators (`validateMidiMessage`,
 *     `validateSession`, `validatePlaylist`, `validateInstrument`) run
 *     through their own compiled schemas declared below.
 *
 * Commands without a registered schema return the permissive
 * `{valid:true, errors:[]}` default.
 */
import { compileSchema } from './SchemaCompiler.js';
import playbackSchemas from '../api/commands/schemas/playback.schemas.js';
import routingSchemas from '../api/commands/schemas/routing.schemas.js';
import deviceSchemas from '../api/commands/schemas/device.schemas.js';
import fileSchemas from '../api/commands/schemas/file.schemas.js';
import latencySchemas from '../api/commands/schemas/latency.schemas.js';
import systemSchemas from '../api/commands/schemas/system.schemas.js';

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
  latencySchemas,
  systemSchemas
]) {
  for (const [cmd, schema] of Object.entries(schemas)) {
    COMPILED_SCHEMAS[cmd] = compileSchema(schema);
  }
}

/**
 * Data-only schemas for the non-command validators (payloads that are
 * not routed through the WS command dispatcher — they're called
 * directly by specific handlers). Each preserves the exact error
 * messages of the pre-migration imperative code so snapshots stay
 * stable.
 */
const MIDI_MESSAGE_SCHEMA = {
  custom: (data) => {
    const errors = [];
    if (!data.type) errors.push('type is required');
    if (!data.deviceId) errors.push('deviceId is required');

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

    if (data.channel !== undefined && (data.channel < 0 || data.channel > 15)) {
      errors.push('channel must be 0-15');
    }

    return errors;
  }
};

const SESSION_SCHEMA = {
  custom: (data) => {
    const errors = [];
    if (!data.name || typeof data.name !== 'string') {
      errors.push('name is required and must be a string');
    }
    if (data.data && typeof data.data !== 'string') {
      errors.push('data must be a JSON string');
    }
    if (data.data && typeof data.data === 'string') {
      try {
        JSON.parse(data.data);
      } catch {
        errors.push('data must be valid JSON');
      }
    }
    return errors;
  }
};

const PLAYLIST_SCHEMA = {
  custom: (data) => {
    if (!data.name || typeof data.name !== 'string') {
      return 'name is required and must be a string';
    }
    return null;
  }
};

const INSTRUMENT_SCHEMA = {
  custom: (data) => {
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
    return errors;
  }
};

const COMPILED_MIDI_MESSAGE = compileSchema(MIDI_MESSAGE_SCHEMA);
const COMPILED_SESSION = compileSchema(SESSION_SCHEMA);
const COMPILED_PLAYLIST = compileSchema(PLAYLIST_SCHEMA);
const COMPILED_INSTRUMENT = compileSchema(INSTRUMENT_SCHEMA);

/**
 * Internal helper: wrap a compiled validator's `string[]` output into
 * the canonical `{valid, errors}` envelope used by every caller.
 *
 * @param {Function} compiled
 * @param {Object} data
 * @returns {{valid:boolean, errors:string[]}}
 * @private
 */
function _run(compiled, data) {
  const errors = compiled(data || {});
  return { valid: errors.length === 0, errors };
}

/**
 * Static validator façade. Every `validate*` method returns the
 * canonical `{valid: boolean, errors: string[]}` shape.
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
   * Canonical command-payload validator. Looks up `command` in the
   * global compiled-schema registry and runs it; returns the permissive
   * `{valid:true, errors:[]}` default when no schema is registered.
   *
   * This is the single entry point consumed by
   * {@link CommandRegistry#handle} — the per-category helpers below
   * (`validateDeviceCommand`, `validateFileCommand`, ...) are thin
   * backward-compat shims.
   *
   * @param {string} command
   * @param {Object} data
   * @returns {{valid:boolean, errors:string[]}}
   */
  static validateByCommand(command, data) {
    const compiled = COMPILED_SCHEMAS[command];
    if (!compiled) return { valid: true, errors: [] };
    return _run(compiled, data);
  }

  /**
   * Backward-compat shim. Prefer {@link JsonValidator.validateByCommand}.
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateDeviceCommand(command, data) {
    return JsonValidator.validateByCommand(command, data);
  }

  /**
   * Backward-compat shim. Prefer {@link JsonValidator.validateByCommand}.
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateRoutingCommand(command, data) {
    return JsonValidator.validateByCommand(command, data);
  }

  /**
   * Backward-compat shim. Prefer {@link JsonValidator.validateByCommand}.
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateFileCommand(command, data) {
    return JsonValidator.validateByCommand(command, data);
  }

  /**
   * Backward-compat shim. Prefer {@link JsonValidator.validateByCommand}.
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validatePlaybackCommand(command, data) {
    return JsonValidator.validateByCommand(command, data);
  }

  /**
   * Backward-compat shim. Prefer {@link JsonValidator.validateByCommand}.
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateLatencyCommand(command, data) {
    return JsonValidator.validateByCommand(command, data);
  }

  /**
   * Validate the in-memory MIDI message shape used by the router and
   * player (note on/off, CC, program, pitchbend). Runs through the
   * {@link SchemaCompiler} engine; error messages are preserved
   * byte-for-byte vs. the pre-migration imperative code.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateMidiMessage(data) {
    return _run(COMPILED_MIDI_MESSAGE, data);
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
   * Backward-compat shim for the system-command validator. Routes
   * through {@link JsonValidator.validateByCommand} now that
   * `system_backup` has a real declarative schema in
   * `schemas/system.schemas.js`. Unrecognised subcommands pass through
   * with the permissive default.
   *
   * @param {string} command
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateSystemCommand(command, data) {
    return JsonValidator.validateByCommand(command, data);
  }

  /**
   * Validate a session record before persistence. Runs through
   * {@link SESSION_SCHEMA} — requires a string `name`; when `data` is
   * present it must be a valid JSON-encoded string.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateSession(data) {
    return _run(COMPILED_SESSION, data);
  }

  /**
   * Validate a playlist record before persistence. Runs through
   * {@link PLAYLIST_SCHEMA} — requires a non-empty string `name`.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validatePlaylist(data) {
    return _run(COMPILED_PLAYLIST, data);
  }

  /**
   * Validate an instrument record before persistence. Runs through
   * {@link INSTRUMENT_SCHEMA} — requires a string `name`, checks
   * `midi_channel` (0-15) and `program_number` (0-127) when present.
   *
   * @param {Object} data
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validateInstrument(data) {
    return _run(COMPILED_INSTRUMENT, data);
  }
}

export default JsonValidator;