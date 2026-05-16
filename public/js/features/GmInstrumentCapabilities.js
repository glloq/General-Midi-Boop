// ============================================================================
// Fichier: public/js/features/GmInstrumentCapabilities.js
// Description: Capacités jouables par programme GM (0-127) : tessiture réelle
//   (rangeMin/rangeMax), tessiture confortable (comfortMin/comfortMax) et
//   polyphonie typique de l'instrument acoustique.
//
//   Source de vérité : shared/gm-instrument-capabilities.json. Ce fichier
//   miroir inline les données pour un chargement synchrone côté navigateur
//   (pas de fetch à l'ouverture du modal). Le backend lit le JSON
//   directement (src/midi/adaptation/InstrumentTypeConfig.js). Un test
//   Vitest garantit la synchronisation des trois sources
//   (tests/frontend/gm-instrument-capabilities-sync.test.js) : 'name' doit
//   égaler shared/gm-instrument-names.json[program] et 'polyphony' la valeur
//   backend getGmDefaultPolyphony().
//
//   Exposé via window.GmInstrumentCapabilities :
//     - CAPABILITIES : objet { [program]: {name,rangeMin,rangeMax,
//                       comfortMin,comfortMax,polyphony,monophonic} }
//     - get(gmProgram) → entrée ou null
// ============================================================================

