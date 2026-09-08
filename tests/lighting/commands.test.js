/**
 * @file tests/lighting/commands.test.js
 * @description L02 — the 38 `lighting_*` WebSocket commands
 * (`src/api/commands/LightingCommands.js`, 313 statements, 0 % covered at
 * baseline). Only 7 of them carry a payload schema
 * (`src/api/commands/schemas/lighting.schemas.js`), so this suite also documents
 * what the 31 schemaless ones accept.
 */

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import EventBus from '../../src/core/EventBus.js';
import LightingManager from '../../src/lighting/LightingManager.js';
import { register } from '../../src/api/commands/LightingCommands.js';
import { ValidationError, NotFoundError, ConfigurationError } from '../../src/core/errors/index.js';
import { FakeLightingDriver, makeDatabase, makeLogger, rule, hardStop } from './l02-fakes.js';

const DEV = { id: 1, name: 'par', type: 'fake', led_count: 8, enabled: true };

let managers = [];

/** Minimal CommandRegistry double: records every registered handler. */
function makeRegistry() {
  const handlers = {};
  return {
    handlers,
    register: (name, fn) => {
      handlers[name] = fn;
    }
  };
}

/** In-memory LightingRepository double. */
function makeRepo(state) {
  return {
    findAllDevices: () => state.devices,
    findDeviceById: (id) => state.devices.find((d) => d.id === id) || null,
    saveDevice: (d) => {
      state.devices.push({ id: state.devices.length + 1, ...d });
      return state.devices.length;
    },
    updateDevice: (id, f) => {
      state.updated.push([id, f]);
    },
    deleteDevice: (id) => {
      state.devices = state.devices.filter((d) => d.id !== id);
    },
    findAllRules: () => state.rules.map((r) => ({ ...r })),
    findRulesByDevice: (id) => state.rules.filter((r) => r.device_id === id),
    saveRule: (r) => {
      state.rules.push({ id: state.rules.length + 1, ...r });
      return state.rules.length;
    },
    updateRule: (id, f) => {
      state.updatedRules.push([id, f]);
    },
    deleteRule: (id) => {
      state.rules = state.rules.filter((r) => r.id !== id);
    },
    findAllPresets: () => state.presets,
    savePreset: (p) => {
      state.presets.push({ id: state.presets.length + 1, ...p });
      return state.presets.length;
    },
    deletePreset: (id) => {
      state.presets = state.presets.filter((p) => p.id !== id);
    }
  };
}

function build({ withManager = true, rules = [] } = {}) {
  const logger = makeLogger();
  const eventBus = new EventBus(logger);
  const state = {
    devices: [{ ...DEV }],
    rules: [...rules],
    presets: [],
    updated: [],
    updatedRules: []
  };
  let manager = null;
  let driver = null;
  if (withManager) {
    manager = new LightingManager({
      logger,
      database: makeDatabase({ rules }),
      eventBus,
      wsServer: null
    });
    driver = new FakeLightingDriver(DEV, logger);
    manager.drivers.set(DEV.id, driver);
    managers.push(manager);
  }
  const app = { logger, eventBus, lightingManager: manager, lightingRepository: makeRepo(state) };
  const registry = makeRegistry();
  register(registry, app);
  return { app, registry, h: registry.handlers, manager, driver, state, eventBus, logger };
}

afterEach(() => {
  managers.forEach(hardStop);
  managers = [];
  jest.useRealTimers();
});

describe('L02 — command surface', () => {
  test('the module registers exactly the 38 documented lighting commands', () => {
    const { h } = build();
    const names = Object.keys(h).sort();
    expect(names.length).toBe(38);
    expect(names.every((n) => n.startsWith('lighting_'))).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['lighting_blackout', 'lighting_midi_learn']));
  });

  // F-37 (was: "only 7 of the 38 have a payload schema — the other 31 are
  // unvalidated"). Closed by wave 1 / R3: the 28 payload-taking commands now
  // carry a schema, and the 10 that are left take no payload argument at all
  // (`registry.register('lighting_all_off', () => ...)`), so nothing they
  // receive can reach anything.
  test('every payload-taking lighting command has a schema (F-37 closed)', async () => {
    const { h } = build();
    const schemas = await import('../../src/api/commands/schemas/lighting.schemas.js');
    const withSchema = Object.keys(schemas.default);
    const without = Object.keys(h).filter((n) => !withSchema.includes(n));
    expect(withSchema.length + without.length).toBe(38);
    // Anything without a schema must be provably unable to read a payload.
    for (const name of without) {
      expect(h[name].length).toBe(0);
    }
  });
});

