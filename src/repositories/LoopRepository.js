/**
 * @file src/repositories/LoopRepository.js
 * @description Repository for sample loops (Loop Creator modal).
 * Thin wrapper over LoopsDB following the project's ADR-002 pattern.
 */

export default class LoopRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  save(loop) {
    return this.database.insertLoop(loop);
  }

  findAll() {
    return this.database.getLoops();
  }

  findById(id) {
    return this.database.getLoop(id);
  }

  update(id, fields) {
    return this.database.updateLoop(id, fields);
  }

  delete(id) {
    return this.database.deleteLoop(id);
  }
}
