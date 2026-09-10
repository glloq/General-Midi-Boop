/**
 * @file src/midi/playback/MidiClockGenerator.js
 * @description Master MIDI clock generator. Emits 24 pulses per quarter
 * note (industry standard) plus the Start / Stop / Continue transport
 * messages and the Song Position Pointer used to relocate slaves.
 * Uses a drift-correcting `setTimeout` schedule so the long-term tempo
 * stays accurate despite per-tick jitter.
 *
 * Per-device latency compensation: the slowest target sends its tick
 * immediately, every other target is delayed by `(slowest - this)` ms.
 * This mirrors the strategy in {@link MidiRouter} so clock pulses
 * arrive in sync with the routed MIDI traffic.
 *
 * Caches:
 *   - `_compensationCache` per-device latency lookups, invalidated on
 *     `instrument_settings_changed` and `device_settings_changed`.
 *   - `_cachedTargetDevices` device list, invalidated on
 *     `device_connected` / `device_disconnected`.
 */

import { performance } from 'perf_hooks';
import { TIMING } from '../../core/constants.js';

/** 24 pulses per quarter note — MIDI 1.0 standard. */
const MIDI_CLOCK_PPQ = TIMING.MIDI_CLOCK_PPQ;

/**
 * Song Position Pointer is a 14-bit value (two 7-bit data bytes), so the
 * highest addressable position is 16383 MIDI beats — 4095 quarter notes,
 * about 34 minutes at 120 BPM. Beyond that the spec has nothing to say and
 * the value is clamped.
 */
const MAX_SONG_POSITION_BEATS = 0x3fff;

/**
 * How many tick intervals of lateness are treated as "the event loop was
 * blocked" rather than ordinary jitter. Beyond this the clock re-anchors on
 * the current instant instead of replaying every missed tick at delay 0
 * (audit F-44). Two intervals is ~42 ms at 120 BPM and ~21 ms at 240 BPM —
 * an order of magnitude above the few ms of libuv jitter measured under
 * load, and far below any real stall (L07 measured 5 015 ms on a contended
 * SQLite write, wave 1 brought it down to 257 ms).
 */
const CLOCK_RESYNC_TICKS = 2;

class MidiClockGenerator {
  /**
   * @param {Object} deps - Service-container facade. The clock reads
   *   `logger`, `eventBus`, `database` and `latencyCompensator` at
   *   construction; the transports (deviceManager, network/serial/
   *   bluetooth managers) are looked up lazily through getters because
   *   they may register after the clock or be entirely absent on
   *   non-Pi hosts.
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.database = deps.database;
    // `latencyCompensator` is registered AFTER this service in
    // Application.initialize (line 221 vs 219) — eager capture would
    // freeze `undefined`, silently disabling per-device clock-tick
    // latency compensation. Same story for the four transport
    // managers. Use lazy getters so we always pick up the live
    // instance.
    for (const name of [
      'deviceManager',
      'networkManager',
      'serialMidiManager',
      'bluetoothManager',
      'latencyCompensator'
    ]) {
      Object.defineProperty(this, name, {
        get: () => deps[name],
        configurable: true
      });
    }
    this._enabled = false;
    this._running = false;
    this._paused = false;
    this._tempo = 120; // BPM
    this._tickIntervalMs = this._calcTickInterval(120);

    // Drift-correcting timer state
    this._timer = null;
    this._expectedTime = 0;

    // Last Song Position Pointer put on the wire, in MIDI beats (sixteenth
    // notes). `null` until a locate happens. Exposed through getSyncMetrics()
    // so an operator can see where the slaves were told to go.
    this._lastSongPosition = null;

    // F-44 observability: how many times the clock re-anchored after an
    // event-loop stall, and how many ticks were dropped doing so.
    this._resyncCount = 0;
    this._skippedTicks = 0;

    // Devices that receive clock (deviceId -> true/false). Unset = default (true).
    this._deviceClockEnabled = new Map();

    // Cached list of target devices (invalidated on device changes)
    this._cachedTargetDevices = null;
    this._cachedDeviceCompensations = null; // Map<deviceId, compensationMs>
    this._maxCompensation = 0; // Max compensation across all clock targets
    this._immediateBucket = null; // deviceId[] sent inline each tick
    this._delayedBuckets = null; // Map<delayMs, deviceId[]> grouped by relative delay

    // Pending compensation timeouts for cleanup
    this._pendingTimeouts = new Set();

    // Cache for device compensation (cleared on settings change)
    this._compensationCache = new Map();

    this._onSettingsChanged = () => {
      this._compensationCache.clear();
      this._invalidateDeviceCache();
    };
    this.eventBus?.on('instrument_settings_changed', this._onSettingsChanged);
    this.eventBus?.on('device_settings_changed', this._onSettingsChanged);

    // Invalidate device cache when devices connect/disconnect
    this._onDeviceChanged = () => {
      this._invalidateDeviceCache();
    };
    this.eventBus?.on('device_connected', this._onDeviceChanged);
    this.eventBus?.on('device_disconnected', this._onDeviceChanged);
  }

  // ─── Configuration ──────────────────────────────────────────

  /**
   * Enable / disable the clock generator globally. When transitioning
   * from on→off mid-playback, also stops the running clock so devices
   * receive a proper Stop transport message.
   *
   * @param {boolean} enabled
   * @returns {void}
   */
  setEnabled(enabled) {
    const wasEnabled = this._enabled;
    this._enabled = !!enabled;
    this.logger.info(`MIDI Clock ${this._enabled ? 'enabled' : 'disabled'}`);

    // If disabled while running, stop
    if (wasEnabled && !this._enabled && this._running) {
      this.stopPlayback();
    }
  }

