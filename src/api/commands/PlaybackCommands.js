// src/api/commands/PlaybackCommands.js
import MidiTransposer from '../../midi/MidiTransposer.js';
import JsonMidiConverter from '../../storage/JsonMidiConverter.js';
import InstrumentCapabilitiesValidator from '../../midi/InstrumentCapabilitiesValidator.js';
import ScoringConfig from '../../midi/ScoringConfig.js';
import { ValidationError, NotFoundError, ConfigurationError, MidiError } from '../../core/errors/index.js';

// Lazily-created converter instance per app (keyed by app reference)
const converterCache = new WeakMap();

function getMidiConverter(app) {
  if (!converterCache.has(app)) {
    converterCache.set(app, new JsonMidiConverter(app.logger));
  }
  return converterCache.get(app);
}

async function playbackStart(app, data) {
  // Load file first
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  app.logger.info(`Loading file ${data.fileId} for playback...`);
  const fileInfo = await app.midiPlayer.loadFile(data.fileId);

  // Auto-load saved channel routings from database (if any exist for this file)
  let loadedRoutings = 0;
  try {
    const savedRoutings = app.database.getRoutingsByFile(data.fileId);
    if (savedRoutings.length > 0) {
      app.midiPlayer.clearChannelRouting();
      for (const routing of savedRoutings) {
        if (routing.channel !== null && routing.channel !== undefined && routing.device_id) {
          // Use persisted target_channel (instrument's actual MIDI channel) from routing record
          const targetChannel = routing.target_channel !== undefined ? routing.target_channel : routing.channel;
          app.midiPlayer.setChannelRouting(routing.channel, routing.device_id, targetChannel);
          loadedRoutings++;
        }
      }
      app.logger.info(`Auto-loaded ${loadedRoutings} channel routings from database for file ${data.fileId}`);
    }
  } catch (routingError) {
    app.logger.warn(`Failed to auto-load routings: ${routingError.message}`);
  }

  // Determine output device
  let outputDevice = data.outputDevice;

  // If no output specified, use first available output
  if (!outputDevice) {
    const devices = app.deviceManager.getDeviceList();
    const outputDevices = devices.filter(d => d.output && d.enabled);

    if (outputDevices.length === 0) {
      throw new ConfigurationError('No output devices available');
    }

    outputDevice = outputDevices[0].id;
    app.logger.info(`No output specified, using: ${outputDevice}`);
  }

  // Start playback
  app.midiPlayer.start(outputDevice);

  return {
    success: true,
    fileInfo: fileInfo,
    outputDevice: outputDevice,
    loadedRoutings: loadedRoutings
  };
}

async function playbackStop(app) {
  app.midiPlayer.stop();
  return { success: true };
}

async function playbackPause(app) {
  app.midiPlayer.pause();
  return { success: true };
}

async function playbackResume(app) {
  app.midiPlayer.resume();
  return { success: true };
}

async function playbackSeek(app, data) {
  app.midiPlayer.seek(data.position);
  return { success: true };
}

async function playbackStatus(app) {
  return app.midiPlayer.getStatus();
}

async function playbackSetLoop(app, data) {
  app.midiPlayer.setLoop(data.enabled);
  return { success: true };
}

async function playbackSetTempo(_app, _data) {
  // Future implementation
  return { success: true };
}

async function playbackTranspose(_app, _data) {
  // Future implementation
  return { success: true };
}

async function playbackSetVolume(_app, _data) {
  // Future implementation
  return { success: true };
}

async function playbackGetChannels(app) {
  return {
    channels: app.midiPlayer.getChannelRouting()
  };
}

