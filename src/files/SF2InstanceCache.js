/**
 * @file src/files/SF2InstanceCache.js
 * @description Tiny LRU of parsed `SoundFont2` instances keyed by file path
 * and mtime. Each cache hit skips ~475 ms of disk-read + RIFF parsing for a
 * 30 MB soundfont — that's the dominant cost on a Pi 3B+ cold load now that
 * the serialisation step is binary.
 *
 * Memory envelope: a SoundFont2 instance holds a reference to its source
 * Uint8Array (the full file bytes), so the bookkeeping size is roughly the
 * SF2 file size + a small parse tree. The cache is capped at 2 entries — enough
 * to hold a melodic + drum soundfont without re-parse thrash, but low enough
 * that even two near-max (160 MB) files stay within a 1 GB Pi envelope. It was
 * previously 3, which combined with the old 500 MB file cap risked OOM.
 *
 * Invalidation: the `mtimeMs` component of the key makes a stale instance
 * disappear automatically when the underlying SF2 file is re-installed or
 * replaced, without needing an explicit invalidate() call from the boot
 * sequence.
 */

import fs from 'fs';
import { parseSoundFont } from './SF2Converter.js';

const DEFAULT_CAPACITY = 2;

export class SF2InstanceCache {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.capacity=2]
   */
  constructor({ capacity = DEFAULT_CAPACITY } = {}) {
    this.capacity = capacity;
    /** @type {Map<string, { sf2: any, mtimeMs: number }>} */
    this._map = new Map();
    this._parseCount = 0;
  }

  /**
   * Return a parsed SoundFont2 for the given file path, parsing it (and
   * caching the result) on miss. `mtimeMs` is part of the cache key so a
   * file replacement invalidates the entry transparently.
   *
   * @param {string} absPath
   * @returns {any} SoundFont2 instance
   */
  getForPath(absPath) {
    const stat = fs.statSync(absPath);
    const key = `${absPath}:${stat.mtimeMs}`;

    const hit = this._map.get(key);
    if (hit) {
      // Touch for LRU ordering
      this._map.delete(key);
      this._map.set(key, hit);
      return hit.sf2;
    }

    // Miss — parse and store. Drop any older entry for the same path (mtime
    // changed) so we don't retain the obsolete instance forever.
    for (const k of this._map.keys()) {
      if (k.startsWith(absPath + ':')) this._map.delete(k);
    }
    const buf = fs.readFileSync(absPath);
    const sf2 = parseSoundFont(buf);
    this._parseCount++;
    this._map.set(key, { sf2, mtimeMs: stat.mtimeMs });

    while (this._map.size > this.capacity) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    return sf2;
  }

  /**
   * Drop every cached entry whose path matches the given prefix. Used when
   * a custom SF2 is deleted by the user.
   *
   * @param {string} absPathPrefix
   */
  invalidate(absPathPrefix) {
    for (const k of this._map.keys()) {
      if (k.startsWith(absPathPrefix + ':') || k === absPathPrefix) {
        this._map.delete(k);
      }
    }
  }

  /** Drop everything (used by tests and on shutdown). */
  clear() {
    this._map.clear();
    this._parseCount = 0;
  }

  /** @returns {{ size: number, parses: number }} */
  getStats() {
    return { size: this._map.size, parses: this._parseCount };
  }
}
