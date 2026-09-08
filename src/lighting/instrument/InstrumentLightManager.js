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

  _key(deviceId, channel) {
    return `${deviceId}_${channel | 0}`;
  }

  _isMasterEnabled(deviceId, channel) {
    try {
      const s = this.database.getInstrumentSettings(deviceId, channel);
      return !!(s && s.lighting_enabled);
    } catch {
      return false;
    }
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
        supportedMask: row?.supported_mask,
        brightnessMode: row?.brightness_mode,
        supportedEffects: row?.supported_effects
      });
      this.controllers.set(key, ctrl);
    } else if (row) {
      ctrl.state = CC.normalizeState(row);
      if (row.supported_mask !== undefined) {
        ctrl.supportedMask = (row.supported_mask | 0) & CC.MASK_ALL;
      }
      if (row.brightness_mode !== undefined) {
        ctrl.brightnessMode =
          row.brightness_mode === CC.BRIGHTNESS_MODE.ON_OFF
            ? CC.BRIGHTNESS_MODE.ON_OFF
            : CC.BRIGHTNESS_MODE.DIMMABLE;
      }
      if (row.supported_effects !== undefined && row.supported_effects !== null) {
        ctrl.supportedEffects = (row.supported_effects | 0) & CC.EFFECTS_ALL;
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

  _capabilityFields(row) {
    return {
      supported_mask: (row?.supported_mask | 0) & CC.MASK_ALL,
      brightness_mode:
        row && row.brightness_mode !== undefined && row.brightness_mode !== null
          ? row.brightness_mode === CC.BRIGHTNESS_MODE.ON_OFF
            ? CC.BRIGHTNESS_MODE.ON_OFF
            : CC.BRIGHTNESS_MODE.DIMMABLE
          : CC.BRIGHTNESS_MODE.DIMMABLE,
      supported_effects:
        row && row.supported_effects !== undefined && row.supported_effects !== null
          ? (row.supported_effects | 0) & CC.EFFECTS_ALL
          : CC.EFFECTS_ALL
    };
  }

  /** Read the persisted state (+ master enable flag) for one instrument. */
  getState(deviceId, channel = 0) {
    const stored = this.database.getInstrumentLightState(deviceId, channel | 0);
    const state = CC.normalizeState(stored || CC.defaultState());
    return {
      ...state,
      ...this._capabilityFields(stored),
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
      ...this._capabilityFields(r),
      master_enabled: this._isMasterEnabled(r.device_id, r.channel)
    }));
  }

  /**
   * Merge a partial state (CC values only) and emit the resulting CC
   * diffs. `supported_mask`, `brightness_mode` and `supported_effects`
   * are intentionally **dropped** from the patch: capability fields are
   * edited exclusively in the instrument settings modal via
   * {@link setSupported}.
   */
  setState(deviceId, channel, partial) {
    const ctrl = this._controllerFor(deviceId, channel);
    const patch = { ...(partial || {}) };
    delete patch.supported_mask;
    delete patch.brightness_mode;
    delete patch.supported_effects;
    const next = CC.normalizeState({ ...ctrl.state, ...patch });

    if (this._isMasterEnabled(deviceId, channel)) {
      ctrl.apply(next);
    } else {
      ctrl.state = next;
    }
    this.database.saveInstrumentLightState(deviceId, channel | 0, {
      ...ctrl.state,
      supported_mask: ctrl.supportedMask,
      brightness_mode: ctrl.brightnessMode,
      supported_effects: ctrl.supportedEffects
    });
    return {
      ...ctrl.state,
      supported_mask: ctrl.supportedMask,
      brightness_mode: ctrl.brightnessMode,
      supported_effects: ctrl.supportedEffects,
      master_enabled: this._isMasterEnabled(deviceId, channel)
    };
  }

  /**
   * Edit the capability fields (instrument-settings-only path). Each
   * field is optional in the patch — only the ones present are touched.
   * @param {string} deviceId
   * @param {number} channel
   * @param {{supported_mask?:number, brightness_mode?:number, supported_effects?:number}} patch
   */
  setSupported(deviceId, channel, patch = {}) {
    const ctrl = this._controllerFor(deviceId, channel);
    const enabled = this._isMasterEnabled(deviceId, channel);

    if (patch.supported_mask !== undefined) {
      const newMask = (patch.supported_mask | 0) & CC.MASK_ALL;
      if (enabled) ctrl.setSupportedMask(newMask);
      else ctrl.supportedMask = newMask;
    }
    const metaPatch = {};
    if (patch.brightness_mode !== undefined) metaPatch.brightnessMode = patch.brightness_mode;
    if (patch.supported_effects !== undefined) metaPatch.supportedEffects = patch.supported_effects;
    if (Object.keys(metaPatch).length > 0) {
      if (enabled) ctrl.setMeta(metaPatch);
      else {
        if (metaPatch.brightnessMode !== undefined) {
          ctrl.brightnessMode =
            metaPatch.brightnessMode === CC.BRIGHTNESS_MODE.ON_OFF
              ? CC.BRIGHTNESS_MODE.ON_OFF
              : CC.BRIGHTNESS_MODE.DIMMABLE;
        }
        if (metaPatch.supportedEffects !== undefined) {
          ctrl.supportedEffects = (metaPatch.supportedEffects | 0) & CC.EFFECTS_ALL;
        }
      }
    }

    this.database.saveInstrumentLightState(deviceId, channel | 0, {
      ...ctrl.state,
      supported_mask: ctrl.supportedMask,
      brightness_mode: ctrl.brightnessMode,
      supported_effects: ctrl.supportedEffects
    });
    return {
      ...ctrl.state,
      supported_mask: ctrl.supportedMask,
      brightness_mode: ctrl.brightnessMode,
      supported_effects: ctrl.supportedEffects,
      master_enabled: enabled
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
    this.database.saveInstrumentLightState(deviceId, channel | 0, {
      ...ctrl.state,
      supported_mask: ctrl.supportedMask,
      brightness_mode: ctrl.brightnessMode,
      supported_effects: ctrl.supportedEffects
    });
    return true;
  }

  async shutdown() {
    // EventBus (src/core/EventBus.js) exposes `off()`, NOT the Node
    // EventEmitter `removeListener()`. The optional call `?.removeListener?.()`
    // made this fail SILENTLY — no throw, no log — so the
    // `instrument_settings_changed` listener registered in initialize() was
    // never released: every Application.restart() cycle leaked one more, until
    // EventBus started warning about a listener leak (audit L02 F-30c,
    // 4th site of the class reported by L01 F-27).
    this.eventBus?.off?.('instrument_settings_changed', this._onReload);
    this.controllers.clear();
  }
}

export default InstrumentLightManager;
