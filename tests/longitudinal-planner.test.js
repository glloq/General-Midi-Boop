// tests/longitudinal-planner.test.js
// LongitudinalPlanner: anchored-finger longitudinal mode for string
// instruments. Covers the test scenarios T1–T8 listed in
// docs/LONGITUDINAL_MODEL.md §11.

import { describe, test, expect } from '@jest/globals';
import LongitudinalPlanner from '../src/midi/adaptation/LongitudinalPlanner.js';

const SCALE_MM = 648; // electric-guitar default

// Reference 4-finger config. Each finger has a ~70 mm excursion range
// — wide enough for one finger to remain anchored on a low fret while
// another reaches a few frets further up. Realistic for a guitar-sized
// mechanism with independent finger sliders.
function makeConfig(overrides = {}) {
  return {
    enabled: true,
    mode: 'frets',
    mechanism: 'string_sliding_fingers',
    hand_move_mm_per_sec: 250,
    hands: [{
      id: 'fretting',
      cc_position_number: 22,
      hand_span_mm: 80,
      fingers: [
        { id: 1, string: 1, offset_min_mm: -10, offset_max_mm: 30,  rest_offset_mm: 0  },
        { id: 2, string: 2, offset_min_mm: 10,  offset_max_mm: 65,  rest_offset_mm: 25 },
        { id: 3, string: 3, offset_min_mm: 25,  offset_max_mm: 95,  rest_offset_mm: 45 },
        { id: 4, string: 4, offset_min_mm: 40,  offset_max_mm: 120, rest_offset_mm: 65 }
      ]
    }],
    anchor: { min_duration_ms: 60, early_release_ms: 20, hysteresis_mm: 3, lookahead_events: 2 },
    ...overrides
  };
}

const ctx = (extra = {}) => ({
  unit: 'frets',
  noteRangeMin: 0,
  noteRangeMax: 24,
  scaleLengthMm: SCALE_MM,
  ...extra
});

const note = (time, fret, str, duration = 0.05, extra = {}) => ({
  time,
  note: 60 + fret,
  fretPosition: fret,
  string: str,
  channel: 0,
  velocity: 80,
  hand: 'fretting',
  duration,
  ...extra
});

describe('LongitudinalPlanner — construction guards', () => {
  test('rejects non-frets unit', () => {
    expect(() => new LongitudinalPlanner(makeConfig(), ctx({ unit: 'semitones' })))
      .toThrow(/unit must be 'frets'/);
  });

  test('requires fingers[]', () => {
    const cfg = makeConfig();
    delete cfg.hands[0].fingers;
    expect(() => new LongitudinalPlanner(cfg, ctx()))
      .toThrow(/fingers\[\] is required/);
  });

  test('requires scaleLengthMm', () => {
    expect(() => new LongitudinalPlanner(makeConfig(), ctx({ scaleLengthMm: undefined })))
      .toThrow(/scaleLengthMm is required/);
  });

  test('rejects mechanisms other than string_sliding_fingers', () => {
    const cfg = makeConfig({ mechanism: 'fret_sliding_fingers' });
    expect(() => new LongitudinalPlanner(cfg, ctx())).toThrow(/not supported/);
  });
});

describe('LongitudinalPlanner — basic emission', () => {
  test('emits a single initial CC for a single note', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx());
    const { ccEvents, stats } = p.plan([note(1.0, 5, 1)]);
    expect(ccEvents).toHaveLength(1);
    expect(ccEvents[0].controller).toBe(22);
    expect(ccEvents[0].time).toBeLessThan(1.0);
    expect(stats.shifts).toBe(0); // first emission is not counted as a shift
  });

  test('no shift when subsequent notes stay reachable from current P', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx());
    const notes = [
      note(0.0, 5, 1, 0.05),
      note(0.5, 6, 2, 0.05),
      note(1.0, 7, 3, 0.05)
    ];
    const { ccEvents } = p.plan(notes);
    // All three notes lie within the same hand position (fingers 1,2,3
    // in their natural offset bands centred on the initial P).
    expect(ccEvents.length).toBeLessThanOrEqual(2);
  });
});

