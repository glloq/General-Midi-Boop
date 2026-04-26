// tests/hand-position-planner.test.js
// HandPositionPlanner: CC emission + feasibility warnings.

import { describe, test, expect } from '@jest/globals';
import HandPositionPlanner from '../src/midi/adaptation/HandPositionPlanner.js';

// Simplified per-hand shape: only CC + span. Travel speed is shared in
// the root config; reachable range and min-interval come via the
// instrument context passed as second constructor arg.
const pianoCfg = {
  enabled: true,
  hand_move_semitones_per_sec: 60,
  hands: [
    { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
  ]
};
// Full 88-key piano range so anchor-logic tests don't hit the clamp.
const pianoCtx = { noteRangeMin: 21, noteRangeMax: 108, minNoteIntervalMs: 40 };

const note = (time, pitch, hand, extra = {}) => ({
  time, note: pitch, channel: 0, velocity: 80, hand, ...extra
});

describe('HandPositionPlanner — basic emission', () => {
  test('emits initial CC just before first note per hand', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const { ccEvents } = p.plan([note(1.0, 40, 'left'), note(1.0, 72, 'right')]);
    // One CC per hand.
    expect(ccEvents).toHaveLength(2);
    const left = ccEvents.find(e => e.hand === 'left');
    const right = ccEvents.find(e => e.hand === 'right');
    expect(left.controller).toBe(23);
    expect(left.value).toBe(40);
    expect(left.time).toBeLessThan(1.0);
    expect(right.controller).toBe(24);
    expect(right.value).toBe(72);
    expect(right.time).toBeLessThan(1.0);
  });

  test('no CC shift when consecutive notes stay inside the window', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const notes = [
      note(0.0, 48, 'left'),
      note(0.5, 52, 'left'),
      note(1.0, 55, 'left'),
      note(1.5, 60, 'left')
    ];
    const { ccEvents, stats } = p.plan(notes);
    expect(ccEvents).toHaveLength(1);
    expect(stats.shifts.left).toBe(1);
  });

  test('shifts window when next note goes above span', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const notes = [
      note(0.0, 48, 'left'),
      note(2.0, 70, 'left')  // +22 semitones > span 14 → shift
    ];
    const { ccEvents, stats } = p.plan(notes);
    expect(ccEvents).toHaveLength(2);
    expect(stats.shifts.left).toBe(2);
    expect(ccEvents[1].value).toBe(70);
  });

  test('shift for a chord anchors so the chord fits at the top of the window', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const notes = [
      note(0.0, 40, 'left'),
      note(5.0, 62, 'left'),
      note(5.0, 68, 'left')
    ];
    const { ccEvents } = p.plan(notes);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents[1].value).toBe(62);
  });

  test('shifts window when next note goes below window', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const notes = [
      note(0.0, 60, 'left'),
      note(2.0, 40, 'left')
    ];
    const { ccEvents } = p.plan(notes);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents[1].value).toBe(40);
  });

  test('CC value is always the anchor lowest note, raw (0-127)', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const { ccEvents } = p.plan([note(0, 21, 'left')]);
    expect(ccEvents[0].value).toBe(21);
  });
});

describe('HandPositionPlanner — chord handling', () => {
  test('simultaneous notes on same hand merge into one chord group', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const chord = [48, 52, 55].map(pitch => note(0, pitch, 'left'));
    const { ccEvents, stats } = p.plan(chord);
    expect(ccEvents).toHaveLength(1);
    expect(stats.shifts.left).toBe(1);
    expect(ccEvents[0].value).toBe(48);
  });

  test('interleaved L/R at same time produces two CCs (one per hand)', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const events = [
      note(0, 40, 'left'),
      note(0, 72, 'right'),
      note(0, 45, 'left'),
      note(0, 76, 'right')
    ];
    const { ccEvents } = p.plan(events);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents.find(e => e.hand === 'left').value).toBe(40);
    expect(ccEvents.find(e => e.hand === 'right').value).toBe(72);
  });

  test('chord wider than span flags chord_span_exceeded', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const events = [
      note(0, 40, 'left'),
      note(0, 60, 'left')  // span 20 > 14
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'chord_span_exceeded')).toBe(true);
  });
});

