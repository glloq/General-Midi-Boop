/**
 * @file tests/lighting/midi-path-isolation.test.js
 * @description L02 / risk #1 — the lighting rule engine is evaluated
 * SYNCHRONOUSLY on every MIDI message (`LightingManager._setupEventListeners`
 * subscribes to `midi_message` and `midi_routed`, and `EventBus.emit` is a
 * synchronous loop). This suite answers, with measurements: can a slow, a
 * faulty, a hung or a disconnecting lighting driver damage the MIDI path?
 *
 * STATUS AFTER R17 (F-28, wave 4): the three latency tests below WERE RED-BY-
 * DESIGN — they documented the defect. They are now INVERTED: the listeners
 * only push the event into a bounded queue drained by a `setImmediate`, so the
 * driver's cost is no longer charged to the MIDI dispatch. The full before/after
 * bench, the queue bound and the shutdown ordering live in
 * `tests/lighting/r17-midi-path-budget.test.js`.
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

/** Run the deferred lighting work the dispatch no longer does (R17). */
function settle() {
  manager.flushLightingQueue();
}

describe('R17 / L02 F-28 — a synchronously slow driver no longer blocks the MIDI path', () => {
  // WAS RED-BY-DESIGN, NOW INVERTED (R17). Same bench, same fake driver, same
  // busy-wait: only the assertions changed sign.
  test('a driver that spends 120 ms in setRange costs the MIDI dispatch nothing', () => {
    build([rule({ condition_config: { trigger: 'noteon' }, instrument_id: null })]);
    // instrument_id null → indexed under '*' → evaluated on every raw message.
    driver.blockMs = 120;

    const blocked = dispatchAndMeasure(
      midiMessage('noteon', { channel: 0, note: 60, velocity: 100 })
    );

    driver.blockMs = 0;
    const free = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 61, velocity: 100 }));

    process.stdout.write(
      `\n[R17 F-28] MIDI dispatch latency — slow driver: ${blocked.toFixed(2)} ms · ` +
        `same driver idle: ${free.toFixed(2)} ms (was 120.1 ms · 0.2 ms)\n`
    );

    // The write is queued, not executed: the dispatch is as cheap as an idle one.
    expect(blocked).toBeLessThan(5);
    expect(free).toBeLessThan(5);
    // …and the light really is written, one event-loop turn later.
    driver.blockMs = 0;
    settle();
    expect(driver.of('setRange').length).toBe(2);
  });

  test('cost is no longer multiplied by the number of matching rules', () => {
    const rules = [1, 2, 3, 4].map((i) => rule({ id: i, condition_config: { trigger: 'noteon' } }));
    build(rules);
    driver.blockMs = 25;

    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    process.stdout.write(
      `[R17 F-28] 4 matching rules × 25 ms driver = ${t.toFixed(2)} ms on the MIDI path (was 100.0 ms)\n`
    );
    expect(t).toBeLessThan(5);

    // The four writes still happen — off the MIDI path.
    driver.blockMs = 0;
    settle();
    expect(driver.of('setRange').length).toBe(4);
  });

  test('midi_routed (post-send, inside the router fan-out loop) is free too', () => {
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
    process.stdout.write(
      `[R17 F-28] midi_routed dispatch with slow driver: ${ms.toFixed(2)} ms (was 99.9 ms)\n`
    );
    expect(ms).toBeLessThan(5);

    driver.blockMs = 0;
    settle();
    expect(driver.of('setRange').length).toBe(1);
  });
});

describe('L02 — a driver that throws does NOT crash the process, but aborts the rest of the rules', () => {
  test('the throw is contained by the lighting drain, not by EventBus.emit (R17)', () => {
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
    // R17: nothing reaches EventBus.emit any more — the driver fault happens in
    // the setImmediate drain, where an escaping throw would be an unhandled
    // exception (i.e. the process). `_drain()` catches it and logs it itself.
    expect(logger._rec.error.join(' ')).not.toMatch(/midi_message handler/);
    expect(() => settle()).not.toThrow();
    expect(logger._rec.warn.join(' ')).toMatch(/Lighting rule dispatch failed/);
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
    manager.flushLightingQueue();

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
    settle();
    expect(driver.of('setRange').length).toBe(1);
  });

  test('a driver that reports itself disconnected is skipped entirely', () => {
    build([rule({ condition_config: { trigger: 'noteon' } })]);
    driver.connected = false;
    driver.blockMs = 200; // would be catastrophic if it were called

    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    settle();
    expect(driver.calls.length).toBe(0);
    expect(t).toBeLessThan(50);
  });

  test('a device removed mid-burst stops being written to without error', () => {
    build([rule({ condition_config: { trigger: 'noteon' } })]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    settle();
    expect(driver.calls.length).toBe(1);

    manager.drivers.delete(DEVICE.id); // e.g. cable pulled → disconnectDevice()
    expect(() => {
      bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 62, velocity: 100 }));
      settle();
    }).not.toThrow();
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
    settle();
    expect(driver.calls.length).toBe(0);
    expect(t).toBeLessThan(50);
    // Nothing was even queued.
    expect(manager.getDispatchStats().queued).toBe(0);
  });

  test('with zero rules the listeners return immediately', () => {
    build([]);
    driver.blockMs = 200;
    const t = dispatchAndMeasure(midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    settle();
    expect(driver.calls.length).toBe(0);
    expect(t).toBeLessThan(50);
    expect(manager.getDispatchStats().queued).toBe(0);
  });
});
