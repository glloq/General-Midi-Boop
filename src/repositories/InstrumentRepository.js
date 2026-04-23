/**
 * @file src/repositories/InstrumentRepository.js
 * @description Thin business-named wrapper over the instrument-related
 * methods on {@link Database}/{@link InstrumentDatabase} +
 * {@link InstrumentSettingsDB} + {@link InstrumentCapabilitiesDB}
 * (P0-2.3, ADR-002).
 *
 * Used by every command that touches instruments — settings, lookups,
 * capability writes, USB-serial / MAC / normalized-name reconciliation
 * helpers consumed by {@link DeviceReconciliationService}.
 */

export default class InstrumentRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  // The legacy generic `instruments` table is gone (v6); the per-channel
  // rows live on `instruments_latency` (plural). The two helpers below
  // operate on the row primary id (`<device_id>_<channel>`) — used by
  // the playback assignment flow to load + patch one instrument at a
  // time without juggling (deviceId, channel) tuples on the caller side.

  findById(instrumentId) {
    return this.database.findInstrumentById(instrumentId);
  }

  update(instrumentId, fields) {
    return this.database.updateInstrumentById(instrumentId, fields);
  }

  findAllWithCapabilities() {
    return this.database.getInstrumentsWithCapabilities();
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

  // deleteLatencyProfile removed in v6 — latency now lives on the
  // per-channel rows of `instruments_latency` (plural). To clear a
  // device's latency, either patch sync_delay/avg_latency back to 0
  // via updateSettings, or use deleteSettingsByDevice to drop the row
  // entirely.

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

  // ============ Multi-GM voices (secondary alternatives) ============
  // The primary GM program still lives on `instruments_latency.gm_program`.
  // These methods cover the SECONDARY voices attached to the same
  // (deviceId, channel) pair — each representing a different actuator
  // or technique on the same physical instrument.

  listVoices(deviceId, channel) {
    return this.database.listInstrumentVoices(deviceId, channel);
  }

  createVoice(deviceId, channel, payload) {
    return this.database.createInstrumentVoice(deviceId, channel, payload);
  }

  updateVoice(id, patch) {
    return this.database.updateInstrumentVoice(id, patch);
  }

  deleteVoice(id) {
    return this.database.deleteInstrumentVoice(id);
  }

  deleteVoicesByInstrument(deviceId, channel) {
    return this.database.deleteInstrumentVoicesByInstrument(deviceId, channel);
  }

  replaceVoices(deviceId, channel, voices) {
    return this.database.replaceInstrumentVoices(deviceId, channel, voices);
  }

  // Wrap a synchronous function in a SQLite transaction. Returns the
  // better-sqlite3 wrapper so callers can invoke it with their own arguments
  // (ADR-002 §Conventions — composite writes belong in the Repository layer).
  transaction(fn) {
    return this.database.transaction(fn);
  }
}
