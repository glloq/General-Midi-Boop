/**
 * @file src/repositories/StringInstrumentRepository.js
 * @description Thin business-named wrapper over
 * {@link StringInstrumentDatabase} (ADR-002 option B). Hides the
 * `database.stringInstrumentDB` sub-module path from handlers and
 * groups the API into "instruments" / "tuning presets" / "tablatures".
 */

export default class StringInstrumentRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  get _sub() {
    return this.database.stringInstrumentDB;
  }

  // Instruments
  save(instrument) {
    return this._sub.createStringInstrument(instrument);
  }

  update(id, fields) {
    return this._sub.updateStringInstrument(id, fields);
  }

  delete(id) {
    return this._sub.deleteStringInstrument(id);
  }

  deleteByDeviceChannel(deviceId, channel) {
    return this._sub.deleteStringInstrumentByDeviceChannel(deviceId, channel);
  }

  deleteByDevice(deviceId, channel) {
    return this._sub.deleteByDevice(deviceId, channel);
  }

  findById(id) {
    return this._sub.getStringInstrumentById(id);
  }

  findByDeviceChannel(deviceId, channel) {
    return this._sub.getStringInstrument(deviceId, channel);
  }

  findByDevice(deviceId) {
    return this._sub.getStringInstrumentsByDevice(deviceId);
  }

  findAll() {
    return this._sub.getAllStringInstruments();
  }

  // Tuning presets
  findAllTuningPresets() {
    return this._sub.getTuningPresets();
  }

  findTuningPreset(key) {
    return this._sub.getTuningPreset(key);
  }

  // Tablatures
  saveTablature(...args) {
    return this._sub.saveTablature(...args);
  }

  findTablature(...args) {
    return this._sub.getTablature(...args);
  }

  findTablaturesByFile(midiFileId) {
    return this._sub.getTablaturesByFile(midiFileId);
  }

  deleteTablature(midiFileId, channel) {
    return this._sub.deleteTablature(midiFileId, channel);
  }

  deleteTablaturesByFile(midiFileId) {
    return this._sub.deleteTablaturesByFile(midiFileId);
  }
}