describe('HandPositionPlanner — feasibility warnings', () => {
  test('move_too_fast fires when shift does not fit in available time', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    // 20-semitone shift at 60 semitones/sec needs 333ms. We give 50ms.
    const events = [
      note(0.0, 40, 'left'),
      note(0.05, 60, 'left')
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'move_too_fast')).toBe(true);
  });

  test('move_too_fast does not fire when there is enough time', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const events = [
      note(0.0, 40, 'left'),
      note(5.0, 60, 'left')
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'move_too_fast')).toBe(false);
  });

  test('finger_interval_violated fires when two notes are closer than min_note_interval', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const events = [
      note(0.000, 48, 'left'),
      note(0.010, 50, 'left')  // 10ms < 40ms min
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'finger_interval_violated')).toBe(true);
  });

  test('finger_interval check is disabled when instrument has no min_note_interval', () => {
    const p = new HandPositionPlanner(pianoCfg, { noteRangeMin: 21, noteRangeMax: 108 });
    const events = [
      note(0.000, 48, 'left'),
      note(0.001, 50, 'left')
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'finger_interval_violated')).toBe(false);
  });

  test('out_of_range fires for notes outside instrument reach', () => {
    const ctx = { noteRangeMin: 21, noteRangeMax: 72 };
    const cfg = {
      enabled: true,
      hand_move_semitones_per_sec: 60,
      hands: [{ id: 'left', cc_position_number: 23, hand_span_semitones: 14 }]
    };
    const p = new HandPositionPlanner(cfg, ctx);
    const events = [
      note(0, 20, 'left'),  // below min 21
      note(1, 80, 'left')   // above max 72
    ];
    const { warnings } = p.plan(events);
    const codes = warnings.map(w => w.code);
    expect(codes.filter(c => c === 'out_of_range').length).toBe(2);
  });
});

describe('HandPositionPlanner — clamp to instrument range', () => {
  const cfg = {
    enabled: true,
    hand_move_semitones_per_sec: 60,
    hands: [{ id: 'left', cc_position_number: 23, hand_span_semitones: 14 }]
  };

  test('CC anchor is clamped below noteRangeMin', () => {
    const p = new HandPositionPlanner(cfg, { noteRangeMin: 40, noteRangeMax: 60 });
    const { ccEvents, warnings } = p.plan([
      { time: 0, note: 30, channel: 0, velocity: 80, hand: 'left' }
    ]);
    expect(ccEvents[0].value).toBe(40);
    expect(warnings.some(w => w.code === 'out_of_range')).toBe(true);
  });

  test('CC anchor is clamped so window top stays <= noteRangeMax', () => {
    const p = new HandPositionPlanner(cfg, { noteRangeMin: 40, noteRangeMax: 60 });
    const { ccEvents, warnings } = p.plan([
      { time: 0, note: 70, channel: 0, velocity: 80, hand: 'left' }
    ]);
    // 70 alone would anchor at 70, but 70+14=84 > max 60 → clamp to 60-14=46.
    expect(ccEvents[0].value).toBe(46);
    expect(warnings.some(w => w.code === 'out_of_range')).toBe(true);
  });

  test('clamping never drops below noteRangeMin', () => {
    const p = new HandPositionPlanner(cfg, { noteRangeMin: 60, noteRangeMax: 65 });
    const { ccEvents } = p.plan([
      { time: 0, note: 80, channel: 0, velocity: 80, hand: 'left' }
    ]);
    expect(ccEvents[0].value).toBeGreaterThanOrEqual(60);
  });
});

