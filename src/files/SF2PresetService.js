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
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import AnalysisCache from '../midi/playback/AnalysisCache.js';
import { convertPreset } from './SF2Converter.js';

// M-1: maximum decompressed preset JSON (64 MB)
const MAX_INFLATE_BYTES = 64 * 1024 * 1024;

// Virtual ID for the built-in default soundfont served from `assets/sf2/`.
// Keeps the project fully offline: see assets/sf2/README.md for provenance.
const DEFAULT_SF2_ID = 'default';

// Resolved at import time so the absolute path stays stable across cwd changes.
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_SF2_PATH = path.resolve(path.dirname(__filename), '../../assets/sf2/default.sf2');

// L1 cache budget. Tuned for Pi 3B+ (Node heap capped at 384 MB via
// ecosystem.config.cjs --max-old-space-size). 128 MB leaves comfortable
// headroom for app/parsing buffers without forcing eviction under a typical
// session (a handful of melodic instruments + one drum kit).
const DEFAULT_CACHE_MAX_BYTES   = 128 * 1024 * 1024;
const DEFAULT_CACHE_MAX_ENTRIES = 256;

export class SF2PresetService {
  /**
   * @param {Object} opts
   * @param {string}  opts.dataDir          - Root data directory (data/ folder)
   * @param {Object}  opts.database         - DatabaseManager facade
   * @param {Object}  opts.logger
   * @param {number} [opts.cacheMaxBytes]   - L1 byte budget (default 128 MB)
   * @param {number} [opts.cacheMaxEntries] - L1 entry count cap (default 256)
   * @param {AnalysisCache} [opts.cache]    - Pre-built cache instance, for tests
   */
  constructor({ dataDir, database, logger, cache, cacheMaxBytes, cacheMaxEntries }) {
    this.sf2Dir = path.join(dataDir, 'sf2');
    this.db     = database;
    this.logger = logger;
    // L1 cache: bounded LRU (bytes + entry count). Default SF2 has no L2
    // safety net, so eviction is the only thing preventing heap blowup on
    // long sessions — see plan #5 in the audit follow-up.
    this._mem = cache || new AnalysisCache({
      maxBytes: cacheMaxBytes   || DEFAULT_CACHE_MAX_BYTES,
      maxSize:  cacheMaxEntries || DEFAULT_CACHE_MAX_ENTRIES,
      logger,
    });
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

    // 1. Memory cache (bounded LRU; only non-null values are stored).
    const hit = this._mem.getRaw(key);
    if (hit) return hit;

    // 2. DB cache (skipped for the built-in default — see resolveSF2Path)
    const isDefault = sf2Id === DEFAULT_SF2_ID;
    if (!isDefault) {
      const compressed = this.db.customSF2DB.getCachedPreset(sf2Id, type, program, kit, note);
      if (compressed) {
        try {
          const inflated = zlib.inflateSync(compressed);
          // M-1: guard against decompression bombs
          if (inflated.length > MAX_INFLATE_BYTES) {
            throw new Error('Cached preset exceeds size limit');
          }
          const preset = JSON.parse(inflated.toString());
          this._mem.setRaw(key, preset, this._estimatePresetBytes(preset));
          return preset;
        } catch (e) {
          this.logger.warn(`SF2PresetService: corrupt/oversized cache entry ${key}, rebuilding`);
        }
      }
    }

    // 3. Resolve SF2 file path (built-in default or DB-registered upload)
    const sf2Path = this._resolveSF2Path(sf2Id);
    if (!sf2Path) return null;
    if (!fs.existsSync(sf2Path)) {
      this.logger.error(`SF2PresetService: file not found for id ${sf2Id} at ${sf2Path}`);
      return null;
    }

    let preset = null;
    try {
      const buf = fs.readFileSync(sf2Path);

      if (type === 'drum') {
        // Try GM drum bank (128) first, fall back to bank 0.
        // If the requested kit is absent, fall back to Standard Kit (0).
        preset = convertPreset(buf, 128, kit) || convertPreset(buf, 0, kit);
        if (!preset && kit !== 0) {
          preset = convertPreset(buf, 128, 0) || convertPreset(buf, 0, 0);
        }
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
    // so subsequent requests will re-attempt the disk parse (avoids null-poisoning).
    // The built-in default skips the DB cache (no DB row to cascade-delete on).
    if (preset) {
      this._mem.setRaw(key, preset, this._estimatePresetBytes(preset));
      if (!isDefault) {
        try {
          const json = JSON.stringify(preset);
          const buf  = zlib.deflateSync(Buffer.from(json));
          this.db.customSF2DB.setCachedPreset(sf2Id, type, program, kit, note, buf);
        } catch (e) {
          this.logger.warn(`SF2PresetService: could not store cache for ${key}: ${e.message}`);
        }
      }
    }

    return preset;
  }

  /**
   * Resolve a public SF2 id to an absolute on-disk path. Accepts the special
   * 'default' id (built-in bundled SF2) or a numeric DB id.
   * Returns null when the id is unknown or the path would escape sf2Dir.
   * @param {string|number} sf2Id
   * @returns {string|null}
   * @private
   */
  _resolveSF2Path(sf2Id) {
    if (sf2Id === DEFAULT_SF2_ID) {
      return DEFAULT_SF2_PATH;
    }
    const row = this.db.customSF2DB.getById(sf2Id);
    if (!row) return null;
    const p = path.join(this.sf2Dir, row.blob_path);
    // H-4: path traversal guard
    if (!p.startsWith(this.sf2Dir + path.sep)) {
      this.logger.error(`SF2PresetService: blob_path escape detected for id ${sf2Id}`);
      return null;
    }
    return p;
  }

  /**
   * Is the built-in default SF2 file present on disk?
   * Used by the boot banner / health endpoint to warn when the postinstall
   * script hasn't run yet.
   * @returns {boolean}
   */
  hasDefaultSF2() {
    try { return fs.existsSync(DEFAULT_SF2_PATH); } catch { return false; }
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
   * @param {number|string} sf2Id
   */
  invalidate(sf2Id) {
    this._mem.invalidatePrefix(`${sf2Id}:`);
  }

  /**
   * Cheap heuristic for the byte footprint of a converted preset. Avoids
   * the `JSON.stringify` cost of AnalysisCache's default estimator, which
   * would dominate cache writes on 40 MB SF2 presets. Per-sample weight
   * matches V8's boxed-double representation for plain Array<number>; the
   * `+200` per zone covers metadata (key/vel range, tuning, loop points).
   *
   * @param {{ zones: Array }} preset
   * @returns {number}
   * @private
   */
  _estimatePresetBytes(preset) {
    if (!preset || !Array.isArray(preset.zones)) return 1024;
    let total = 0;
    for (const z of preset.zones) {
      total += (z.sample?.length || 0) * 8;
    }
    return total + preset.zones.length * 200;
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
