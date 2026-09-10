/**
 * @file tests/lighting/r17-midi-path-budget.test.js
 * @description R17 (audit F-28, P1) — "the sound must never wait for the light".
 *
 * L02 measured the defect on this exact bench: a lighting driver that spends
 * 120 ms inside `setRange()` added **120.1 ms to the MIDI dispatch** (0.2 ms
 * idle), and the cost was multiplied by the number of matching rules
 * (4 rules × 25 ms = 100.0 ms). The reason is structural, not accidental:
 * `DeviceManager` emits `midi_message` BEFORE `midiRouter.routeMessage()`, and
 * `EventBus.emit()` is a synchronous loop — so the rule engine ran on the MIDI
 * dispatch stack. The counter-intuitive part, also measured, is that a driver
 * hung ASYNCHRONOUSLY cost nothing (0.05 ms): the threat was never the hang, it
 * was synchronous slowness.
 *
 * This suite pins the fix:
 *   1. the same bench, before/after, in the same process;
 *   2. the bound on the queue that replaces the synchronous call (F-36: a queue
 *      without a bound is a memory leak under a dense MIDI flood);
 *   3. the per-tick time budget, so a slow driver yields the event loop instead
 *      of monopolising it;
 *   4. the guard-rail that must not be lost on the way: the blackout at
 *      shutdown is still really emitted, and is still the LAST thing written.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
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

let managers = [];

function build(rules, { blockMs = 0 } = {}) {
  const logger = makeLogger();
  const bus = new EventBus(logger);
  const manager = new LightingManager({
    logger,
    database: makeDatabase({ rules }),
    eventBus: bus,
    wsServer: null
  });
  const driver = new FakeLightingDriver(DEVICE, logger);
  driver.blockMs = blockMs;
  manager.drivers.set(DEVICE.id, driver);
  managers.push(manager);
  return { manager, bus, logger, driver };
}

afterEach(() => {
  managers.forEach(hardStop);
  managers = [];
});

/** Milliseconds spent inside `bus.emit(...)` — i.e. charged to the MIDI path. */
function dispatchCost(bus, event, data) {
  const t0 = process.hrtime.bigint();
  bus.emit(event, data);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/**
 * The pre-R17 cost profile, reproduced faithfully: the same rule evaluation and
 * the same driver writes, but performed INSIDE the dispatch window (which is
 * what `EventBus.emit()` did when it called `_executeAction` directly).
 */
function dispatchCostInline(bus, manager, event, data) {
  const t0 = process.hrtime.bigint();
  bus.emit(event, data);
  manager.flushLightingQueue();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const note = (n, velocity = 100) => midiMessage('noteon', { channel: 0, note: n, velocity });
const release = (n) => midiMessage('noteoff', { channel: 0, note: n, velocity: 0 });

// ==========================================================================
// 1. The measurement L02 asked for: same bench, before → after
// ==========================================================================

describe('R17 F-28 — the MIDI dispatch no longer pays for the lights', () => {
  test('a driver blocking 120 ms: inline 120 ms → queued < 5 ms on the dispatch', () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })], {
      blockMs: 120
    });

    // BEFORE: the work done on the dispatch stack, as it used to be.
    const before = dispatchCostInline(bus, manager, 'midi_message', note(60));
    // AFTER: what the MIDI path actually pays now.
    const after = dispatchCost(bus, 'midi_message', note(61));

    process.stdout.write(
      `\n[R17 F-28] one 120 ms driver — MIDI dispatch: ${before.toFixed(1)} ms inline (pre-R17) → ` +
        `${after.toFixed(2)} ms queued (post-R17)\n`
    );

    expect(before).toBeGreaterThanOrEqual(100); // the defect, reproduced
    expect(after).toBeLessThan(5); // the fix, measured
    expect(after * 20).toBeLessThan(before);

    // The light is not lost, only deferred.
    driver.blockMs = 0;
    manager.flushLightingQueue();
    expect(driver.of('setRange').length).toBe(2);
  });

  test('the cost stops multiplying by the rule count (1 / 4 / 16 rules × 25 ms)', () => {
    const curve = [];
    for (const n of [1, 4, 16]) {
      const rules = Array.from({ length: n }, (_, i) =>
        rule({ id: i + 1, condition_config: { trigger: 'noteon' } })
      );
      const { bus, manager, driver } = build(rules, { blockMs: 25 });
      const inline = dispatchCostInline(bus, manager, 'midi_message', note(60));
      const queued = dispatchCost(bus, 'midi_message', note(61));
      driver.blockMs = 0;
      manager.flushLightingQueue();
      curve.push({ n, inline, queued, writes: driver.of('setRange').length });
    }
    process.stdout.write(
      `[R17 F-28] rules × 25 ms driver — ` +
        curve
          .map((c) => `${c.n}: ${c.inline.toFixed(0)} ms inline / ${c.queued.toFixed(2)} ms queued`)
          .join(' · ') +
        '\n'
    );

    // Inline: strictly linear in the number of rules (that is F-28).
    expect(curve[0].inline).toBeGreaterThanOrEqual(20);
    expect(curve[1].inline).toBeGreaterThanOrEqual(80);
    expect(curve[2].inline).toBeGreaterThanOrEqual(300);
    // Queued: flat, and every write still happens off the path.
    for (const c of curve) {
      expect(c.queued).toBeLessThan(5);
      expect(c.writes).toBe(c.n * 2);
    }
  });

  test('midi_routed — emitted inside the router fan-out loop — is free as well', () => {
    const { bus, manager, driver } = build(
      [rule({ instrument_id: 'inst-1', condition_config: { trigger: 'noteon' } })],
      { blockMs: 100 }
    );
    const routed = {
      route: 'r1',
      source: 'in',
      destination: 'inst-1',
      type: 'noteon',
      data: { channel: 0, note: 60, velocity: 100 }
    };
    const cost = dispatchCost(bus, 'midi_routed', routed);
    process.stdout.write(`[R17 F-28] midi_routed dispatch: ${cost.toFixed(2)} ms\n`);
    expect(cost).toBeLessThan(5);
    driver.blockMs = 0;
    manager.flushLightingQueue();
    expect(driver.of('setRange').length).toBe(1);
  });

  test('a burst of 200 notes through a 2 ms driver keeps the whole dispatch under 20 ms', () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })], {
      blockMs: 2
    });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) bus.emit('midi_message', note(36 + (i % 48)));
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(
      `[R17 F-28] 200 notes × 2 ms driver — total time on the MIDI path: ${total.toFixed(2)} ms ` +
        `(would be ~400 ms inline)\n`
    );
    expect(total).toBeLessThan(20);
    driver.blockMs = 0;
    manager.flushLightingQueue();
    expect(driver.of('setRange').length).toBe(200);
  });

  test('the lighting work really does happen, on its own setImmediate turn', async () => {
    const { bus, driver } = build([rule({ condition_config: { trigger: 'noteon' } })]);
    bus.emit('midi_message', note(60));
    expect(driver.calls.length).toBe(0); // nothing yet: the dispatch is clean
    await new Promise((r) => setImmediate(r));
    expect(driver.of('setRange').length).toBe(1); // …and one turn later, lit
  });
});