  /** @returns {boolean} */
  isEnabled() {
    return this._enabled;
  }

  /**
   * Per-device override of clock targeting. Process-local (not
   * persisted); use the device-settings command to persist.
   *
   * @param {string} deviceId
   * @param {boolean} enabled
   * @returns {void}
   */
  setDeviceClockEnabled(deviceId, enabled) {
    this._deviceClockEnabled.set(deviceId, !!enabled);
    this._invalidateDeviceCache();
  }

  /**
   * Resolve the effective clock-enabled state for a device. Runtime
   * overrides win; otherwise falls back to the persisted DB flag.
   *
   * @param {string} deviceId
   * @returns {boolean}
   */
  isDeviceClockEnabled(deviceId) {
    if (this._deviceClockEnabled.has(deviceId)) {
      return this._deviceClockEnabled.get(deviceId);
    }
    return this._isDeviceClockEnabledInDB(deviceId);
  }

  /**
   * Check the devices table for `midi_clock_enabled = 1` on the device
   * (any channel suffices).
   *
   * @param {string} deviceId
   * @returns {boolean}
   * @private
   */
  _isDeviceClockEnabledInDB(deviceId) {
    if (!this.database) return false;
    try {
      const settings = this.database.getDeviceSettings(deviceId);
      return settings && !!settings.midi_clock_enabled;
    } catch (_e) {
      /* device settings may not exist yet */
    }
    return false;
  }

  // ─── Playback lifecycle ─────────────────────────────────────

