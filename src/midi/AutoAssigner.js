// src/midi/AutoAssigner.js

import ChannelAnalyzer from './ChannelAnalyzer.js';
import InstrumentMatcher from './InstrumentMatcher.js';
import ChannelSplitter from './ChannelSplitter.js';
import AnalysisCache from './AnalysisCache.js';
import ScoringConfig from './ScoringConfig.js';
import InstrumentTypeConfig from './InstrumentTypeConfig.js';

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
    this.splitter = new ChannelSplitter(logger);
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
    const { topN = 5, minScore = 30, excludeVirtual = false, includeMatrix = false } = options;

    try {
      // 1. Récupérer tous les instruments disponibles avec leurs capabilities
      let availableInstruments = await this.instrumentDatabase.getInstrumentsWithCapabilities();

      // Exclure les instruments virtuels si désactivés dans les réglages
      if (excludeVirtual) {
        availableInstruments = availableInstruments.filter(inst =>
          !inst.device_id || !inst.device_id.startsWith('virtual_')
        );
        this.logger.info(`Auto-assign: excluded virtual instruments, ${availableInstruments.length} remaining`);
      }

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
      // Collecter tous les scores bruts pour la matrice (si demandé)
      const allScoresRaw = includeMatrix ? {} : null;

      for (const analysis of channelAnalyses) {
        const scores = [];
        const lowScores = [];

        const isDrumChannel = analysis.channel === 9 || analysis.estimatedType === 'drums';
        if (includeMatrix) allScoresRaw[analysis.channel] = {};

        for (const instrument of availableInstruments) {
          // Hard filter: drums only to drums, non-drums never to drums
          const isDrumInstrument = instrument.instrument_type === 'drums'
            || (instrument.note_selection_mode === 'discrete' && instrument.instrument_type !== 'chromatic_percussion');

          if ((isDrumChannel && !isDrumInstrument) || (!isDrumChannel && isDrumInstrument)) {
            // Marquer incompatible dans la matrice
            if (includeMatrix) {
              allScoresRaw[analysis.channel][instrument.id] = {
                score: 0,
                incompatible: true,
                reason: isDrumChannel ? 'non_drum_instrument' : 'drum_instrument_on_melodic'
              };
            }
            continue;
          }

          const compatibility = this.matcher.calculateCompatibility(analysis, instrument);

          // Stocker dans la matrice brute
          if (includeMatrix) {
            allScoresRaw[analysis.channel][instrument.id] = {
              score: compatibility.score,
              transposition: compatibility.transposition,
              issues: compatibility.issues,
              incompatible: false
            };
          }

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
              sync_delay: instrument.sync_delay || 0,
              supported_ccs: instrument.supported_ccs,
              instrument_type: instrument.instrument_type
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

      // 5. Évaluer les splits pour les canaux skippés ou mal scorés
      const splitProposals = this.evaluateChannelSplits(
        channelAnalyses, autoSelection, availableInstruments
      );

      // 6. Calculer score de confiance global
      const confidenceScore = this.calculateConfidence(autoSelection, channelAnalyses.length);

      // 7. Construire la matrice et la liste d'instruments (si demandé)
      let matrixScores = null;
      let instrumentList = null;
      if (includeMatrix) {
        matrixScores = allScoresRaw;
        instrumentList = this._buildInstrumentList(availableInstruments);
      }

      // 8. Liste brute de tous les instruments (pour affichage "tous les instruments")
      const allInstruments = this._buildInstrumentList(availableInstruments);

      return {
        success: true,
        suggestions,
        lowScoreSuggestions,
        autoSelection,
        splitProposals,
        channelAnalyses,
        confidenceScore,
        allInstruments,
        matrixScores,
        instrumentList,
        stats: {
          channelCount: channelAnalyses.length,
          instrumentCount: availableInstruments.length,
          assignedChannels: Object.keys(autoSelection).length,
          splitChannels: Object.keys(splitProposals).length
        }
      };
    } catch (error) {
      this.logger.error(`Error generating suggestions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Construit la liste d'instruments avec infos résumées pour le frontend
   * @param {Array} availableInstruments - Tous les instruments disponibles
   * @returns {Array}
   */
  _buildInstrumentList(availableInstruments) {
    return availableInstruments.map(inst => ({
      id: inst.id,
      device_id: inst.device_id,
      channel: inst.channel,
      name: inst.name || inst.custom_name || 'Unknown',
      custom_name: inst.custom_name,
      gm_program: inst.gm_program,
      instrument_type: inst.instrument_type,
      instrument_subtype: inst.instrument_subtype,
      note_range_min: inst.note_range_min,
      note_range_max: inst.note_range_max,
      note_selection_mode: inst.note_selection_mode,
      selected_notes: inst.selected_notes,
      polyphony: inst.polyphony || 16,
      sync_delay: inst.sync_delay || 0,
      supported_ccs: inst.supported_ccs,
      capabilities_source: inst.capabilities_source,
      mac_address: inst.mac_address,
      usb_serial_number: inst.usb_serial_number
    }));
  }

  /**
   * Sélectionne le meilleur instrument pour chaque canal
   * en évitant les doublons : chaque instrument n'est assigné qu'une seule fois.
   * Les canaux sans instrument unique disponible sont auto-skippés.
   * @param {Object} suggestions
   * @param {Array} channelAnalyses
   * @returns {Object}
   */
  selectBestAssignments(suggestions, channelAnalyses) {
    const assignments = {};
    const usedInstruments = new Set();
    const autoSkipped = new Set();

    // Créer une map des analyses par canal
    const analysisMap = {};
    for (const analysis of channelAnalyses) {
      analysisMap[analysis.channel] = analysis;
    }

    const acceptableScore = ScoringConfig.scoreThresholds?.acceptable || 60;

    // Tri par RARETÉ de choix : les canaux avec moins d'options viables sont assignés en priorité.
    // Cela évite qu'un canal avec beaucoup d'options "vole" l'unique bon instrument d'un autre canal.
    const channelsByScarcity = Object.entries(suggestions)
      .map(([channel, options]) => {
        const ch = parseInt(channel);
        const viableCount = options.filter(o => o.compatibility.score >= acceptableScore).length;
        return {
          channel: ch,
          bestScore: options[0]?.compatibility.score || 0,
          viableCount,
          options,
          analysis: analysisMap[ch]
        };
      })
      .sort((a, b) => {
        // Priorité 1: Canal 9 (drums) toujours en premier
        if (a.channel === 9 && b.channel !== 9) return -1;
        if (b.channel === 9 && a.channel !== 9) return 1;
        // Priorité 2: Moins d'options viables = plus prioritaire (rareté)
        if (a.viableCount !== b.viableCount) return a.viableCount - b.viableCount;
        // Priorité 3: En cas d'égalité, meilleur score en premier
        return b.bestScore - a.bestScore;
      });

    const totalChannels = channelsByScarcity.length;
    const totalInstruments = new Set(
      Object.values(suggestions).flatMap(opts => opts.map(o => o.instrument.id))
    ).size;

    this.logger.info(`Auto-assign: ${totalChannels} channels, ${totalInstruments} unique instruments available (scarcity-based ordering)`);

    // Assigner dans l'ordre de rareté — chaque instrument une seule fois
    for (const { channel, options, analysis, viableCount } of channelsByScarcity) {
      let selected = null;

      for (const option of options) {
        const instrumentKey = option.instrument.id;
        if (!usedInstruments.has(instrumentKey)) {
          selected = option;
          usedInstruments.add(instrumentKey);
          break;
        }
      }

      if (!selected) {
        autoSkipped.add(channel);
        this.logger.info(`Channel ${channel}: auto-skipped (no unique instrument available, ${usedInstruments.size}/${totalInstruments} instruments already assigned, had ${viableCount} viable options)`);
        continue;
      }

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
    }

    if (autoSkipped.size > 0) {
      this.logger.info(`Auto-assign summary: ${Object.keys(assignments).length} assigned, ${autoSkipped.size} auto-skipped (not enough instruments)`);
    }

    // Attach autoSkipped info so the frontend can use it
    assignments._autoSkipped = Array.from(autoSkipped);

    return assignments;
  }

  /**
   * Évalue les splits possibles pour les canaux non-assignés ou mal scorés
   * @param {Array} channelAnalyses
   * @param {Object} autoSelection
   * @param {Array} availableInstruments
   * @returns {Object} - { channel: SplitProposal }
   */
  evaluateChannelSplits(channelAnalyses, autoSelection, availableInstruments) {
    const splitProposals = {};
    const autoSkipped = autoSelection._autoSkipped || [];
    const triggerThreshold = ScoringConfig.splitting?.triggerBelowScore || 60;

    // Identifier les canaux candidats au split
    const candidateChannels = [];

    for (const analysis of channelAnalyses) {
      const ch = analysis.channel;
      const assignment = autoSelection[ch];

      // Canal skippé → candidat
      if (autoSkipped.includes(ch)) {
        candidateChannels.push(analysis);
        continue;
      }

      // Canal assigné avec score faible → candidat
      if (assignment && assignment.score < triggerThreshold) {
        candidateChannels.push(analysis);
      }
    }

    if (candidateChannels.length === 0) {
      return splitProposals;
    }

    // Grouper les instruments disponibles par type (catégorie hiérarchique)
    const instrumentsByType = {};
    for (const inst of availableInstruments) {
      const type = inst.instrument_type || 'unknown';
      if (type === 'unknown') continue;
      if (!instrumentsByType[type]) instrumentsByType[type] = [];
      instrumentsByType[type].push(inst);
    }

    // Pour chaque canal candidat, chercher un split possible
    for (const analysis of candidateChannels) {
      const channelCategory = analysis.estimatedCategory;
      if (!channelCategory || channelCategory === 'unknown') continue;

      // Chercher les instruments du même type
      let sameType = instrumentsByType[channelCategory] || [];

      // Tier 2: élargir à la famille si pas assez d'instruments du type exact
      if (sameType.length < 2) {
        const family = InstrumentTypeConfig.getFamily(channelCategory);
        if (family) {
          const familyMembers = InstrumentTypeConfig.families[family] || [];
          const familyInstruments = [];
          for (const memberType of familyMembers) {
            if (instrumentsByType[memberType]) {
              familyInstruments.push(...instrumentsByType[memberType]);
            }
          }
          if (familyInstruments.length >= 2) {
            sameType = familyInstruments;
          }
        }
      }

      // Tier 3: split cross-famille — tout instrument avec plage compatible
      if (sameType.length < 2 && analysis.noteRange && analysis.noteRange.min !== null) {
        const channelMin = analysis.noteRange.min;
        const channelMax = analysis.noteRange.max;
        const crossFamilyInstruments = availableInstruments.filter(inst =>
          inst.note_range_min != null && inst.note_range_max != null &&
          inst.note_range_min <= channelMax && inst.note_range_max >= channelMin &&
          inst.instrument_type !== 'drums' // Exclure drums des splits cross-famille
        );
        if (crossFamilyInstruments.length >= 2) {
          sameType = crossFamilyInstruments;
          this.logger.debug(`Channel ${analysis.channel}: using cross-family split (${crossFamilyInstruments.length} instruments with compatible ranges)`);
        }
      }

      if (sameType.length < 2) continue;

      const proposal = this.splitter.evaluateAllSplits(analysis, sameType);
      if (proposal) {
        splitProposals[analysis.channel] = proposal;
        this.logger.info(
          `Channel ${analysis.channel}: split proposed (${proposal.type}, quality=${proposal.quality}, ${proposal.segments.length} segments, ${(proposal.alternatives || []).length} alternatives)`
        );
      }
    }

    return splitProposals;
  }

  /**
   * Calcule un score de confiance global (0-100)
   * Prend en compte la qualité moyenne ET le taux de réussite
   * @param {Object} autoSelection - Canaux assignés avec leurs scores
   * @param {number} totalChannels - Nombre total de canaux actifs
   * @returns {number}
   */
  calculateConfidence(autoSelection, totalChannels) {
    const scores = Object.values(autoSelection)
      .filter(a => typeof a === 'object' && a !== null && typeof a.score === 'number')
      .map(a => a.score);

    if (scores.length === 0 || totalChannels === 0) {
      return 0;
    }

    // Moyenne des scores des canaux assignés
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;

    // Taux de réussite (combien de canaux ont été assignés)
    const successRate = scores.length / totalChannels;

    // Score final = qualité moyenne × taux de réussite
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
