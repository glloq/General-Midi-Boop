// src/utils/JsonValidator.js
import { compileSchema } from './SchemaCompiler.js';
import playbackSchemas from '../api/commands/schemas/playback.schemas.js';
import routingSchemas from '../api/commands/schemas/routing.schemas.js';
import deviceSchemas from '../api/commands/schemas/device.schemas.js';
import fileSchemas from '../api/commands/schemas/file.schemas.js';
import latencySchemas from '../api/commands/schemas/latency.schemas.js';

// Compile schema maps once at module load (ADR-004 §Plan de migration).
// Key : command name, Value : compiled validator (data => string[]).
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
   * Validate command message structure
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
   * Validate device command data
   */
  static validateDeviceCommand(command, data) {
    // ADR-004 migration (P1-3.2c) : lookup in declarative schema map.
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Validate routing command data
   */
  static validateRoutingCommand(command, data) {
    // ADR-004 migration (P1-3.2b) : lookup in declarative schema map.
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Validate file command data
   */
  static validateFileCommand(command, data) {
    // ADR-004 migration (P1-3.2c) : lookup in declarative schema map.
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Validate playback command data
   */
  static validatePlaybackCommand(command, data) {
    // ADR-004 migration (P1-3.2a) : first consult the declarative schema map.
    // Legacy switch remains below as a no-op fallback for commands not yet
    // migrated — all current playback cases are covered by the map.
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Validate latency command data
   */
  static validateLatencyCommand(command, data) {
    // ADR-004 migration (P1-3.2c) : lookup in declarative schema map.
    const compiled = COMPILED_SCHEMAS[command];
    if (compiled) {
      const errors = compiled(data || {});
      return { valid: errors.length === 0, errors };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Validate MIDI message data
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
   * Check if string is valid base64
   */
  static isValidBase64(str) {
    if (typeof str !== 'string') {
      return false;
    }

    // Base64 regex pattern
    const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
    
    // Check pattern
    if (!base64Pattern.test(str)) {
      return false;
    }

    // Check length (must be multiple of 4)
    if (str.length % 4 !== 0) {
      return false;
    }

    return true;
  }

  /**
   * Validate JSON string
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
   * Sanitize string input
   */
  static sanitizeString(str, maxLength = 255) {
    if (typeof str !== 'string') {
      return '';
    }

    // Trim and limit length
    str = str.trim().substring(0, maxLength);

    // Remove control characters
    str = str.replace(/[\x00-\x1F\x7F]/g, '');

    return str;
  }

  /**
   * Validate system command data
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
   * Validate session data
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
   * Validate playlist data
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
   * Validate instrument data
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