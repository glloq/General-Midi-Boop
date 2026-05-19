/**
 * @file src/lighting/instrument/InstrumentLightController.js
 * @description One controller per lit instrument (deviceId + channel).
 * Translates lighting intent (note played, brightness, effect, guide,
 * all-off) into the highest tier the instrument's capabilities support,
 * then sends the resulting MIDI back to the instrument's own output via
 * the injected DeviceManager. Throttles continuous updates so a slow
 * 31250-baud serial link is never flooded.
 */
import * as P from './InstrumentLightProtocol.js';

class InstrumentLightController {
  /**
   * @param {Object} opts
   * @param {string} opts.deviceId
   * @param {number} opts.channel - instrument MIDI channel (0-15)
   * @param {Object} opts.deviceManager
   * @param {Object} opts.logger
   * @param {Object} opts.capabilities - row fields from InstrumentLightDB
   * @param {Object} opts.config - control fields from InstrumentLightDB
   */
  constructor({ deviceId, channel, deviceManager, logger, capabilities, config, sink }) {
    this.deviceId = deviceId;
    this.channel = channel | 0;
    this.deviceManager = deviceManager;
    // Reentrancy-guarded send provided by the manager; falls back to a
    // direct call when absent (unit tests).
    this.sink = sink || ((id, type, data) => this.deviceManager?.sendMessage(id, type, data));
    this.logger = logger;
    this.caps = capabilities || {};
    this.config = config || {};
    this.enabled = false;

    this._activeNotes = new Set();      // LED notes currently lit (for all-off)
    this._lastSendAt = new Map();       // ledKey -> ts (throttle)
    this._trackColors = this._parseJson(this.config.light_track_colors_json) || {};
  }

  _parseJson(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  }

  applyCapabilities(caps) { this.caps = caps || {}; }
  applyConfig(config) {
    this.config = config || {};
    this._trackColors = this._parseJson(this.config.light_track_colors_json) || {};
  }

  /** Resolved lighting MIDI channel (0-15). */
  get lightChannel() {
    const c = this.caps.light_channel;
    return (c === undefined || c === P.UNSET || c === null) ? this.channel : (c & 0x0F);
  }

  get transports() { return this.caps.light_transports ?? P.TRANSPORT.NOTE; }
  get colorMode() { return this.caps.light_color_mode ?? P.COLOR_MODE.ON_OFF; }
  get isAutonomous() {
    return this.config.light_mode === 'autonomous'
      && (this.transports & P.TRANSPORT.AUTONOMOUS) !== 0;
  }

  _supports(bit) { return (this.transports & bit) !== 0; }

  _send(type, data) {
    try {
      this.sink(this.deviceId, type, data);
    } catch (e) {
      this.logger?.warn?.(`InstrumentLight send failed (${this.deviceId}): ${e.message}`);
    }
  }

  _sendSysex(bytes) { this._send('sysex', bytes); }

  _throttled(key, fn) {
    const min = this.caps.light_min_interval_ms || 0;
    if (min > 0) {
      const now = Date.now();
      const last = this._lastSendAt.get(key) || 0;
      if (now - last < min) return;
      this._lastSendAt.set(key, now);
    }
    fn();
  }

  /** Master brightness 0-255 (from config), used to scale RGB. */
  get _brightness() {
    const b = this.config.light_brightness;
    return (b === undefined || b === null) ? 255 : Math.max(0, Math.min(255, b));
  }

  _ledForNote(note) {
    if ((this.caps.light_addressing ?? P.ADDRESSING.PER_NOTE) === P.ADDRESSING.PER_NOTE) {
      const base = this.caps.light_note_base;
      if (base !== undefined && base !== P.UNSET) {
        return Math.max(0, note - base);
      }
    }
    return note;
  }

  _colorForTrack(trackIndex) {
    if ((this.caps.light_flags & P.CAP_FLAG.PER_TRACK_COLOR)
        && trackIndex !== undefined
        && this._trackColors[trackIndex]) {
      return P.hexToRgb(this._trackColors[trackIndex]);
    }
    return { r: 255, g: 255, b: 255 };
  }

  _scale(v) { return Math.round((v * this._brightness) / 255); }