(function() {
    'use strict';

    const CAPABILITIES = {
        0: { name: "Acoustic Grand Piano", rangeMin: 21, rangeMax: 108, comfortMin: 28, comfortMax: 96, polyphony: 16, monophonic: false },
        1: { name: "Bright Acoustic Piano", rangeMin: 21, rangeMax: 108, comfortMin: 28, comfortMax: 96, polyphony: 16, monophonic: false },
        2: { name: "Electric Grand Piano", rangeMin: 21, rangeMax: 108, comfortMin: 28, comfortMax: 96, polyphony: 16, monophonic: false },
        3: { name: "Honky-tonk Piano", rangeMin: 21, rangeMax: 108, comfortMin: 28, comfortMax: 96, polyphony: 16, monophonic: false },
        4: { name: "Electric Piano 1", rangeMin: 21, rangeMax: 108, comfortMin: 28, comfortMax: 96, polyphony: 16, monophonic: false },
        5: { name: "Electric Piano 2", rangeMin: 21, rangeMax: 108, comfortMin: 28, comfortMax: 96, polyphony: 16, monophonic: false },
        6: { name: "Harpsichord", rangeMin: 29, rangeMax: 89, comfortMin: 36, comfortMax: 84, polyphony: 8, monophonic: false },
        7: { name: "Clavinet", rangeMin: 28, rangeMax: 88, comfortMin: 36, comfortMax: 84, polyphony: 8, monophonic: false },
        8: { name: "Celesta", rangeMin: 60, rangeMax: 108, comfortMin: 60, comfortMax: 96, polyphony: 8, monophonic: false },
        9: { name: "Glockenspiel", rangeMin: 79, rangeMax: 108, comfortMin: 79, comfortMax: 105, polyphony: 4, monophonic: false },
        10: { name: "Music Box", rangeMin: 72, rangeMax: 96, comfortMin: 72, comfortMax: 96, polyphony: 4, monophonic: false },
        11: { name: "Vibraphone", rangeMin: 53, rangeMax: 89, comfortMin: 53, comfortMax: 89, polyphony: 6, monophonic: false },
        12: { name: "Marimba", rangeMin: 45, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 4, monophonic: false },
        13: { name: "Xylophone", rangeMin: 65, rangeMax: 108, comfortMin: 65, comfortMax: 105, polyphony: 4, monophonic: false },
        14: { name: "Tubular Bells", rangeMin: 60, rangeMax: 89, comfortMin: 60, comfortMax: 89, polyphony: 8, monophonic: false },
        15: { name: "Dulcimer", rangeMin: 48, rangeMax: 84, comfortMin: 50, comfortMax: 81, polyphony: 4, monophonic: false },
        16: { name: "Drawbar Organ", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 16, monophonic: false },
        17: { name: "Percussive Organ", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 16, monophonic: false },
        18: { name: "Rock Organ", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 16, monophonic: false },
        19: { name: "Church Organ", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 16, monophonic: false },
        20: { name: "Reed Organ", rangeMin: 36, rangeMax: 96, comfortMin: 41, comfortMax: 89, polyphony: 16, monophonic: false },
        21: { name: "Accordion", rangeMin: 41, rangeMax: 96, comfortMin: 48, comfortMax: 89, polyphony: 8, monophonic: false },
        22: { name: "Harmonica", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 1, monophonic: true },
        23: { name: "Tango Accordion", rangeMin: 41, rangeMax: 96, comfortMin: 48, comfortMax: 89, polyphony: 8, monophonic: false },
        24: { name: "Acoustic Guitar (nylon)", rangeMin: 40, rangeMax: 84, comfortMin: 40, comfortMax: 79, polyphony: 6, monophonic: false },
        25: { name: "Acoustic Guitar (steel)", rangeMin: 40, rangeMax: 84, comfortMin: 40, comfortMax: 79, polyphony: 6, monophonic: false },
        26: { name: "Electric Guitar (jazz)", rangeMin: 40, rangeMax: 88, comfortMin: 40, comfortMax: 84, polyphony: 6, monophonic: false },
        27: { name: "Electric Guitar (clean)", rangeMin: 40, rangeMax: 88, comfortMin: 40, comfortMax: 84, polyphony: 6, monophonic: false },
        28: { name: "Electric Guitar (muted)", rangeMin: 40, rangeMax: 88, comfortMin: 40, comfortMax: 84, polyphony: 6, monophonic: false },
        29: { name: "Overdriven Guitar", rangeMin: 40, rangeMax: 88, comfortMin: 40, comfortMax: 84, polyphony: 6, monophonic: false },
        30: { name: "Distortion Guitar", rangeMin: 40, rangeMax: 88, comfortMin: 40, comfortMax: 84, polyphony: 6, monophonic: false },
        31: { name: "Guitar Harmonics", rangeMin: 40, rangeMax: 88, comfortMin: 40, comfortMax: 84, polyphony: 6, monophonic: false },
        32: { name: "Acoustic Bass", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        33: { name: "Electric Bass (finger)", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        34: { name: "Electric Bass (pick)", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        35: { name: "Fretless Bass", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        36: { name: "Slap Bass 1", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        37: { name: "Slap Bass 2", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        38: { name: "Synth Bass 1", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        39: { name: "Synth Bass 2", rangeMin: 28, rangeMax: 67, comfortMin: 28, comfortMax: 60, polyphony: 1, monophonic: true },
        40: { name: "Violin", rangeMin: 55, rangeMax: 103, comfortMin: 55, comfortMax: 96, polyphony: 4, monophonic: false },
        41: { name: "Viola", rangeMin: 48, rangeMax: 91, comfortMin: 48, comfortMax: 84, polyphony: 4, monophonic: false },
        42: { name: "Cello", rangeMin: 36, rangeMax: 84, comfortMin: 36, comfortMax: 76, polyphony: 4, monophonic: false },
        43: { name: "Contrabass", rangeMin: 28, rangeMax: 60, comfortMin: 28, comfortMax: 55, polyphony: 4, monophonic: false },
        44: { name: "Tremolo Strings", rangeMin: 28, rangeMax: 100, comfortMin: 36, comfortMax: 91, polyphony: 8, monophonic: false },
        45: { name: "Pizzicato Strings", rangeMin: 28, rangeMax: 100, comfortMin: 36, comfortMax: 91, polyphony: 8, monophonic: false },
        46: { name: "Orchestral Harp", rangeMin: 24, rangeMax: 103, comfortMin: 24, comfortMax: 100, polyphony: 8, monophonic: false },
        47: { name: "Timpani", rangeMin: 36, rangeMax: 57, comfortMin: 38, comfortMax: 53, polyphony: 2, monophonic: false },
        48: { name: "String Ensemble 1", rangeMin: 28, rangeMax: 100, comfortMin: 36, comfortMax: 91, polyphony: 16, monophonic: false },
        49: { name: "String Ensemble 2", rangeMin: 28, rangeMax: 100, comfortMin: 36, comfortMax: 91, polyphony: 16, monophonic: false },
        50: { name: "Synth Strings 1", rangeMin: 28, rangeMax: 100, comfortMin: 36, comfortMax: 91, polyphony: 16, monophonic: false },
        51: { name: "Synth Strings 2", rangeMin: 28, rangeMax: 100, comfortMin: 36, comfortMax: 91, polyphony: 16, monophonic: false },
        52: { name: "Choir Aahs", rangeMin: 40, rangeMax: 84, comfortMin: 48, comfortMax: 79, polyphony: 16, monophonic: false },
        53: { name: "Voice Oohs", rangeMin: 40, rangeMax: 84, comfortMin: 48, comfortMax: 79, polyphony: 16, monophonic: false },
        54: { name: "Synth Voice", rangeMin: 40, rangeMax: 84, comfortMin: 48, comfortMax: 79, polyphony: 16, monophonic: false },
        55: { name: "Orchestra Hit", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        56: { name: "Trumpet", rangeMin: 52, rangeMax: 84, comfortMin: 55, comfortMax: 79, polyphony: 1, monophonic: true },
        57: { name: "Trombone", rangeMin: 40, rangeMax: 72, comfortMin: 43, comfortMax: 67, polyphony: 1, monophonic: true },
        58: { name: "Tuba", rangeMin: 28, rangeMax: 58, comfortMin: 33, comfortMax: 55, polyphony: 1, monophonic: true },
        59: { name: "Muted Trumpet", rangeMin: 52, rangeMax: 82, comfortMin: 55, comfortMax: 77, polyphony: 1, monophonic: true },
        60: { name: "French Horn", rangeMin: 34, rangeMax: 77, comfortMin: 41, comfortMax: 72, polyphony: 1, monophonic: true },
        61: { name: "Brass Section", rangeMin: 40, rangeMax: 84, comfortMin: 48, comfortMax: 77, polyphony: 8, monophonic: false },
        62: { name: "Synth Brass 1", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        63: { name: "Synth Brass 2", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        64: { name: "Soprano Sax", rangeMin: 56, rangeMax: 87, comfortMin: 59, comfortMax: 84, polyphony: 1, monophonic: true },
        65: { name: "Alto Sax", rangeMin: 49, rangeMax: 80, comfortMin: 52, comfortMax: 77, polyphony: 1, monophonic: true },
        66: { name: "Tenor Sax", rangeMin: 44, rangeMax: 75, comfortMin: 47, comfortMax: 72, polyphony: 1, monophonic: true },
        67: { name: "Baritone Sax", rangeMin: 36, rangeMax: 68, comfortMin: 39, comfortMax: 65, polyphony: 1, monophonic: true },
        68: { name: "Oboe", rangeMin: 58, rangeMax: 91, comfortMin: 60, comfortMax: 86, polyphony: 1, monophonic: true },
        69: { name: "English Horn", rangeMin: 52, rangeMax: 81, comfortMin: 55, comfortMax: 77, polyphony: 1, monophonic: true },
        70: { name: "Bassoon", rangeMin: 34, rangeMax: 72, comfortMin: 38, comfortMax: 67, polyphony: 1, monophonic: true },
        71: { name: "Clarinet", rangeMin: 50, rangeMax: 91, comfortMin: 52, comfortMax: 86, polyphony: 1, monophonic: true },
        72: { name: "Piccolo", rangeMin: 74, rangeMax: 108, comfortMin: 76, comfortMax: 103, polyphony: 1, monophonic: true },
        73: { name: "Flute", rangeMin: 60, rangeMax: 96, comfortMin: 62, comfortMax: 91, polyphony: 1, monophonic: true },
        74: { name: "Recorder", rangeMin: 60, rangeMax: 86, comfortMin: 62, comfortMax: 84, polyphony: 1, monophonic: true },
        75: { name: "Pan Flute", rangeMin: 60, rangeMax: 84, comfortMin: 62, comfortMax: 79, polyphony: 1, monophonic: true },
        76: { name: "Blown Bottle", rangeMin: 60, rangeMax: 84, comfortMin: 62, comfortMax: 79, polyphony: 1, monophonic: true },
        77: { name: "Shakuhachi", rangeMin: 55, rangeMax: 84, comfortMin: 57, comfortMax: 79, polyphony: 1, monophonic: true },
        78: { name: "Whistle", rangeMin: 60, rangeMax: 96, comfortMin: 64, comfortMax: 91, polyphony: 1, monophonic: true },
        79: { name: "Ocarina", rangeMin: 60, rangeMax: 84, comfortMin: 62, comfortMax: 79, polyphony: 1, monophonic: true },
        80: { name: "Lead 1 (square)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 1, monophonic: true },
        81: { name: "Lead 2 (sawtooth)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 1, monophonic: true },
        82: { name: "Lead 3 (calliope)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 1, monophonic: true },
        83: { name: "Lead 4 (chiff)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 1, monophonic: true },
        84: { name: "Lead 5 (charang)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 1, monophonic: true },
        85: { name: "Lead 6 (voice)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 1, monophonic: true },
        86: { name: "Lead 7 (fifths)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 2, monophonic: false },
        87: { name: "Lead 8 (bass + lead)", rangeMin: 36, rangeMax: 96, comfortMin: 48, comfortMax: 91, polyphony: 2, monophonic: false },
        88: { name: "Pad 1 (new age)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        89: { name: "Pad 2 (warm)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        90: { name: "Pad 3 (polysynth)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        91: { name: "Pad 4 (choir)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        92: { name: "Pad 5 (bowed)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        93: { name: "Pad 6 (metallic)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        94: { name: "Pad 7 (halo)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        95: { name: "Pad 8 (sweep)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 8, monophonic: false },
        96: { name: "FX 1 (rain)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        97: { name: "FX 2 (soundtrack)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        98: { name: "FX 3 (crystal)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        99: { name: "FX 4 (atmosphere)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        100: { name: "FX 5 (brightness)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        101: { name: "FX 6 (goblins)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        102: { name: "FX 7 (echoes)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        103: { name: "FX 8 (sci-fi)", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 4, monophonic: false },
        104: { name: "Sitar", rangeMin: 48, rangeMax: 84, comfortMin: 48, comfortMax: 79, polyphony: 4, monophonic: false },
        105: { name: "Banjo", rangeMin: 50, rangeMax: 86, comfortMin: 50, comfortMax: 81, polyphony: 6, monophonic: false },
        106: { name: "Shamisen", rangeMin: 50, rangeMax: 84, comfortMin: 50, comfortMax: 79, polyphony: 4, monophonic: false },
        107: { name: "Koto", rangeMin: 43, rangeMax: 84, comfortMin: 43, comfortMax: 79, polyphony: 4, monophonic: false },
        108: { name: "Kalimba", rangeMin: 53, rangeMax: 84, comfortMin: 55, comfortMax: 79, polyphony: 4, monophonic: false },
        109: { name: "Bagpipe", rangeMin: 62, rangeMax: 86, comfortMin: 62, comfortMax: 81, polyphony: 1, monophonic: true },
        110: { name: "Fiddle", rangeMin: 55, rangeMax: 103, comfortMin: 55, comfortMax: 96, polyphony: 4, monophonic: false },
        111: { name: "Shanai", rangeMin: 62, rangeMax: 86, comfortMin: 64, comfortMax: 81, polyphony: 1, monophonic: true },
        112: { name: "Tinkle Bell", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 4, monophonic: false },
        113: { name: "Agogo", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 4, monophonic: false },
        114: { name: "Steel Drums", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 2, monophonic: false },
        115: { name: "Woodblock", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 2, monophonic: false },
        116: { name: "Taiko Drum", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 4, monophonic: false },
        117: { name: "Melodic Tom", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 4, monophonic: false },
        118: { name: "Synth Drum", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 4, monophonic: false },
        119: { name: "Reverse Cymbal", rangeMin: 48, rangeMax: 96, comfortMin: 53, comfortMax: 89, polyphony: 4, monophonic: false },
        120: { name: "Guitar Fret Noise", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        121: { name: "Breath Noise", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        122: { name: "Seashore", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        123: { name: "Bird Tweet", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        124: { name: "Telephone Ring", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        125: { name: "Helicopter", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        126: { name: "Applause", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
        127: { name: "Gunshot", rangeMin: 36, rangeMax: 96, comfortMin: 36, comfortMax: 96, polyphony: 1, monophonic: true },
    };

    /**
     * Capability entry for a GM program, or null when out of range / unknown.
     * @param {number} gmProgram - GM program number (0-127)
     * @returns {?{name:string,rangeMin:number,rangeMax:number,comfortMin:number,comfortMax:number,polyphony:number,monophonic:boolean}}
     */
    function get(gmProgram) {
        if (!Number.isFinite(gmProgram)) return null;
        return CAPABILITIES[gmProgram] || null;
    }

    const api = { CAPABILITIES: CAPABILITIES, get: get };

    if (typeof window !== 'undefined') window.GmInstrumentCapabilities = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
