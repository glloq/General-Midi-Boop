// tests/instrument-light-manager.test.js
// Manager + controller behaviour with a fake DeviceManager that faithfully
// re-invokes the lighting observer (as the real sendMessage hook does),
// proving the reentrancy guard prevents a lighting note from re-triggering
// itself, and that played notes are mirrored onto the instrument's LEDs.

import { describe, test, expect, beforeEach } from '@jest/globals';
import InstrumentLightManager from '../src/lighting/instrument/InstrumentLightManager.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function makeEventBus() {
  const map = new Map();
  return {
    on(e, cb) { (map.get(e) || map.set(e, []).get(e)).push(cb); },
    removeListener() {},
    emit(e, d) { (map.get(e) || []).forEach(cb => cb(d)); }
  };
}

function makeDeviceManager() {
  const dm = {
    instrumentLightObserver: null,
    sent: [],
    sendMessage(deviceName, type, data) {
      this.sent.push({ deviceName, type, data });
      // Mirror the real DeviceManager: notify the observer for notes.
      if (this.instrumentLightObserver && (type === 'noteon' || type === 'noteoff')) {
        this.instrumentLightObserver(deviceName, type, data);
      }
      return true;
    },
    requestLightingCapabilities() { return true; }
  };
  return dm;
}

function makeDatabase(rows) {
  return {
    getAllInstrumentLights: () => rows,
    getInstrumentSettings: () => ({ lighting_enabled: 1 }),
    getInstrumentLight: (d, c) =>
      rows.find(r => r.device_id === d && (r.channel || 0) === (c || 0)) || null,
    saveInstrumentLightCapabilities() {},
    saveInstrumentLightConfig() {}
  };
}

const baseRow = {
  device_id: 'kbd-1',
  channel: 0,
  light_caps_source: 'sysex',
  light_led_count: 88,
  light_addressing: 1,        // per-note
  light_note_base: 0,
  light_color_mode: 0,        // on/off → NOTE transport
  light_transports: 0x02,     // NOTE only
  light_channel: 127,         // same as instrument channel
  light_min_interval_ms: 0,
  light_mode: 'managed',
  light_brightness: 255
};

describe('InstrumentLightManager', () => {
  let dm, deps;
  beforeEach(() => {
    dm = makeDeviceManager();
    deps = { logger, eventBus: makeEventBus(), deviceManager: dm,
             database: makeDatabase([{ ...baseRow }]) };
  });

  test('installs the DeviceManager observer and builds a controller', () => {
    const mgr = new InstrumentLightManager(deps);
    expect(typeof dm.instrumentLightObserver).toBe('function');
    expect(mgr.controllers.size).toBe(1);
  });

  test('mirrors a played note onto the LED without infinite recursion', () => {
    new InstrumentLightManager(deps);
    // Simulate the instrument playing note 60: the real DeviceManager
    // calls the observer before dispatching.
    dm.instrumentLightObserver('kbd-1', 'noteon', { channel: 0, note: 60, velocity: 100 });
    const lightSends = dm.sent.filter(s => s.type === 'noteon');
    // Exactly one lighting noteon emitted (on/off mode → velocity 127),
    // and the guard stopped it from re-triggering itself.
    expect(lightSends.length).toBe(1);
    expect(lightSends[0].data).toMatchObject({ note: 60, velocity: 127 });
  });

  test('note off clears the LED', () => {
    new InstrumentLightManager(deps);
    dm.instrumentLightObserver('kbd-1', 'noteon', { channel: 0, note: 64, velocity: 90 });
    dm.sent.length = 0;
    dm.instrumentLightObserver('kbd-1', 'noteoff', { channel: 0, note: 64, velocity: 0 });
    const offs = dm.sent.filter(s => s.type === 'noteoff');
    expect(offs.length).toBe(1);
    expect(offs[0].data.note).toBe(64);
  });

  test('disabled master gate keeps the controller silent', () => {
    deps.database.getInstrumentSettings = () => ({ lighting_enabled: 0 });
    new InstrumentLightManager(deps);
    dm.instrumentLightObserver('kbd-1', 'noteon', { channel: 0, note: 60, velocity: 100 });
    expect(dm.sent.length).toBe(0);
  });

  test('test() flashes then restores without recursion', () => {
    const mgr = new InstrumentLightManager(deps);
    dm.sent.length = 0;
    const ok = mgr.test('kbd-1', 0);
    expect(ok).toBe(true);
    // NOTE transport → a burst of noteon, each guarded (no runaway).
    expect(dm.sent.length).toBeGreaterThan(0);
    expect(dm.sent.length).toBeLessThan(200);
  });
});
