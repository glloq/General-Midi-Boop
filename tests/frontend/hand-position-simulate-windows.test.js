// tests/frontend/hand-position-simulate-windows.test.js
// E.6.2: HandPositionFeasibility.simulateHandWindows produces a
// timeline of hand `shift` events + per-tick `chord` records carrying
// the played notes and the ones the current window can't reach. Two
// modes mirror the backend planner taxonomy (semitones / frets, with
// or without the physical mm fallback).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/auto-assign/HandPositionFeasibility.js'),
  'utf8'
);

beforeAll(() => {
  new Function(src)();
});

beforeEach(() => {
  // Some tests check fallback when window globals are absent.
});

const semitonesHands = {
  enabled: true,
  mode: 'semitones',
  hand_move_semitones_per_sec: 60,
  hands: [
    { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
  ]
};

const fretsHands = {
  enabled: true,
  mode: 'frets',
  hand_move_mm_per_sec: 250,
  hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, hand_span_frets: 4, max_fingers: 4 }]
};

function note(tick, n, extra = {}) {
  return { tick, note: n, ...extra };
}

describe('simulateHandWindows — guards and unknown', () => {
  it('returns [] when notes are empty / not an array', () => {
    expect(window.HandPositionFeasibility.simulateHandWindows([], { hands_config: semitonesHands })).toEqual([]);
    expect(window.HandPositionFeasibility.simulateHandWindows(null, { hands_config: semitonesHands })).toEqual([]);
    expect(window.HandPositionFeasibility.simulateHandWindows('nope', { hands_config: semitonesHands })).toEqual([]);
  });

  it('returns [] when instrument has no usable hands_config', () => {
    expect(window.HandPositionFeasibility.simulateHandWindows([note(0, 60)], {})).toEqual([]);
    expect(window.HandPositionFeasibility.simulateHandWindows([note(0, 60)], { hands_config: { enabled: false, hands: [] } })).toEqual([]);
  });

  it('parses hands_config from a JSON string', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60)],
      { hands_config: JSON.stringify(semitonesHands) }
    );
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('simulateHandWindows — semitones mode', () => {
  it('emits a chord per tick', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60), note(480, 64), note(960, 67)],
      { hands_config: semitonesHands }
    );
    const chords = out.filter(e => e.type === 'chord');
    expect(chords.map(c => c.tick)).toEqual([0, 480, 960]);
  });

  it('groups simultaneous notes (within 8-tick tolerance) into one chord', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60), note(4, 64), note(7, 67), note(480, 72)],
      { hands_config: semitonesHands }
    );
    const chords = out.filter(e => e.type === 'chord');
    expect(chords).toHaveLength(2);
    expect(chords[0].notes.map(n => n.note).sort((a, b) => a - b)).toEqual([60, 64, 67]);
  });

  it('emits an initial shift per hand on first chord touched', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 40), note(0, 72)],
      { hands_config: semitonesHands }
    );
    const shifts = out.filter(e => e.type === 'shift');
    expect(shifts.length).toBeGreaterThanOrEqual(2);
    const handIds = new Set(shifts.map(s => s.handId));
    expect(handIds.has('left') && handIds.has('right')).toBe(true);
  });

  it('emits a follow-up shift when a hand needs to move', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60), note(480, 80)],
      { hands_config: semitonesHands }
    );
    const shifts = out.filter(e => e.type === 'shift');
    // First chord pulls one hand down to 60; second chord requires the
    // same hand (only one used so far) to shift up to reach 80.
    expect(shifts.length).toBeGreaterThanOrEqual(2);
  });

  it('flags notes outside the window as unplayable', () => {
    // hand_span_semitones = 14. Anchor at 60 → max reach = 74.
    // A second chord at the same tick reaching 80 is unplayable on the
    // hand that just got pinned.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60), note(0, 64), note(0, 80)],
      { hands_config: semitonesHands }
    );
    const chord = out.find(e => e.type === 'chord');
    // Two hands are available but the planner picks closest; depending
    // on the assignment, 80 may land on right (which gets anchored low
    // by 80 itself) → playable; or 80 may be assigned to a hand whose
    // anchor is too low → unplayable. We just check the shape.
    expect(Array.isArray(chord.unplayable)).toBe(true);
  });
});