async function playbackSetChannelRouting(app, data) {
  if (data.channel === undefined || data.channel === null) {
    throw new ValidationError('channel is required', 'channel');
  }
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const channel = parseInt(data.channel);
  if (isNaN(channel) || channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // targetChannel allows remapping source channel to instrument's actual MIDI channel
  const targetChannel = data.targetChannel !== undefined ? parseInt(data.targetChannel) : channel;
  if (isNaN(targetChannel) || targetChannel < 0 || targetChannel > 15) {
    throw new ValidationError('targetChannel must be between 0 and 15', 'channel');
  }

  app.midiPlayer.setChannelRouting(channel, data.deviceId, targetChannel);

  return {
    success: true,
    channel: data.channel,
    channelDisplay: data.channel + 1,
    deviceId: data.deviceId,
    targetChannel: targetChannel
  };
}

async function playbackClearChannelRouting(app) {
  app.midiPlayer.clearChannelRouting();
  return { success: true };
}

async function playbackMuteChannel(app, data) {
  if (data.channel === undefined) {
    throw new ValidationError('Missing channel parameter', 'channel');
  }

  const channel = parseInt(data.channel);
  if (isNaN(channel) || channel < 0 || channel > 15) {
    throw new ValidationError('Invalid channel (must be 0-15)', 'channel');
  }

  if (data.muted) {
    app.midiPlayer.muteChannel(channel);
  } else {
    app.midiPlayer.unmuteChannel(channel);
  }

  return {
    success: true,
    channel: channel,
    channelDisplay: channel + 1,
    muted: data.muted
  };
}

/**
 * Analyze a specific MIDI channel
 * @param {Object} data - { fileId, channel }
 * @returns {Object} - Channel analysis
 */
async function analyzeChannel(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }
  if (data.channel === undefined) {
    throw new ValidationError('channel is required', 'channel');
  }

  // Get MIDI file from database
  const file = app.database.getFile(data.fileId);
  if (!file) {
    throw new NotFoundError('File', data.fileId);
  }

  // Parse MIDI data
  let midiData;
  try {
    const midiConverter = getMidiConverter(app);
    const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  // Use singleton auto-assigner (with cache support)
  const analysis = app.autoAssigner.analyzeChannel(midiData, data.channel, data.fileId);

  return {
    success: true,
    channel: data.channel,
    analysis
  };
}

/**
 * Apply scoring overrides temporarily to ScoringConfig.
 * Validates and deep-merges user-provided overrides.
 * @param {Object} overrides - Partial scoring config
 * @returns {Object} - Snapshot of original config for restoration
 */
function applyScoringOverrides(overrides) {
  const original = JSON.parse(JSON.stringify({
    weights: ScoringConfig.weights,
    scoreThresholds: ScoringConfig.scoreThresholds,
    penalties: ScoringConfig.penalties,
    bonuses: ScoringConfig.bonuses,
    percussion: ScoringConfig.percussion,
    splitting: ScoringConfig.splitting
  }));

  // Weights (must sum to 100)
  if (overrides.weights) {
    const w = overrides.weights;
    const keys = ['noteRange', 'programMatch', 'instrumentType', 'polyphony', 'ccSupport'];
    for (const k of keys) {
      if (w[k] !== undefined) {
        ScoringConfig.weights[k] = Math.max(0, Math.min(100, Math.round(Number(w[k]))));
      }
    }
    // Sync bonuses with weights
    ScoringConfig.bonuses.perfectNoteRange = ScoringConfig.weights.noteRange;
    ScoringConfig.bonuses.perfectProgramMatch = ScoringConfig.weights.programMatch;
  }

  // Score thresholds
  if (overrides.scoreThresholds) {
    const t = overrides.scoreThresholds;
    if (t.acceptable !== undefined) ScoringConfig.scoreThresholds.acceptable = Math.max(0, Math.min(100, Number(t.acceptable)));
    if (t.minimum !== undefined) ScoringConfig.scoreThresholds.minimum = Math.max(0, Math.min(100, Number(t.minimum)));
  }

  // Penalties
  if (overrides.penalties) {
    const p = overrides.penalties;
    if (p.transpositionPerOctave !== undefined) ScoringConfig.penalties.transpositionPerOctave = Math.max(0, Math.min(20, Number(p.transpositionPerOctave)));
    if (p.maxTranspositionOctaves !== undefined) ScoringConfig.penalties.maxTranspositionOctaves = Math.max(1, Math.min(6, Number(p.maxTranspositionOctaves)));
  }

  // Bonuses
  if (overrides.bonuses) {
    const b = overrides.bonuses;
    if (b.sameCategoryMatch !== undefined) ScoringConfig.bonuses.sameCategoryMatch = Math.max(0, Math.min(30, Number(b.sameCategoryMatch)));
    if (b.sameFamilyMatch !== undefined) ScoringConfig.bonuses.sameFamilyMatch = Math.max(0, Math.min(25, Number(b.sameFamilyMatch)));
    if (b.exactTypeMatch !== undefined) ScoringConfig.bonuses.exactTypeMatch = Math.max(0, Math.min(30, Number(b.exactTypeMatch)));
  }

  // Percussion
  if (overrides.percussion) {
    const perc = overrides.percussion;
    if (perc.drumChannelDrumBonus !== undefined) ScoringConfig.percussion.drumChannelDrumBonus = Math.max(0, Math.min(30, Number(perc.drumChannelDrumBonus)));
    if (perc.drumChannelNonDrumPenalty !== undefined) ScoringConfig.percussion.drumChannelNonDrumPenalty = Math.max(-100, Math.min(0, Number(perc.drumChannelNonDrumPenalty)));
    if (perc.nonDrumChannelDrumPenalty !== undefined) ScoringConfig.percussion.nonDrumChannelDrumPenalty = Math.max(-100, Math.min(0, Number(perc.nonDrumChannelDrumPenalty)));
    if (perc.drumChannelWeights) {
      const dw = perc.drumChannelWeights;
      for (const k of ['noteRange', 'programMatch', 'instrumentType', 'polyphony', 'ccSupport']) {
        if (dw[k] !== undefined) ScoringConfig.percussion.drumChannelWeights[k] = Math.max(0, Math.min(100, Math.round(Number(dw[k]))));
      }
    }
  }

  // Splitting
  if (overrides.splitting) {
    const s = overrides.splitting;
    if (s.minQuality !== undefined) ScoringConfig.splitting.minQuality = Math.max(0, Math.min(100, Number(s.minQuality)));
    if (s.maxInstruments !== undefined) ScoringConfig.splitting.maxInstruments = Math.max(2, Math.min(8, Number(s.maxInstruments)));
    if (s.triggerBelowScore !== undefined) ScoringConfig.splitting.triggerBelowScore = Math.max(0, Math.min(100, Number(s.triggerBelowScore)));
  }

  return original;
}

/**
 * Restore ScoringConfig from a saved snapshot.
 */
function restoreScoringConfig(original) {
  Object.assign(ScoringConfig.weights, original.weights);
  Object.assign(ScoringConfig.scoreThresholds, original.scoreThresholds);
  Object.assign(ScoringConfig.penalties, original.penalties);
  Object.assign(ScoringConfig.bonuses, original.bonuses);
  Object.assign(ScoringConfig.percussion, original.percussion);
  if (ScoringConfig.percussion.drumChannelWeights && original.percussion.drumChannelWeights) {
    Object.assign(ScoringConfig.percussion.drumChannelWeights, original.percussion.drumChannelWeights);
  }
  Object.assign(ScoringConfig.splitting, original.splitting);
}

/**
 * Generate auto-assignment suggestions for all channels
 * @param {Object} data - { fileId, topN, minScore, scoringOverrides }
 * @returns {Object} - Suggestions for all channels
 */
async function generateAssignmentSuggestions(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  const options = {
    topN: data.topN || 5,
    minScore: data.minScore || 30,
    excludeVirtual: data.excludeVirtual || false,
    includeMatrix: data.includeMatrix || false
  };

  // Get MIDI file from database
  const file = app.database.getFile(data.fileId);
  if (!file) {
    throw new NotFoundError('File', data.fileId);
  }

  // Parse MIDI data
  let midiData;
  try {
    const midiConverter = getMidiConverter(app);
    const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  // Apply temporary scoring overrides if provided
  let originalConfig = null;
  if (data.scoringOverrides) {
    originalConfig = applyScoringOverrides(data.scoringOverrides);
    app.logger.info('Scoring overrides applied for this request');
  }

  let result;
  try {
    // Generate suggestions using singleton auto-assigner
    result = await app.autoAssigner.generateSuggestions(midiData, options);
  } finally {
    // Always restore original config
    if (originalConfig) {
      restoreScoringConfig(originalConfig);
    }
  }

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      suggestions: {},
      autoSelection: {}
    };
  }

  const response = {
    success: true,
    suggestions: result.suggestions,
    lowScoreSuggestions: result.lowScoreSuggestions || {},
    autoSelection: result.autoSelection,
    splitProposals: result.splitProposals || {},
    channelAnalyses: result.channelAnalyses,
    confidenceScore: result.confidenceScore,
    allInstruments: result.allInstruments || [],
    stats: result.stats
  };

  // Inclure les données de matrice si demandé
  if (result.matrixScores) {
    response.matrixScores = result.matrixScores;
    response.instrumentList = result.instrumentList;
  }

  return response;
}