describe('L02 / L01 F-18 — lighting_midi_learn must not be a remote kill switch', () => {
  test('the 10 s timeout resolves with a clean failure instead of throwing out of the timer', async () => {
    jest.useFakeTimers();
    const { h } = build();
    const p = h.lighting_midi_learn({});
    // Before L01's F-18 fix this threw `removeListener is not a function`
    // INSIDE the setTimeout callback → uncaughtException → Application.stop().
    // L02 keeps the regression test: the defect class (EventBus has no
    // `removeListener`) also hit LightingManager.shutdown() — see F-30.
    expect(() => jest.advanceTimersByTime(10000)).not.toThrow();
    await expect(p).resolves.toMatchObject({ success: false, error: 'timeout' });
  });

  test('the timeout path detaches its listener', async () => {
    jest.useFakeTimers();
    const { h, eventBus } = build();
    const p = h.lighting_midi_learn({});
    expect(eventBus.listenerCount('midi_message')).toBe(2); // manager + learn
    jest.advanceTimersByTime(10000);
    await p;
    expect(eventBus.listenerCount('midi_message')).toBe(1); // manager only
  });

  test('the success path resolves with the captured message and detaches', async () => {
    jest.useFakeTimers();
    const { h, eventBus } = build();
    const p = h.lighting_midi_learn({});
    eventBus.emit('midi_message', {
      type: 'cc',
      data: { channel: 3, controller: 74, value: 100 }
    });
    await expect(p).resolves.toMatchObject({
      success: true,
      learned: { type: 'cc', channel: 3, controller: 74, value: 100 }
    });
    expect(eventBus.listenerCount('midi_message')).toBe(1);
  });

  test('without a lighting manager the command refuses cleanly', () => {
    const { h } = build({ withManager: false });
    expect(() => h.lighting_midi_learn({})).toThrow(ConfigurationError);
  });
});

describe('L02 — validation actually enforced by the handlers', () => {
  test('required fields are enforced', async () => {
    const { h } = build();
    await expect(h.lighting_device_add({})).rejects.toThrow(ValidationError);
    await expect(h.lighting_device_update({})).rejects.toThrow(ValidationError);
    await expect(h.lighting_device_delete({})).rejects.toThrow(ValidationError);
    expect(() => h.lighting_rule_add({})).toThrow(ValidationError);
    expect(() => h.lighting_effect_stop({})).toThrow(ValidationError);
    expect(() => h.lighting_group_delete({})).toThrow(ValidationError);
    expect(() => h.lighting_scene_apply({})).toThrow(ValidationError);
    expect(() => h.lighting_rules_import({})).toThrow(ValidationError);
  });

  test('lighting_rule_add refuses an unknown device and out-of-range MIDI bounds', () => {
    const { h } = build();
    expect(() => h.lighting_rule_add({ device_id: 4242 })).toThrow(NotFoundError);
    expect(() =>
      h.lighting_rule_add({ device_id: 1, condition_config: { note_min: 200 } })
    ).toThrow(/note_min must be 0-127/);
    expect(() =>
      h.lighting_rule_add({ device_id: 1, condition_config: { velocity_min: -1 } })
    ).toThrow(ValidationError);
  });

  test('lighting_device_scan rejects an SSRF-shaped subnet', async () => {
    const { h } = build();
    await expect(
      h.lighting_device_scan({ type: 'wled', subnet: '127.0.0' })
    ).resolves.toBeDefined();
    await expect(
      h.lighting_device_scan({ type: 'wled', subnet: '10.0.0.1:8080/x' })
    ).rejects.toThrow(ValidationError);
    await expect(h.lighting_device_scan({ type: 'wled', subnet: '999.1.1' })).rejects.toThrow(
      ValidationError
    );
  });

  test('lighting_rules_import rejects malformed JSON, a missing array and an oversized batch', () => {
    const { h } = build();
    expect(() => h.lighting_rules_import({ import_data: '{oops' })).toThrow(
      /Invalid import data JSON/
    );
    expect(() => h.lighting_rules_import({ import_data: { rules: 'nope' } })).toThrow(
      ValidationError
    );
    expect(() =>
      h.lighting_rules_import({ import_data: { rules: new Array(1001).fill({}) } })
    ).toThrow(/Too many rules/);
  });

  test('every manager-backed command reports ConfigurationError when lighting is absent', () => {
    const { h } = build({ withManager: false });
    for (const cmd of [
      'lighting_blackout',
      'lighting_master_dimmer',
      'lighting_bpm_tap',
      'lighting_led_broadcast'
    ]) {
      expect(() => h[cmd]({})).toThrow(ConfigurationError);
    }
    // …while the read-only ones degrade to an empty/default answer.
    expect(h.lighting_effect_list()).toEqual({ success: true, effects: [] });
    expect(h.lighting_group_list()).toEqual({ success: true, groups: {} });
    expect(h.lighting_bpm_get()).toEqual({ success: true, bpm: 120 });
    expect(h.lighting_all_off()).toEqual({ success: true });
  });
});

