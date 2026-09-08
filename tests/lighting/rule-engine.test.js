/**
 * @file tests/lighting/rule-engine.test.js
 * @description L02 — semantics of the lighting rule engine
 * (`LightingManager._matchesCondition` / `_executeAction`): trigger type,
 * channel, velocity, note range, CC number/value, action kinds, note tracking,
 * master dimmer, rule ordering and rule overlap.
 *
 * Everything runs against a `FakeLightingDriver`: no socket, no GPIO.
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

const DEV = (id = 1) => ({ id, name: `d${id}`, type: 'fake', led_count: 8, enabled: true });

let managers = [];

function build(rules, deviceIds = [1]) {
  const logger = makeLogger();
  const bus = new EventBus(logger);
  const database = makeDatabase({ rules });
  const manager = new LightingManager({ logger, database, eventBus: bus, wsServer: null });
  const drivers = new Map();
  for (const id of deviceIds) {
    const d = new FakeLightingDriver(DEV(id), logger);
    manager.drivers.set(id, d);
    drivers.set(id, d);
  }
  managers.push(manager);
  return { manager, bus, logger, driver: drivers.get(deviceIds[0]), drivers };
}

afterEach(() => {
  managers.forEach(hardStop);
  managers = [];
});

// ==================== _matchesCondition ====================

describe('L02 — trigger type', () => {
  test("trigger 'any' (and an absent trigger) matches every message type", () => {
    const { manager } = build([]);
    const m = (c, d) => manager._matchesCondition(c, manager._normalizeMidiData(midiMessage(...d)));
    for (const type of ['noteon', 'noteoff', 'cc', 'pitch', 'program']) {
      expect(m({ trigger: 'any' }, [type, { channel: 0 }])).toBe(true);
      expect(m({}, [type, { channel: 0 }])).toBe(true);
    }
  });

  test('an exact trigger rejects every other type', () => {
    const { manager } = build([]);
    const cond = { trigger: 'cc' };
    const norm = (t, d) => manager._normalizeMidiData(midiMessage(t, d));
    expect(
      manager._matchesCondition(cond, norm('cc', { channel: 0, controller: 7, value: 64 }))
    ).toBe(true);
    expect(
      manager._matchesCondition(cond, norm('noteon', { channel: 0, note: 60, velocity: 1 }))
    ).toBe(false);
  });
});

describe('L02 F-31 — a `noteon` rule never sees the release: the light stays lit', () => {
  test('trigger:noteon (the UI default for a new rule) lights the LED and never clears it', () => {
    const { bus, driver } = build([
      rule({
        condition_config: { trigger: 'noteon' },
        action_config: { type: 'static', color: '#FF0000' }
      })
    ]);

    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    expect(driver.of('setRange').length).toBe(1);
    expect(driver.of('setRange')[0]).toMatchObject({ r: 255, g: 0, b: 0 });

    // DeviceManager.js:1353 normalises a velocity-0 Note On to `noteoff`
    // BEFORE emitting, so this is the only release the engine can ever see.
    bus.emit('midi_message', midiMessage('noteoff', { channel: 0, note: 60, velocity: 0 }));

    // No second write at all → the LED is still red. Light stuck ON.
    expect(driver.of('setRange').length).toBe(1);
    expect(driver.of('allOff').length).toBe(0);
  });

  test("trigger:'any' does clear it — the note-off path is only reachable that way", () => {
    const { bus, driver } = build([
      rule({
        condition_config: { trigger: 'any' },
        action_config: { type: 'static', color: '#FF0000' }
      })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    bus.emit('midi_message', midiMessage('noteoff', { channel: 0, note: 60, velocity: 0 }));
    const writes = driver.of('setRange');
    expect(writes.length).toBe(2);
    expect(writes[1]).toMatchObject({ r: 0, g: 0, b: 0, brightness: 0 });
  });

  test('F-31b: a velocity floor on an `any` rule re-creates the stuck light', () => {
    // "Only react to notes played at velocity >= 64" — a natural rule. The
    // release carries velocity 0, so it fails the SAME velocity filter.
    const { bus, driver } = build([
      rule({ condition_config: { trigger: 'any', velocity_min: 64 } })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    bus.emit('midi_message', midiMessage('noteoff', { channel: 0, note: 60, velocity: 0 }));
    expect(driver.of('setRange').length).toBe(1); // lit, never cleared
  });
});

describe('L02 — channel / note / velocity / CC filters', () => {
  test('channels is an inclusion list on the 0-based channel', () => {
    const { manager } = build([]);
    const n = (d) => manager._normalizeMidiData(midiMessage('noteon', d));
    expect(
      manager._matchesCondition({ channels: [9] }, n({ channel: 9, note: 36, velocity: 100 }))
    ).toBe(true);
    expect(
      manager._matchesCondition({ channels: [9] }, n({ channel: 0, note: 36, velocity: 100 }))
    ).toBe(false);
    // An empty list means "no filter", not "match nothing".
    expect(
      manager._matchesCondition({ channels: [] }, n({ channel: 3, note: 36, velocity: 100 }))
    ).toBe(true);
  });

  test('note_min / note_max bounds are inclusive', () => {
    const { manager } = build([]);
    const n = (note) =>
      manager._normalizeMidiData(midiMessage('noteon', { channel: 0, note, velocity: 100 }));
    const c = { note_min: 60, note_max: 72 };
    expect(manager._matchesCondition(c, n(59))).toBe(false);
    expect(manager._matchesCondition(c, n(60))).toBe(true);
    expect(manager._matchesCondition(c, n(72))).toBe(true);
    expect(manager._matchesCondition(c, n(73))).toBe(false);
  });

  test('velocity_min / velocity_max bounds are inclusive', () => {
    const { manager } = build([]);
    const n = (velocity) =>
      manager._normalizeMidiData(midiMessage('noteon', { channel: 0, note: 60, velocity }));
    const c = { velocity_min: 40, velocity_max: 100 };
    expect(manager._matchesCondition(c, n(39))).toBe(false);
    expect(manager._matchesCondition(c, n(40))).toBe(true);
    expect(manager._matchesCondition(c, n(100))).toBe(true);
    expect(manager._matchesCondition(c, n(101))).toBe(false);
  });

  test('cc_number selects the controller; a different CC does not fire', () => {
    const { bus, driver } = build([rule({ condition_config: { trigger: 'cc', cc_number: [7] } })]);
    bus.emit('midi_message', midiMessage('cc', { channel: 0, controller: 7, value: 100 }));
    bus.emit('midi_message', midiMessage('cc', { channel: 0, controller: 11, value: 100 }));
    expect(driver.of('setRange').length).toBe(1);
  });

  test('F-37: cc_number [0] (Bank Select MSB) is silently treated as "no filter"', () => {
    const { manager } = build([]);
    const n = (controller) =>
      manager._normalizeMidiData(midiMessage('cc', { channel: 0, controller, value: 1 }));
    // `condition.cc_number && condition.cc_number.length > 0` — the guard is on
    // the array, so [0] IS a filter and works…
    expect(manager._matchesCondition({ cc_number: [0] }, n(0))).toBe(true);
    expect(manager._matchesCondition({ cc_number: [0] }, n(7))).toBe(false);
    // …but a scalar 0 (what an unvalidated payload can carry, F-37) disables it.
    expect(manager._matchesCondition({ cc_number: 0 }, n(7))).toBe(true);
  });

  test('cc_value_min / cc_value_max only apply to cc messages', () => {
    const { manager } = build([]);
    const cc = manager._normalizeMidiData(
      midiMessage('cc', { channel: 0, controller: 7, value: 10 })
    );
    expect(manager._matchesCondition({ cc_value_min: 64 }, cc)).toBe(false);
    // A pitchbend carries `value` too but is not filtered by cc_value_*.
    const pb = manager._normalizeMidiData(midiMessage('pitch', { channel: 0, value: 10 }));
    expect(manager._matchesCondition({ cc_value_min: 64 }, pb)).toBe(true);
  });
});

// ==================== _executeAction ====================

describe('L02 — action semantics', () => {
  test('static: hex colour is written verbatim, master dimmer scales brightness', () => {
    const { manager, bus, driver } = build([
      rule({ action_config: { type: 'static', color: '#0080FF', brightness: 200 } })
    ]);
    manager.setMasterDimmer(128);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    const w = driver.of('setRange')[0];
    expect(w).toMatchObject({ r: 0, g: 128, b: 255 });
    expect(w.brightness).toBe(Math.round((200 * 128) / 255));
  });

  test('an invalid hex colour degrades to white instead of throwing', () => {
    const { bus, driver } = build([
      rule({ action_config: { type: 'static', color: 'not-a-color' } })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    expect(driver.of('setRange')[0]).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  test('brightness_from_velocity maps 0..127 onto 0..255', () => {
    const { bus, driver } = build([
      rule({ action_config: { type: 'static', color: '#FFFFFF', brightness_from_velocity: true } })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 127 }));
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 61, velocity: 64 }));
    expect(driver.of('setRange')[0].brightness).toBe(255);
    expect(driver.of('setRange')[1].brightness).toBe(Math.round((64 / 127) * 255));
  });

  test('note_color maps the pitch class to a chromatic hue (C=red, octave-invariant)', () => {
    const { manager } = build([]);
    expect(manager._noteToColor(60)).toEqual(manager._noteToColor(72));
    expect(manager._noteToColor(60)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(manager._noteToColor(66)).not.toEqual(manager._noteToColor(60));
  });

  test('velocity_mapped interpolates linearly between the colour-map stops', () => {
    const { manager } = build([]);
    const map = { 0: '#000000', 127: '#FFFFFF' };
    expect(manager._interpolateColorMap(map, 0)).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(manager._interpolateColorMap(map, 127)).toMatchObject({ r: 255, g: 255, b: 255 });
    const mid = manager._interpolateColorMap(map, 64);
    expect(mid.r).toBeGreaterThan(120);
    expect(mid.r).toBeLessThan(136);
    // Out-of-range values clamp to the end stops rather than extrapolating.
    expect(manager._interpolateColorMap(map, 999)).toMatchObject({ r: 255 });
    expect(manager._interpolateColorMap(map, -5)).toMatchObject({ r: 0 });
    expect(manager._interpolateColorMap({}, 64)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  test('color_temp maps 0..127 from warm to cool white', () => {
    const { manager } = build([]);
    const warm = manager._colorTemperature(0, 2700, 6500);
    const cool = manager._colorTemperature(127, 2700, 6500);
    expect(warm.b).toBeLessThan(cool.b);
    expect(warm.r).toBeGreaterThanOrEqual(cool.r);
  });

  test('vu_meter lights a velocity-proportional number of LEDs and clears the rest', () => {
    const { bus, driver } = build([
      rule({ action_config: { type: 'vu_meter', led_start: 0, led_end: 7 } })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 64 }));
    const writes = driver.of('setColor');
    expect(writes.length).toBe(8);
    const lit = writes.filter((w) => w.r + w.g + w.b > 0).length;
    expect(lit).toBe(Math.round((64 / 127) * 8));
    expect(writes[7]).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  test('note_led maps a note to exactly one LED, clamped to the strip', () => {
    const { bus, driver } = build([
      rule({
        action_config: {
          type: 'note_led',
          note_led_min: 60,
          note_led_max: 67,
          led_start: 0,
          led_end: 7
        }
      })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 67, velocity: 100 }));
    // A note far outside the declared range must not address LED -30 or +200.
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 0, velocity: 100 }));
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 127, velocity: 100 }));
    const idx = driver.of('setColor').map((c) => c.ledIndex);
    expect(idx[0]).toBe(0);
    expect(idx[1]).toBe(7);
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThanOrEqual(7);
    }
  });

  test("off_action:'hold' keeps the LED lit on release", () => {
    const { bus, driver } = build([
      rule({
        condition_config: { trigger: 'any' },
        action_config: { type: 'static', off_action: 'hold' }
      })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    bus.emit('midi_message', midiMessage('noteoff', { channel: 0, note: 60, velocity: 0 }));
    expect(driver.of('setRange').length).toBe(1);
  });

  test('polyphony: the strip only goes dark when the LAST held note is released', () => {
    const { bus, driver } = build([rule({ condition_config: { trigger: 'any' } })]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 64, velocity: 100 }));
    driver.reset();
    bus.emit('midi_message', midiMessage('noteoff', { channel: 0, note: 60, velocity: 0 }));
    expect(driver.of('setRange').filter((w) => w.brightness === 0).length).toBe(0);
    bus.emit('midi_message', midiMessage('noteoff', { channel: 0, note: 64, velocity: 0 }));
    expect(driver.of('setRange').filter((w) => w.brightness === 0).length).toBe(1);
  });

  test('F-31c: a release with no matching press leaves the LED untouched', () => {
    // Server restarted (or the stale-note sweep ran) while a key was held:
    // activeNotes has no entry for the device, so `_handleNoteOff` does nothing.
    const { bus, driver } = build([rule({ condition_config: { trigger: 'any' } })]);
    bus.emit('midi_message', midiMessage('noteoff', { channel: 0, note: 60, velocity: 0 }));
    expect(driver.calls.length).toBe(0);
  });
});

// ==================== ordering, priority, overlap ====================

describe('L02 — several rules on one event', () => {
  test('every matching rule fires (no first-match-wins); the last write wins on the wire', () => {
    const { bus, driver } = build([
      rule({ id: 1, priority: 10, action_config: { type: 'static', color: '#FF0000' } }),
      rule({ id: 2, priority: 1, action_config: { type: 'static', color: '#00FF00' } })
    ]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    const w = driver.of('setRange');
    expect(w.length).toBe(2);
    // Rules are applied in the order the DB returned them (priority DESC),
    // so the LOWEST-priority overlapping rule is the one that ends up visible.
    expect(w[0]).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(w[1]).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  test('F-33: a high-priority wildcard rule is overwritten by a low-priority instrument rule', () => {
    const { bus, drivers } = build(
      [
        rule({
          id: 1,
          priority: 100,
          instrument_id: null,
          action_config: { type: 'static', color: '#FF0000' }
        }),
        rule({
          id: 2,
          priority: 0,
          instrument_id: 'inst-1',
          action_config: { type: 'static', color: '#00FF00' }
        })
      ],
      [1]
    );
    const d = drivers.get(1);
    bus.emit('midi_routed', {
      route: 'r',
      source: 'in',
      destination: 'inst-1',
      type: 'noteon',
      data: { channel: 0, note: 60, velocity: 100 }
    });
    const w = d.of('setRange');
    expect(w.length).toBe(2);
    // `_evaluateRoutedEvent` runs the instrument bucket BEFORE the wildcard
    // bucket, so priority 100 loses to priority 0 across buckets.
    expect(w[0]).toMatchObject({ g: 255 });
    expect(w[1]).toMatchObject({ r: 255 });
  });

  test('F-32: a wildcard rule fires TWICE per logical input note', () => {
    // DeviceManager emits `midi_message` first, then routeMessage() emits
    // `midi_routed`; `_recentRoutedEvents` is only populated by the second,
    // so the de-dup can never suppress the first. Both paths run the '*' rules.
    const { bus, driver } = build([
      rule({ instrument_id: null, condition_config: { trigger: 'any' } })
    ]);
    const data = { channel: 0, note: 60, velocity: 100 };
    bus.emit('midi_message', midiMessage('noteon', data));
    bus.emit('midi_routed', {
      route: 'r',
      source: 'in',
      destination: 'inst-1',
      type: 'noteon',
      data
    });
    expect(driver.of('setRange').length).toBe(2);
  });

  test('rules pointing at an unknown device are inert', () => {
    const { bus, driver } = build([rule({ id: 9, device_id: 999 })]);
    bus.emit('midi_message', midiMessage('noteon', { channel: 0, note: 60, velocity: 100 }));
    expect(driver.calls.length).toBe(0);
  });
});
