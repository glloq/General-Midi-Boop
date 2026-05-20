/**
 * @file src/persistence/tables/InstrumentLightDB.js
 * @description Persistence for embedded-LED lighting that lives on a MIDI
 * instrument and is driven by the instrument's own microcontroller
 * (table `instrument_light_config`, migration 025). Independent of the
 * Raspberry-side LightingManager. Sub-module of {@link InstrumentDatabase}.
 *
 * Two concerns on one row, keyed by (device_id, channel):
 *   - capabilities  (what the LEDs can do; SysEx Block 8 or manual)
 *   - control config (how GM Boop drives them)
 */
import { buildDynamicUpdate } from '../dbHelpers.js';

const CAPABILITY_FIELDS = [
  'light_caps_source', 'light_led_count', 'light_addressing',
  'light_note_base', 'light_note_count', 'light_color_mode',
  'light_palette_size', 'light_transports', 'light_channel',
  'light_cc_brightness', 'light_cc_mode', 'light_cc_effect',
  'light_cc_effect_speed', 'light_cc_guide', 'light_local_effects',
  'light_flags', 'light_min_interval_ms', 'light_messages_bitmask'
];

const CONTROL_FIELDS = [
  'light_mode', 'light_brightness', 'light_guide_enabled',
  'light_palette_json', 'light_track_colors_json',
  'light_active_effect', 'light_effect_speed'
];

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
   * Fetch the light config row for a device+channel, or null.
   * @param {string} deviceId
   * @param {number} [channel=0]
   * @returns {?Object}
   */
  getInstrumentLight(deviceId, channel = 0) {
    try {
      return this.db
        .prepare('SELECT * FROM instrument_light_config WHERE device_id = ? AND channel = ?')
        .get(deviceId, channel) || null;
    } catch (error) {
      this.logger.error(`Failed to read instrument light config: ${error.message}`);
      return null;
    }
  }

  /**
   * Every persisted light config row (used by the manager at startup and
   * by the Lighting modal "Par instrument" tab).
   * @returns {Object[]}
   */
  getAllInstrumentLights() {
    try {
      return this.db.prepare('SELECT * FROM instrument_light_config').all();
    } catch (error) {
      this.logger.error(`Failed to list instrument light configs: ${error.message}`);
      return [];
    }
  }

  _ensureRow(deviceId, channel) {
    const id = `${deviceId}_${channel}`;
    const existing = this.db
      .prepare('SELECT id FROM instrument_light_config WHERE device_id = ? AND channel = ?')
      .get(deviceId, channel);
    if (!existing) {
      this.db
        .prepare('INSERT INTO instrument_light_config (id, device_id, channel) VALUES (?, ?, ?)')
        .run(id, deviceId, channel);
    }
    return id;
  }

  _patch(deviceId, channel, fields, allowed) {
    channel = channel || 0;
    try {
      this._ensureRow(deviceId, channel);
      const patch = { ...fields, updated_at: new Date().toISOString() };
      const result = buildDynamicUpdate(
        'instrument_light_config',
        patch,
        [...allowed, 'updated_at'],
        { whereClause: 'device_id = ? AND channel = ?' }
      );
      if (!result) return `${deviceId}_${channel}`;
      this.db.prepare(result.sql).run(...result.values, deviceId, channel);
      return `${deviceId}_${channel}`;
    } catch (error) {
      this.logger.error(`Failed to save instrument light row: ${error.message}`);
      throw error;
    }
  }

  /**
   * Persist the LED capabilities (from SysEx Block 8 or manual entry).
   * @param {string} deviceId
   * @param {number} channel
   * @param {Object} capabilities - subset of CAPABILITY_FIELDS
   * @param {'sysex'|'manual'} source
   * @returns {string} row id
   */
  saveInstrumentLightCapabilities(deviceId, channel, capabilities, source) {
    return this._patch(
      deviceId,
      channel,
      { ...capabilities, light_caps_source: source },
      CAPABILITY_FIELDS
    );
  }

  /**
   * Persist the control configuration (Lighting modal "Par instrument").
   * @param {string} deviceId
   * @param {number} channel
   * @param {Object} config - subset of CONTROL_FIELDS
   * @returns {string} row id
   */
  saveInstrumentLightConfig(deviceId, channel, config) {
    return this._patch(deviceId, channel, config, CONTROL_FIELDS);
  }

  /**
   * Drop every light config row for a device (called when a device is
   * removed/forgotten alongside instruments_latency cleanup).
   * @param {string} deviceId
   */
  deleteInstrumentLightByDevice(deviceId) {
    try {
      this.db
        .prepare('DELETE FROM instrument_light_config WHERE device_id = ?')
        .run(deviceId);
    } catch (error) {
      this.logger.error(`Failed to delete instrument light config: ${error.message}`);
    }
  }
}

export default InstrumentLightDB;
