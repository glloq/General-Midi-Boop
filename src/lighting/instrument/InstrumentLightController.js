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
  constructor({ deviceId, channel, deviceManager, logger, state, supportedMask }) {
    this.deviceId = deviceId;
    this.channel = channel | 0;
    this.deviceManager = deviceManager;
    this.logger = logger;
    this.state = CC.normalizeState(state);
    this.supportedMask = (supportedMask | 0) & CC.MASK_ALL;
  }

  _send(msg) {
    try {
      this.deviceManager?.sendMessage(this.deviceId, msg.type, msg.data);
    } catch (e) {
      this.logger?.warn?.(`InstrumentLight CC send failed (${this.deviceId}): ${e.message}`);
    }
  }

  /** Merge `partial` into state and emit the supported CCs that changed. */
  apply(partial) {
    const next = CC.normalizeState({ ...this.state, ...partial });
    for (const m of CC.messagesForDiff(this.channel, this.state, next, this.supportedMask)) {
      this._send(m);
    }
    this.state = next;
  }

  /** Emit the current value of every supported CC (used on activation). */
  pushAll() {
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
      for (const m of CC.messagesFor(this.channel, this.state, newly)) this._send(m);
    }
  }

  /** Master off (CC 110 = 0). The rest of the state is preserved. */
  off() {
    this.apply({ brightness: 0 });
  }
}

export default InstrumentLightController;
