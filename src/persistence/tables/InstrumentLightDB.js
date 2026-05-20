/**
 * @file src/persistence/tables/InstrumentLightDB.js
 * @description Persistence for the generic CC-based instrument lighting
 * state (table `instrument_light_state`, migration 027). Stores the five
 * CC values (CC 110-114) per `(device_id, channel)` so they survive a
 * restart. Sub-module of {@link InstrumentDatabase}.
 */

const FIELDS = ['brightness', 'effect', 'hue', 'speed', 'intensity'];
const clamp7 = (v) => Math.max(0, Math.min(127, v | 0));

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
   * @returns {?Object} { device_id, channel, brightness, effect, hue, speed, intensity }
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
   * Insert or replace the row for (deviceId, channel). All five fields
   * are mandatory; missing ones are coerced to their defaults.
   * @param {string} deviceId
   * @param {number} channel
   * @param {Object} state - { brightness, effect, hue, speed, intensity }
   * @returns {string} row id
   */
  saveInstrumentLightState(deviceId, channel, state) {
    channel = channel | 0;
    const id = `${deviceId}_${channel}`;
    const v = {};
    for (const f of FIELDS) v[f] = clamp7((state && state[f]) || 0);
    try {
      this.db
        .prepare(
          `INSERT INTO instrument_light_state
             (id, device_id, channel, brightness, effect, hue, speed, intensity, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             brightness = excluded.brightness,
             effect     = excluded.effect,
             hue        = excluded.hue,
             speed      = excluded.speed,
             intensity  = excluded.intensity,
             updated_at = datetime('now')`
        )
        .run(id, deviceId, channel, v.brightness, v.effect, v.hue, v.speed, v.intensity);
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
