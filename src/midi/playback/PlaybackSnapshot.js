/**
 * @file src/midi/playback/PlaybackSnapshot.js
 * @description Immutable view of the instrument-capability and
 * compensation data needed during a single playback session.
 *
 * Problem this solves
 * -------------------
 * `better-sqlite3` is synchronous. Any DB hit during the MIDI hot path
 * — even a cache miss inside CapabilityResolver / CompensationService —
 * blocks the event loop for the duration of the SQL call (typically
 * 0.1-2 ms on a Pi, sometimes worse when the SD card is busy).
 *
 * Mid-playback mutations make this worse: a UI change of `sync_delay`
 * fires `instrument_settings_changed`, which the underlying services
 * react to by invalidating their caches. The very next note-on lookup
 * then re-queries SQLite mid-tick.
 *
 * The snapshot wraps the resolver and the compensation service with a
 * second-level cache that is NEVER invalidated for the lifetime of one
 * playback. The first lookup for a (deviceId, channel) pair hits the
 * underlying service once (whose own cache may itself be warm); the
 * snapshot stores the value and serves every subsequent lookup
 * directly. Mutations applied to the underlying service after the
 * snapshot is built are ignored until {@link PlaybackSnapshot#destroy}
 * is called (typically when playback stops) — at which point
 * `MidiPlayer` flushes deferred mutations and the next playback builds
 * a fresh snapshot.
 *
 * Hot-path methods are kept in lockstep with the resolver/compensation
 * API surface used by `PlaybackScheduler` so swapping one for the
 * other is a one-line change.
 */

/**
 * Frozen lookup view used for the duration of a playback.
 */
export class PlaybackSnapshot {
  /**
   * @param {Object} deps
   * @param {Object} [deps.capabilityResolver] - source of string-CC and timing constraints
   * @param {Object} [deps.compensationService] - source of sync_delay / latency compensation
   * @param {Object} [deps.logger]
   */
  constructor({ capabilityResolver = null, compensationService = null, logger = null } = {}) {
    this._cap = capabilityResolver;
    this._comp = compensationService;
    this._log = logger;
    /** @type {Map<string, boolean>} */
    this._stringCC = new Map();
    /** @type {Map<string, {minNoteInterval:number|null, minNoteDuration:number|null, polyphony:number|null}>} */
    this._timing = new Map();
    /** @type {Map<string, number>} */
    this._compMs = new Map();
    this._destroyed = false;
  }

  /**
   * Build the cache key from (device, channel). Channel `undefined`
   * yields a device-level key, matching CompensationService.
   * @private
   */
  _key(deviceId, channel) {
    return channel !== undefined && channel !== null
      ? `${deviceId}:${channel}`
      : `${deviceId}`;
  }

  /**
   * Returns sync-delay compensation in ms for a (device, channel) pair.
   * Falls back to 0 when no compensation service is wired.
   *
   * @param {string} deviceId
   * @param {number} [channel]
   * @returns {number}
   */
  getCompensationMs(deviceId, channel) {
    const key = this._key(deviceId, channel);
    const cached = this._compMs.get(key);
    if (cached !== undefined) return cached;
    const value = this._comp ? this._comp.getDelay(deviceId, channel) : 0;
    const normalised = Number.isFinite(value) ? value : 0;
    this._compMs.set(key, normalised);
    return normalised;
  }

  /**
   * Returns the frozen timing-constraint record for a device:channel.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @returns {{ minNoteInterval: number|null, minNoteDuration: number|null, polyphony: number|null }}
   */
  getTimingConstraints(deviceId, channel) {
    const key = this._key(deviceId, channel);
    const cached = this._timing.get(key);
    if (cached !== undefined) return cached;
    const value = this._cap
      ? this._cap.getTimingConstraints(deviceId, channel)
      : { minNoteInterval: null, minNoteDuration: null, polyphony: null };
    // Defensive freeze so a downstream caller cannot mutate the cached object.
    const frozen = Object.freeze({ ...value });
    this._timing.set(key, frozen);
    return frozen;
  }

  /**
   * Returns true when CC 20 / CC 21 are forwarded for this
   * (deviceId, channel) — i.e. a string instrument with cc_enabled.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @returns {boolean}
   */
  isStringCCAllowed(deviceId, channel) {
    const key = this._key(deviceId, channel);
    const cached = this._stringCC.get(key);
    if (cached !== undefined) return cached;
    const value = this._cap ? !!this._cap.isStringCCAllowed(deviceId, channel) : false;
    this._stringCC.set(key, value);
    return value;
  }

  /** @returns {{ stringCC: number, timing: number, comp: number }} */
  getStats() {
    return {
      stringCC: this._stringCC.size,
      timing: this._timing.size,
      comp: this._compMs.size
    };
  }

  /**
   * Tear down the snapshot. Subsequent lookups still work but are
   * recomputed from the underlying services (legacy fallback).
   * @returns {void}
   */
  destroy() {
    this._destroyed = true;
    this._stringCC.clear();
    this._timing.clear();
    this._compMs.clear();
  }
}

export default PlaybackSnapshot;