  /**
   * Start MIDI clock with playback.
   *
   * With no song position (or position 0) this sends MIDI **Start** (0xFA),
   * which MIDI 1.0 defines as "play from the beginning" — correct for a fresh
   * play or a loop back to bar 1.
   *
   * With a non-zero `songPositionBeats` it sends the spec-correct **locate**
   * sequence instead: **Song Position Pointer (0xF2)** followed by
   * **Continue (0xFB)**. Sending Start after a seek made every slave synced to
   * this clock jump back to bar 1 while the operator had just moved the
   * playhead to the middle of the song (audit F-43). The caller is expected to
   * have sent Stop (0xFC) beforehand — {@link MidiPlayer#seek} does — so the
   * full sequence on the wire is `FC → F2 → FB`.
   *
   * @param {number} tempo - BPM
   * @param {?number} [songPositionBeats] - Target position in MIDI beats
   *   (sixteenth notes = 6 clock ticks). `null`/0 ⇒ Start from bar 1.
   * @returns {void}
   */
  startPlayback(tempo, songPositionBeats = null) {
    if (!this._enabled) return;

    // Stop any existing clock to avoid timer leaks (e.g., during seek)
    if (this._running) {
      this._stopClockTimer();
    }

    this._tempo = tempo;
    this._tickIntervalMs = this._calcTickInterval(tempo);
    this._paused = false;
    this._running = true;

    // Rebuild device/compensation caches
    this._invalidateDeviceCache();
    this._ensureDeviceCache();

    const beats = this._normalizeSongPosition(songPositionBeats);
    if (beats > 0) {
      this.sendSongPosition(beats);
      this._sendTransportToAll('continue');
    } else {
      // Start means "from the beginning": the slaves' song position IS 0.
      this._lastSongPosition = 0;
      this._sendTransportToAll('start');
    }
    this._startClockTimer();

    this.logger.info(
      `MIDI Clock ${beats > 0 ? `continued at SPP ${beats}` : 'started'} at ${tempo.toFixed(1)} BPM (tick every ${this._tickIntervalMs.toFixed(2)}ms)`
    );
  }

  /**
   * Emit a **Song Position Pointer** (0xF2) to every clock target.
   *
   * SPP carries a 14-bit count of *MIDI beats* — sixteenth notes, i.e. 6 clock
   * pulses each — split LSB-first into two 7-bit data bytes. MIDI 1.0 says a
   * slave must be **stopped** when it receives one, and resumes at that
   * position on the next Continue; that is the whole point of the
   * Stop → SPP → Continue locate sequence (audit F-43).
   *
   * The payload carries the position twice on purpose: `value` is the 14-bit
   * form easymidi expects on the USB path, `bytes` the pre-split pair the
   * byte-level transports (BLE / serial / RTP) consume.
   *
   * @param {number} songPositionBeats - Position in MIDI beats. Clamped to
   *   the 14-bit range and rounded to the nearest sixteenth.
   * @returns {?number} The beat value actually sent, or `null` when the clock
   *   is disabled (nothing was emitted).
   */
  sendSongPosition(songPositionBeats) {
    if (!this._enabled) return null;

    const beats = this._normalizeSongPosition(songPositionBeats);
    this._lastSongPosition = beats;
    this._dispatchToBuckets((deviceId) =>
      this._sendTransportToDevice(deviceId, 'position', {
        value: beats,
        bytes: [beats & 0x7f, (beats >> 7) & 0x7f]
      })
    );
    return beats;
  }

