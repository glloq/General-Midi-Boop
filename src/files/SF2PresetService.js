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
import AnalysisCache from '../midi/playback/AnalysisCache.js';
import { convertPresetFromSF2 } from './SF2Converter.js';
import { SF2InstanceCache } from './SF2InstanceCache.js';
import { encodePreset, decodePreset, looksLikeBinaryPreset } from './SF2PresetCodec.js';

// Maximum L2-cached payload size (64 MB). Mirrors the heap envelope from
// the previous gzipped-JSON path so a malformed/oversized cache row can't
// blow the Node heap on read.
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

// Virtual ID for the built-in default soundfont served from `assets/sf2/`.
// Keeps the project fully offline: see assets/sf2/README.md for provenance.
const DEFAULT_SF2_ID = 'default';

// Sentinel `custom_sf2.id` for the default soundfont. Inserted by
// migration 020 so that L2 preset cache rows can satisfy the FK
// constraint. The HTTP routes reject `id <= 0` for delete/patch, so
// this row is never mutated through the API.
const DEFAULT_SF2_DB_ID = 0;

// Resolved at import time so the absolute path stays stable across cwd changes.
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_SF2_PATH = path.resolve(path.dirname(__filename), '../../assets/sf2/default.sf2');

// L1 cache budget. Tuned for Pi 3B+ (Node heap capped at 384 MB via
// ecosystem.config.cjs --max-old-space-size). 128 MB leaves comfortable
// headroom for app/parsing buffers without forcing eviction under a typical
// session (a handful of melodic instruments + one drum kit).
const DEFAULT_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_CACHE_MAX_ENTRIES = 256;

export class SF2PresetService {
  /**
   * @param {Object} opts
   * @param {string}  opts.dataDir          - Root data directory (data/ folder)
   * @param {Object}  opts.database         - DatabaseManager facade
   * @param {Object}  opts.logger
   * @param {number} [opts.cacheMaxBytes]   - L1 byte budget (default 128 MB)
   * @param {number} [opts.cacheMaxEntries] - L1 entry count cap (default 256)
   * @param {AnalysisCache}     [opts.cache]         - Pre-built cache instance, for tests
   * @param {SF2InstanceCache}  [opts.instanceCache] - Pre-built SF2 instance cache, for tests
   */
  constructor({ dataDir, database, logger, cache, instanceCache, cacheMaxBytes, cacheMaxEntries }) {
    this.sf2Dir = path.join(dataDir, 'sf2');
    this.db = database;
    this.logger = logger;
    // L1 cache: bounded LRU (bytes + entry count). Default SF2 has no L2
    // safety net, so eviction is the only thing preventing heap blowup on
    // long sessions — see plan #5 in the audit follow-up.
    this._mem =
      cache ||
      new AnalysisCache({
        maxBytes: cacheMaxBytes || DEFAULT_CACHE_MAX_BYTES,
        maxSize: cacheMaxEntries || DEFAULT_CACHE_MAX_ENTRIES,
        logger
      });
    // SoundFont2 instance LRU — amortises the ~450 ms RIFF parse across
    // multiple program lookups from the same SF2 file. Keyed by abs path
    // + mtime so a file replacement invalidates automatically.
    this._sf2Instances = instanceCache || new SF2InstanceCache();
    // Tracks SF2 ids for which we've already logged the drum-kit inventory.
    // Logging once per id surfaces missing kits (so the user knows why some
    // drum presets fall back to Standard) without spamming on every preset
    // fetch.
    this._kitInventoryLogged = new Set();
    fs.mkdirSync(this.sf2Dir, { recursive: true });
    // Drop default-SF2 L2 cache rows if the underlying file changed since
    // they were stored. Wrapped — older DB facades (test mocks) may not
    // implement the bookkeeping methods, in which case we skip silently.
    this._invalidateDefaultIfStale();
  }

