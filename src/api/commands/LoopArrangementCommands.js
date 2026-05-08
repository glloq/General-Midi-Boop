/**
 * @file src/api/commands/LoopArrangementCommands.js
 * @description WebSocket commands for Loop Arranger CRUD.
 *
 * Registered commands:
 *   arrangement_create / _list / _get / _update / _delete
 *   arrangement_add_track / _update_track / _delete_track
 *   arrangement_add_block / _update_block / _delete_block
 */

import { ValidationError, NotFoundError } from '../../core/errors/index.js';

// ── Arrangements ──────────────────────────────────────────────────────────────

async function arrangementCreate(app, data) {
  if (!data.name?.trim()) throw new ValidationError('name is required', 'name');
  const id = app.loopArrangementRepository.save({
    name: data.name.trim(),
    global_tempo: data.global_tempo,
    total_bars: data.total_bars
  });
  // Auto-create 3 default tracks
  for (let i = 0; i < 3; i++) {
    app.loopArrangementRepository.addTrack({ arrangement_id: id, track_index: i, label: `Track ${i + 1}` });
  }
  return { arrangementId: id };
}

async function arrangementList(app) {
  return { arrangements: app.loopArrangementRepository.findAll() };
}

async function arrangementGet(app, data) {
  if (!data.arrangementId) throw new ValidationError('arrangementId is required', 'arrangementId');
  const arr = app.loopArrangementRepository.findById(data.arrangementId);
  if (!arr) throw new NotFoundError('Arrangement', data.arrangementId);
  const tracks = app.loopArrangementRepository.findTracks(data.arrangementId);
  const blocks = app.loopArrangementRepository.findAllBlocks(data.arrangementId);
  return { arrangement: arr, tracks, blocks };
}

async function arrangementUpdate(app, data) {
  if (!data.arrangementId) throw new ValidationError('arrangementId is required', 'arrangementId');
  const arr = app.loopArrangementRepository.findById(data.arrangementId);
  if (!arr) throw new NotFoundError('Arrangement', data.arrangementId);
  const fields = {};
  ['name', 'global_tempo', 'total_bars'].forEach(k => { if (k in data) fields[k] = data[k]; });
  app.loopArrangementRepository.update(data.arrangementId, fields);
  return { success: true };
}

async function arrangementDelete(app, data) {
  if (!data.arrangementId) throw new ValidationError('arrangementId is required', 'arrangementId');
  app.loopArrangementRepository.delete(data.arrangementId);
  return { success: true };
}

// ── Tracks ────────────────────────────────────────────────────────────────────

async function arrangementAddTrack(app, data) {
  if (!data.arrangementId) throw new ValidationError('arrangementId is required', 'arrangementId');
  const tracks = app.loopArrangementRepository.findTracks(data.arrangementId);
  const trackIndex = data.track_index ?? tracks.length;
  const id = app.loopArrangementRepository.addTrack({
    arrangement_id: data.arrangementId,
    track_index: trackIndex,
    label: data.label ?? `Track ${trackIndex + 1}`,
    midi_channel: data.midi_channel
  });
  return { trackId: id };
}

async function arrangementUpdateTrack(app, data) {
  if (!data.trackId) throw new ValidationError('trackId is required', 'trackId');
  const fields = {};
  ['label', 'midi_channel'].forEach(k => { if (k in data) fields[k] = data[k]; });
  app.loopArrangementRepository.updateTrack(data.trackId, fields);
  return { success: true };
}

async function arrangementDeleteTrack(app, data) {
  if (!data.trackId) throw new ValidationError('trackId is required', 'trackId');
  app.loopArrangementRepository.deleteTrack(data.trackId);
  return { success: true };
}

// ── Blocks ────────────────────────────────────────────────────────────────────

async function arrangementAddBlock(app, data) {
  if (!data.trackId) throw new ValidationError('trackId is required', 'trackId');
  if (!data.loopId)  throw new ValidationError('loopId is required',  'loopId');
  const id = app.loopArrangementRepository.addBlock({
    track_id: data.trackId,
    loop_id: data.loopId,
    position_bar: data.position_bar ?? 0,
    repetitions: data.repetitions ?? 1
  });
  return { blockId: id };
}

async function arrangementUpdateBlock(app, data) {
  if (!data.blockId) throw new ValidationError('blockId is required', 'blockId');
  const fields = {};
  ['position_bar', 'repetitions', 'loop_id', 'track_id'].forEach(k => { if (k in data) fields[k] = data[k]; });
  app.loopArrangementRepository.updateBlock(data.blockId, fields);
  return { success: true };
}

async function arrangementDeleteBlock(app, data) {
  if (!data.blockId) throw new ValidationError('blockId is required', 'blockId');
  app.loopArrangementRepository.deleteBlock(data.blockId);
  return { success: true };
}

// ── Registration ──────────────────────────────────────────────────────────────

export function register(registry, app) {
  registry.register('arrangement_create',       (d) => arrangementCreate(app, d));
  registry.register('arrangement_list',         ()  => arrangementList(app));
  registry.register('arrangement_get',          (d) => arrangementGet(app, d));
  registry.register('arrangement_update',       (d) => arrangementUpdate(app, d));
  registry.register('arrangement_delete',       (d) => arrangementDelete(app, d));
  registry.register('arrangement_add_track',    (d) => arrangementAddTrack(app, d));
  registry.register('arrangement_update_track', (d) => arrangementUpdateTrack(app, d));
  registry.register('arrangement_delete_track', (d) => arrangementDeleteTrack(app, d));
  registry.register('arrangement_add_block',    (d) => arrangementAddBlock(app, d));
  registry.register('arrangement_update_block', (d) => arrangementUpdateBlock(app, d));
  registry.register('arrangement_delete_block', (d) => arrangementDeleteBlock(app, d));
}
