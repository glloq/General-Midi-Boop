/**
 * @file src/persistence/tables/CustomSF2DB.js
 * @description CRUD for the `custom_sf2` table and `sf2_preset_cache` table.
 * Sub-module of {@link Database}.
 */
import { buildDynamicUpdate } from '../dbHelpers.js';

class CustomSF2DB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  // ── Custom SF2 records ────────────────────────────────────────────────────

  insert({ filename, blob_path, content_hash, size, label, reverb_mix = 0.12 }) {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO custom_sf2 (filename, blob_path, content_hash, size, label, reverb_mix)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const result = stmt.run(filename, blob_path, content_hash, size, label, reverb_mix);
      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`CustomSF2DB.insert failed: ${error.message}`);
      throw error;
    }
  }

  getById(id) {
    try {
      return (
        this.db
          .prepare(
            `SELECT id, filename, blob_path, content_hash, size, label, reverb_mix, uploaded_at
         FROM custom_sf2 WHERE id = ?`
          )
          .get(id) || null
      );
    } catch (error) {
      this.logger.error(`CustomSF2DB.getById failed: ${error.message}`);
      throw error;
    }
  }

  getByHash(hash) {
    try {
      return (
        this.db
          .prepare(
            `SELECT id, filename, blob_path, content_hash, size, label, reverb_mix, uploaded_at
         FROM custom_sf2 WHERE content_hash = ?`
          )
          .get(hash) || null
      );
    } catch (error) {
      this.logger.error(`CustomSF2DB.getByHash failed: ${error.message}`);
      throw error;
    }
  }

  listAll() {
    try {
      return this.db
        .prepare(
          `SELECT id, filename, blob_path, content_hash, size, label, reverb_mix, uploaded_at
         FROM custom_sf2 ORDER BY uploaded_at ASC`
        )
        .all();
    } catch (error) {
      this.logger.error(`CustomSF2DB.listAll failed: ${error.message}`);
      throw error;
    }
  }

  update(id, { label, reverb_mix }) {
    try {
      const result = buildDynamicUpdate('custom_sf2', { label, reverb_mix }, [
        'label',
        'reverb_mix'
      ]);
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (error) {
      this.logger.error(`CustomSF2DB.update failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Used by SF2PresetService to stamp the default-SF2 sentinel row with the
   * file's mtimeMs, so the L2 preset cache can be invalidated on the next
   * boot if the soundfont was replaced on disk. `size` is the only INTEGER
   * column we can repurpose without a schema change — uploads are size-
   * limited well below 2^53 ms (year 287000+), so no collision risk.
   */
  setSize(id, sizeValue) {
    try {
      this.db.prepare('UPDATE custom_sf2 SET size = ? WHERE id = ?').run(sizeValue, id);
    } catch (error) {
      this.logger.error(`CustomSF2DB.setSize failed: ${error.message}`);
      throw error;
    }
  }

  delete(id) {
    try {
      this.db.prepare('DELETE FROM custom_sf2 WHERE id = ?').run(id);
    } catch (error) {
      this.logger.error(`CustomSF2DB.delete failed: ${error.message}`);
      throw error;
    }
  }

  // ── Preset cache ──────────────────────────────────────────────────────────

  getCachedPreset(sf2Id, type, program, kit, note) {
    try {
      const row = this.db
        .prepare(
          `SELECT preset_json FROM sf2_preset_cache
         WHERE sf2_id = ? AND preset_type = ? AND program = ? AND kit = ? AND note = ?`
        )
        .get(sf2Id, type, program, kit, note);
      return row ? row.preset_json : null;
    } catch (error) {
      this.logger.error(`CustomSF2DB.getCachedPreset failed: ${error.message}`);
      throw error;
    }
  }

  setCachedPreset(sf2Id, type, program, kit, note, compressedBuf) {
    try {
      this.db
        .prepare(
          `INSERT INTO sf2_preset_cache (sf2_id, preset_type, program, kit, note, preset_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sf2_id, preset_type, program, kit, note) DO UPDATE SET
           preset_json = excluded.preset_json,
           created_at  = datetime('now')`
        )
        .run(sf2Id, type, program, kit, note, compressedBuf);
    } catch (error) {
      this.logger.error(`CustomSF2DB.setCachedPreset failed: ${error.message}`);
      throw error;
    }
  }

  deleteCacheForSF2(sf2Id) {
    try {
      this.db.prepare('DELETE FROM sf2_preset_cache WHERE sf2_id = ?').run(sf2Id);
    } catch (error) {
      this.logger.error(`CustomSF2DB.deleteCacheForSF2 failed: ${error.message}`);
      throw error;
    }
  }
}

export default CustomSF2DB;
