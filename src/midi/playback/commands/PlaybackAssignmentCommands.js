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
import InstrumentCapabilitiesValidator from '../../adaptation/InstrumentCapabilitiesValidator.js';
import InstrumentMatcher from '../../adaptation/InstrumentMatcher.js';
import {
  ValidationError,
  NotFoundError,
  MidiError,
  ConflictError
} from '../../../core/errors/index.js';
import { getMidiConverter } from './midiConverterCache.js';
import { getFileWriteLock } from '../../../files/FileWriteLock.js';
import { computeRoutingStatus } from '../../files/FileRoutingStatusService.js';

/**
 * Build a per-channel hand-position feasibility summary for an apply
 * cycle's routings. Re-runs the matcher's heuristic so the response
 * carries the same `level` taxonomy ('unknown' | 'ok' | 'warning' |
 * 'infeasible') the UI already speaks (see C.1 toast, C.3 badge).
 * Failures are swallowed: a missing capability row, an absent
 * adaptation service, or a malformed `hands_config` should never
 * abort the apply — they just yield a `level: 'unknown'` entry.
 *
 * Exported for direct unit testing.
 *
 * @param {Object} app
 * @param {Object} midiData
 * @param {Object} assignments - The same `data.assignments` map.
 * @returns {Array<{channel:number, deviceId:?string, instrumentName:?string,
 *                  level:string, summary:Object, message:?string}>}
 */
export function buildHandPositionWarnings(app, midiData, assignments) {
  const out = [];
  if (!app?.instrumentRepository?.getCapabilities) return out;
  const matcher = new InstrumentMatcher(app.logger);

  for (const [channelKey, assignment] of Object.entries(assignments || {})) {
    const channel = parseInt(channelKey, 10);
    if (!Number.isFinite(channel)) continue;

    // Resolve channel analysis lazily (cheap memoization within the loop)
    let analysis = null;
    const getAnalysis = () => {
      if (analysis) return analysis;
      try {
        analysis = app.adaptationService?.analyzeChannel?.(midiData, channel) || null;
      } catch (_) {
        analysis = null;
      }
      return analysis;
    };

    // Iterate every (deviceId, targetChannel) pair this assignment routes
    // to. Split assignments contribute one entry per segment so the UI
    // can highlight infeasibility on a specific destination.
    const targets = [];
    if (assignment.split && Array.isArray(assignment.segments)) {
      for (const seg of assignment.segments) {
        if (!seg?.deviceId) continue;
        targets.push({
          deviceId: seg.deviceId,
          targetChannel: seg.instrumentChannel ?? channel,
          instrumentName: seg.instrumentName || null,
          segmentLabel: seg.noteRange ? `notes ${seg.noteRange.min}-${seg.noteRange.max}` : null
        });
      }
    } else if (assignment.deviceId) {
      targets.push({
        deviceId: assignment.deviceId,
        targetChannel: assignment.instrumentChannel ?? channel,
        instrumentName: assignment.instrumentName || null,
        segmentLabel: null
      });
    }

    for (const target of targets) {
      let caps = null;
      try {
        caps = app.instrumentRepository.getCapabilities(target.deviceId, target.targetChannel);
      } catch (_) {
        /* leave caps null → level 'unknown' */
      }

      const channelAnalysis = getAnalysis();
      const feasibility =
        caps && channelAnalysis
          ? matcher._scoreHandPositionFeasibility(channelAnalysis, caps)
          : { level: 'unknown', qualityScore: 0, summary: {}, info: null, issue: null };

      out.push({
        channel,
        deviceId: target.deviceId,
        instrumentName: target.instrumentName,
        segmentLabel: target.segmentLabel,
        level: feasibility.level,
        qualityScore: feasibility.qualityScore,
        summary: feasibility.summary || {},
        message: feasibility.issue?.message || feasibility.info || null
      });
    }
  }

  return out;
}