/**
 * Apply auto-assignments (create adapted file and routings)
 * @param {Object} data - { originalFileId, assignments, createAdaptedFile }
 * @returns {Object} - Result with adapted file ID and routings
 */
async function applyAssignments(app, data) {
  if (!data.originalFileId) {
    throw new ValidationError('originalFileId is required', 'originalFileId');
  }
  if (!data.assignments) {
    throw new ValidationError('assignments is required', 'assignments');
  }

  const createAdaptedFile = data.createAdaptedFile !== false; // Default true
  const midiConverter = getMidiConverter(app);

  // Get original MIDI file
  const originalFile = app.database.getFile(data.originalFileId);
  if (!originalFile) {
    throw new NotFoundError('File', data.originalFileId);
  }

  // Parse original MIDI data
  let midiData;
  try {
    const buffer = Buffer.isBuffer(originalFile.data) ? originalFile.data : Buffer.from(originalFile.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  let adaptedFileId = null;
  let stats = null;

  // Create adapted file if requested
  if (createAdaptedFile) {
    // Build transpositions object from assignments
    const transpositions = {};
    const postProcessing = []; // Additional processing steps (compression only — needs pre-computed remapping)
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      const channelNum = parseInt(channel);
      transpositions[channelNum] = {
        semitones: assignment.transposition?.semitones || 0,
        noteRemapping: assignment.noteRemapping || null,
        suppressOutOfRange: assignment.suppressOutOfRange || false,
        noteRangeMin: assignment.noteRangeMin,
        noteRangeMax: assignment.noteRangeMax,
        // CC remapping and polyphony reduction run in the same pass
        maxPolyphony: (assignment.polyReduction && assignment.maxPolyphony) ? assignment.maxPolyphony : null,
        ccMapping: (assignment.ccRemapping && Object.keys(assignment.ccRemapping).length > 0) ? assignment.ccRemapping : null
      };
      // Note compression still needs a separate pre-computed remapping pass
      if (assignment.noteCompression && assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
        postProcessing.push({ type: 'compression', channel: channelNum, min: assignment.noteRangeMin, max: assignment.noteRangeMax });
      }
    }

    // Apply all transformations in a single pass (transposition, note remapping, CC remap, poly reduction)
    const transposer = new MidiTransposer(app.logger);
    let result = transposer.transposeChannels(midiData, transpositions);
    let adaptedMidiData = result.midiData;
    stats = result.stats;

    // Apply note compression as post-processing (generates a noteRemapping, needs separate pass)
    for (const step of postProcessing) {
      if (step.type === 'compression') {
        const compResult = transposer.compressChannel(adaptedMidiData, step.channel, step.min, step.max);
        adaptedMidiData = compResult.midiData;
        stats.notesRemapped += (compResult.stats?.notesRemapped || 0);
      }
    }

    // Apply physical channel splitting for split assignments
    // This duplicates the source channel into N separate channels in the MIDI data
    let splitStats = { channelsSplit: 0, notesMoved: 0 };
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      if (!assignment.split || !assignment.segments || assignment.segments.length < 2) continue;
      const channelNum = parseInt(channel);

      // Find free channels for the additional segments (first segment keeps source channel)
      const freeChannels = transposer.findFreeChannels(adaptedMidiData);
      const neededChannels = assignment.segments.length - 1;

      if (freeChannels.length < neededChannels) {
        app.logger.warn(
          `[ApplyAssignments] Not enough free channels for split on ch ${channelNum}: ` +
          `need ${neededChannels}, have ${freeChannels.length}. Using playback-time routing fallback.`
        );
        continue;
      }

      // Build segment mapping: first segment keeps source channel, others get free channels
      const splitSegments = assignment.segments.map((seg, i) => ({
        targetChannel: i === 0 ? channelNum : freeChannels[i - 1],
        noteMin: seg.noteRange?.min ?? 0,
        noteMax: seg.noteRange?.max ?? 127,
        gmProgram: seg.gmProgram ?? null
      }));

      const splitResult = transposer.splitChannelInFile(adaptedMidiData, channelNum, splitSegments);
      adaptedMidiData = splitResult.midiData;
      splitStats.channelsSplit++;
      splitStats.notesMoved += splitResult.stats.notesMoved;

      // Update the assignment segments with the actual target channels for routing persistence
      for (let i = 0; i < assignment.segments.length; i++) {
        assignment.segments[i]._resolvedChannel = splitSegments[i].targetChannel;
      }

      app.logger.info(
        `[ApplyAssignments] Physically split ch ${channelNum} → ` +
        `[${splitSegments.map(s => `ch${s.targetChannel}(${s.noteMin}-${s.noteMax})`).join(', ')}]`
      );
    }

    // Only create an adapted file if actual modifications were made
    // Otherwise, routings will be saved against the original file
    const hasModifications = (stats.notesChanged > 0 || stats.notesRemapped > 0 || stats.notesSuppressed > 0
      || splitStats.channelsSplit > 0);

    if (hasModifications) {
      // Convert back to MIDI binary
      let adaptedBuffer;
      try {
        adaptedBuffer = midiConverter.jsonToMidi(adaptedMidiData);
      } catch (error) {
        throw new MidiError(`Failed to convert adapted MIDI: ${error.message}`);
      }

      // Generate adaptation metadata
      const metadata = transposer.generateAdaptationMetadata(data.assignments, stats);

      // Save adapted file to database
      const adaptedFilename = originalFile.filename.replace(/\.mid$/i, '_adapted.mid');
      const adaptedFile = {
        filename: adaptedFilename,
        data: adaptedBuffer.toString('base64'),
        size: adaptedBuffer.length,
        tracks: originalFile.tracks,
        duration: originalFile.duration,
        tempo: originalFile.tempo,
        ppq: originalFile.ppq,
        uploaded_at: new Date().toISOString(),
        folder: originalFile.folder,
        is_original: false,
        parent_file_id: data.originalFileId,
        adaptation_metadata: JSON.stringify(metadata)
      };

      adaptedFileId = app.database.insertFile(adaptedFile);
      app.logger.info(`Created adapted file: ${adaptedFileId} (${adaptedFilename})`);
    } else {
      app.logger.info(`No transposition needed, saving routings against original file ${data.originalFileId}`);
    }
  }

  // Create routings in database
  const routings = [];
  const targetFileId = adaptedFileId || data.originalFileId;

  for (const [channel, assignment] of Object.entries(data.assignments)) {
    const channelNum = parseInt(channel);

    // Handle split assignments (one channel → multiple instruments)
    if (assignment.split && assignment.segments) {
      // Check if physical splitting was done (segments have _resolvedChannel)
      const physicalSplit = assignment.segments.some(s => s._resolvedChannel !== undefined);

      if (physicalSplit) {
        // Physical split: each segment is on its own MIDI channel → simple per-channel routing
        for (const seg of assignment.segments) {
          const resolvedCh = seg._resolvedChannel ?? channelNum;
          const segTargetChannel = seg.instrumentChannel !== undefined
            ? Math.max(0, Math.min(15, parseInt(seg.instrumentChannel) || 0))
            : resolvedCh;
          const routing = {
            midi_file_id: targetFileId,
            channel: resolvedCh,
            target_channel: segTargetChannel,
            device_id: seg.deviceId,
            instrument_name: seg.instrumentName,
            compatibility_score: seg.score || null,
            transposition_applied: 0,
            auto_assigned: true,
            assignment_reason: `Split ${assignment.splitMode || 'range'} from ch ${channelNum}: notes ${seg.noteRange?.min ?? '?'}-${seg.noteRange?.max ?? '?'}`,
            note_remapping: null,
            enabled: true,
            created_at: Date.now()
          };
          try {
            app.database.insertRouting(routing);
          } catch (dbError) {
            app.logger.warn(`Failed to persist routing for split segment ch ${resolvedCh}: ${dbError.message}`);
          }
          // Apply simple channel routing to MidiPlayer
          if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
            app.midiPlayer.setChannelRouting(resolvedCh, seg.deviceId, segTargetChannel);
          }
          routings.push(routing);
        }
        app.logger.info(
          `Physically split channel ${channelNum} → ${assignment.segments.map(s => `ch${s._resolvedChannel}`).join(', ')} (${assignment.splitMode})`
        );
      } else {
        // No physical split (not enough free channels) → use playback-time split routing
        const segments = assignment.segments.map(seg => {
          const segTargetChannel = seg.instrumentChannel !== undefined
            ? Math.max(0, Math.min(15, parseInt(seg.instrumentChannel) || 0))
            : channelNum;

          return {
            target_channel: segTargetChannel,
            device_id: seg.deviceId,
            instrument_name: seg.instrumentName,
            compatibility_score: seg.score || null,
            transposition_applied: 0,
            auto_assigned: true,
            assignment_reason: `Split ${assignment.splitMode || 'range'}: notes ${seg.noteRange?.min ?? '?'}-${seg.noteRange?.max ?? '?'}`,
            note_remapping: null,
            enabled: true,
            created_at: Date.now(),
            split_mode: assignment.splitMode || 'range',
            split_note_min: seg.noteRange?.min ?? null,
            split_note_max: seg.noteRange?.max ?? null,
            split_polyphony_share: seg.polyphonyShare ?? null
          };
        });

        try {
          app.database.insertSplitRoutings(targetFileId, channelNum, segments);
        } catch (dbError) {
          app.logger.warn(`Failed to persist split routings for channel ${channelNum}: ${dbError.message}`);
        }

        if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
          app.midiPlayer.setChannelSplitRouting(channelNum, segments);
        }

        routings.push(...segments.map(s => ({ ...s, midi_file_id: targetFileId, channel: channelNum })));
        app.logger.info(
          `Split channel ${channelNum} across ${segments.length} instruments using playback routing (${assignment.splitMode})`
        );
      }
      continue;
    }

    // Standard single-instrument assignment
    let instrumentTargetChannel = assignment.instrumentChannel !== undefined
      ? Math.max(0, Math.min(15, parseInt(assignment.instrumentChannel) || 0))
      : channelNum;

    const routing = {
      midi_file_id: targetFileId,
      channel: channelNum,
      target_channel: instrumentTargetChannel,
      device_id: assignment.deviceId,
      instrument_name: assignment.instrumentName,
      compatibility_score: assignment.score,
      transposition_applied: assignment.transposition?.semitones || 0,
      auto_assigned: true,
      assignment_reason: assignment.info
        ? (Array.isArray(assignment.info) ? assignment.info.join('; ') : String(assignment.info))
        : 'Auto-assigned',
      note_remapping: assignment.noteRemapping ? JSON.stringify(assignment.noteRemapping) : null,
      enabled: true,
      created_at: Date.now()
    };

    try {
      app.database.insertRouting(routing);
    } catch (dbError) {
      app.logger.warn(`Failed to persist routing for channel ${channelNum}: ${dbError.message}`);
    }
    routings.push(routing);

    if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
      app.midiPlayer.setChannelRouting(channelNum, assignment.deviceId, instrumentTargetChannel);
    }

    app.logger.info(
      `Assigned channel ${channelNum} to ${assignment.instrumentName} (score: ${assignment.score})`
    );
  }

  return {
    success: true,
    adaptedFileId,
    filename: adaptedFileId ? originalFile.filename.replace(/\.mid$/i, '_adapted.mid') : null,
    stats,
    routings
  };
}

