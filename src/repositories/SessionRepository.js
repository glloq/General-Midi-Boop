// src/repositories/SessionRepository.js
// Repository wrapper over session CRUD via Database facade (ADR-002 option B).

export default class SessionRepository {
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