  /**
   * Compare default.sf2's mtimeMs against the value stamped on the sentinel
   * row (custom_sf2.id=0, size column). Wipe the L2 preset cache for that
   * sf2_id if they differ — keeps L2 in sync with file replacements done
   * via `npm run install-default-sf2 --force`.
   * @private
   */
  _invalidateDefaultIfStale() {
    try {
      if (!fs.existsSync(DEFAULT_SF2_PATH)) return;
      const stat = fs.statSync(DEFAULT_SF2_PATH);
      const mtimeInt = Math.floor(stat.mtimeMs);
      const row = this.db.customSF2DB.getById?.(DEFAULT_SF2_DB_ID);
      if (!row) return; // migration 020 hasn't run yet — skip
      if (row.size === mtimeInt) return;
      if (typeof this.db.customSF2DB.deleteCacheForSF2 === 'function') {
        this.db.customSF2DB.deleteCacheForSF2(DEFAULT_SF2_DB_ID);
      }
      if (typeof this.db.customSF2DB.setSize === 'function') {
        this.db.customSF2DB.setSize(DEFAULT_SF2_DB_ID, mtimeInt);
      }
      this.logger.info?.(
        `SF2PresetService: default SF2 L2 cache invalidated (mtime ${row.size} → ${mtimeInt})`
      );
    } catch (e) {
      this.logger.warn?.(`SF2PresetService: default-staleness check failed: ${e.message}`);
    }
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

    // 2. DB cache. The default SF2 maps onto the sentinel `custom_sf2.id=0`
    //    inserted by migration 020 so it can share the same FK-bound table.
    //    Cache rows are stored in the GMBP binary format (see SF2PresetCodec).
    //    Legacy gzipped-JSON rows are silently ignored and rebuilt.
    const isDefault = sf2Id === DEFAULT_SF2_ID;
    const dbSf2Id = isDefault ? DEFAULT_SF2_DB_ID : sf2Id;
    const cached = this.db.customSF2DB.getCachedPreset(dbSf2Id, type, program, kit, note);
    if (cached && cached.length <= MAX_CACHE_BYTES && looksLikeBinaryPreset(cached)) {
      try {
        const preset = decodePreset(cached);
        this._mem.setRaw(key, preset, this._estimatePresetBytes(preset));
        return preset;
      } catch (e) {
        this.logger.warn(`SF2PresetService: corrupt cache entry ${key}, rebuilding`);
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
      // Re-uses the parsed SoundFont2 instance across program lookups from
      // the same SF2 file — saves ~475 ms (disk read + RIFF parse) per hit.
      const sf2 = this._sf2Instances.getForPath(sf2Path);

      if (type === 'drum') {
        this._logKitInventoryOnce(sf2Id, sf2);
        // Cascade (128, kit) → (128, 0). No bank-0 fallback: a melodic
        // preset played at a drum note's pitch produces a bell timbre.
        // Silence is unambiguously diagnosable, bells are not.
        preset = convertPresetFromSF2(sf2, 128, kit);
        if (!preset && kit !== 0) {
          preset = convertPresetFromSF2(sf2, 128, 0);
        }
        if (preset) {
          // Keep only zones covering this note with the narrowest key
          // range — GeneralUser GS Standard Kit ships a wide catch-all
          // zone alongside the per-note zones, and without this filter
          // the synth plays the catch-all sample on top of every drum
          // hit ("cloche" bleed-through). Same-width zones are kept
          // (velocity round-robin).
          const covering = preset.zones.filter(
            (z) => note >= z.keyRangeLow && note <= z.keyRangeHigh
          );
          if (covering.length === 0) {
            preset = null;
          } else {
            let minWidth = Infinity;
            for (const z of covering) {
              const w = z.keyRangeHigh - z.keyRangeLow;
              if (w < minWidth) minWidth = w;
            }
            preset = {
              zones: covering.filter((z) => z.keyRangeHigh - z.keyRangeLow === minWidth)
            };
          }
        }
        if (!preset) {
          this.logger.warn?.(
            `SF2PresetService: no drum preset for sf2=${sf2Id} kit=${kit} note=${note} — SF2 likely lacks GM drum bank`
          );
        }
      } else {
        preset = convertPresetFromSF2(sf2, 0, program);
      }
    } catch (err) {
      this.logger.error(`SF2PresetService: conversion failed for ${key}: ${err.message}`);
      return null;
    }

    // M-2: only cache successful results; null is returned without being stored
    // so subsequent requests will re-attempt the disk parse (avoids null-poisoning).
    if (preset) {
      this._mem.setRaw(key, preset, this._estimatePresetBytes(preset));
      try {
        const buf = encodePreset(preset);
        this.db.customSF2DB.setCachedPreset(dbSf2Id, type, program, kit, note, buf);
      } catch (e) {
        this.logger.warn(`SF2PresetService: could not store cache for ${key}: ${e.message}`);
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
    try {
      return fs.existsSync(DEFAULT_SF2_PATH);
    } catch {
      return false;
    }
  }

  /**
   * Enumerate the GM drum kit programs actually present in the given SF2.
   * Looks in bank 128 (the GM drum bank); if none are present, falls back
   * to bank 0 since a handful of non-conformant SF2 files stash kits there.
   * @param {string|number} sf2Id
   * @returns {{ bankNum: number, kits: number[] }}  — kits sorted ascending
   */
  inspectDrumKits(sf2Id) {
    const sf2Path = this._resolveSF2Path(sf2Id);
    if (!sf2Path || !fs.existsSync(sf2Path)) return { bankNum: 128, kits: [] };
    try {
      const sf2 = this._sf2Instances.getForPath(sf2Path);
      const bank128 = sf2.banks?.[128];
      if (bank128 && bank128.presets) {
        const kits = Object.keys(bank128.presets)
          .map(Number)
          .sort((a, b) => a - b);
        if (kits.length > 0) return { bankNum: 128, kits };
      }
      const bank0 = sf2.banks?.[0];
      if (bank0 && bank0.presets) {
        const kits = Object.keys(bank0.presets)
          .map(Number)
          .sort((a, b) => a - b);
        return { bankNum: 0, kits };
      }
      return { bankNum: 128, kits: [] };
    } catch (err) {
      this.logger.warn?.(`SF2PresetService: inspectDrumKits failed for ${sf2Id}: ${err.message}`);
      return { bankNum: 128, kits: [] };
    }
  }

  /**
   * Enumerate the melodic GM programs (bank 0) present in the SF2.
   * @param {string|number} sf2Id
   * @returns {number[]} — programs sorted ascending (empty if SF2 missing)
   */
  inspectMelodicPrograms(sf2Id) {
    const sf2Path = this._resolveSF2Path(sf2Id);
    if (!sf2Path || !fs.existsSync(sf2Path)) return [];
    try {
      const sf2 = this._sf2Instances.getForPath(sf2Path);
      const bank0 = sf2.banks?.[0];
      if (!bank0 || !bank0.presets) return [];
      return Object.keys(bank0.presets)
        .map(Number)
        .sort((a, b) => a - b);
    } catch (err) {
      this.logger.warn?.(
        `SF2PresetService: inspectMelodicPrograms failed for ${sf2Id}: ${err.message}`
      );
      return [];
    }
  }

  /**
   * Log the drum-kit inventory of an SF2 the first time we look up a drum
   * preset against it. Surfaces missing kits at info level so users can tell
   * why their custom SF2 falls back to Standard Kit. Idempotent per sf2Id.
   * @param {string|number} sf2Id
   * @param {Object}        sf2
   * @private
   */
  _logKitInventoryOnce(sf2Id, sf2) {
    if (this._kitInventoryLogged.has(sf2Id)) return;
    this._kitInventoryLogged.add(sf2Id);
    try {
      const bank128 = sf2.banks?.[128];
      const kits =
        bank128 && bank128.presets
          ? Object.keys(bank128.presets)
              .map(Number)
              .sort((a, b) => a - b)
          : [];
      if (kits.length === 0) {
        this.logger.warn?.(
          `SF2PresetService: SF2 '${sf2Id}' has no drum kits in bank 128 — drum requests will fall back to bank 0 (may sound melodic)`
        );
      } else {
        this.logger.info?.(
          `SF2PresetService: SF2 '${sf2Id}' drum kits in bank 128: [${kits.join(', ')}]`
        );
      }
    } catch (e) {
      this._kitInventoryLogged.delete(sf2Id);
    }
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
      return {
        sf2Id: existing.id,
        label: existing.label,
        size: existing.size,
        status: 'duplicate'
      };
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
        label
      });
    } catch (err) {
      // Roll back the file write if DB insert fails
      try {
        fs.unlinkSync(dest);
      } catch {}
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
      try {
        fs.unlinkSync(sf2Path);
      } catch {}
      this._sf2Instances.invalidate(sf2Path);
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
    this._kitInventoryLogged.delete(sf2Id);
  }

  /**
   * Cheap heuristic for the byte footprint of a converted preset. Avoids
   * the `JSON.stringify` cost of AnalysisCache's default estimator, which
   * would dominate cache writes on multi-MB SF2 presets. 4 bytes per
   * sample matches Float32Array storage; the `+200` per zone covers
   * metadata (key/vel range, tuning, loop points).
   *
   * @param {{ zones: Array }} preset
   * @returns {number}
   * @private
   */
  _estimatePresetBytes(preset) {
    if (!preset || !Array.isArray(preset.zones)) return 1024;
    let total = 0;
    for (const z of preset.zones) {
      total += (z.sample?.length || 0) * 4;
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
    // Exclude the id=0 built-in-default sentinel: its `size` column is
    // repurposed to hold the default.sf2 mtime (~1.75e12), so summing it made
    // `totalStored` exceed MAX_SF2_TOTAL_SIZE (1 GB) forever — every custom
    // upload was rejected with 413 in the default deployment (audit B2 M1).
    const rows = this.db.customSF2DB.listAll();
    return rows.reduce((sum, r) => (r.id > 0 ? sum + (r.size || 0) : sum), 0);
  }
}
