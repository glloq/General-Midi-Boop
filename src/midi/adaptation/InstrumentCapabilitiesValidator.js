/**
 * @file src/midi/adaptation/InstrumentCapabilitiesValidator.js
 * @description Capability completeness checker for instrument records.
 * Used by the auto-assigner UI to flag instruments that are missing
 * data needed to score them properly (`gm_program`, `polyphony`,
 * `note_selection_mode`, plus mode-conditional fields like
 * `selected_notes` for discrete-pad instruments and the note range for
 * range-based instruments).
 *
 * The validator returns a structured report (`isValid`, `isComplete`,
 * `missing`, `recommended`) so the UI can both block invalid configs
 * AND nudge the user to fill in optional but recommended fields like
 * `supported_ccs` and `type`.
 */

class InstrumentCapabilitiesValidator {
  constructor() {
    // Always required capabilities
    this.requiredCapabilities = [
      'gm_program',
      'polyphony',
      'note_selection_mode'
    ];

    // Optional but recommended capabilities
    this.recommendedCapabilities = [
      'supported_ccs',
      'type'
    ];

    // Conditional capabilities depending on the mode
    this.conditionalCapabilities = {
      'selected_notes': (instrument) => instrument.note_selection_mode === 'discrete',
      'note_range_min': (instrument) => instrument.note_selection_mode !== 'discrete',
      'note_range_max': (instrument) => instrument.note_selection_mode !== 'discrete'
    };
  }

  /**
   * Validates an instrument and returns missing capabilities
   * @param {Object} instrument
   * @returns {Object} { isValid, isComplete, missing, recommended }
   */
  validateInstrument(instrument) {
    const missing = [];
    const recommended = [];

    // Check required capabilities
    for (const capability of this.requiredCapabilities) {
      const value = instrument[capability];

      if (value === null || value === undefined || value === '') {
        missing.push({
          field: capability,
          label: this.getCapabilityLabel(capability),
          type: this.getCapabilityType(capability),
          required: true
        });
      }
    }

    // Validate that note_selection_mode has a recognized value
    const mode = instrument.note_selection_mode;
    if (mode !== null && mode !== undefined && mode !== '' &&
        mode !== 'range' && mode !== 'discrete') {
      missing.push({
        field: 'note_selection_mode',
        label: this.getCapabilityLabel('note_selection_mode'),
        type: this.getCapabilityType('note_selection_mode'),
        required: true,
        reason: `Invalid value '${mode}'. Must be 'range' or 'discrete'.`
      });
    }

    // Check conditional capabilities
    for (const [capability, condition] of Object.entries(this.conditionalCapabilities)) {
      if (condition(instrument)) {
        const value = instrument[capability];
        if (!value || (Array.isArray(value) && value.length === 0)) {
          missing.push({
            field: capability,
            label: this.getCapabilityLabel(capability),
            type: this.getCapabilityType(capability),
            required: true,
            conditional: true
          });
        }
      }
    }

    // Check recommended capabilities
    for (const capability of this.recommendedCapabilities) {
      const value = instrument[capability];

      if (value === null || value === undefined || value === '' ||
          (Array.isArray(value) && value.length === 0)) {
        recommended.push({
          field: capability,
          label: this.getCapabilityLabel(capability),
          type: this.getCapabilityType(capability),
          required: false
        });
      }
    }

    // Optional: validate hands_config shape when present. Missing or null
    // means the hand-position feature is disabled for this instrument —
    // that is a valid state (Phase 1 keyboards only, everything else is
    // opt-in). When present, the structure must be coherent.
    const handIssues = this._validateHandsConfig(instrument.hands_config);
    for (const issue of handIssues) missing.push(issue);

    const isValid = missing.length === 0;
    const isComplete = missing.length === 0 && recommended.length === 0;

    return {
      isValid,
      isComplete,
      missing,
      recommended,
      instrument
    };
  }

  /**
   * Validate the optional `hands_config` JSON payload. Returns an array
   * of `missing`-shaped entries (empty when absent or well-formed).
   * @private
   */
  _validateHandsConfig(raw) {
    if (raw === null || raw === undefined || raw === '') return [];

    let cfg = raw;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch (e) {
        return [{
          field: 'hands_config',
          label: this.getCapabilityLabel('hands_config'),
          type: 'json',
          required: true,
          reason: `Invalid JSON: ${e.message}`
        }];
      }
    }

    const issues = [];
    if (typeof cfg !== 'object' || Array.isArray(cfg)) {
      issues.push({
        field: 'hands_config', label: this.getCapabilityLabel('hands_config'),
        type: 'json', required: true, reason: 'Must be an object.'
      });
      return issues;
    }

    if (cfg.enabled === false) return []; // explicitly disabled — OK

    if (!Array.isArray(cfg.hands) || cfg.hands.length === 0) {
      issues.push({
        field: 'hands_config.hands', label: 'Hands list',
        type: 'array', required: true, conditional: true,
        reason: 'hands_config requires at least one hand.'
      });
      return issues;
    }

