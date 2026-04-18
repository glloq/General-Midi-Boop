/**
 * @file src/repositories/PlaylistRepository.js
 * @description Thin business-named wrapper over playlist CRUD on
 * {@link Database} (ADR-002 option B). Owns both the playlist headers
 * and the ordered item rows; runtime queue state lives in MidiPlayer.
 */

export default class PlaylistRepository {
  /** @param {Object} database - Application database facade. */
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