  /**
   * React to a note played by the instrument.
   * @param {string} type 'noteon' | 'noteoff'
   * @param {Object} data { note, velocity, channel }
   * @param {number} [trackIndex]
   */
  onInstrumentNote(type, data, trackIndex) {
    if (!this.enabled || this.isAutonomous) return;
    const note = data?.note;
    if (note === undefined || note === null) return;

    const isOn = type === 'noteon' && (data.velocity || 0) > 0;
    const led = this._ledForNote(note);
    const lc = this.lightChannel;

    if (!isOn) {
      this._activeNotes.delete(led);
      if (this._supports(P.TRANSPORT.SYSEX) && this.colorMode === P.COLOR_MODE.RGB) {
        this._sendSysex(P.sysexSetLed(lc, led, 0, 0, 0));
      } else if (this._supports(P.TRANSPORT.NOTE)) {
        const m = P.noteColorMessage(lc, led, 0);
        this._send(m.type, m.data);
      }
      return;
    }

    this._activeNotes.add(led);

    if (this._supports(P.TRANSPORT.SYSEX) && this.colorMode === P.COLOR_MODE.RGB) {
      const c = this._colorForTrack(trackIndex);
      this._sendSysex(P.sysexSetLed(lc, led, this._scale(c.r), this._scale(c.g), this._scale(c.b)));
      return;
    }

    if (this._supports(P.TRANSPORT.NOTE)) {
      let velocity;
      switch (this.colorMode) {
        case P.COLOR_MODE.DIMMABLE:
          velocity = Math.max(1, Math.round((this._brightness / 255) * 127));
          break;
        case P.COLOR_MODE.PALETTE:
          velocity = Math.max(1, Math.min(127,
            (this.caps.light_palette_size
              ? (trackIndex ?? 0) % this.caps.light_palette_size : 0) + 1));
          break;
        default: // ON_OFF / FIXED
          velocity = 127;
      }
      const m = P.noteColorMessage(lc, led, velocity);
      this._send(m.type, m.data);
    }
  }

  /** Push the master brightness to the instrument. */
  pushBrightness() {
    if (!this.enabled) return;
    const lc = this.lightChannel;
    const b = this._brightness;
    this._throttled('brightness', () => {
      if (this._supports(P.TRANSPORT.SYSEX)) {
        this._sendSysex(P.sysexBrightness(lc, b));
      } else if (this._supports(P.TRANSPORT.CC)
                 && this.caps.light_cc_brightness !== P.UNSET) {
        const m = P.ccMessage(lc, this.caps.light_cc_brightness, Math.round(b / 2));
        this._send(m.type, m.data);
      }
    });
  }

  /** Select / start an effect (firmware-side if supported). */
  setEffect(effectId, speed) {
    if (!this.enabled) return;
    const lc = this.lightChannel;
    if (this._supports(P.TRANSPORT.SYSEX)) {
      this._sendSysex(P.sysexEffect(lc, effectId, speed, 255, 255, 255));
    } else if (this._supports(P.TRANSPORT.CC)
               && this.caps.light_cc_effect !== P.UNSET) {
      let m = P.ccMessage(lc, this.caps.light_cc_effect, effectId);
      this._send(m.type, m.data);
      if (this.caps.light_cc_effect_speed !== P.UNSET) {
        m = P.ccMessage(lc, this.caps.light_cc_effect_speed, speed);
        this._send(m.type, m.data);
      }
    }
  }

  /** Light a set of upcoming notes for guide/learning mode (dim white). */
  setGuideTarget(notes) {
    if (!this.enabled || !(this.caps.light_flags & P.CAP_FLAG.GUIDE)) return;
    const lc = this.lightChannel;
    for (const n of notes || []) {
      const led = this._ledForNote(n);
      if (this._supports(P.TRANSPORT.SYSEX) && this.colorMode === P.COLOR_MODE.RGB) {
        this._sendSysex(P.sysexSetLed(lc, led, 40, 40, 40));
      } else if (this._supports(P.TRANSPORT.NOTE)) {
        const m = P.noteColorMessage(lc, led, 1);
        this._send(m.type, m.data);
      }
    }
  }

  /** Turn everything off. */
  allOff() {
    const lc = this.lightChannel;
    if (this._supports(P.TRANSPORT.SYSEX)) {
      this._sendSysex(P.sysexClear(lc));
    } else if (this._supports(P.TRANSPORT.CC)
               && this.caps.light_cc_brightness !== P.UNSET) {
      const m = P.ccMessage(lc, P.DEFAULT_CC.allOff, 0);
      this._send(m.type, m.data);
    }
    if (this._supports(P.TRANSPORT.NOTE)) {
      for (const led of this._activeNotes) {
        const m = P.noteColorMessage(lc, led, 0);
        this._send(m.type, m.data);
      }
    }
    this._activeNotes.clear();
  }

  enable() {
    this.enabled = true;
    if (this.isAutonomous) {
      this.pushBrightness();
      return;
    }
    this.allOff();
    this.pushBrightness();
  }

  disable() {
    if (this.enabled) this.allOff();
    this.enabled = false;
  }
}

export default InstrumentLightController;
