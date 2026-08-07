/**
 * @file src/repositories/FileFoldersRepository.js
 * @description Persists the file-manager folder structure (the client's
 * `folderStructure` map) in the existing `settings` key-value table under a
 * single JSON value (`file_folders`).
 *
 * The dashboard historically kept this map in `localStorage` only, so folder
 * organization did not survive a different browser/device or a cache clear
 * (audit T2.2). Storing the whole structure as one JSON blob mirrors
 * HotspotConfigRepository, keeps writes atomic, and — unlike the per-file
 * `midi_files.folder` column — faithfully carries the richer client model
 * (nested folders and EMPTY folders) that a flat per-file path cannot.
 *
 * The value is opaque to the server (it never interprets the tree); it only
 * stores and returns it so every client shares one organization.
 */

const KEY = 'file_folders';

export default class FileFoldersRepository {
  /**
   * @param {Object} database - Database façade exposing `.db`, OR a raw
   *   better-sqlite3 Database instance.
   */
  constructor(database) {
    this.db = database && database.db ? database.db : database;
  }

  /**
   * @returns {Object} the persisted folder structure, or `{}` when none is
   *   stored yet (or the row is unreadable).
   */
  get() {
    try {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
      if (!row || !row.value) return {};
      const parsed = JSON.parse(row.value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Replace the persisted folder structure wholesale (the client owns the
   * merge — it sends the full tree on every change).
   *
   * @param {Object} structure - the full folderStructure map.
   * @returns {Object} the stored structure.
   */
  set(structure) {
    const safe =
      structure && typeof structure === 'object' && !Array.isArray(structure) ? structure : {};
    const value = JSON.stringify(safe);
    this.db
      .prepare(
        `INSERT INTO settings (key, value, type, description)
       VALUES (?, ?, 'json', 'File-manager folder structure (shared across clients)')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = 'json'`
      )
      .run(KEY, value);
    return safe;
  }
}
