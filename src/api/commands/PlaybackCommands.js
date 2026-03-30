// src/api/commands/PlaybackCommands.js
import MidiTransposer from '../../midi/MidiTransposer.js';
import JsonMidiConverter from '../../storage/JsonMidiConverter.js';
import InstrumentCapabilitiesValidator from '../../midi/InstrumentCapabilitiesValidator.js';

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
    throw new Error('fileId is required');
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
      throw new Error('No output devices available');
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

async function playbackSetTempo(app, data) {
  // Future implementation
  return { success: true };
}

async function playbackTranspose(app, data) {
  // Future implementation
  return { success: true };
}

async function playbackSetVolume(app, data) {
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
    throw new Error('channel is required');
  }
  if (!data.deviceId) {
    throw new Error('deviceId is required');
  }

  const channel = parseInt(data.channel);
  if (isNaN(channel) || channel < 0 || channel > 15) {
    throw new Error('channel must be between 0 and 15');
  }

  // targetChannel allows remapping source channel to instrument's actual MIDI channel
  const targetChannel = data.targetChannel !== undefined ? parseInt(data.targetChannel) : channel;
  if (isNaN(targetChannel) || targetChannel < 0 || targetChannel > 15) {
    throw new Error('targetChannel must be between 0 and 15');
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
    throw new Error('Missing channel parameter');
  }

  const channel = parseInt(data.channel);
  if (isNaN(channel) || channel < 0 || channel > 15) {
    throw new Error('Invalid channel (must be 0-15)');
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
    throw new Error('fileId is required');
  }
  if (data.channel === undefined) {
    throw new Error('channel is required');
  }

  // Get MIDI file from database
  const file = app.database.getFile(data.fileId);
  if (!file) {
    throw new Error(`File not found: ${data.fileId}`);
  }

  // Parse MIDI data
  let midiData;
  try {
    const midiConverter = getMidiConverter(app);
    const buffer = Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new Error(`Failed to parse MIDI file: ${error.message}`);
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
 * Generate auto-assignment suggestions for all channels
 * @param {Object} data - { fileId, topN, minScore }
 * @returns {Object} - Suggestions for all channels
 */
async function generateAssignmentSuggestions(app, data) {
  if (!data.fileId) {
    throw new Error('fileId is required');
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
    throw new Error(`File not found: ${data.fileId}`);
  }

  // Parse MIDI data
  let midiData;
  try {
    const midiConverter = getMidiConverter(app);
    const buffer = Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new Error(`Failed to parse MIDI file: ${error.message}`);
  }

  // Generate suggestions using singleton auto-assigner
  const result = await app.autoAssigner.generateSuggestions(midiData, options);

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
    throw new Error('originalFileId is required');
  }
  if (!data.assignments) {
    throw new Error('assignments is required');
  }

  const createAdaptedFile = data.createAdaptedFile !== false; // Default true
  const midiConverter = getMidiConverter(app);

  // Get original MIDI file
  const originalFile = app.database.getFile(data.originalFileId);
  if (!originalFile) {
    throw new Error(`File not found: ${data.originalFileId}`);
  }

  // Parse original MIDI data
  let midiData;
  try {
    const buffer = Buffer.from(originalFile.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new Error(`Failed to parse MIDI file: ${error.message}`);
  }

  let adaptedFileId = null;
  let stats = null;

  // Create adapted file if requested
  if (createAdaptedFile) {
    // Build transpositions object from assignments
    const transpositions = {};
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      const channelNum = parseInt(channel);
      transpositions[channelNum] = {
        semitones: assignment.transposition?.semitones || 0,
        noteRemapping: assignment.noteRemapping || null,
        suppressOutOfRange: assignment.suppressOutOfRange || false,
        noteRangeMin: assignment.noteRangeMin,
        noteRangeMax: assignment.noteRangeMax
      };
    }

    // Apply transpositions
    const transposer = new MidiTransposer(app.logger);
    const result = transposer.transposeChannels(midiData, transpositions);
    const adaptedMidiData = result.midiData;
    stats = result.stats;

    // Only create an adapted file if actual modifications were made
    // Otherwise, routings will be saved against the original file
    const hasModifications = (stats.notesChanged > 0 || stats.notesRemapped > 0 || stats.notesSuppressed > 0);

    if (hasModifications) {
      // Convert back to MIDI binary
      let adaptedBuffer;
      try {
        adaptedBuffer = midiConverter.jsonToMidi(adaptedMidiData);
      } catch (error) {
        throw new Error(`Failed to convert adapted MIDI: ${error.message}`);
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

      // Apply split routing to MidiPlayer if currently loaded
      if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
        app.midiPlayer.setChannelSplitRouting(channelNum, segments);
      }

      routings.push(...segments.map(s => ({ ...s, midi_file_id: targetFileId, channel: channelNum })));
      app.logger.info(
        `Split channel ${channelNum} across ${segments.length} instruments (${assignment.splitMode})`
      );
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
    throw new Error(`Instrument not found: ${data.instrumentId}`);
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
    throw new Error('updates is required');
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
    throw new Error('fileId is required');
  }

  const routings = app.database.getRoutingsByFile(data.fileId);

  return {
    success: true,
    routings,
    count: routings.length
  };
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
  registry.register('validate_instrument_capabilities', (data) => validateInstrumentCapabilities(app));
  registry.register('get_instrument_defaults', (data) => getInstrumentDefaults(app, data));
  registry.register('update_instrument_capabilities', (data) => updateInstrumentCapabilities(app, data));
  registry.register('get_file_routings', (data) => getFileRoutings(app, data));
}
