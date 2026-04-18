/**
 * @file src/midi/adaptation/AutoAssigner.js
 * @description End-to-end auto-assignment orchestrator. For each active
 * channel of a MIDI file, asks {@link ChannelAnalyzer} for the channel
 * profile, runs every registered instrument through
 * {@link InstrumentMatcher}, optionally splits a channel across several
 * instruments via {@link ChannelSplitter}, and returns the top-N
 * suggestions. Heavy result objects are cached in {@link AnalysisCache}
 * keyed by `(fileId, channel, instrument-set hash)`.
 *
 * Singleton — registered as `autoAssigner`. Cleans up its cache and
 * sweep timer in {@link AutoAssigner#destroy}.
 */

import ChannelAnalyzer from '../routing/ChannelAnalyzer.js';
import InstrumentMatcher from './InstrumentMatcher.js';
import ChannelSplitter from '../routing/ChannelSplitter.js';
import AnalysisCache from '../playback/AnalysisCache.js';
import ScoringConfig from './ScoringConfig.js';
import InstrumentTypeConfig from './InstrumentTypeConfig.js';

class AutoAssigner {
  constructor(instrumentDatabase, logger) {
    this.instrumentDatabase = instrumentDatabase;
    this.logger = logger;
    this.analyzer = new ChannelAnalyzer(logger);
    this.matcher = new InstrumentMatcher(logger);
    this.splitter = new ChannelSplitter(logger);
    this.cache = new AnalysisCache(ScoringConfig.cache.maxSize, ScoringConfig.cache.ttl);

    // Periodic cache cleanup (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      this.cache.cleanup();
      const stats = this.cache.getStats();
      this.logger.debug(`Cache cleanup: ${stats.size}/${stats.maxSize} entries`);
    }, 300000);
  }

  /**
   * Generates assignment suggestions for all channels
   * @param {Object} midiData - Parsed MIDI file
   * @param {Object} options - { topN: 3, minScore: 30 }
   * @returns {Promise<AssignmentSuggestions>}
   */
  async generateSuggestions(midiData, options = {}) {
    const { topN = 5, minScore = 30, excludeVirtual = false, includeMatrix = false } = options;

    try {
      // 1. Retrieve all available instruments with their capabilities
      let availableInstruments = await this.instrumentDatabase.getInstrumentsWithCapabilities();

      // Exclude virtual instruments if disabled in settings
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

      // 2. Analyze all active channels
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

      // 3. For each channel, score all instruments
      const suggestions = {};
      const lowScoreSuggestions = {};
      // Collect all raw scores for the matrix (if requested)
      const allScoresRaw = includeMatrix ? {} : null;

      for (const analysis of channelAnalyses) {
        const scores = [];
        const lowScores = [];

        const isDrumChannel = analysis.channel === 9 || analysis.estimatedType === 'drums';
        if (includeMatrix) allScoresRaw[analysis.channel] = {};

        for (const instrument of availableInstruments) {
          // Hard filter: drums only to drums, non-drums never to drums
          // Multiple indicators for drum instruments:
          // 1. Explicit instrument_type='drums' (user-configured)
          // 2. Discrete note mode (pad-based instruments can't play melodic content)
          // 3. MIDI channel 9 (standard GM drum channel)
          // 4. GM percussive programs (112-119)
          const isDrumInstrument = instrument.instrument_type === 'drums'
            || instrument.note_selection_mode === 'discrete'
            || instrument.channel === 9
            || (instrument.gm_program >= 112 && instrument.gm_program <= 119);

          if ((isDrumChannel && !isDrumInstrument) || (!isDrumChannel && isDrumInstrument)) {
            // Mark as incompatible in the matrix
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

          // Store in raw matrix
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

        // Sort by descending score and keep top N
        scores.sort((a, b) => b.compatibility.score - a.compatibility.score);
        suggestions[analysis.channel] = scores.slice(0, topN);

        // Also keep low-score instruments (sorted)
        lowScores.sort((a, b) => b.compatibility.score - a.compatibility.score);
        lowScoreSuggestions[analysis.channel] = lowScores;
      }

      // 4. Automatic selection (best score per channel)
      const autoSelection = this.selectBestAssignments(suggestions, channelAnalyses);

      // 5. Evaluate splits for skipped or poorly scored channels
      const splitProposals = this.evaluateChannelSplits(
        channelAnalyses, autoSelection, availableInstruments
      );

      // 6. Calculate overall confidence score
      const confidenceScore = this.calculateConfidence(autoSelection, channelAnalyses.length);

      // 7. Build the matrix and instrument list (if requested)
      let matrixScores = null;
      let instrumentList = null;
      if (includeMatrix) {
        matrixScores = allScoresRaw;
        instrumentList = this._buildInstrumentList(availableInstruments);
      }

      // 8. Raw list of all instruments (for "all instruments" display)
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
   * Builds the instrument list with summarized info for the frontend
   * @param {Array} availableInstruments - All available instruments
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
   * Selects the best instrument for each channel
   * while avoiding duplicates: each instrument is assigned only once.
   * Channels without a unique available instrument are auto-skipped.
   * @param {Object} suggestions
   * @param {Array} channelAnalyses
   * @returns {Object}
   */
  selectBestAssignments(suggestions, channelAnalyses) {
    const assignments = {};
    const usedInstruments = new Set();
    const autoSkipped = new Set();

    // Create a map of analyses by channel
    const analysisMap = {};
    for (const analysis of channelAnalyses) {
      analysisMap[analysis.channel] = analysis;
    }

    const acceptableScore = ScoringConfig.scoreThresholds?.acceptable || 60;
    const allowReuse = ScoringConfig.routing?.allowInstrumentReuse !== false;
    const sharedPenalty = ScoringConfig.routing?.sharedInstrumentPenalty || 10;

    // Sort by SCARCITY of choices: channels with fewer viable options are assigned first.
    // This prevents a channel with many options from "stealing" the only good instrument from another channel.
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
        // Priority 1: Channel 9 (drums) always first
        if (a.channel === 9 && b.channel !== 9) return -1;
        if (b.channel === 9 && a.channel !== 9) return 1;
        // Priority 2: Fewer viable options = higher priority (scarcity)
        if (a.viableCount !== b.viableCount) return a.viableCount - b.viableCount;
        // Priority 3: In case of tie, best score first
        return b.bestScore - a.bestScore;
      });

    const totalChannels = channelsByScarcity.length;
    const totalInstruments = new Set(
      Object.values(suggestions).flatMap(opts => opts.map(o => o.instrument.id))
    ).size;

    this.logger.info(`Auto-assign: ${totalChannels} channels, ${totalInstruments} unique instruments available (scarcity-based ordering, reuse=${allowReuse})`);

    // -- Pass 1: unique assignment -- each instrument only once --
    const pendingChannels = []; // channels without a unique instrument
    for (const entry of channelsByScarcity) {
      const { channel, options, analysis, viableCount } = entry;
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
        pendingChannels.push(entry);
        continue;
      }

      assignments[channel] = this._buildAssignment(selected, analysis, false);
    }

    // -- Pass 2: instrument sharing for remaining channels --
    const sharedChannels = new Set();
    if (allowReuse && pendingChannels.length > 0) {
      // Map instrument -> list of channels using it (for sharedWith)
      const instrumentUsage = {};
      for (const [ch, a] of Object.entries(assignments)) {
        if (!a || typeof a !== 'object') continue;
        if (!instrumentUsage[a.instrumentId]) instrumentUsage[a.instrumentId] = [];
        instrumentUsage[a.instrumentId].push(parseInt(ch));
      }

      for (const { channel, options, analysis, viableCount } of pendingChannels) {
        // Find the best instrument even if already used
        let selected = null;
        for (const option of options) {
          selected = option;
          break; // first = best score (already sorted)
        }

        if (!selected) {
          autoSkipped.add(channel);
          this.logger.info(`Channel ${channel}: auto-skipped (no compatible instrument at all, had ${viableCount} viable options)`);
          continue;
        }

        // Build the assignment with the shared flag
        const assignment = this._buildAssignment(selected, analysis, true);
        // Apply sharing penalty to the displayed score
        assignment.score = Math.max(0, assignment.score - sharedPenalty);
        assignment.scoreBeforePenalty = selected.compatibility.score;

        // Track which channels share this instrument
        if (!instrumentUsage[selected.instrument.id]) instrumentUsage[selected.instrument.id] = [];
        instrumentUsage[selected.instrument.id].push(channel);
        assignment.sharedWith = instrumentUsage[selected.instrument.id].filter(ch => ch !== channel);

        assignments[channel] = assignment;
        sharedChannels.add(channel);
        this.logger.info(`Channel ${channel}: shared assignment → ${selected.instrument.name} (score ${selected.compatibility.score} → ${assignment.score} after penalty, shared with ch ${assignment.sharedWith.join(',')})`);
      }

      // Update sharedWith on pass 1 channels that now share
      for (const [ch, a] of Object.entries(assignments)) {
        if (!a || typeof a !== 'object' || a.shared) continue;
        const usage = instrumentUsage[a.instrumentId];
        if (usage && usage.length > 1) {
          a.sharedWith = usage.filter(c => c !== parseInt(ch));
        }
      }
    } else {
      // No sharing -- mark all pending as auto-skipped
      for (const { channel, viableCount } of pendingChannels) {
        autoSkipped.add(channel);
        this.logger.info(`Channel ${channel}: auto-skipped (no unique instrument available, ${usedInstruments.size}/${totalInstruments} instruments already assigned, had ${viableCount} viable options)`);
      }
    }

    if (autoSkipped.size > 0) {
      this.logger.info(`Auto-assign summary: ${Object.keys(assignments).length} assigned (${sharedChannels.size} shared), ${autoSkipped.size} auto-skipped`);
    } else if (sharedChannels.size > 0) {
      this.logger.info(`Auto-assign summary: ${Object.keys(assignments).length} assigned (${sharedChannels.size} shared), 0 auto-skipped`);
    }

    // Return autoSkipped as a separate property (not on the assignments dictionary
    // to avoid issues with Object.entries() iteration seeing it as a channel key)
    assignments._autoSkipped = Array.from(autoSkipped);

    return assignments;
  }

  /**
   * Builds an assignment object from a selected option
   * @param {Object} selected - Instrument option + compatibility
   * @param {Object} analysis - Channel analysis
   * @param {boolean} shared - Whether the instrument is shared with other channels
   * @returns {Object}
   */
  _buildAssignment(selected, analysis, shared) {
    return {
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
      shared: shared,
      sharedWith: [],
      channelAnalysis: {
        noteRange: analysis.noteRange,
        polyphony: analysis.polyphony,
        estimatedType: analysis.estimatedType,
        primaryProgram: analysis.primaryProgram
      }
    };
  }

  /**
   * Evaluates possible splits for unassigned or poorly scored channels
   * @param {Array} channelAnalyses
   * @param {Object} autoSelection
   * @param {Array} availableInstruments
   * @returns {Object} - { channel: SplitProposal }
   */
  evaluateChannelSplits(channelAnalyses, autoSelection, availableInstruments) {
    const splitProposals = {};
    const autoSkipped = autoSelection._autoSkipped || [];
    const triggerThreshold = ScoringConfig.splitting?.triggerBelowScore || 60;

    // Identify channels that are split candidates
    const candidateChannels = [];

    for (const analysis of channelAnalyses) {
      const ch = analysis.channel;
      const assignment = autoSelection[ch];

      // Skipped channel -> candidate
      if (autoSkipped.includes(ch)) {
        candidateChannels.push(analysis);
        continue;
      }

      // Channel assigned with low score -> candidate
      if (assignment && assignment.score < triggerThreshold) {
        candidateChannels.push(analysis);
        continue;
      }

      // Channel assigned WITH transposition when autoSplitAvoidTransposition is enabled -> candidate
      // Even if the score is acceptable, a split could avoid transposition
      if (ScoringConfig.routing.autoSplitAvoidTransposition &&
          assignment && assignment.transposition &&
          assignment.transposition.semitones !== 0 &&
          !autoSkipped.includes(ch)) {
        candidateChannels.push(analysis);
        this.logger.debug(`Channel ${ch}: candidate for split (autoSplitAvoidTransposition, transposition=${assignment.transposition.semitones}st)`);
      }
    }

    if (candidateChannels.length === 0) {
      return splitProposals;
    }

    // Group available instruments by type (hierarchical category)
    const instrumentsByType = {};
    for (const inst of availableInstruments) {
      const type = inst.instrument_type || 'unknown';
      if (type === 'unknown') continue;
      if (!instrumentsByType[type]) instrumentsByType[type] = [];
      instrumentsByType[type].push(inst);
    }

    // For each candidate channel, look for a possible split
    for (const analysis of candidateChannels) {
      // Force drums category for channel 9 (drums often have no program change, leading to 'unknown')
      let channelCategory = analysis.estimatedCategory;
      if ((analysis.channel === 9 || analysis.estimatedType === 'drums') && (!channelCategory || channelCategory === 'unknown')) {
        channelCategory = 'drums';
      }
      if (!channelCategory || channelCategory === 'unknown') continue;

      // Find instruments of the same type
      let sameType = instrumentsByType[channelCategory] || [];

      // Tier 2: expand to family if not enough instruments of the exact type
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

      // Tier 3: cross-family split -- any instrument with a compatible range
      if (sameType.length < 2 && analysis.noteRange && analysis.noteRange.min !== null) {
        const channelMin = analysis.noteRange.min;
        const channelMax = analysis.noteRange.max;
        const crossFamilyInstruments = availableInstruments.filter(inst =>
          inst.note_range_min != null && inst.note_range_max != null &&
          inst.note_range_min <= channelMax && inst.note_range_max >= channelMin &&
          inst.instrument_type !== 'drums' // Exclude drums from cross-family splits
        );
        if (crossFamilyInstruments.length >= 2) {
          sameType = crossFamilyInstruments;
          this.logger.debug(`Channel ${analysis.channel}: using cross-family split (${crossFamilyInstruments.length} instruments with compatible ranges)`);
        }
      }

      if (sameType.length < 2) continue;

      const proposal = this.splitter.evaluateAllSplits(analysis, sameType);
      if (proposal) {
        // If this channel was added specifically for autoSplitAvoidTransposition,
        // only keep the proposal if it reduces/eliminates transposition
        const assignment = autoSelection[analysis.channel];
        const wasAddedForTransposition = ScoringConfig.routing.autoSplitAvoidTransposition &&
          assignment && assignment.transposition &&
          assignment.transposition.semitones !== 0 &&
          assignment.score >= triggerThreshold &&
          !autoSkipped.includes(analysis.channel);

        if (wasAddedForTransposition) {
          const hasSegTransposition = proposal.segments.some(
            seg => seg.transposition && seg.transposition.semitones !== 0
          );
          if (hasSegTransposition) {
            this.logger.debug(
              `Channel ${analysis.channel}: split rejected (still requires transposition in segments)`
            );
            continue; // The split doesn't help avoid transposition
          }
          this.logger.info(
            `Channel ${analysis.channel}: split avoids transposition! (was ${assignment.transposition.semitones}st)`
          );
        }

        splitProposals[analysis.channel] = proposal;
        this.logger.info(
          `Channel ${analysis.channel}: split proposed (${proposal.type}, quality=${proposal.quality}, ${proposal.segments.length} segments, ${(proposal.alternatives || []).length} alternatives)`
        );
      }
    }

    return splitProposals;
  }

  /**
   * Calculates an overall confidence score (0-100)
   * Takes into account both average quality AND success rate
   * @param {Object} autoSelection - Assigned channels with their scores
   * @param {number} totalChannels - Total number of active channels
   * @returns {number}
   */
  calculateConfidence(autoSelection, totalChannels) {
    const entries = Object.values(autoSelection)
      .filter(a => typeof a === 'object' && a !== null && typeof a.score === 'number');

    if (entries.length === 0 || totalChannels === 0) {
      return 0;
    }

    // For shared channels, use the pre-penalty score if available
    const scores = entries.map(a => a.shared && a.scoreBeforePenalty != null ? a.scoreBeforePenalty : a.score);

    // Average score of assigned channels
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;

    // Success rate (how many channels were assigned)
    const successRate = entries.length / totalChannels;

    // Final score = average quality x success rate
    const confidenceScore = avgScore * successRate;

    return Math.round(confidenceScore);
  }

  /**
   * Analyzes a single channel (useful for the analyze_channel API)
   * Uses cache if fileId is provided
   * @param {Object} midiData
   * @param {number} channel
   * @param {number} [fileId] - Optional, for caching
   * @returns {Object}
   */
  analyzeChannel(midiData, channel, fileId = null) {
    // Check cache if fileId is provided
    if (fileId !== null) {
      const cached = this.cache.get(fileId, channel);
      if (cached) {
        this.logger.debug(`Cache hit for file ${fileId}, channel ${channel}`);
        return cached;
      }
    }

    // Analyze the channel
    const analysis = this.analyzer.analyzeChannel(midiData, channel);

    // Store in cache if fileId is provided
    if (fileId !== null) {
      this.cache.set(fileId, channel, analysis);
      this.logger.debug(`Cache stored for file ${fileId}, channel ${channel}`);
    }

    return analysis;
  }

  /**
   * Calculates compatibility for a specific channel/instrument pair
   * @param {Object} midiData
   * @param {number} channel
   * @param {Object} instrument
   * @param {number} [fileId] - Optional, for caching
   * @returns {Object}
   */
  async calculateCompatibility(midiData, channel, instrument, fileId = null) {
    const analysis = this.analyzeChannel(midiData, channel, fileId);
    return this.matcher.calculateCompatibility(analysis, instrument);
  }

  /**
   * Invalidates the cache for a file
   * Call when a file is modified
   * @param {number} fileId
   */
  invalidateCache(fileId) {
    this.cache.invalidateFile(fileId);
    this.logger.debug(`Cache invalidated for file ${fileId}`);
  }

  /**
   * Cleans up resources (intervals, cache)
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