/**
 * Valide les capacités des instruments
 * @returns {Object}
 */
async function validateInstrumentCapabilities(app) {
  const validator = new InstrumentCapabilitiesValidator();

  // Récupérer tous les instruments
  const instruments = app.database.getInstrumentsWithCapabilities();

  // Valider
  const validation = validator.validateInstruments(instruments);

  return {
    success: true,
    allValid: validation.allValid,
    validCount: validation.validCount,
    completeCount: validation.completeCount,
    totalCount: validation.totalCount,
    incompleteInstruments: validation.incomplete
  };
}

/**
 * Obtient les valeurs par défaut suggérées pour un instrument
 * @param {Object} data - { instrumentId, type }
 * @returns {Object}
 */
async function getInstrumentDefaults(app, data) {
  const validator = new InstrumentCapabilitiesValidator();

  // Récupérer l'instrument (table instruments)
  const instrument = app.database.getInstrument(data.instrumentId);

  if (!instrument) {
    throw new NotFoundError('Instrument', data.instrumentId);
  }

  // Obtenir les suggestions basées sur le type
  const defaults = validator.getSuggestedDefaults(instrument);

  // Enrichir avec les capabilities actuelles depuis instruments_latency
  let currentCapabilities = null;
  if (instrument.device_id) {
    try {
      currentCapabilities = app.database.getInstrumentCapabilities(
        instrument.device_id, instrument.channel || 0
      );
    } catch (e) {
      // Capabilities may not exist yet
    }
  }

  return {
    success: true,
    defaults,
    currentCapabilities
  };
}

