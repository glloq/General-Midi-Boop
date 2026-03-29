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
    programMatch: 30,      // Match du programme MIDI GM (réduit de 34)
    noteRange: 27,         // Compatibilité de plage de notes (réduit de 29)
    polyphony: 13,         // Polyphonie suffisante (réduit de 15)
    ccSupport: 5,          // Support des contrôleurs MIDI (réduit de 7)
    instrumentType: 20,    // Type d'instrument hiérarchique (augmenté de 10 → 20)
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
    allCCsSupported: 7,           // Tous les CCs supportés
    typeMatch: 10,                // Type détecté correspond (legacy)
    channel10Drums: 5,            // Canal 10 assigné à drums
    exactTypeMatch: 20,           // Type hiérarchique exact (ex: guitar ↔ guitar)
    subtypeMatch: 5,              // Sous-type exact en plus
    sameFamilyMatch: 12           // Même famille (ex: reed ↔ pipe = bois)
  },

  /**
   * Configuration specifique percussion / canal 10 (index 9)
   */
  percussion: {
    drumChannelNonDrumPenalty: -20,    // Instrument non-drum assigne au canal 9
    nonDrumChannelDrumPenalty: -15,    // Instrument drum-only assigne a un canal non-9
    drumChannelDrumBonus: 15,          // Instrument drum assigne au canal 9 (remplace ancien +5)
    drumChannelWeights: {
      programMatch: 10,       // Reduit (drums n'utilisent pas les programmes GM standard sur ch10)
      noteRange: 37,          // Augmente (qualite du mapping drum est critique)
      polyphony: 10,          // Reduit (drums = polyphonie limitee)
      ccSupport: 5,           // Faible impact pour drums
      instrumentType: 23,     // Augmente (type match critique pour drums)
      channelSpecial: 15      // Augmente (bonus canal drums)
    }
  },

  /**
   * Configuration du channel splitting
   */
  splitting: {
    minQuality: 50,               // Score minimum pour proposer un split
    minInstruments: 2,            // Minimum d'instruments pour un split
    maxInstruments: 4,            // Maximum d'instruments dans un split
    weights: {
      noteCoverage: 40,           // Couverture des notes du canal
      polyphonyCoverage: 25,      // Polyphonie combinée suffisante
      minimalCuts: 20,            // Moins de coupures = mieux
      minimalOverlap: 15          // Recouvrement minimal entre instruments
    },
    // Score minimum du canal pour déclencher l'évaluation de split
    triggerBelowScore: 60,
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
   * Obtenir le poids d'un critere pour le canal drums (canal 9)
   * @param {string} criterion
   * @returns {number}
   */
  getDrumWeight(criterion) {
    return (this.percussion && this.percussion.drumChannelWeights &&
            this.percussion.drumChannelWeights[criterion]) || this.weights[criterion] || 0;
  },

  /**
   * Obtenir une penalite/bonus percussion
   * @param {string} key
   * @returns {number}
   */
  getPercussionValue(key) {
    return (this.percussion && this.percussion[key]) || 0;
  },

};

export default ScoringConfig;
