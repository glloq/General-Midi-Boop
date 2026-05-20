/**
 * @file src/persistence/tables/InstrumentLightDB.js
 * @description Persistence for the generic CC-based instrument lighting
 * state (table `instrument_light_state`, migrations 027 + 028 + 029).
 * Stores the five CC values (CC 110-114) per `(device_id, channel)` plus
 * the capability flags declared in the instrument settings modal:
 *   - `supported_mask`    (5 bits)  — which CCs the firmware understands
 *   - `brightness_mode`   (0/1)     — CC110 on/off vs dimmable
 *   - `supported_effects` (10 bits) — which CC111 effects the firmware does
 *
 * Sub-module of {@link InstrumentDatabase}.
 */

const CC_FIELDS = ['brightness', 'effect', 'hue', 'speed', 'intensity'];
const clamp7 = (v) => Math.max(0, Math.min(127, v | 0));
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

class InstrumentLightDB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * @param {string} deviceId
   * @param {number} [channel=0]
   * @returns {?Object}
   */
  getInstrumentLightState(deviceId, channel = 0) {
    try {
      return (
        this.db
          .prepare(
            'SELECT * FROM instrument_light_state WHERE device_id = ? AND channel = ?'
          )
          .get(deviceId, channel) || null
      );
    } catch (error) {
      this.logger?.error?.(`Failed to read instrument light state: ${error.message}`);
      return null;
    }
  }

  /** @returns {Object[]} every persisted state */
  getAllInstrumentLightStates() {
    try {
      return this.db
        .prepare('SELECT * FROM instrument_light_state ORDER BY device_id, channel')
        .all();
    } catch (error) {
      this.logger?.error?.(`Failed to list instrument light states: ${error.message}`);
      return [];
    }
  }

  /**
   * Insert or replace the row for (deviceId, channel). Each field is
   * coerced and clamped before being written.
   * @param {string} deviceId
   * @param {number} channel
   * @param {Object} state
   * @returns {string} row id
   */
  saveInstrumentLightState(deviceId, channel, state) {
    channel = channel | 0;
    const id = `${deviceId}_${channel}`;
    const v = {};
    for (const f of CC_FIELDS) v[f] = clamp7((state && state[f]) || 0);
    v.supported_mask = clampInt((state && state.supported_mask) || 0, 0, 31);
    v.brightness_mode = clampInt(
      state && state.brightness_mode !== undefined ? state.brightness_mode : 1,
      0, 1
    );
    v.supported_effects = clampInt(
      state && state.supported_effects !== undefined ? state.supported_effects : 1023,
      0, 1023
    );
    try {
      this.db
        .prepare(
          `INSERT INTO instrument_light_state
             (id, device_id, channel,
              brightness, effect, hue, speed, intensity,
              supported_mask, brightness_mode, supported_effects,
              updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             brightness        = excluded.brightness,
             effect            = excluded.effect,
             hue               = excluded.hue,
             speed             = excluded.speed,
             intensity         = excluded.intensity,
             supported_mask    = excluded.supported_mask,
             brightness_mode   = excluded.brightness_mode,
             supported_effects = excluded.supported_effects,
             updated_at        = datetime('now')`
        )
        .run(
          id, deviceId, channel,
          v.brightness, v.effect, v.hue, v.speed, v.intensity,
          v.supported_mask, v.brightness_mode, v.supported_effects
        );
      return id;
    } catch (error) {
      this.logger?.error?.(`Failed to save instrument light state: ${error.message}`);
      throw error;
    }
  }

  /**
   * Drop every state row for a device (called when a device is removed).
   * @param {string} deviceId
   */
  deleteInstrumentLightByDevice(deviceId) {
    try {
      this.db
        .prepare('DELETE FROM instrument_light_state WHERE device_id = ?')
        .run(deviceId);
    } catch (error) {
      this.logger?.error?.(`Failed to delete instrument light state: ${error.message}`);
    }
  }
}

export default InstrumentLightDB;
