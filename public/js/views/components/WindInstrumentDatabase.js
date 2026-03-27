// ============================================================================
// Fichier: public/js/views/components/WindInstrumentDatabase.js
// Description: Static database of wind/brass instrument presets (GM 56-79)
//   Provides note ranges, breathing capacity, articulation definitions,
//   and detection methods for wind instrument channels
// ============================================================================

class WindInstrumentDatabase {

    // ========================================================================
    // PRESETS — All 24 GM wind instruments (Brass 56-63, Reed 64-71, Pipe 72-79)
    // ========================================================================

    static PRESETS = {
        // ---- Brass (GM 56-63) ----
        56: { name: 'Trumpet',        category: 'brass', gmProgram: 56,
              rangeMin: 52, rangeMax: 84, comfortMin: 55, comfortMax: 79,
              breathCapacity: 8.0 },
        57: { name: 'Trombone',       category: 'brass', gmProgram: 57,
              rangeMin: 40, rangeMax: 72, comfortMin: 43, comfortMax: 67,
              breathCapacity: 6.0 },
        58: { name: 'Tuba',           category: 'brass', gmProgram: 58,
              rangeMin: 28, rangeMax: 58, comfortMin: 33, comfortMax: 55,
              breathCapacity: 4.0 },
        59: { name: 'Muted Trumpet',  category: 'brass', gmProgram: 59,
              rangeMin: 52, rangeMax: 82, comfortMin: 55, comfortMax: 77,
              breathCapacity: 7.0 },
        60: { name: 'French Horn',    category: 'brass', gmProgram: 60,
              rangeMin: 34, rangeMax: 77, comfortMin: 41, comfortMax: 72,
              breathCapacity: 7.0 },
        61: { name: 'Brass Section',  category: 'brass', gmProgram: 61,
              rangeMin: 40, rangeMax: 84, comfortMin: 48, comfortMax: 77,
              breathCapacity: 6.0 },
        62: { name: 'Synth Brass 1',  category: 'brass', gmProgram: 62,
              rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96,
              breathCapacity: Infinity },
        63: { name: 'Synth Brass 2',  category: 'brass', gmProgram: 63,
              rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96,
              breathCapacity: Infinity },

        // ---- Reed (GM 64-71) ----
        64: { name: 'Soprano Sax',    category: 'reed', gmProgram: 64,
              rangeMin: 56, rangeMax: 87, comfortMin: 59, comfortMax: 84,
              breathCapacity: 6.0 },
        65: { name: 'Alto Sax',       category: 'reed', gmProgram: 65,
              rangeMin: 49, rangeMax: 80, comfortMin: 52, comfortMax: 77,
              breathCapacity: 7.0 },
        66: { name: 'Tenor Sax',      category: 'reed', gmProgram: 66,
              rangeMin: 44, rangeMax: 75, comfortMin: 47, comfortMax: 72,
              breathCapacity: 7.0 },
        67: { name: 'Baritone Sax',   category: 'reed', gmProgram: 67,
              rangeMin: 36, rangeMax: 68, comfortMin: 39, comfortMax: 65,
              breathCapacity: 5.0 },
        68: { name: 'Oboe',           category: 'reed', gmProgram: 68,
              rangeMin: 58, rangeMax: 91, comfortMin: 60, comfortMax: 86,
              breathCapacity: 8.0 },
        69: { name: 'English Horn',   category: 'reed', gmProgram: 69,
              rangeMin: 52, rangeMax: 81, comfortMin: 55, comfortMax: 77,
              breathCapacity: 7.0 },
        70: { name: 'Bassoon',        category: 'reed', gmProgram: 70,
              rangeMin: 34, rangeMax: 72, comfortMin: 38, comfortMax: 67,
              breathCapacity: 6.0 },
        71: { name: 'Clarinet',       category: 'reed', gmProgram: 71,
              rangeMin: 50, rangeMax: 91, comfortMin: 52, comfortMax: 86,
              breathCapacity: 10.0 },

        // ---- Pipe (GM 72-79) ----
        72: { name: 'Piccolo',        category: 'pipe', gmProgram: 72,
              rangeMin: 74, rangeMax: 108, comfortMin: 76, comfortMax: 103,
              breathCapacity: 5.0 },
        73: { name: 'Flute',          category: 'pipe', gmProgram: 73,
              rangeMin: 60, rangeMax: 96, comfortMin: 62, comfortMax: 91,
              breathCapacity: 6.0 },
        74: { name: 'Recorder',       category: 'pipe', gmProgram: 74,
              rangeMin: 60, rangeMax: 86, comfortMin: 62, comfortMax: 84,
              breathCapacity: 5.0 },
        75: { name: 'Pan Flute',      category: 'pipe', gmProgram: 75,
              rangeMin: 60, rangeMax: 84, comfortMin: 62, comfortMax: 79,
              breathCapacity: 4.0 },
        76: { name: 'Blown Bottle',   category: 'pipe', gmProgram: 76,
              rangeMin: 60, rangeMax: 84, comfortMin: 62, comfortMax: 79,
              breathCapacity: 3.0 },
        77: { name: 'Shakuhachi',     category: 'pipe', gmProgram: 77,
              rangeMin: 55, rangeMax: 84, comfortMin: 57, comfortMax: 79,
              breathCapacity: 5.0 },
        78: { name: 'Whistle',        category: 'pipe', gmProgram: 78,
              rangeMin: 60, rangeMax: 96, comfortMin: 64, comfortMax: 91,
              breathCapacity: 4.0 },
        79: { name: 'Ocarina',        category: 'pipe', gmProgram: 79,
              rangeMin: 60, rangeMax: 84, comfortMin: 62, comfortMax: 79,
              breathCapacity: 5.0 },
    };

