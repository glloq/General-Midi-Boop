/**
 * @file src/midi/InstrumentTypeConfig.js
 * @description Static instrument-type hierarchy aligned with the General
 * MIDI standard. Each top-level category exposes:
 *   - `label`        — UI-visible category name (kept as-is, French in the
 *                      current copy because it is rendered in the user's
 *                      locale and persisted alongside other settings).
 *   - `gmPrograms`   — GM program numbers (0-127) that fall under it.
 *   - `subtypes`     — finer-grained breakdown also keyed to GM programs.
 *
 * Consumers:
 *   - Instrument-settings UI (mandatory category selector).
 *   - {@link InstrumentMatcher} for category-aware scoring.
 *   - {@link InstrumentTypeConfig.detectTypeFromProgram} for GM-program
 *     reverse lookup.
 */

const INSTRUMENT_TYPE_HIERARCHY = {
  piano: {
    label: 'Piano',
    gmPrograms: [0, 1, 2, 3, 4, 5, 6, 7],
    subtypes: {
      acoustic_grand: { label: 'Piano à queue', gmPrograms: [0] },
      bright_acoustic: { label: 'Piano brillant', gmPrograms: [1] },
      electric_grand: { label: 'Piano électrique grand', gmPrograms: [2] },
      honky_tonk: { label: 'Honky-tonk', gmPrograms: [3] },
      electric_piano_1: { label: 'Piano électrique 1', gmPrograms: [4] },
      electric_piano_2: { label: 'Piano électrique 2', gmPrograms: [5] },
      harpsichord: { label: 'Clavecin', gmPrograms: [6] },
      clavinet: { label: 'Clavinet', gmPrograms: [7] }
    }
  },
  chromatic_percussion: {
    label: 'Percussion chromatique',
    gmPrograms: [8, 9, 10, 11, 12, 13, 14, 15],
    subtypes: {
      celesta: { label: 'Célesta', gmPrograms: [8] },
      glockenspiel: { label: 'Glockenspiel', gmPrograms: [9] },
      music_box: { label: 'Boîte à musique', gmPrograms: [10] },
      vibraphone: { label: 'Vibraphone', gmPrograms: [11] },
      marimba: { label: 'Marimba', gmPrograms: [12] },
      xylophone: { label: 'Xylophone', gmPrograms: [13] },
      tubular_bells: { label: 'Cloches tubulaires', gmPrograms: [14] },
      dulcimer: { label: 'Dulcimer', gmPrograms: [15] }
    }
  },
  organ: {
    label: 'Orgue',
    gmPrograms: [16, 17, 18, 19, 20, 21, 22, 23],
    subtypes: {
      drawbar: { label: 'Orgue à tirettes', gmPrograms: [16] },
      percussive_organ: { label: 'Orgue percussif', gmPrograms: [17] },
      rock_organ: { label: 'Orgue rock', gmPrograms: [18] },
      church_organ: { label: 'Orgue d\'église', gmPrograms: [19] },
      reed_organ: { label: 'Orgue à anches', gmPrograms: [20] },
      accordion: { label: 'Accordéon', gmPrograms: [21] },
      harmonica: { label: 'Harmonica', gmPrograms: [22] },
      tango_accordion: { label: 'Bandonéon', gmPrograms: [23] }
    }
  },
  guitar: {
    label: 'Guitare',
    gmPrograms: [24, 25, 26, 27, 28, 29, 30, 31],
    subtypes: {
      nylon: { label: 'Guitare classique (nylon)', gmPrograms: [24] },
      steel: { label: 'Guitare folk (acier)', gmPrograms: [25] },
      jazz: { label: 'Guitare jazz', gmPrograms: [26] },
      clean: { label: 'Guitare clean', gmPrograms: [27] },
      muted: { label: 'Guitare muted', gmPrograms: [28] },
      overdrive: { label: 'Guitare overdrive', gmPrograms: [29] },
      distortion: { label: 'Guitare distortion', gmPrograms: [30] },
      harmonics: { label: 'Guitare harmoniques', gmPrograms: [31] }
    }
  },
  bass: {
    label: 'Basse',
    gmPrograms: [32, 33, 34, 35, 36, 37, 38, 39],
    subtypes: {
      acoustic: { label: 'Contrebasse', gmPrograms: [32] },
      finger: { label: 'Basse finger', gmPrograms: [33] },
      pick: { label: 'Basse pick', gmPrograms: [34] },
      fretless: { label: 'Basse fretless', gmPrograms: [35] },
      slap_1: { label: 'Basse slap 1', gmPrograms: [36] },
      slap_2: { label: 'Basse slap 2', gmPrograms: [37] },
      synth_bass_1: { label: 'Synth bass 1', gmPrograms: [38] },
      synth_bass_2: { label: 'Synth bass 2', gmPrograms: [39] }
    }
  },
  strings: {
    label: 'Cordes',
    gmPrograms: [40, 41, 42, 43, 44, 45, 46, 47],
    subtypes: {
      violin: { label: 'Violon', gmPrograms: [40] },
      viola: { label: 'Alto', gmPrograms: [41] },
      cello: { label: 'Violoncelle', gmPrograms: [42] },
      contrabass: { label: 'Contrebasse à cordes', gmPrograms: [43] },
      tremolo: { label: 'Cordes trémolo', gmPrograms: [44] },
      pizzicato: { label: 'Cordes pizzicato', gmPrograms: [45] },
      harp: { label: 'Harpe', gmPrograms: [46] },
      timpani: { label: 'Timbales', gmPrograms: [47] }
    }
  },
  ensemble: {
    label: 'Ensemble',
    gmPrograms: [48, 49, 50, 51, 52, 53, 54, 55],
    subtypes: {
      string_ensemble_1: { label: 'Ensemble cordes 1', gmPrograms: [48] },
      string_ensemble_2: { label: 'Ensemble cordes 2', gmPrograms: [49] },
      synth_strings_1: { label: 'Synth strings 1', gmPrograms: [50] },
      synth_strings_2: { label: 'Synth strings 2', gmPrograms: [51] },
      choir_aahs: { label: 'Chœur Aahs', gmPrograms: [52] },
      voice_oohs: { label: 'Voix Oohs', gmPrograms: [53] },
      synth_voice: { label: 'Voix synth', gmPrograms: [54] },
      orchestra_hit: { label: 'Hit orchestral', gmPrograms: [55] }
    }
  },
  brass: {
    label: 'Cuivres',
    gmPrograms: [56, 57, 58, 59, 60, 61, 62, 63],
    subtypes: {
      trumpet: { label: 'Trompette', gmPrograms: [56] },
      trombone: { label: 'Trombone', gmPrograms: [57] },
      tuba: { label: 'Tuba', gmPrograms: [58] },
      muted_trumpet: { label: 'Trompette en sourdine', gmPrograms: [59] },
      french_horn: { label: 'Cor', gmPrograms: [60] },
      brass_section: { label: 'Section cuivres', gmPrograms: [61] },
      synth_brass_1: { label: 'Synth brass 1', gmPrograms: [62] },
      synth_brass_2: { label: 'Synth brass 2', gmPrograms: [63] }
    }
  },
  reed: {
    label: 'Anches',
    gmPrograms: [64, 65, 66, 67, 68, 69, 70, 71],
    subtypes: {
      soprano_sax: { label: 'Sax soprano', gmPrograms: [64] },
      alto_sax: { label: 'Sax alto', gmPrograms: [65] },
      tenor_sax: { label: 'Sax ténor', gmPrograms: [66] },
      baritone_sax: { label: 'Sax baryton', gmPrograms: [67] },
      oboe: { label: 'Hautbois', gmPrograms: [68] },
      english_horn: { label: 'Cor anglais', gmPrograms: [69] },
      bassoon: { label: 'Basson', gmPrograms: [70] },
      clarinet: { label: 'Clarinette', gmPrograms: [71] }
    }
  },
  pipe: {
    label: 'Bois / Flûtes',
    gmPrograms: [72, 73, 74, 75, 76, 77, 78, 79],
    subtypes: {
      piccolo: { label: 'Piccolo', gmPrograms: [72] },
      flute: { label: 'Flûte traversière', gmPrograms: [73] },
      recorder: { label: 'Flûte à bec', gmPrograms: [74] },
      pan_flute: { label: 'Flûte de Pan', gmPrograms: [75] },
      bottle: { label: 'Bouteille soufflée', gmPrograms: [76] },
      shakuhachi: { label: 'Shakuhachi', gmPrograms: [77] },
      whistle: { label: 'Sifflet', gmPrograms: [78] },
      ocarina: { label: 'Ocarina', gmPrograms: [79] }
    }
  },
  synth_lead: {
    label: 'Synth Lead',
    gmPrograms: [80, 81, 82, 83, 84, 85, 86, 87],
    subtypes: {
      square: { label: 'Lead carré', gmPrograms: [80] },
      sawtooth: { label: 'Lead dents de scie', gmPrograms: [81] },
      calliope: { label: 'Lead calliope', gmPrograms: [82] },
      chiff: { label: 'Lead chiff', gmPrograms: [83] },
      charang: { label: 'Lead charang', gmPrograms: [84] },
      voice_lead: { label: 'Lead voix', gmPrograms: [85] },
      fifths: { label: 'Lead quintes', gmPrograms: [86] },
      bass_lead: { label: 'Lead + basse', gmPrograms: [87] }
    }
  },
  synth_pad: {
    label: 'Synth Pad',
    gmPrograms: [88, 89, 90, 91, 92, 93, 94, 95],
    subtypes: {
      new_age: { label: 'Pad new age', gmPrograms: [88] },
      warm: { label: 'Pad warm', gmPrograms: [89] },
      polysynth: { label: 'Pad polysynth', gmPrograms: [90] },
      choir: { label: 'Pad chœur', gmPrograms: [91] },
      bowed: { label: 'Pad bowed', gmPrograms: [92] },
      metallic: { label: 'Pad métallique', gmPrograms: [93] },
      halo: { label: 'Pad halo', gmPrograms: [94] },
      sweep: { label: 'Pad sweep', gmPrograms: [95] }
    }
  },
  synth_effects: {
    label: 'Effets Synth',
    gmPrograms: [96, 97, 98, 99, 100, 101, 102, 103],
    subtypes: {
      rain: { label: 'FX pluie', gmPrograms: [96] },
      soundtrack: { label: 'FX soundtrack', gmPrograms: [97] },
      crystal: { label: 'FX crystal', gmPrograms: [98] },
      atmosphere: { label: 'FX atmosphère', gmPrograms: [99] },
      brightness: { label: 'FX brightness', gmPrograms: [100] },
      goblins: { label: 'FX goblins', gmPrograms: [101] },
      echoes: { label: 'FX echoes', gmPrograms: [102] },
      sci_fi: { label: 'FX sci-fi', gmPrograms: [103] }
    }
  },
  ethnic: {
    label: 'Ethnique',
    gmPrograms: [104, 105, 106, 107, 108, 109, 110, 111],
    subtypes: {
      sitar: { label: 'Sitar', gmPrograms: [104] },
      banjo: { label: 'Banjo', gmPrograms: [105] },
      shamisen: { label: 'Shamisen', gmPrograms: [106] },
      koto: { label: 'Koto', gmPrograms: [107] },
      kalimba: { label: 'Kalimba', gmPrograms: [108] },
      bagpipe: { label: 'Cornemuse', gmPrograms: [109] },
      fiddle: { label: 'Fiddle', gmPrograms: [110] },
      shanai: { label: 'Shanai', gmPrograms: [111] }
    }
  },
  drums: {
    label: 'Batterie / Percussion',
    gmPrograms: [112, 113, 114, 115, 116, 117, 118, 119],
    subtypes: {
      tinkle_bell: { label: 'Clochette', gmPrograms: [112] },
      agogo: { label: 'Agogo', gmPrograms: [113] },
      steel_drums: { label: 'Steel drums', gmPrograms: [114] },
      woodblock: { label: 'Woodblock', gmPrograms: [115] },
      taiko: { label: 'Taiko', gmPrograms: [116] },
      melodic_tom: { label: 'Tom mélodique', gmPrograms: [117] },
      synth_drum: { label: 'Synth drum', gmPrograms: [118] },
      reverse_cymbal: { label: 'Cymbale inversée', gmPrograms: [119] },
      // Special subtypes for drum kits (channel 10)
      standard_kit: { label: 'Kit standard', gmPrograms: [] },
      jazz_kit: { label: 'Kit jazz', gmPrograms: [] },
      electronic_kit: { label: 'Kit électronique', gmPrograms: [] },
      brush_kit: { label: 'Kit brosses', gmPrograms: [] },
      orchestra_kit: { label: 'Kit orchestral', gmPrograms: [] }
    }
  },
  sound_effects: {
    label: 'Effets sonores',
    gmPrograms: [120, 121, 122, 123, 124, 125, 126, 127],
    subtypes: {
      guitar_fret: { label: 'Fret noise', gmPrograms: [120] },
      breath: { label: 'Souffle', gmPrograms: [121] },
      seashore: { label: 'Mer', gmPrograms: [122] },
      bird: { label: 'Oiseau', gmPrograms: [123] },
      telephone: { label: 'Téléphone', gmPrograms: [124] },
      helicopter: { label: 'Hélicoptère', gmPrograms: [125] },
      applause: { label: 'Applaudissements', gmPrograms: [126] },
      gunshot: { label: 'Coup de feu', gmPrograms: [127] }
    }
  }
};

