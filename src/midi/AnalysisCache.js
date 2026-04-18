/**
 * @file src/midi/AnalysisCache.js
 * @description LRU + TTL cache for MIDI channel analyses.
 *
 * Sits in front of {@link AutoAssigner}/{@link ChannelAnalyzer} to avoid
 * re-running expensive per-channel analyses (note range, instrument
 * suggestions, polyphony stats) when the same file/channel pair is queried
 * repeatedly during a session.
 *
 * Eviction is dual-keyed:
 *   - LRU: when {@link AnalysisCache#set} would exceed `maxSize`, the
 *     least-recently-touched entry is dropped first.
 *   - TTL: entries older than `ttl` ms are treated as missing on `get` and
 *     swept by an explicit {@link AnalysisCache#cleanup} call.
 *
 * Cache invalidation is the caller's responsibility — call
 * {@link AnalysisCache#invalidateFile} after a file is re-uploaded or its
 * channel routing changes.
 */

/**
 * Bounded LRU cache for per-channel analysis results.
 */
class AnalysisCache {
  constructor(maxSize = 100, ttl = 600000) { // 10 minutes by default
    this.maxSize = maxSize;
    this.ttl = ttl; // Time to live in milliseconds
    this.cache = new Map();
    this.accessOrder = []; // For LRU
  }

  /**
   * Generates a cache key for a file + channel
   * @param {number} fileId
   * @param {number} channel
   * @returns {string}
   */
  _generateKey(fileId, channel) {
    return `${fileId}:${channel}`;
  }

  /**
   * Retrieves an analysis from the cache
   * @param {number} fileId
   * @param {number} channel
   * @returns {Object|null}
   */
  get(fileId, channel) {
    const key = this._generateKey(fileId, channel);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check expiration
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
      return null;
    }

    // Update access order (LRU)
    this._touch(key);

    return entry.data;
  }

  /**
   * Stores an analysis in the cache
   * @param {number} fileId
   * @param {number} channel
   * @param {Object} data
   */
  set(fileId, channel, data) {
    const key = this._generateKey(fileId, channel);

    // If already present, remove from access order
    if (this.cache.has(key)) {
      this._removeFromAccessOrder(key);
    }

    // Check max size and evict oldest if needed
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this._evictOldest();
    }

    // Add to cache
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    // Add to access order
    this.accessOrder.push(key);
  }

  /**
   * Deletes a cache entry
   * @param {number} fileId
   * @param {number} channel
   */
  delete(fileId, channel) {
    const key = this._generateKey(fileId, channel);
    this.cache.delete(key);
    this._removeFromAccessOrder(key);
  }

  /**
   * Invalidates all analyses for a file
   * @param {number} fileId
   */
  invalidateFile(fileId) {
    const prefix = `${fileId}:`;
    const keysToDelete = [];

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
    }
  }

  /**
   * Completely clears the cache
   */
  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Updates the access order (LRU)
   * @param {string} key
   * @private
   */
  _touch(key) {
    this._removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  /**
   * Removes a key from the access order
   * @param {string} key
   * @private
   */
  _removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Evicts the oldest entry (LRU)
   * @private
   */
  _evictOldest() {
    if (this.accessOrder.length === 0) {
      return;
    }

    const oldestKey = this.accessOrder[0];
    this.cache.delete(oldestKey);
    this.accessOrder.shift();
  }

  /**
   * Cleans up expired entries
   */
  cleanup() {
    const now = Date.now();
    const keysToDelete = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
    }
  }

  /**
   * Gets cache statistics
   * @returns {Object}
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
      oldestEntry: this.accessOrder.length > 0 ? this.accessOrder[0] : null,
      newestEntry: this.accessOrder.length > 0 ? this.accessOrder[this.accessOrder.length - 1] : null
    };
  }
}

export default AnalysisCache;
