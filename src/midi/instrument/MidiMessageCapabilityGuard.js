/**
 * @file src/midi/instrument/MidiMessageCapabilityGuard.js
 * @description Central outbound MIDI capability gate. Installed once on the
 * DeviceManager instance so file playback, live routing, direct API sends,
 * calibration and transport messages all share the exact same policy.
 *
 * Policy:
 *   - explicit false => suppress the semantic message
 *   - true / absent / unknown => allow (backward compatible)
 *   - Note Off / velocity-zero Note On and Channel Mode panic CCs always pass
 *     so a bad/stale descriptor cannot create stuck notes.
 *   - SysEx and unknown message families are never gated here; GMB discovery
 *     and future protocol extensions must remain reachable.
 */

import { DEVICE_MSG_TYPES, SEND_STATUS } from '../../core/constants.js';
import { allowsMidiMessage } from './MidiMessageCapabilities.js';

const CAPABILITY_BY_DEVICE_TYPE = Object.freeze({
  [DEVICE_MSG_TYPES.NOTE_ON]: 'note_on',
  [DEVICE_MSG_TYPES.NOTE_OFF]: 'note_off',
  [DEVICE_MSG_TYPES.CC]: 'control_change',
  [DEVICE_MSG_TYPES.PROGRAM]: 'program_change',
  [DEVICE_MSG_TYPES.PITCH_BEND]: 'pitch_bend',
  [DEVICE_MSG_TYPES.CHANNEL_AFTERTOUCH]: 'channel_aftertouch',
  [DEVICE_MSG_TYPES.POLY_AFTERTOUCH]: 'poly_aftertouch',
  clock: 'clock',
  start: 'start',
  continue: 'continue',
  stop: 'stop',
  reset: 'system_reset'
});

// Accept the aliases that can appear at API / transport boundaries even though
// DeviceManager normally receives DEVICE_MSG_TYPES values.
const TYPE_ALIASES = Object.freeze({
  noteOn: DEVICE_MSG_TYPES.NOTE_ON,
  noteOff: DEVICE_MSG_TYPES.NOTE_OFF,
  controller: DEVICE_MSG_TYPES.CC,
  programChange: DEVICE_MSG_TYPES.PROGRAM,
  pitchBend: DEVICE_MSG_TYPES.PITCH_BEND,
  channelAftertouch: DEVICE_MSG_TYPES.CHANNEL_AFTERTOUCH,
  noteAftertouch: DEVICE_MSG_TYPES.POLY_AFTERTOUCH,
  polyAftertouch: DEVICE_MSG_TYPES.POLY_AFTERTOUCH
});

export class MidiMessageCapabilityGuard {
  /**
   * @param {Object} deps
   * @param {Object} deps.instrumentRepository
   * @param {Object} [deps.eventBus]
   * @param {Object} [deps.logger]
   */
  constructor({ instrumentRepository, eventBus = null, logger = null } = {}) {
    this._repo = instrumentRepository ?? null;
    this._eventBus = eventBus;
    this._logger = logger ?? { debug() {}, warn() {} };
    /** @type {Map<string, Object|null>} */
    this._channelCache = new Map();
    /** @type {Map<string, Object|null>} */
    this._deviceCache = new Map();
    this._installedOn = null;
    this._originalSendMessageEx = null;

    this._onCapabilitiesChanged = (payload = {}) => {
      if (payload.deviceId) this.invalidate(payload.deviceId);
      else this.invalidate();
    };
    this._onSettingsChanged = (payload = {}) => {
      const deviceId = payload.deviceId ?? payload.device_id ?? null;
      if (deviceId) this.invalidate(deviceId);
      else this.invalidate();
    };
    this._onDeviceDisconnected = (payload = {}) => {
      const deviceId = payload.deviceId ?? payload.device_id ?? payload.id ?? payload.name ?? null;
      if (deviceId) this.invalidate(deviceId);
    };

    eventBus?.on?.('instruments_configured', this._onCapabilitiesChanged);
    eventBus?.on?.('instrument_settings_changed', this._onSettingsChanged);
    eventBus?.on?.('device_disconnected', this._onDeviceDisconnected);
  }

  /**
   * Install the guard at the single outbound DeviceManager boundary.
   * Idempotent: a manager can only be wrapped once.
   *
   * @param {Object} deviceManager
   * @returns {boolean} true when installed by this call
   */
  install(deviceManager) {
    if (!deviceManager || typeof deviceManager.sendMessageEx !== 'function') return false;
    if (deviceManager.__gmbMidiMessageCapabilityGuard) return false;

    const original = deviceManager.sendMessageEx;
    const guard = this;
    deviceManager.sendMessageEx = function capabilityAwareSendMessageEx(deviceName, type, data) {
      if (!guard.allows(deviceName, type, data)) {
        guard._logger.debug?.(
          `Suppressed unsupported MIDI message ${type} for ${deviceName}:${data?.channel ?? '*'} `
        );
        return { status: SEND_STATUS.UNSUPPORTED };
      }
      return original.call(this, deviceName, type, data);
    };

    Object.defineProperty(deviceManager, '__gmbMidiMessageCapabilityGuard', {
      value: this,
      configurable: true,
      enumerable: false,
      writable: false
    });
    this._installedOn = deviceManager;
    this._originalSendMessageEx = original;
    return true;
  }

