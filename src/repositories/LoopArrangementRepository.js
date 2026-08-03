/**
 * @file src/repositories/LoopArrangementRepository.js
 * @description Repository for loop arrangements (ADR-002).
 *
 * Wrappe `loopArrangementsDB` et expose deux méthodes additionnelles
 * utilisées par les commands :
 *   - `findTrackById(id)` : nécessaire pour vérifier l'appartenance
 *     d'un block à un arrangement (FK + total_bars check).
 *   - `findFullArrangement(arrId)` : un seul JOIN tracks+blocks au lieu
 *     de 3 queries séparées (réduit la latence côté client).
 *   - `countBlocksByLoopId(loopId)` : pré-compte l'impact CASCADE
 *     avant un loop_delete.
 */

export default class LoopArrangementRepository {
  constructor(database) {
    this.database = database;
  }

  // Arrangements
  save(arr) {
    return this.database.insertArrangement(arr);
  }
  findAll() {
    return this.database.getArrangements();
  }
  findById(id) {
    return this.database.getArrangement(id);
  }
  update(id, fields) {
    return this.database.updateArrangement(id, fields);
  }
  delete(id) {
    return this.database.deleteArrangement(id);
  }

  // Tracks
  addTrack(track) {
    return this.database.insertTrack(track);
  }
  findTracks(arrId) {
    return this.database.getTracks(arrId);
  }
  findTrackById(id) {
    return this.database.getTrack(id);
  }
  updateTrack(id, f) {
    return this.database.updateTrack(id, f);
  }
  deleteTrack(id) {
    return this.database.deleteTrack(id);
  }

  // Blocks
  addBlock(block) {
    return this.database.insertBlock(block);
  }
  findBlocks(trackId) {
    return this.database.getBlocks(trackId);
  }
  findAllBlocks(arrId) {
    return this.database.getAllBlocksForArrangement(arrId);
  }
  updateBlock(id, f) {
    return this.database.updateBlock(id, f);
  }
  deleteBlock(id) {
    return this.database.deleteBlock(id);
  }
  countBlocksByLoopId(loopId) {
    return this.database.countBlocksByLoopId(loopId);
  }

  /**
   * Full arrangement fetch en une seule passe DB (vs 3 queries séparées).
   * Retourne `{ tracks, blocks }` ; les tracks sans block sont incluses.
   * @param {number} arrangementId
   */
  findFullArrangement(arrangementId) {
    return this.database.getFullArrangement(arrangementId);
  }
}
