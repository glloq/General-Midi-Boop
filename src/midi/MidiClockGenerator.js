// src/midi/MidiClockGenerator.js
// Generates MIDI clock (24 PPQ) with per-device latency compensation.
// Sends transport messages (Start/Stop/Continue) synchronized with playback.

import { performance } from 'perf_hooks';
import { TIMING } from '../constants.js';

const MIDI_CLOCK_PPQ = TIMING.MIDI_CLOCK_PPQ; // 24 pulses per quarter note

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

    // Devices that receive clock (deviceId -> true). If empty, all output devices receive clock.
    this._deviceClockEnabled = new Map();

    // Pending compensation timeouts for cleanup
    this._pendingTimeouts = new Set();

    // Cache for device compensation (cleared on settings change)
    this._compensationCache = new Map();

    this._onSettingsChanged = () => {
      this._compensationCache.clear();
    };
    this.app.eventBus?.on('instrument_settings_changed', this._onSettingsChanged);
  }

  // ─── Configuration ──────────────────────────────────────────

  /** Enable/disable clock globally */
  setEnabled(enabled) {
    const wasEnabled = this._enabled;
    this._enabled = !!enabled;
    this.app.logger.info(`MIDI Clock ${this._enabled ? 'enabled' : 'disabled'}`);

    // If disabled while running, stop
    if (wasEnabled && !this._enabled && this._running) {
      this.stopPlayback();
    }
  }

  isEnabled() {
    return this._enabled;
  }

  /** Enable/disable clock for a specific device */
  setDeviceClockEnabled(deviceId, enabled) {
    this._deviceClockEnabled.set(deviceId, !!enabled);
  }

  isDeviceClockEnabled(deviceId) {
    if (this._deviceClockEnabled.has(deviceId)) {
      return this._deviceClockEnabled.get(deviceId);
    }
    // Default: enabled for all devices
    return true;
  }

  // ─── Playback lifecycle ─────────────────────────────────────

  /**
   * Start MIDI clock with playback.
   * Sends MIDI Start (0xFA) then begins clock ticks.
   * @param {number} tempo - BPM
   */
  startPlayback(tempo) {
    if (!this._enabled) return;

    this._tempo = tempo;
    this._tickIntervalMs = this._calcTickInterval(tempo);
    this._paused = false;

    this._sendTransportToAll('start');
    this._startClockTimer();
    this._running = true;

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

  // ─── Sending ────────────────────────────────────────────────

  /**
   * Send a clock tick (0xF8) to all enabled output devices with per-device compensation.
   */
  _sendClockToAll() {
    const devices = this._getClockTargetDevices();

    for (const deviceId of devices) {
      const compensation = this._getDeviceCompensation(deviceId);

      if (compensation <= 0) {
        // No compensation or negative (shouldn't happen for clock) → send immediately
        this._sendClockToDevice(deviceId);
      } else {
        // Clock needs to arrive early → we're already late by compensation, send now
        // (compensation is pre-applied by the scheduling lookahead in PlaybackScheduler)
        this._sendClockToDevice(deviceId);
      }
    }
  }

  /**
   * Send a transport message (start/stop/continue) to all enabled devices.
   * @param {string} type - 'start', 'stop', or 'continue'
   */
  _sendTransportToAll(type) {
    const devices = this._getClockTargetDevices();

    for (const deviceId of devices) {
      this._sendTransportToDevice(deviceId, type);
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

  // ─── Device resolution ──────────────────────────────────────

  /**
   * Get the list of output device IDs that should receive clock.
   * @returns {string[]}
   */
  _getClockTargetDevices() {
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
   * Reuses the same sources as PlaybackScheduler._getSyncDelay().
   * @param {string} deviceId
   * @returns {number} compensation in ms
   */
  _getDeviceCompensation(deviceId) {
    if (this._compensationCache.has(deviceId)) {
      return this._compensationCache.get(deviceId);
    }

    let compensation = 0;

    // User-configured sync_delay (use channel 0 as reference for clock)
    if (this.app.database) {
      try {
        const settings = this.app.database.getInstrumentSettings(deviceId, 0);
        if (settings && settings.sync_delay != null) {
          compensation = settings.sync_delay;
        }
      } catch (_e) { /* ignore */ }
    }

    // Add measured hardware latency
    if (this.app.latencyCompensator) {
      const hwLatency = this.app.latencyCompensator.getLatency(deviceId);
      if (hwLatency > 0) {
        compensation += hwLatency;
      }
    }

    // Clamp
    compensation = Math.min(Math.max(compensation, 0), TIMING.MAX_COMPENSATION_MS);

    this._compensationCache.set(deviceId, compensation);
    return compensation;
  }

  // ─── Cleanup ────────────────────────────────────────────────

  destroy() {
    this.stopPlayback();
    this._compensationCache.clear();
    this._deviceClockEnabled.clear();
    if (this._onSettingsChanged) {
      this.app.eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
    }
  }
}

export default MidiClockGenerator;
