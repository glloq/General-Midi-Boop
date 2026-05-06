/**
 * @file src/midi/instrument/CapabilityResolver.js
 * @description Centralised lookup for per-device/channel instrument capabilities.
 *
 * Previously scattered across PlaybackScheduler as private methods:
 *   - _isStringCCAllowed  → isStringCCAllowed()
 *   - _getTimingConstraints → getTimingConstraints()
 *
 * Both lookups are cached per device:channel and invalidated together on
 * `instrument_settings_changed`. A single cache guarantees that capability
 * data is always consistent between the two callers.
 *
 * Cache policy mirrors CompensationService: event-driven invalidation +
 * 30-second periodic sweep to recover from missed events (direct DB writes
 * in tests, etc.).
 *
 * @see PlaybackScheduler — primary consumer.
 */

const CACHE_TTL_MS = 30_000;

export class CapabilityResolver {
  /**
   * @param {Object} deps
   * @param {Object} deps.database   - Database facade.
   * @param {Object} deps.eventBus   - EventBus instance.
   */
  constructor({ database, eventBus }) {
    this._db = database;
    this._eventBus = eventBus ?? null;
    /** @type {Map<string, boolean>} */
    this._stringCCCache = new Map();
    /** @type {Map<string, {minNoteInterval:number|null, minNoteDuration:number|null, polyphony:number|null}>} */
    this._timingCache = new Map();

    this._cacheTimer = setInterval(() => this.invalidate(), CACHE_TTL_MS).unref();

    this._onSettingsChanged = () => this.invalidate();
    eventBus?.on('instrument_settings_changed', this._onSettingsChanged);
  }

  /**
   * Returns true if CC 20 (STRING_SELECT) and CC 21 (FRET_SELECT) should
   * be forwarded to this device+channel. Only string instruments with
   * `cc_enabled !== false` qualify.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @returns {boolean}
   */
  isStringCCAllowed(deviceId, channel) {
    const key = `${deviceId}:${channel}`;
    if (this._stringCCCache.has(key)) return this._stringCCCache.get(key);

    let allowed = false;
    try {
      const instrument = this._db?.stringInstrumentDB?.getStringInstrument(deviceId, channel);
      allowed = instrument != null && instrument.cc_enabled !== false;
    } catch {
      allowed = false;
    }
    this._stringCCCache.set(key, allowed);
    return allowed;
  }

  /**
   * Returns timing and polyphony constraints for a device+channel.
   * All fields default to `null` when no capability record exists.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @returns {{ minNoteInterval: number|null, minNoteDuration: number|null, polyphony: number|null }}
   */
  getTimingConstraints(deviceId, channel) {
    const key = `${deviceId}:${channel}`;
    if (this._timingCache.has(key)) return this._timingCache.get(key);

    let constraints = { minNoteInterval: null, minNoteDuration: null, polyphony: null };
    try {
      const capDB = this._db?.instrumentCapabilitiesDB;
      if (capDB) {
        const instrument = capDB.getInstrumentCapabilities(deviceId, channel);
        if (instrument) {
          constraints = {
            minNoteInterval: instrument.min_note_interval || null,
            minNoteDuration: instrument.min_note_duration || null,
            polyphony: instrument.polyphony || null
          };
        }
      }
    } catch {
      // No constraints applied when DB is unavailable
    }
    this._timingCache.set(key, constraints);
    return constraints;
  }

  /**
   * Force invalidation of all cached capability data.
   * @returns {void}
   */
  invalidate() {
    this._stringCCCache.clear();
    this._timingCache.clear();
  }

  /**
   * Cancel background timer and detach EventBus listener. Call during shutdown.
   * @returns {void}
   */
  destroy() {
    if (this._cacheTimer) {
      clearInterval(this._cacheTimer);
      this._cacheTimer = null;
    }
    this._eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
    this.invalidate();
  }
}
