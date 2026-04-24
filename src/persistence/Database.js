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
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import MidiDatabase from './tables/MidiDatabase.js';
import InstrumentDatabase from './tables/InstrumentDatabase.js';
import LightingDatabase from './tables/LightingDatabase.js';
import StringInstrumentDatabase from './tables/StringInstrumentDatabase.js';
import DeviceSettingsDB from './tables/DeviceSettingsDB.js';
import BankEffectsDB from './tables/BankEffectsDB.js';
import { buildDynamicUpdate } from './dbHelpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

    this.ensureDataDir();
    this.connect();
    this.runMigrations();

    this.midiDB = new MidiDatabase(this.db, this.logger);
    this.instrumentDB = new InstrumentDatabase(this.db, this.logger);
    this.lightingDB = new LightingDatabase(this.db, this.logger);
    this.stringInstrumentDB = new StringInstrumentDatabase(this.db, this.logger);
    this.deviceSettingsDB = new DeviceSettingsDB(this.db, this.logger);
    this.bankEffectsDB = new BankEffectsDB(this.db, this.logger);

    this.logger.info('Database initialized');
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
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.logger.info(`Connected to database: ${this.dbPath}`);
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
   * Each migration runs inside a transaction so partial application
   * cannot poison the DB.
   *
   * @returns {void}
   */
  runMigrations() {
    const migrationsDir = path.join(__dirname, '../../migrations');
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const version = parseInt(file.split('_')[0], 10);
      if (!Number.isFinite(version)) continue;

      if (this.hasMigration(version)) continue;
      this.runMigration(version, file, migrationsDir);
    }

    this.logger.info(`Migrations up to date (current version: ${this.getCurrentVersion()})`);
  }

  /**
   * Current (maximum) applied schema version. Returns 0 when the DB is
   * brand new and `schema_version` does not exist yet.
   */
  getCurrentVersion() {
    try {
      const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get();
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check whether a migration is already recorded. Returns false when
   * `schema_version` does not exist yet (baseline not applied).
   */
  hasMigration(version) {
    try {
      const row = this.db
        .prepare('SELECT 1 FROM schema_version WHERE version = ?')
        .get(version);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  runMigration(version, filename, migrationsDir) {
    const filePath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(filePath, 'utf8');

    this.logger.info(`Running migration ${version}: ${filename}`);
    try {
      this.db.exec('BEGIN TRANSACTION');
      this.db.exec(sql);

      // Ensure the migration is recorded even if the SQL forgot to
      // INSERT into schema_version (defensive).
      this.db
        .prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)')
        .run(version, filename);

      this.db.exec('COMMIT');
      this.logger.info(`Migration ${version} completed`);
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.logger.error(`Migration ${version} failed: ${error.message}`);
      throw error;
    }
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
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
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
        this.db.prepare(`
          UPDATE playlist_items SET position = position - 1
          WHERE playlist_id = ? AND position > ?
        `).run(item.playlist_id, item.position);

        this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
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
      const item = this.db.prepare(
        'SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?'
      ).get(itemId, playlistId);
      if (!item) throw new Error(`Playlist item ${itemId} not found`);

      const oldPosition = item.position;
      if (oldPosition === newPosition) return;

      const reorder = this.db.transaction(() => {
        if (newPosition < oldPosition) {
          // Moving up: shift items between newPosition and oldPosition-1 down
          this.db.prepare(`
            UPDATE playlist_items SET position = position + 1
            WHERE playlist_id = ? AND position >= ? AND position < ?
          `).run(playlistId, newPosition, oldPosition);
        } else {
          // Moving down: shift items between oldPosition+1 and newPosition up
          this.db.prepare(`
            UPDATE playlist_items SET position = position - 1
            WHERE playlist_id = ? AND position > ? AND position <= ?
          `).run(playlistId, oldPosition, newPosition);
        }

        this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?')
          .run(newPosition, itemId);

        this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
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
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
        .run(Date.now(), playlistId);
    } catch (error) {
      this.logger.error(`Failed to clear playlist items: ${error.message}`);
      throw error;
    }
  }

  updatePlaylistLoop(playlistId, loop) {
    try {
      this.db.prepare('UPDATE playlists SET loop = ?, updated_at = ? WHERE id = ?')
        .run(loop ? 1 : 0, Date.now(), playlistId);
    } catch (error) {
      this.logger.error(`Failed to update playlist loop: ${error.message}`);
      throw error;
    }
  }

  updatePlaylistSettings(playlistId, settings) {
    try {
      const updates = [];
      const params = [];
      if (settings.gap_seconds !== undefined) {
        updates.push('gap_seconds = ?');
        params.push(Math.max(0, Math.min(60, parseInt(settings.gap_seconds) || 0)));
      }
      if (settings.shuffle !== undefined) {
        updates.push('shuffle = ?');
        params.push(settings.shuffle ? 1 : 0);
      }
      if (updates.length === 0) return;
      updates.push('updated_at = ?');
      params.push(Date.now());
      params.push(playlistId);
      this.db.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...params);
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
  getAllFiles(options) {
    return this.midiDB.getAllFiles(options);
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

  // Instruments + LatencyProfile generic CRUD methods removed in v6 —
  // both the `instruments` and `instrument_latency` (singular) tables
  // were dropped from the baseline schema. Per-channel settings + latency
  // now live exclusively on `instruments_latency` (plural) via
  // InstrumentSettingsDB / InstrumentCapabilitiesDB.

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
  findInstrumentByMac(macAddress) {
    return this.instrumentDB.findInstrumentByMac(macAddress);
  }
  findInstrumentByUsbSerial(usbSerialNumber) {
    return this.instrumentDB.findInstrumentByUsbSerial(usbSerialNumber);
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
  getRegisteredInstrumentIds() {
    return this.instrumentDB.getRegisteredInstrumentIds();
  }

  // Routing persistence
  insertRouting(routing) {
    return this.instrumentDB.insertRouting(routing);
  }
  insertSplitRoutings(...args) {
    return this.instrumentDB.insertSplitRoutings(...args);
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
    try {
      await this.db.backup(backupPath);
      this.logger.info(`Database backed up to: ${backupPath}`);
    } catch (error) {
      this.logger.error(`Backup failed: ${error.message}`);
      throw error;
    }
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