    // ========================================================================
    // ARTICULATION TYPES
    // ========================================================================

    static ARTICULATION_TYPES = {
        normal:   { name: 'Normal',   symbol: '',  durationFactor: 0.9,  velocityFactor: 1.0 },
        legato:   { name: 'Legato',   symbol: '\u2322', durationFactor: 1.0, velocityFactor: 1.0 },
        staccato: { name: 'Staccato', symbol: '.',  durationFactor: 0.5,  velocityFactor: 0.9 },
        accent:   { name: 'Accent',   symbol: '>',  durationFactor: 0.85, velocityFactor: 1.2 },
    };

    // ========================================================================
    // NOTE NAMES (for pitch label display)
    // ========================================================================

    static NOTE_NAMES = (typeof MidiConstants !== 'undefined') ? MidiConstants.NOTE_NAMES : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    static noteName(midiNote) {
        const octave = Math.floor(midiNote / 12) - 1;
        return `${WindInstrumentDatabase.NOTE_NAMES[midiNote % 12]}${octave}`;
    }

    // ========================================================================
    // LOOKUP METHODS
    // ========================================================================

    /**
     * Check if a GM program number is a wind instrument
     * @param {number} program - GM program number (0-127)
     * @returns {boolean}
     */
    static isWindInstrument(program) {
        return program >= 56 && program <= 79;
    }

    /**
     * Get the wind category for a GM program
     * @param {number} program - GM program number
     * @returns {string|null} 'brass' | 'reed' | 'pipe' | null
     */
    static getCategory(program) {
        if (program >= 56 && program <= 63) return 'brass';
        if (program >= 64 && program <= 71) return 'reed';
        if (program >= 72 && program <= 79) return 'pipe';
        return null;
    }

    /**
     * Get the full preset for a GM program
     * @param {number} program - GM program number
     * @returns {object|null} Preset object or null
     */
    static getPresetByProgram(program) {
        return WindInstrumentDatabase.PRESETS[program] || null;
    }

    /**
     * Get all presets for a given category
     * @param {string} category - 'brass' | 'reed' | 'pipe'
     * @returns {Array}
     */
    static getPresetsByCategory(category) {
        return Object.values(WindInstrumentDatabase.PRESETS)
            .filter(p => p.category === category);
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WindInstrumentDatabase;
}
if (typeof window !== 'undefined') {
    window.WindInstrumentDatabase = WindInstrumentDatabase;
}
