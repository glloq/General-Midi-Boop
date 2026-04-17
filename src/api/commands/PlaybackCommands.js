// src/api/commands/PlaybackCommands.js
import { parseMidi } from 'midi-file';
import MidiTransposer from '../../midi/MidiTransposer.js';
import InstrumentCapabilitiesValidator from '../../midi/InstrumentCapabilitiesValidator.js';
import { ValidationError, NotFoundError, MidiError } from '../../core/errors/index.js';
import { register as registerPlaybackControl } from './playback/PlaybackControlCommands.js';
import { register as registerPlaybackAnalysis } from './playback/PlaybackAnalysisCommands.js';
import { getMidiConverter } from './playback/midiConverterCache.js';

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
  const overwriteOriginal = data.overwriteOriginal === true;
  const warnings = [];
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
        polyStrategy: assignment.polyStrategy || 'drop',
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

      // Overflow and alternate modes need all notes on all segments — skip physical split
      if (assignment.behaviorMode === 'overflow' || assignment.behaviorMode === 'alternate') continue;

      // Find free channels for the additional segments (first segment keeps source channel)
      const freeChannels = transposer.findFreeChannels(adaptedMidiData);
      const neededChannels = assignment.segments.length - 1;

      if (freeChannels.length < neededChannels) {
        const msg = `Channel ${channelNum + 1}: not enough free MIDI channels for physical split ` +
          `(${neededChannels} needed, ${freeChannels.length} available). Using real-time routing instead.`;
        app.logger.warn(`[ApplyAssignments] ${msg}`);
        warnings.push(msg);
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

    // Inject CC7 (volume) events at tick 0 for channels with non-default volume
    let volumeEventsInjected = 0;
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      if (assignment.channelVolume === undefined || assignment.channelVolume === 100) continue;
      const channelNum = parseInt(channel);
      const volumeValue = Math.max(0, Math.min(127, assignment.channelVolume));

      // Collect target channels: source channel + any resolved split segment channels
      const targetChannels = [channelNum];
      if (assignment.split && assignment.segments) {
        for (const seg of assignment.segments) {
          if (seg._resolvedChannel !== undefined && seg._resolvedChannel !== channelNum) {
            targetChannels.push(seg._resolvedChannel);
          }
        }
      }

      for (const targetCh of targetChannels) {
        // Find a track that has events for this channel, or fall back to track 0
        let targetTrack = adaptedMidiData.tracks[0];
        for (const track of adaptedMidiData.tracks) {
          if (track.events?.some(e => (e.channel ?? -1) === targetCh)) {
            targetTrack = track;
            break;
          }
        }
        // Prepend CC7 event at tick 0 (before any notes)
        targetTrack.events.unshift({
          type: 'controller',
          channel: targetCh,
          controller: 7,
          value: volumeValue,
          deltaTime: 0
        });
        volumeEventsInjected++;
      }
    }

    // Only create an adapted file if actual modifications were made
    // Otherwise, routings will be saved against the original file
    const hasModifications = (stats.notesChanged > 0 || stats.notesRemapped > 0 || stats.notesSuppressed > 0
      || splitStats.channelsSplit > 0 || volumeEventsInjected > 0);

    if (hasModifications) {
      // Convert back to MIDI binary
      let adaptedBuffer;
      try {
        adaptedBuffer = midiConverter.jsonToMidi(adaptedMidiData);
      } catch (error) {
        throw new MidiError(`Failed to convert adapted MIDI: ${error.message}`);
      }

      // Recalculate metadata from the adapted binary (correct track/channel counts)
      let adaptedMeta = { duration: originalFile.duration, tempo: originalFile.tempo, tracks: originalFile.tracks };
      let adaptedInstrumentMeta = {};
      try {
        const parsedAdapted = parseMidi(adaptedBuffer);
        if (parsedAdapted && app.fileManager) {
          adaptedMeta = app.fileManager.extractMetadata(parsedAdapted);
          adaptedMeta.tracks = parsedAdapted.tracks?.length || originalFile.tracks;
          adaptedInstrumentMeta = app.fileManager.extractInstrumentMetadata(parsedAdapted);
        }
      } catch (e) {
        app.logger.warn(`[ApplyAssignments] Could not recalculate adapted metadata: ${e.message}`);
      }

      if (overwriteOriginal) {
        // Overwrite the original file with adapted data
        try {
          app.database.updateFile(data.originalFileId, {
            data: adaptedBuffer.toString('base64'),
            size: adaptedBuffer.length,
            tracks: adaptedMeta.tracks || originalFile.tracks,
            duration: adaptedMeta.duration || originalFile.duration,
            tempo: Math.round(adaptedMeta.tempo || originalFile.tempo),
            ppq: originalFile.ppq,
            ...(adaptedInstrumentMeta.fileMetadata || {})
          });
          // Use original file as target for routings
          adaptedFileId = null;
          app.logger.info(`Overwritten original file ${data.originalFileId} with adapted data`);
        } catch (e) {
          throw new MidiError(`Failed to overwrite original file: ${e.message}`);
        }
      } else {
        // Create new adapted file (or update existing one if already adapted before)
        const adaptedFilename = originalFile.filename.replace(/\.mid$/i, '_adapted.mid');

        // Check for existing adapted file to avoid duplicates
        let existingAdaptedId = null;
        try {
          const existingFiles = app.database.getFiles(originalFile.folder);
          const existingAdapted = existingFiles.find(f =>
            f.parent_file_id === data.originalFileId && f.is_original === 0
          );
          if (existingAdapted) existingAdaptedId = existingAdapted.id;
        } catch (e) { app.logger.debug('Could not check for existing adapted file', e); }

        if (existingAdaptedId) {
          // Update existing adapted file instead of creating a duplicate
          app.database.updateFile(existingAdaptedId, {
            data: adaptedBuffer.toString('base64'),
            size: adaptedBuffer.length,
            tracks: adaptedMeta.tracks || originalFile.tracks,
            duration: adaptedMeta.duration || originalFile.duration,
            tempo: Math.round(adaptedMeta.tempo || originalFile.tempo),
            ppq: originalFile.ppq,
            ...(adaptedInstrumentMeta.fileMetadata || {})
          });
          adaptedFileId = existingAdaptedId;
          app.logger.info(`Updated existing adapted file: ${adaptedFileId} (${adaptedFilename})`);
        } else {
          // Insert new adapted file
          const adaptedFile = {
            filename: adaptedFilename,
            data: adaptedBuffer.toString('base64'),
            size: adaptedBuffer.length,
            tracks: adaptedMeta.tracks || originalFile.tracks,
            duration: adaptedMeta.duration || originalFile.duration,
            tempo: Math.round(adaptedMeta.tempo || originalFile.tempo),
            ppq: originalFile.ppq,
            uploaded_at: new Date().toISOString(),
            folder: originalFile.folder,
            is_original: false,
            parent_file_id: data.originalFileId,
            ...(adaptedInstrumentMeta.fileMetadata || {})
          };
          adaptedFileId = app.database.insertFile(adaptedFile);
          app.logger.info(`Created adapted file: ${adaptedFileId} (${adaptedFilename})`);
        }
      }
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
            split_mode: (() => {
              const m = assignment.splitMode === 'fullCoverage' ? 'range' : assignment.splitMode;
              if (m === 'overflow' || m === 'alternate') return 'polyphony';
              return m || 'range';
            })(),
            split_note_min: seg.noteRange?.min ?? null,
            split_note_max: seg.noteRange?.max ?? null,
            split_polyphony_share: seg.polyphonyShare ?? null,
            overlap_strategy: assignment.overlapStrategy || null,
            behavior_mode: assignment.behaviorMode || null
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
    overwritten: overwriteOriginal && !adaptedFileId,
    stats,
    routings,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Validate instrument capabilities
 * @returns {Object}
 */
async function validateInstrumentCapabilities(app) {
  const validator = new InstrumentCapabilitiesValidator();

  // Retrieve all instruments
  const instruments = app.database.getInstrumentsWithCapabilities();

  // Validate
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
 * Get suggested default values for an instrument
 * @param {Object} data - { instrumentId, type }
 * @returns {Object}
 */
async function getInstrumentDefaults(app, data) {
  const validator = new InstrumentCapabilitiesValidator();

  // Retrieve the instrument (instruments table)
  const instrument = app.database.getInstrument(data.instrumentId);

  if (!instrument) {
    throw new NotFoundError('Instrument', data.instrumentId);
  }

  // Get suggestions based on the type
  const defaults = validator.getSuggestedDefaults(instrument);

  // Enrich with current capabilities from instruments_latency
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
 * Update instrument capabilities
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
      // Convert instrumentId to number
      const id = parseInt(instrumentId);

      // Retrieve the instrument
      const instrument = app.database.getInstrument(id);

      if (!instrument) {
        failed.push({
          instrumentId: id,
          error: 'Instrument not found'
        });
        continue;
      }

      // Separate fields by their type
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

      // Update basic fields (type, gm_program, etc.)
      if (Object.keys(basicFields).length > 0) {
        app.database.updateInstrument(id, basicFields);
      }

      // Update capabilities
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
  registerPlaybackControl(registry, app);
  registerPlaybackAnalysis(registry, app);
  registry.register('playback_get_channels', () => playbackGetChannels(app));
  registry.register('playback_set_channel_routing', (data) => playbackSetChannelRouting(app, data));
  registry.register('playback_clear_channel_routing', () => playbackClearChannelRouting(app));
  registry.register('playback_mute_channel', (data) => playbackMuteChannel(app, data));
  registry.register('apply_assignments', (data) => applyAssignments(app, data));
  registry.register('validate_instrument_capabilities', (_data) => validateInstrumentCapabilities(app));
  registry.register('get_instrument_defaults', (data) => getInstrumentDefaults(app, data));
  registry.register('update_instrument_capabilities', (data) => updateInstrumentCapabilities(app, data));
  registry.register('get_file_routings', (data) => getFileRoutings(app, data));
  registry.register('playback_validate_routing', (data) => playbackValidateRouting(app, data));
  registry.register('playback_set_disconnect_policy', (data) => playbackSetDisconnectPolicy(app, data));
}