    const seenIds = new Set();
    for (let i = 0; i < cfg.hands.length; i++) {
      const h = cfg.hands[i];
      if (!h || typeof h !== 'object') {
        issues.push({ field: `hands_config.hands[${i}]`, label: 'Hand entry', type: 'object', required: true, reason: 'Must be an object.' });
        continue;
      }
      if (!h.id || (h.id !== 'left' && h.id !== 'right')) {
        issues.push({ field: `hands_config.hands[${i}].id`, label: 'Hand id', type: 'text', required: true, reason: "id must be 'left' or 'right'." });
      }
      if (h.id && seenIds.has(h.id)) {
        issues.push({ field: `hands_config.hands[${i}].id`, label: 'Hand id', type: 'text', required: true, reason: `Duplicate hand id '${h.id}'.` });
      }
      if (h.id) seenIds.add(h.id);
      if (!Number.isFinite(h.cc_position_number) || h.cc_position_number < 0 || h.cc_position_number > 127) {
        issues.push({ field: `hands_config.hands[${i}].cc_position_number`, label: 'CC number', type: 'number', required: true, reason: 'Must be an integer in [0,127].' });
      }
      if (!Number.isFinite(h.hand_span_semitones) || h.hand_span_semitones <= 0) {
        issues.push({ field: `hands_config.hands[${i}].hand_span_semitones`, label: 'Hand span', type: 'number', required: true, reason: 'Must be a positive number of semitones.' });
      }
      if (h.note_range_min != null && h.note_range_max != null && h.note_range_min > h.note_range_max) {
        issues.push({ field: `hands_config.hands[${i}].note_range`, label: 'Hand range', type: 'range', required: true, reason: 'note_range_min must be <= note_range_max.' });
      }
      if (h.polyphony != null && (!Number.isInteger(h.polyphony) || h.polyphony < 1)) {
        issues.push({ field: `hands_config.hands[${i}].polyphony`, label: 'Fingers', type: 'number', required: true, reason: 'polyphony must be an integer >= 1.' });
      }
    }

    const mode = cfg.assignment?.mode;
    if (mode && mode !== 'auto' && mode !== 'track' && mode !== 'pitch_split') {
      issues.push({ field: 'hands_config.assignment.mode', label: 'Assignment mode', type: 'select', required: true, reason: `Unknown mode '${mode}'.` });
    }

    return issues;
  }

  /**
   * Validates a list of instruments
   * @param {Array} instruments
   * @returns {Object} { valid, incomplete, allValid }
   */
  validateInstruments(instruments) {
    const results = instruments.map(inst => this.validateInstrument(inst));

    const incomplete = results.filter(r => !r.isValid || !r.isComplete);
    const allValid = results.every(r => r.isValid);

    return {
      results,
      incomplete,
      allValid,
      validCount: results.filter(r => r.isValid).length,
      completeCount: results.filter(r => r.isComplete).length,
      totalCount: results.length
    };
  }

  /**
   * Gets the human-readable label for a capability
   * @param {string} capability
   * @returns {string}
   */
  getCapabilityLabel(capability) {
    const labels = {
      'gm_program': 'General MIDI Program',
      'note_range_min': 'Lowest Note',
      'note_range_max': 'Highest Note',
      'polyphony': 'Maximum Polyphony',
      'note_selection_mode': 'Play Mode',
      'supported_ccs': 'Supported Control Changes',
      'type': 'Instrument Type',
      'selected_notes': 'Playable Notes (Discrete Mode)',
      'hands_config': 'Hand-Position Configuration'
    };

    return labels[capability] || capability;
  }

  /**
   * Gets the input type for a capability
   * @param {string} capability
   * @returns {string}
   */
  getCapabilityType(capability) {
    const types = {
      'gm_program': 'number',
      'note_range_min': 'note',
      'note_range_max': 'note',
      'polyphony': 'number',
      'note_selection_mode': 'select',
      'supported_ccs': 'array',
      'type': 'select',
      'selected_notes': 'note-array'
    };

    return types[capability] || 'text';
  }

  /**
   * Gets suggested default values for an instrument
   * @param {Object} instrument
   * @returns {Object}
   */
  getSuggestedDefaults(instrument) {
    const defaults = {};

    // Default values based on instrument type
    if (instrument.type === 'keyboard' || instrument.type === 'piano') {
      defaults.gm_program = 0; // Acoustic Grand Piano
      defaults.note_range_min = 21; // A0
      defaults.note_range_max = 108; // C8
      defaults.polyphony = 64;
      defaults.note_selection_mode = 'range';
      defaults.supported_ccs = [1, 7, 10, 11, 64, 71, 91, 93];
    }
    else if (instrument.type === 'drums' || instrument.type === 'percussion') {
      defaults.gm_program = 0; // Standard Drum Kit (on channel 9)
      defaults.note_range_min = 35; // Acoustic Bass Drum
      defaults.note_range_max = 81; // Open Triangle
      defaults.polyphony = 16;
      defaults.note_selection_mode = 'discrete';
      defaults.selected_notes = [36, 38, 42, 44, 46, 48, 50, 51]; // Common drum notes
      defaults.supported_ccs = [7, 10]; // Volume, Pan
    }
    else if (instrument.type === 'bass') {
      defaults.gm_program = 33; // Electric Bass (finger)
      defaults.note_range_min = 28; // E1
      defaults.note_range_max = 60; // C4
      defaults.polyphony = 4;
      defaults.note_selection_mode = 'range';
      defaults.supported_ccs = [1, 7, 10, 11];
    }
    else if (instrument.type === 'synth') {
      defaults.gm_program = 81; // Lead 2 (sawtooth)
      defaults.note_range_min = 0; // Full MIDI range
      defaults.note_range_max = 127;
      defaults.polyphony = 8;
      defaults.note_selection_mode = 'range';
      defaults.supported_ccs = [1, 7, 10, 11, 71, 72, 73, 74];
    }
    else {
      // Generic default values
      defaults.gm_program = 0;
      defaults.note_range_min = 48; // C3
      defaults.note_range_max = 84; // C6
      defaults.polyphony = 16;
      defaults.note_selection_mode = 'range';
      defaults.supported_ccs = [7, 10, 11];
    }

    return defaults;
  }
}

export default InstrumentCapabilitiesValidator;