  /**
   * Clamp/round an arbitrary caller value into the 14-bit SPP domain.
   * @param {*} beats
   * @returns {number} 0 … 16383
   * @private
   */
  _normalizeSongPosition(beats) {
    const n = Number(beats);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_SONG_POSITION_BEATS, Math.round(n));
  }

  /** @returns {?number} Last SPP emitted, in MIDI beats (null if never). */
  getLastSongPosition() {
    return this._lastSongPosition;
  }

  /**
   * Observability for the two policies this generator implements: where the
   * slaves were last told to locate (F-43) and how often the tick grid had to
   * be re-anchored after an event-loop stall (F-44).
   *
   * @returns {{lastSongPosition: ?number, resyncCount: number,
   *   skippedTicks: number, tickIntervalMs: number}}
   */
  getSyncMetrics() {
    return {
      lastSongPosition: this._lastSongPosition,
      resyncCount: this._resyncCount,
      skippedTicks: this._skippedTicks,
      tickIntervalMs: this._tickIntervalMs
    };
  }

  /**
   * Stop MIDI clock.
   * Sends MIDI Stop (0xFC) and stops ticks.
   */
  stopPlayback() {
    if (!this._running) return;

    this._stopClockTimer();
    this._sendTransportToAll('stop');
    this._running = false;
    this._paused = false;

    this.logger.info('MIDI Clock stopped');
  }

  /**
   * Pause MIDI clock.
   * Sends MIDI Stop (0xFC) and pauses ticks (can resume later).
   */
  pausePlayback() {
    if (!this._running || this._paused) return;

    this._stopClockTimer();
    this._sendTransportToAll('stop');
    this._paused = true;

    this.logger.info('MIDI Clock paused');
  }

  /**
   * Resume MIDI clock after pause.
   * Sends MIDI Continue (0xFB) and resumes ticks.
   */
  resumePlayback() {
    if (!this._running || !this._paused) return;

    this._paused = false;
    this._sendTransportToAll('continue');
    this._startClockTimer();

    this.logger.info('MIDI Clock resumed');
  }

  // ─── Tempo ──────────────────────────────────────────────────

  /**
   * Update tempo (e.g. on mid-song tempo change).
   * @param {number} bpm
   */
  setTempo(bpm) {
    if (bpm <= 0 || bpm === this._tempo) return;

    this._tempo = bpm;
    this._tickIntervalMs = this._calcTickInterval(bpm);

    this.logger.debug(
      `MIDI Clock tempo changed to ${bpm.toFixed(1)} BPM (tick every ${this._tickIntervalMs.toFixed(2)}ms)`
    );
  }

  /** @returns {number} Current tempo in BPM. */
  getTempo() {
    return this._tempo;
  }

  // ─── Internal timer ─────────────────────────────────────────

  /**
   * Calculate tick interval in ms for given BPM.
   * 24 PPQ → interval = 60000 / (bpm * 24)
   */
  _calcTickInterval(bpm) {
    return 60000 / (bpm * MIDI_CLOCK_PPQ);
  }

  /**
   * Start the drift-correcting clock timer.
   */
  _startClockTimer() {
    this._expectedTime = performance.now();
    this._scheduleNextTick();
  }

  /**
   * Stop the clock timer and clear pending compensation timeouts.
   */
  _stopClockTimer() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    for (const tid of this._pendingTimeouts) {
      clearTimeout(tid);
    }
    this._pendingTimeouts.clear();
  }

  /**
   * Schedule the next clock tick with drift correction.
   *
   * Drift correction accumulates the ideal grid (`_expectedTime`) rather than
   * chaining `setInterval`, so ordinary jitter never shifts the tempo. Past
   * `CLOCK_RESYNC_TICKS` intervals of lateness that is no longer jitter: the
   * event loop was blocked, and replaying every missed tick at delay 0 fired
   * the whole backlog on a single instant — 240 `0xF8` messages down every
   * output port after a 5 s stall (audit F-44). A burst like that is inaudible
   * as tempo but saturates the ports and, on a slave, arrives as an
   * instantaneous jump. Re-anchor on the current instant instead: the slaves'
   * musical position drifts by exactly the stall, which is what actually
   * happened, and the tick stream resumes at the right cadence immediately.
   */
  _scheduleNextTick() {
    const now = performance.now();
    this._expectedTime += this._tickIntervalMs;

    const lateness = now - this._expectedTime;
    if (lateness > this._tickIntervalMs * CLOCK_RESYNC_TICKS) {
      const skipped = Math.round(lateness / this._tickIntervalMs);
      this._resyncCount++;
      this._skippedTicks += skipped;
      this._expectedTime = now + this._tickIntervalMs;
      this.logger.warn(
        `MIDI Clock re-anchored after a ${lateness.toFixed(0)}ms event-loop stall ` +
          `(${skipped} tick(s) dropped instead of replayed as a burst)`
      );
    }

    const delay = Math.max(0, this._expectedTime - now);

    this._timer = setTimeout(() => {
      this._onTick();
    }, delay);
  }

  /**
   * Called on each clock tick. Sends 0xF8 to all enabled devices, then schedules next.
   */
  _onTick() {
    if (!this._running || this._paused) return;

    this._sendClockToAll();
    this._scheduleNextTick();
  }

  // ─── Sending with relative compensation ─────────────────────

  /**
   * Send a clock tick (0xF8) to all enabled output devices with per-device
   * relative latency compensation.
   *
   * Strategy: The device with the HIGHEST latency receives the clock immediately.
   * Devices with lower latency receive it LATER, so all instruments perceive
   * the clock at the same musical time.
   *
   * relativeDelay(device) = maxCompensation - deviceCompensation
   */
  _sendClockToAll() {
    this._dispatchToBuckets((deviceId) => this._sendClockToDevice(deviceId));
  }

  /**
   * Send a transport message (start/stop/continue) to all enabled devices
   * with per-device relative latency compensation.
   * @param {string} type - 'start', 'stop', or 'continue'
   */
  _sendTransportToAll(type) {
    this._dispatchToBuckets((deviceId) => this._sendTransportToDevice(deviceId, type));
  }

  /**
   * Shared compensation-bucket dispatch for {@link _sendClockToAll} and
   * {@link _sendTransportToAll}: ensures the device cache, sends to the
   * immediate bucket inline, then schedules one timer per distinct
   * relative-delay bucket.
   * @param {(deviceId: string) => void} sendFn
   * @private
   */
  _dispatchToBuckets(sendFn) {
    this._ensureDeviceCache();
    if (!this._cachedDeviceCompensations || this._cachedDeviceCompensations.size === 0) return;

    // Immediate bucket: dispatched inline, no timer.
    for (const deviceId of this._immediateBucket) {
      sendFn(deviceId);
    }

    // Delayed buckets: one timer per distinct relative delay.
    for (const [delayMs, deviceIds] of this._delayedBuckets) {
      const tid = setTimeout(() => {
        this._pendingTimeouts.delete(tid);
        for (const deviceId of deviceIds) {
          sendFn(deviceId);
        }
      }, delayMs);
      this._pendingTimeouts.add(tid);
    }
  }

  /**
   * Send a single clock tick to a device.
   * @param {string} deviceId
   */
  _sendClockToDevice(deviceId) {
    try {
      this.deviceManager.sendMessage(deviceId, 'clock', {});
    } catch (err) {
      this.logger.debug(`Failed to send clock to ${deviceId}: ${err.message}`);
    }
  }

  /**
   * Send a transport message to a device.
   * @param {string} deviceId
   * @param {string} type - 'start', 'stop', 'continue' or 'position'
   * @param {Object} [data] - Payload; only Song Position Pointer carries one.
   */
  _sendTransportToDevice(deviceId, type, data = {}) {
    try {
      this.deviceManager.sendMessage(deviceId, type, data);
    } catch (err) {
      this.logger.debug(`Failed to send ${type} to ${deviceId}: ${err.message}`);
    }
  }

  // ─── Device resolution & caching ────────────────────────────

  /**
   * Invalidate cached device list and compensations.
   * Called on device connect/disconnect or settings change.
   */
  _invalidateDeviceCache() {
    this._cachedTargetDevices = null;
    this._cachedDeviceCompensations = null;
    this._maxCompensation = 0;
    this._immediateBucket = null;
    this._delayedBuckets = null;
    this._compensationCache.clear();
  }

  /**
   * Build and cache the device list, compensation map, and per-delay
   * dispatch buckets if not already cached.
   *
   * Buckets group devices sharing the same `relativeDelay` so the hot
   * path schedules ONE `setTimeout` per bucket per tick instead of one
   * per device. With N devices and K distinct compensations, this drops
   * scheduled timers per tick from N to K (typically K ≤ 3).
   */
  _ensureDeviceCache() {
    if (this._cachedDeviceCompensations !== null) return;

    const devices = this._resolveClockTargetDevices();
    const compensations = new Map();
    let maxComp = 0;

    for (const deviceId of devices) {
      const comp = this._getDeviceCompensation(deviceId);
      compensations.set(deviceId, comp);
      if (comp > maxComp) maxComp = comp;
    }

    // Pre-compute dispatch buckets: relativeDelay -> deviceId[].
    // Delay ≤ 1 ms collapses into the "immediate" bucket (sent inline).
    const immediate = [];
    const delayed = new Map(); // delayMs -> deviceId[]
    for (const [deviceId, comp] of compensations) {
      const relativeDelay = maxComp - comp;
      if (relativeDelay <= 1) {
        immediate.push(deviceId);
      } else {
        const bucket = delayed.get(relativeDelay);
        if (bucket) bucket.push(deviceId);
        else delayed.set(relativeDelay, [deviceId]);
      }
    }

    this._cachedTargetDevices = devices;
    this._cachedDeviceCompensations = compensations;
    this._maxCompensation = maxComp;
    this._immediateBucket = immediate;
    this._delayedBuckets = delayed;
  }

  /**
   * Resolve the list of output device IDs that should receive clock.
   * @returns {string[]}
   */
  _resolveClockTargetDevices() {
    const deviceManager = this.deviceManager;
    if (!deviceManager) return [];

    // Get all connected output devices
    const allOutputs = Array.from(deviceManager.outputs?.keys() || []);

    // Also include BLE, network, serial devices
    const bleDevices = this.bluetoothManager
      ? this.bluetoothManager
          .getPairedDevices()
          .filter((d) => d.connected)
          .map((d) => d.address || d.name)
      : [];
    const networkDevices = this.networkManager
      ? this.networkManager.getConnectedDevices().map((d) => d.ip || d.name)
      : [];
    const serialDevices = this.serialMidiManager
      ? this.serialMidiManager.getConnectedPorts().map((p) => p.path || p.name)
      : [];

    const allDevices = [...allOutputs, ...bleDevices, ...networkDevices, ...serialDevices];

    // Filter by per-device clock enable setting
    return allDevices.filter((id) => this.isDeviceClockEnabled(id));
  }

  // ─── Compensation ───────────────────────────────────────────

  /**
   * Get latency compensation for a device in milliseconds.
   * Uses the MAX sync_delay across all channels for the device,
   * since clock is a device-level (channel-less) message.
   * @param {string} deviceId
   * @returns {number} compensation in ms
   */
  _getDeviceCompensation(deviceId) {
    if (this._compensationCache.has(deviceId)) {
      return this._compensationCache.get(deviceId);
    }

    let compensation = 0;

    // Find the maximum sync_delay across all channels for this device
    if (this.database) {
      try {
        // Try channels 0-15 to find the max sync_delay configured for this device
        for (let ch = 0; ch < 16; ch++) {
          const settings = this.database.getInstrumentSettings(deviceId, ch);
          if (settings && settings.sync_delay != null) {
            if (settings.sync_delay > compensation) {
              compensation = settings.sync_delay;
            }
          }
        }
      } catch (_e) {
        /* device may not have instrument settings configured */
      }
    }

    // Add measured hardware latency
    if (this.latencyCompensator) {
      const hwLatency = this.latencyCompensator.getLatency(deviceId);
      if (hwLatency > 0) {
        compensation += hwLatency;
      }
    }

    // Clamp to valid range (clock compensation should always be >= 0)
    compensation = Math.min(Math.max(compensation, 0), TIMING.MAX_COMPENSATION_MS);

    this._compensationCache.set(deviceId, compensation);
    return compensation;
  }

  // ─── Cleanup ────────────────────────────────────────────────

  /**
   * Stop the clock, drop all caches and detach EventBus listeners.
   * Must be called during application shutdown to avoid handler / timer
   * leaks across restarts.
   *
   * @returns {void}
   */
  destroy() {
    this.stopPlayback();
    this._lastSongPosition = null;
    this._compensationCache.clear();
    this._deviceClockEnabled.clear();
    this._cachedTargetDevices = null;
    this._cachedDeviceCompensations = null;
    if (this._onSettingsChanged) {
      this.eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
    }
    if (this._onDeviceChanged) {
      this.eventBus?.off('device_connected', this._onDeviceChanged);
      this.eventBus?.off('device_disconnected', this._onDeviceChanged);
    }
  }
}

export default MidiClockGenerator;
