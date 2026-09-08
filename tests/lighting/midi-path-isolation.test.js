/**
 * @file tests/lighting/midi-path-isolation.test.js
 * @description L02 / risk #1 — the lighting rule engine is evaluated
 * SYNCHRONOUSLY on every MIDI message (`LightingManager._setupEventListeners`
 * subscribes to `midi_message` and `midi_routed`, and `EventBus.emit` is a
 * synchronous loop). This suite answers, with measurements: can a slow, a
 * faulty, a hung or a disconnecting lighting driver damage the MIDI path?
 *
 * Reference points in production code:
 *   - DeviceManager.js:1409  `eventBus.emit('midi_message', …)` — emitted
 *     BEFORE `midiRouter.routeMessage(...)`, i.e. upstream of MIDI output.
 *   - MidiRouter.js:405      `eventBus.emit('midi_routed', …)` — emitted inside
 *     the per-destination send loop.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import EventBus from '../../src/core/EventBus.js';
import LightingManager from '../../src/lighting/LightingManager.js';
import {
  FakeLightingDriver,
  makeDatabase,
  makeLogger,
  rule,
  midiMessage,
  hardStop
} from './l02-fakes.js';

const DEVICE = { id: 1, name: 'strip', type: 'fake', led_count: 8, enabled: true };

let bus;
let logger;
let manager;
let driver;

function build(rules) {
  logger = makeLogger();
  bus = new EventBus(logger);
  const database = makeDatabase({ devices: [], rules });
  manager = new LightingManager({ logger, database, eventBus: bus, wsServer: null });
  driver = new FakeLightingDriver(DEVICE, logger);
  manager.drivers.set(DEVICE.id, driver);
  return manager;
}

beforeEach(() => {
  manager = null;
});

afterEach(() => {
  if (manager) hardStop(manager);
});

/**
 * Reproduces the DeviceManager ordering: the lighting listeners run first,
 * the actual MIDI output happens after. Returns the delay (ms) the lighting
 * subsystem injected before the note reached its instrument.
 */
