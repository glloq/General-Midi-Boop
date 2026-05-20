// tests/instrument-light-manager.test.js
// Manager + controller behaviour with a fake DeviceManager and database.
// Validates: the master gate suppresses CCs, partial updates emit only the
// changed CC numbers, and the persisted row matches the in-memory state.

import { describe, test, expect, beforeEach } from '@jest/globals';
import InstrumentLightManager from '../src/lighting/instrument/InstrumentLightManager.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function makeEventBus() {
  return { on() {}, removeListener() {}, emit() {} };
}

function makeDeviceManager() {
  return {
    sent: [],
    sendMessage(deviceName, type, data) {
      this.sent.push({ deviceName, type, data });
      return true;
    }
  };
}

function makeDatabase({ lightingEnabled = true, initialState = null } = {}) {
  let stored = initialState ? { ...initialState } : null;
  return {
    getInstrumentSettings: () => ({ lighting_enabled: lightingEnabled ? 1 : 0 }),
    getInstrumentLightState: () => stored,
    getAllInstrumentLightStates: () =>
      stored ? [{ device_id: 'kbd-1', channel: 0, ...stored }] : [],
    saveInstrumentLightState: (device_id, channel, state) => {
      stored = { device_id, channel, supported_mask: 0, ...state };
      return `${device_id}_${channel}`;
    },
    _peek: () => stored
  };
}

const ALL = 0x1F; // supported_mask covering CC110-114

describe('InstrumentLightManager', () => {
  let dm, db, mgr;
  // Tests that emit CCs assume the instrument declared every CC supported.
  beforeEach(() => {
    dm = makeDeviceManager();
    db = makeDatabase({ initialState: { supported_mask: ALL } });
    mgr = new InstrumentLightManager({
      logger, eventBus: makeEventBus(), deviceManager: dm, database: db
    });
  });

  test('getState returns defaults + master flag when no row stored yet', () => {
    const freshDb = makeDatabase();
    const freshMgr = new InstrumentLightManager({
      logger, eventBus: makeEventBus(), deviceManager: makeDeviceManager(), database: freshDb
    });
    const s = freshMgr.getState('kbd-1', 0);
    expect(s).toMatchObject({
      brightness: 0, effect: 0, hue: 0, speed: 64, intensity: 64,
      supported_mask: 0, master_enabled: true
    });
  });

  test('default supported_mask = 0 silences every CC emission', () => {
    const silentDb = makeDatabase();   // no initial row → mask defaults to 0
    const silentDm = makeDeviceManager();
    const silentMgr = new InstrumentLightManager({
      logger, eventBus: makeEventBus(), deviceManager: silentDm, database: silentDb
    });
    silentMgr.setState('kbd-1', 0, { brightness: 80, hue: 42, effect: 3 });
    expect(silentDm.sent.length).toBe(0);
    expect(silentDb._peek()).toMatchObject({ brightness: 80, supported_mask: 0 });
  });

  test('activating a CC bit pushes its current value', () => {
    db.saveInstrumentLightState('kbd-1', 0, {
      brightness: 90, effect: 0, hue: 0, speed: 64, intensity: 64, supported_mask: 0
    });
    const dm2 = makeDeviceManager();
    const mgr2 = new InstrumentLightManager({
      logger, eventBus: makeEventBus(), deviceManager: dm2, database: db
    });
    mgr2.setState('kbd-1', 0, { supported_mask: 0x01 }); // activate CC110
    const sent = dm2.sent.filter((s) => s.type === 'cc');
    expect(sent.length).toBe(1);
    expect(sent[0].data.controller).toBe(110);
    expect(sent[0].data.value).toBe(90);
  });

  test('setState persists every field and emits only the changed CCs', () => {
    mgr.setState('kbd-1', 0, { brightness: 80, hue: 42 });
    expect(db._peek()).toMatchObject({ brightness: 80, hue: 42, effect: 0, speed: 64, intensity: 64 });
    const ccs = dm.sent.filter((s) => s.type === 'cc').map((s) => s.data.controller).sort();
    expect(ccs).toEqual([110, 112]);
  });

  test('further setState calls only emit the actual diffs', () => {
    mgr.setState('kbd-1', 0, { brightness: 80, hue: 42 });
    dm.sent.length = 0;
    mgr.setState('kbd-1', 0, { brightness: 80, effect: 4 });
    const ccs = dm.sent.filter((s) => s.type === 'cc').map((s) => s.data.controller);
    expect(ccs).toEqual([111]);
    expect(dm.sent[0].data.value).toBe(4);
  });

  test('master toggle off keeps the state persisted but emits nothing', () => {
    const offDb = makeDatabase({ lightingEnabled: false });
    const offDm = makeDeviceManager();
    const offMgr = new InstrumentLightManager({
      logger, eventBus: makeEventBus(), deviceManager: offDm, database: offDb
    });
    offMgr.setState('kbd-1', 0, { brightness: 120, effect: 3, hue: 10, speed: 50, intensity: 90 });
    expect(offDb._peek()).toMatchObject({ brightness: 120, effect: 3 });
    expect(offDm.sent.length).toBe(0);
  });

  test('allOff sends CC110 = 0 and persists brightness 0', () => {
    mgr.setState('kbd-1', 0, { brightness: 90, hue: 30 });
    dm.sent.length = 0;
    mgr.allOff('kbd-1', 0);
    expect(dm.sent.length).toBe(1);
    expect(dm.sent[0].data.controller).toBe(110);
    expect(dm.sent[0].data.value).toBe(0);
    expect(db._peek().brightness).toBe(0);
  });

  test('test() pushes a visible burst then restores the saved state', async () => {
    mgr.setState('kbd-1', 0, { brightness: 40, hue: 100, effect: 2, speed: 70, intensity: 30 });
    dm.sent.length = 0;
    expect(mgr.test('kbd-1', 0)).toBe(true);
    // Burst should bump brightness to 127 immediately.
    const burstCc = dm.sent.find((s) => s.data.controller === 110 && s.data.value === 127);
    expect(burstCc).toBeTruthy();
    await new Promise((r) => setTimeout(r, 900));
    // After the timeout, brightness must be back to 40.
    const restored = dm.sent.filter((s) => s.data.controller === 110).pop();
    expect(restored.data.value).toBe(40);
  });

  test('listStates exposes the persisted row with master flag', () => {
    mgr.setState('kbd-1', 0, { brightness: 60, hue: 20 });
    const list = mgr.listStates();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ device_id: 'kbd-1', channel: 0, brightness: 60, hue: 20, master_enabled: true });
  });
});
