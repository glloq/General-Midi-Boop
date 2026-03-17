// src/midi/AutoAssigner.js

import ChannelAnalyzer from './ChannelAnalyzer.js';
import InstrumentMatcher from './InstrumentMatcher.js';
import AnalysisCache from './AnalysisCache.js';
import ScoringConfig from './ScoringConfig.js';

/**
 * AutoAssigner - Génère des suggestions d'assignation automatique
 *
 * Pour chaque canal MIDI actif, propose les N meilleurs instruments
 * disponibles avec leurs scores de compatibilité.
 */
class AutoAssigner {
  constructor(instrumentDatabase, logger) {
    this.instrumentDatabase = instrumentDatabase;
    this.logger = logger;
    this.analyzer = new ChannelAnalyzer(logger);
    this.matcher = new InstrumentMatcher(logger);
    this.cache = new AnalysisCache(ScoringConfig.cache.maxSize, ScoringConfig.cache.ttl);

    // Cleanup périodique du cache (toutes les 5 minutes)
    this.cleanupInterval = setInterval(() => {
      this.cache.cleanup();
      const stats = this.cache.getStats();
      this.logger.debug(`Cache cleanup: ${stats.size}/${stats.maxSize} entries`);
    }, 300000);
  }

  /**
   * Génère des suggestions d'assignation pour tous les canaux
   * @param {Object} midiData - Fichier MIDI parsé
   * @param {Object} options - { topN: 3, minScore: 30 }
   * @returns {Promise<AssignmentSuggestions>}
   */
  async generateSuggestions(midiData, options = {}) {
    const { topN = 5, minScore = 30 } = options;

    try {
      // 1. Récupérer tous les instruments disponibles avec leurs capabilities
      const availableInstruments = await this.instrumentDatabase.getInstrumentsWithCapabilities();

      if (availableInstruments.length === 0) {
        this.logger.warn('No instruments available for auto-assignment');
        return {
          success: false,
          error: 'No instruments available',
          suggestions: {},
          autoSelection: {},
          channelAnalyses: []
        };
      }

      // 2. Analyser tous les canaux actifs
      const channelAnalyses = this.analyzer.analyzeAllChannels(midiData);

      if (channelAnalyses.length === 0) {
        this.logger.warn('No active channels found in MIDI file');
        return {
          success: false,
          error: 'No active channels found',
          suggestions: {},
          autoSelection: {},
          channelAnalyses: []
        };
      }

      this.logger.info(`Analyzing ${channelAnalyses.length} active channels against ${availableInstruments.length} instruments`);

      // 3. Pour chaque canal, scorer tous les instruments
      const suggestions = {};
      const lowScoreSuggestions = {};

      for (const analysis of channelAnalyses) {
        const scores = [];
        const lowScores = [];

        for (const instrument of availableInstruments) {
          const compatibility = this.matcher.calculateCompatibility(analysis, instrument);

          const entry = {
            instrument: {
              id: instrument.id,
              device_id: instrument.device_id,
              channel: instrument.channel,
              name: instrument.name || instrument.custom_name || 'Unknown',
              custom_name: instrument.custom_name,
              gm_program: instrument.gm_program,
              note_range_min: instrument.note_range_min,
              note_range_max: instrument.note_range_max,
              note_selection_mode: instrument.note_selection_mode,
              polyphony: instrument.polyphony || 16,
              sync_delay: instrument.sync_delay || 0
            },
            compatibility
          };

          if (compatibility.score >= minScore) {
            scores.push(entry);
          } else {
            lowScores.push(entry);
          }
        }

        // Trier par score décroissant et garder top N
        scores.sort((a, b) => b.compatibility.score - a.compatibility.score);
        suggestions[analysis.channel] = scores.slice(0, topN);

        // Garder aussi les instruments à bas score (triés)
        lowScores.sort((a, b) => b.compatibility.score - a.compatibility.score);
        lowScoreSuggestions[analysis.channel] = lowScores;
      }

      // 4. Sélection automatique (meilleur score par canal)
      const autoSelection = this.selectBestAssignments(suggestions, channelAnalyses);

      // 5. Calculer score de confiance global
      const confidenceScore = this.calculateConfidence(autoSelection, channelAnalyses.length);

      return {
        success: true,
        suggestions,
        lowScoreSuggestions,
        autoSelection,
        channelAnalyses,
        confidenceScore,
        stats: {
          channelCount: channelAnalyses.length,
          instrumentCount: availableInstruments.length,
          assignedChannels: Object.keys(autoSelection).length
        }
      };
    } catch (error) {
      this.logger.error(`Error generating suggestions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sélectionne le meilleur instrument pour chaque canal
   * en évitant les conflits (1 instrument par canal si possible)
   * @param {Object} suggestions
   * @param {Array} channelAnalyses
   * @returns {Object}
   */
  selectBestAssignments(suggestions, channelAnalyses) {
    const assignments = {};
    const usedInstruments = new Set();

    // Créer une map des analyses par canal
    const analysisMap = {};
    for (const analysis of channelAnalyses) {
      analysisMap[analysis.channel] = analysis;
    }

    // Trier les canaux par score du meilleur instrument (priorité aux meilleurs matchs)
    const channelsByBestScore = Object.entries(suggestions)
      .map(([channel, options]) => ({
        channel: parseInt(channel),
        bestScore: options[0]?.compatibility.score || 0,
        options,
        analysis: analysisMap[parseInt(channel)]
      }))
      .sort((a, b) => {
        // Priorité 1: Canal 9 (drums)
        if (a.channel === 9 && b.channel !== 9) return -1;
        if (b.channel === 9 && a.channel !== 9) return 1;
        // Priorité 2: Meilleur score
        return b.bestScore - a.bestScore;
      });

    // Assigner dans l'ordre de priorité
    for (const { channel, options, analysis } of channelsByBestScore) {
      // Essayer d'assigner un instrument non encore utilisé
      let selected = null;

      for (const option of options) {
        const instrumentKey = option.instrument.id;
        if (!usedInstruments.has(instrumentKey)) {
          selected = option;
          usedInstruments.add(instrumentKey);
          break;
        }
      }

      // Si tous sont utilisés, prendre le meilleur quand même
      // (permet multi-canal sur un instrument si nécessaire)
      if (!selected && options.length > 0) {
        selected = options[0];
        this.logger.info(`Channel ${channel}: Reusing instrument (all instruments already assigned)`);
      }

      if (selected) {
        assignments[channel] = {
          deviceId: selected.instrument.device_id,
          instrumentId: selected.instrument.id,
          instrumentChannel: selected.instrument.channel,
          instrumentName: selected.instrument.name,
          customName: selected.instrument.custom_name,
          score: selected.compatibility.score,
          transposition: selected.compatibility.transposition,
          noteRemapping: selected.compatibility.noteRemapping,
          octaveWrapping: selected.compatibility.octaveWrapping || null,
          octaveWrappingEnabled: selected.compatibility.octaveWrappingEnabled || false,
          octaveWrappingInfo: selected.compatibility.octaveWrappingInfo || null,
          issues: selected.compatibility.issues,
          info: selected.compatibility.info,
          channelAnalysis: {
            noteRange: analysis.noteRange,
            polyphony: analysis.polyphony,
            estimatedType: analysis.estimatedType,
            primaryProgram: analysis.primaryProgram
          }
        };
      } else {
        this.logger.warn(`No compatible instrument found for channel ${channel}`);
      }
    }

    return assignments;
  }

  /**
   * Calcule un score de confiance global (0-100)
   * Prend en compte la qualité moyenne ET le taux de réussite
   * @param {Object} autoSelection - Canaux assignés avec leurs scores
   * @param {number} totalChannels - Nombre total de canaux actifs
   * @returns {number}
   */
  calculateConfidence(autoSelection, totalChannels) {
    const scores = Object.values(autoSelection).map(a => a.score);

    if (scores.length === 0 || totalChannels === 0) {
      return 0;
    }

    // Moyenne des scores des canaux assignés
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;

    // Taux de réussite (combien de canaux ont été assignés)
    const successRate = scores.length / totalChannels;

    // Score final = qualité moyenne × taux de réussite
    // Exemple: 8/8 canaux avec score moyen 90 → 90
    // Exemple: 2/8 canaux avec score moyen 95 → 23.75
    const confidenceScore = avgScore * successRate;

    return Math.round(confidenceScore);
  }

  /**
   * Analyse un seul canal (utile pour l'API analyze_channel)
   * Utilise le cache si fileId est fourni
   * @param {Object} midiData
   * @param {number} channel
   * @param {number} [fileId] - Optionnel pour le cache
   * @returns {Object}
   */
  analyzeChannel(midiData, channel, fileId = null) {
    // Vérifier le cache si fileId fourni
    if (fileId !== null) {
      const cached = this.cache.get(fileId, channel);
      if (cached) {
        this.logger.debug(`Cache hit for file ${fileId}, channel ${channel}`);
        return cached;
      }
    }

    // Analyser le canal
    const analysis = this.analyzer.analyzeChannel(midiData, channel);

    // Stocker dans le cache si fileId fourni
    if (fileId !== null) {
      this.cache.set(fileId, channel, analysis);
      this.logger.debug(`Cache stored for file ${fileId}, channel ${channel}`);
    }

    return analysis;
  }

  /**
   * Calcule la compatibilité pour un couple canal/instrument spécifique
   * @param {Object} midiData
   * @param {number} channel
   * @param {Object} instrument
   * @param {number} [fileId] - Optionnel pour le cache
   * @returns {Object}
   */
  async calculateCompatibility(midiData, channel, instrument, fileId = null) {
    const analysis = this.analyzeChannel(midiData, channel, fileId);
    return this.matcher.calculateCompatibility(analysis, instrument);
  }

  /**
   * Invalide le cache pour un fichier
   * À appeler quand un fichier est modifié
   * @param {number} fileId
   */
  invalidateCache(fileId) {
    this.cache.invalidateFile(fileId);
    this.logger.debug(`Cache invalidated for file ${fileId}`);
  }

  /**
   * Nettoie les ressources (intervals, cache)
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }
}

export default AutoAssigner;
