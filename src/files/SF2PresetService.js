/**
 * @file src/files/SF2PresetService.js
 * @description Two-level preset cache for custom SF2 soundfonts.
 *
 * Level 1 — In-memory Map (fast, session-scoped).
 * Level 2 — SQLite `sf2_preset_cache` table (zlib-compressed JSON, persistent).
 *
 * Cache miss → parse SF2 from disk with SF2Converter → compress → store both levels.
 * Invalidation wipes all entries for a given sf2_id from both levels.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { convertPreset } from './SF2Converter.js';

// M-1: maximum decompressed preset JSON (64 MB)
const MAX_INFLATE_BYTES = 64 * 1024 * 1024;

export class SF2PresetService {
  /**
   * @param {Object} opts
   * @param {string}  opts.dataDir   - Root data directory (data/ folder)
   * @param {Object}  opts.database  - DatabaseManager facade
   * @param {Object}  opts.logger
   */
  constructor({ dataDir, database, logger }) {
    this.sf2Dir = path.join(dataDir, 'sf2');
    this.db     = database;
    this.logger = logger;
    this._mem   = new Map(); // key → preset object
    fs.mkdirSync(this.sf2Dir, { recursive: true });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Return a WAF-compatible preset for the given parameters.
   * For melodic: program = GM program 0-127, kit = 0, note = 0.
   * For drum:    program = 0, kit = GM kit program, note = MIDI note.
   *
   * @returns {Object|null} preset (with zones array) or null if not found
   */
  async getPreset(sf2Id, type, program, kit = 0, note = 0) {
    const key = `${sf2Id}:${type}:${program}:${kit}:${note}`;

    // 1. Memory cache — M-2: only non-null values are stored here
    if (this._mem.has(key)) return this._mem.get(key);

    // 2. DB cache
    const compressed = this.db.customSF2DB.getCachedPreset(sf2Id, type, program, kit, note);
    if (compressed) {
      try {
        const inflated = zlib.inflateSync(compressed);
        // M-1: guard against decompression bombs
        if (inflated.length > MAX_INFLATE_BYTES) {
          throw new Error('Cached preset exceeds size limit');
        }
        const preset = JSON.parse(inflated.toString());
        this._mem.set(key, preset);
        return preset;
      } catch (e) {
        this.logger.warn(`SF2PresetService: corrupt/oversized cache entry ${key}, rebuilding`);
      }
    }

    // 3. Parse SF2 from disk
    const row = this.db.customSF2DB.getById(sf2Id);
    if (!row) return null;

    // H-4: validate blob_path stays inside sf2Dir (path traversal guard)
    const sf2Path = path.join(this.sf2Dir, row.blob_path);
    if (!sf2Path.startsWith(this.sf2Dir + path.sep)) {
      this.logger.error(`SF2PresetService: blob_path escape detected for id ${sf2Id}`);
      return null;
    }
    if (!fs.existsSync(sf2Path)) {
      this.logger.error(`SF2PresetService: file not found for id ${sf2Id}`);
      return null;
    }

    let preset = null;
    try {
      const buf = fs.readFileSync(sf2Path);

      if (type === 'drum') {
        // Try GM drum bank (128) first, fall back to bank 0
        preset = convertPreset(buf, 128, kit) || convertPreset(buf, 0, kit);
        if (preset) {
          // Filter to zones covering this specific note
          const filtered = preset.zones.filter(
            z => note >= z.keyRangeLow && note <= z.keyRangeHigh
          );
          preset = filtered.length ? { zones: filtered } : null;
        }
      } else {
        preset = convertPreset(buf, 0, program);
      }
    } catch (err) {
      this.logger.error(`SF2PresetService: conversion failed for ${key}: ${err.message}`);
      return null;
    }

    // M-2: only cache successful results; null is returned without being stored
    // so subsequent requests will re-attempt the disk parse (avoids null-poisoning)
    if (preset) {
      this._mem.set(key, preset);
      try {
        const json = JSON.stringify(preset);
        const buf  = zlib.deflateSync(Buffer.from(json));
        this.db.customSF2DB.setCachedPreset(sf2Id, type, program, kit, note, buf);
      } catch (e) {
        this.logger.warn(`SF2PresetService: could not store cache for ${key}: ${e.message}`);
      }
    }

    return preset;
  }

  /**
   * Save an uploaded SF2 file to disk and register it in the DB.
   * Deduplicates by content hash.
   *
   * @param {string} filename - Original filename
   * @param {Buffer} buf      - File bytes
   * @returns {{ sf2Id: number, label: string, size: number, status: string }}
   */
  async storeUpload(filename, buf) {
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    const existing = this.db.customSF2DB.getByHash(hash);
    if (existing) {
      return { sf2Id: existing.id, label: existing.label, size: existing.size, status: 'duplicate' };
    }

    // L-4: derive a safe label; never fall back to the raw unsanitized filename
    const rawBase = path.basename(filename, path.extname(filename));
    const label = rawBase.replace(/[^\w\s-]/g, ' ').trim() || 'untitled';

    // Write to disk first so the DB row is consistent if write fails
    const blobName = `${Date.now()}_${Math.random().toString(36).slice(2)}.sf2`;
    const blobPath = blobName; // relative to sf2Dir (single flat directory, no subdirs)
    const dest = path.join(this.sf2Dir, blobName);
    fs.writeFileSync(dest, buf);

    let sf2Id;
    try {
      sf2Id = this.db.customSF2DB.insert({
        filename,
        blob_path: blobPath,
        content_hash: hash,
        size: buf.length,
        label,
      });
    } catch (err) {
      // Roll back the file write if DB insert fails
      try { fs.unlinkSync(dest); } catch {}
      throw err;
    }

    return { sf2Id, label, size: buf.length, status: 'created' };
  }

  /**
   * Delete an SF2 file from disk + DB + both caches.
   * @param {number} sf2Id
   */
  deleteSF2(sf2Id) {
    const row = this.db.customSF2DB.getById(sf2Id);
    if (!row) return;

    // H-4: validate blob_path before deletion
    const sf2Path = path.join(this.sf2Dir, row.blob_path);
    if (sf2Path.startsWith(this.sf2Dir + path.sep)) {
      try { fs.unlinkSync(sf2Path); } catch {}
    } else {
      this.logger.error(`SF2PresetService: blob_path escape on delete for id ${sf2Id}`);
    }

    // DB delete cascades to sf2_preset_cache via ON DELETE CASCADE
    this.db.customSF2DB.delete(sf2Id);

    // Wipe memory cache
    this.invalidate(sf2Id);
  }

  /**
   * Evict all in-memory cache entries for a given sf2_id.
   * @param {number} sf2Id
   */
  invalidate(sf2Id) {
    const prefix = `${sf2Id}:`;
    for (const key of this._mem.keys()) {
      if (key.startsWith(prefix)) this._mem.delete(key);
    }
  }

  /**
   * List all registered SF2 soundfonts (for GET /api/sf2).
   * @returns {Object[]}
   */
  listAll() {
    return this.db.customSF2DB.listAll();
  }

  /**
   * Return the total bytes stored across all SF2 files (for quota check).
   * @returns {number}
   */
  getTotalStoredSize() {
    const rows = this.db.customSF2DB.listAll();
    return rows.reduce((sum, r) => sum + (r.size || 0), 0);
  }
}
