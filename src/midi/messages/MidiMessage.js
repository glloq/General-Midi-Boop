/**
 * @file src/midi/messages/MidiMessage.js
 * @description Parse / serialize / validate / pretty-print a single MIDI
 * message. Accepts both raw byte arrays (channel voice messages and the
 * common system messages) and richer object form used internally on the
 * EventBus. Pitch bend is normalised to the centered range
 * (-8192..8191) at parse time and re-encoded to raw 14-bit at serialize
 * time.
 */
import MidiUtils from '../../utils/MidiUtils.js';

class MidiMessage {
  /**
   * @param {(number[]|Object)} [data] - Raw byte array or object form.
   *   When omitted, the instance is left empty for callers that want to
   *   build a message field-by-field before calling `toBytes`.
   */
  constructor(data) {
    this.raw = data;
    this.type = null;
    this.channel = null;
    this.timestamp = Date.now();

    if (data) {
      this.parse(data);
    }
  }

  /**
   * Dispatch to {@link MidiMessage#parseBytes} or
   * {@link MidiMessage#parseObject} based on the input shape.
   *
   * @param {(number[]|Object)} data
   * @returns {void}
   * @throws {Error} For unsupported input types.
   */
  parse(data) {
    if (Array.isArray(data)) {
      this.parseBytes(data);
    } else if (typeof data === 'object') {
      this.parseObject(data);
    } else {
      throw new Error('Invalid MIDI message data');
    }
  }

  /**
   * Decode a raw MIDI byte stream into the typed instance fields. Note
   * On with velocity 0 is rewritten as Note Off (canonical MIDI
   * convention). Unsupported message types throw — caller handles.
   *
   * @param {number[]} bytes
   * @returns {void}
   * @throws {Error}
   */
  parseBytes(bytes) {
    if (!bytes || bytes.length < 1) {
      throw new Error('Empty MIDI message');
    }

    const status = bytes[0];
    const parsed = MidiUtils.parseStatus(status);

    this.type = this.getTypeString(parsed.type);
    this.channel = parsed.channel;

    switch (parsed.type) {
      case MidiUtils.MessageTypes.NOTE_OFF:
        if (bytes.length < 3) throw new Error('Note Off message requires 3 bytes');
        this.note = bytes[1];
        this.velocity = bytes[2];
        break;

      case MidiUtils.MessageTypes.NOTE_ON:
        if (bytes.length < 3) throw new Error('Note On message requires 3 bytes');
        this.note = bytes[1];
        this.velocity = bytes[2];
        // Treat velocity 0 as note off
        if (this.velocity === 0) {
          this.type = 'noteoff';
        }
        break;

      case MidiUtils.MessageTypes.POLY_AFTERTOUCH:
        if (bytes.length < 3) throw new Error('Poly Aftertouch message requires 3 bytes');
        this.note = bytes[1];
        this.pressure = bytes[2];
        break;

      case MidiUtils.MessageTypes.CONTROL_CHANGE:
        if (bytes.length < 3) throw new Error('Control Change message requires 3 bytes');
        this.controller = bytes[1];
        this.value = bytes[2];
        break;

      case MidiUtils.MessageTypes.PROGRAM_CHANGE:
        if (bytes.length < 2) throw new Error('Program Change message requires 2 bytes');
        this.program = bytes[1];
        break;

      case MidiUtils.MessageTypes.CHANNEL_AFTERTOUCH:
        if (bytes.length < 2) throw new Error('Channel Aftertouch message requires 2 bytes');
        this.pressure = bytes[1];
        break;

      case MidiUtils.MessageTypes.PITCH_BEND: {
        if (bytes.length < 3) throw new Error('Pitch Bend message requires 3 bytes');
        const lsb = bytes[1];
        const msb = bytes[2];
        this.value = MidiUtils.decode14bit(msb, lsb) - 8192; // Center at 0
        break;
      }

      case MidiUtils.MessageTypes.SYSTEM:
        this.parseSystemMessage(bytes);
        break;

      default:
        throw new Error(`Unknown MIDI message type: ${parsed.type}`);
    }
  }

  /**
   * Hydrate from the object form used on the EventBus. Property copy
   * is whitelisted to defeat prototype pollution from untrusted payloads.
   *
   * @param {Object} obj
   * @returns {void}
   */
  parseObject(obj) {
    this.type = obj.type;
    this.channel = obj.channel;

    const allowedKeys = [
      'note', 'velocity', 'pressure', 'controller', 'value',
      'program', 'data', 'song', 'timestamp', 'raw'
    ];
    Object.keys(obj).forEach(key => {
      if (key !== 'type' && key !== 'channel' && allowedKeys.includes(key)) {
        this[key] = obj[key];
      }
    });
  }

