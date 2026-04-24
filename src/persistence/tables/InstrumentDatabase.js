/**
 * @file src/persistence/tables/InstrumentDatabase.js
 * @description SQLite access layer for the `presets` table plus
 * delegated facades over the four sub-modules that own the actual
 * instrument-related tables:
 *   - {@link InstrumentSettingsDB}      — per-channel settings on `instruments_latency`.
 *   - {@link InstrumentCapabilitiesDB}  — capability matrix on `instruments_latency`.
 *   - {@link RoutingPersistenceDB}      — file/channel→device routings.
 *   - {@link DeviceSettingsDB}          — device-level (clock/rate) flags.
 *
 * The legacy `instruments` (CRUD) and `instrument_latency` (singular)
 * methods that this class used to expose were removed in v6 — both
 * tables were dropped from the baseline schema and no live caller
 * depended on them. Per-channel settings and latency profiles now live
 * exclusively on `instruments_latency` (plural), accessed via the
 * sub-modules above.
 */
import InstrumentSettingsDB from './InstrumentSettingsDB.js';
import InstrumentCapabilitiesDB from './InstrumentCapabilitiesDB.js';
import InstrumentVoicesDB from './InstrumentVoicesDB.js';
import { buildDynamicUpdate } from '../dbHelpers.js';
import RoutingPersistenceDB from './RoutingPersistenceDB.js';
import DeviceSettingsDB from './DeviceSettingsDB.js';

class InstrumentDatabase {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;

    this._settings = new InstrumentSettingsDB(db, logger);
    this._capabilities = new InstrumentCapabilitiesDB(db, logger);
    this._voices = new InstrumentVoicesDB(db, logger);
    this._routing = new RoutingPersistenceDB(db, logger);
    this._deviceSettings = new DeviceSettingsDB(db, logger);
  }

  // ==================== PRESETS ====================
  // The baseline schema names the column `category` (CHECK in
  // {'routing','processing','playback','system'}); the public API
  // surfaces it as `type` for backwards compatibility with the SPA.

  insertPreset(preset) {
    try {
      const result = this.db.prepare(`
        INSERT INTO presets (name, description, category, data)
        VALUES (?, ?, ?, ?)
      `).run(
        preset.name,
        preset.description || null,
        preset.type || preset.category || 'routing',
        preset.data
      );
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
        return this.db.prepare('SELECT * FROM presets WHERE category = ? ORDER BY name').all(type);
      }
      return this.db.prepare('SELECT * FROM presets ORDER BY name').all();
    } catch (error) {
      this.logger.error(`Failed to get presets: ${error.message}`);
      throw error;
    }
  }

  updatePreset(presetId, updates) {
    try {
      // Map API `type` → schema `category` if present.
      const patch = { ...updates };
      if (patch.type !== undefined) {
        patch.category = patch.type;
        delete patch.type;
      }
      const result = buildDynamicUpdate('presets', patch, ['name', 'description', 'category', 'data']);
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
  getOmniInstruments(...args) { return this._settings.getOmniInstruments(...args); }
  findInstrumentById(...args) { return this._settings.findById(...args); }
  updateInstrumentById(...args) { return this._settings.updateById(...args); }
  getAllLatencyProfiles() { return this._settings.getAllLatencyProfiles(); }
  saveDeviceLatency(...args) { return this._settings.saveDeviceLatency(...args); }
  clearDeviceLatency(...args) { return this._settings.clearDeviceLatency(...args); }
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

  // ==================== DELEGATED: INSTRUMENT VOICES (multi-GM) ====================
  // Full implementations in InstrumentVoicesDB.js

  listInstrumentVoices(...args) { return this._voices.listByInstrument(...args); }
  createInstrumentVoice(...args) { return this._voices.create(...args); }
  updateInstrumentVoice(...args) { return this._voices.update(...args); }
  deleteInstrumentVoice(...args) { return this._voices.deleteById(...args); }
  deleteInstrumentVoicesByInstrument(...args) { return this._voices.deleteByInstrument(...args); }
  replaceInstrumentVoices(...args) { return this._voices.replaceAll(...args); }

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