/**
 * Locate the adapted child previously produced for `originalFileId`, if any.
 *
 * Extracted so the optimistic-concurrency snapshot and the write path agree on
 * *exactly* which row is the adapted file — a disagreement between the two
 * would either miss a conflict or invent one.
 *
 * @param {Object} app
 * @param {Object} originalFile - Row of the original (for its folder).
 * @param {(string|number)} originalFileId
 * @returns {?Object} The adapted row, or `null`.
 */
function findExistingAdaptedFile(app, originalFile, originalFileId) {
  if (!originalFile) return null;
  try {
    const siblings = app.fileRepository.findByFolder(originalFile.folder) || [];
    return siblings.find((f) => f.parent_file_id === originalFileId && f.is_original === 0) || null;
  } catch (e) {
    app.logger?.debug?.('Could not check for existing adapted file', e);
    return null;
  }
}

/**
 * Stable fingerprint of the routing rows an apply would REPLACE for `fileId`
 * (`deleteActiveAutoByFileId` clears exactly `enabled=1 AND auto_assigned=1`).
 *
 * Volatile columns (`id`, `created_at`) are excluded so re-reading an unchanged
 * set always yields the same token. Manual and disabled routings are excluded
 * because apply never touches them — including them would raise conflicts for
 * edits that cannot collide.
 *
 * @param {Object} app
 * @param {(string|number)} fileId
 * @returns {string}
 */
function routingFingerprint(app, fileId) {
  let rows;
  try {
    rows = app.routingRepository.findByFileId(fileId) || [];
  } catch (e) {
    app.logger?.debug?.(`Could not fingerprint routings for file ${fileId}: ${e.message}`);
    return 'unavailable';
  }
  const parts = rows
    .filter((r) => r.auto_assigned && r.enabled)
    .map((r) =>
      [
        r.channel,
        r.target_channel,
        r.device_id,
        r.transposition_applied ?? 0,
        r.split_mode ?? '',
        r.split_note_min ?? '',
        r.split_note_max ?? '',
        r.split_polyphony_share ?? '',
        r.note_remapping ? JSON.stringify(r.note_remapping) : ''
      ].join('|')
    )
    .sort();
  return `${parts.length}:${parts.join(';')}`;
}

/**
 * Version token covering everything one `apply_assignments` may overwrite for a
 * given original file: the original's bytes, the adapted child's identity and
 * bytes, and the auto-assigned routing set of whichever of the two is the write
 * target.
 *
 * @param {Object} app
 * @param {(string|number)} originalFileId
 * @returns {{originalHash:?string, adaptedFileId:?(string|number),
 *   adaptedHash:?string, routings:string}}
 */
function snapshotApplyTargets(app, originalFileId) {
  let originalFile = null;
  try {
    originalFile = app.fileRepository.findById(originalFileId) || null;
  } catch (e) {
    app.logger?.debug?.(`Could not snapshot file ${originalFileId}: ${e.message}`);
  }
  const adapted = findExistingAdaptedFile(app, originalFile, originalFileId);
  return {
    originalHash: originalFile ? originalFile.content_hash : null,
    adaptedFileId: adapted ? adapted.id : null,
    adaptedHash: adapted ? adapted.content_hash : null,
    routings: routingFingerprint(app, adapted ? adapted.id : originalFileId)
  };
}

/**
 * Name the first field that moved between two snapshots, or `null` when they
 * are identical.
 *
 * @param {Object} before
 * @param {Object} after
 * @returns {?string}
 */
function snapshotDrift(before, after) {
  for (const key of ['originalHash', 'adaptedFileId', 'adaptedHash', 'routings']) {
    if (before[key] !== after[key]) return key;
  }
  return null;
}

