/**
 * @file src/lighting/instrument/InstrumentLightManager.js
 * @description Dedicated subsystem (independent of the Raspberry-side
 * LightingManager) that drives LEDs physically on MIDI instruments and
 * managed by the instrument's own microcontroller.
 *
 * It owns one {@link InstrumentLightController} per lit instrument,
 * mirrors every played note onto the instrument's LEDs via a best-effort
 * hook in {@link DeviceManager#sendMessage} (covers both file playback
 * and live routing), and exposes the API surface used by the Lighting
 * modal "Par instrument" tab and the instrument settings modal.
 */
import InstrumentLightController from './InstrumentLightController.js';
import * as P from './InstrumentLightProtocol.js';

class InstrumentLightManager {
  /**
   * @param {Object} deps - service-container facade
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.database = deps.database;
    this.eventBus = deps.eventBus;
    this.deviceManager = deps.deviceManager;
    Object.defineProperty(this, 'wsServer', {
      get: () => deps.wsServer,
      configurable: true
    });

    /** @type {Map<string, InstrumentLightController>} */
    this.controllers = new Map();
    // Reentrancy depth: every send our controllers make flows back
    // through DeviceManager.sendMessage → our observer. While depth > 0
    // the observer is a no-op so a lighting note never re-triggers itself.
    this._depth = 0;

    this._sink = (id, type, data) => this._guarded(
      () => this.deviceManager?.sendMessage(id, type, data)
    );
    this._onNote = (name, type, data) => this.onInstrumentNote(name, type, data);
    this._onReload = () => this.reload();