  /**
   * Decode System Common / Real-Time messages. Each branch sets `type`
   * and any payload field expected by downstream consumers.
   * Unrecognised system status bytes are silently ignored — they are
   * harmless on the bus and we don't want to throw mid-stream.
   *
   * @param {number[]} bytes
   * @returns {void}
   */
  parseSystemMessage(bytes) {
    const status = bytes[0];

    if (status === 0xF0) {
      // SysEx
      this.type = 'sysex';
      this.data = bytes.slice(1, -1); // Remove 0xF0 and 0xF7
    } else if (status === 0xF1) {
      // MIDI Time Code Quarter Frame
      this.type = 'mtc';
      this.value = bytes[1];
    } else if (status === 0xF2) {
      // Song Position Pointer
      this.type = 'position';
      this.value = MidiUtils.decode14bit(bytes[2], bytes[1]);
    } else if (status === 0xF3) {
      // Song Select
      this.type = 'select';
      this.song = bytes[1];
    } else if (status === 0xF6) {
      // Tune Request
      this.type = 'tune';
    } else if (status === 0xF8) {
      // Timing Clock
      this.type = 'clock';
    } else if (status === 0xFA) {
      // Start
      this.type = 'start';
    } else if (status === 0xFB) {
      // Continue
      this.type = 'continue';
    } else if (status === 0xFC) {
      // Stop
      this.type = 'stop';
    } else if (status === 0xFE) {
      // Active Sensing
      this.type = 'sensing';
    } else if (status === 0xFF) {
      // System Reset
      this.type = 'reset';
    }
  }

  /**
   * Translate a MIDI status type code (0x80, 0x90, …) into the string
   * label used everywhere else in the codebase.
   *
   * @param {number} typeCode
   * @returns {string} Lowercase event name (`'noteon'`, `'cc'`, ...).
   */
  getTypeString(typeCode) {
    switch (typeCode) {
      case MidiUtils.MessageTypes.NOTE_OFF: return 'noteoff';
      case MidiUtils.MessageTypes.NOTE_ON: return 'noteon';
      case MidiUtils.MessageTypes.POLY_AFTERTOUCH: return 'poly aftertouch';
      case MidiUtils.MessageTypes.CONTROL_CHANGE: return 'cc';
      case MidiUtils.MessageTypes.PROGRAM_CHANGE: return 'program';
      case MidiUtils.MessageTypes.CHANNEL_AFTERTOUCH: return 'channel aftertouch';
      case MidiUtils.MessageTypes.PITCH_BEND: return 'pitchbend';
      case MidiUtils.MessageTypes.SYSTEM: return 'system';
      default: return 'unknown';
    }
  }

  /**
   * Serialize the message back to its raw byte form.
   *
   * @returns {number[]}
   * @throws {Error} For types that do not have a byte encoding here
   *   (e.g. `'mtc'`, `'sensing'` — these are read-only in this codebase).
   */
  toBytes() {
    const bytes = [];

    switch (this.type) {
      case 'noteoff':
        bytes.push(MidiUtils.createStatus(MidiUtils.MessageTypes.NOTE_OFF, this.channel));
        bytes.push(this.note);
        bytes.push(this.velocity);
        break;

      case 'noteon':
        bytes.push(MidiUtils.createStatus(MidiUtils.MessageTypes.NOTE_ON, this.channel));
        bytes.push(this.note);
        bytes.push(this.velocity);
        break;

      case 'poly aftertouch':
        bytes.push(MidiUtils.createStatus(MidiUtils.MessageTypes.POLY_AFTERTOUCH, this.channel));
        bytes.push(this.note);
        bytes.push(this.pressure);
        break;

      case 'cc':
        bytes.push(MidiUtils.createStatus(MidiUtils.MessageTypes.CONTROL_CHANGE, this.channel));
        bytes.push(this.controller);
        bytes.push(this.value);
        break;

      case 'program':
        bytes.push(MidiUtils.createStatus(MidiUtils.MessageTypes.PROGRAM_CHANGE, this.channel));
        bytes.push(this.program);
        break;

      case 'channel aftertouch':
        bytes.push(MidiUtils.createStatus(MidiUtils.MessageTypes.CHANNEL_AFTERTOUCH, this.channel));
        bytes.push(this.pressure);
        break;

      case 'pitchbend': {
        bytes.push(MidiUtils.createStatus(MidiUtils.MessageTypes.PITCH_BEND, this.channel));
        const encoded = MidiUtils.encode14bit(this.value + 8192);
        bytes.push(encoded.lsb);
        bytes.push(encoded.msb);
        break;
      }

      case 'sysex':
        bytes.push(0xF0);
        bytes.push(...this.data);
        bytes.push(0xF7);
        break;

      default:
        throw new Error(`Cannot convert ${this.type} to bytes`);
    }

    return bytes;
  }

