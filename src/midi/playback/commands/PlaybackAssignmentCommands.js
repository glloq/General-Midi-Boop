/**
 * @file src/midi/playback/commands/PlaybackAssignmentCommands.js
 * @description Auto-assignment "apply" handlers extracted from
 * `PlaybackCommands.js` (P0-1.3). Translates the user's choice from the
 * suggestion UI into:
 *   - A persisted routing record per channel.
 *   - An optional adapted file (transposed, compressed, polyphony-
 *     reduced) saved alongside the original so playback can use the
 *     pre-adapted version directly.
 *
 * Also exposes capability-validation helpers used by the same UI.
 */
import { parseMidi } from 'midi-file';
import InstrumentCapabilitiesValidator from '../../adaptation/InstrumentCapabilitiesValidator.js';
import { ValidationError, NotFoundError, MidiError } from '../../../core/errors/index.js';
import { getMidiConverter } from './midiConverterCache.js';

/**
 * Apply a user-selected auto-assignment plan: optionally produce an
 * adapted MIDI file (transpose / remap / compress / poly-reduce / CC
 * remap) and persist a routing row per channel so future playbacks
 * pick the same destinations.
 *
 * @param {Object} app
 * @param {{originalFileId:(string|number),
 *   assignments:Object<string, Object>,
 *   createAdaptedFile?:boolean,
 *   overwriteOriginal?:boolean}} data
 * @returns {Promise<Object>} Operation summary including any warnings,
 *   the adapted file id (when generated), and applied routing count.
 * @throws {ValidationError|NotFoundError|MidiError}
 */
