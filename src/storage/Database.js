// src/storage/Database.js
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import MidiDatabase from './MidiDatabase.js';
import InstrumentDatabase from './InstrumentDatabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class DatabaseManager {
  constructor(app) {
    this.app = app;
    this.dbPath = app.config.database.path || './data/midimind.db';
    this.db = null;
    this.midiDB = null;
    this.instrumentDB = null;

    this.ensureDataDir();
    this.connect();
    this.runMigrations();

    // Ensure instrument capabilities columns exist (safety net)
    this.ensureInstrumentCapabilitiesColumns();

    // Initialize sub-modules
    this.midiDB = new MidiDatabase(this.db, this.app.logger);
    this.instrumentDB = new InstrumentDatabase(this.db, this.app.logger);

    this.app.logger.info('Database initialized');
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
      this.app.logger.info(`Connected to database: ${this.dbPath}`);
    } catch (error) {
      this.app.logger.error(`Failed to connect to database: ${error.message}`);
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
      this.app.logger.info(`Current database version: ${currentVersion}`);

      // Load and run migrations
      const migrationsDir = path.join(__dirname, '../../migrations');
      const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

      for (const file of migrationFiles) {
        const version = parseInt(file.split('_')[0]);
        
        if (version > currentVersion) {
          this.runMigration(version, file, migrationsDir);
        }
      }

      this.app.logger.info('Migrations completed');
    } catch (error) {
      this.app.logger.error(`Migration failed: ${error.message}`);
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
      this.app.logger.info(`Running migration ${version}: ${filename}`);

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

      this.app.logger.info(`Migration ${version} completed`);
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.app.logger.error(`Migration ${version} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ensure required columns exist in instruments_latency table
   * This is a safety net for partial migration failures
   */
  ensureInstrumentCapabilitiesColumns() {
    const requiredColumns = [
      { name: 'note_range_min', sql: 'ALTER TABLE instruments_latency ADD COLUMN note_range_min INTEGER' },
      { name: 'note_range_max', sql: 'ALTER TABLE instruments_latency ADD COLUMN note_range_max INTEGER' },
      { name: 'supported_ccs', sql: 'ALTER TABLE instruments_latency ADD COLUMN supported_ccs TEXT' },
      { name: 'note_selection_mode', sql: "ALTER TABLE instruments_latency ADD COLUMN note_selection_mode TEXT DEFAULT 'range'" },
      { name: 'selected_notes', sql: 'ALTER TABLE instruments_latency ADD COLUMN selected_notes TEXT' },
      { name: 'capabilities_source', sql: "ALTER TABLE instruments_latency ADD COLUMN capabilities_source TEXT DEFAULT 'manual'" },
      { name: 'capabilities_updated_at', sql: 'ALTER TABLE instruments_latency ADD COLUMN capabilities_updated_at TEXT' },
      { name: 'gm_program', sql: 'ALTER TABLE instruments_latency ADD COLUMN gm_program INTEGER' },
      { name: 'polyphony', sql: 'ALTER TABLE instruments_latency ADD COLUMN polyphony INTEGER DEFAULT 16' }
    ];

    try {
      const existingColumns = this.db.prepare("SELECT name FROM pragma_table_info('instruments_latency')").all();
      const existingNames = new Set(existingColumns.map(c => c.name));

      for (const col of requiredColumns) {
        if (!existingNames.has(col.name)) {
          try {
            this.db.exec(col.sql);
            this.app.logger.info(`Added missing column: ${col.name}`);
          } catch (err) {
            this.app.logger.warn(`Could not add column ${col.name}: ${err.message}`);
          }
        }
      }
    } catch (error) {
      this.app.logger.warn(`ensureInstrumentCapabilitiesColumns: ${error.message}`);
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
      this.app.logger.error(`Failed to insert route: ${error.message}`);
      throw error;
    }
  }

  getRoute(routeId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM routes WHERE id = ?');
      return stmt.get(routeId);
    } catch (error) {
      this.app.logger.error(`Failed to get route: ${error.message}`);
      throw error;
    }
  }

  getRoutes() {
    try {
      const stmt = this.db.prepare('SELECT * FROM routes');
      return stmt.all();
    } catch (error) {
      this.app.logger.error(`Failed to get routes: ${error.message}`);
      throw error;
    }
  }

  updateRoute(routeId, updates) {
    try {
      const fields = [];
      const values = [];

      if (updates.source_device !== undefined) {
        fields.push('source_device = ?');
        values.push(updates.source_device);
      }
      if (updates.destination_device !== undefined) {
        fields.push('destination_device = ?');
        values.push(updates.destination_device);
      }
      if (updates.channel_mapping !== undefined) {
        fields.push('channel_mapping = ?');
        values.push(updates.channel_mapping);
      }
      if (updates.filter !== undefined) {
        fields.push('filter = ?');
        values.push(updates.filter);
      }
      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled ? 1 : 0);
      }

      if (fields.length === 0) {
        return;
      }

      values.push(routeId);

      const stmt = this.db.prepare(`
        UPDATE routes SET ${fields.join(', ')} WHERE id = ?
      `);

      stmt.run(...values);
    } catch (error) {
      this.app.logger.error(`Failed to update route: ${error.message}`);
      throw error;
    }
  }

  deleteRoute(routeId) {
    try {
      const stmt = this.db.prepare('DELETE FROM routes WHERE id = ?');
      stmt.run(routeId);
    } catch (error) {
      this.app.logger.error(`Failed to delete route: ${error.message}`);
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
      const result = stmt.run(
        session.name,
        session.description || null,
        session.data,
        now,
        now
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.app.logger.error(`Failed to insert session: ${error.message}`);
      throw error;
    }
  }

  getSession(sessionId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
      return stmt.get(sessionId);
    } catch (error) {
      this.app.logger.error(`Failed to get session: ${error.message}`);
      throw error;
    }
  }

  getSessions() {
    try {
      const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
      return stmt.all();
    } catch (error) {
      this.app.logger.error(`Failed to get sessions: ${error.message}`);
      throw error;
    }
  }

  updateSession(sessionId, updates) {
    try {
      const fields = [];
      const values = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.description !== undefined) {
        fields.push('description = ?');
        values.push(updates.description);
      }
      if (updates.data !== undefined) {
        fields.push('data = ?');
        values.push(updates.data);
      }

      fields.push('updated_at = ?');
      values.push(new Date().toISOString());

      values.push(sessionId);

      const stmt = this.db.prepare(`
        UPDATE sessions SET ${fields.join(', ')} WHERE id = ?
      `);

      stmt.run(...values);
    } catch (error) {
      this.app.logger.error(`Failed to update session: ${error.message}`);
      throw error;
    }
  }

  deleteSession(sessionId) {
    try {
      const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      stmt.run(sessionId);
    } catch (error) {
      this.app.logger.error(`Failed to delete session: ${error.message}`);
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

      const now = new Date().toISOString();
      const result = stmt.run(
        playlist.name,
        playlist.description || null,
        now,
        now
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.app.logger.error(`Failed to insert playlist: ${error.message}`);
      throw error;
    }
  }

  getPlaylist(playlistId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM playlists WHERE id = ?');
      return stmt.get(playlistId);
    } catch (error) {
      this.app.logger.error(`Failed to get playlist: ${error.message}`);
      throw error;
    }
  }

  getPlaylists() {
    try {
      const stmt = this.db.prepare('SELECT * FROM playlists ORDER BY name');
      return stmt.all();
    } catch (error) {
      this.app.logger.error(`Failed to get playlists: ${error.message}`);
      throw error;
    }
  }

  deletePlaylist(playlistId) {
    try {
      const stmt = this.db.prepare('DELETE FROM playlists WHERE id = ?');
      stmt.run(playlistId);
    } catch (error) {
      this.app.logger.error(`Failed to delete playlist: ${error.message}`);
      throw error;
    }
  }

  // ==================== DELEGATE TO SUB-MODULES ====================

  // MIDI Files
  insertFile(file) { return this.midiDB.insertFile(file); }
  getFile(fileId) { return this.midiDB.getFile(fileId); }
  getFiles(folder) { return this.midiDB.getFiles(folder); }
  getAllFiles() { return this.midiDB.getAllFiles(); }
  updateFile(fileId, updates) { return this.midiDB.updateFile(fileId, updates); }
  deleteFile(fileId) { return this.midiDB.deleteFile(fileId); }
  getFolders() { return this.midiDB.getFolders(); }
  searchFiles(query) { return this.midiDB.searchFiles(query); }
  filterFiles(filters) { return this.midiDB.filterFiles(filters); }

  // MIDI File Channels
  insertFileChannels(fileId, channels) { return this.midiDB.insertFileChannels(fileId, channels); }
  getFileChannels(fileId) { return this.midiDB.getFileChannels(fileId); }
  deleteFileChannels(fileId) { return this.midiDB.deleteFileChannels(fileId); }
  getDistinctInstruments() { return this.midiDB.getDistinctInstruments(); }
  getDistinctCategories() { return this.midiDB.getDistinctCategories(); }
  findFilesByInstrument(instruments, mode) { return this.midiDB.findFilesByInstrument(instruments, mode); }
  findFilesByCategory(categories, mode) { return this.midiDB.findFilesByCategory(categories, mode); }

  // Instruments
  insertInstrument(instrument) { return this.instrumentDB.insertInstrument(instrument); }
  getInstrument(instrumentId) { return this.instrumentDB.getInstrument(instrumentId); }
  getInstruments() { return this.instrumentDB.getInstruments(); }
  updateInstrument(instrumentId, updates) { return this.instrumentDB.updateInstrument(instrumentId, updates); }
  deleteInstrument(instrumentId) { return this.instrumentDB.deleteInstrument(instrumentId); }

  // Latency Profiles
  saveLatencyProfile(profile) { return this.instrumentDB.saveLatencyProfile(profile); }
  getLatencyProfile(deviceId) { return this.instrumentDB.getLatencyProfile(deviceId); }
  getLatencyProfiles() { return this.instrumentDB.getLatencyProfiles(); }
  deleteLatencyProfile(deviceId) { return this.instrumentDB.deleteLatencyProfile(deviceId); }

  // Presets
  insertPreset(preset) { return this.instrumentDB.insertPreset(preset); }
  getPreset(presetId) { return this.instrumentDB.getPreset(presetId); }
  getPresets(type) { return this.instrumentDB.getPresets(type); }
  updatePreset(presetId, updates) { return this.instrumentDB.updatePreset(presetId, updates); }
  deletePreset(presetId) { return this.instrumentDB.deletePreset(presetId); }

  // Instrument Settings
  updateInstrumentSettings(deviceId, settings) { return this.instrumentDB.updateInstrumentSettings(deviceId, settings); }
  getInstrumentSettings(deviceId) { return this.instrumentDB.getInstrumentSettings(deviceId); }
  saveSysExIdentity(deviceId, identity) { return this.instrumentDB.saveSysExIdentity(deviceId, identity); }
  findInstrumentByMac(macAddress) { return this.instrumentDB.findInstrumentByMac(macAddress); }
  findInstrumentByUsbSerial(usbSerialNumber) { return this.instrumentDB.findInstrumentByUsbSerial(usbSerialNumber); }

  // Instrument Capabilities
  updateInstrumentCapabilities(deviceId, capabilities) { return this.instrumentDB.updateInstrumentCapabilities(deviceId, capabilities); }
  getInstrumentCapabilities(deviceId) { return this.instrumentDB.getInstrumentCapabilities(deviceId); }
  getAllInstrumentCapabilities() { return this.instrumentDB.getAllInstrumentCapabilities(); }
  getInstrumentsWithCapabilities() { return this.instrumentDB.getInstrumentsWithCapabilities(); }

  // ==================== UTILITIES ====================

  close() {
    if (this.db) {
      this.db.close();
      this.app.logger.info('Database closed');
    }
  }

  backup(backupPath) {
    try {
      this.db.backup(backupPath);
      this.app.logger.info(`Database backed up to: ${backupPath}`);
    } catch (error) {
      this.app.logger.error(`Backup failed: ${error.message}`);
      throw error;
    }
  }

  vacuum() {
    try {
      this.db.exec('VACUUM');
      this.app.logger.info('Database vacuumed');
    } catch (error) {
      this.app.logger.error(`Vacuum failed: ${error.message}`);
      throw error;
    }
  }

  getStats() {
    try {
      const stats = {
        size: fs.statSync(this.dbPath).size,
        files: this.db.prepare('SELECT COUNT(*) as count FROM midi_files').get().count,
        routes: this.db.prepare('SELECT COUNT(*) as count FROM routes').get().count,
        instruments: this.db.prepare('SELECT COUNT(*) as count FROM instruments').get().count,
        sessions: this.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
        playlists: this.db.prepare('SELECT COUNT(*) as count FROM playlists').get().count
      };
      return stats;
    } catch (error) {
      this.app.logger.error(`Failed to get stats: ${error.message}`);
      throw error;
    }
  }
}

export default DatabaseManager;