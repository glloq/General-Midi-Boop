/**
 * @file src/lighting/instrument/InstrumentLightController.js
 * @description One controller per lit instrument (device + channel).
 * Holds the current 5-CC state in memory and emits only the CCs that
 * (a) have changed and (b) are declared supported by the device via the
 * `supportedMask` bitmask. No business logic, no persistence (that lives
 * in {@link InstrumentLightManager}).
 */
import * as CC from './InstrumentLightCC.js';

class InstrumentLightController {
  /**
   * @param {Object} opts
   * @param {string} opts.deviceId
   * @param {number} opts.channel - instrument MIDI channel (0-15)
   * @param {Object} opts.deviceManager
   * @param {Object} [opts.logger]
   * @param {Object} [opts.state]
   * @param {number} [opts.supportedMask=0] - which CC bits the device understands
   */
  constructor({
    deviceId,
    channel,
    deviceManager,
    logger,
    state,
    supportedMask,
    brightnessMode,
    supportedEffects
  }) {
    this.deviceId = deviceId;
    this.channel = channel | 0;
    this.deviceManager = deviceManager;
    this.logger = logger;
    this.state = CC.normalizeState(state);
    this.supportedMask = (supportedMask | 0) & CC.MASK_ALL;
    this.brightnessMode =
      brightnessMode === CC.BRIGHTNESS_MODE.ON_OFF
        ? CC.BRIGHTNESS_MODE.ON_OFF
        : CC.BRIGHTNESS_MODE.DIMMABLE;
    this.supportedEffects =
      supportedEffects === undefined || supportedEffects === null
        ? CC.EFFECTS_ALL
        : (supportedEffects | 0) & CC.EFFECTS_ALL;
  }

  _send(msg) {
    try {
      this.deviceManager?.sendMessage(this.deviceId, msg.type, msg.data);
    } catch (e) {
      this.logger?.warn?.(`InstrumentLight CC send failed (${this.deviceId}): ${e.message}`);
    }
  }

  /**
   * Merge `partial` into state and emit the supported CCs that changed.
   * Brightness is snapped to 0/127 when the firmware is wired on/off.
   */
  apply(partial) {
    const merged = CC.normalizeState({ ...this.state, ...partial });
    merged.brightness = CC.snapBrightness(merged.brightness, this.brightnessMode);
    for (const m of CC.messagesForDiff(this.channel, this.state, merged, this.supportedMask)) {
      this._send(m);
    }
    this.state = merged;
  }

  /** Emit the current value of every supported CC (used on activation). */
  pushAll() {
    this.state.brightness = CC.snapBrightness(this.state.brightness, this.brightnessMode);
    for (const m of CC.messagesFor(this.channel, this.state, this.supportedMask)) {
      this._send(m);
    }
  }

  /**
   * Replace the supported-CC mask, sending the current value of any CC
   * that became newly supported.
   */
  setSupportedMask(mask) {
    const prev = this.supportedMask;
    const next = (mask | 0) & CC.MASK_ALL;
    const newly = next & ~prev;
    this.supportedMask = next;
    if (newly !== 0) {
      this.state.brightness = CC.snapBrightness(this.state.brightness, this.brightnessMode);
      for (const m of CC.messagesFor(this.channel, this.state, newly)) this._send(m);
    }
  }

  /**
   * Replace the extra capability metadata. When `brightnessMode` flips
   * to on/off, the current brightness is re-snapped (and CC110 re-sent
   * if it changed).
   */
  setMeta({ brightnessMode, supportedEffects } = {}) {
    if (brightnessMode !== undefined) {
      const prev = this.brightnessMode;
      this.brightnessMode =
        brightnessMode === CC.BRIGHTNESS_MODE.ON_OFF
          ? CC.BRIGHTNESS_MODE.ON_OFF
          : CC.BRIGHTNESS_MODE.DIMMABLE;
      if (prev !== this.brightnessMode) {
        const snapped = CC.snapBrightness(this.state.brightness, this.brightnessMode);
        if (snapped !== this.state.brightness) this.apply({ brightness: snapped });
      }
    }
    if (supportedEffects !== undefined) {
      this.supportedEffects = (supportedEffects | 0) & CC.EFFECTS_ALL;
    }
  }

  /** Master off (CC 110 = 0). The rest of the state is preserved. */
  off() {
    this.apply({ brightness: 0 });
  }
}

export default InstrumentLightController;