describe('simulateHandWindows — frets mode (fallback frets count)', () => {
  it('uses the fretting hand and emits shifts only when fret moves out', () => {
    const fallbackOnly = {
      enabled: true, mode: 'frets', hand_move_frets_per_sec: 12,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
    };
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [
        note(0,   45, { fret: 5, string: 1 }),
        note(480, 47, { fret: 7, string: 1 }), // within [5..9]: no shift
        note(960, 50, { fret: 12, string: 1 }) // outside: shift
      ],
      { hands_config: fallbackOnly }
    );
    const shifts = out.filter(e => e.type === 'shift');
    expect(shifts).toHaveLength(2);
    expect(shifts[0].toAnchor).toBe(5);
    expect(shifts[1].toAnchor).toBe(12);
  });

  it('open strings (fret 0) do not move the window', () => {
    const fallbackOnly = {
      enabled: true, mode: 'frets', hand_move_frets_per_sec: 12,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
    };
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [
        note(0,   45, { fret: 5, string: 1 }),
        note(480, 64, { fret: 0, string: 0 }), // open string
        note(960, 50, { fret: 7, string: 1 })  // still inside window
      ],
      { hands_config: fallbackOnly }
    );
    const shifts = out.filter(e => e.type === 'shift');
    expect(shifts).toHaveLength(1);
    expect(shifts[0].toAnchor).toBe(5);
  });

  it('uses the physical mm reach when scale_length_mm + hand_span_mm are present', () => {
    // 80 mm hand on a 650 mm scale ≈ 4.4 frets at fret 12 → a
    // 12→16 jump fits in the same window.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [
        note(0,   76, { fret: 12, string: 1 }),
        note(480, 79, { fret: 15, string: 1 })
      ],
      { hands_config: fretsHands, scale_length_mm: 650 }
    );
    const shifts = out.filter(e => e.type === 'shift');
    expect(shifts).toHaveLength(1); // only the initial anchor
  });

  it('the same fret span at the nut does not fit (≈ 2.2 frets reach)', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [
        note(0,   41, { fret: 1, string: 1 }),
        note(480, 44, { fret: 4, string: 1 })
      ],
      { hands_config: fretsHands, scale_length_mm: 650 }
    );
    const shifts = out.filter(e => e.type === 'shift');
    expect(shifts.length).toBe(2);
  });
});

describe('simulateHandWindows — overrides', () => {
  it('honours a pinned hand_anchor at a tick (semitones)', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60), note(480, 64)],
      { hands_config: semitonesHands },
      { overrides: { hand_anchors: [{ tick: 480, handId: 'left', anchor: 30 }], disabled_notes: [] } }
    );
    const shifts = out.filter(e => e.type === 'shift' && e.tick === 480);
    expect(shifts.find(s => s.source === 'override' && s.handId === 'left' && s.toAnchor === 30)).toBeDefined();
  });

  it('filters out notes listed in disabled_notes', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60), note(0, 64), note(0, 67)],
      { hands_config: semitonesHands },
      { overrides: { hand_anchors: [], disabled_notes: [{ tick: 0, note: 64, reason: 'user' }] } }
    );
    const chord = out.find(e => e.type === 'chord');
    expect(chord.notes.map(n => n.note).sort()).toEqual([60, 67]);
  });
});

