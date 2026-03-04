// src/midi/ScoringConfig.js

/**
 * Configuration des poids pour le scoring de compatibilité
 *
 * Permet d'ajuster finement l'algorithme d'auto-assignation
 * en modifiant les poids sans toucher au code.
 */
const ScoringConfig = {
  /**
   * Poids maximum pour chaque critère (total = 100)
   */
  weights: {
    programMatch: 30,      // Match du programme MIDI GM
    noteRange: 25,         // Compatibilité de plage de notes
    polyphony: 15,         // Polyphonie suffisante
    ccSupport: 15,         // Support des contrôleurs MIDI
    instrumentType: 10,    // Type d'instrument (drums, bass, etc.)
    channelSpecial: 5      // Canal spécial (ex: canal 10 = drums)
  },

  /**
   * Poids pour la détection de type
   */
  typeDetection: {
    programWeight: 40,     // Importance du programme MIDI
    rangeWeight: 25,       // Importance de la plage de notes
    polyphonyWeight: 20,   // Importance de la polyphonie
    densityWeight: 15,     // Importance de la densité rythmique
    trackNameWeight: 30    // Importance des noms de tracks
  },

  /**
   * Seuils pour la détection de type
   */
  typeThresholds: {
    lowNote: 48,           // Note en dessous = potentiellement bass
    highDensity: 6,        // Notes/sec au-dessus = potentiellement drums
    wideSpan: 36,          // Semitones au-dessus = potentiellement harmony
    narrowSpan: 12,        // Semitones en dessous = potentiellement drums/melody
    highPolyphony: 5,      // Notes simultanées au-dessus = potentiellement harmony
    drumNoteRange: { min: 35, max: 60, span: 25 } // Plage typique drums
  },

  /**
   * Pénalités pour incompatibilités
   */
  penalties: {
    transpositionPerOctave: 3,    // Pénalité par octave de transposition
    maxTranspositionOctaves: 3,   // Au-delà = incompatible
    insufficientPolyphony: 20,    // Polyphonie insuffisante
    missingCCPercentage: 5,       // Par CC non supporté
    wrongInstrumentType: 10       // Type complètement différent
  },

  /**
   * Bonus pour bons matchs
   */
  bonuses: {
    perfectProgramMatch: 30,      // Programme MIDI exact
    sameCategoryMatch: 20,        // Même catégorie GM
    perfectNoteRange: 25,         // Pas de transposition
    highPolyphonyMargin: 15,      // Marge de polyphonie > 8
    allCCsSupported: 15,          // Tous les CCs supportés
    typeMatch: 10,                // Type détecté correspond
    channel10Drums: 5             // Canal 10 assigné à drums
  },

  /**
   * Configuration du cache
   */
  cache: {
    maxSize: 100,                 // Nombre max d'entrées
    ttl: 600000                   // Time to live (10 minutes)
  },

  /**
   * Seuils de score
   */
  scoreThresholds: {
    excellent: 90,                // Score >= 90 = excellent
    good: 75,                     // Score >= 75 = bon
    acceptable: 60,               // Score >= 60 = acceptable
    poor: 40,                     // Score >= 40 = médiocre
    minimum: 30                   // Score < 30 = non recommandé
  },

  /**
   * Obtenir le poids d'un critère
   * @param {string} criterion
   * @returns {number}
   */
  getWeight(criterion) {
    return this.weights[criterion] || 0;
  },

  /**
   * Obtenir un seuil
   * @param {string} threshold
   * @returns {number|Object}
   */
  getThreshold(threshold) {
    return this.typeThresholds[threshold];
  },

  /**
   * Obtenir une pénalité
   * @param {string} penalty
   * @returns {number}
   */
  getPenalty(penalty) {
    return this.penalties[penalty] || 0;
  },

  /**
   * Obtenir un bonus
   * @param {string} bonus
   * @returns {number}
   */
  getBonus(bonus) {
    return this.bonuses[bonus] || 0;
  },

  /**
   * Obtenir la classification d'un score
   * @param {number} score
   * @returns {string}
   */
  getScoreClassification(score) {
    if (score >= this.scoreThresholds.excellent) return 'excellent';
    if (score >= this.scoreThresholds.good) return 'good';
    if (score >= this.scoreThresholds.acceptable) return 'acceptable';
    if (score >= this.scoreThresholds.poor) return 'poor';
    return 'insufficient';
  },

  /**
   * Valider que la somme des poids = 100
   * @returns {boolean}
   */
  validateWeights() {
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
    return sum === 100;
  },

  /**
   * Charger une configuration personnalisée
   * @param {Object} customConfig
   */
  load(customConfig) {
    if (customConfig.weights) {
      Object.assign(this.weights, customConfig.weights);
    }
    if (customConfig.typeDetection) {
      Object.assign(this.typeDetection, customConfig.typeDetection);
    }
    if (customConfig.typeThresholds) {
      Object.assign(this.typeThresholds, customConfig.typeThresholds);
    }
    if (customConfig.penalties) {
      Object.assign(this.penalties, customConfig.penalties);
    }
    if (customConfig.bonuses) {
      Object.assign(this.bonuses, customConfig.bonuses);
    }
  }
};

export default ScoringConfig;
