// src/utils/MidiUtils.js

class MidiUtils {
  /**
   * MIDI message type constants
   */
  static MessageTypes = {
    NOTE_OFF: 0x80,
    NOTE_ON: 0x90,
    POLY_AFTERTOUCH: 0xA0,
    CONTROL_CHANGE: 0xB0,
    PROGRAM_CHANGE: 0xC0,
    CHANNEL_AFTERTOUCH: 0xD0,
    PITCH_BEND: 0xE0,
    SYSTEM: 0xF0
  };

  /**
   * Common MIDI CC numbers
   */
  static CC = {
    BANK_SELECT: 0,
    MODULATION: 1,
    BREATH_CONTROLLER: 2,
    FOOT_CONTROLLER: 4,
    PORTAMENTO_TIME: 5,
    DATA_ENTRY_MSB: 6,
    VOLUME: 7,
    BALANCE: 8,
    PAN: 10,
    EXPRESSION: 11,
    SUSTAIN_PEDAL: 64,
    PORTAMENTO: 65,
    SOSTENUTO: 66,
    SOFT_PEDAL: 67,
    LEGATO: 68,
    HOLD_2: 69,
    SOUND_CONTROLLER_1: 70,
    SOUND_CONTROLLER_2: 71,
    SOUND_CONTROLLER_3: 72,
    SOUND_CONTROLLER_4: 73,
    SOUND_CONTROLLER_5: 74,
    SOUND_CONTROLLER_6: 75,
    SOUND_CONTROLLER_7: 76,
    SOUND_CONTROLLER_8: 77,
    SOUND_CONTROLLER_9: 78,
    SOUND_CONTROLLER_10: 79,
    PORTAMENTO_CONTROL: 84,
    EFFECTS_1_DEPTH: 91,
    EFFECTS_2_DEPTH: 92,
    EFFECTS_3_DEPTH: 93,
    EFFECTS_4_DEPTH: 94,
    EFFECTS_5_DEPTH: 95,
    ALL_SOUND_OFF: 120,
    RESET_ALL_CONTROLLERS: 121,
    LOCAL_CONTROL: 122,
    ALL_NOTES_OFF: 123,
    OMNI_MODE_OFF: 124,
    OMNI_MODE_ON: 125,
    MONO_MODE_ON: 126,
    POLY_MODE_ON: 127
  };