/**
 * Related type families (for cross-type scoring)
 */
const TYPE_FAMILIES = {
  keyboards: ['piano', 'organ', 'chromatic_percussion'],
  strings_family: ['strings', 'ensemble'],
  winds: ['brass', 'reed', 'pipe'],
  synths: ['synth_lead', 'synth_pad', 'synth_effects'],
  percussion: ['drums', 'chromatic_percussion']
};

/**
 * Default polyphony for GM instruments (0-127).
 * Represents the typical polyphony of the real acoustic instrument.
 * Used as a fallback when the routed instrument has no defined value.
 */
const GM_DEFAULT_POLYPHONY = {
  // Piano (0-7) — polyphonic, long sustain
  0: 16, 1: 16, 2: 16, 3: 16, 4: 16, 5: 16, 6: 8, 7: 8,
  // Chromatic Percussion (8-15) — varies
  8: 8, 9: 4, 10: 4, 11: 6, 12: 4, 13: 4, 14: 8, 15: 4,
  // Organ (16-23) — polyphonic
  16: 16, 17: 16, 18: 16, 19: 16, 20: 16, 21: 8, 22: 1, 23: 8,
  // Guitar (24-31) — 6 strings
  24: 6, 25: 6, 26: 6, 27: 6, 28: 6, 29: 6, 30: 6, 31: 6,
  // Bass (32-39) — monophonic / 4 strings
  32: 1, 33: 1, 34: 1, 35: 1, 36: 1, 37: 1, 38: 1, 39: 1,
  // Strings solo (40-43) — polyphony limited by strings
  40: 4, 41: 4, 42: 4, 43: 4,
  // Strings orchestral (44-47) — varies
  44: 8, 45: 8, 46: 8, 47: 2,
  // Ensemble (48-55) — polyphonic
  48: 16, 49: 16, 50: 16, 51: 16, 52: 16, 53: 16, 54: 16, 55: 1,
  // Brass solo (56-60) — monophonic
  56: 1, 57: 1, 58: 1, 59: 1, 60: 1,
  // Brass section + synth brass (61-63)
  61: 8, 62: 8, 63: 8,
  // Reed / Sax solo (64-71) — monophonic
  64: 1, 65: 1, 66: 1, 67: 1, 68: 1, 69: 1, 70: 1, 71: 1,
  // Pipe / Flutes (72-79) — monophonic
  72: 1, 73: 1, 74: 1, 75: 1, 76: 1, 77: 1, 78: 1, 79: 1,
  // Synth Lead (80-87) — typically monophonic
  80: 1, 81: 1, 82: 1, 83: 1, 84: 1, 85: 1, 86: 2, 87: 2,
  // Synth Pad (88-95) — polyphonic
  88: 8, 89: 8, 90: 8, 91: 8, 92: 8, 93: 8, 94: 8, 95: 8,
  // Synth Effects (96-103) — varies
  96: 4, 97: 4, 98: 4, 99: 4, 100: 4, 101: 4, 102: 4, 103: 4,
  // Ethnic (104-111) — varies
  104: 4, 105: 6, 106: 4, 107: 4, 108: 4, 109: 1, 110: 4, 111: 1,
  // Percussive (112-119) — varies
  112: 4, 113: 4, 114: 2, 115: 2, 116: 4, 117: 4, 118: 4, 119: 4,
  // Sound Effects (120-127) — monophonic
  120: 1, 121: 1, 122: 1, 123: 1, 124: 1, 125: 1, 126: 1, 127: 1
};

