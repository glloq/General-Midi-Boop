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
   *
   * Supports two modes, selected by `cfg.mode`:
   *   - `'semitones'` (default when absent): keyboard-family. Two hands
   *     (left/right), per-hand `hand_span_semitones`, shared
   *     `hand_move_semitones_per_sec`, optional `assignment` block.
   *   - `'frets'`: string-family. A single hand whose id is `'fretting'`,
   *     per-hand `hand_span_mm`, shared `hand_move_mm_per_sec`, no
   *     assignment block. The `mechanism` field discriminates between
   *     the two V1 implementations (`string_sliding_fingers`,
   *     `fret_sliding_fingers`); `independent_fingers` is V2 and
   *     rejected at save time so the planner is never asked to run it.
   *
   * Cross-unit fields are rejected (a frets-mode config carrying
   * `hand_span_semitones`, or vice versa) so misconfigurations surface
   * at save time rather than at playback time.
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

    const mode = cfg.mode === 'frets' ? 'frets' : 'semitones';
    if (cfg.mode != null && cfg.mode !== 'semitones' && cfg.mode !== 'frets') {
      issues.push({
        field: 'hands_config.mode', label: 'Hand-position mode',
        type: 'select', required: true,
        reason: `Unknown mode '${cfg.mode}'. Must be 'semitones' or 'frets'.`
      });
      return issues;
    }

    if (!Array.isArray(cfg.hands) || cfg.hands.length === 0) {
      issues.push({
        field: 'hands_config.hands', label: 'Hands list',
        type: 'array', required: true, conditional: true,
        reason: 'hands_config requires at least one hand.'
      });
      return issues;
    }

    if (mode === 'frets') {
      this._validateFretsHandsConfig(cfg, issues);
    } else {
      this._validateSemitonesHandsConfig(cfg, issues);
    }

    return issues;
  }

  /** @private Semitones mode: two hands (left/right), assignment block allowed. */
  _validateSemitonesHandsConfig(cfg, issues) {
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
      if (h.hand_span_frets != null) {
        issues.push({ field: `hands_config.hands[${i}].hand_span_frets`, label: 'Hand span', type: 'number', required: true, reason: 'hand_span_frets is only valid in frets mode.' });
      }
      if (h.hand_span_mm != null) {
        issues.push({ field: `hands_config.hands[${i}].hand_span_mm`, label: 'Hand span', type: 'number', required: true, reason: 'hand_span_mm is only valid in frets mode.' });
      }
      if (h.max_fingers != null) {
        issues.push({ field: `hands_config.hands[${i}].max_fingers`, label: 'Max fingers', type: 'number', required: true, reason: 'max_fingers is only valid in frets mode.' });
      }
    }

    if (cfg.hand_move_semitones_per_sec != null
        && (!Number.isFinite(cfg.hand_move_semitones_per_sec) || cfg.hand_move_semitones_per_sec <= 0)) {
      issues.push({
        field: 'hands_config.hand_move_semitones_per_sec', label: 'Travel speed',
        type: 'number', required: true,
        reason: 'hand_move_semitones_per_sec must be a positive number.'
      });
    }
    if (cfg.hand_move_frets_per_sec != null) {
      issues.push({
        field: 'hands_config.hand_move_frets_per_sec', label: 'Travel speed',
        type: 'number', required: true,
        reason: 'hand_move_frets_per_sec is only valid in frets mode.'
      });
    }
    if (cfg.hand_move_mm_per_sec != null) {
      issues.push({
        field: 'hands_config.hand_move_mm_per_sec', label: 'Travel speed',
        type: 'number', required: true,
        reason: 'hand_move_mm_per_sec is only valid in frets mode.'
      });
    }

    const mode = cfg.assignment?.mode;
    if (mode && mode !== 'auto' && mode !== 'track' && mode !== 'pitch_split') {
      issues.push({ field: 'hands_config.assignment.mode', label: 'Assignment mode', type: 'select', required: true, reason: `Unknown mode '${mode}'.` });
    }
  }

  /**
   * Frets mode: single fretting hand, no assignment block.
   *
   * Required:
   *   - `mechanism`: discriminator selecting the V1 planner variant
   *     (`string_sliding_fingers` or `fret_sliding_fingers`).
   *     `independent_fingers` is reserved for V2 and rejected here so
   *     the planner is never asked to run it.
   *   - hand span: `hand_span_mm` (preferred) or `hand_span_frets`
   *     (legacy fallback for rows that pre-date the mm refactor; new
   *     UI never writes it but downstream code still reads it as a
   *     summary value).
   *   - travel speed: `hand_move_mm_per_sec` or `hand_move_frets_per_sec`
   *     under the same legacy/new split.
   *
   * For `fret_sliding_fingers` we additionally validate the per-finger
   * count (`num_fingers`) and the optional variable-height sub-count
   * (`variable_height_fingers_count`).
   * @private
   */
  _validateFretsHandsConfig(cfg, issues) {
    // Mechanism — required for frets mode. V2 entries are saved-rejected.
    const VALID_MECHANISMS = new Set(['string_sliding_fingers', 'fret_sliding_fingers']);
    const V2_MECHANISMS = new Set(['independent_fingers']);
    if (cfg.mechanism == null || cfg.mechanism === '') {
      issues.push({
        field: 'hands_config.mechanism', label: 'Hand mechanism',
        type: 'select', required: true,
        reason: "mechanism is required in frets mode (one of: 'string_sliding_fingers', 'fret_sliding_fingers')."
      });
    } else if (V2_MECHANISMS.has(cfg.mechanism)) {
      issues.push({
        field: 'hands_config.mechanism', label: 'Hand mechanism',
        type: 'select', required: true,
        reason: `mechanism '${cfg.mechanism}' is reserved for V2 and not yet implemented.`
      });
    } else if (!VALID_MECHANISMS.has(cfg.mechanism)) {
      issues.push({
        field: 'hands_config.mechanism', label: 'Hand mechanism',
        type: 'select', required: true,
        reason: `Unknown mechanism '${cfg.mechanism}'. Must be 'string_sliding_fingers' or 'fret_sliding_fingers'.`
      });
    }

    if (cfg.hands.length !== 1) {
      issues.push({
        field: 'hands_config.hands', label: 'Hands list',
        type: 'array', required: true,
        reason: "frets mode requires exactly one hand entry (the fretting hand)."
      });
    }
    const h = cfg.hands[0];
    if (!h || typeof h !== 'object') {
      issues.push({ field: 'hands_config.hands[0]', label: 'Hand entry', type: 'object', required: true, reason: 'Must be an object.' });
      return;
    }
    if (h.id !== 'fretting') {
      issues.push({ field: 'hands_config.hands[0].id', label: 'Hand id', type: 'text', required: true, reason: "id must be 'fretting' in frets mode." });
    }
    if (!Number.isFinite(h.cc_position_number) || h.cc_position_number < 0 || h.cc_position_number > 127) {
      issues.push({ field: 'hands_config.hands[0].cc_position_number', label: 'CC number', type: 'number', required: true, reason: 'Must be an integer in [0,127].' });
    }

    // Hand span — at least one of (mm, frets) must be present and valid.
    // `hand_span_mm` is the canonical unit; `hand_span_frets` is kept
    // accepted for legacy rows but no longer written by the UI.
    const mmSpanValid = Number.isFinite(h.hand_span_mm) && h.hand_span_mm > 0;
    const fretsSpanValid = Number.isFinite(h.hand_span_frets) && h.hand_span_frets > 0;
    if (h.hand_span_mm != null && (!Number.isFinite(h.hand_span_mm) || h.hand_span_mm < 30 || h.hand_span_mm > 200)) {
      issues.push({ field: 'hands_config.hands[0].hand_span_mm', label: 'Hand span (mm)', type: 'number', required: true, reason: 'hand_span_mm must be between 30 and 200 mm.' });
    }
    if (h.hand_span_frets != null && (!Number.isFinite(h.hand_span_frets) || h.hand_span_frets <= 0 || h.hand_span_frets > 24)) {
      issues.push({ field: 'hands_config.hands[0].hand_span_frets', label: 'Hand span (frets)', type: 'number', required: true, reason: 'hand_span_frets must be a positive integer ≤ 24.' });
    }
    if (!mmSpanValid && !fretsSpanValid) {
      issues.push({
        field: 'hands_config.hands[0].hand_span_mm', label: 'Hand span',
        type: 'number', required: true,
        reason: 'frets mode requires hand_span_mm (preferred) or hand_span_frets (legacy).'
      });
    }
    if (h.hand_span_semitones != null) {
      issues.push({ field: 'hands_config.hands[0].hand_span_semitones', label: 'Hand span', type: 'number', required: true, reason: 'hand_span_semitones is only valid in semitones mode.' });
    }

    // max_fingers — optional, capped at 12 (== num_strings DB cap).
    if (h.max_fingers != null) {
      if (!Number.isFinite(h.max_fingers) || h.max_fingers < 1 || h.max_fingers > 12) {
        issues.push({
          field: 'hands_config.hands[0].max_fingers', label: 'Max fingers',
          type: 'number', required: true,
          reason: 'max_fingers must be a positive integer between 1 and 12.'
        });
      }
    }

    // fret_sliding_fingers-specific fields. `num_fingers` is the count
    // of fret-anchored fingers spread across the hand width;
    // `variable_height_fingers_count` is how many of those fingers have
    // an adjustable fret offset (0 = all fixed, max = all variable).
    if (cfg.mechanism === 'fret_sliding_fingers') {
      if (h.num_fingers == null
          || !Number.isFinite(h.num_fingers)
          || h.num_fingers < 1
          || h.num_fingers > 8) {
        issues.push({
          field: 'hands_config.hands[0].num_fingers', label: 'Number of fingers',
          type: 'number', required: true,
          reason: 'fret_sliding_fingers requires num_fingers in [1,8].'
        });
      }
      if (h.variable_height_fingers_count != null) {
        const max = Number.isFinite(h.num_fingers) ? h.num_fingers : 8;
        if (!Number.isFinite(h.variable_height_fingers_count)
            || h.variable_height_fingers_count < 0
            || h.variable_height_fingers_count > max) {
          issues.push({
            field: 'hands_config.hands[0].variable_height_fingers_count',
            label: 'Variable-height fingers',
            type: 'number', required: true,
            reason: `variable_height_fingers_count must be between 0 and num_fingers (${max}).`
          });
        }
      }
    } else if (cfg.mechanism === 'string_sliding_fingers') {
      // string_sliding_fingers must NOT carry the fret-sliding-only fields.
      if (h.num_fingers != null) {
        issues.push({
          field: 'hands_config.hands[0].num_fingers', label: 'Number of fingers',
          type: 'number', required: true,
          reason: 'num_fingers is only valid for fret_sliding_fingers.'
        });
      }
      if (h.variable_height_fingers_count != null) {
        issues.push({
          field: 'hands_config.hands[0].variable_height_fingers_count',
          label: 'Variable-height fingers',
          type: 'number', required: true,
          reason: 'variable_height_fingers_count is only valid for fret_sliding_fingers.'
        });
      }
    }

    // Travel speed — same dual-unit logic as span.
    const mmSpeedValid = Number.isFinite(cfg.hand_move_mm_per_sec) && cfg.hand_move_mm_per_sec > 0;
    const fretsSpeedValid = Number.isFinite(cfg.hand_move_frets_per_sec) && cfg.hand_move_frets_per_sec > 0;
    if (cfg.hand_move_mm_per_sec != null
        && (!Number.isFinite(cfg.hand_move_mm_per_sec) || cfg.hand_move_mm_per_sec < 50 || cfg.hand_move_mm_per_sec > 2000)) {
      issues.push({
        field: 'hands_config.hand_move_mm_per_sec', label: 'Travel speed (mm/s)',
        type: 'number', required: true,
        reason: 'hand_move_mm_per_sec must be between 50 and 2000.'
      });
    }
    if (cfg.hand_move_frets_per_sec != null
        && (!Number.isFinite(cfg.hand_move_frets_per_sec) || cfg.hand_move_frets_per_sec <= 0 || cfg.hand_move_frets_per_sec > 120)) {
      issues.push({
        field: 'hands_config.hand_move_frets_per_sec', label: 'Travel speed (frets/s)',
        type: 'number', required: true,
        reason: 'hand_move_frets_per_sec must be a positive number ≤ 120.'
      });
    }
    if (!mmSpeedValid && !fretsSpeedValid) {
      issues.push({
        field: 'hands_config.hand_move_mm_per_sec', label: 'Travel speed',
        type: 'number', required: true,
        reason: 'frets mode requires hand_move_mm_per_sec (preferred) or hand_move_frets_per_sec (legacy).'
      });
    }
    if (cfg.hand_move_semitones_per_sec != null) {
      issues.push({
        field: 'hands_config.hand_move_semitones_per_sec', label: 'Travel speed',
        type: 'number', required: true,
        reason: 'hand_move_semitones_per_sec is only valid in semitones mode.'
      });
    }

    if (cfg.assignment != null) {
      issues.push({
        field: 'hands_config.assignment', label: 'Assignment mode',
        type: 'object', required: true,
        reason: 'assignment is not used in frets mode (single hand).'
      });
    }
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
