/**
 * @file src/persistence/Database.js
 * @description Top-level SQLite façade. Owns the single
 * `better-sqlite3` connection, applies migrations from `migrations/`,
 * and instantiates the per-domain sub-modules.
 *
 * Fresh-install schema (001_baseline.sql) is the single source of
 * truth. Future features each get their own incremental migration
 * (`NNN_snake_case.sql`). Version tracking lives in `schema_version`.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import MidiDatabase from './tables/MidiDatabase.js';
import InstrumentDatabase from './tables/InstrumentDatabase.js';
import LightingDatabase from './tables/LightingDatabase.js';
import StringInstrumentDatabase from './tables/StringInstrumentDatabase.js';
import DeviceSettingsDB from './tables/DeviceSettingsDB.js';
import BankEffectsDB from './tables/BankEffectsDB.js';
import CustomSF2DB from './tables/CustomSF2DB.js';
import LoopsDB from './tables/LoopsDB.js';
import LoopArrangementsDB from './tables/LoopArrangementsDB.js';
import BluetoothDB from './tables/BluetoothDB.js';
import { buildDynamicUpdate } from './dbHelpers.js';
import {
  runMigrations as runSchemaMigrations,
  applyConnectionPragmas
} from './DatabaseLifecycle.js';
import { runWithBusyRetry } from './busyRetry.js';

/**
 * Top-level database manager. One instance per process; registered as
 * `database` in the DI container.
 */
class DatabaseManager {
  /**
   * @param {Object} deps - DI bag (or Application facade). Needs
   *   `logger` and `config` (`config.database.path`).
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.config = deps.config;
    this.dbPath = deps.config.database.path || './data/gmboop.db';
    this.db = null;
    this.midiDB = null;
    this.instrumentDB = null;
    this.lightingDB = null;
    this.stringInstrumentDB = null;
    this.deviceSettingsDB = null;
    this.bankEffectsDB = null;
    this.customSF2DB = null;
    this.loopsDB = null;
    this.loopArrangementsDB = null;
    this.bluetoothDB = null;

    this.ensureDataDir();
    this.connect();
    this.runMigrations();
    this._initSubModules();

    this.logger.info('Database initialized');
  }

  /**
   * (Re)build the per-domain sub-modules bound to the current `this.db`
   * connection. Extracted so it can run both at construction and after
   * restoreFromBackup reopens a fresh connection — otherwise the sub-modules
   * would keep a reference to a closed handle.
   * @returns {void}
   */
  _initSubModules() {
    this.midiDB = new MidiDatabase(this.db, this.logger);
    this.instrumentDB = new InstrumentDatabase(this.db, this.logger);
    this.lightingDB = new LightingDatabase(this.db, this.logger);
    this.stringInstrumentDB = new StringInstrumentDatabase(this.db, this.logger);
    this.deviceSettingsDB = new DeviceSettingsDB(this.db, this.logger);
    this.bankEffectsDB = new BankEffectsDB(this.db, this.logger);
    this.customSF2DB = new CustomSF2DB(this.db, this.logger);
    this.loopsDB = new LoopsDB(this.db, this.logger);
    this.loopArrangementsDB = new LoopArrangementsDB(this.db, this.logger);
    this.bluetoothDB = new BluetoothDB(this.db, this.logger);
  }

  /**
   * Create the directory holding the SQLite file when missing.
   * @returns {void}
   */
  ensureDataDir() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Open the SQLite connection with WAL mode + the pragmas needed by
   * the rest of the application.
   * @returns {void}
   */
  connect() {
    try {
      this.db = new Database(this.dbPath);
      // busy_timeout is the worst-case FREEZE of this process, not just of the
      // query: better-sqlite3 is synchronous, so the SQLite busy handler blocks
      // the event loop — and with it the MIDI scheduler (F-78 / F-130). It is
      // set explicitly here instead of inheriting the driver's 5 s default.
      this.busyTimeoutMs = applyConnectionPragmas(this.db, {
        busyTimeoutMs: this.config?.database?.busyTimeoutMs
      });
      this.logger.info(
        `Connected to database: ${this.dbPath} (busy_timeout=${this.busyTimeoutMs}ms)`
      );
    } catch (error) {
      this.logger.error(`Failed to connect to database: ${error.message}`);
      throw error;
    }
  }

