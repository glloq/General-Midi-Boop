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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIDI_STATUS, MIDI_CC, MIDI_NOTE } from '../core/constants.js';

// Canonical GM 1 instrument names live in `shared/gm-instrument-names.json`
// so the same list is consumable by the frontend i18n layer (en.json
// `instruments.list`) and any other tooling. Loaded synchronously once
// at module init — the file is tiny (~3 KB) and never changes at runtime.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GM_INSTRUMENT_NAMES = Object.freeze(
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../shared/gm-instrument-names.json'),
      'utf8'
    )
  )
);

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
   * Get GM 1 instrument name for a program number (0-127). Names come
   * from `shared/gm-instrument-names.json` — see the module-level
   * import. Out-of-range numbers fall back to `Program <n>`.
   *
   * @param {number} program - Program number (0-127)
   * @returns {string} Instrument name
   */
  static getGMInstrumentName(program) {
    return GM_INSTRUMENT_NAMES[program] || `Program ${program}`;
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
   * GM 1 program categories — sixteen consecutive 8-program blocks
   * (indices match `Math.floor(program / 8)`). The display labels and
   * the slug keys live side-by-side so consumers can pick whichever
   * shape they need:
   *   - {@link GMCategories} — human-readable labels for UI / logs.
   *   - {@link GM_CATEGORY_SLUGS} — snake_case keys used by the matcher
   *     (`piano`, `chromatic`, `synth_lead`, …).
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

  static GM_CATEGORY_SLUGS = [
    'piano', 'chromatic', 'organ', 'guitar',
    'bass', 'strings', 'ensemble', 'brass',
    'reed', 'pipe', 'synth_lead', 'synth_pad',
    'synth_effects', 'ethnic', 'percussive', 'sound_effects',
  ];

  /**
   * Get GM category display label for a program number.
   * @param {number} program - Program number (0-127)
   * @returns {string} Category name (`"Piano"`, `"Chromatic Percussion"`…)
   */
  static getGMCategory(program) {
    if (program < 0 || program > 127) return 'Unknown';
    return this.GMCategories[Math.floor(program / 8)];
  }

  /**
   * Get GM category slug for a program number (snake_case, matches
   * {@link GM_CATEGORY_SLUGS}). Used by the matcher to compare
   * channel/instrument categories without string-matching display
   * names.
   * @param {number} program - Program number (0-127)
   * @returns {string|null} Slug, or null when out of range.
   */
  static getGMCategorySlug(program) {
    if (program < 0 || program > 127) return null;
    return this.GM_CATEGORY_SLUGS[Math.floor(program / 8)];
  }

}

export default MidiUtils;