/**
 * Apply a user-selected auto-assignment plan: optionally produce an
 * adapted MIDI file (transpose / remap / compress / poly-reduce / CC
 * remap) and persist a routing row per channel so future playbacks
 * pick the same destinations.
 *
 * **Concurrency (audit F-76 / F-77).** The body below is a read-modify-write
 * with `await` points in the middle, so two clients — the perfectly banal "two
 * browser tabs" case — used to interleave: the audit measured `+5` and `+7`
 * producing a file at `+12`, with `success: true` returned to *both*, and
 * `+5` / `−5` silently restoring the original. Two mechanisms close it here:
 *
 *   1. a **per-file mutex**: the whole read→transform→write→routings sequence
 *      is one critical section, so nothing can slip between the read and the
 *      write;
 *   2. **optimistic version control**: the version token of everything this
 *      call may overwrite is snapshotted *before* the lock (synchronously, i.e.
 *      before any other apply can have written) and re-checked once the lock is
 *      held. If it moved, this call's plan was computed from bytes that no
 *      longer exist — it is refused with a {@link ConflictError} and writes
 *      nothing, instead of stacking its transform on someone else's output.
 *
 * A conflict can only fire between applies that were *both in flight*: a
 * sequential re-apply snapshots after the previous one finished, so it sees no
 * drift and proceeds exactly as before.
 *
 * @param {Object} app
 * @param {{originalFileId:(string|number),
 *   assignments:Object<string, Object>,
 *   createAdaptedFile?:boolean,
 *   overwriteOriginal?:boolean}} data
 * @returns {Promise<Object>} Operation summary including any warnings,
 *   the adapted file id (when generated), and applied routing count.
 * @throws {ValidationError|NotFoundError|MidiError|ConflictError}
 */
async function applyAssignments(app, data) {
  if (!data.originalFileId) {
    throw new ValidationError('originalFileId is required', 'originalFileId');
  }
  if (!data.assignments) {
    throw new ValidationError('assignments is required', 'assignments');
  }

  // Snapshot SYNCHRONOUSLY, before the first `await`. This is the whole point:
  // a concurrent apply cannot have written yet, so a stale plan is provably
  // stale by the time we hold the lock.
  const baseline = snapshotApplyTargets(app, data.originalFileId);

  const release = await getFileWriteLock(app).acquire(data.originalFileId);
  try {
    return await applyAssignmentsLocked(app, data, baseline);
  } finally {
    release();
  }
}

/**
 * The apply itself, executed while holding the per-file write lock.
 *
 * @param {Object} app
 * @param {Object} data - Same payload as {@link applyAssignments}.
 * @param {Object} baseline - Version token captured before the lock.
 * @returns {Promise<Object>}
 * @throws {ValidationError|NotFoundError|MidiError|ConflictError}
 */
