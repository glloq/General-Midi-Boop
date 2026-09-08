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

  // Per-channel rows live on `instruments_latency`, keyed by the row
  // primary id (`<device_id>_<channel>`).

  findById(instrumentId) {
    return this.database.findInstrumentById(instrumentId);
  }

  update(instrumentId, fields) {
    return this.database.updateInstrumentById(instrumentId, fields);
  }

  findAllWithCapabilities() {
    return this.database.getInstrumentsWithCapabilities();
  }

  /** Cheap catalog version string for cache keying. @returns {string} */
  getCatalogFingerprint() {
    return this.database.getInstrumentCatalogFingerprint();
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

  // Multi-GM voices: SECONDARY alternatives attached to a (deviceId,
  // channel) pair. The primary program stays on `instruments_latency.gm_program`.

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

  /**
   * Remove an instrument and everything hanging off it, **atomically**.
   *
   * Audit F-81: `instrument_delete` used to fire four independent deletes in
   * four separate `try/catch` blocks, outside any transaction — a failure in the
   * middle left a half-deleted instrument and the handler answered
   * `{ success: true }` anyway, with the errors buried in a `logger.warn`.
   * Here the four legs share one SQLite transaction: either the instrument is
   * gone from all four tables or nothing changed, and any real error propagates
   * so the caller can tell the client the delete failed.
   *
   * A genuinely absent table (`string_instruments` / `midi_instrument_routings`
   * are optional on old installs) is still tolerated — but it is *reported* in
   * `skippedTables` instead of being silently swallowed like every other error.
   *
   * ADR-002 §Conventions: the composite write lives in the repository, not in
   * the handler.
   *
   * @param {string} deviceId
   * @param {?number} [channel] - Restrict to one channel; omit for the whole
   *   device.
   * @returns {{deleted:Object<string,number>, skippedTables:string[]}}
   * @throws {Error} Any non-"missing table" SQLite error, after rollback.
   */
  deleteInstrumentCascade(deviceId, channel) {
    const scoped = channel === undefined || channel === null ? undefined : channel;
    const deleted = {};
    const skippedTables = [];

    // Tables that legitimately may not exist on an old install. Anything else
    // is a real failure and must abort the transaction.
    const legs = [
      { table: 'instruments_latency', optional: false, run: 'deleteInstrumentSettingsByDevice' },
      { table: 'string_instruments', optional: true, run: 'deleteStringInstrumentsByDevice' },
      { table: 'instrument_voices', optional: false, run: 'deleteInstrumentVoicesByInstrument' },
      { table: 'midi_instrument_routings', optional: true, run: 'deleteRoutingsByDevice' }
    ];

    const cascade = this.database.transaction(() => {
      for (const leg of legs) {
        try {
          const changes = this.database[leg.run](deviceId, scoped);
          deleted[leg.table] = Number.isFinite(changes) ? changes : 0;
        } catch (error) {
          if (leg.optional && /no such table/i.test(String(error.message || ''))) {
            skippedTables.push(leg.table);
            deleted[leg.table] = 0;
            continue;
          }
          throw error;
        }
      }
    });

    cascade();
    return { deleted, skippedTables };
  }

  // Wrap a synchronous function in a SQLite transaction. Returns the
  // better-sqlite3 wrapper so callers can invoke it with their own arguments
  // (ADR-002 §Conventions — composite writes belong in the Repository layer).
  transaction(fn) {
    return this.database.transaction(fn);
  }
}
