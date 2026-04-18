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

  getAllCapabilities() {
    return this.database.getAllInstrumentCapabilities();
  }

  updateCapabilities(deviceId, channel, fields) {
    return this.database.updateInstrumentCapabilities(deviceId, channel, fields);
  }

  updateSettings(deviceId, channel, fields) {
    return this.database.updateInstrumentSettings(deviceId, channel, fields);
  }

  getSettings(deviceId, channel) {
    return this.database.getInstrumentSettings(deviceId, channel);
  }

  getAllSettings(deviceId) {
    return this.database.getInstrumentSettings(deviceId);
  }

  findByDevice(deviceId) {
    return this.database.getInstrumentsByDevice(deviceId);
  }

  deleteLatencyProfile(deviceId) {
    return this.database.deleteLatencyProfile(deviceId);
  }

  deleteSettingsByDevice(deviceId, channel) {
    return this.database.deleteInstrumentSettingsByDevice(deviceId, channel);
  }

  findByUsbSerial(serial) {
    return this.database.findInstrumentByUsbSerial(serial);
  }

  findByMac(mac) {
    return this.database.findInstrumentByMac(mac);
  }

  findByNormalizedName(deviceId) {
    return this.database.findInstrumentByNormalizedName(deviceId);
  }

  reconcileDeviceId(oldDeviceId, newDeviceId) {
    return this.database.reconcileDeviceId(oldDeviceId, newDeviceId);
  }

  deduplicateByUsbSerial() {
    return this.database.deduplicateByUsbSerial();
  }

  saveSysExIdentity(deviceId, channel, identity) {
    return this.database.saveSysExIdentity(deviceId, channel, identity);
  }

  // Wrap a synchronous function in a SQLite transaction. Returns the
  // better-sqlite3 wrapper so callers can invoke it with their own arguments
  // (ADR-002 §Conventions — composite writes belong in the Repository layer).
  transaction(fn) {
    return this.database.transaction(fn);
  }
}
