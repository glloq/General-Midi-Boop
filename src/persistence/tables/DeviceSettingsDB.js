/**
 * @file src/persistence/tables/DeviceSettingsDB.js
 * @description CRUD for the `devices` table — per-device settings
 * (custom display name, MIDI Clock enable, outbound rate limit).
 * Sub-module of {@link Database}; consumed via `DeviceSettingsRepository`.
 */
import { buildDynamicUpdate } from '../dbHelpers.js';

class DeviceSettingsDB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Get device-level settings.
   * @param {string} deviceId
   * @returns {Object|undefined}
   */
  getDeviceSettings(deviceId) {
    try {
      const stmt = this.db.prepare(
        'SELECT id, name, type, custom_name, midi_clock_enabled, message_rate_limit FROM devices WHERE id = ?'
      );
      return stmt.get(deviceId);
    } catch (error) {
      this.logger.error(`DeviceSettingsDB.getDeviceSettings failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update device-level settings (dynamic fields).
   * @param {string} deviceId
   * @param {Object} settings - { custom_name?, midi_clock_enabled?, message_rate_limit? }
   */
  updateDeviceSettings(deviceId, settings) {
    const result = buildDynamicUpdate('devices', settings,
      ['custom_name', 'midi_clock_enabled', 'message_rate_limit'],
      {
        transforms: {
          custom_name: v => v || null,
          midi_clock_enabled: v => v ? 1 : 0,
          message_rate_limit: v => Math.max(0, parseInt(v) || 0)
        }
      }
    );
    if (!result) return;
    this.db.prepare(result.sql).run(...result.values, deviceId);
  }

  /**
   * Ensure a device row exists (INSERT OR IGNORE).
   * @param {string} deviceId
   * @param {string} name
   * @param {string} type - 'input', 'output', or 'virtual'
   */
  ensureDevice(deviceId, name, type) {
    try {
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO devices (id, name, type) VALUES (?, ?, ?)'
      );
      stmt.run(deviceId, name, type || 'output');
    } catch (error) {
      this.logger.error(`DeviceSettingsDB.ensureDevice failed: ${error.message}`);
    }
  }
}

export default DeviceSettingsDB;
