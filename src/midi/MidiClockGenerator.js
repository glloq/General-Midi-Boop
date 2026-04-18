/**
 * @file src/midi/MidiClockGenerator.js
 * @description Master MIDI clock generator. Emits 24 pulses per quarter
 * note (industry standard) plus the Start / Stop / Continue transport
 * messages. Uses a drift-correcting `setTimeout` schedule so the long-
 * term tempo stays accurate despite per-tick jitter.
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
import { TIMING } from '../constants.js';

/** 24 pulses per quarter note — MIDI 1.0 standard. */
const MIDI_CLOCK_PPQ = TIMING.MIDI_CLOCK_PPQ;

class MidiClockGenerator {
  /**
   * @param {Object} app - Application context (deviceManager, database, latencyCompensator, logger, eventBus)
   */
  constructor(app) {
    this.app = app;
    this._enabled = false;
    this._running = false;
    this._paused = false;
    this._tempo = 120; // BPM
    this._tickIntervalMs = this._calcTickInterval(120);

    // Drift-correcting timer state
    this._timer = null;
    this._expectedTime = 0;

    // Devices that receive clock (deviceId -> true/false). Unset = default (true).
    this._deviceClockEnabled = new Map();

    // Cached list of target devices (invalidated on device changes)
    this._cachedTargetDevices = null;
    this._cachedDeviceCompensations = null; // Map<deviceId, compensationMs>
    this._maxCompensation = 0; // Max compensation across all clock targets

    // Pending compensation timeouts for cleanup
    this._pendingTimeouts = new Set();

    // Cache for device compensation (cleared on settings change)
    this._compensationCache = new Map();

    this._onSettingsChanged = () => {
      this._compensationCache.clear();
      this._invalidateDeviceCache();
    };
    this.app.eventBus?.on('instrument_settings_changed', this._onSettingsChanged);
    this.app.eventBus?.on('device_settings_changed', this._onSettingsChanged);

    // Invalidate device cache when devices connect/disconnect
    this._onDeviceChanged = () => {
      this._invalidateDeviceCache();
    };
    this.app.eventBus?.on('device_connected', this._onDeviceChanged);
    this.app.eventBus?.on('device_disconnected', this._onDeviceChanged);
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
    this.app.logger.info(`MIDI Clock ${this._enabled ? 'enabled' : 'disabled'}`);

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
    if (!this.app.database) return false;
    try {
      const settings = this.app.database.getDeviceSettings(deviceId);
      return settings && !!settings.midi_clock_enabled;
    } catch (_e) { /* device settings may not exist yet */ }
    return false;
  }

  // ─── Playback lifecycle ─────────────────────────────────────