describe('HandPositionPlanner — CC emission timing', () => {
  test('subsequent shift CC is scheduled right after previous note-on', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const events = [
      note(1.0, 40, 'left'),
      note(5.0, 70, 'left')
    ];
    const { ccEvents } = p.plan(events);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents[1].time).toBeGreaterThan(1.0);
    expect(ccEvents[1].time).toBeLessThan(1.01);
  });

  test('first CC per hand is emitted just before the first note', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const events = [note(2.0, 60, 'left')];
    const { ccEvents } = p.plan(events);
    expect(ccEvents[0].time).toBeLessThan(2.0);
    expect(ccEvents[0].time).toBeGreaterThan(1.99);
  });
});

// -----------------------------------------------------------------------------
// frets mode: a single fretting hand, axis = absolute fret number, travel in
// frets/sec. Input events carry `fretPosition` instead of using `note`.
// -----------------------------------------------------------------------------

const guitarCfg = {
  enabled: true,
  mode: 'frets',
  hand_move_frets_per_sec: 12,
  hands: [
    { id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }
  ]
};
// Standard 22-fret guitar: axis is [0, 22].
const guitarCtx = { unit: 'frets', noteRangeMin: 0, noteRangeMax: 22 };

const fretNote = (time, fret, extra = {}) => ({
  time,
  note: 60, // unused in frets mode but required by other code paths
  fretPosition: fret,
  channel: 0,
  velocity: 80,
  hand: 'fretting',
  ...extra
});

describe('HandPositionPlanner — frets mode', () => {
  test('emits initial CC just before first fretted note', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    const { ccEvents } = p.plan([fretNote(1.0, 5)]);
    expect(ccEvents).toHaveLength(1);
    expect(ccEvents[0].controller).toBe(22);
    expect(ccEvents[0].value).toBe(5);
    expect(ccEvents[0].time).toBeLessThan(1.0);
    expect(ccEvents[0].hand).toBe('fretting');
  });

  test('no shift while consecutive frets stay inside the span', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    const { ccEvents, stats } = p.plan([
      fretNote(0.0, 5),
      fretNote(0.5, 6),
      fretNote(1.0, 8),
      fretNote(1.5, 9) // window [5..9], span 4
    ]);
    expect(ccEvents).toHaveLength(1);
    expect(stats.shifts.fretting).toBe(1);
  });

  test('shifts window upward when next fret exceeds span', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    const { ccEvents } = p.plan([
      fretNote(0.0, 5),
      fretNote(2.0, 15)
    ]);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents[1].value).toBe(15);
  });

  test('shifts window downward when next fret is below current window', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    const { ccEvents } = p.plan([
      fretNote(0.0, 10),
      fretNote(2.0, 2)
    ]);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents[1].value).toBe(2);
  });

  test('CC value for an isolated open string is 0 when not filtered upstream', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    const { ccEvents } = p.plan([fretNote(0, 0)]);
    expect(ccEvents[0].value).toBe(0);
  });

  test('events without fretPosition are skipped (grouping safety)', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    const { ccEvents } = p.plan([
      { time: 0, note: 60, channel: 0, velocity: 80, hand: 'fretting' }, // no fretPosition
      fretNote(1, 7)
    ]);
    expect(ccEvents).toHaveLength(1);
    expect(ccEvents[0].value).toBe(7);
  });

  test('chord wider than hand_span_frets flags chord_span_exceeded', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    const { warnings } = p.plan([
      fretNote(0, 3),
      fretNote(0, 10) // chord span 7 > 4
    ]);
    expect(warnings.some(w => w.code === 'chord_span_exceeded')).toBe(true);
    expect(warnings.find(w => w.code === 'chord_span_exceeded').message).toMatch(/frets/);
  });

  test('move_too_fast reports frets unit and fires when shift is too fast', () => {
    const p = new HandPositionPlanner(guitarCfg, guitarCtx);
    // 15 frets shift at 12 frets/sec needs 1250ms; we give 50ms.
    const { warnings } = p.plan([
      fretNote(0.0, 2),
      fretNote(0.05, 20)
    ]);
    const mtf = warnings.find(w => w.code === 'move_too_fast');
    expect(mtf).toBeDefined();
    expect(mtf.message).toMatch(/frets/);
  });

  test('out_of_range fires for fret above instrument max', () => {
    const p = new HandPositionPlanner(guitarCfg, { unit: 'frets', noteRangeMin: 0, noteRangeMax: 12 });
    const { warnings } = p.plan([fretNote(0, 18)]);
    const oor = warnings.find(w => w.code === 'out_of_range');
    expect(oor).toBeDefined();
    expect(oor.message).toMatch(/Fret 18/);
  });

  test('fretless (float positions) produces rounded CC values', () => {
    const p = new HandPositionPlanner(guitarCfg, { unit: 'frets', noteRangeMin: 0, noteRangeMax: 24 });
    const { ccEvents } = p.plan([fretNote(0, 3.4), fretNote(2, 8.6)]);
    expect(ccEvents.map(e => e.value)).toEqual([3, 9]);
  });

  test('semitones fields on a frets config are ignored (unit is explicit)', () => {
    const cfg = {
      ...guitarCfg,
      // stray semitones fields should have no effect
      hand_move_semitones_per_sec: 60,
      hands: [
        { id: 'fretting', cc_position_number: 22, hand_span_frets: 4, hand_span_semitones: 14 }
      ]
    };
    const p = new HandPositionPlanner(cfg, guitarCtx);
    const { ccEvents } = p.plan([
      fretNote(0, 3),
      fretNote(2, 9) // within 4 frets? 9-3=6 > 4 → shift
    ]);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents[1].value).toBe(9);
  });
});