// Internal cache for fast program → type lookups
let _programToTypeCache = null;

function _buildProgramCache() {
  if (_programToTypeCache) return _programToTypeCache;
  _programToTypeCache = new Map();
  for (const [type, config] of Object.entries(INSTRUMENT_TYPE_HIERARCHY)) {
    for (const program of config.gmPrograms) {
      let subtype = null;
      for (const [st, stConfig] of Object.entries(config.subtypes || {})) {
        if (stConfig.gmPrograms.includes(program)) {
          subtype = st;
          break;
        }
      }
      _programToTypeCache.set(program, { type, subtype });
    }
  }
  return _programToTypeCache;
}

/**
 * Transposition offsets for transposing instruments.
 * Key = instrument subtype, value = array of candidate transpositions in semitones.
 * For example, a Bb trumpet transposes by -2 semitones (written C sounds Bb).
 */
const TRANSPOSING_OFFSETS = {
  // Bb instruments (-2 semitones)
  trumpet: [-2],
  muted_trumpet: [-2],
  clarinet: [-2],
  soprano_sax: [-2],
  tenor_sax: [-2],
  // Eb instruments (+3 or -9 semitones)
  alto_sax: [3, -9],
  baritone_sax: [3, -9],
  // F instruments (+5 or -7 semitones)
  french_horn: [5, -7],
  english_horn: [5, -7],
  // Guitar/bass: often octave (-12) but also fifth (-7)
  bass: [-12, -7],
  // Piccolo (+12), double bass (-12)
  piccolo: [12],
  contrabass: [-12],
};