  /**
   * Restore the wrapped manager. Primarily used by tests/shutdown-safe tooling.
   */
  uninstall() {
    const dm = this._installedOn;
    if (!dm || !this._originalSendMessageEx) return;
    dm.sendMessageEx = this._originalSendMessageEx;
    try {
      delete dm.__gmbMidiMessageCapabilityGuard;
    } catch {
      // Non-critical cleanup only.
    }
    this._installedOn = null;
    this._originalSendMessageEx = null;
  }

  /**
   * Decide whether one outbound message is safe/useful for the destination.
   * Unknown capability data deliberately remains permissive.
   *
   * @param {string} deviceId
   * @param {string} type
   * @param {Object} [data]
   * @returns {boolean}
   */
  allows(deviceId, type, data = {}) {
    const canonicalType = TYPE_ALIASES[type] ?? type;

    // Releases are safety traffic. Never let a stale/incorrect descriptor turn
    // a normal note lifecycle into a stuck note.
    if (canonicalType === DEVICE_MSG_TYPES.NOTE_OFF) return true;
    if (canonicalType === DEVICE_MSG_TYPES.NOTE_ON && (data?.velocity ?? 0) === 0) return true;

    // Channel Mode controllers are the panic/safety family. Existing GMB CC
    // enforcement also bypasses them; keep that invariant at the final gate.
    if (
      canonicalType === DEVICE_MSG_TYPES.CC &&
      Number.isInteger(data?.controller) &&
      data.controller >= 120 &&
      data.controller <= 127
    ) {
      return true;
    }

    const capability = CAPABILITY_BY_DEVICE_TYPE[canonicalType];
    if (!capability) return true; // SysEx / SPP / future message families.

    const channel = Number.isInteger(data?.channel) ? data.channel : null;
    if (channel !== null) {
      const support = this._supportForChannel(deviceId, channel);
      // Bank Select is protocol state for a Program Change. If the firmware
      // explicitly supports program changes, allow CC0/32 even when it declares
      // no other Control Change semantics.
      if (
        canonicalType === DEVICE_MSG_TYPES.CC &&
        (data?.controller === 0 || data?.controller === 32) &&
        support?.program_change === true
      ) {
        return true;
      }
      return allowsMidiMessage(support, capability);
    }

    // Realtime/system messages are device-wide but descriptors are per channel.
    // Suppress only when every known instrument row explicitly says false.
    // Any true OR unknown channel keeps the send permissive.
    const byChannel = this._supportForDevice(deviceId);
    if (!byChannel || Object.keys(byChannel).length === 0) return true;
    let sawKnown = false;
    for (const support of Object.values(byChannel)) {
      if (!support || typeof support !== 'object') return true; // unknown channel
      const value = support[capability];
      if (value === true || value === undefined) return true;
      if (value === false) sawKnown = true;
    }
    return !sawKnown;
  }

  _supportForChannel(deviceId, channel) {
    const key = `${deviceId}|${channel}`;
    if (this._channelCache.has(key)) return this._channelCache.get(key);
    let support = null;
    try {
      support = this._repo?.getMidiMessageSupport?.(deviceId, channel) ?? null;
    } catch (error) {
      this._logger.warn?.(`MIDI capability lookup failed for ${key}: ${error.message}`);
    }
    this._channelCache.set(key, support);
    return support;
  }

  _supportForDevice(deviceId) {
    if (this._deviceCache.has(deviceId)) return this._deviceCache.get(deviceId);
    let support = null;
    try {
      support = this._repo?.getMidiMessageSupportsForDevice?.(deviceId) ?? null;
    } catch (error) {
      this._logger.warn?.(`MIDI capability lookup failed for ${deviceId}: ${error.message}`);
    }
    this._deviceCache.set(deviceId, support);
    return support;
  }

  /** Clear cached declarations globally or for one device. */
  invalidate(deviceId = null) {
    if (!deviceId) {
      this._channelCache.clear();
      this._deviceCache.clear();
      return;
    }
    this._deviceCache.delete(deviceId);
    const prefix = `${deviceId}|`;
    for (const key of [...this._channelCache.keys()]) {
      if (key.startsWith(prefix)) this._channelCache.delete(key);
    }
  }

  destroy() {
    this.uninstall();
    this._eventBus?.off?.('instruments_configured', this._onCapabilitiesChanged);
    this._eventBus?.off?.('instrument_settings_changed', this._onSettingsChanged);
    this._eventBus?.off?.('device_disconnected', this._onDeviceDisconnected);
    this.invalidate();
  }
}

export default MidiMessageCapabilityGuard;
