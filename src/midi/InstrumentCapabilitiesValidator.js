/**
 * InstrumentCapabilitiesValidator
 *
 * Valide que les instruments ont toutes les capacités nécessaires
 * pour l'auto-assignation et identifie les informations manquantes.
 */

class InstrumentCapabilitiesValidator {
  constructor() {
    // Capacités requises pour une auto-assignation optimale
    this.requiredCapabilities = [
      'gm_program',
      'note_range_min',
      'note_range_max',
      'polyphony',
      'note_selection_mode'
    ];

    // Capacités optionnelles mais recommandées
    this.recommendedCapabilities = [
      'supported_ccs',
      'type'
    ];

    // Capacités conditionnelles
    this.conditionalCapabilities = {
      'selected_notes': (instrument) => instrument.note_selection_mode === 'discrete'
    };
  }

  /**
   * Valide un instrument et retourne les capacités manquantes
   * @param {Object} instrument
   * @returns {Object} { isValid, isComplete, missing, recommended }
   */
  validateInstrument(instrument) {
    const missing = [];
    const recommended = [];

    // Vérifier les capacités requises
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

    // Valider que note_selection_mode a une valeur reconnue
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

    // Vérifier les capacités conditionnelles
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

    // Vérifier les capacités recommandées
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
   * Valide une liste d'instruments
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
   * Obtient le label lisible d'une capacité
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
      'selected_notes': 'Playable Notes (Discrete Mode)'
    };

    return labels[capability] || capability;
  }

  /**
   * Obtient le type d'input pour une capacité
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
   * Obtient des valeurs par défaut suggérées pour un instrument
   * @param {Object} instrument
   * @returns {Object}
   */
  getSuggestedDefaults(instrument) {
    const defaults = {};

    // Valeurs par défaut selon le type d'instrument
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
      // Valeurs par défaut génériques
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