  /**
   * Note names
   */
  static NoteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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
   * Convert note name to note number
   * @param {string} name - Note name (e.g., "C4", "F#5")
   * @returns {number} MIDI note number
   */
  static noteNameToNumber(name) {
    const match = name.match(/^([A-G]#?)(-?\d+)$/);
    if (!match) {
      throw new Error(`Invalid note name: ${name}`);
    }

    const noteName = match[1];
    const octave = parseInt(match[2]);
    const noteIndex = this.NoteNames.indexOf(noteName);

    if (noteIndex === -1) {
      throw new Error(`Invalid note name: ${noteName}`);
    }

    return (octave + 1) * 12 + noteIndex;
  }

  /**
   * Convert note number to frequency in Hz
   * @param {number} note - MIDI note number
   * @returns {number} Frequency in Hz
   */
  static noteToFrequency(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  /**
   * Convert frequency to nearest note number
   * @param {number} frequency - Frequency in Hz
   * @returns {number} MIDI note number
   */
  static frequencyToNote(frequency) {
    if (!frequency || frequency <= 0) return 0;
    return Math.round(69 + 12 * Math.log2(frequency / 440));
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
   * Clamp value to MIDI data byte range (0-127)
   * @param {number} value - Value to clamp
   * @returns {number} Clamped value
   */
  static clampDataByte(value) {
    return Math.max(0, Math.min(127, Math.round(value)));
  }

  /**
   * Clamp value to MIDI channel range (0-15)
   * @param {number} channel - Channel to clamp
   * @returns {number} Clamped channel
   */
  static clampChannel(channel) {
    return Math.max(0, Math.min(15, Math.round(channel)));
  }

  /**
   * Scale value from 0-127 to custom range
   * @param {number} value - MIDI value (0-127)
   * @param {number} min - Minimum output value
   * @param {number} max - Maximum output value
   * @returns {number} Scaled value
   */
  static scaleValue(value, min, max) {
    return min + (value / 127) * (max - min);
  }

  /**
   * Scale value from custom range to 0-127
   * @param {number} value - Input value
   * @param {number} min - Minimum input value
   * @param {number} max - Maximum input value
   * @returns {number} MIDI value (0-127)
   */
  static unscaleValue(value, min, max) {
    const normalized = (value - min) / (max - min);
    return this.clampDataByte(Math.round(normalized * 127));
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
   * Convert pitch bend value to semitones
   * @param {number} value - Pitch bend value (-8192 to 8191)
   * @param {number} range - Pitch bend range in semitones (default: 2)
   * @returns {number} Pitch bend in semitones
   */
  static pitchBendToSemitones(value, range = 2) {
    return (value / 8192) * range;
  }

  /**
   * Convert semitones to pitch bend value
   * @param {number} semitones - Pitch bend in semitones
   * @param {number} range - Pitch bend range in semitones (default: 2)
   * @returns {number} Pitch bend value (-8192 to 8191)
   */
  static semitonesToPitchBend(semitones, range = 2) {
    return Math.round((semitones / range) * 8192);
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
   * Create a Note On message object
   * @param {number} channel - MIDI channel (0-15)
   * @param {number} note - Note number (0-127)
   * @param {number} velocity - Velocity (0-127)
   * @returns {object} Message object
   */
  static createNoteOn(channel, note, velocity) {
    return {
      type: 'noteon',
      channel: this.clampChannel(channel),
      note: this.clampDataByte(note),
      velocity: this.clampDataByte(velocity)
    };
  }

  /**
   * Create a Note Off message object
   * @param {number} channel - MIDI channel (0-15)
   * @param {number} note - Note number (0-127)
   * @param {number} velocity - Velocity (0-127)
   * @returns {object} Message object
   */
  static createNoteOff(channel, note, velocity = 0) {
    return {
      type: 'noteoff',
      channel: this.clampChannel(channel),
      note: this.clampDataByte(note),
      velocity: this.clampDataByte(velocity)
    };
  }

  /**
   * Create a Control Change message object
   * @param {number} channel - MIDI channel (0-15)
   * @param {number} controller - Controller number (0-127)
   * @param {number} value - Controller value (0-127)
   * @returns {object} Message object
   */
  static createCC(channel, controller, value) {
    return {
      type: 'cc',
      channel: this.clampChannel(channel),
      controller: this.clampDataByte(controller),
      value: this.clampDataByte(value)
    };
  }

  /**
   * Create a Program Change message object
   * @param {number} channel - MIDI channel (0-15)
   * @param {number} program - Program number (0-127)
   * @returns {object} Message object
   */
  static createProgramChange(channel, program) {
    return {
      type: 'program',
      channel: this.clampChannel(channel),
      program: this.clampDataByte(program),
      number: this.clampDataByte(program) // backward compat alias
    };
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

  /**
   * Get all GM categories
   * @returns {Array<string>} List of all GM categories
   */
  static getGMCategories() {
    return [...this.GMCategories];
  }

  /**
   * Get all GM instruments in a category
   * @param {string} category - Category name
   * @returns {Array<{program: number, name: string}>}
   */
  static getGMInstrumentsByCategory(category) {
    const categoryIndex = this.GMCategories.indexOf(category);
    if (categoryIndex === -1) return [];

    const startProgram = categoryIndex * 8;
    const instruments = [];
    for (let i = 0; i < 8; i++) {
      const program = startProgram + i;
      instruments.push({
        program,
        name: this.getGMInstrumentName(program)
      });
    }
    return instruments;
  }
}

export default MidiUtils;