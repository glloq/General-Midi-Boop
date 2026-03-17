// src/utils/JsonValidator.js

class JsonValidator {
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
    const errors = [];

    switch (command) {
      case 'device_info':
      case 'device_enable':
        if (!data.deviceId) {
          errors.push('deviceId is required');
        }
        break;

      case 'device_set_properties':
        if (!data.deviceId) {
          errors.push('deviceId is required');
        }
        if (!data.properties || typeof data.properties !== 'object') {
          errors.push('properties must be an object');
        }
        break;

      case 'virtual_create':
        if (!data.name || typeof data.name !== 'string') {
          errors.push('name is required and must be a string');
        }
        break;

      case 'virtual_delete':
        if (!data.deviceId) {
          errors.push('deviceId is required');
        }
        break;

      case 'ble_connect':
        if (!data.address) {
          errors.push('address is required');
        }
        break;

      case 'ble_disconnect':
        if (!data.deviceId) {
          errors.push('deviceId is required');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate routing command data
   */
  static validateRoutingCommand(command, data) {
    const errors = [];

    switch (command) {
      case 'route_create':
        if (!data.source) {
          errors.push('source is required');
        }
        if (!data.destination) {
          errors.push('destination is required');
        }
        break;

      case 'route_delete':
      case 'route_enable':
      case 'filter_set':
      case 'filter_clear':
      case 'channel_map':
        if (!data.routeId) {
          errors.push('routeId is required');
        }
        break;

      case 'monitor_start':
      case 'monitor_stop':
        if (!data.deviceId) {
          errors.push('deviceId is required');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate file command data
   */
  static validateFileCommand(command, data) {
    const errors = [];

    switch (command) {
      case 'file_upload':
        if (!data.filename) {
          errors.push('filename is required');
        }
        if (!data.data) {
          errors.push('data is required');
        }
        // Validate base64
        if (data.data && !this.isValidBase64(data.data)) {
          errors.push('data must be valid base64 string');
        }
        break;

      case 'file_load':
      case 'file_delete':
      case 'file_export':
        if (!data.fileId) {
          errors.push('fileId is required');
        }
        break;

      case 'file_save':
        if (!data.fileId) {
          errors.push('fileId is required');
        }
        if (!data.midi) {
          errors.push('midi data is required');
        }
        break;

      case 'file_rename':
        if (!data.fileId) {
          errors.push('fileId is required');
        }
        if (!data.newFilename) {
          errors.push('newFilename is required');
        }
        break;

      case 'file_move':
        if (!data.fileId) {
          errors.push('fileId is required');
        }
        if (!data.folder) {
          errors.push('folder is required');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate playback command data
   */
  static validatePlaybackCommand(command, data) {
    const errors = [];

    switch (command) {
      case 'playback_start':
        if (!data.outputDevice) {
          errors.push('outputDevice is required');
        }
        break;

      case 'playback_seek':
        if (data.position === undefined) {
          errors.push('position is required');
        }
        if (typeof data.position !== 'number' || data.position < 0) {
          errors.push('position must be a positive number');
        }
        break;

      case 'playback_set_loop':
        if (data.enabled === undefined) {
          errors.push('enabled is required');
        }
        if (typeof data.enabled !== 'boolean') {
          errors.push('enabled must be a boolean');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Validate latency command data
   */
  static validateLatencyCommand(command, data) {
    const errors = [];

    switch (command) {
      case 'latency_measure':
      case 'latency_set':
      case 'latency_get':
      case 'latency_delete':
        if (!data.deviceId) {
          errors.push('deviceId is required');
        }
        break;
    }

    // Additional validation for latency_set
    if (command === 'latency_set') {
      if (data.latency === undefined) {
        errors.push('latency is required');
      } else if (typeof data.latency !== 'number' || data.latency < 0) {
        errors.push('latency must be a positive number');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
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