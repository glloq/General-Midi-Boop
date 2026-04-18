/**
 * @file src/midi/playback/AnalysisCache.js
 * @description Size-bounded LRU cache for MIDI channel analyses.
 *
 * Sits in front of {@link AutoAssigner}/{@link ChannelAnalyzer} to avoid
 * re-running expensive per-channel analyses (note range, instrument
 * suggestions, polyphony stats) when the same file/channel pair is queried
 * repeatedly during a session.
 *
 * Eviction policy:
 *   - LRU by access order (touched on every `get`/`set`).
 *   - Capped on byte count (`maxBytes`, default 32 MB) AND entry count
 *     (`maxSize`, default 500). The first cap reached triggers eviction.
 *   - No automatic TTL expiration: in v6 invalidation is event-driven
 *     (`file_write`, `file_delete` over EventBus). Caller can still use the
 *     legacy `cleanup()` no-op for backward compatibility.
 *
 * Optional EventBus integration: pass `{ eventBus }` and the cache
 * subscribes to `file_write`/`file_delete`/`file_uploaded` and invalidates
 * the affected file automatically.
 */

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

class AnalysisCache {
  /**
   * @param {number|Object} [maxSizeOrOpts] - Backwards-compatible: either a
   *   number (max entry count, legacy) or an options object
   *   `{ maxSize, maxBytes, eventBus, logger }`.
   * @param {number} [legacyTtl] - Ignored in v6 (kept for call-site compat).
   */
  constructor(maxSizeOrOpts = DEFAULT_MAX_SIZE, legacyTtl) {
    let opts = {};
    if (typeof maxSizeOrOpts === 'object' && maxSizeOrOpts !== null) {
      opts = maxSizeOrOpts;
    } else {
      opts = { maxSize: maxSizeOrOpts, _legacyTtl: legacyTtl };
    }

    this.maxSize = opts.maxSize > 0 ? opts.maxSize : DEFAULT_MAX_SIZE;
    this.maxBytes = opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
    this.cache = new Map(); // key -> { data, bytes }
    this.accessOrder = [];  // LRU order, oldest first
    this.totalBytes = 0;
    this.logger = opts.logger || null;

    if (opts.eventBus) {
      this._wireEventBus(opts.eventBus);
    }
  }

  _wireEventBus(eventBus) {
    const invalidate = (data) => {
      if (data && data.fileId !== undefined) this.invalidateFile(data.fileId);
    };
    eventBus.on('file_write', invalidate);
    eventBus.on('file_delete', invalidate);
    eventBus.on('file_uploaded', invalidate);
  }

  _generateKey(fileId, channel) {
    return `${fileId}:${channel}`;
  }

  /**
   * Estimate the byte footprint of a value. Cheap heuristic: JSON length.
   * Good enough for proportional eviction; not a strict ceiling.
   */
  _estimateBytes(value) {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 1024;
    }
  }

  get(fileId, channel) {
    const key = this._generateKey(fileId, channel);
    const entry = this.cache.get(key);
    if (!entry) return null;
    this._touch(key);
    return entry.data;
  }

  set(fileId, channel, data) {
    const key = this._generateKey(fileId, channel);

    if (this.cache.has(key)) {
      const prev = this.cache.get(key);
      this.totalBytes -= prev.bytes;
      this._removeFromAccessOrder(key);
    }

    const bytes = this._estimateBytes(data);
    this.cache.set(key, { data, bytes });
    this.accessOrder.push(key);
    this.totalBytes += bytes;

    while (
      (this.cache.size > this.maxSize || this.totalBytes > this.maxBytes) &&
      this.accessOrder.length > 0
    ) {
      this._evictOldest();
    }
  }

  delete(fileId, channel) {
    const key = this._generateKey(fileId, channel);
    const entry = this.cache.get(key);
    if (entry) {
      this.totalBytes -= entry.bytes;
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
    }
  }

  invalidateFile(fileId) {
    const prefix = `${fileId}:`;
    const keysToDelete = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) keysToDelete.push(key);
    }
    for (const key of keysToDelete) {
      const entry = this.cache.get(key);
      if (entry) this.totalBytes -= entry.bytes;
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
    }
  }

  clear() {
    this.cache.clear();
    this.accessOrder = [];
    this.totalBytes = 0;
  }

  _touch(key) {
    this._removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  _removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) this.accessOrder.splice(index, 1);
  }

  _evictOldest() {
    const oldestKey = this.accessOrder.shift();
    if (!oldestKey) return;
    const entry = this.cache.get(oldestKey);
    if (entry) {
      this.totalBytes -= entry.bytes;
      this.cache.delete(oldestKey);
    }
  }

  /** Backwards-compat: TTL-based cleanup is a no-op in v6. */
  cleanup() {}

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      oldestEntry: this.accessOrder.length > 0 ? this.accessOrder[0] : null,
      newestEntry: this.accessOrder.length > 0
        ? this.accessOrder[this.accessOrder.length - 1]
        : null
    };
  }
}

export default AnalysisCache;
