/**
 * @file src/utils/MidiUtils.js
 * @description MIDI message helpers shared by the router, player,
 * adapters and command handlers. Pure functions / static methods grouped
 * on the {@link MidiUtils} class.
 *
 * Static fields re-export the canonical constants from `src/constants.js`
 * (`MessageTypes`, `CC`, `NoteNames`) for backwards compatibility with
 * older call sites that still reach for them via this module.
 */
import { MIDI_STATUS, MIDI_CC, MIDI_NOTE } from '../core/constants.js';

/**
 * Static utility class — all members are static. Not meant to be
 * instantiated; import and use as `MidiUtils.foo(...)`.
 */
class MidiUtils {
  /**
   * MIDI message type constants
   * Re-exported from constants.js for backward compatibility
   */
  static MessageTypes = MIDI_STATUS;

  /**
   * Common MIDI CC numbers
   * Re-exported from constants.js for backward compatibility
   */
  static CC = MIDI_CC;

  /**
   * Note names
   */
  static NoteNames = MIDI_NOTE.NOTE_NAMES;

  /**
   * Parse status byte into message type and channel
   * @param {number} status - MIDI status byte
   * @returns {object} {type: number, channel: number}
   */
  static parseStatus(status) {
    return {
      type: status & 0xF0,
      channel: status & 0x0F
    };
  }

  /**
   * Create status byte from type and channel
   * @param {number} type - Message type (0x80-0xE0)
   * @param {number} channel - MIDI channel (0-15)
   * @returns {number} Status byte
   */
  static createStatus(type, channel) {
    return (type & 0xF0) | (channel & 0x0F);
  }

  /**
   * Convert note number to note name
   * @param {number} note - MIDI note number (0-127)
   * @returns {string} Note name with octave (e.g., "C4")
   */
  static noteNumberToName(note) {
    const octave = Math.floor(note / 12) - 1;
    const noteName = this.NoteNames[note % 12];
    return `${noteName}${octave}`;
  }

  /**
   * Check if value is valid MIDI data byte (0-127)
   * @param {number} value - Value to check
   * @returns {boolean} True if valid
   */
  static isValidDataByte(value) {
    return Number.isInteger(value) && value >= 0 && value <= 127;
  }

  /**
   * Check if value is valid MIDI channel (0-15)
   * @param {number} channel - Channel to check
   * @returns {boolean} True if valid
   */
  static isValidChannel(channel) {
    return Number.isInteger(channel) && channel >= 0 && channel <= 15;
  }

  /**
   * Check if value is valid MIDI note number (0-127)
   * @param {number} note - Note number to check
   * @returns {boolean} True if valid
   */
  static isValidNote(note) {
    return this.isValidDataByte(note);
  }

  /**
   * Decode 14-bit value from MSB and LSB
   * @param {number} msb - Most significant byte (0-127)
   * @param {number} lsb - Least significant byte (0-127)
   * @returns {number} 14-bit value (0-16383)
   */
  static decode14bit(msb, lsb) {
    return (msb << 7) | lsb;
  }

  /**
   * Encode 14-bit value to MSB and LSB
   * @param {number} value - 14-bit value (0-16383)
   * @returns {object} {msb: number, lsb: number}
   */
  static encode14bit(value) {
    return {
      msb: (value >> 7) & 0x7F,
      lsb: value & 0x7F
    };
  }

  /**
   * Get GM instrument name
   * @param {number} program - Program number (0-127)
   * @returns {string} Instrument name
   */
  static getGMInstrumentName(program) {
    const instruments = [
      // Piano (0-7)
      'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
      'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
      // Chromatic Percussion (8-15)
      'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
      'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
      // Organ (16-23)
      'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
      'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
      // Guitar (24-31)
      'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
      'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
      // Bass (32-39)
      'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
      'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
      // Strings (40-47)
      'Violin', 'Viola', 'Cello', 'Contrabass',
      'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
      // Ensemble (48-55)
      'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
      'Choir Aahs', 'Voice Oohs', 'Synth Choir', 'Orchestra Hit',
      // Brass (56-63)
      'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
      'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
      // Reed (64-71)
      'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
      'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
      // Pipe (72-79)
      'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
      'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
      // Synth Lead (80-87)
      'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
      'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
      // Synth Pad (88-95)
      'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
      'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
      // Synth Effects (96-103)
      'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
      'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
      // Ethnic (104-111)
      'Sitar', 'Banjo', 'Shamisen', 'Koto',
      'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
      // Percussive (112-119)
      'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
      'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
      // Sound Effects (120-127)
      'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
      'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'
    ];

    return instruments[program] || `Program ${program}`;
  }

  /**
   * Convert easymidi-format message to raw MIDI bytes
   * Shared utility used by all transport managers (Bluetooth, Network, Serial)
   * @param {string} type - Message type (noteon, noteoff, cc, program, etc.)
   * @param {object} data - Message data with channel, note, velocity, etc.
   * @returns {Array<number>|null} Raw MIDI bytes or null for unknown types
   */
  static convertToMidiBytes(type, data) {
    const channel = data.channel ?? 0;

    switch (type.toLowerCase()) {
      case 'noteon':
        return [0x90 | channel, data.note & 0x7F, (data.velocity ?? 127) & 0x7F];
      case 'noteoff':
        return [0x80 | channel, data.note & 0x7F, (data.velocity ?? 0) & 0x7F];
      case 'cc':
      case 'controlchange':
        return [0xB0 | channel, data.controller & 0x7F, data.value & 0x7F];
      case 'program':
      case 'programchange':
        return [0xC0 | channel, (data.program ?? data.number ?? 0) & 0x7F];
      case 'channel aftertouch':
      case 'channelaftertouch':
        return [0xD0 | channel, data.pressure & 0x7F];
      case 'poly aftertouch':
      case 'polyaftertouch':
        return [0xA0 | channel, data.note & 0x7F, data.pressure & 0x7F];
      case 'pitchbend': {
        // Accept both centered (-8192..8191) and raw 14-bit (0..16383) formats
        let raw = data.value ?? 8192;
        if (raw < 0) raw += 8192; // Convert centered format to raw 14-bit
        return [0xE0 | channel, raw & 0x7F, (raw >> 7) & 0x7F];
      }
      case 'sysex':
        return Array.isArray(data) ? data : (data.bytes || []);
      // System Realtime messages (no data bytes)
      case 'clock':
        return [0xF8];
      case 'start':
        return [0xFA];
      case 'continue':
        return [0xFB];
      case 'stop':
        return [0xFC];
      case 'reset':
        return [0xFF];
      default:
        return null;
    }
  }

  /**
   * GM instrument categories by program range
   */
  static GMCategories = [
    'Piano',              // 0-7
    'Chromatic Percussion', // 8-15
    'Organ',              // 16-23
    'Guitar',             // 24-31
    'Bass',               // 32-39
    'Strings',            // 40-47
    'Ensemble',           // 48-55
    'Brass',              // 56-63
    'Reed',               // 64-71
    'Pipe',               // 72-79
    'Synth Lead',         // 80-87
    'Synth Pad',          // 88-95
    'Synth Effects',      // 96-103
    'Ethnic',             // 104-111
    'Percussive',         // 112-119
    'Sound Effects'       // 120-127
  ];

  /**
   * Get GM category for a program number
   * @param {number} program - Program number (0-127)
   * @returns {string} Category name
   */
  static getGMCategory(program) {
    if (program < 0 || program > 127) return 'Unknown';
    return this.GMCategories[Math.floor(program / 8)];
  }

}

export default MidiUtils;