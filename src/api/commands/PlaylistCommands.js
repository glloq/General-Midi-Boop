// src/api/commands/PlaylistCommands.js

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

async function playlistAddFile(app, data) {
  // Future implementation with playlist_items table
  return { success: true };
}

export function register(registry, app) {
  registry.register('playlist_create', (data) => playlistCreate(app, data));
  registry.register('playlist_delete', (data) => playlistDelete(app, data));
  registry.register('playlist_list', () => playlistList(app));
  registry.register('playlist_add_file', (data) => playlistAddFile(app, data));
}
