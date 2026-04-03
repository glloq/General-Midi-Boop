// src/storage/Database.js
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import MidiDatabase from './MidiDatabase.js';
import InstrumentDatabase from './InstrumentDatabase.js';
import LightingDatabase from './LightingDatabase.js';
import StringInstrumentDatabase from './StringInstrumentDatabase.js';
import { buildDynamicUpdate } from './dbHelpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class DatabaseManager {
  constructor(deps) {
    this.logger = deps.logger;
    this.config = deps.config;
    this.dbPath = deps.config.database.path || './data/midimind.db';
    this.db = null;
    this.midiDB = null;
    this.instrumentDB = null;
    this.lightingDB = null;
    this.stringInstrumentDB = null;

    this.ensureDataDir();
    this.connect();
    this.runMigrations();

    // Ensure instrument capabilities columns exist (safety net)
    this.ensureInstrumentCapabilitiesColumns();

    // Initialize sub-modules
    this.midiDB = new MidiDatabase(this.db, this.logger);
    this.instrumentDB = new InstrumentDatabase(this.db, this.logger);
    this.lightingDB = new LightingDatabase(this.db, this.logger);
    this.stringInstrumentDB = new StringInstrumentDatabase(this.db, this.logger);

    // Migrate base64 TEXT data to binary BLOB (one-time, after migration 031)
    this._migrateBase64ToBlob();

    // Repair: populate channel_count from midi_file_channels for files missing it
    this._repairMissingChannelCounts();

    this.logger.info('Database initialized');
  }

  /**
   * Convert base64 TEXT data to binary BLOB for MIDI files.
   * Processes in batches to limit memory usage on RPi.
   */
  _migrateBase64ToBlob() {
    try {
      // Check if data_blob column exists (migration 034 applied)
      const columns = this.db.prepare("SELECT name FROM pragma_table_info('midi_files')").all();
      const hasDataBlob = columns.some(c => c.name === 'data_blob');
      if (!hasDataBlob) return;

      // Find files that have base64 data but no blob
      const pending = this.db.prepare(
        'SELECT id FROM midi_files WHERE data IS NOT NULL AND data_blob IS NULL LIMIT 50'
      ).all();

      if (pending.length === 0) return;

      this.logger.info(`[DB Migration] Converting ${pending.length} file(s) from base64 to BLOB...`);

      const update = this.db.prepare('UPDATE midi_files SET data_blob = ?, data = NULL WHERE id = ?');
      const select = this.db.prepare('SELECT data FROM midi_files WHERE id = ?');

      const batchConvert = this.db.transaction((ids) => {
        for (const { id } of ids) {
          const row = select.get(id);
          if (row && row.data) {
            const buffer = Buffer.from(row.data, 'base64');
            update.run(buffer, id);
          }
        }
      });

      batchConvert(pending);
      this.logger.info(`[DB Migration] Converted ${pending.length} file(s) to BLOB format`);

      // Check if more remain
      const remaining = this.db.prepare(
        'SELECT COUNT(*) as count FROM midi_files WHERE data IS NOT NULL AND data_blob IS NULL'
      ).get();
      if (remaining.count > 0) {
        this.logger.info(`[DB Migration] ${remaining.count} file(s) still need conversion (will continue next startup)`);
      }
    } catch (err) {
      this.logger.warn(`[DB Migration] Base64 to BLOB conversion: ${err.message}`);
    }
  }

  /**
   * Fix files where channel_count is 0 but midi_file_channels has actual channel data.
   * This can happen if files were uploaded before channel analysis was implemented.
   */
  _repairMissingChannelCounts() {
    try {
      const result = this.db.prepare(`
        UPDATE midi_files SET channel_count = (
          SELECT COUNT(*) FROM midi_file_channels WHERE midi_file_id = midi_files.id
        ) WHERE (channel_count IS NULL OR channel_count = 0)
          AND id IN (SELECT DISTINCT midi_file_id FROM midi_file_channels)
      `).run();
      if (result.changes > 0) {
        this.logger.info(`[DB Repair] Updated channel_count for ${result.changes} file(s) from midi_file_channels`);
      }
    } catch (err) {
      this.logger.warn(`[DB Repair] Failed to repair channel counts: ${err.message}`);
    }
  }

  ensureDataDir() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

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

  runMigrations() {
    try {
      // Create migrations table if not exists
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version INTEGER UNIQUE NOT NULL,
          name TEXT NOT NULL,
          executed_at TEXT NOT NULL
        )
      `);

      // Get current version
      const currentVersion = this.getCurrentVersion();
      this.logger.info(`Current database version: ${currentVersion}`);

      // Load and run migrations
      const migrationsDir = path.join(__dirname, '../../migrations');
      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of migrationFiles) {
        const version = parseInt(file.split('_')[0]);

        if (version > currentVersion) {
          this.runMigration(version, file, migrationsDir);
        }
      }

      this.logger.info('Migrations completed');
    } catch (error) {
      this.logger.error(`Migration failed: ${error.message}`);
      throw error;
    }
  }

  getCurrentVersion() {
    try {
      const result = this.db.prepare('SELECT MAX(version) as version FROM migrations').get();
      return result.version || 0;
    } catch (error) {
      return 0;
    }
  }

  runMigration(version, filename, migrationsDir) {
    const filePath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(filePath, 'utf8');

    try {
      this.logger.info(`Running migration ${version}: ${filename}`);

      // Run migration in transaction
      this.db.exec('BEGIN TRANSACTION');
      this.db.exec(sql);

      // Record migration
      const stmt = this.db.prepare(`
        INSERT INTO migrations (version, name, executed_at)
        VALUES (?, ?, ?)
      `);
      stmt.run(version, filename, new Date().toISOString());

      this.db.exec('COMMIT');

      this.logger.info(`Migration ${version} completed`);
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.logger.error(`Migration ${version} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Rollback the last N migrations using down scripts.
   * Down scripts must exist in migrations/down/ with matching filenames.
   * @param {number} steps - Number of migrations to rollback (default 1)
   */
  rollbackMigrations(steps = 1) {
    const migrationsDir = path.join(__dirname, '../../migrations');
    const downDir = path.join(migrationsDir, 'down');

    if (!fs.existsSync(downDir)) {
      throw new Error('No down migrations directory found');
    }

    const applied = this.db
      .prepare('SELECT version, name FROM migrations ORDER BY version DESC LIMIT ?')
      .all(steps);

    if (applied.length === 0) {
      this.logger.info('No migrations to rollback');
      return;
    }

    // Pre-check: ensure ALL down migration files exist before starting
    for (const migration of applied) {
      const downFile = path.join(downDir, migration.name);
      if (!fs.existsSync(downFile)) {
        throw new Error(`Down migration not found for ${migration.name}. Cannot rollback.`);
      }
    }

    for (const migration of applied) {
      const downFile = path.join(downDir, migration.name);
      const sql = fs.readFileSync(downFile, 'utf8');
      try {
        this.logger.info(`Rolling back migration ${migration.version}: ${migration.name}`);
        this.db.exec('BEGIN TRANSACTION');
        this.db.exec(sql);
        this.db.prepare('DELETE FROM migrations WHERE version = ?').run(migration.version);
        this.db.exec('COMMIT');
        this.logger.info(`Rollback of migration ${migration.version} completed`);
      } catch (error) {
        this.db.exec('ROLLBACK');
        this.logger.error(
          `Rollback of migration ${migration.version} failed: ${error.message}`
        );
        throw error;
      }
    }
  }

  /**
   * Ensure required columns exist in instruments_latency table
   * This is a safety net for partial migration failures
   */
  ensureInstrumentCapabilitiesColumns() {
    const requiredColumns = [
      {
        name: 'note_range_min',
        sql: 'ALTER TABLE instruments_latency ADD COLUMN note_range_min INTEGER'
      },
      {
        name: 'note_range_max',
        sql: 'ALTER TABLE instruments_latency ADD COLUMN note_range_max INTEGER'
      },
      {
        name: 'supported_ccs',
        sql: 'ALTER TABLE instruments_latency ADD COLUMN supported_ccs TEXT'
      },
      {
        name: 'note_selection_mode',
        sql: "ALTER TABLE instruments_latency ADD COLUMN note_selection_mode TEXT DEFAULT 'range'"
      },
      {
        name: 'selected_notes',
        sql: 'ALTER TABLE instruments_latency ADD COLUMN selected_notes TEXT'
      },
      {
        name: 'capabilities_source',
        sql: "ALTER TABLE instruments_latency ADD COLUMN capabilities_source TEXT DEFAULT 'manual'"
      },
      {
        name: 'capabilities_updated_at',
        sql: 'ALTER TABLE instruments_latency ADD COLUMN capabilities_updated_at TEXT'
      },
      { name: 'gm_program', sql: 'ALTER TABLE instruments_latency ADD COLUMN gm_program INTEGER' },
      {
        name: 'polyphony',
        sql: 'ALTER TABLE instruments_latency ADD COLUMN polyphony INTEGER DEFAULT 16'
      }
    ];

    try {
      const existingColumns = this.db
        .prepare("SELECT name FROM pragma_table_info('instruments_latency')")
        .all();
      const existingNames = new Set(existingColumns.map((c) => c.name));

      for (const col of requiredColumns) {
        if (!existingNames.has(col.name)) {
          try {
            this.db.exec(col.sql);
            this.logger.info(`Added missing column: ${col.name}`);
          } catch (err) {
            this.logger.warn(`Could not add column ${col.name}: ${err.message}`);
          }
        }
      }
    } catch (error) {
      this.logger.warn(`ensureInstrumentCapabilitiesColumns: ${error.message}`);
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

  // ==================== DELEGATE TO SUB-MODULES ====================

  // MIDI Files
  insertFile(file) {
    return this.midiDB.insertFile(file);
  }
  getFile(fileId) {
    return this.midiDB.getFile(fileId);
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

  // Instruments
  insertInstrument(instrument) {
    return this.instrumentDB.insertInstrument(instrument);
  }
  getInstrument(instrumentId) {
    return this.instrumentDB.getInstrument(instrumentId);
  }
  getInstruments() {
    return this.instrumentDB.getInstruments();
  }
  updateInstrument(instrumentId, updates) {
    return this.instrumentDB.updateInstrument(instrumentId, updates);
  }
  deleteInstrument(instrumentId) {
    return this.instrumentDB.deleteInstrument(instrumentId);
  }

  // Latency Profiles
  saveLatencyProfile(profile) {
    return this.instrumentDB.saveLatencyProfile(profile);
  }
  getLatencyProfile(deviceId) {
    return this.instrumentDB.getLatencyProfile(deviceId);
  }
  getLatencyProfiles() {
    return this.instrumentDB.getLatencyProfiles();
  }
  deleteLatencyProfile(deviceId) {
    return this.instrumentDB.deleteLatencyProfile(deviceId);
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
  getRoutingsByFile(fileId, includeDisabled) {
    return this.instrumentDB.getRoutingsByFile(fileId, includeDisabled);
  }
  getRoutingCountsByFiles(fileIds, connectedDeviceIds) {
    return this.instrumentDB.getRoutingCountsByFiles(fileIds, connectedDeviceIds);
  }
  deleteRoutingsByFile(fileId) {
    return this.instrumentDB.deleteRoutingsByFile(fileId);
  }
  getInstrumentsByDevice(deviceId) {
    return this.instrumentDB.getInstrumentsByDevice(deviceId);
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
        instruments: safeCount('instruments'),
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