async function applyAssignmentsLocked(app, data, baseline) {
  const createAdaptedFile = data.createAdaptedFile !== false;
  const overwriteOriginal = data.overwriteOriginal === true;
  const warnings = [];
  const midiConverter = getMidiConverter(app);

  const originalFile = app.fileRepository.findById(data.originalFileId);
  if (!originalFile) {
    throw new NotFoundError('File', data.originalFileId);
  }

  // Compare-and-swap: refuse rather than write on top of a concurrent apply.
  // Nothing has been written at this point, so the caller can safely reload and
  // retry — and, crucially, it LEARNS instead of receiving a success that lies.
  const current = snapshotApplyTargets(app, data.originalFileId);
  const drift = snapshotDrift(baseline, current);
  if (drift) {
    throw new ConflictError(
      `File ${data.originalFileId} was modified by a concurrent assignment apply ` +
        `(${drift} changed); nothing was written. Reload the file and apply again.`,
      { resource: `midi_file:${data.originalFileId}`, expected: baseline, actual: current }
    );
  }

  let midiData;
  try {
    const buffer = app.blobStore.read(originalFile.blob_path);
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  let adaptedFileId = null;
  let stats = null;
  // True once transpose/remap have been BAKED into the target file's bytes.
  // The routing rows must then NOT also carry transposition_applied /
  // note_remapping, or the runtime player would apply the shift a SECOND time
  // on top of the baked notes — sending them octaves off and out of the
  // instrument's range (audit P0 — double application). Runtime routing params
  // are only for the un-baked case (createAdaptedFile=false).
  let adaptationBaked = false;

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
        maxPolyphony:
          assignment.polyReduction && assignment.maxPolyphony ? assignment.maxPolyphony : null,
        polyStrategy: assignment.polyStrategy || 'drop',
        ccMapping:
          assignment.ccRemapping && Object.keys(assignment.ccRemapping).length > 0
            ? assignment.ccRemapping
            : null
      };
      if (
        assignment.noteCompression &&
        assignment.noteRangeMin != null &&
        assignment.noteRangeMax != null
      ) {
        postProcessing.push({
          type: 'compression',
          channel: channelNum,
          min: assignment.noteRangeMin,
          max: assignment.noteRangeMax
        });
      }
    }

    const adaptation = app.adaptationService;
    let result = adaptation.transposeChannels(midiData, transpositions);
    let adaptedMidiData = result.midiData;
    stats = result.stats;

    for (const step of postProcessing) {
      if (step.type === 'compression') {
        const compResult = adaptation.compressChannel(
          adaptedMidiData,
          step.channel,
          step.min,
          step.max
        );
        adaptedMidiData = compResult.midiData;
        stats.notesRemapped += compResult.stats?.notesRemapped || 0;
      }
    }

    let splitStats = { channelsSplit: 0, notesMoved: 0 };
    for (const [channel, assignment] of Object.entries(data.assignments)) {
      if (!assignment.split || !assignment.segments || assignment.segments.length < 2) continue;
      const channelNum = parseInt(channel);

      if (assignment.behaviorMode === 'overflow' || assignment.behaviorMode === 'alternate')
        continue;

      const freeChannels = adaptation.findFreeChannels(adaptedMidiData);
      const neededChannels = assignment.segments.length - 1;

      if (freeChannels.length < neededChannels) {
        const msg =
          `Channel ${channelNum + 1}: not enough free MIDI channels for physical split ` +
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
          `[${splitSegments.map((s) => `ch${s.targetChannel}(${s.noteMin}-${s.noteMax})`).join(', ')}]`
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
          if (track.events?.some((e) => (e.channel ?? -1) === targetCh)) {
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

    const hasModifications =
      stats.notesChanged > 0 ||
      stats.notesRemapped > 0 ||
      stats.notesSuppressed > 0 ||
      stats.notesDropped > 0 ||
      stats.notesShortened > 0 ||
      stats.ccsRemapped > 0 ||
      splitStats.channelsSplit > 0 ||
      volumeEventsInjected > 0;

    if (hasModifications) {
      let adaptedBuffer;
      try {
        adaptedBuffer = midiConverter.jsonToMidi(adaptedMidiData);
      } catch (error) {
        throw new MidiError(`Failed to convert adapted MIDI: ${error.message}`);
      }

      // Persist the adapted bytes through FileManager so they actually reach
      // disk (BlobStore) with a fresh content_hash + recomputed metadata. The
      // previous code handed a base64 `data` field to the DB layer, whose
      // column whitelist dropped it — the adapted file was never stored and
      // playback kept using the original (audit P1 — adapted file lost).
      if (!app.fileManager) {
        throw new MidiError('FileManager unavailable — cannot persist adapted file');
      }

      if (overwriteOriginal) {
        try {
          await app.fileManager.replaceFileBytes(data.originalFileId, adaptedBuffer);
          adaptedFileId = null;
          app.logger.info(`Overwritten original file ${data.originalFileId} with adapted data`);
        } catch (e) {
          throw new MidiError(`Failed to overwrite original file: ${e.message}`);
        }
      } else {
        const adaptedFilename = originalFile.filename.replace(/\.mid$/i, '_adapted.mid');

        // Same lookup the concurrency snapshot uses — they MUST agree on which
        // row is "the adapted file" or the conflict check would be blind to it.
        const existingAdapted = findExistingAdaptedFile(app, originalFile, data.originalFileId);
        const existingAdaptedId = existingAdapted ? existingAdapted.id : null;

        try {
          if (existingAdaptedId) {
            await app.fileManager.replaceFileBytes(existingAdaptedId, adaptedBuffer);
            adaptedFileId = existingAdaptedId;
            app.logger.info(`Updated existing adapted file: ${adaptedFileId} (${adaptedFilename})`);
          } else {
            const created = await app.fileManager.createDerivedFile(
              adaptedFilename,
              adaptedBuffer,
              {
                folder: originalFile.folder,
                parentFileId: data.originalFileId
              }
            );
            adaptedFileId = created.fileId;
            app.logger.info(`Created adapted file: ${adaptedFileId} (${adaptedFilename})`);
          }
        } catch (e) {
          throw new MidiError(`Failed to persist adapted file: ${e.message}`);
        }
      }
      // Transpose/remap are now baked into the target file's bytes → routing
      // rows must not re-apply them at runtime (audit P0 — double application).
      adaptationBaked = true;
    } else {
      app.logger.info(
        `No transposition needed, saving routings against original file ${data.originalFileId}`
      );
    }
  }

  const routings = [];
  const failedChannels = [];
  const targetFileId = adaptedFileId || data.originalFileId;

  // Re-apply replaces this file's ACTIVE auto-assigned routing set. Clear only
  // the enabled auto-assigned rows first so that (a) switching a channel from
  // split→single doesn't leave orphan split rows behind — the non-split upsert's
  // partial index only matches `split_mode IS NULL`, so it can't overwrite a
  // split row — and (b) a channel removed from the selection doesn't keep a
  // stale routing (audit P1-6). Scoping to `enabled=1 AND auto_assigned=1`
  // preserves manual routings and disabled offline-preserved ones (audit review:
  // a blanket delete destroyed both, incl. the P2-3 offline-preserved routing).
  // A freshly created adapted file has no rows yet, so this is a no-op there.
  // NOTE: the writes below are not yet wrapped in a single transaction
  // (saveSplit opens its own), so a mid-loop insert failure is surfaced via
  // `failedChannels` rather than rolled back — full atomicity is a follow-up (P1-8).
  try {
    app.routingRepository.deleteActiveAutoByFileId(targetFileId);
  } catch (delErr) {
    app.logger.warn(`Failed to clear prior routings for file ${targetFileId}: ${delErr.message}`);
  }

  // Runtime routing params are suppressed once the transform is baked into the
  // file (adaptationBaked); otherwise they carry the operator's choice so the
  // player applies it live on the original file (audit P0 — no double-apply).
  const runtimeSemitones = (a) => (adaptationBaked ? 0 : a.transposition?.semitones || 0);
  const runtimeRemapJson = (a) =>
    adaptationBaked || !a.noteRemapping ? null : JSON.stringify(a.noteRemapping);

  // D.1: pre-compute the hand-position feasibility per (channel, deviceId)
  // so each routing row gets persisted with its current classification.
  // The same payload is also returned at the end (D.2) so the frontend
  // can paint the C.3 badge without an extra round-trip. The lookup
  // map keys on `${channel}:${deviceId}` to support split assignments
  // where each segment has its own destination.
  const handPositionWarnings = buildHandPositionWarnings(app, midiData, data.assignments);
  const feasibilityByChannelDevice = new Map();
  for (const w of handPositionWarnings) {
    feasibilityByChannelDevice.set(`${w.channel}:${w.deviceId}`, {
      level: w.level,
      qualityScore: w.qualityScore,
      summary: w.summary,
      message: w.message
    });
  }

  for (const [channel, assignment] of Object.entries(data.assignments)) {
    const channelNum = parseInt(channel);

    if (assignment.split && assignment.segments) {
      const physicalSplit = assignment.segments.some((s) => s._resolvedChannel !== undefined);

      if (physicalSplit) {
        for (const seg of assignment.segments) {
          const resolvedCh = seg._resolvedChannel ?? channelNum;
          const segTargetChannel =
            seg.instrumentChannel !== undefined
              ? Math.max(0, Math.min(15, parseInt(seg.instrumentChannel) || 0))
              : resolvedCh;
          const routing = {
            midi_file_id: targetFileId,
            channel: resolvedCh,
            target_channel: segTargetChannel,
            device_id: seg.deviceId,
            instrument_name: seg.instrumentName,
            compatibility_score: seg.score || null,
            // Channel-level transposition — applied at runtime only when NOT
            // baked into the file (split segments share the source channel's
            // transposition).
            transposition_applied: runtimeSemitones(assignment),
            auto_assigned: true,
            assignment_reason: `Split ${assignment.splitMode || 'range'} from ch ${channelNum}: notes ${seg.noteRange?.min ?? '?'}-${seg.noteRange?.max ?? '?'}`,
            note_remapping: null,
            enabled: true,
            created_at: Date.now(),
            hand_position_feasibility:
              feasibilityByChannelDevice.get(`${channelNum}:${seg.deviceId}`) || null
          };
          try {
            app.routingRepository.save(routing);
            // Only record a routing the DB actually accepted (audit P1-8).
            routings.push(routing);
            // Live player update is best-effort — a setter throwing must not turn
            // a persisted routing into a reported failure (audit review).
            try {
              if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
                app.midiPlayer.setChannelRouting(resolvedCh, seg.deviceId, segTargetChannel);
                if (typeof app.midiPlayer.setChannelTransposition === 'function') {
                  app.midiPlayer.setChannelTransposition(resolvedCh, runtimeSemitones(assignment));
                }
              }
            } catch (playerErr) {
              app.logger.warn(
                `Live routing update failed for ch ${resolvedCh}: ${playerErr.message}`
              );
            }
          } catch (dbError) {
            app.logger.warn(
              `Failed to persist routing for split segment ch ${resolvedCh}: ${dbError.message}`
            );
            failedChannels.push(channelNum);
          }
        }
        app.logger.info(
          `Physically split channel ${channelNum} → ${assignment.segments.map((s) => `ch${s._resolvedChannel}`).join(', ')} (${assignment.splitMode})`
        );
      } else {
        const segments = assignment.segments.map((seg) => {
          const segTargetChannel =
            seg.instrumentChannel !== undefined
              ? Math.max(0, Math.min(15, parseInt(seg.instrumentChannel) || 0))
              : channelNum;

          return {
            target_channel: segTargetChannel,
            device_id: seg.deviceId,
            instrument_name: seg.instrumentName,
            compatibility_score: seg.score || null,
            // Channel-level transposition shared across split segments —
            // runtime-applied only when NOT baked into the file.
            transposition_applied: runtimeSemitones(assignment),
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
          // Only record routings the DB actually accepted (audit P1-8).
          routings.push(
            ...segments.map((s) => ({ ...s, midi_file_id: targetFileId, channel: channelNum }))
          );
          // Live player update is best-effort (audit review).
          try {
            if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
              app.midiPlayer.setChannelSplitRouting(channelNum, segments);
              if (typeof app.midiPlayer.setChannelTransposition === 'function') {
                app.midiPlayer.setChannelTransposition(channelNum, runtimeSemitones(assignment));
              }
            }
          } catch (playerErr) {
            app.logger.warn(
              `Live split-routing update failed for ch ${channelNum}: ${playerErr.message}`
            );
          }
        } catch (dbError) {
          app.logger.warn(
            `Failed to persist split routings for channel ${channelNum}: ${dbError.message}`
          );
          failedChannels.push(channelNum);
        }
        app.logger.info(
          `Split channel ${channelNum} across ${segments.length} instruments using playback routing (${assignment.splitMode})`
        );
      }
      continue;
    }

    let instrumentTargetChannel =
      assignment.instrumentChannel !== undefined
        ? Math.max(0, Math.min(15, parseInt(assignment.instrumentChannel) || 0))
        : channelNum;

    const routing = {
      midi_file_id: targetFileId,
      channel: channelNum,
      target_channel: instrumentTargetChannel,
      device_id: assignment.deviceId,
      instrument_name: assignment.instrumentName,
      compatibility_score: assignment.score,
      transposition_applied: runtimeSemitones(assignment),
      auto_assigned: true,
      assignment_reason: assignment.info
        ? Array.isArray(assignment.info)
          ? assignment.info.join('; ')
          : String(assignment.info)
        : 'Auto-assigned',
      note_remapping: runtimeRemapJson(assignment),
      enabled: true,
      created_at: Date.now(),
      hand_position_feasibility:
        feasibilityByChannelDevice.get(`${channelNum}:${assignment.deviceId}`) || null
    };

    try {
      app.routingRepository.save(routing);
      // Only record a routing the DB actually accepted (audit P1-8).
      routings.push(routing);
      // Live player update is best-effort — must not turn a persisted routing
      // into a reported failure (audit review).
      try {
        if (app.midiPlayer && app.midiPlayer.loadedFileId === targetFileId) {
          app.midiPlayer.setChannelRouting(
            channelNum,
            assignment.deviceId,
            instrumentTargetChannel
          );
          if (typeof app.midiPlayer.setChannelTransposition === 'function') {
            app.midiPlayer.setChannelTransposition(channelNum, runtimeSemitones(assignment));
          }
          if (typeof app.midiPlayer.setChannelNoteRemapping === 'function') {
            app.midiPlayer.setChannelNoteRemapping(
              channelNum,
              adaptationBaked ? null : assignment.noteRemapping || null
            );
          }
        }
      } catch (playerErr) {
        app.logger.warn(`Live routing update failed for ch ${channelNum}: ${playerErr.message}`);
      }
    } catch (dbError) {
      app.logger.warn(`Failed to persist routing for channel ${channelNum}: ${dbError.message}`);
      failedChannels.push(channelNum);
    }

    app.logger.info(
      `Assigned channel ${channelNum} to ${assignment.instrumentName} (score: ${assignment.score})`
    );
  }

  // handPositionWarnings was computed earlier (just before the
  // routings loop) so we could persist each entry alongside its
  // routing row (D.1). Reuse the same payload in the response so
  // the frontend (C.3 badge, future inspection panel) sees the
  // same level taxonomy without an extra round-trip.

  // Bake the hand-position CCs (CC22/CC23/CC24…) into the saved file so
  // the MIDI editor's CC pane can render them and the operator can tweak
  // the curve. See TODO.md "CC main absents de l'éditeur CC après routage"
  // (option A). The baker reads `targetFileId`'s `blob_path` from disk,
  // which now always reflects the content we want enriched:
  //   * createAdaptedFile=false (or no modifications): `targetFileId` is
  //     the original file, whose blob is unchanged — safe to bake CCs
  //     straight onto it.
  //   * createAdaptedFile=true with modifications: the adapted bytes were
  //     already flushed to disk above through FileManager.replaceFileBytes
  //     / createDerivedFile (both write via BlobStore and update
  //     `blob_path`), and `targetFileId` resolves to that adapted file
  //     (`adaptedFileId || originalFileId`). So the bake enriches the
  //     adapted blob, not the original.
  //
  // This previously had to be gated off for adapted files because the
  // adapted buffer was handed to the DB layer as a `data: base64` field
  // that its column whitelist silently dropped — the blob never reached
  // disk (audit P1). That persistence gap has since been fixed (see the
  // replaceFileBytes / createDerivedFile calls above), so the gate is
  // gone and the editor CC pane is populated for adapted files too.
  let bakeStats = null;
  try {
    const hasHandRouted = await _hasHandConfigRouting(app, routings);
    if (hasHandRouted && app.fileManager?.bakeAndSave) {
      const bakeResult = await app.fileManager.bakeAndSave(targetFileId);
      bakeStats = bakeResult?.stats || null;
      app.logger.info(
        `[ApplyAssignments] Baked CCs into file ${targetFileId}: +${bakeStats?.cc_events_added ?? 0} events`
      );
    }
  } catch (bakeErr) {
    const msg = `CC bake failed for file ${targetFileId}: ${bakeErr.message}`;
    app.logger.warn(`[ApplyAssignments] ${msg}`);
    warnings.push(msg);
  }

  // Surface partial persistence failures instead of silently reporting a full
  // success (audit P1-8): `routings` now contains only rows the DB accepted,
  // and `failedChannels` lists the channels whose routing was rejected.
  if (failedChannels.length > 0) {
    warnings.push(
      `${failedChannels.length} channel(s) failed to persist: ${failedChannels.join(', ')}`
    );
  }

  return {
    success: true,
    partial: failedChannels.length > 0 || undefined,
    failedChannels: failedChannels.length > 0 ? failedChannels : undefined,
    adaptedFileId,
    filename: adaptedFileId ? originalFile.filename.replace(/\.mid$/i, '_adapted.mid') : null,
    overwritten: overwriteOriginal && !adaptedFileId,
    stats,
    bakeStats,
    routings,
    handPositionWarnings,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * True when at least one persisted routing points to a destination whose
 * instrument capabilities include a `hands_config` with enabled hands.
 * Used to gate the post-apply bake step.
 *
 * @param {Object} app
 * @param {Array} routings - The routings just persisted by applyAssignments.
 * @returns {Promise<boolean>}
 * @private
 */
async function _hasHandConfigRouting(app, routings) {
  if (!Array.isArray(routings) || routings.length === 0) return false;
  const getCaps = app.instrumentRepository?.getCapabilities?.bind(app.instrumentRepository);
  if (!getCaps) return false;
  for (const r of routings) {
    if (!r?.device_id) continue;
    const target = r.target_channel ?? r.channel ?? 0;
    try {
      const caps = getCaps(r.device_id, target);
      const cfg = caps?.hands_config;
      if (cfg && cfg.enabled !== false && Array.isArray(cfg.hands) && cfg.hands.length > 0) {
        return true;
      }
    } catch {
      /* skip — missing caps is the same as "no hands_config" */
    }
  }
  return false;
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
        instrument.device_id,
        instrument.channel || 0
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
      const capabilityFieldNames = [
        'note_range_min',
        'note_range_max',
        'polyphony',
        'note_selection_mode',
        'supported_ccs',
        'selected_notes'
      ];

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
        const channel = fields.channel !== undefined ? fields.channel : instrument.channel || 0;
        app.instrumentRepository.updateCapabilities(
          instrument.device_id,
          channel,
          capabilityFields
        );
      }

      updated.push(id);
      // Refresh runtime caches that key on this event rather than the
      // capabilities fingerprint — CapabilityResolver, CompensationService,
      // MidiRouter, PlaybackScheduler, MidiClockGenerator — so mid-session
      // clamp/compensation reflect the edit immediately (audit P2-2). Matches
      // the sibling handlers in InstrumentSettingsCommands.
      if (instrument.device_id) {
        const affectedChannel =
          fields.channel !== undefined ? fields.channel : instrument.channel || 0;
        app.eventBus?.emit('instrument_settings_changed', {
          deviceId: instrument.device_id,
          channel: affectedChannel
        });
      }
      app.logger.info(
        `Updated capabilities for instrument ${id}: ${Object.keys(fields).join(', ')}`
      );
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

  // Compute summary metrics for the playlist status indicators.
  const file = app.fileRepository.findById(data.fileId);
  const statusResult = file
    ? computeRoutingStatus({ file, routings })
    : { status: 'unrouted', routedCount: 0, channelCount: 0 };

  const scores = routings
    .map((r) => r.compatibility_score)
    .filter((s) => s !== null && s !== undefined);
  const avgScore =
    scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  const transpositions = [
    ...new Set(routings.map((r) => r.transposition_applied || 0).filter((t) => t !== 0))
  ];

  return {
    success: true,
    routings,
    count: routings.length,
    status: statusResult.status,
    routedCount: statusResult.routedCount,
    channelCount: statusResult.channelCount,
    avgScore,
    transpositions
  };
}

/**
 * @param {import('../../../api/CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('apply_assignments', (data) => applyAssignments(app, data));
  registry.register('validate_instrument_capabilities', (_data) =>
    validateInstrumentCapabilities(app)
  );
  registry.register('get_instrument_defaults', (data) => getInstrumentDefaults(app, data));
  registry.register('update_instrument_capabilities', (data) =>
    updateInstrumentCapabilities(app, data)
  );
  registry.register('get_file_routings', (data) => getFileRoutings(app, data));
}
