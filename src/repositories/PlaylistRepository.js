// src/repositories/PlaylistRepository.js
// Repository wrapper over playlist CRUD via Database facade (ADR-002 option B).

export default class PlaylistRepository {
  constructor(database) {
    this.database = database;
  }

  save(playlist) {
    return this.database.insertPlaylist(playlist);
  }

  delete(playlistId) {
    return this.database.deletePlaylist(playlistId);
  }

  findAll() {
    return this.database.getPlaylists();
  }

  findById(playlistId) {
    return this.database.getPlaylist(playlistId);
  }

  findItems(playlistId) {
    return this.database.getPlaylistItems(playlistId);
  }

  addItem(playlistId, midiId, position) {
    return this.database.addPlaylistItem(playlistId, midiId, position);
  }

  removeItem(itemId) {
    return this.database.removePlaylistItem(itemId);
  }

  reorderItem(playlistId, itemId, newPosition) {
    return this.database.reorderPlaylistItem(playlistId, itemId, newPosition);
  }

  updateLoop(playlistId, loop) {
    return this.database.updatePlaylistLoop(playlistId, loop);
  }

  clearItems(playlistId) {
    return this.database.clearPlaylistItems(playlistId);
  }

  updateSettings(playlistId, settings) {
    return this.database.updatePlaylistSettings(playlistId, settings);
  }
}