async function applyAssignments(app, data) {
  if (!data.originalFileId) {
    throw new ValidationError('originalFileId is required', 'originalFileId');
  }
  if (!data.assignments) {
    throw new ValidationError('assignments is required', 'assignments');
  }

  const createAdaptedFile = data.createAdaptedFile !== false;
  const overwriteOriginal = data.overwriteOriginal === true;
  const warnings = [];
  const midiConverter = getMidiConverter(app);

  const originalFile = app.fileRepository.findById(data.originalFileId);
  if (!originalFile) {
    throw new NotFoundError('File', data.originalFileId);
  }

  let midiData;
  try {
    const buffer = Buffer.isBuffer(originalFile.data) ? originalFile.data : Buffer.from(originalFile.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  let adaptedFileId = null;
  let stats = null;

  if (createAdaptedFile) {
    const transpositions = {};
    const postProcessing = [];
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      const channelNum = parseInt(channel);
      transpositions[channelNum] = {
        semitones: assignment.transposition?.semitones || 0,
        noteRemapping: assignment.noteRemapping || null,
        suppressOutOfRange: assignment.suppressOutOfRange || false,
        noteRangeMin: assignment.noteRangeMin,
        noteRangeMax: assignment.noteRangeMax,
        maxPolyphony: (assignment.polyReduction && assignment.maxPolyphony) ? assignment.maxPolyphony : null,
        polyStrategy: assignment.polyStrategy || 'drop',
        ccMapping: (assignment.ccRemapping && Object.keys(assignment.ccRemapping).length > 0) ? assignment.ccRemapping : null
      };
      if (assignment.noteCompression && assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
        postProcessing.push({ type: 'compression', channel: channelNum, min: assignment.noteRangeMin, max: assignment.noteRangeMax });
      }
    }

    const adaptation = app.adaptationService;
    let result = adaptation.transposeChannels(midiData, transpositions);
    let adaptedMidiData = result.midiData;
    stats = result.stats;

    for (const step of postProcessing) {
      if (step.type === 'compression') {
        const compResult = adaptation.compressChannel(adaptedMidiData, step.channel, step.min, step.max);
        adaptedMidiData = compResult.midiData;
        stats.notesRemapped += (compResult.stats?.notesRemapped || 0);
      }
    }

    let splitStats = { channelsSplit: 0, notesMoved: 0 };
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      if (!assignment.split || !assignment.segments || assignment.segments.length < 2) continue;
      const channelNum = parseInt(channel);

      if (assignment.behaviorMode === 'overflow' || assignment.behaviorMode === 'alternate') continue;

      const freeChannels = adaptation.findFreeChannels(adaptedMidiData);
      const neededChannels = assignment.segments.length - 1;

      if (freeChannels.length < neededChannels) {
        const msg = `Channel ${channelNum + 1}: not enough free MIDI channels for physical split ` +
          `(${neededChannels} needed, ${freeChannels.length} available). Using real-time routing instead.`;
        app.logger.warn(`[ApplyAssignments] ${msg}`);
        warnings.push(msg);
        continue;
      }

      const splitSegments = assignment.segments.map((seg, i) => ({
        targetChannel: i === 0 ? channelNum : freeChannels[i - 1],
        noteMin: seg.noteRange?.min ?? 0,
        noteMax: seg.noteRange?.max ?? 127,
        gmProgram: seg.gmProgram ?? null
      }));

      const splitResult = adaptation.splitChannelInFile(adaptedMidiData, channelNum, splitSegments);
      adaptedMidiData = splitResult.midiData;
      splitStats.channelsSplit++;
      splitStats.notesMoved += splitResult.stats.notesMoved;

      for (let i = 0; i < assignment.segments.length; i++) {
        assignment.segments[i]._resolvedChannel = splitSegments[i].targetChannel;
      }

      app.logger.info(
        `[ApplyAssignments] Physically split ch ${channelNum} → ` +
        `[${splitSegments.map(s => `ch${s.targetChannel}(${s.noteMin}-${s.noteMax})`).join(', ')}]`
      );
    }

    let volumeEventsInjected = 0;
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      if (assignment.channelVolume === undefined || assignment.channelVolume === 100) continue;
      const channelNum = parseInt(channel);
      const volumeValue = Math.max(0, Math.min(127, assignment.channelVolume));

      const targetChannels = [channelNum];
      if (assignment.split && assignment.segments) {
        for (const seg of assignment.segments) {
          if (seg._resolvedChannel !== undefined && seg._resolvedChannel !== channelNum) {
            targetChannels.push(seg._resolvedChannel);
          }
        }
      }

      for (const targetCh of targetChannels) {
        let targetTrack = adaptedMidiData.tracks[0];
        for (const track of adaptedMidiData.tracks) {
          if (track.events?.some(e => (e.channel ?? -1) === targetCh)) {
            targetTrack = track;
            break;
          }
        }
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

    const hasModifications = (stats.notesChanged > 0 || stats.notesRemapped > 0 || stats.notesSuppressed > 0
      || splitStats.channelsSplit > 0 || volumeEventsInjected > 0);

    if (hasModifications) {
      let adaptedBuffer;
      try {
        adaptedBuffer = midiConverter.jsonToMidi(adaptedMidiData);
      } catch (error) {
        throw new MidiError(`Failed to convert adapted MIDI: ${error.message}`);
      }

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
        try {
          app.fileRepository.update(data.originalFileId, {
            data: adaptedBuffer.toString('base64'),
            size: adaptedBuffer.length,
            tracks: adaptedMeta.tracks || originalFile.tracks,
            duration: adaptedMeta.duration || originalFile.duration,
            tempo: Math.round(adaptedMeta.tempo || originalFile.tempo),
            ppq: originalFile.ppq,
            ...(adaptedInstrumentMeta.fileMetadata || {})
          });
          adaptedFileId = null;
          app.logger.info(`Overwritten original file ${data.originalFileId} with adapted data`);
        } catch (e) {
          throw new MidiError(`Failed to overwrite original file: ${e.message}`);
        }
      } else {
        const adaptedFilename = originalFile.filename.replace(/\.mid$/i, '_adapted.mid');

        let existingAdaptedId = null;
        try {
          const existingFiles = app.fileRepository.findByFolder(originalFile.folder);
          const existingAdapted = existingFiles.find(f =>
            f.parent_file_id === data.originalFileId && f.is_original === 0
          );
          if (existingAdapted) existingAdaptedId = existingAdapted.id;
        } catch (e) { app.logger.debug('Could not check for existing adapted file', e); }

        if (existingAdaptedId) {
          app.fileRepository.update(existingAdaptedId, {
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
          adaptedFileId = app.fileRepository.save(adaptedFile);
          app.logger.info(`Created adapted file: ${adaptedFileId} (${adaptedFilename})`);
        }
      }
    } else {
      app.logger.info(`No transposition needed, saving routings against original file ${data.originalFileId}`);
    }
  }

  const routings = [];
  const targetFileId = adaptedFileId || data.originalFileId;

  for (const [channel, assignment] of Object.entries(data.assignments)) {
    const channelNum = parseInt(channel);

    if (assignment.split && assignment.segments) {
      const physicalSplit = assignment.segments.some(s => s._resolvedChannel !== undefined);

      if (physicalSplit) {
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
            app.routingRepository.save(routing);
          } catch (dbError) {
            app.logger.warn(`Failed to persist routing for split segment ch ${resolvedCh}: ${dbError.message}`);
          }
          if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
            app.midiPlayer.setChannelRouting(resolvedCh, seg.deviceId, segTargetChannel);
          }
          routings.push(routing);
        }
        app.logger.info(
          `Physically split channel ${channelNum} → ${assignment.segments.map(s => `ch${s._resolvedChannel}`).join(', ')} (${assignment.splitMode})`
        );
      } else {
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
          app.routingRepository.saveSplit(targetFileId, channelNum, segments);
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
      app.routingRepository.save(routing);
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
 * Run the {@link InstrumentCapabilitiesValidator} over every registered
 * instrument and return the aggregated report.
 *
 * @param {Object} app
 * @returns {Promise<{success:true, report:Object}>}
 */
async function validateInstrumentCapabilities(app) {
  const validator = new InstrumentCapabilitiesValidator();
  const instruments = app.instrumentRepository.findAllWithCapabilities();
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
 * Suggest default capabilities for an instrument based on its GM
 * program and family. Used by the "Add instrument" UI to pre-fill the
 * capability form.
 *
 * @param {Object} app
 * @param {{gm_program?:number}} data
 * @returns {Promise<{success:true, defaults:Object}>}
 */
async function getInstrumentDefaults(app, data) {
  const validator = new InstrumentCapabilitiesValidator();
  const instrument = app.instrumentRepository.findById(data.instrumentId);

  if (!instrument) {
    throw new NotFoundError('Instrument', data.instrumentId);
  }

  const defaults = validator.getSuggestedDefaults(instrument);

  let currentCapabilities = null;
  if (instrument.device_id) {
    try {
      currentCapabilities = app.instrumentRepository.getCapabilities(
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
 * Persist the user-edited instrument capability set. Emits
 * `instrument_settings_changed` so caches refresh.
 *
 * @param {Object} app
 * @param {Object} data - Instrument id + capability fields.
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function updateInstrumentCapabilities(app, data) {
  if (!data.updates) {
    throw new ValidationError('updates is required', 'updates');
  }

  const updated = [];
  const failed = [];

  for (const [instrumentId, fields] of Object.entries(data.updates)) {
    try {
      const id = parseInt(instrumentId);
      const instrument = app.instrumentRepository.findById(id);

      if (!instrument) {
        failed.push({ instrumentId: id, error: 'Instrument not found' });
        continue;
      }

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

      if (Object.keys(basicFields).length > 0) {
        app.instrumentRepository.update(id, basicFields);
      }

      if (Object.keys(capabilityFields).length > 0) {
        const channel = fields.channel !== undefined ? fields.channel : (instrument.channel || 0);
        app.instrumentRepository.updateCapabilities(instrument.device_id, channel, capabilityFields);
      }

      updated.push(id);
      app.logger.info(`Updated capabilities for instrument ${id}: ${Object.keys(fields).join(', ')}`);
    } catch (error) {
      failed.push({ instrumentId: parseInt(instrumentId), error: error.message });
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
 * Read every persisted routing row for a file.
 *
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<{success:true, routings:Object[]}>}
 * @throws {ValidationError}
 */
async function getFileRoutings(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  const routings = app.routingRepository.findByFileId(data.fileId);
  return { success: true, routings, count: routings.length };
}

/**
 * @param {import('../../../api/CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('apply_assignments', (data) => applyAssignments(app, data));
  registry.register('validate_instrument_capabilities', (_data) => validateInstrumentCapabilities(app));
  registry.register('get_instrument_defaults', (data) => getInstrumentDefaults(app, data));
  registry.register('update_instrument_capabilities', (data) => updateInstrumentCapabilities(app, data));
  registry.register('get_file_routings', (data) => getFileRoutings(app, data));
}
