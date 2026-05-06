/**
 * @file src/midi/compensation/CompensationService.js
 * @description Single source of truth for MIDI timing compensation.
 *
 * Combines two sources of latency into one cached value per device+channel:
 *   1. User-configured `sync_delay` stored in instrument settings (DB).
 *   2. Measured hardware round-trip latency from LatencyCompensator.
 *
 * Previously this logic was duplicated between MidiRouter (_getRouteCompensation)
 * and PlaybackScheduler (_getSyncDelay) with separate caches — a divergence risk
 * if one cache was stale and not the other.
 *
 * Cache policy:
 *   - Entries are invalidated immediately on `instrument_settings_changed`.
 *   - A 30-second periodic sweep clears the cache to recover from edge cases
 *     where the event is missed (e.g. direct DB writes in tests).
 *
 * @see MidiRouter — uses getDelay() for relative compensation in real-time routing.
 * @see PlaybackScheduler — uses getDelay() for sync-delay compensation during playback.
 */
import { TIMING } from '../../core/constants.js';

const { MAX_COMPENSATION_MS } = TIMING;
const CACHE_TTL_MS = 30_000;

export class CompensationService {
  /**
   * @param {Object} deps
   * @param {Object} deps.database          - Database facade (getInstrumentSettings).
   * @param {Object} [deps.latencyCompensator] - Optional hardware latency source.
   * @param {Object} deps.eventBus          - EventBus instance.
   * @param {Object} deps.logger            - Logger instance.
   */
  constructor({ database, latencyCompensator, eventBus, logger }) {
    this._db = database;
    this._lc = latencyCompensator || null;
    this._log = logger;
    this._eventBus = eventBus ?? null;
    /** @type {Map<string, number>} */
    this._cache = new Map();

    this._cacheTimer = setInterval(() => this._cache.clear(), CACHE_TTL_MS).unref();

    this._onSettingsChanged = () => this._cache.clear();
    eventBus?.on('instrument_settings_changed', this._onSettingsChanged);
  }

  /**
   * Returns the total timing compensation (ms) for a device+channel pair.
   * Result is clamped to [-MAX_COMPENSATION_MS, +MAX_COMPENSATION_MS].
   *
   * @param {string} deviceId
   * @param {number} [channel] - MIDI channel (0-15). Omit for device-level lookup.
   * @returns {number} Compensation in milliseconds (positive = delay the send).
   */
  getDelay(deviceId, channel) {
    const key = channel !== undefined ? `${deviceId}:${channel}` : deviceId;
    if (this._cache.has(key)) return this._cache.get(key);

    const result = this._compute(deviceId, channel);
    this._cache.set(key, result);
    return result;
  }

  /**
   * Force immediate cache invalidation (e.g. after a route is deleted).
   * @returns {void}
   */
  invalidate() {
    this._cache.clear();
  }

  /**
   * Cancel background timers and detach EventBus listener.
   * @returns {void}
   */
  destroy() {
    if (this._cacheTimer) {
      clearInterval(this._cacheTimer);
      this._cacheTimer = null;
    }
    this._eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * @param {string} deviceId
   * @param {number} [channel]
   * @returns {number}
   * @private
   */
  _compute(deviceId, channel) {
    let total = 0;

    // 1. User-configured sync_delay per instrument/channel
    if (this._db) {
      try {
        const settings = this._db.getInstrumentSettings(deviceId, channel);
        if (settings?.sync_delay != null) {
          total += settings.sync_delay;
        }
      } catch {
        // DB errors are non-fatal in hot paths
      }
    }

    // 2. Measured hardware round-trip latency
    if (this._lc) {
      const hw = this._lc.getLatency(deviceId);
      if (hw > 0) total += hw;
    }

    // Clamp
    if (total > MAX_COMPENSATION_MS) {
      this._log.warn(
        `CompensationService: ${total.toFixed(0)}ms for ${deviceId}:${channel} ` +
        `exceeds max ${MAX_COMPENSATION_MS}ms, clamping`
      );
      return MAX_COMPENSATION_MS;
    }
    if (total < -MAX_COMPENSATION_MS) {
      this._log.warn(
        `CompensationService: ${total.toFixed(0)}ms for ${deviceId}:${channel} ` +
        `exceeds min -${MAX_COMPENSATION_MS}ms, clamping`
      );
      return -MAX_COMPENSATION_MS;
    }

    return total;
  }
}