function dispatchAndMeasure(event) {
  const t0 = process.hrtime.bigint();
  bus.emit('midi_message', event);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

describe('L02 F-28 — a synchronously slow driver blocks the MIDI path', () => {
  test('a driver that spends 120 ms in setRange delays MIDI output by ~120 ms', () => {
    build([rule({ condition_config: { trigger: 'noteon' }, instrument_id: null })]);
    // instrument_id null → indexed under '*' → evaluated on every raw message.
    driver.blockMs = 120;

    const blocked = dispatchAndMeasure(
      midiMessage('noteon', { channel: 0, note: 60, velocity: 100 })
    );

    driver.blockMs = 0;
    const free = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 61, velocity: 100 }));

    process.stdout.write(
      `\n[L02 F-28] MIDI dispatch latency — slow driver: ${blocked.toFixed(1)} ms · ` +
        `same driver idle: ${free.toFixed(1)} ms\n`
    );

    // The blocking is REAL: the driver's cost lands on the MIDI dispatch stack.
    expect(blocked).toBeGreaterThanOrEqual(100);
    expect(free).toBeLessThan(60);
    expect(blocked).toBeGreaterThan(free * 2);
  });

  test('cost is multiplied by the number of matching rules (N rules × driver cost)', () => {
    const rules = [1, 2, 3, 4].map((i) => rule({ id: i, condition_config: { trigger: 'noteon' } }));
    build(rules);
    driver.blockMs = 25;

    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    process.stdout.write(`[L02 F-28] 4 matching rules × 25 ms driver = ${t.toFixed(1)} ms\n`);

    // 4 rules → 4 synchronous driver writes on the MIDI stack.
    expect(driver.of('setRange').length).toBe(4);
    expect(t).toBeGreaterThanOrEqual(80);
  });

  test('midi_routed (post-send, inside the router fan-out loop) blocks too', () => {
    build([rule({ instrument_id: 'inst-1', condition_config: { trigger: 'noteon' } })]);
    driver.blockMs = 100;

    const t0 = process.hrtime.bigint();
    bus.emit('midi_routed', {
      route: 'r1',
      source: 'in',
      destination: 'inst-1',
      type: 'noteon',
      data: { channel: 0, note: 60, velocity: 100 }
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(`[L02 F-28] midi_routed dispatch with slow driver: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeGreaterThanOrEqual(80);
  });
});

describe('L02 — a driver that throws does NOT crash the process, but aborts the rest of the rules', () => {
  test('the throw is contained by EventBus.emit (MIDI path survives)', () => {
    build([rule({ condition_config: { trigger: 'noteon' } })]);
    driver.throwOn.add('setRange');

    let downstreamRan = false;
    bus.on('midi_message', () => {
      downstreamRan = true;
    });

    expect(() =>
      bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }))
    ).not.toThrow();
    expect(downstreamRan).toBe(true);
    // EventBus logged the fault rather than propagating it.
    expect(logger._rec.error.join(' ')).toMatch(/midi_message handler/);
  });

  test('F-29: one faulty device silently cancels every LATER rule of the same event', () => {
    const badDevice = { id: 1, name: 'bad', type: 'fake', led_count: 8, enabled: true };
    const goodDevice = { id: 2, name: 'good', type: 'fake', led_count: 8, enabled: true };
    logger = makeLogger();
    bus = new EventBus(logger);
    const database = makeDatabase({
      rules: [
        rule({ id: 1, device_id: 1, condition_config: { trigger: 'noteon' } }),
        rule({ id: 2, device_id: 2, condition_config: { trigger: 'noteon' } })
      ]
    });
    manager = new LightingManager({ logger, database, eventBus: bus, wsServer: null });
    const bad = new FakeLightingDriver(badDevice, logger);
    const good = new FakeLightingDriver(goodDevice, logger);
    bad.throwOn.add('setRange');
    manager.drivers.set(1, bad);
    manager.drivers.set(2, good);

    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));

    // Rule 1 (broken device) was attempted…
    expect(bad.of('setRange').length).toBe(1);
    // …and rule 2, on a perfectly healthy device, never ran.
    expect(good.of('setRange').length).toBe(0);
  });
});

describe('L02 — an asynchronously hung driver does NOT block the MIDI path', () => {
  test('a write returning a never-settling promise costs the MIDI path nothing', () => {
    build([rule({ condition_config: { trigger: 'noteon' } })]);
    driver.hang = true;

    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    process.stdout.write(`[L02] hung (async) driver dispatch: ${t.toFixed(2)} ms\n`);
    expect(t).toBeLessThan(50);
    expect(driver.of('setRange').length).toBe(1);
  });

  test('a driver that reports itself disconnected is skipped entirely', () => {
    build([rule({ condition_config: { trigger: 'noteon' } })]);
    driver.connected = false;
    driver.blockMs = 200; // would be catastrophic if it were called

    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    expect(driver.calls.length).toBe(0);
    expect(t).toBeLessThan(50);
  });

  test('a device removed mid-burst stops being written to without error', () => {
    build([rule({ condition_config: { trigger: 'noteon' } })]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    expect(driver.calls.length).toBe(1);

    manager.drivers.delete(DEVICE.id); // e.g. cable pulled → disconnectDevice()
    expect(() =>
      bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 62, velocity: 100 }))
    ).not.toThrow();
    expect(driver.calls.length).toBe(1);
  });
});

describe('L02 — the system-disable switch really removes the cost', () => {
  test('lighting_set_enabled(false) short-circuits evaluation before any driver call', () => {
    build([rule({ condition_config: { trigger: 'noteon' } })]);
    manager.setSystemEnabled(false);
    driver.reset();
    driver.blockMs = 200;

    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    expect(driver.calls.length).toBe(0);
    expect(t).toBeLessThan(50);
  });

  test('with zero rules the listeners return immediately', () => {
    build([]);
    driver.blockMs = 200;
    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    expect(driver.calls.length).toBe(0);
    expect(t).toBeLessThan(50);
  });
});