/**
 * Met à jour les capacités des instruments
 * @param {Object} data - { updates: { instrumentId: { field: value, ... }, ... } }
 * @returns {Object}
 */
async function updateInstrumentCapabilities(app, data) {
  if (!data.updates) {
    throw new ValidationError('updates is required', 'updates');
  }

  const updated = [];
  const failed = [];

  for (const [instrumentId, fields] of Object.entries(data.updates)) {
    try {
      // Convertir instrumentId en nombre
      const id = parseInt(instrumentId);

      // Récupérer l'instrument
      const instrument = app.database.getInstrument(id);

      if (!instrument) {
        failed.push({
          instrumentId: id,
          error: 'Instrument not found'
        });
        continue;
      }

      // Séparer les champs selon leur type
      const basicFields = {};
      const capabilityFields = {};

      const capabilityFieldNames = ['note_range_min', 'note_range_max', 'polyphony',
                                    'note_selection_mode', 'supported_ccs', 'selected_notes'];

      for (const [field, value] of Object.entries(fields)) {
        if (capabilityFieldNames.includes(field)) {
          capabilityFields[field] = value;
        } else {
          basicFields[field] = value;
        }
      }

      // Mettre à jour les champs basiques (type, gm_program, etc.)
      if (Object.keys(basicFields).length > 0) {
        app.database.updateInstrument(id, basicFields);
      }

      // Mettre à jour les capacités
      if (Object.keys(capabilityFields).length > 0) {
        // Use channel from fields, instrument, or default to 0
        const channel = fields.channel !== undefined ? fields.channel : (instrument.channel || 0);
        app.database.updateInstrumentCapabilities(instrument.device_id, channel, capabilityFields);
      }

      updated.push(id);

      app.logger.info(`Updated capabilities for instrument ${id}: ${Object.keys(fields).join(', ')}`);

    } catch (error) {
      failed.push({
        instrumentId: parseInt(instrumentId),
        error: error.message
      });
    }
  }

  return {
    success: true,
    updated: updated.length,
    failed: failed.length,
    failedDetails: failed
  };
}

