/**
 * @file src/api/commands/PlaylistCommands.js
 * @description WebSocket commands for playlist CRUD plus runtime
 * controls (start/next/previous/stop/status). Storage is delegated to
 * `playlistRepository`; runtime queue lives in `MidiPlayer`.
 *
 * Registered commands:
 *   - `playlist_create` / `_delete` / `_list` / `_get`
 *   - `playlist_add_file` / `_remove_file` / `_reorder` / `_clear`
 *   - `playlist_set_loop` / `_update_settings` (gap, shuffle)
 *   - `playlist_start` / `_next` / `_previous` / `_stop` / `_status`
 *
 * Validation: imperative, inside each handler.
 */

import { ValidationError, NotFoundError } from '../../core/errors/index.js';

/**
 * @param {Object} app
 * @param {{name:string, description?:string}} data
 * @returns {Promise<{playlistId:(string|number)}>}
 */
async function playlistCreate(app, data) {
  const playlistId = app.playlistRepository.save({
    name: data.name,
    description: data.description
  });
  return { playlistId: playlistId };
}

/**
 * @param {Object} app
 * @param {{playlistId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 */
async function playlistDelete(app, data) {
  app.playlistRepository.delete(data.playlistId);
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{playlists:Object[]}>}
 */
async function playlistList(app) {
  const playlists = app.playlistRepository.findAll();
  return { playlists: playlists };
}

/**
 * @param {Object} app
 * @param {{playlistId:(string|number)}} data
 * @returns {Promise<{playlist:Object, items:Object[]}>}
 * @throws {ValidationError|NotFoundError}
 */
async function playlistGet(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  const playlist = app.playlistRepository.findById(data.playlistId);
  if (!playlist) {
    throw new NotFoundError('Playlist', data.playlistId);
  }
  const items = app.playlistRepository.findItems(data.playlistId);
  return { playlist, items };
}

/**
 * Append (or insert at `position`) a MIDI file into a playlist.
 *
 * @param {Object} app
 * @param {{playlistId:(string|number), midiId:(string|number),
 *   position?:number}} data
 * @returns {Promise<{success:true, itemId:(string|number)}>}
 * @throws {ValidationError}
 */
async function playlistAddFile(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  if (!data.midiId) {
    throw new ValidationError('midiId is required', 'midiId');
  }
  const itemId = app.playlistRepository.addItem(data.playlistId, data.midiId, data.position);
  return { success: true, itemId };
}

/**
 * @param {Object} app
 * @param {{itemId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function playlistRemoveFile(app, data) {
  if (!data.itemId) {
    throw new ValidationError('itemId is required', 'itemId');
  }
  app.playlistRepository.removeItem(data.itemId);
  return { success: true };
}

/**
 * Move an item to a new ordinal position within its playlist.
 *
 * @param {Object} app
 * @param {{playlistId:(string|number), itemId:(string|number),
 *   newPosition:number}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function playlistReorder(app, data) {
  if (!data.playlistId || !data.itemId || data.newPosition === undefined) {
    throw new ValidationError('playlistId, itemId, and newPosition are required', 'playlistId,itemId,newPosition');
  }
  app.playlistRepository.reorderItem(data.playlistId, data.itemId, data.newPosition);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{playlistId:(string|number), loop:(boolean|number)}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function playlistSetLoop(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  app.playlistRepository.updateLoop(data.playlistId, data.loop);
  return { success: true };
}

/**
 * Remove every item from a playlist (the playlist itself is kept).
 *
 * @param {Object} app
 * @param {{playlistId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function playlistClear(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  app.playlistRepository.clearItems(data.playlistId);
  return { success: true };
}

/**
 * Update playback-time settings (`gap_seconds`, `shuffle`). Only the
 * fields present in `data` are written.
 *
 * @param {Object} app
 * @param {{playlistId:(string|number), gap_seconds?:number,
 *   shuffle?:(boolean|number)}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError|NotFoundError}
 */
