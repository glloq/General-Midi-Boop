/**
 * @file src/lighting/instrument/InstrumentLightManager.js
 * @description Generic CC-based lighting control for instrument-side
 * LEDs. Owns one {@link InstrumentLightController} per lit instrument,
 * persists the 5-CC state per `(device_id, channel)` and exposes the API
 * surface consumed by the Lighting modal "Par instrument" tab.
 *
 * Independent of the Raspberry-side {@link LightingManager}; no native
 * deps. Sends only CC 110-114 — does not parse SysEx, does not mirror
 * played notes, does not touch the MIDI router hot path.
 */
import InstrumentLightController from './InstrumentLightController.js';
import * as CC from './InstrumentLightCC.js';

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

    this._onReload = () => this.reload();
    this.initialize();
  }

  initialize() {
    try {
      this.eventBus?.on('instrument_settings_changed', this._onReload);
      this.reload();
      this.logger?.info?.(
        `InstrumentLightManager initialized: ${this.controllers.size} state(s) loaded`
      );
    } catch (error) {
      this.logger?.warn?.(`InstrumentLightManager init partial: ${error.message}`);
    }
  }

  _key(deviceId, channel) { return `${deviceId}_${channel | 0}`; }

  _isMasterEnabled(deviceId, channel) {
    try {
      const s = this.database.getInstrumentSettings(deviceId, channel);
      return !!(s && s.lighting_enabled);
    } catch { return false; }
  }

  _controllerFor(deviceId, channel, row) {
    const key = this._key(deviceId, channel);
    let ctrl = this.controllers.get(key);
    if (!ctrl) {
      ctrl = new InstrumentLightController({
        deviceId,
        channel: channel | 0,
        deviceManager: this.deviceManager,
        logger: this.logger,
        state: row,
        supportedMask: row?.supported_mask
      });
      this.controllers.set(key, ctrl);
    } else if (row) {
      ctrl.state = CC.normalizeState(row);
      if (row.supported_mask !== undefined) {
        ctrl.supportedMask = (row.supported_mask | 0) & CC.MASK_ALL;
      }
    }
    return ctrl;
  }

  /** Refresh every controller's state from the database. */
  reload() {
    let rows = [];
    try {
      rows = this.database.getAllInstrumentLightStates() || [];
    } catch (e) {
      this.logger?.warn?.(`InstrumentLight reload failed: ${e.message}`);
      return;
    }
    for (const r of rows) this._controllerFor(r.device_id, r.channel, r);
  }

  // ---- API surface --------------------------------------------------------

  /** Read the persisted state (+ master enable flag) for one instrument. */
  getState(deviceId, channel = 0) {
    const stored = this.database.getInstrumentLightState(deviceId, channel | 0);
    const state = CC.normalizeState(stored || CC.defaultState());
    const supported_mask = (stored?.supported_mask | 0) & CC.MASK_ALL;
    return {
      ...state,
      supported_mask,
      master_enabled: this._isMasterEnabled(deviceId, channel)
    };
  }

  /** Every persisted state, used by the Lighting modal "Par instrument" tab. */
  listStates() {
    const rows = this.database.getAllInstrumentLightStates() || [];
    return rows.map((r) => ({
      device_id: r.device_id,
      channel: r.channel,
      brightness: r.brightness,
      effect: r.effect,
      hue: r.hue,
      speed: r.speed,
      intensity: r.intensity,
      supported_mask: (r.supported_mask | 0) & CC.MASK_ALL,
      master_enabled: this._isMasterEnabled(r.device_id, r.channel)
    }));
  }

  /**
   * Merge a partial state (CC values only) and emit the resulting CC
   * diffs. `supported_mask` is intentionally **dropped** from the patch:
   * the catalogue of supported CCs is edited exclusively in the
   * instrument settings modal via {@link setSupported}.
   */
  setState(deviceId, channel, partial) {
    const ctrl = this._controllerFor(deviceId, channel);
    const patch = { ...(partial || {}) };
    delete patch.supported_mask;
    const next = CC.normalizeState({ ...ctrl.state, ...patch });

    this.database.saveInstrumentLightState(deviceId, channel | 0, {
      ...next,
      supported_mask: ctrl.supportedMask
    });

    if (this._isMasterEnabled(deviceId, channel)) {
      ctrl.apply(next);
    } else {
      ctrl.state = next;
    }
    return {
      ...next,
      supported_mask: ctrl.supportedMask,
      master_enabled: this._isMasterEnabled(deviceId, channel)
    };
  }

  /**
   * Edit the catalogue of supported CCs (instrument-settings-only path).
   * Pushes the current value of any newly-supported CC and persists the
   * full row so future restarts honour the new mask.
   */
  setSupported(deviceId, channel, mask) {
    const ctrl = this._controllerFor(deviceId, channel);
    const newMask = (mask | 0) & CC.MASK_ALL;
    if (this._isMasterEnabled(deviceId, channel)) {
      ctrl.setSupportedMask(newMask);
    } else {
      ctrl.supportedMask = newMask;
    }
    this.database.saveInstrumentLightState(deviceId, channel | 0, {
      ...ctrl.state,
      supported_mask: newMask
    });
    return {
      ...ctrl.state,
      supported_mask: newMask,
      master_enabled: this._isMasterEnabled(deviceId, channel)
    };
  }

  /** Briefly drive the LEDs to a known visible setting then restore. */
  test(deviceId, channel = 0) {
    if (!this._isMasterEnabled(deviceId, channel)) return false;
    const ctrl = this._controllerFor(deviceId, channel);
    const saved = { ...ctrl.state };
    ctrl.apply({ brightness: 127, effect: 0, hue: 64, intensity: 127, speed: 64 });
    setTimeout(() => ctrl.apply(saved), 800);
    return true;
  }

  /** Master off — sends CC 110 = 0 and persists. */
  allOff(deviceId, channel = 0) {
    const ctrl = this._controllerFor(deviceId, channel);
    ctrl.off();
    this.database.saveInstrumentLightState(deviceId, channel | 0, ctrl.state);
    return true;
  }

  async shutdown() {
    this.eventBus?.removeListener?.('instrument_settings_changed', this._onReload);
    this.controllers.clear();
  }
}

export default InstrumentLightManager;
