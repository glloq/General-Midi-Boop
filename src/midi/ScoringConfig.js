/**
 * @file src/midi/ScoringConfig.js
 * @description Weight tables that drive the compatibility score
 * computed by {@link InstrumentMatcher} and the cache parameters used
 * by {@link AutoAssigner}. Tweak values here to influence the
 * auto-assignment ranking without touching algorithmic code; the sum of
 * `weights.*` should remain 100.
 */
const ScoringConfig = {
  /**
   * Maximum weight for each criterion (total = 100)
   */
  weights: {
    programMatch: 22,      // GM MIDI program match
    noteRange: 40,         // Note range compatibility (criterion #1: playability)
    polyphony: 13,         // Sufficient polyphony
    ccSupport: 5,          // MIDI controller support
    instrumentType: 20     // Hierarchical instrument type
    // Note: channelSpecial removed (was never implemented as a sub-score).
    // The percussion channel 9 bonus is handled separately via percussion.drumChannelDrumBonus.
    // The 5 points were redistributed: +2 programMatch, +3 polyphony. Total = 100.
  },

  /**
   * Weights for type detection
   */
  typeDetection: {
    programWeight: 40,     // MIDI program importance
    rangeWeight: 25,       // Note range importance
    polyphonyWeight: 20,   // Polyphony importance
    densityWeight: 15,     // Rhythmic density importance
    trackNameWeight: 30    // Track name importance
  },

  /**
   * Thresholds for type detection
   */
  typeThresholds: {
    lowNote: 48,           // Note below this = potentially bass
    highDensity: 6,        // Notes/sec above this = potentially drums
    wideSpan: 36,          // Semitones above this = potentially harmony
    narrowSpan: 12,        // Semitones below this = potentially drums/melody
    highPolyphony: 5,      // Simultaneous notes above this = potentially harmony
    drumNoteRange: { min: 35, max: 60, span: 25 } // Typical drum range
  },

  /**
   * Penalties for incompatibilities
   */
  penalties: {
    transpositionPerOctave: 3,    // Penalty per octave of transposition
    maxTranspositionOctaves: 3,   // Beyond this = incompatible
    insufficientPolyphony: 20,    // Insufficient polyphony
    missingCCPercentage: 5,       // Per unsupported CC
    wrongInstrumentType: 10       // Completely different type
  },

  /**
   * Bonuses for good matches
   */
  bonuses: {
    perfectProgramMatch: 22,      // Exact MIDI program (= programMatch weight)
    sameCategoryMatch: 15,        // Same GM category
    perfectNoteRange: 40,         // No transposition needed (note range = criterion #1)
    highPolyphonyMargin: 15,      // Polyphony margin > 8
    allCCsSupported: 7,           // All CCs supported
    typeMatch: 10,                // Detected type matches (legacy)
    channel10Drums: 5,            // Channel 10 assigned to drums
    exactTypeMatch: 20,           // Exact hierarchical type (e.g., guitar ↔ guitar)
    subtypeMatch: 5,              // Exact subtype on top
    sameFamilyMatch: 12           // Same family (e.g., reed ↔ pipe = woodwinds)
  },

  /**
   * Percussion-specific configuration / channel 10 (index 9)
   */
  percussion: {
    drumChannelNonDrumPenalty: -100,   // Non-drum instrument assigned to channel 9 → BLOCKED
    nonDrumChannelDrumPenalty: -100,   // Drum-only instrument assigned to a non-9 channel → BLOCKED
    drumChannelDrumBonus: 15,          // Drum instrument assigned to channel 9
    drumChannelWeights: {
      programMatch: 5,        // Reduced (drums don't use standard GM programs on ch10)
      noteRange: 50,          // Increased (drum mapping quality = critical)
      polyphony: 10,          // Reduced (drums = limited polyphony)
      ccSupport: 5,           // Low impact for drums
      instrumentType: 30      // Type match for drums (includes former channelSpecial)
      // Note: Total = 100. channelSpecial removed, points redistributed.
    }
  },

  /**
   * Channel splitting configuration
   */
  splitting: {
    minQuality: 50,               // Minimum score to propose a split
    minInstruments: 2,            // Minimum instruments for a split
    maxInstruments: 4,            // Maximum instruments in a split
    weights: {
      noteCoverage: 40,           // Channel note coverage
      polyphonyCoverage: 25,      // Combined polyphony sufficient
      minimalCuts: 20,            // Fewer cuts = better
      minimalOverlap: 15          // Minimal overlap between instruments
    },
    // Minimum channel score to trigger split evaluation
    triggerBelowScore: 60,
    // Weights for pair quality scoring by behavior mode
    behaviorWeights: {
      overflow: { polyphonyCoverage: 50, rangeCoverage: 30, avgPolyFit: 20 },
      combineNoOverlap: { rangeCoverage: 40, gapMinimization: 30, naturalSplit: 20, polyphonyCoverage: 10 },
      combineWithOverlap: { rangeCoverage: 35, overlapSize: 25, polyphonyCoverage: 20, naturalFit: 20 },
      alternate: { rangeCoverage: 40, densityJustification: 30, polyphonyCoverage: 20, symmetry: 10 }
    }
  },

  /**
   * Routing settings (from ScoringSettingsModal)
   */
  routing: {
    allowInstrumentReuse: true,        // Allow an instrument on multiple channels when not enough instruments
    sharedInstrumentPenalty: 10,        // Score penalty displayed for shared assignments
    autoSplitAvoidTransposition: false,
    preferSingleInstrument: true,
    preferSimilarGMType: true,
    drumFallback: {
      kicks: 2,        // Essential: tight substitution (kick -> kick only)
      snares: 3,       // Essential: allow rim shot, clap substitution
      hiHats: 3,       // Important: allow pedal/open/tambourine
      toms: 5,         // Optional: allow more distant toms, congas
      crashes: 4,      // Important: allow splash, china, ride
      rides: 4,        // Important: allow bell, crash
      latin: -1,       // Nice-to-have: unlimited substitution
      shakers: -1,     // Nice-to-have: unlimited substitution
      woodsMetal: -1,  // Nice-to-have: unlimited substitution
      pitched: -1,     // Nice-to-have: unlimited substitution
      cuicas: -1,      // Nice-to-have: unlimited substitution
      triangles: -1    // Nice-to-have: unlimited substitution
    }
  },

  /**
   * Timing / playing speed configuration
   * Penalties applied when channel notes are too fast for the instrument.
   * Works as a penalty (subtracted from score), not a weighted factor.
   */
  timing: {
    tooFastPenalty: -10,          // When p5 interval < instrument's min_note_interval
    moderatelyFastPenalty: -5,    // When p10 interval < min_note_interval
    suggestSpeedSplit: true       // Suggest a split when > 20% of notes are too fast
  },

  /**
   * Cache configuration
   */
  cache: {
    maxSize: 100,                 // Maximum number of entries
    ttl: 600000                   // Time to live (10 minutes)
  },

  /**
   * Score thresholds
   */
  scoreThresholds: {
    excellent: 90,                // Score >= 90 = excellent
    good: 75,                     // Score >= 75 = good
    acceptable: 60,               // Score >= 60 = acceptable
    poor: 40,                     // Score >= 40 = poor
    minimum: 30                   // Score < 30 = not recommended
  },

  /**
   * Get the weight of a criterion
   * @param {string} criterion
   * @returns {number}
   */
  getWeight(criterion) {
    return this.weights[criterion] || 0;
  },

  /**
   * Get a threshold
   * @param {string} threshold
   * @returns {number|Object}
   */
  getThreshold(threshold) {
    return this.typeThresholds[threshold];
  },

  /**
   * Get a penalty
   * @param {string} penalty
   * @returns {number}
   */
  getPenalty(penalty) {
    return this.penalties[penalty] || 0;
  },

  /**
   * Get a bonus
   * @param {string} bonus
   * @returns {number}
   */
  getBonus(bonus) {
    return this.bonuses[bonus] || 0;
  },

  /**
   * Get the weight of a criterion for the drums channel (channel 9)
   * @param {string} criterion
   * @returns {number}
   */
  getDrumWeight(criterion) {
    return (this.percussion && this.percussion.drumChannelWeights &&
            this.percussion.drumChannelWeights[criterion]) || this.weights[criterion] || 0;
  },

  /**
   * Get a percussion penalty/bonus
   * @param {string} key
   * @returns {number}
   */
  getPercussionValue(key) {
    return (this.percussion && this.percussion[key]) || 0;
  },

};

export default ScoringConfig;
