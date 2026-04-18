/**
 * @file src/repositories/SessionRepository.js
 * @description Thin business-named wrapper over session CRUD on
 * {@link Database} (ADR-002 option B). Sessions are JSON snapshots of
 * device list, routing table and player state — see SessionCommands.
 */

export default class SessionRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  save(session) {
    return this.database.insertSession(session);
  }

  findById(sessionId) {
    return this.database.getSession(sessionId);
  }

  findAll() {
    return this.database.getSessions();
  }

  delete(sessionId) {
    return this.database.deleteSession(sessionId);
  }
}