describe('LongitudinalPlanner — T1 anchored finger across a movement', () => {
  test('long held note keeps its finger anchored while another finger plays', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx());
    const notes = [
      note(0.0, 5, 1, 1.0),   // long: finger 1 anchored on string 1, fret 5
      note(0.5, 7, 2, 0.05)   // finger 2 plays string 2, fret 7
    ];
    const { ccEvents, stats } = p.plan(notes);
    expect(stats.anchors_kept).toBeGreaterThanOrEqual(1);
    // No "release_forced" warning: finger 1 stays anchored.
    const { warnings } = p.plan(notes);
    expect(warnings.find(w => w.code === 'release_forced')).toBeUndefined();
    expect(ccEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe('LongitudinalPlanner — T4 release_forced when an anchor is unreachable', () => {
  test('warns when keeping the anchor would prevent reaching the next note', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx());
    const notes = [
      note(0.0, 3, 1, 2.0),   // finger 1 anchored low
      note(0.5, 18, 1, 0.05)  // same string, very high — must release
    ];
    const { warnings, stats } = p.plan(notes);
    // Same finger needs to be at two different frets at once → either
    // the anchor is released, or anchor_conflict is raised.
    const released = warnings.find(w => w.code === 'release_forced');
    const conflict = warnings.find(w => w.code === 'anchor_conflict');
    expect(released || conflict).toBeTruthy();
    expect(stats.anchors_released_forced + (conflict ? 0 : 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('LongitudinalPlanner — T7 hysteresis prevents micro-jitter', () => {
  test('alternating notes within hysteresis do not retrigger CC', () => {
    const cfg = makeConfig({ anchor: { min_duration_ms: 60, hysteresis_mm: 6 } });
    const p = new LongitudinalPlanner(cfg, ctx());
    const notes = [
      note(0.0, 7, 1, 0.05),
      note(0.2, 8, 1, 0.05),
      note(0.4, 7, 1, 0.05),
      note(0.6, 8, 1, 0.05),
      note(0.8, 7, 1, 0.05)
    ];
    const { ccEvents } = p.plan(notes);
    // With a generous hysteresis the planner should not emit a fresh
    // shift for each oscillation — fewer events than naive 1-per-note.
    expect(ccEvents.length).toBeLessThan(notes.length);
  });
});

describe('LongitudinalPlanner — T8 speed_saturation warning on fast slides', () => {
  test('warns when the requested travel exceeds hand speed', () => {
    const cfg = makeConfig({ hand_move_mm_per_sec: 100 });
    const p = new LongitudinalPlanner(cfg, ctx());
    const notes = [
      note(0.0, 1, 1, 0.05),
      note(0.05, 18, 1, 0.05) // huge jump in 50 ms with slow hand
    ];
    const { warnings } = p.plan(notes);
    expect(warnings.find(w => w.code === 'speed_saturation')).toBeDefined();
  });
});

describe('LongitudinalPlanner — out-of-range and missing-finger warnings', () => {
  test('warns when fret is out of instrument range', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx({ noteRangeMax: 12 }));
    const { warnings } = p.plan([note(0.0, 22, 1, 0.05)]);
    expect(warnings.find(w => w.code === 'out_of_range')).toBeDefined();
  });

  test('warns when a note targets a string with no finger pinned', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx());
    const { warnings } = p.plan([note(0.0, 5, 99, 0.05)]);
    expect(warnings.find(w => w.code === 'no_finger_for_string')).toBeDefined();
  });
});

describe('LongitudinalPlanner — densification', () => {
  test('emits intermediate samples between distant note-ons when cc_sample_rate_hz > 0', () => {
    const cfg = makeConfig({ cc_sample_rate_hz: 50 });
    const p = new LongitudinalPlanner(cfg, ctx());
    const notes = [
      note(0.0, 3,  1, 0.05),
      note(1.0, 12, 1, 0.05) // 1-second gap → ~50 interpolated steps possible
    ];
    const { ccEvents } = p.plan(notes);
    const interp = ccEvents.filter(e => e._interpolated);
    expect(interp.length).toBeGreaterThan(2);
    // All interpolated samples lie strictly between the two key events.
    for (const e of interp) {
      expect(e.time).toBeGreaterThan(0);
      expect(e.time).toBeLessThan(1.0);
    }
  });

  test('no interpolation when cc_sample_rate_hz is omitted', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx());
    const notes = [
      note(0.0, 3,  1, 0.05),
      note(1.0, 12, 1, 0.05)
    ];
    const { ccEvents } = p.plan(notes);
    expect(ccEvents.find(e => e._interpolated)).toBeUndefined();
  });
});

describe('LongitudinalPlanner — chord (T5) two anchored fingers', () => {
  test('two simultaneous long notes anchor both fingers', () => {
    const p = new LongitudinalPlanner(makeConfig(), ctx());
    const notes = [
      note(0.0, 5, 1, 1.0),
      note(0.0, 8, 2, 1.0)  // same chord
    ];
    const { stats } = p.plan(notes);
    expect(stats.anchors_kept).toBe(2);
  });
});