  /**
   * Apply pending migrations from `migrations/` in numeric order. The
   * first file (001_baseline.sql) creates `schema_version` + the full
   * schema; subsequent migrations are single-feature SQL files that
   * each register themselves into `schema_version`.
   *
   * Delegates to the shared runner in `DatabaseLifecycle.js` so the
   * startup path and the one-shot `scripts/migrate-db.js` runner apply
   * migrations identically — including compound `CREATE TRIGGER ...
   * BEGIN ... END;` statements, which the previous statement-splitter
   * broke apart on a fresh install.
   *
   * @returns {void}
   */
  runMigrations() {
    runSchemaMigrations(this.db, this.logger);
  }

  // ==================== ROUTING ====================

  insertRoute(route) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO routes (
          id, source_device, destination_device, channel_mapping, filter, enabled
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        route.id,
        route.source_device,
        route.destination_device,
        route.channel_mapping || '{}',
        route.filter || '{}',
        route.enabled ? 1 : 0
      );

      return route.id;
    } catch (error) {
      this.logger.error(`Failed to insert route: ${error.message}`);
      throw error;
    }
  }

  getRoute(routeId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM routes WHERE id = ?');
      return stmt.get(routeId);
    } catch (error) {
      this.logger.error(`Failed to get route: ${error.message}`);
      throw error;
    }
  }

  getRoutes() {
    try {
      const stmt = this.db.prepare('SELECT * FROM routes');
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get routes: ${error.message}`);
      throw error;
    }
  }

  updateRoute(routeId, updates) {
    try {
      const result = buildDynamicUpdate(
        'routes',
        updates,
        ['source_device', 'destination_device', 'channel_mapping', 'filter', 'enabled'],
        { transforms: { enabled: (v) => (v ? 1 : 0) } }
      );
      if (!result) return;

      result.values.push(routeId);
      this.db.prepare(result.sql).run(...result.values);
    } catch (error) {
      this.logger.error(`Failed to update route: ${error.message}`);
      throw error;
    }
  }

  deleteRoute(routeId) {
    try {
      const stmt = this.db.prepare('DELETE FROM routes WHERE id = ?');
      stmt.run(routeId);
    } catch (error) {
      this.logger.error(`Failed to delete route: ${error.message}`);
      throw error;
    }
  }

  // ==================== SESSIONS ====================

  insertSession(session) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (
          name, description, data, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `);

      const now = new Date().toISOString();
      const result = stmt.run(session.name, session.description || null, session.data, now, now);

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert session: ${error.message}`);
      throw error;
    }
  }

  getSession(sessionId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
      return stmt.get(sessionId);
    } catch (error) {
      this.logger.error(`Failed to get session: ${error.message}`);
      throw error;
    }
  }

  getSessions() {
    try {
      const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get sessions: ${error.message}`);
      throw error;
    }
  }

  updateSession(sessionId, updates) {
    try {
      // Always update the timestamp
      const withTimestamp = { ...updates, updated_at: new Date().toISOString() };
      const result = buildDynamicUpdate('sessions', withTimestamp, [
        'name',
        'description',
        'data',
        'updated_at'
      ]);
      if (!result) return;

      result.values.push(sessionId);
      this.db.prepare(result.sql).run(...result.values);
    } catch (error) {
      this.logger.error(`Failed to update session: ${error.message}`);
      throw error;
    }
  }

  deleteSession(sessionId) {
    try {
      const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      stmt.run(sessionId);
    } catch (error) {
      this.logger.error(`Failed to delete session: ${error.message}`);
      throw error;
    }
  }

  // ==================== PLAYLISTS ====================

  insertPlaylist(playlist) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO playlists (
          name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
      `);

      const now = Date.now();
      const result = stmt.run(playlist.name, playlist.description || null, now, now);

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert playlist: ${error.message}`);
      throw error;
    }
  }

  getPlaylist(playlistId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM playlists WHERE id = ?');
      return stmt.get(playlistId);
    } catch (error) {
      this.logger.error(`Failed to get playlist: ${error.message}`);
      throw error;
    }
  }

  getPlaylists() {
    try {
      const stmt = this.db.prepare('SELECT * FROM playlists ORDER BY name');
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get playlists: ${error.message}`);
      throw error;
    }
  }

  deletePlaylist(playlistId) {
    try {
      const stmt = this.db.prepare('DELETE FROM playlists WHERE id = ?');
      stmt.run(playlistId);
    } catch (error) {
      this.logger.error(`Failed to delete playlist: ${error.message}`);
      throw error;
    }
  }

  // ==================== PLAYLIST ITEMS ====================

  getPlaylistItems(playlistId) {
    try {
      const stmt = this.db.prepare(`
        SELECT pi.*, mf.filename, mf.duration, mf.tempo, mf.tracks
        FROM playlist_items pi
        JOIN midi_files mf ON pi.midi_id = mf.id
        WHERE pi.playlist_id = ?
        ORDER BY pi.position
      `);
      return stmt.all(playlistId);
    } catch (error) {
      this.logger.error(`Failed to get playlist items: ${error.message}`);
      throw error;
    }
  }

  addPlaylistItem(playlistId, midiId, position) {
    try {
      if (position === undefined || position === null) {
        const maxStmt = this.db.prepare(
          'SELECT COALESCE(MAX(position), -1) as maxPos FROM playlist_items WHERE playlist_id = ?'
        );
        const row = maxStmt.get(playlistId);
        position = row.maxPos + 1;
      }

      const stmt = this.db.prepare(
        'INSERT INTO playlist_items (playlist_id, midi_id, position) VALUES (?, ?, ?)'
      );
      const result = stmt.run(playlistId, midiId, position);

      // Update playlist updated_at
      this.db
        .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
        .run(Date.now(), playlistId);

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to add playlist item: ${error.message}`);
      throw error;
    }
  }

  removePlaylistItem(itemId) {
    try {
      const item = this.db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(itemId);
      if (!item) return;

      const remove = this.db.transaction(() => {
        this.db.prepare('DELETE FROM playlist_items WHERE id = ?').run(itemId);
        // Recompact positions
        this.db
          .prepare(
            `
          UPDATE playlist_items SET position = position - 1
          WHERE playlist_id = ? AND position > ?
        `
          )
          .run(item.playlist_id, item.position);

        this.db
          .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
          .run(Date.now(), item.playlist_id);
      });
      remove();
    } catch (error) {
      this.logger.error(`Failed to remove playlist item: ${error.message}`);
      throw error;
    }
  }

  reorderPlaylistItem(playlistId, itemId, newPosition) {
    try {
      const item = this.db
        .prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
        .get(itemId, playlistId);
      if (!item) throw new Error(`Playlist item ${itemId} not found`);

      const oldPosition = item.position;
      if (oldPosition === newPosition) return;

      const reorder = this.db.transaction(() => {
        if (newPosition < oldPosition) {
          // Moving up: shift items between newPosition and oldPosition-1 down
          this.db
            .prepare(
              `
            UPDATE playlist_items SET position = position + 1
            WHERE playlist_id = ? AND position >= ? AND position < ?
          `
            )
            .run(playlistId, newPosition, oldPosition);
        } else {
          // Moving down: shift items between oldPosition+1 and newPosition up
          this.db
            .prepare(
              `
            UPDATE playlist_items SET position = position - 1
            WHERE playlist_id = ? AND position > ? AND position <= ?
          `
            )
            .run(playlistId, oldPosition, newPosition);
        }

        this.db
          .prepare('UPDATE playlist_items SET position = ? WHERE id = ?')
          .run(newPosition, itemId);

        this.db
          .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
          .run(Date.now(), playlistId);
      });
      reorder();
    } catch (error) {
      this.logger.error(`Failed to reorder playlist item: ${error.message}`);
      throw error;
    }
  }

  clearPlaylistItems(playlistId) {
    try {
      this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlistId);
      this.db
        .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
        .run(Date.now(), playlistId);
    } catch (error) {
      this.logger.error(`Failed to clear playlist items: ${error.message}`);
      throw error;
    }
  }

  updatePlaylistLoop(playlistId, loop) {
    try {
      this.db
        .prepare('UPDATE playlists SET loop = ?, updated_at = ? WHERE id = ?')
        .run(loop ? 1 : 0, Date.now(), playlistId);
    } catch (error) {
      this.logger.error(`Failed to update playlist loop: ${error.message}`);
      throw error;
    }
  }

  updatePlaylistSettings(playlistId, settings) {
    try {
      if (settings.gap_seconds === undefined && settings.shuffle === undefined) return;
      const result = buildDynamicUpdate(
        'playlists',
        { ...settings, updated_at: Date.now() },
        ['gap_seconds', 'shuffle', 'updated_at'],
        {
          transforms: {
            gap_seconds: (v) => Math.max(0, Math.min(60, parseInt(v) || 0)),
            shuffle: (v) => (v ? 1 : 0)
          }
        }
      );
      this.db.prepare(result.sql).run(...result.values, playlistId);
    } catch (error) {
      this.logger.error(`Failed to update playlist settings: ${error.message}`);
      throw error;
    }
  }

  // Wrap a synchronous function in a SQLite transaction so multi-step writes
  // either all commit or all roll back. Returns the underlying wrapper so
  // callers can invoke it with their own arguments.
  transaction(fn) {
    return this.db.transaction(fn);
  }

  /**
   * Run a synchronous write, retrying `SQLITE_BUSY` **across `await` points**
   * so the event loop — and the MIDI scheduler — runs between attempts.
   *
   * `busy_timeout` alone only bounds ONE freeze (F-78/F-130); this bounds the
   * freeze *and* keeps a write from being lost to a transient external lock.
   * Callers get a named {@link DatabaseBusyError} when every attempt failed,
   * never a silent no-op.
   *
   * @template T
   * @param {() => T} fn - Re-runnable synchronous write.
   * @param {{attempts?:number, backoffMs?:number, operation?:string}} [options]
   * @returns {Promise<T>}
   */
  runWriteWithRetry(fn, options = {}) {
    return runWithBusyRetry(fn, { logger: this.logger, ...options });
  }

  // ==================== DELEGATE TO SUB-MODULES ====================

  // MIDI Files
  insertFile(file) {
    return this.midiDB.insertFile(file);
  }
  getFile(fileId) {
    return this.midiDB.getFile(fileId);
  }
  getFileByContentHash(hash) {
    return this.midiDB.getFileByContentHash(hash);
  }
  getFileInfo(fileId) {
    return this.midiDB.getFileInfo(fileId);
  }
  getFiles(folder) {
    return this.midiDB.getFiles(folder);
  }
  getAllFiles() {
    return this.midiDB.getAllFiles();
  }
  updateFile(fileId, updates) {
    return this.midiDB.updateFile(fileId, updates);
  }
  deleteFile(fileId) {
    return this.midiDB.deleteFile(fileId);
  }
  getFolders() {
    return this.midiDB.getFolders();
  }
  searchFiles(query) {
    return this.midiDB.searchFiles(query);
  }
  filterFiles(filters) {
    return this.midiDB.filterFiles(filters);
  }

  // MIDI File Channels
  insertFileChannels(fileId, channels) {
    return this.midiDB.insertFileChannels(fileId, channels);
  }
  getFileChannels(fileId) {
    return this.midiDB.getFileChannels(fileId);
  }
  deleteFileChannels(fileId) {
    return this.midiDB.deleteFileChannels(fileId);
  }

  // MIDI File Tempo Map
  insertFileTempoMap(fileId, tempoMap) {
    return this.midiDB.insertFileTempoMap(fileId, tempoMap);
  }
  getFileTempoMap(fileId) {
    return this.midiDB.getFileTempoMap(fileId);
  }
  deleteFileTempoMap(fileId) {
    return this.midiDB.deleteFileTempoMap(fileId);
  }
  countFilesWithoutChannels() {
    return this.midiDB.countFilesWithoutChannels();
  }
  countFilesNeedingReanalysis() {
    return this.midiDB.countFilesNeedingReanalysis();
  }
  getDistinctInstruments() {
    return this.midiDB.getDistinctInstruments();
  }
  getDistinctCategories() {
    return this.midiDB.getDistinctCategories();
  }
  findFilesByInstrument(instruments, mode) {
    return this.midiDB.findFilesByInstrument(instruments, mode);
  }
  findFilesByCategory(categories, mode) {
    return this.midiDB.findFilesByCategory(categories, mode);
  }

  deleteInstrumentSettingsByDevice(...args) {
    return this.instrumentDB.deleteInstrumentSettingsByDevice(...args);
  }

  // Presets
  insertPreset(preset) {
    return this.instrumentDB.insertPreset(preset);
  }
  getPreset(presetId) {
    return this.instrumentDB.getPreset(presetId);
  }
  getPresets(type) {
    return this.instrumentDB.getPresets(type);
  }
  updatePreset(presetId, updates) {
    return this.instrumentDB.updatePreset(presetId, updates);
  }
  deletePreset(presetId) {
    return this.instrumentDB.deletePreset(presetId);
  }

  // Instrument Settings
  updateInstrumentSettings(...args) {
    return this.instrumentDB.updateInstrumentSettings(...args);
  }
  getInstrumentSettings(...args) {
    return this.instrumentDB.getInstrumentSettings(...args);
  }
  findInstrumentById(...args) {
    return this.instrumentDB.findInstrumentById(...args);
  }
  updateInstrumentById(...args) {
    return this.instrumentDB.updateInstrumentById(...args);
  }
  getAllLatencyProfiles() {
    return this.instrumentDB.getAllLatencyProfiles();
  }
  saveDeviceLatency(...args) {
    return this.instrumentDB.saveDeviceLatency(...args);
  }
  clearDeviceLatency(...args) {
    return this.instrumentDB.clearDeviceLatency(...args);
  }
  saveSysExIdentity(...args) {
    return this.instrumentDB.saveSysExIdentity(...args);
  }
  saveSysExIdentityForDevice(...args) {
    return this.instrumentDB.saveSysExIdentityForDevice(...args);
  }
  findInstrumentByMac(macAddress) {
    return this.instrumentDB.findInstrumentByMac(macAddress);
  }
  findInstrumentByUsbSerial(usbSerialNumber) {
    return this.instrumentDB.findInstrumentByUsbSerial(usbSerialNumber);
  }
  findInstrumentByNormalizedName(...args) {
    return this.instrumentDB.findInstrumentByNormalizedName(...args);
  }
  reconcileDeviceId(...args) {
    return this.instrumentDB.reconcileDeviceId(...args);
  }
  deduplicateByUsbSerial(...args) {
    return this.instrumentDB.deduplicateByUsbSerial(...args);
  }

  // Instrument Capabilities
  updateInstrumentCapabilities(...args) {
    return this.instrumentDB.updateInstrumentCapabilities(...args);
  }
  getInstrumentCapabilities(...args) {
    return this.instrumentDB.getInstrumentCapabilities(...args);
  }
  getAllInstrumentCapabilities() {
    return this.instrumentDB.getAllInstrumentCapabilities();
  }
  getInstrumentsWithCapabilities() {
    return this.instrumentDB.getInstrumentsWithCapabilities();
  }
  getInstrumentCatalogFingerprint() {
    return this.instrumentDB.getInstrumentCatalogFingerprint();
  }

  // Instrument Embedded Lights (CC 110-114 generic scheme)
  getInstrumentLightState(...args) {
    return this.instrumentDB.getInstrumentLightState(...args);
  }
  getAllInstrumentLightStates() {
    return this.instrumentDB.getAllInstrumentLightStates();
  }
  saveInstrumentLightState(...args) {
    return this.instrumentDB.saveInstrumentLightState(...args);
  }
  deleteInstrumentLightByDevice(...args) {
    return this.instrumentDB.deleteInstrumentLightByDevice(...args);
  }
  getRegisteredInstrumentIds() {
    return this.instrumentDB.getRegisteredInstrumentIds();
  }

  // Instrument Voices (secondary GM alternatives keyed by device_id + channel).
  listInstrumentVoices(...args) {
    return this.instrumentDB.listInstrumentVoices(...args);
  }
  createInstrumentVoice(...args) {
    return this.instrumentDB.createInstrumentVoice(...args);
  }
  updateInstrumentVoice(...args) {
    return this.instrumentDB.updateInstrumentVoice(...args);
  }
  deleteInstrumentVoice(...args) {
    return this.instrumentDB.deleteInstrumentVoice(...args);
  }
  deleteInstrumentVoicesByInstrument(...args) {
    return this.instrumentDB.deleteInstrumentVoicesByInstrument(...args);
  }
  replaceInstrumentVoices(...args) {
    return this.instrumentDB.replaceInstrumentVoices(...args);
  }

  // Routing persistence
  insertRouting(routing) {
    return this.instrumentDB.insertRouting(routing);
  }
  insertSplitRoutings(...args) {
    return this.instrumentDB.insertSplitRoutings(...args);
  }
  updateHandOverrides(...args) {
    return this.instrumentDB.updateHandOverrides(...args);
  }
  getRoutingsByFile(fileId, includeDisabled) {
    return this.instrumentDB.getRoutingsByFile(fileId, includeDisabled);
  }
  getRoutingCountsByFiles(fileIds, connectedDeviceIds) {
    return this.instrumentDB.getRoutingCountsByFiles(fileIds, connectedDeviceIds);
  }
  deleteRoutingsByFile(fileId) {
    return this.instrumentDB.deleteRoutingsByFile(fileId);
  }
  deleteActiveAutoRoutingsByFile(fileId) {
    return this.instrumentDB.deleteActiveAutoRoutingsByFile(fileId);
  }
  deleteNonSplitRoutingsByFile(fileId) {
    return this.instrumentDB.deleteNonSplitRoutingsByFile(fileId);
  }
  deleteRoutingsByDevice(...args) {
    return this.instrumentDB.deleteRoutingsByDevice(...args);
  }
  getInstrumentsByDevice(deviceId) {
    return this.instrumentDB.getInstrumentsByDevice(deviceId);
  }
  getOmniInstruments() {
    return this.instrumentDB.getOmniInstruments();
  }

  // Lighting Devices
  insertLightingDevice(device) {
    return this.lightingDB.insertDevice(device);
  }
  getLightingDevice(id) {
    return this.lightingDB.getDevice(id);
  }
  getLightingDevices() {
    return this.lightingDB.getDevices();
  }
  updateLightingDevice(id, updates) {
    return this.lightingDB.updateDevice(id, updates);
  }
  deleteLightingDevice(id) {
    return this.lightingDB.deleteDevice(id);
  }

  // Lighting Rules
  insertLightingRule(rule) {
    return this.lightingDB.insertRule(rule);
  }
  getLightingRule(id) {
    return this.lightingDB.getRule(id);
  }
  getLightingRulesForDevice(deviceId) {
    return this.lightingDB.getRulesForDevice(deviceId);
  }
  getAllEnabledLightingRules() {
    return this.lightingDB.getAllEnabledRules();
  }
  getAllLightingRules() {
    return this.lightingDB.getAllRules();
  }
  updateLightingRule(id, updates) {
    return this.lightingDB.updateRule(id, updates);
  }
  deleteLightingRule(id) {
    return this.lightingDB.deleteRule(id);
  }

  // Lighting Presets
  insertLightingPreset(preset) {
    return this.lightingDB.insertPreset(preset);
  }
  getLightingPresets() {
    return this.lightingDB.getPresets();
  }
  deleteLightingPreset(id) {
    return this.lightingDB.deletePreset(id);
  }

  // Lighting Groups
  insertLightingGroup(name, deviceIds) {
    return this.lightingDB.insertGroup(name, deviceIds);
  }
  getLightingGroups() {
    return this.lightingDB.getGroups();
  }
  updateLightingGroup(name, deviceIds) {
    return this.lightingDB.updateGroup(name, deviceIds);
  }
  deleteLightingGroup(name) {
    return this.lightingDB.deleteGroup(name);
  }

  // String Instruments
  createStringInstrument(config) {
    return this.stringInstrumentDB.createStringInstrument(config);
  }
  getStringInstrument(deviceId, channel) {
    return this.stringInstrumentDB.getStringInstrument(deviceId, channel);
  }
  getStringInstrumentById(id) {
    return this.stringInstrumentDB.getStringInstrumentById(id);
  }
  getAllStringInstruments() {
    return this.stringInstrumentDB.getAllStringInstruments();
  }
  getStringInstrumentsByDevice(deviceId) {
    return this.stringInstrumentDB.getStringInstrumentsByDevice(deviceId);
  }
  updateStringInstrument(id, updates) {
    return this.stringInstrumentDB.updateStringInstrument(id, updates);
  }
  deleteStringInstrument(id) {
    return this.stringInstrumentDB.deleteStringInstrument(id);
  }
  deleteStringInstrumentByDeviceChannel(deviceId, channel) {
    return this.stringInstrumentDB.deleteStringInstrumentByDeviceChannel(deviceId, channel);
  }
  /**
   * Delete a device's string-instrument rows (optionally one channel).
   * Exposed on the facade so the `instrument_delete` cascade can run every leg
   * through a single object inside one transaction (F-81).
   * @param {string} deviceId
   * @param {?number} [channel]
   * @returns {number} Rows removed.
   */
  deleteStringInstrumentsByDevice(deviceId, channel) {
    return this.stringInstrumentDB.deleteByDevice(deviceId, channel);
  }

  // Tablature Data
  saveTablature(...args) {
    return this.stringInstrumentDB.saveTablature(...args);
  }
  getTablature(midiFileId, channel) {
    return this.stringInstrumentDB.getTablature(midiFileId, channel);
  }
  getTablaturesByFile(midiFileId) {
    return this.stringInstrumentDB.getTablaturesByFile(midiFileId);
  }
  deleteTablature(midiFileId, channel) {
    return this.stringInstrumentDB.deleteTablature(midiFileId, channel);
  }
  deleteTablaturesByFile(midiFileId) {
    return this.stringInstrumentDB.deleteTablaturesByFile(midiFileId);
  }

  // Device Settings
  getDeviceSettings(deviceId) {
    return this.deviceSettingsDB.getDeviceSettings(deviceId);
  }
  updateDeviceSettings(deviceId, settings) {
    return this.deviceSettingsDB.updateDeviceSettings(deviceId, settings);
  }
  ensureDevice(deviceId, name, type) {
    return this.deviceSettingsDB.ensureDevice(deviceId, name, type);
  }

  // Sound-bank effect overrides (browser synth)
  getBankEffects(bankId) {
    return this.bankEffectsDB.getForBank(bankId);
  }
  listBankEffects() {
    return this.bankEffectsDB.listAll();
  }
  upsertBankEffects(bankId, values) {
    return this.bankEffectsDB.upsert(bankId, values);
  }
  resetBankEffects(bankId) {
    return this.bankEffectsDB.resetBank(bankId);
  }

  // ==================== UTILITIES ====================

  close() {
    if (this.db) {
      this.db.close();
      this.logger.info('Database closed');
    }
  }

  async backup(backupPath) {
    // Write to a temp path and rename into place only on success. better-sqlite3
    // writes `db.backup()` straight to its destination, so a mid-backup failure
    // (disk full on a Pi SD card) would otherwise leave a PARTIAL file at the
    // canonical `gmboop-<ts>.db` name — which passes the restore header check
    // and ranks as the "newest" backup, so retention keeps it and prunes good
    // ones. rename() is atomic within a filesystem (audit A3 M2).
    const tmpPath = `${backupPath}.tmp`;
    try {
      await this.db.backup(tmpPath);
      fs.renameSync(tmpPath, backupPath);
      this.logger.info(`Database backed up to: ${backupPath}`);
    } catch (error) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (cleanupErr) {
        this.logger.warn(`Backup temp cleanup failed: ${cleanupErr.message}`);
      }
      this.logger.error(`Backup failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Restore the live database from a backup file. The backup is validated
   * (SQLite magic header) and copied over the live DB file while the
   * connection is closed; the WAL/SHM sidecars are removed so the next
   * open starts from a clean, consistent file. The caller is expected to
   * restart the process afterwards so every service reopens the new DB.
   *
   * @param {string} backupPath - Absolute path to a backup `.db` file.
   * @returns {void}
   * @throws {Error} If the source is missing or is not a SQLite file.
   */
  restoreFromBackup(backupPath) {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }
    // Validate the source by OPENING it read-only and running an integrity
    // check. A 15-byte magic-header sniff passes for a truncated/body-corrupt
    // file (e.g. a partial backup from a disk-full event), which would then be
    // copied over the live DB and brick the box (audit A3 M1).
    let integrity;
    let checkDb = null;
    try {
      checkDb = new Database(backupPath, { readonly: true, fileMustExist: true });
      integrity = checkDb.pragma('integrity_check', { simple: true });
    } catch (err) {
      throw new Error(`Backup file is not a valid SQLite database: ${err.message}`);
    } finally {
      try {
        checkDb?.close();
      } catch {
        /* ignore */
      }
    }
    if (integrity !== 'ok') {
      throw new Error(`Backup failed integrity check: ${integrity}`);
    }

    // Close the live connection before swapping the file on disk. A clean close
    // of the last connection checkpoints and removes the WAL/SHM sidecars.
    try {
      if (this.db) this.db.close();
    } catch (err) {
      this.logger.warn(`Closing DB before restore failed: ${err.message}`);
    }
    this.db = null;

    // Atomic swap: stage the validated backup beside the live file, preserve the
    // current live DB as `.prerestore`, then rename the stage into place. A
    // failure at any step leaves a recoverable DB rather than a half-copied one
    // (audit A3 M1) — the previous code copied straight over the live file, so a
    // mid-copy error destroyed it with no fallback.
    const stagePath = `${this.dbPath}.restore-tmp`;
    const prevPath = `${this.dbPath}.prerestore`;
    try {
      fs.copyFileSync(backupPath, stagePath);
      // Drop stale WAL/SHM so the swapped-in file opens clean (safe: the close
      // above already checkpointed them into the old main file).
      for (const sidecar of [`${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        try {
          if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
        } catch (err) {
          this.logger.warn(`Removing ${sidecar} during restore failed: ${err.message}`);
        }
      }
      if (fs.existsSync(this.dbPath)) fs.renameSync(this.dbPath, prevPath);
      fs.renameSync(stagePath, this.dbPath);
      try {
        if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
      } catch {
        /* best effort — the restore already succeeded */
      }
    } catch (err) {
      this.logger.error(`Restore swap failed: ${err.message}`);
      // Roll back the live DB if we already moved it aside.
      try {
        if (!fs.existsSync(this.dbPath) && fs.existsSync(prevPath)) {
          fs.renameSync(prevPath, this.dbPath);
        }
      } catch (rollbackErr) {
        this.logger.error(`Restore rollback failed: ${rollbackErr.message}`);
      }
      try {
        if (fs.existsSync(stagePath)) fs.unlinkSync(stagePath);
      } catch {
        /* ignore */
      }
      // Reopen whatever DB survived so the manager stays usable, then surface.
      this.connect();
      this.runMigrations();
      this._initSubModules();
      throw err;
    }

    // Reopen the connection and rebuild the sub-modules so this manager is
    // immediately usable instead of leaving every sub-module holding the closed
    // handle (audit P3 — a caller that touched the DB before an external restart
    // hit "database connection is not open"). A full process restart is still
    // recommended so other long-lived caches drop stale state.
    this.connect();
    this.runMigrations();
    this._initSubModules();

    this.logger.info(`Database restored from ${backupPath}; a process restart is recommended`);
  }

  vacuum() {
    try {
      this.db.exec('VACUUM');
      this.logger.info('Database vacuumed');
    } catch (error) {
      this.logger.error(`Vacuum failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== LOOP ARRANGEMENTS ====================

  insertArrangement(a) {
    return this.loopArrangementsDB.insertArrangement(a);
  }
  getArrangement(id) {
    return this.loopArrangementsDB.getArrangement(id);
  }
  getArrangements() {
    return this.loopArrangementsDB.getArrangements();
  }
  updateArrangement(id, f) {
    return this.loopArrangementsDB.updateArrangement(id, f);
  }
  deleteArrangement(id) {
    return this.loopArrangementsDB.deleteArrangement(id);
  }
  insertTrack(t) {
    return this.loopArrangementsDB.insertTrack(t);
  }
  getTracks(arrId) {
    return this.loopArrangementsDB.getTracks(arrId);
  }
  getTrack(id) {
    return this.loopArrangementsDB.getTrack(id);
  }
  updateTrack(id, f) {
    return this.loopArrangementsDB.updateTrack(id, f);
  }
  deleteTrack(id) {
    return this.loopArrangementsDB.deleteTrack(id);
  }
  insertBlock(b) {
    return this.loopArrangementsDB.insertBlock(b);
  }
  getBlocks(trackId) {
    return this.loopArrangementsDB.getBlocks(trackId);
  }
  getAllBlocksForArrangement(id) {
    return this.loopArrangementsDB.getAllBlocksForArrangement(id);
  }
  getFullArrangement(id) {
    return this.loopArrangementsDB.getFullArrangement(id);
  }
  countBlocksByLoopId(loopId) {
    return this.loopArrangementsDB.countBlocksByLoopId(loopId);
  }
  updateBlock(id, f) {
    return this.loopArrangementsDB.updateBlock(id, f);
  }
  deleteBlock(id) {
    return this.loopArrangementsDB.deleteBlock(id);
  }

  // ==================== LOOPS ====================

  insertLoop(loop) {
    return this.loopsDB.insertLoop(loop);
  }
  getLoop(id) {
    return this.loopsDB.getLoop(id);
  }
  getLoops() {
    return this.loopsDB.getLoops();
  }
  updateLoop(id, fields) {
    return this.loopsDB.updateLoop(id, fields);
  }
  deleteLoop(id) {
    return this.loopsDB.deleteLoop(id);
  }

  getStats() {
    try {
      const safeCount = (table) => {
        try {
          return this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
        } catch {
          return 0;
        }
      };

      const stats = {
        size: fs.statSync(this.dbPath).size,
        files: safeCount('midi_files'),
        routes: safeCount('routes'),
        instruments: safeCount('instruments_latency'),
        sessions: safeCount('sessions'),
        playlists: safeCount('playlists')
      };
      return stats;
    } catch (error) {
      this.logger.error(`Failed to get stats: ${error.message}`);
      throw error;
    }
  }
}

export default DatabaseManager;
