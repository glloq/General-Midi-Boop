// src/api/commands/PlaylistCommands.js

import { ValidationError, NotFoundError } from '../../core/errors/index.js';

async function playlistCreate(app, data) {
  const playlistId = app.database.insertPlaylist({
    name: data.name,
    description: data.description
  });
  return { playlistId: playlistId };
}

async function playlistDelete(app, data) {
  app.database.deletePlaylist(data.playlistId);
  return { success: true };
}

async function playlistList(app) {
  const playlists = app.database.getPlaylists();
  return { playlists: playlists };
}

async function playlistGet(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  const playlist = app.database.getPlaylist(data.playlistId);
  if (!playlist) {
    throw new NotFoundError('Playlist', data.playlistId);
  }
  const items = app.database.getPlaylistItems(data.playlistId);
  return { playlist, items };
}

async function playlistAddFile(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  if (!data.midiId) {
    throw new ValidationError('midiId is required', 'midiId');
  }
  const itemId = app.database.addPlaylistItem(data.playlistId, data.midiId, data.position);
  return { success: true, itemId };
}

async function playlistRemoveFile(app, data) {
  if (!data.itemId) {
    throw new ValidationError('itemId is required', 'itemId');
  }
  app.database.removePlaylistItem(data.itemId);
  return { success: true };
}

async function playlistReorder(app, data) {
  if (!data.playlistId || !data.itemId || data.newPosition === undefined) {
    throw new ValidationError('playlistId, itemId, and newPosition are required', 'playlistId,itemId,newPosition');
  }
  app.database.reorderPlaylistItem(data.playlistId, data.itemId, data.newPosition);
  return { success: true };
}

async function playlistSetLoop(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  app.database.updatePlaylistLoop(data.playlistId, data.loop);
  return { success: true };
}

async function playlistClear(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }
  app.database.clearPlaylistItems(data.playlistId);
  return { success: true };
}

async function playlistStart(app, data) {
  if (!data.playlistId) {
    throw new ValidationError('playlistId is required', 'playlistId');
  }

  const playlist = app.database.getPlaylist(data.playlistId);
  if (!playlist) {
    throw new NotFoundError('Playlist', data.playlistId);
  }

  const items = app.database.getPlaylistItems(data.playlistId);
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

  // Set queue in MidiPlayer
  app.midiPlayer.setQueue(queue, loop, data.playlistId);

  // Play first (or specified) item using the queue system
  await app.midiPlayer.playQueueItem(startIndex);

  return {
    success: true,
    playlistId: data.playlistId,
    totalItems: items.length,
    startIndex,
    loop
  };
}

async function playlistNext(app) {
  const status = app.midiPlayer.getQueueStatus();
  if (!status.active) {
    throw new ValidationError('No active playlist');
  }
  await app.midiPlayer.nextInQueue();
  return { success: true, ...app.midiPlayer.getQueueStatus() };
}

async function playlistPrevious(app) {
  const status = app.midiPlayer.getQueueStatus();
  if (!status.active) {
    throw new ValidationError('No active playlist');
  }
  await app.midiPlayer.previousInQueue();
  return { success: true, ...app.midiPlayer.getQueueStatus() };
}

async function playlistStop(app) {
  app.midiPlayer.stop();
  app.midiPlayer.clearQueue();
  return { success: true };
}

async function playlistStatus(app) {
  return app.midiPlayer.getQueueStatus();
}

export function register(registry, app) {
  registry.register('playlist_create', (data) => playlistCreate(app, data));
  registry.register('playlist_delete', (data) => playlistDelete(app, data));
  registry.register('playlist_list', () => playlistList(app));
  registry.register('playlist_get', (data) => playlistGet(app, data));
  registry.register('playlist_add_file', (data) => playlistAddFile(app, data));
  registry.register('playlist_remove_file', (data) => playlistRemoveFile(app, data));
  registry.register('playlist_reorder', (data) => playlistReorder(app, data));
  registry.register('playlist_set_loop', (data) => playlistSetLoop(app, data));
  registry.register('playlist_clear', (data) => playlistClear(app, data));
  registry.register('playlist_start', (data) => playlistStart(app, data));
  registry.register('playlist_next', () => playlistNext(app));
  registry.register('playlist_previous', () => playlistPrevious(app));
  registry.register('playlist_stop', () => playlistStop(app));
  registry.register('playlist_status', () => playlistStatus(app));
}