/**
 * Get saved routings for a MIDI file
 * @param {Object} data - { fileId }
 * @returns {Object} - { success, routings }
 */
async function getFileRoutings(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  const routings = app.database.getRoutingsByFile(data.fileId);

  return {
    success: true,
    routings,
    count: routings.length
  };
}

/**
 * Validate routing for a MIDI file before playback.
 * Checks each active channel for routing existence and device availability.
 * @param {Object} data - { fileId }
 * @returns {Object} - { channels, allRouted, allOnline, warnings }
 */
async function playbackValidateRouting(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  const file = app.database.getFile(data.fileId);
  if (!file) {
    throw new NotFoundError('File', data.fileId);
  }

  // Parse MIDI to find active channels
  const midiConverter = getMidiConverter(app);
  let midiData;
  try {
    const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  // Find active channels (channels with noteOn events)
  const activeChannels = new Set();
  if (midiData && midiData.tracks) {
    for (const track of midiData.tracks) {
      const events = track.events || track;
      for (const event of events) {
        if ((event.type === 'noteOn' || event.type === 'noteOff') && event.channel !== undefined) {
          activeChannels.add(event.channel);
        }
      }
    }
  }

  // Get saved routings
  const savedRoutings = app.database.getRoutingsByFile(data.fileId);
  const routingMap = new Map();
  for (const r of savedRoutings) {
    if (r.channel !== null && r.channel !== undefined) {
      routingMap.set(r.channel, r);
    }
  }

  // Get connected devices
  const deviceList = app.deviceManager?.getDeviceList?.() || [];
  const connectedDevices = new Set(deviceList.filter(d => d.output).map(d => d.id));

  // Build channel report
  const channels = [];
  const warnings = [];
  let allRouted = true;
  let allOnline = true;

  for (const channel of [...activeChannels].sort((a, b) => a - b)) {
    const routing = routingMap.get(channel);
    if (!routing || !routing.device_id) {
      channels.push({ channel, channelDisplay: channel + 1, status: 'unrouted' });
      warnings.push(`Channel ${channel + 1} has no routing`);
      allRouted = false;
      allOnline = false;
    } else {
      const deviceOnline = connectedDevices.has(routing.device_id);
      channels.push({
        channel,
        channelDisplay: channel + 1,
        status: 'routed',
        deviceId: routing.device_id,
        instrumentName: routing.instrument_name,
        deviceOnline
      });
      if (!deviceOnline) {
        warnings.push(`Channel ${channel + 1}: device "${routing.instrument_name || routing.device_id}" is offline`);
        allOnline = false;
      }
    }
  }

  return {
    success: true,
    fileId: data.fileId,
    channels,
    allRouted,
    allOnline,
    warnings
  };
}

/**
 * Set the disconnect policy for playback.
 * @param {Object} data - { policy: 'skip' | 'pause' | 'mute' }
 */
async function playbackSetDisconnectPolicy(app, data) {
  const validPolicies = ['skip', 'pause', 'mute'];
  if (!data.policy || !validPolicies.includes(data.policy)) {
    throw new ValidationError(`Invalid policy. Must be one of: ${validPolicies.join(', ')}`, 'policy');
  }
  app.midiPlayer.disconnectedPolicy = data.policy;
  app.logger.info(`Disconnect policy set to: ${data.policy}`);
  return { success: true, policy: data.policy };
}

export function register(registry, app) {
  registry.register('playback_start', (data) => playbackStart(app, data));
  registry.register('playback_stop', () => playbackStop(app));
  registry.register('playback_pause', () => playbackPause(app));
  registry.register('playback_resume', () => playbackResume(app));
  registry.register('playback_seek', (data) => playbackSeek(app, data));
  registry.register('playback_status', () => playbackStatus(app));
  registry.register('playback_set_loop', (data) => playbackSetLoop(app, data));
  registry.register('playback_set_tempo', (data) => playbackSetTempo(app, data));
  registry.register('playback_transpose', (data) => playbackTranspose(app, data));
  registry.register('playback_set_volume', (data) => playbackSetVolume(app, data));
  registry.register('playback_get_channels', () => playbackGetChannels(app));
  registry.register('playback_set_channel_routing', (data) => playbackSetChannelRouting(app, data));
  registry.register('playback_clear_channel_routing', () => playbackClearChannelRouting(app));
  registry.register('playback_mute_channel', (data) => playbackMuteChannel(app, data));
  registry.register('analyze_channel', (data) => analyzeChannel(app, data));
  registry.register('generate_assignment_suggestions', (data) => generateAssignmentSuggestions(app, data));
  registry.register('apply_assignments', (data) => applyAssignments(app, data));
  registry.register('validate_instrument_capabilities', (_data) => validateInstrumentCapabilities(app));
  registry.register('get_instrument_defaults', (data) => getInstrumentDefaults(app, data));
  registry.register('update_instrument_capabilities', (data) => updateInstrumentCapabilities(app, data));
  registry.register('get_file_routings', (data) => getFileRoutings(app, data));
  registry.register('playback_validate_routing', (data) => playbackValidateRouting(app, data));
  registry.register('playback_set_disconnect_policy', (data) => playbackSetDisconnectPolicy(app, data));
}