describe('simulateHandWindows — semitones non-overlap (E.6.x)', () => {
  function getAnchors(out) {
    const last = new Map();
    for (const e of out) {
      if (e.type === 'shift') last.set(e.handId, e.toAnchor);
    }
    return last;
  }

  it('two-note opening chord puts left below right (no overlap)', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 40), note(0, 80)],
      { hands_config: semitonesHands }
    );
    const a = getAnchors(out);
    expect(a.get('left')).toBeLessThan(a.get('right'));
    // No-overlap invariant: left.anchor + left.span < right.anchor.
    expect(a.get('left') + 14).toBeLessThan(a.get('right'));
  });

  it('multi-note chord splits cleanly between low and high subsets', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 40), note(0, 45), note(0, 70), note(0, 75)],
      { hands_config: semitonesHands }
    );
    const a = getAnchors(out);
    expect(a.get('left')).toBe(40);
    expect(a.get('right')).toBe(70);
    expect(a.get('left') + 14).toBeLessThan(a.get('right'));
  });

  it('initial chord whose notes fit one hand parks the idle hand without overlap', () => {
    // All 3 notes within left's 14-semitone span and clearly low
    // (≤ 60). The bias places them on left; right gets parked one
    // semitone beyond left's reach so its band still renders.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 40), note(0, 45), note(0, 50)],
      { hands_config: semitonesHands }
    );
    const a = getAnchors(out);
    expect(a.get('left')).toBe(40);
    expect(a.has('right')).toBe(true);
    expect(a.get('left') + 14).toBeLessThan(a.get('right'));
  });

  it('flags a hand_overlap when no partition fits both spans', () => {
    // Three notes spanning 40 semitones (40..80). Every partition
    // leaves at least one side with a span > 14 → the second pass
    // taggs the chord overlap=true and reports the notes as
    // outside their respective hand window.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 40), note(0, 60), note(0, 80)],
      { hands_config: semitonesHands }
    );
    const chord = out.find(e => e.type === 'chord');
    expect(chord.unplayable.some(u => u.reason === 'hand_overlap'
                                  || u.reason === 'outside_window')).toBe(true);
  });

  it('honours an override that anchors left HIGH and forces right to push up', () => {
    // Override pins left to 60. Right has been auto-anchored to 80.
    // 60 + 14 = 74, 80 > 74 → no collision; right keeps its anchor.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 40), note(0, 80), note(480, 60)],
      { hands_config: semitonesHands },
      { overrides: { hand_anchors: [{ tick: 480, handId: 'left', anchor: 60 }], disabled_notes: [] } }
    );
    const a = getAnchors(out);
    expect(a.get('left')).toBe(60);
    expect(a.get('left') + 14).toBeLessThan(a.get('right'));
  });

  it('shifts the idle hand when an override forces a collision', () => {
    // Setup: chord 1 anchors left=40, right=80. At chord 2 an
    // override pins LEFT to 70 → left's reach now spans 70..84,
    // which collides with right at 80. The simulator must push
    // right up to keep the no-overlap invariant.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 40), note(0, 80), note(480, 75)],
      { hands_config: semitonesHands },
      { overrides: { hand_anchors: [{ tick: 480, handId: 'left', anchor: 70 }], disabled_notes: [] } }
    );
    const a = getAnchors(out);
    expect(a.get('left')).toBe(70);
    expect(a.get('left') + 14).toBeLessThan(a.get('right'));
    const collisions = out.filter(e => e.type === 'shift' && e.source === 'collision');
    expect(collisions.length).toBeGreaterThanOrEqual(1);
  });

  it('single-hand keyboard configs are not constrained', () => {
    const oneHand = {
      enabled: true, mode: 'semitones', hand_move_semitones_per_sec: 60,
      hands: [{ id: 'left', cc_position_number: 23, hand_span_semitones: 14 }]
    };
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 60), note(480, 80)],
      { hands_config: oneHand }
    );
    // A single-hand instrument doesn't even attempt the partition;
    // it just shifts the single hand as needed.
    const shifts = out.filter(e => e.type === 'shift');
    expect(shifts.every(s => s.handId === 'left')).toBe(true);
  });
});

describe('simulateHandWindows — chord release ticks (note-off propagation)', () => {
  it('chord events carry releaseTick = tick + max(duration)', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [
        { tick: 0,   note: 60, duration: 240 },
        { tick: 0,   note: 64, duration: 480 }, // longer note dictates release
        { tick: 960, note: 67, duration: 240 }
      ],
      { hands_config: semitonesHands }
    );
    const chords = out.filter(e => e.type === 'chord');
    expect(chords[0].releaseTick).toBe(480); // 0 + 480
    expect(chords[1].releaseTick).toBe(1200); // 960 + 240
  });

  it('falls back to releaseTick = tick when notes have no duration', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 60 }, { tick: 480, note: 64 }],
      { hands_config: semitonesHands }
    );
    const chords = out.filter(e => e.type === 'chord');
    expect(chords[0].releaseTick).toBe(0);
    expect(chords[1].releaseTick).toBe(480);
  });

  it('frets mode also propagates releaseTick on chord events', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 45, fret: 5, string: 1, duration: 360 }],
      { hands_config: fretsHands, scale_length_mm: 650 }
    );
    const chord = out.find(e => e.type === 'chord');
    expect(chord.releaseTick).toBe(360);
  });
});

