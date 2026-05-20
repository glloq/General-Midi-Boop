/**
 * @file src/lighting/instrument/InstrumentLightController.js
 * @description One controller per lit instrument (device + channel).
 * Holds the current 5-CC state in memory and pushes diffs to the
 * instrument's MIDI output through the injected DeviceManager. Pure
 * fan-out — no business logic, no persistence (that lives in
 * {@link InstrumentLightManager}).
 */
import * as CC from './InstrumentLightCC.js';

class InstrumentLightController {
  /**
   * @param {Object} opts
   * @param {string} opts.deviceId
   * @param {number} opts.channel - instrument MIDI channel (0-15)
   * @param {Object} opts.deviceManager
   * @param {Object} [opts.logger]
   * @param {Object} [opts.state] - initial state (defaults to all-off)
   */
  constructor({ deviceId, channel, deviceManager, logger, state }) {
    this.deviceId = deviceId;
    this.channel = channel | 0;
    this.deviceManager = deviceManager;
    this.logger = logger;
    this.state = CC.normalizeState(state);
  }

  _send(msg) {
    try {
      this.deviceManager?.sendMessage(this.deviceId, msg.type, msg.data);
    } catch (e) {
      this.logger?.warn?.(`InstrumentLight CC send failed (${this.deviceId}): ${e.message}`);
    }
  }

  /** Merge `partial` into state and emit only the CCs that changed. */
  apply(partial) {
    const next = CC.normalizeState({ ...this.state, ...partial });
    for (const m of CC.messagesForDiff(this.channel, this.state, next)) this._send(m);
    this.state = next;
  }

  /** Emit every CC for the current state — used on (re)enable and test. */
  pushAll() {
    for (const m of CC.messagesFor(this.channel, this.state)) this._send(m);
  }

  /** Master off (CC 110 = 0). The rest of the state is preserved. */
  off() {
    this.apply({ brightness: 0 });
  }
}

export default InstrumentLightController;