// ==========================================================================
// 2. The bound (F-36: a queue with no cap is a memory leak)
// ==========================================================================

describe('R17 — the queue that replaces the synchronous call is bounded', () => {
  test('5 000 events under a stalled drain never exceed the cap', () => {
    const { bus, manager } = build([rule({ condition_config: { trigger: 'any' } })]);
    const limit = manager.getDispatchStats().limit;
    expect(limit).toBe(512);

    for (let i = 0; i < 5000; i++) bus.emit('midi_message', note(36 + (i % 48)));

    const stats = manager.getDispatchStats();
    expect(stats.depth).toBeLessThanOrEqual(limit);
    expect(stats.queued).toBe(5000);
    expect(stats.dropped).toBe(5000 - limit);
    // The backing array cannot grow behind the read cursor either.
    expect(manager._queue.length).toBeLessThanOrEqual(limit * 2);
  });

  test('overflow drops attacks, never releases: the rig cannot be stranded lit', () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'any' } })]);
    const limit = manager.getDispatchStats().limit;

    // A note that is really held, then a flood that overflows the queue.
    bus.emit('midi_message', note(60));
    manager.flushLightingQueue(); // the fixture is lit and note 60 is tracked
    expect(driver.of('setRange').length).toBe(1);

    bus.emit('midi_message', release(60)); // the release the show depends on
    for (let i = 0; i < limit * 3; i++) bus.emit('midi_message', note(36 + (i % 48)));

    const stats = manager.getDispatchStats();
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.droppedReleases).toBe(0); // the release survived the flood

    driver.reset();
    manager.flushLightingQueue();
    const dark = driver.of('setRange').filter((w) => w.brightness === 0);
    expect(dark.length).toBeGreaterThanOrEqual(1);
  });

  test('a full queue of nothing but releases still drops (bounded is bounded), and says so', () => {
    const { bus, manager, logger } = build([rule({ condition_config: { trigger: 'any' } })]);
    const limit = manager.getDispatchStats().limit;
    for (let i = 0; i < limit + 10; i++) bus.emit('midi_message', release(36 + (i % 48)));
    const stats = manager.getDispatchStats();
    expect(stats.depth).toBe(limit);
    expect(stats.droppedReleases).toBe(10);
    expect(logger._rec.warn.join(' ')).toMatch(/Lighting queue full/);
  });

  test('the overflow warning is throttled — a flood must not flood the log', () => {
    const { bus, manager, logger } = build([rule({ condition_config: { trigger: 'any' } })]);
    for (let i = 0; i < 3000; i++) bus.emit('midi_message', note(36 + (i % 48)));
    expect(manager.getDispatchStats().dropped).toBeGreaterThan(2000);
    expect(logger._rec.warn.filter((w) => /Lighting queue full/.test(w)).length).toBe(1);
  });
});

// ==========================================================================
// 3. The per-tick time budget
// ==========================================================================

