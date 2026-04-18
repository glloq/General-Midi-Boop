/**
 * @file src/persistence/tables/InstrumentDatabase.js
 * @description SQLite access layer for the core `instruments`,
 * `latency_profiles` and `presets` tables. Composes four sub-modules
 * for the larger feature areas:
 *   - {@link InstrumentSettingsDB}      — per-channel persisted settings.
 *   - {@link InstrumentCapabilitiesDB}  — capability matrix.
 *   - {@link RoutingPersistenceDB}      — file/channel→device routings.
 *   - {@link DeviceSettingsDB}          — device-level (clock/rate) flags.
 *
 * Sub-module method calls are exposed verbatim on this class for
 * legacy callers; new code should resolve the corresponding repository.
 */
import InstrumentSettingsDB from './InstrumentSettingsDB.js';
import InstrumentCapabilitiesDB from './InstrumentCapabilitiesDB.js';
import { buildDynamicUpdate } from '../dbHelpers.js';
import RoutingPersistenceDB from './RoutingPersistenceDB.js';
import DeviceSettingsDB from './DeviceSettingsDB.js';

class InstrumentDatabase {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;

    // Sub-modules for large feature areas
    this._settings = new InstrumentSettingsDB(db, logger);
    this._capabilities = new InstrumentCapabilitiesDB(db, logger);
    this._routing = new RoutingPersistenceDB(db, logger);
    this._deviceSettings = new DeviceSettingsDB(db, logger);
  }

  // ==================== INSTRUMENT PROFILES ====================

  insertInstrument(instrument) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO instruments (
          name, manufacturer, model, type, midi_channel, program_number,
          bank_msb, bank_lsb, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        instrument.name,
        instrument.manufacturer || null,
        instrument.model || null,
        instrument.type || 'synth',
        instrument.midi_channel || 0,
        instrument.program_number || 0,
        instrument.bank_msb || null,
        instrument.bank_lsb || null,
        instrument.notes || null
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert instrument: ${error.message}`);
      throw error;
    }
  }

  getInstrument(instrumentId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM instruments WHERE id = ?');
      return stmt.get(instrumentId);
    } catch (error) {
      this.logger.error(`Failed to get instrument: ${error.message}`);
      throw error;
    }
  }

  getInstruments() {
    try {
      const stmt = this.db.prepare('SELECT * FROM instruments ORDER BY name');
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get instruments: ${error.message}`);
      throw error;
    }
  }

  updateInstrument(instrumentId, updates) {
    try {
      const result = buildDynamicUpdate('instruments', updates, [
        'name', 'manufacturer', 'model', 'type', 'midi_channel',
        'program_number', 'bank_msb', 'bank_lsb', 'notes'
      ]);
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, instrumentId);
    } catch (error) {
      this.logger.error(`Failed to update instrument: ${error.message}`);
      throw error;
    }
  }

  deleteInstrument(instrumentId) {
    try {
      this.db.prepare('DELETE FROM instruments WHERE id = ?').run(instrumentId);
    } catch (error) {
      this.logger.error(`Failed to delete instrument: ${error.message}`);
      throw error;
    }
  }

  // ==================== LATENCY PROFILES ====================

  saveLatencyProfile(profile) {
    try {
      const existing = this.db.prepare(
        'SELECT id FROM instrument_latency WHERE device_id = ?'
      ).get(profile.device_id);

      if (existing) {
        this.db.prepare(`
          UPDATE instrument_latency
          SET latency_ms = ?, last_calibrated = ?, measurement_count = ?,
              average_latency_ms = ?, min_latency_ms = ?, max_latency_ms = ?
          WHERE device_id = ?
        `).run(
          profile.latency_ms, profile.last_calibrated,
          profile.measurement_count || 1,
          profile.average_latency_ms || profile.latency_ms,
          profile.min_latency_ms || profile.latency_ms,
          profile.max_latency_ms || profile.latency_ms,
          profile.device_id
        );
        return existing.id;
      } else {
        const result = this.db.prepare(`
          INSERT INTO instrument_latency (
            device_id, latency_ms, last_calibrated, measurement_count,
            average_latency_ms, min_latency_ms, max_latency_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          profile.device_id, profile.latency_ms, profile.last_calibrated,
          profile.measurement_count || 1,
          profile.average_latency_ms || profile.latency_ms,
          profile.min_latency_ms || profile.latency_ms,
          profile.max_latency_ms || profile.latency_ms
        );
        return result.lastInsertRowid;
      }
    } catch (error) {
      this.logger.error(`Failed to save latency profile: ${error.message}`);
      throw error;
    }
  }

  getLatencyProfile(deviceId) {
    try {
      return this.db.prepare('SELECT * FROM instrument_latency WHERE device_id = ?').get(deviceId);
    } catch (error) {
      this.logger.error(`Failed to get latency profile: ${error.message}`);
      throw error;
    }
  }

  getLatencyProfiles() {
    try {
      return this.db.prepare('SELECT * FROM instrument_latency ORDER BY device_id').all();
    } catch (error) {
      this.logger.error(`Failed to get latency profiles: ${error.message}`);
      throw error;
    }
  }

  deleteLatencyProfile(deviceId) {
    try {
      this.db.prepare('DELETE FROM instrument_latency WHERE device_id = ?').run(deviceId);
    } catch (error) {
      this.logger.error(`Failed to delete latency profile: ${error.message}`);
      throw error;
    }
  }

  // ==================== PRESETS ====================

  insertPreset(preset) {
    try {
      const result = this.db.prepare(`
        INSERT INTO presets (name, description, type, data, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(preset.name, preset.description || null, preset.type || 'routing', preset.data, new Date().toISOString());
      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert preset: ${error.message}`);
      throw error;
    }
  }

  getPreset(presetId) {
    try {
      return this.db.prepare('SELECT * FROM presets WHERE id = ?').get(presetId);
    } catch (error) {
      this.logger.error(`Failed to get preset: ${error.message}`);
      throw error;
    }
  }

  getPresets(type = null) {
    try {
      if (type) {
        return this.db.prepare('SELECT * FROM presets WHERE type = ? ORDER BY name').all(type);
      }
      return this.db.prepare('SELECT * FROM presets ORDER BY name').all();
    } catch (error) {
      this.logger.error(`Failed to get presets: ${error.message}`);
      throw error;
    }
  }

  updatePreset(presetId, updates) {
    try {
      const result = buildDynamicUpdate('presets', updates, ['name', 'description', 'data']);
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, presetId);
    } catch (error) {
      this.logger.error(`Failed to update preset: ${error.message}`);
      throw error;
    }
  }

  deletePreset(presetId) {
    try {
      this.db.prepare('DELETE FROM presets WHERE id = ?').run(presetId);
    } catch (error) {
      this.logger.error(`Failed to delete preset: ${error.message}`);
      throw error;
    }
  }

  // ==================== DELEGATED: INSTRUMENT SETTINGS ====================
  // Full implementations in InstrumentSettingsDB.js

  updateInstrumentSettings(...args) { return this._settings.updateInstrumentSettings(...args); }
  getInstrumentSettings(...args) { return this._settings.getInstrumentSettings(...args); }
  getInstrumentsByDevice(...args) { return this._settings.getInstrumentsByDevice(...args); }
  saveSysExIdentity(...args) { return this._settings.saveSysExIdentity(...args); }
  findInstrumentByMac(...args) { return this._settings.findInstrumentByMac(...args); }
  findInstrumentByUsbSerial(...args) { return this._settings.findInstrumentByUsbSerial(...args); }
  findInstrumentByNormalizedName(...args) { return this._settings.findInstrumentByNormalizedName(...args); }
  reconcileDeviceId(...args) { return this._settings.reconcileDeviceId(...args); }
  deduplicateByUsbSerial(...args) { return this._settings.deduplicateByUsbSerial(...args); }
  deleteInstrumentSettingsByDevice(...args) { return this._settings.deleteByDevice(...args); }
  static normalizeDeviceName(deviceId) { return InstrumentSettingsDB.normalizeDeviceName(deviceId); }

  // ==================== DELEGATED: INSTRUMENT CAPABILITIES ====================
  // Full implementations in InstrumentCapabilitiesDB.js

  updateInstrumentCapabilities(...args) { return this._capabilities.updateInstrumentCapabilities(...args); }
  getInstrumentCapabilities(...args) { return this._capabilities.getInstrumentCapabilities(...args); }
  getAllInstrumentCapabilities() { return this._capabilities.getAllInstrumentCapabilities(); }
  getRegisteredInstrumentIds() { return this._capabilities.getRegisteredInstrumentIds(); }
  getInstrumentsWithCapabilities() { return this._capabilities.getInstrumentsWithCapabilities(); }

  // ==================== DELEGATED: ROUTING PERSISTENCE ====================
  // Full implementations in RoutingPersistenceDB.js

  insertRouting(...args) { return this._routing.insertRouting(...args); }
  insertSplitRoutings(...args) { return this._routing.insertSplitRoutings(...args); }
  getRoutingsByFile(...args) { return this._routing.getRoutingsByFile(...args); }
  getRoutingCountsByFiles(...args) { return this._routing.getRoutingCountsByFiles(...args); }
  deleteRoutingsByFile(...args) { return this._routing.deleteRoutingsByFile(...args); }
  deleteRoutingsByDevice(...args) { return this._routing.deleteRoutingsByDevice(...args); }
  disableVirtualRoutings(...args) { return this._routing.disableVirtualRoutings(...args); }
  enableVirtualRoutings(...args) { return this._routing.enableVirtualRoutings(...args); }

  // ==================== DELEGATED: DEVICE SETTINGS ====================
  // Full implementations in DeviceSettingsDB.js

  getDeviceSettings(...args) { return this._deviceSettings.getDeviceSettings(...args); }
  updateDeviceSettings(...args) { return this._deviceSettings.updateDeviceSettings(...args); }
  ensureDevice(...args) { return this._deviceSettings.ensureDevice(...args); }
}

export default InstrumentDatabase;
