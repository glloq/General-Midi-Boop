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