describe('L02 F-37 — what the 31 schemaless commands accept', () => {
  test('lighting_group_color: a hex-shaped nonsense colour silently becomes white', () => {
    const { h, driver } = build();
    h.lighting_group_create({ name: 'g', device_ids: [1] });
    driver.reset();
    h.lighting_group_color({ name: 'g', color: 'javascript:alert(1)' });
    expect(driver.of('setRange')[0]).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  test('lighting_group_color: an out-of-range brightness reaches the driver unclamped', () => {
    const { h, driver } = build();
    h.lighting_group_create({ name: 'g', device_ids: [1] });
    driver.reset();
    h.lighting_group_color({ name: 'g', r: 999, g: -50, b: 1e9, brightness: 100000 });
    const w = driver.of('setRange')[0];
    // The manager only scales by the master dimmer; clamping is left to each
    // driver's `_applyBrightness` (which does clamp) — but a driver that
    // forwards the value raw, or a `setDmxChannel`-style path, gets this.
    expect(w.r).toBe(999);
    expect(w.brightness).toBeGreaterThan(255);
  });

  test('lighting_master_dimmer: a non-numeric value is coerced to 0 (blackout), not rejected', () => {
    const { h, manager } = build();
    expect(h.lighting_master_dimmer({ value: 'bright' })).toEqual({
      success: true,
      masterDimmer: 0
    });
    expect(manager.getMasterDimmer()).toBe(0);
  });

  test('lighting_bpm_set with a non-numeric bpm poisons the effects engine tempo', () => {
    const { h, manager } = build();
    h.lighting_bpm_set({ bpm: 'fast' });
    expect(Number.isNaN(manager.effectsEngine.getBpm())).toBe(true);
    expect(Number.isNaN(manager.effectsEngine.getBeatMs())).toBe(true);
  });

  test('lighting_rule_add accepts a non-numeric MIDI bound (validateMidiRange only compares)', () => {
    const { h, state } = build();
    expect(() =>
      h.lighting_rule_add({ device_id: 1, condition_config: { velocity_min: 'loud' } })
    ).not.toThrow();
    expect(state.rules[0].condition_config.velocity_min).toBe('loud');
  });

  test('lighting_effect_start accepts an unknown effect type (logged, silently ignored)', () => {
    const { h, manager, logger } = build();
    h.lighting_effect_start({ device_id: 1, effect_type: 'chase; DROP TABLE' });
    expect(manager.effectsEngine.activeEffects.size).toBe(0);
    expect(logger._rec.warn.join(' ')).toMatch(/Unknown effect type/);
  });

  test('lighting_scene_apply walks an attacker-supplied scene object without validating it', () => {
    const { h, manager, driver } = build();
    driver.reset();
    h.lighting_scene_apply({
      scene: {
        masterDimmer: 255,
        devices: [
          { id: 1, color: '#00FF00' },
          { id: 99, color: '#FF0000' }
        ],
        effects: [
          { key: 'x_device_1', effectType: 'rainbow', config: { led_start: 0, led_end: 7 } }
        ]
      }
    });
    expect(driver.of('setRange')[0]).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(manager.effectsEngine.activeEffects.size).toBe(1);
  });
});

describe('L02 — happy paths of the persistence-backed commands', () => {
  test('device list merges the live connected flag', () => {
    const { h } = build();
    const res = h.lighting_device_list();
    expect(res.devices[0]).toMatchObject({ id: 1, connected: true });
  });

  test('device add/update/delete reach the repository and reload the manager', async () => {
    const { h, state, manager } = build();
    const spy = jest.spyOn(manager, 'reloadDevices');
    await h.lighting_device_add({ name: 'new', type: 'artnet', led_count: 4 });
    expect(state.devices.at(-1)).toMatchObject({ name: 'new', type: 'artnet', led_count: 4 });
    await h.lighting_device_update({ id: 1, name: 'renamed' });
    expect(state.updated[0][0]).toBe(1);
    await h.lighting_device_delete({ id: 1 });
    expect(state.devices.find((d) => d.id === 1)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('rules export → import round-trips through the device NAME', () => {
    const { h, state } = build();
    h.lighting_rule_add({ device_id: 1, name: 'r1', condition_config: {}, action_config: {} });
    const exported = h.lighting_rules_export({});
    expect(exported.export_data.rules[0].device_name).toBe('par');
    state.rules = [];
    const res = h.lighting_rules_import({ import_data: exported.export_data });
    expect(res).toMatchObject({ imported: 1, skipped: 0 });
  });

  test('an import whose device name is unknown is skipped unless a default is given', () => {
    const { h } = build();
    const doc = { rules: [{ name: 'x', device_name: 'ghost' }] };
    expect(h.lighting_rules_import({ import_data: doc })).toMatchObject({
      imported: 0,
      skipped: 1
    });
    expect(h.lighting_rules_import({ import_data: doc, default_device_id: 1 })).toMatchObject({
      imported: 1,
      skipped: 0
    });
  });

  test('preset save/load replaces the whole rule set; a scene preset is applied instead', () => {
    const { h, state } = build();
    h.lighting_rule_add({ device_id: 1, name: 'keep' });
    h.lighting_preset_save({ name: 'p1' });
    h.lighting_rule_add({ device_id: 1, name: 'extra' });
    expect(state.rules.length).toBe(2);
    expect(h.lighting_preset_load({ id: 1 })).toMatchObject({ rules_loaded: 1 });
    expect(state.rules.length).toBe(1);

    h.lighting_scene_save({ name: 's1' });
    expect(h.lighting_preset_load({ id: 2 })).toMatchObject({ scene_applied: true });
    expect(() => h.lighting_preset_load({ id: 404 })).toThrow(NotFoundError);
  });

  test('groups: create → colour → off → delete', () => {
    const { h, driver } = build();
    expect(h.lighting_group_create({ name: 'front', device_ids: [1] })).toEqual({ success: true });
    expect(() => h.lighting_group_create({ name: 'x', device_ids: 'nope' })).toThrow(
      ValidationError
    );
    expect(h.lighting_group_list().groups).toEqual({ front: [1] });
    driver.reset();
    h.lighting_group_color({ name: 'front', color: '#FF00FF', brightness: 255 });
    expect(driver.of('setRange')[0]).toMatchObject({ r: 255, g: 0, b: 255 });
    h.lighting_group_off({ name: 'front' });
    expect(driver.of('allOff').length).toBe(1);
    expect(h.lighting_group_delete({ name: 'front' })).toEqual({ success: true });
    expect(() => h.lighting_group_color({ name: 'front' })).toThrow(/not found/);
  });

  test('BPM: set / get / tap stay inside 20..300', () => {
    jest.useFakeTimers(); // tapTempo() arms an uncleared 3.5 s timer per tap
    const { h } = build();
    h.lighting_bpm_set({ bpm: 5000 });
    expect(h.lighting_bpm_get()).toEqual({ success: true, bpm: 300 });
    h.lighting_bpm_set({ bpm: 1 });
    expect(h.lighting_bpm_get()).toEqual({ success: true, bpm: 20 });
    expect(h.lighting_bpm_tap()).toMatchObject({ success: true });
  });

  test('lighting_dmx_profiles returns the fixture library', async () => {
    const { h } = build();
    const res = await h.lighting_dmx_profiles();
    expect(res.success).toBe(true);
    expect(res.profiles.length).toBeGreaterThan(5);
    expect(res.profiles[0]).toHaveProperty('channels');
  });

  test('device test / rule test refuse a device that is not connected', async () => {
    jest.useFakeTimers();
    const { h, driver, manager } = build({ rules: [rule({ id: 1 })] });
    driver.connected = false;
    await expect(h.lighting_device_test({ id: 1 })).rejects.toThrow(/not connected/);
    driver.connected = true;
    await expect(h.lighting_device_test({ id: 1 })).resolves.toEqual({ success: true });
    expect(() => h.lighting_rule_test({ id: 404 })).toThrow(/not found/);
    manager.database._state.rules = [rule({ id: 1 })];
    expect(h.lighting_rule_test({ id: 1 })).toEqual({ success: true });
  });

  test('led broadcast toggle and system enable/disable are reflected in state', () => {
    const { h, manager } = build();
    expect(h.lighting_led_broadcast({ enabled: true })).toEqual({ success: true, enabled: true });
    expect(h.lighting_led_broadcast({ enabled: false })).toEqual({ success: true, enabled: false });
    expect(h.lighting_set_enabled({ enabled: false })).toEqual({ success: true, enabled: false });
    expect(h.lighting_get_enabled()).toEqual({ success: true, enabled: false });
    expect(manager._systemEnabled).toBe(false);
  });
});