// -----------------------------------------------------------------------------
// frets mode — PHYSICAL model. When the context provides scaleLengthMm and
// the hand carries hand_span_mm + hand_move_mm_per_sec, the planner switches
// from constant-fret span to a position-dependent reach derived from
// equal-temperament geometry. A 80 mm hand on a 650 mm scale covers ~2.2
// frets at fret 1 and ~4.4 frets at fret 12.
// -----------------------------------------------------------------------------

const guitarPhysCfg = {
  enabled: true,
  mode: 'frets',
  hand_move_mm_per_sec: 250,
  hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
};
const guitarPhysCtx = {
  unit: 'frets',
  scaleLengthMm: 650,
  noteRangeMin: 0,
  noteRangeMax: 22
};

describe('HandPositionPlanner — frets mode (physical model)', () => {
  test('initial CC value is the lowest fret as usual', () => {
    const p = new HandPositionPlanner(guitarPhysCfg, guitarPhysCtx);
    const { ccEvents } = p.plan([fretNote(0, 5)]);
    expect(ccEvents).toHaveLength(1);
    expect(ccEvents[0].value).toBe(5);
  });

  test('low-position hand covers fewer frets than high-position hand', () => {
    // A 4-fret jump near the nut should force a shift (~2 fret reach).
    const pLow = new HandPositionPlanner(guitarPhysCfg, guitarPhysCtx);
    const lowPlan = pLow.plan([fretNote(0, 1), fretNote(2, 4)]);
    expect(lowPlan.ccEvents).toHaveLength(2);
    expect(lowPlan.stats.shifts.fretting).toBe(2);

    // The same 3-fret jump near fret 12 stays inside the same window
    // (~4.4 fret reach), so only one CC is emitted.
    const pHigh = new HandPositionPlanner(guitarPhysCfg, guitarPhysCtx);
    const highPlan = pHigh.plan([fretNote(0, 12), fretNote(2, 15)]);
    expect(highPlan.ccEvents).toHaveLength(1);
    expect(highPlan.stats.shifts.fretting).toBe(1);
  });

  test('shift-up anchor for a chord lands below chordHigh so the chord fits', () => {
    const planner = new HandPositionPlanner(guitarPhysCfg, guitarPhysCtx);
    const { ccEvents } = planner.plan([
      fretNote(0, 1),                  // initial anchor near nut
      fretNote(2, 12), fretNote(2, 15) // chord: low=12, high=15
    ]);
    expect(ccEvents).toHaveLength(2);
    // Anchor must cover both 12 and 15. With ~4.4 frets reach at fret 12,
    // anchor 12 covers up to ~16 → fits. So newLow = chordLow = 12.
    expect(ccEvents[1].value).toBe(12);
  });

  test('chord_span_exceeded reports mm + approx frets at anchor', () => {
    // 80 mm hand. d(0, 5) on L=650 ≈ 168 mm, well beyond 80 mm.
    const planner = new HandPositionPlanner(guitarPhysCfg, guitarPhysCtx);
    const { warnings } = planner.plan([fretNote(0, 0), fretNote(0, 5)]);
    const w = warnings.find(x => x.code === 'chord_span_exceeded');
    expect(w).toBeDefined();
    expect(w.spanMm).toBeGreaterThan(80);
    expect(w.handMm).toBe(80);
    expect(w.atFret).toBe(0);
    expect(w.approxFrets).toBeGreaterThan(0);
    expect(w.message).toMatch(/mm/);
  });

  test('move_too_fast carries travelMm and ms metrics', () => {
    // 250 mm/s. Distance(0,12) on 650 mm ≈ 325 mm → needs ~1.3s; we give 50ms.
    const planner = new HandPositionPlanner(guitarPhysCfg, guitarPhysCtx);
    const { warnings } = planner.plan([
      fretNote(0.0, 0),
      fretNote(0.05, 14)
    ]);
    const w = warnings.find(x => x.code === 'move_too_fast');
    expect(w).toBeDefined();
    expect(w.travelMm).toBeGreaterThan(80);
    expect(w.requiredMs).toBeGreaterThan(w.availableMs);
    expect(w.message).toMatch(/mm/);
  });

  test('falls back to fret-count model when scaleLengthMm is missing', () => {
    const cfgFallback = {
      enabled: true,
      mode: 'frets',
      hand_move_frets_per_sec: 12,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4, hand_span_mm: 80 }]
    };
    const ctxFallback = { unit: 'frets', noteRangeMin: 0, noteRangeMax: 22 };
    const planner = new HandPositionPlanner(cfgFallback, ctxFallback);
    // Constant 4-fret span: a 0→3 jump fits, a 0→5 jump shifts.
    const { ccEvents: nofit } = planner.plan([fretNote(0, 0), fretNote(2, 5)]);
    expect(nofit).toHaveLength(2);
  });

  test('falls back when hand_span_mm is missing on the hand', () => {
    const cfg = {
      enabled: true,
      mode: 'frets',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
    };
    const planner = new HandPositionPlanner(cfg, guitarPhysCtx);
    // Behaves as constant 4-fret span.
    const { ccEvents } = planner.plan([fretNote(0, 12), fretNote(2, 15)]);
    expect(ccEvents).toHaveLength(1);
  });

  test('too_many_fingers fires when chord exceeds max_fingers', () => {
    const cfg = {
      enabled: true,
      mode: 'frets',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, max_fingers: 3 }]
    };
    const planner = new HandPositionPlanner(cfg, guitarPhysCtx);
    const { warnings } = planner.plan([
      fretNote(0, 5),
      fretNote(0, 5),
      fretNote(0, 6),
      fretNote(0, 7)  // 4 fretted notes, max 3
    ]);
    const w = warnings.find(x => x.code === 'too_many_fingers');
    expect(w).toBeDefined();
    expect(w.count).toBe(4);
    expect(w.limit).toBe(3);
  });

  test('open strings (fret 0) do not consume a finger', () => {
    const cfg = {
      enabled: true,
      mode: 'frets',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, max_fingers: 2 }]
    };
    const planner = new HandPositionPlanner(cfg, guitarPhysCtx);
    const { warnings } = planner.plan([
      fretNote(0, 5),
      fretNote(0, 5),
      fretNote(0, 0),  // open
      fretNote(0, 0)   // open
    ]);
    expect(warnings.some(w => w.code === 'too_many_fingers')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Anchor floor: in the physical (mm) frets-mode model, the leftmost finger
// cannot sit more than 10 mm behind fret 1. This widens the high-fret reach
// for a fixed hand width while still letting fret 1 be played.
// -----------------------------------------------------------------------------

describe('HandPositionPlanner — physical anchor floor (10 mm before fret 1)', () => {
  const cfg = {
    enabled: true,
    mode: 'frets',
    hand_move_mm_per_sec: 250,
    hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
  };
  const ctx = { unit: 'frets', scaleLengthMm: 650, noteRangeMin: 0, noteRangeMax: 22 };

  test('exposes the floor as a fret-equivalent value > 0', () => {
    const p = new HandPositionPlanner(cfg, ctx);
    // For L=650 mm: fret 1 ≈ 36.5 mm from nut. 10 mm before fret 1 ≈
    // 26.5 mm → ~0.72 frets. The floor must be strictly positive but
    // less than 1 fret so fret 1 stays reachable.
    expect(p._physical).not.toBeNull();
    expect(p._physical.minAnchorFret).toBeGreaterThan(0);
    expect(p._physical.minAnchorFret).toBeLessThan(1);
  });

  test('forces an open-string-only chord to anchor at the floor, never below it', () => {
    const p = new HandPositionPlanner(cfg, ctx);
    // A note at fret 0 (open). The planner used to anchor at 0; with
    // the floor it lifts the anchor forward.
    const { ccEvents } = p.plan([fretNote(0, 0)]);
    expect(ccEvents).toHaveLength(1);
    const floor = p._physical.minAnchorFret;
    // CC value is rounded; at L=650 the floor rounds to 1 (≈ 0.72).
    expect(ccEvents[0].value).toBe(Math.max(0, Math.round(floor)));
  });

  test('floor still allows fret 1 to be played in the same window', () => {
    const p = new HandPositionPlanner(cfg, ctx);
    // Anchor at the floor (~0.72 fret); reach with a 80 mm hand on a
    // 650 mm scale extends well past fret 1.
    const { ccEvents, warnings } = p.plan([fretNote(0, 1)]);
    expect(ccEvents).toHaveLength(1);
    // No out_of_range / chord_span_exceeded — fret 1 fits the window.
    expect(warnings.filter(w => w.code === 'out_of_range')).toHaveLength(0);
    expect(warnings.filter(w => w.code === 'chord_span_exceeded')).toHaveLength(0);
  });

  test('floor is not applied in non-physical (constant-fret) mode', () => {
    // No scale length → physical model not built → no floor.
    const cfgFallback = {
      enabled: true,
      mode: 'frets',
      hand_move_frets_per_sec: 12,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
    };
    const p = new HandPositionPlanner(cfgFallback, { unit: 'frets', noteRangeMin: 0, noteRangeMax: 22 });
    expect(p._physical).toBeNull();
    const { ccEvents } = p.plan([fretNote(0, 0)]);
    // Anchor stays at 0 (the chord's lowest fret), no implicit floor.
    expect(ccEvents[0].value).toBe(0);
  });
});

describe('HandPositionPlanner — edge cases', () => {
  test('empty notes list returns empty plan', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const { ccEvents, warnings } = p.plan([]);
    expect(ccEvents).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('note with unknown hand id is skipped (defensive)', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const { ccEvents } = p.plan([note(0, 60, 'middle')]);
    expect(ccEvents).toHaveLength(0);
  });

  test('velocity-0 note-ons (logical note-offs) are ignored', () => {
    const p = new HandPositionPlanner(pianoCfg, pianoCtx);
    const events = [
      { time: 0, note: 60, hand: 'right', channel: 0, velocity: 0 }
    ];
    const { ccEvents } = p.plan(events);
    expect(ccEvents).toHaveLength(0);
  });
});
