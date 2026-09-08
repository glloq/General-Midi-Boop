/**
 * @file tests/lighting/r22-default-rule.test.js
 * @description R22 (audit F-31, P1) — "the rule the UI proposes by default
 * leaves a LED lit for ever".
 *
 * L02 proved it: `_matchesCondition()` filters on the trigger type FIRST, so a
 * rule with `trigger: 'noteon'` never saw the release and the whole note-off
 * half of `_executeAction()` (instant / fade / hold) was dead code for it. And
 * `trigger: 'noteon'` is not an exotic setting: `LightingForms.js` lists it
 * first and a new rule carries no `selected` attribute, so the browser picks
 * it — the first lighting rule a user ever creates lights a fixture and nothing
 * ever switches it off. Variant F-31b: an `any` rule with a velocity floor
 * ("only react to strong notes") rejects the release, which carries velocity 0.
 *
 * Semantics retained: **a rule that lit a note owns its release.** A release is
 * matched against the filters that say WHERE the rule applies (instrument,
 * channel, note range, CC) but not against those describing HOW the note was
 * struck (trigger type, velocity window), and only while that note is actually
 * held on the rule's device. Rejected alternatives are documented in
 * `docs/audit/2026-09-07/WAVE4_R17_R22.md`.
 */

import { describe, test, expect, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import EventBus from '../../src/core/EventBus.js';
import LightingManager from '../../src/lighting/LightingManager.js';
import {
  FakeLightingDriver,
  makeDatabase,
  makeLogger,
  rule,
  midiMessage,
  hardStop,
  drainOnEmit
} from './l02-fakes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const DEV = (id = 1) => ({ id, name: `d${id}`, type: 'fake', led_count: 8, enabled: true });

/**
 * The `condition_config` that `LightingForms.submitRule()` posts for a BRAND
 * NEW rule: the trigger the `<select>` defaults to, plus the numeric inputs at
 * their own defaults (velocity 0..127, note 0..127, CC 0..127, no channel/CC
 * filter). Kept in sync with `public/js/features/lighting/LightingForms.js`.
 */
const UI_DEFAULT_CONDITION = {
  trigger: 'noteon',
  channels: null,
  velocity_min: 0,
  velocity_max: 127,
  note_min: 0,
  note_max: 127,
  cc_number: null,
  cc_value_min: 0,
  cc_value_max: 127
};

/** The `action_config` the same form posts with nothing touched but the colour. */
const UI_DEFAULT_ACTION = {
  type: 'static',
  color: '#FF0000',
  brightness: 255,
  brightness_from_velocity: false,
  led_start: 0,
  led_end: -1,
  fade_time_ms: 200,
  off_action: 'instant'
};

let managers = [];

function build(rules, deviceIds = [1]) {
  const logger = makeLogger();
  const bus = new EventBus(logger);
  const manager = new LightingManager({
    logger,
    database: makeDatabase({ rules }),
    eventBus: bus,
    wsServer: null
  });
  const drivers = new Map();
  for (const id of deviceIds) {
    const d = new FakeLightingDriver(DEV(id), logger);
    manager.drivers.set(id, d);
    drivers.set(id, d);
  }
  managers.push(manager);
  drainOnEmit(bus, manager); // R17: the engine runs off the MIDI stack now
  return { manager, bus, logger, driver: drivers.get(deviceIds[0]), drivers };
}

afterEach(() => {
  managers.forEach(hardStop);
  managers = [];
});

const press = (note, velocity = 100) => midiMessage('noteon', { channel: 0, note, velocity });
const release = (note) => midiMessage('noteoff', { channel: 0, note, velocity: 0 });

// ==========================================================================
// 1. The rule the UI actually produces
// ==========================================================================

describe('R22 F-31 — the rule the UI proposes by default behaves sanely', () => {
  test('press → lit, release → dark: the fixture is not stranded on', () => {
    const { bus, driver } = build([
      rule({ condition_config: UI_DEFAULT_CONDITION, action_config: UI_DEFAULT_ACTION })
    ]);

    bus.emit('midi_message', press(60));
    expect(driver.of('setRange')[0]).toMatchObject({ r: 255, g: 0, b: 0, brightness: 255 });

    bus.emit('midi_message', release(60));
    const writes = driver.of('setRange');
    expect(writes.length).toBe(2);
    expect(writes[1]).toMatchObject({ r: 0, g: 0, b: 0, brightness: 0 });
  });

  test('the same, one note after another, over a whole phrase: nothing accumulates', () => {
    const { manager, bus, driver } = build([
      rule({ condition_config: UI_DEFAULT_CONDITION, action_config: UI_DEFAULT_ACTION })
    ]);
    for (const n of [60, 62, 64, 65, 67]) {
      bus.emit('midi_message', press(n));
      bus.emit('midi_message', release(n));
    }
    const writes = driver.of('setRange');
    expect(writes.length).toBe(10);
    expect(writes[writes.length - 1]).toMatchObject({ brightness: 0 }); // ends dark
    expect(manager.activeNotes.get(1)?.size ?? 0).toBe(0); // no leaked tracking
  });

  test('the LightingForms `<select>` marks that default explicitly, not by accident', () => {
    // The audit's root cause was partly "no option carries `selected`, so the
    // browser picks the first one". Whatever the default is, it must be stated.
    const src = fs.readFileSync(
      path.join(ROOT, 'public', 'js', 'features', 'lighting', 'LightingForms.js'),
      'utf8'
    );
    const select = src.slice(src.indexOf('<select id="lrFormTrigger"'));
    const options = select.slice(0, select.indexOf('</select>'));
    const noteOn = options.split('\n').find((l) => l.includes('value="noteon"'));
    expect(noteOn).toBeDefined();
    // Selected when the rule says so AND when the rule says nothing (new rule).
    expect(noteOn).toMatch(/cond\.trigger === 'noteon' \|\| !cond\.trigger \? 'selected' : ''/);
    // …and exactly one option can be the default.
    const defaults = options
      .split('\n')
      .filter((l) => /!cond\.trigger \?/.test(l) && l.includes('<option'));
    expect(defaults.length).toBe(1);
  });

  test("off_action 'fade' on that default rule reaches the fade-out path", () => {
    const { manager, bus } = build([
      rule({
        condition_config: UI_DEFAULT_CONDITION,
        action_config: { ...UI_DEFAULT_ACTION, off_action: 'fade', fade_time_ms: 100 }
      })
    ]);
    bus.emit('midi_message', press(60));
    expect(manager.activeFades.size).toBe(0);
    bus.emit('midi_message', release(60));
    expect(manager.activeFades.size).toBe(1); // the release really was handled
  });

  test("off_action 'hold' still holds — the escape hatch is intact", () => {
    const { bus, driver } = build([
      rule({
        condition_config: UI_DEFAULT_CONDITION,
        action_config: { ...UI_DEFAULT_ACTION, off_action: 'hold' }
      })
    ]);
    bus.emit('midi_message', press(60));
    bus.emit('midi_message', release(60));
    expect(driver.of('setRange').length).toBe(1); // deliberately still lit
  });

  test('a Note On with velocity 0 (running status) counts as the release', () => {
    const { bus, driver } = build([
      rule({ condition_config: UI_DEFAULT_CONDITION, action_config: UI_DEFAULT_ACTION })
    ]);
    bus.emit('midi_message', press(60));
    bus.emit('midi_message', press(60, 0));
    expect(driver.of('setRange')[1]).toMatchObject({ brightness: 0 });
  });

  test('polyphony: the strip goes dark on the LAST release, not the first', () => {
    const { bus, driver } = build([
      rule({ condition_config: UI_DEFAULT_CONDITION, action_config: UI_DEFAULT_ACTION })
    ]);
    bus.emit('midi_message', press(60));
    bus.emit('midi_message', press(64));
    driver.reset();
    bus.emit('midi_message', release(60));
    expect(driver.of('setRange').filter((w) => w.brightness === 0).length).toBe(0);
    bus.emit('midi_message', release(64));
    expect(driver.of('setRange').filter((w) => w.brightness === 0).length).toBe(1);
  });
});

// ==========================================================================
// 2. The pairing is narrow: it must not hijack other rules
// ==========================================================================

describe('R22 — a release is only paired with a rule that lit that note', () => {
  test('a `cc` rule is not dragged into the note-off path', () => {
    const { bus, drivers } = build(
      [
        rule({ id: 1, device_id: 1, condition_config: { trigger: 'noteon' } }),
        // Same device, CC-driven: a release must not darken it.
        rule({ id: 2, device_id: 1, condition_config: { trigger: 'cc' } })
      ],
      [1]
    );
    const d = drivers.get(1);
    bus.emit('midi_message', press(60));
    const afterPress = d.calls.length;
    bus.emit('midi_message', release(60));
    // Exactly one extra write: the note rule's blackout, not two.
    expect(d.calls.length).toBe(afterPress + 1);
  });

  test('a `noteoff` rule keeps its own (unchanged) behaviour', () => {
    const { manager } = build([]);
    const r = rule({ condition_config: { trigger: 'noteoff' } });
    const norm = (t, d) => manager._normalizeMidiData(midiMessage(t, d));
    expect(manager._ruleMatches(r, norm('noteoff', { channel: 0, note: 60, velocity: 0 }))).toBe(
      true
    );
    expect(manager._ruleMatches(r, norm('noteon', { channel: 0, note: 60, velocity: 90 }))).toBe(
      false
    );
  });

  test('the release only pairs on the device the rule targets', () => {
    const { manager, bus, drivers } = build(
      [
        rule({ id: 1, device_id: 1, condition_config: { trigger: 'noteon' } }),
        rule({ id: 2, device_id: 2, condition_config: { trigger: 'noteon', note_min: 90 } })
      ],
      [1, 2]
    );
    bus.emit('midi_message', press(60)); // only device 1 lights
    expect(drivers.get(2).calls.length).toBe(0);
    drivers.get(1).reset();
    bus.emit('midi_message', release(60));
    expect(drivers.get(1).of('setRange').length).toBe(1); // darkened
    expect(drivers.get(2).calls.length).toBe(0); // untouched
    expect(manager.activeNotes.get(2)).toBeUndefined();
  });

  test('placement filters still apply to the release (channel, note range)', () => {
    const { manager } = build([]);
    const r = rule({ condition_config: { trigger: 'noteon', channels: [0], note_min: 60 } });
    manager._trackNoteOn(r.device_id, 64);
    const norm = (d) => manager._normalizeMidiData(midiMessage('noteoff', d));
    expect(manager._ruleMatches(r, norm({ channel: 0, note: 64, velocity: 0 }))).toBe(true);
    // Same held note, wrong channel → not this rule's release.
    expect(manager._ruleMatches(r, norm({ channel: 5, note: 64, velocity: 0 }))).toBe(false);
    // Held note outside the rule's range → not its release either.
    manager._trackNoteOn(r.device_id, 30);
    expect(manager._ruleMatches(r, norm({ channel: 0, note: 30, velocity: 0 }))).toBe(false);
  });

  test('F-31c: an unpaired release (server restarted key-down) still changes nothing', () => {
    // Deliberate: a release the engine never saw the attack of must not darken
    // a fixture a scene or a group command owns.
    const { bus, driver } = build([
      rule({ condition_config: UI_DEFAULT_CONDITION, action_config: UI_DEFAULT_ACTION })
    ]);
    bus.emit('midi_message', release(60));
    expect(driver.calls.length).toBe(0);
  });
});

// ==========================================================================
// 3. The safety net: tracking can never be dropped while a fixture is lit
// ==========================================================================

describe('R22 — the stale-note sweep darkens what it stops tracking', () => {
  test('clearing >16 stuck notes also switches the fixture off', () => {
    jest.useFakeTimers();
    try {
      const { manager, driver, logger } = build([
        rule({ condition_config: UI_DEFAULT_CONDITION, action_config: UI_DEFAULT_ACTION })
      ]);
      for (let n = 40; n < 60; n++) manager._trackNoteOn(1, n); // 20 notes held
      driver.reset();

      jest.advanceTimersByTime(10000); // the health check runs

      expect(manager.activeNotes.get(1).size).toBe(0);
      expect(driver.of('allOff').length).toBe(1); // not left lit with nobody tracking it
      expect(logger._rec.warn.join(' ')).toMatch(/Cleared stale activeNotes for device 1/);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a driver that throws during that sweep does not kill the timer callback', () => {
    jest.useFakeTimers();
    try {
      const { manager, driver, logger } = build([rule({})]);
      driver.throwOn.add('allOff');
      for (let n = 40; n < 60; n++) manager._trackNoteOn(1, n);
      expect(() => jest.advanceTimersByTime(10000)).not.toThrow();
      expect(logger._rec.warn.join(' ')).toMatch(/Stale-note blackout failed for device 1/);
    } finally {
      jest.useRealTimers();
    }
  });
});