const InstrumentTypeConfig = {
  /**
   * Complete type hierarchy
   */
  hierarchy: INSTRUMENT_TYPE_HIERARCHY,

  /**
   * Related type families
   */
  families: TYPE_FAMILIES,

  /**
   * Detect type and subtype from a GM program
   * @param {number|null} gmProgram - GM program (0-127)
   * @returns {{ type: string, subtype: string|null }}
   */
  detectTypeFromProgram(gmProgram) {
    if (gmProgram === null || gmProgram === undefined) {
      return { type: 'unknown', subtype: null };
    }
    const cache = _buildProgramCache();
    return cache.get(gmProgram) || { type: 'unknown', subtype: null };
  },

  /**
   * Return the list of categories for the UI
   * @returns {Array<{ key: string, label: string }>}
   */
  getCategories() {
    return Object.entries(INSTRUMENT_TYPE_HIERARCHY).map(([key, config]) => ({
      key,
      label: config.label
    }));
  },

  /**
   * Return the subtypes of a category for the UI
   * @param {string} categoryKey
   * @returns {Array<{ key: string, label: string }>}
   */
  getSubtypes(categoryKey) {
    const category = INSTRUMENT_TYPE_HIERARCHY[categoryKey];
    if (!category || !category.subtypes) return [];
    return Object.entries(category.subtypes).map(([key, config]) => ({
      key,
      label: config.label
    }));
  },

  /**
   * Check if a type is valid
   * @param {string} type
   * @returns {boolean}
   */
  isValidType(type) {
    return type in INSTRUMENT_TYPE_HIERARCHY;
  },

  /**
   * Check if a subtype is valid for a given type
   * @param {string} type
   * @param {string} subtype
   * @returns {boolean}
   */
  isValidSubtype(type, subtype) {
    const category = INSTRUMENT_TYPE_HIERARCHY[type];
    if (!category || !category.subtypes) return false;
    return subtype in category.subtypes;
  },

  /**
   * Get the label of a type
   * @param {string} type
   * @returns {string}
   */
  getTypeLabel(type) {
    const category = INSTRUMENT_TYPE_HIERARCHY[type];
    return category ? category.label : type;
  },

  /**
   * Get the label of a subtype
   * @param {string} type
   * @param {string} subtype
   * @returns {string}
   */
  getSubtypeLabel(type, subtype) {
    const category = INSTRUMENT_TYPE_HIERARCHY[type];
    if (!category || !category.subtypes || !category.subtypes[subtype]) return subtype;
    return category.subtypes[subtype].label;
  },

  /**
   * Check if two types belong to the same family
   * @param {string} type1
   * @param {string} type2
   * @returns {boolean}
   */
  areSameFamily(type1, type2) {
    if (type1 === type2) return true;
    for (const members of Object.values(TYPE_FAMILIES)) {
      if (members.includes(type1) && members.includes(type2)) {
        return true;
      }
    }
    return false;
  },

  /**
   * Get the family of a type
   * @param {string} type
   * @returns {string|null} - Family name or null
   */
  getFamily(type) {
    for (const [family, members] of Object.entries(TYPE_FAMILIES)) {
      if (members.includes(type)) {
        return family;
      }
    }
    return null;
  },

  /**
   * Return the GM programs associated with a type
   * @param {string} type
   * @returns {number[]}
   */
  getGmProgramsForType(type) {
    const category = INSTRUMENT_TYPE_HIERARCHY[type];
    return category ? category.gmPrograms : [];
  },

  /**
   * Return the default polyphony of a GM instrument.
   * Represents the typical polyphony of the real acoustic instrument.
   * @param {number|null} gmProgram - GM program (0-127)
   * @returns {number} - Default polyphony (fallback: 16)
   */
  getGmDefaultPolyphony(gmProgram) {
    if (gmProgram === null || gmProgram === undefined || gmProgram < 0 || gmProgram > 127) {
      return 16;
    }
    return GM_DEFAULT_POLYPHONY[gmProgram] ?? 16;
  },

  /**
   * Return the transposition offsets for a transposing instrument.
   * @param {string|null} subtype - Instrument subtype (e.g., 'trumpet', 'alto_sax')
   * @returns {number[]|null} - Array of candidate transpositions in semitones, or null
   */
  getTransposingOffsets(subtype) {
    if (!subtype) return null;
    return TRANSPOSING_OFFSETS[subtype] || null;
  }
};

export default InstrumentTypeConfig;