    this.initialize();
  }

  initialize() {
    try {
      if (this.deviceManager) {
        this.deviceManager.instrumentLightObserver = this._onNote;
      }
      this.eventBus?.on('instrument_settings_changed', this._onReload);
      this.eventBus?.on('instrument_light_capabilities', this._onReload);
      this.reload();
      this.logger.info(
        `InstrumentLightManager initialized: ${this.controllers.size} lit instrument(s)`
      );
    } catch (error) {
      this.logger.warn(`InstrumentLightManager init partial: ${error.message}`);
    }
  }

  _guarded(fn) {
    this._depth++;
    try { return fn(); } finally { this._depth--; }
  }

  _key(deviceId, channel) { return `${deviceId}_${channel | 0}`; }

  _isMasterEnabled(deviceId, channel) {
    try {
      const s = this.database.getInstrumentSettings(deviceId, channel);
      return !!(s && s.lighting_enabled);
    } catch { return false; }
  }

  /** Rebuild every controller from the database. */
  reload() {
    let rows = [];
    try {
      rows = this.database.getAllInstrumentLights() || [];
    } catch (e) {
      this.logger.warn(`InstrumentLight reload failed: ${e.message}`);
      return;
    }

    const seen = new Set();
    for (const row of rows) {
      const key = this._key(row.device_id, row.channel);
      seen.add(key);
      let ctrl = this.controllers.get(key);
      if (!ctrl) {
        ctrl = new InstrumentLightController({
          deviceId: row.device_id,
          channel: row.channel,
          deviceManager: this.deviceManager,
          sink: this._sink,
          logger: this.logger,
          capabilities: row,
          config: row
        });
        this.controllers.set(key, ctrl);
      } else {
        ctrl.applyCapabilities(row);
        ctrl.applyConfig(row);
      }

      const shouldEnable = this._isMasterEnabled(row.device_id, row.channel);
      if (shouldEnable && !ctrl.enabled) ctrl.enable();
      else if (!shouldEnable && ctrl.enabled) ctrl.disable();
    }

    // Drop controllers whose row disappeared.
    for (const [key, ctrl] of this.controllers) {
      if (!seen.has(key)) {
        ctrl.disable();
        this.controllers.delete(key);
      }
    }
  }

  /**
   * DeviceManager hook. Re-entrancy guarded: the controller's own
   * lighting sends flow back through DeviceManager.sendMessage.
   * @param {string} deviceName
   * @param {string} type
   * @param {Object} data
   */
  onInstrumentNote(deviceName, type, data) {
    if (this._depth > 0) return;
    const channel = (data && data.channel != null) ? data.channel : 0;
    const ctrl = this.controllers.get(this._key(deviceName, channel));
    if (!ctrl || !ctrl.enabled) return;
    this._guarded(() => ctrl.onInstrumentNote(type, data));
  }

  // ---- API surface (consumed by InstrumentLightCommands) ------------------

  /** Capabilities + control config for one instrument (or null). */
  getInstrument(deviceId, channel = 0) {
    const row = this.database.getInstrumentLight(deviceId, channel);
    if (!row) return null;
    return { ...row, master_enabled: this._isMasterEnabled(deviceId, channel) };
  }

  /** Every instrument that has a light config row. */
  listLitInstruments() {
    return (this.database.getAllInstrumentLights() || []).map(r => ({
      ...r,
      master_enabled: this._isMasterEnabled(r.device_id, r.channel)
    }));
  }

  /** Save manually-entered capabilities, then reload. */
  setCapabilities(deviceId, channel, capabilities) {
    const patch = { ...capabilities };
    if (patch.light_messages_bitmask === undefined || patch.light_messages_bitmask === null) {
      patch.light_messages_bitmask = P.deriveMessagesBitmask(patch);
    }
    this.database.saveInstrumentLightCapabilities(
      deviceId, channel | 0, patch, 'manual'
    );
    this.reload();
    return this.getInstrument(deviceId, channel | 0);
  }

  /** Save control configuration, then reload + push live changes. */
  setConfig(deviceId, channel, config) {
    this.database.saveInstrumentLightConfig(deviceId, channel | 0, config);
    this.reload();
    const ctrl = this.controllers.get(this._key(deviceId, channel | 0));
    if (ctrl && ctrl.enabled) {
      ctrl.pushBrightness();
      if (config.light_active_effect !== undefined) {
        ctrl.setEffect(config.light_active_effect, config.light_effect_speed ?? 64);
      }
    }
    return this.getInstrument(deviceId, channel | 0);
  }

  /** Trigger a fresh SysEx Block 8 capabilities request. */
  requestSysexCapabilities(deviceId, channel = 0) {
    return this.deviceManager.requestLightingCapabilities(deviceId, channel);
  }

  /** Flash the instrument's LEDs so the user can confirm wiring. */
  test(deviceId, channel = 0) {
    const ctrl = this.controllers.get(this._key(deviceId, channel | 0));
    if (!ctrl) return false;
    const wasEnabled = ctrl.enabled;
    ctrl.enabled = true;
    const lc = ctrl.lightChannel;
    if (ctrl._supports(P.TRANSPORT.SYSEX)) {
      ctrl._sendSysex(P.sysexSetAll(lc, 255, 255, 255));
      setTimeout(() => {
        ctrl._sendSysex(P.sysexClear(lc));
        ctrl.enabled = wasEnabled;
      }, 600);
    } else if (ctrl._supports(P.TRANSPORT.NOTE)) {
      const count = ctrl.caps.light_led_count || 12;
      for (let i = 0; i < count; i++) {
        const m = P.noteColorMessage(lc, (ctrl.caps.light_note_base ?? 0) + i, 127);
        ctrl._send(m.type, m.data);
      }
      setTimeout(() => { ctrl.allOff(); ctrl.enabled = wasEnabled; }, 600);
    } else {
      ctrl.enabled = wasEnabled;
    }
    return true;
  }

  allOff(deviceId, channel = 0) {
    const ctrl = this.controllers.get(this._key(deviceId, channel | 0));
    if (ctrl) { ctrl.allOff(); return true; }
    return false;
  }

  async shutdown() {
    for (const ctrl of this.controllers.values()) {
      try { ctrl.disable(); } catch { /* best-effort */ }
    }
    this.controllers.clear();
    if (this.deviceManager && this.deviceManager.instrumentLightObserver === this._onNote) {
      this.deviceManager.instrumentLightObserver = null;
    }
    this.eventBus?.removeListener?.('instrument_settings_changed', this._onReload);
    this.eventBus?.removeListener?.('instrument_light_capabilities', this._onReload);
  }
}

export default InstrumentLightManager;
