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
    const caps = this.database.getInstrumentCapabilities(deviceId, channel);
    if (!caps) return null;
    return {
      ...caps,
      midi_message_support: this.getMidiMessageSupport(deviceId, channel)
    };
  }

  getAllCapabilities() {
    const rows = this.database.getAllInstrumentCapabilities();
    return rows.map((row) => ({
      ...row,
      midi_message_support:
        row?.device_id != null && row?.channel != null
          ? this.getMidiMessageSupport(row.device_id, row.channel)
          : null
    }));
  }

  updateCapabilities(deviceId, channel, fields) {
    return this.database.updateInstrumentCapabilities(deviceId, channel, fields);
  }

  /**
   * Persist the semantic MIDI messages advertised by a GMB v2 descriptor.
   *
   * `support` is a tri-state object: true = implemented, false = explicitly
   * unsupported, absent = unknown. The complete object is stored as JSON so
   * future protocol keys do not require another schema migration. When the
   * descriptor explicitly declares pitch-bend support we also mirror that value
   * into the legacy `pitch_bend_enabled` column used by the virtual keyboard.
   *
   * The base capability row is created by `updateCapabilities()` immediately
   * before this method in DescriptorService; a missing row here is therefore a
   * real integration error rather than something to silently upsert.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @param {Object|null} support
   * @returns {number} number of rows changed
   */
  saveMidiMessageSupport(deviceId, channel, support) {
    if (support !== null && (typeof support !== 'object' || Array.isArray(support))) {
      throw new TypeError('MIDI message support must be an object or null');
    }
    const db = this.database?.db;
    if (!db) throw new Error('Database connection unavailable');

    const json = support === null ? null : JSON.stringify(support);
    const pitchBend =
      support && typeof support.pitch_bend === 'boolean' ? (support.pitch_bend ? 1 : 0) : null;
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE instruments_latency
      SET midi_message_support = ?,
          pitch_bend_enabled = CASE WHEN ? IS NULL THEN pitch_bend_enabled ELSE ? END,
          capabilities_updated_at = ?
      WHERE device_id = ? AND channel = ?
    `).run(json, pitchBend, pitchBend, now, deviceId, channel);

    if (result.changes === 0) {
      throw new Error(
        `Cannot persist MIDI message support: no instrument row for ${deviceId}:${channel}`
      );
    }
    return result.changes;
  }

  /**
   * Read the semantic MIDI-message declaration for one instrument channel.
   * Returns null for legacy/unknown data or malformed legacy JSON.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @returns {Object|null}
   */
  getMidiMessageSupport(deviceId, channel) {
    const db = this.database?.db;
    if (!db) return null;
    const row = db
      .prepare(
        'SELECT midi_message_support FROM instruments_latency WHERE device_id = ? AND channel = ?'
      )
      .get(deviceId, channel);
    if (!row?.midi_message_support) return null;
    try {
      const value = JSON.parse(row.midi_message_support);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Read every channel's declaration for one physical/logical device.
   * Rows with no declaration are retained as `null`: the outbound guard needs
   * to distinguish "all channels explicitly false" from "at least one channel
   * is still unknown" for device-wide realtime/system messages.
   *
   * @param {string} deviceId
   * @returns {Object<number,Object|null>|null}
   */
  getMidiMessageSupportsForDevice(deviceId) {
    const db = this.database?.db;
    if (!db) return null;
    const rows = db
      .prepare(
        'SELECT channel, midi_message_support FROM instruments_latency WHERE device_id = ? ORDER BY channel'
      )
      .all(deviceId);
    if (!rows.length) return null;

    const out = {};
    for (const row of rows) {
      if (!row.midi_message_support) {
        out[row.channel] = null;
        continue;
      }
      try {
        const value = JSON.parse(row.midi_message_support);
        out[row.channel] =
          value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      } catch {
        out[row.channel] = null;
      }
    }
    return out;
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