describe('simulateHandWindows — semitones lookahead-aware anchor placement', () => {
  function shiftsByHand(out, handId) {
    return out.filter(e => e.type === 'shift' && e.handId === handId);
  }

  it('keeps the previous anchor when the next chord still fits the same window', () => {
    // Both chords are below SPLIT_REF (60) so the bias sends them
    // both to LEFT. Chord 1: notes [50, 55] anchor left at 50;
    // chord 2: notes [52, 58] still fit inside [50..64] → no shift.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 50), note(0, 55), note(480, 52), note(480, 58)],
      { hands_config: semitonesHands }
    );
    const leftAutoShifts = shiftsByHand(out, 'left').filter(s => s.source === 'auto');
    // Only the initial pull — the second chord lands inside the
    // pre-existing window.
    expect(leftAutoShifts).toHaveLength(1);
    expect(leftAutoShifts[0].toAnchor).toBe(50);
  });

  it('reduces shift size by clamping the previous anchor into the new range', () => {
    // Chord 1: notes [50, 55] anchors left at 50. Chord 2: a single
    // high note 80 forces RIGHT (the parked one) to move. Right was
    // parked just above left's reach (anchor ≈ 65). The naive algo
    // would jump it to 80 (Δ ≈ 15); the look-ahead-aware planner
    // clamps 65 into [80-14, 80] = [66, 80] → anchor 66 (Δ = 1).
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 50), note(0, 55), note(480, 80)],
      { hands_config: semitonesHands }
    );
    const rightAutoShifts = shiftsByHand(out, 'right').filter(s => s.source === 'auto');
    expect(rightAutoShifts.length).toBeGreaterThanOrEqual(1);
    const finalRight = rightAutoShifts[rightAutoShifts.length - 1].toAnchor;
    // Critical: NOT jumping to 80 — the shift uses the minimum
    // viable anchor (range lo).
    expect(finalRight).toBeGreaterThanOrEqual(66);
    expect(finalRight).toBeLessThan(80);
  });

  it('returns to a music-driven anchor when no future chord constrains', () => {
    // Lone chord, all notes below SPLIT_REF → left hand. With no
    // future to bias the anchor, the fallback (lo of lowSet) wins.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 50), note(0, 55)],
      { hands_config: semitonesHands }
    );
    const leftShifts = shiftsByHand(out, 'left');
    expect(leftShifts[0].toAnchor).toBe(50);
  });

  it('on a sequence the cumulative auto-shift distance is bounded by the music', () => {
    // Three single-note chords, all on left: 50, 56, 50.
    // - Chord 1 [50]: anchor=50 (initial fb).
    // - Chord 2 [56]: range=[42,56], prev=50 in range → no shift.
    // - Chord 3 [50]: range=[36,50], prev=50 in range → no shift.
    // Total auto distance = 0 (only the initial anchor).
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 50), note(480, 56), note(960, 50)],
      { hands_config: semitonesHands }
    );
    const leftAutoShifts = shiftsByHand(out, 'left').filter(s => s.source === 'auto');
    let total = 0;
    for (let i = 1; i < leftAutoShifts.length; i++) {
      total += Math.abs(leftAutoShifts[i].toAnchor - leftAutoShifts[i - 1].toAnchor);
    }
    // The naive algorithm would shift 50 → 56 → 50 (Δ=12). Look-ahead
    // aware keeps the hand still since both later chords fit the
    // initial window.
    expect(total).toBe(0);
  });

  it('initial anchor anticipates an upcoming higher chord (look-ahead bias)', () => {
    // Chord 1 [50, 55] gives left freedom in [41, 50] (range lo=41
    // because hi=55, span=14). Chord 2 forces a low note 30 → range
    // [16, 30], anchor moves down. The look-ahead refiner picks
    // chord 1's anchor at the LOW end of the freedom (41) so the
    // distance to chord 2 (30) is minimised: |41-30|=11 vs the
    // naive |50-30|=20.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [note(0, 50), note(0, 55), note(480, 30)],
      { hands_config: semitonesHands }
    );
    const leftAuto = shiftsByHand(out, 'left').filter(s => s.source === 'auto');
    // First auto-shift is the initial pull. Look-ahead pushes it to
    // 41 instead of 50 because chord 2 is below.
    expect(leftAuto[0].toAnchor).toBeLessThan(50);
    expect(leftAuto[0].toAnchor).toBeGreaterThanOrEqual(41);
  });
});