  /**
   * Start MIDI clock with playback.
   * Sends MIDI Start (0xFA) then begins clock ticks.
   * @param {number} tempo - BPM
   */
  startPlayback(tempo) {
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

    this._sendTransportToAll('start');
    this._startClockTimer();

    this.app.logger.info(`MIDI Clock started at ${tempo.toFixed(1)} BPM (tick every ${this._tickIntervalMs.toFixed(2)}ms)`);
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

    this.app.logger.info('MIDI Clock stopped');
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

    this.app.logger.info('MIDI Clock paused');
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

    this.app.logger.info('MIDI Clock resumed');
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

    this.app.logger.debug(`MIDI Clock tempo changed to ${bpm.toFixed(1)} BPM (tick every ${this._tickIntervalMs.toFixed(2)}ms)`);
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
   */
  _scheduleNextTick() {
    const now = performance.now();
    this._expectedTime += this._tickIntervalMs;
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
    this._ensureDeviceCache();
    const compensations = this._cachedDeviceCompensations;
    if (!compensations || compensations.size === 0) return;

    const maxComp = this._maxCompensation;

    for (const [deviceId, compensation] of compensations) {
      const relativeDelay = maxComp - compensation;

      if (relativeDelay <= 1) {
        // Send immediately (within 1ms tolerance)
        this._sendClockToDevice(deviceId);
      } else {
        // Delay this device so it receives clock at the same musical time
        const tid = setTimeout(() => {
          this._pendingTimeouts.delete(tid);
          this._sendClockToDevice(deviceId);
        }, relativeDelay);
        this._pendingTimeouts.add(tid);
      }
    }
  }

  /**
   * Send a transport message (start/stop/continue) to all enabled devices
   * with per-device relative latency compensation.
   * @param {string} type - 'start', 'stop', or 'continue'
   */
  _sendTransportToAll(type) {
    this._ensureDeviceCache();
    const compensations = this._cachedDeviceCompensations;
    if (!compensations || compensations.size === 0) return;

    const maxComp = this._maxCompensation;

    for (const [deviceId, compensation] of compensations) {
      const relativeDelay = maxComp - compensation;

      if (relativeDelay <= 1) {
        this._sendTransportToDevice(deviceId, type);
      } else {
        const tid = setTimeout(() => {
          this._pendingTimeouts.delete(tid);
          this._sendTransportToDevice(deviceId, type);
        }, relativeDelay);
        this._pendingTimeouts.add(tid);
      }
    }
  }

  /**
   * Send a single clock tick to a device.
   * @param {string} deviceId
   */
  _sendClockToDevice(deviceId) {
    try {
      this.app.deviceManager.sendMessage(deviceId, 'clock', {});
    } catch (err) {
      this.app.logger.debug(`Failed to send clock to ${deviceId}: ${err.message}`);
    }
  }

  /**
   * Send a transport message to a device.
   * @param {string} deviceId
   * @param {string} type - 'start', 'stop', or 'continue'
   */
  _sendTransportToDevice(deviceId, type) {
    try {
      this.app.deviceManager.sendMessage(deviceId, type, {});
    } catch (err) {
      this.app.logger.debug(`Failed to send ${type} to ${deviceId}: ${err.message}`);
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
    this._compensationCache.clear();
  }

  /**
   * Build and cache the device list and compensation map if not already cached.
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

    this._cachedTargetDevices = devices;
    this._cachedDeviceCompensations = compensations;
    this._maxCompensation = maxComp;
  }

  /**
   * Resolve the list of output device IDs that should receive clock.
   * @returns {string[]}
   */
  _resolveClockTargetDevices() {
    const deviceManager = this.app.deviceManager;
    if (!deviceManager) return [];

    // Get all connected output devices
    const allOutputs = Array.from(deviceManager.outputs?.keys() || []);

    // Also include BLE, network, serial devices
    const bleDevices = this.app.bluetoothManager
      ? this.app.bluetoothManager.getPairedDevices().filter(d => d.connected).map(d => d.address || d.name)
      : [];
    const networkDevices = this.app.networkManager
      ? this.app.networkManager.getConnectedDevices().map(d => d.ip || d.name)
      : [];
    const serialDevices = this.app.serialMidiManager
      ? this.app.serialMidiManager.getConnectedPorts().map(p => p.path || p.name)
      : [];

    const allDevices = [...allOutputs, ...bleDevices, ...networkDevices, ...serialDevices];

    // Filter by per-device clock enable setting
    return allDevices.filter(id => this.isDeviceClockEnabled(id));
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
    if (this.app.database) {
      try {
        // Try channels 0-15 to find the max sync_delay configured for this device
        for (let ch = 0; ch < 16; ch++) {
          const settings = this.app.database.getInstrumentSettings(deviceId, ch);
          if (settings && settings.sync_delay != null) {
            if (settings.sync_delay > compensation) {
              compensation = settings.sync_delay;
            }
          }
        }
      } catch (_e) { /* device may not have instrument settings configured */ }
    }

    // Add measured hardware latency
    if (this.app.latencyCompensator) {
      const hwLatency = this.app.latencyCompensator.getLatency(deviceId);
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
    this._compensationCache.clear();
    this._deviceClockEnabled.clear();
    this._cachedTargetDevices = null;
    this._cachedDeviceCompensations = null;
    if (this._onSettingsChanged) {
      this.app.eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
    }
    if (this._onDeviceChanged) {
      this.app.eventBus?.off('device_connected', this._onDeviceChanged);
      this.app.eventBus?.off('device_disconnected', this._onDeviceChanged);
    }
  }
}

export default MidiClockGenerator;