async function playlistUpdateSettings(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  const playlist = app.playlistRepository.findById(data.playlistId);
  if (!playlist) {
    throw new NotFoundError('Playlist', data.playlistId);
  }

  const settings = {};
  if (data.gap_seconds !== undefined) settings.gap_seconds = data.gap_seconds;
  if (data.shuffle !== undefined) settings.shuffle = data.shuffle;

  app.playlistRepository.updateSettings(data.playlistId, settings);
  return { success: true };
}

/**
 * Build the playback queue from a playlist and start playing the
 * `startIndex`-th item (defaults to 0). Loop / shuffle / gap come from
 * the persisted playlist settings.
 *
 * @param {Object} app
 * @param {{playlistId:(string|number), startIndex?:number|string}} data
 * @returns {Promise<{success:true, playlistId:(string|number),
 *   totalItems:number, startIndex:number, loop:boolean, shuffle:boolean,
 *   gapSeconds:number}>}
 * @throws {ValidationError|NotFoundError}
 */
async function playlistStart(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }

  const playlist = app.playlistRepository.findById(data.playlistId);
  if (!playlist) {
    throw new NotFoundError('Playlist', data.playlistId);
  }

  const items = app.playlistRepository.findItems(data.playlistId);
  if (items.length === 0) {
    throw new ValidationError('Playlist is empty');
  }

  // Build queue from playlist items
  const queue = items.map(item => ({
    fileId: item.midi_id,
    filename: item.filename
  }));

  const startIndex = parseInt(data.startIndex) || 0;
  if (startIndex < 0 || startIndex >= items.length) {
    throw new ValidationError(`startIndex ${startIndex} out of range (0-${items.length - 1})`, 'startIndex');
  }
  const loop = playlist.loop === 1;
  const shuffle = playlist.shuffle === 1;
  const gapSeconds = playlist.gap_seconds || 0;

  // Set queue in MidiPlayer with playback options
  app.midiPlayer.setQueue(queue, loop, data.playlistId, { gapSeconds, shuffle });

  // Play first (or specified) item using the queue system
  await app.midiPlayer.playQueueItem(startIndex);

  return {
    success: true,
    playlistId: data.playlistId,
    totalItems: items.length,
    startIndex,
    loop,
    shuffle,
    gapSeconds
  };
}

/**
 * Advance to the next queued item.
 *
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError} When no playlist is currently playing.
 */
async function playlistNext(app) {
  const status = app.midiPlayer.getQueueStatus();
  if (!status.active) {
    throw new ValidationError('No active playlist');
  }
  await app.midiPlayer.nextInQueue();
  return { success: true, ...app.midiPlayer.getQueueStatus() };
}

/**
 * Step back to the previous queued item.
 *
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError} When no playlist is currently playing.
 */
async function playlistPrevious(app) {
  const status = app.midiPlayer.getQueueStatus();
  if (!status.active) {
    throw new ValidationError('No active playlist');
  }
  await app.midiPlayer.previousInQueue();
  return { success: true, ...app.midiPlayer.getQueueStatus() };
}

/**
 * Stop playback and clear the queue.
 *
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function playlistStop(app) {
  app.midiPlayer.stop();
  app.midiPlayer.clearQueue();
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<Object>} Player queue status snapshot.
 */
async function playlistStatus(app) {
  return app.midiPlayer.getQueueStatus();
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('playlist_create', (data) => playlistCreate(app, data));
  registry.register('playlist_delete', (data) => playlistDelete(app, data));
  registry.register('playlist_list', () => playlistList(app));
  registry.register('playlist_get', (data) => playlistGet(app, data));
  registry.register('playlist_add_file', (data) => playlistAddFile(app, data));
  registry.register('playlist_remove_file', (data) => playlistRemoveFile(app, data));
  registry.register('playlist_reorder', (data) => playlistReorder(app, data));
  registry.register('playlist_set_loop', (data) => playlistSetLoop(app, data));
  registry.register('playlist_update_settings', (data) => playlistUpdateSettings(app, data));
  registry.register('playlist_clear', (data) => playlistClear(app, data));
  registry.register('playlist_start', (data) => playlistStart(app, data));
  registry.register('playlist_next', () => playlistNext(app));
  registry.register('playlist_previous', () => playlistPrevious(app));
  registry.register('playlist_stop', () => playlistStop(app));
  registry.register('playlist_status', () => playlistStatus(app));
}