  /**
   * Run range checks against the populated fields and return a
   * structured result. Mostly used by tests; the runtime parsers above
   * already enforce most constraints.
   *
   * @returns {{valid:boolean, errors:string[]}}
   */
  validate() {
    const errors = [];

    // Check channel
    if (this.channel !== undefined && !MidiUtils.isValidChannel(this.channel)) {
      errors.push(`Invalid channel: ${this.channel}`);
    }

    // Type-specific validation
    switch (this.type) {
      case 'noteon':
      case 'noteoff':
        if (!MidiUtils.isValidNote(this.note)) {
          errors.push(`Invalid note: ${this.note}`);
        }
        if (!MidiUtils.isValidDataByte(this.velocity)) {
          errors.push(`Invalid velocity: ${this.velocity}`);
        }
        break;

      case 'cc':
        if (!MidiUtils.isValidDataByte(this.controller)) {
          errors.push(`Invalid controller: ${this.controller}`);
        }
        if (!MidiUtils.isValidDataByte(this.value)) {
          errors.push(`Invalid value: ${this.value}`);
        }
        break;

      case 'program':
        if (!MidiUtils.isValidDataByte(this.program)) {
          errors.push(`Invalid program: ${this.program}`);
        }
        break;

      case 'poly aftertouch':
        if (!MidiUtils.isValidNote(this.note)) {
          errors.push(`Invalid note: ${this.note}`);
        }
        if (!MidiUtils.isValidDataByte(this.pressure)) {
          errors.push(`Invalid pressure: ${this.pressure}`);
        }
        break;

      case 'channel aftertouch':
        if (!MidiUtils.isValidDataByte(this.pressure)) {
          errors.push(`Invalid pressure: ${this.pressure}`);
        }
        break;

      case 'pitchbend':
        if (this.value < -8192 || this.value > 8191) {
          errors.push(`Invalid pitch bend value: ${this.value}`);
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /** @returns {MidiMessage} A deep-copied independent instance. */
  clone() {
    return new MidiMessage(this.toObject());
  }

  /**
   * Marshal to the plain-object form consumed by EventBus listeners.
   * Only fields relevant to `this.type` are included so subscribers can
   * deconstruct without optional-chaining everywhere.
   *
   * @returns {Object}
   */
  toObject() {
    const obj = {
      type: this.type,
      channel: this.channel,
      timestamp: this.timestamp
    };

    // Add type-specific properties
    switch (this.type) {
      case 'noteon':
      case 'noteoff':
        obj.note = this.note;
        obj.velocity = this.velocity;
        break;

      case 'cc':
        obj.controller = this.controller;
        obj.value = this.value;
        break;

      case 'program':
        obj.program = this.program;
        break;

      case 'poly aftertouch':
        obj.note = this.note;
        obj.pressure = this.pressure;
        break;

      case 'channel aftertouch':
        obj.pressure = this.pressure;
        break;

      case 'pitchbend':
        obj.value = this.value;
        break;

      case 'sysex':
        obj.data = this.data;
        break;
    }

    return obj;
  }

  /**
   * Render the message as a single human-readable line for log output
   * (e.g. `[NOTEON] ch:1 note:C4 vel:96`).
   *
   * @returns {string}
   */
  toString() {
    const parts = [`[${(this.type || 'UNKNOWN').toUpperCase()}]`];
    
    if (this.channel !== undefined) {
      parts.push(`ch:${this.channel + 1}`);
    }

    switch (this.type) {
      case 'noteon':
      case 'noteoff':
        parts.push(`note:${MidiUtils.noteNumberToName(this.note)}`);
        parts.push(`vel:${this.velocity}`);
        break;

      case 'cc':
        parts.push(`cc:${this.controller}`);
        parts.push(`val:${this.value}`);
        break;

      case 'program':
        parts.push(`prog:${this.program}`);
        parts.push(`(${MidiUtils.getGMInstrumentName(this.program)})`);
        break;

      case 'pitchbend':
        parts.push(`val:${this.value}`);
        break;
    }

    return parts.join(' ');
  }
}

export default MidiMessage;