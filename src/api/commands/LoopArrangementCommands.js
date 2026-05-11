/**
 * @file src/api/commands/LoopArrangementCommands.js
 * @description WebSocket commands for Loop Arranger CRUD.
 *
 * Validation structurelle (types, bornes) déclarative dans
 * `schemas/loop.schemas.js`. Les handlers gardent la logique qui
 * nécessite un accès DB (NotFoundError, intégrité référentielle entre
 * tracks et arrangements, transactions sur opérations multi-step).
 *
 * Registered commands:
 *   arrangement_create / _list / _get / _update / _delete
 *   arrangement_add_track / _update_track / _delete_track
 *   arrangement_add_block / _update_block / _delete_block
 */

import { ValidationError, NotFoundError } from '../../core/errors/index.js';

// ── Arrangements ──────────────────────────────────────────────────────────────

async function arrangementCreate(app, data) {
  // Opération multi-step : insert arrangement + 3 tracks. On encapsule
  // dans une transaction pour éviter l'arrangement zombie si un insert
  // de track échoue. Les labels par défaut sont volontairement vides
  // côté serveur (le client génère le label traduit à la réception —
  // voir AUDIT §U1).
  const txn = app.database?.db?.transaction
    ? app.database.db.transaction(() => {
        const id = app.loopArrangementRepository.save({
          name: data.name.trim(),
          global_tempo: data.global_tempo,
          total_bars: data.total_bars
        });
        for (let i = 0; i < 3; i++) {
          app.loopArrangementRepository.addTrack({
            arrangement_id: id,
            track_index: i,
            label: '' // i18n : généré côté client
          });
        }
        return id;
      })
    : () => {
        // Fallback hors better-sqlite3 (tests / autres backends).
        const id = app.loopArrangementRepository.save({
          name: data.name.trim(),
          global_tempo: data.global_tempo,
          total_bars: data.total_bars
        });
        for (let i = 0; i < 3; i++) {
          app.loopArrangementRepository.addTrack({
            arrangement_id: id, track_index: i, label: ''
          });
        }
        return id;
      };
  const arrangementId = txn();
  return { arrangementId };
}

async function arrangementList(app) {
  return { arrangements: app.loopArrangementRepository.findAll() };
}

async function arrangementGet(app, data) {
  const arr = app.loopArrangementRepository.findById(data.arrangementId);
  if (!arr) throw new NotFoundError('Arrangement', data.arrangementId);
  // findFullArrangement (si dispo) fait un seul JOIN tracks+blocks.
  // Fallback sur les 3 queries séparées pour préserver la compat tests.
  if (typeof app.loopArrangementRepository.findFullArrangement === 'function') {
    const { tracks, blocks } = app.loopArrangementRepository.findFullArrangement(data.arrangementId);
    return { arrangement: arr, tracks, blocks };
  }
  const tracks = app.loopArrangementRepository.findTracks(data.arrangementId);
  const blocks = app.loopArrangementRepository.findAllBlocks(data.arrangementId);
  return { arrangement: arr, tracks, blocks };
}

async function arrangementUpdate(app, data) {
  const arr = app.loopArrangementRepository.findById(data.arrangementId);
  if (!arr) throw new NotFoundError('Arrangement', data.arrangementId);
  const fields = {};
  ['name', 'global_tempo', 'total_bars'].forEach((k) => {
    if (k in data) fields[k] = data[k];
  });
  if (fields.name !== undefined) fields.name = String(fields.name).trim();
  app.loopArrangementRepository.update(data.arrangementId, fields);
  return { success: true };
}

async function arrangementDelete(app, data) {
  app.loopArrangementRepository.delete(data.arrangementId);
  return { success: true };
}

// ── Tracks ────────────────────────────────────────────────────────────────────

async function arrangementAddTrack(app, data) {
  const arr = app.loopArrangementRepository.findById(data.arrangementId);
  if (!arr) throw new NotFoundError('Arrangement', data.arrangementId);
  const tracks = app.loopArrangementRepository.findTracks(data.arrangementId);
  const trackIndex = data.track_index ?? tracks.length;
  const id = app.loopArrangementRepository.addTrack({
    arrangement_id: data.arrangementId,
    track_index: trackIndex,
    label: data.label ?? '',
    midi_channel: data.midi_channel
  });
  return { trackId: id };
}

async function arrangementUpdateTrack(app, data) {
  const fields = {};
  ['label', 'midi_channel'].forEach((k) => {
    if (k in data) fields[k] = data[k];
  });
  app.loopArrangementRepository.updateTrack(data.trackId, fields);
  return { success: true };
}

async function arrangementDeleteTrack(app, data) {
  app.loopArrangementRepository.deleteTrack(data.trackId);
  return { success: true };
}

// ── Blocks ────────────────────────────────────────────────────────────────────

/**
 * Intégrité référentielle au niveau handler (les FKs SQLite throw
 * mais sans message typé). On vérifie aussi que position_bar reste
 * dans la longueur de l'arrangement parent.
 */
function _validateBlockRefs(app, { trackId, loopId, position_bar }) {
  if (trackId !== undefined && typeof app.loopArrangementRepository.findTrackById === 'function') {
    const track = app.loopArrangementRepository.findTrackById(trackId);
    if (!track) throw new NotFoundError('Track', trackId);
    if (position_bar !== undefined && typeof app.loopArrangementRepository.findById === 'function') {
      const arrangement = app.loopArrangementRepository.findById(track.arrangement_id);
      if (arrangement && position_bar >= arrangement.total_bars) {
        throw new ValidationError(
          `position_bar must be < arrangement total_bars (${arrangement.total_bars})`,
          'position_bar'
        );
      }
    }
  }
  if (loopId !== undefined && typeof app.loopRepository?.findById === 'function') {
    const loop = app.loopRepository.findById(loopId);
    if (!loop) throw new NotFoundError('Loop', loopId);
  }
}

async function arrangementAddBlock(app, data) {
  _validateBlockRefs(app, {
    trackId: data.trackId,
    loopId: data.loopId,
    position_bar: data.position_bar
  });
  const id = app.loopArrangementRepository.addBlock({
    track_id: data.trackId,
    loop_id: data.loopId,
    position_bar: data.position_bar ?? 0,
    repetitions: data.repetitions ?? 1
  });
  return { blockId: id };
}

async function arrangementUpdateBlock(app, data) {
  // Si on change track/loop/position, on valide les nouvelles cibles.
  _validateBlockRefs(app, {
    trackId: data.track_id,
    loopId: data.loop_id,
    position_bar: data.position_bar
  });
  const fields = {};
  ['position_bar', 'repetitions', 'loop_id', 'track_id'].forEach((k) => {
    if (k in data) fields[k] = data[k];
  });
  app.loopArrangementRepository.updateBlock(data.blockId, fields);
  return { success: true };
}

async function arrangementDeleteBlock(app, data) {
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
