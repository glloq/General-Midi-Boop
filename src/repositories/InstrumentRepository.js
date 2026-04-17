// src/repositories/InstrumentRepository.js
// Repository wrapper over InstrumentDatabase + InstrumentSettingsDB (P0-2.3, ADR-002).

export default class InstrumentRepository {
  constructor(database) {
    this.database = database;
  }

  findById(instrumentId) {
    return this.database.getInstrument(instrumentId);
  }

  findAll() {
    return this.database.getInstruments();
  }

  findAllWithCapabilities() {
    return this.database.getInstrumentsWithCapabilities();
  }

  save(instrument) {
    return this.database.insertInstrument(instrument);
  }

  update(instrumentId, updates) {
    return this.database.updateInstrument(instrumentId, updates);
  }

  delete(instrumentId) {
    return this.database.deleteInstrument(instrumentId);
  }

  getCapabilities(deviceId, channel) {
    return this.database.getInstrumentCapabilities(deviceId, channel);
  }

  updateCapabilities(deviceId, channel, fields) {
    return this.database.updateInstrumentCapabilities(deviceId, channel, fields);
  }

  // Wrap a synchronous function in a SQLite transaction. Returns the
  // better-sqlite3 wrapper so callers can invoke it with their own arguments
  // (ADR-002 §Conventions — composite writes belong in the Repository layer).
  transaction(fn) {
    return this.database.transaction(fn);
  }
}