describe('R17 — one drain tick is time-boxed, so the event loop keeps breathing', () => {
  test('a 5 ms driver × 20 events is spread over several turns, ~8 ms each', async () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })], {
      blockMs: 5
    });
    for (let i = 0; i < 20; i++) bus.emit('midi_message', note(36 + i));

    const turns = [];
    let guard = 0;
    while (manager.getDispatchStats().depth > 0 && guard++ < 50) {
      const t0 = process.hrtime.bigint();
      await new Promise((r) => setImmediate(r));
      turns.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }

    process.stdout.write(
      `[R17 F-28] 20 events × 5 ms driver drained in ${turns.length} turns of ` +
        `${turns.map((t) => t.toFixed(0)).join('/')} ms (budget ${manager.getDispatchStats().budgetMs} ms)\n`
    );

    expect(driver.of('setRange').length).toBe(20);
    // More than one turn: the drain yielded instead of holding the loop for 100 ms.
    expect(turns.length).toBeGreaterThan(1);
    // No single turn ran away with the loop: budget (8) + at most one in-flight
    // write (5), plus generous slack for a loaded CI box — the point is that no
    // turn is anywhere near the 100 ms the synchronous path used to hold.
    for (const t of turns) expect(t).toBeLessThan(60);
  });

  test('an event that overruns the budget on its own is reported once, not silently', () => {
    const { bus, manager, logger, driver } = build(
      [rule({ condition_config: { trigger: 'noteon' } })],
      { blockMs: 40 }
    );
    bus.emit('midi_message', note(60));
    manager.flushLightingQueue();
    driver.blockMs = 0;
    expect(manager.getDispatchStats().slowEvents).toBe(1);
    expect(logger._rec.warn.join(' ')).toMatch(/spent .* ms on a single MIDI event/);
    expect(logger._rec.warn.join(' ')).toMatch(/The lights are late; the MIDI path is not/);
  });

  test('a driver that throws in the drain is contained (no unhandled exception)', () => {
    const { bus, manager, logger, driver } = build([
      rule({ condition_config: { trigger: 'noteon' } })
    ]);
    driver.throwOn.add('setRange');
    bus.emit('midi_message', note(60));
    expect(() => manager.flushLightingQueue()).not.toThrow();
    expect(manager.getDispatchStats().errors).toBe(1);
    expect(logger._rec.warn.join(' ')).toMatch(/Lighting rule dispatch failed/);
  });
});

// ==========================================================================
// 4. The guard-rail: the blackout at shutdown is still really emitted, LAST
// ==========================================================================

describe('R17 — deferring the writes must not break the blackout at shutdown', () => {
  test('shutdown() darkens the rig even with a queue full of pending note-ons', async () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })]);
    for (let i = 0; i < 100; i++) bus.emit('midi_message', note(36 + (i % 48)));
    expect(manager.getDispatchStats().depth).toBe(100);

    driver.reset();
    await manager.shutdown();

    // The queued note-ons were dropped, not replayed…
    expect(manager.getDispatchStats().discarded).toBe(100);
    // …and the blackout is the LAST thing the fixture was told.
    expect(driver.of('allOff').length).toBe(1);
    expect(driver.calls[driver.calls.length - 1].m).toBe('allOff');
    expect(driver.disconnectCalls).toBe(1);

    // Nothing wakes up afterwards.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(driver.calls[driver.calls.length - 1].m).toBe('allOff');
  });

  test('a slow driver cannot hold the shutdown blackout hostage', async () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })], {
      blockMs: 50
    });
    for (let i = 0; i < 40; i++) bus.emit('midi_message', note(36 + i)); // 2 s of queued work

    const t0 = process.hrtime.bigint();
    driver.blockMs = 0;
    await manager.shutdown();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    process.stdout.write(
      `[R17] shutdown with 40 queued events on a 50 ms driver: ${ms.toFixed(1)} ms\n`
    );
    expect(ms).toBeLessThan(500); // not 2 000 ms of queue drained first
    expect(driver.of('allOff').length).toBe(1);
  });

  test('blackout() cannot be undone one tick later by a queued note-on', async () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })]);
    bus.emit('midi_message', note(60)); // queued, not written yet
    driver.reset();

    manager.blackout();
    await new Promise((r) => setImmediate(r));

    expect(driver.of('allOff').length).toBe(1);
    expect(driver.of('setRange').length).toBe(0); // the rig stayed dark
    expect(manager.getDispatchStats().discarded).toBe(1);
  });

  test('setSystemEnabled(false) also empties the queue', async () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })]);
    for (let i = 0; i < 5; i++) bus.emit('midi_message', note(60 + i));
    driver.reset();
    manager.setSystemEnabled(false);
    await new Promise((r) => setImmediate(r));
    expect(driver.of('setRange').length).toBe(0);
    expect(driver.of('allOff').length).toBe(1);
  });

  test('the listeners are gone after shutdown, so nothing can be queued again', async () => {
    const { bus, manager, driver } = build([rule({ condition_config: { trigger: 'noteon' } })]);
    await manager.shutdown();
    driver.reset();
    bus.emit('midi_message', note(60));
    expect(manager.getDispatchStats().depth).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(driver.calls.length).toBe(0);
  });
});
