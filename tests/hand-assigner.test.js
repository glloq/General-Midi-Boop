// tests/hand-assigner.test.js
// HandAssigner: hand tagging logic for hand-position control.

import { describe, test, expect } from '@jest/globals';
import HandAssigner from '../src/midi/adaptation/HandAssigner.js';

const twoHands = {
  enabled: true,
  assignment: { mode: 'pitch_split', pitch_split_note: 60, pitch_split_hysteresis: 2 },
  hands: [{ id: 'left' }, { id: 'right' }]
};

const n = (time, note, extra = {}) => ({ time, note, ...extra });

describe('HandAssigner — pitch_split', () => {
  test('notes well below split go left, well above go right', () => {
    const a = new HandAssigner(twoHands);
    const { assignments, warnings } = a.assign([n(0, 48), n(1, 72)]);
    expect(assignments[0].hand).toBe('left');
    expect(assignments[1].hand).toBe('right');
    expect(warnings).toHaveLength(0);
  });

  test('notes inside hysteresis band emit warnings and stick to last hand', () => {
    const a = new HandAssigner(twoHands);
    const { assignments, warnings } = a.assign([n(0, 48), n(1, 60), n(2, 61)]);
    expect(assignments[0].hand).toBe('left');
    // 60 is at the split exactly, inside band → sticks to previous hand (left)
    expect(assignments[1].hand).toBe('left');
    expect(assignments[2].hand).toBe('left');
    expect(warnings.some(w => w.code === 'auto_split_ambiguous')).toBe(true);
  });

  test('pure above/below split gives no warnings', () => {
    const a = new HandAssigner(twoHands);
    const { warnings } = a.assign([n(0, 40), n(1, 80), n(2, 45), n(3, 75)]);
    expect(warnings).toHaveLength(0);
  });
});

describe('HandAssigner — track mode', () => {
  test('tracks mapped explicitly are respected', () => {
    const cfg = {
      enabled: true,
      assignment: { mode: 'track', track_map: { left: [1], right: [2] } },
      hands: [{ id: 'left' }, { id: 'right' }]
    };
    const a = new HandAssigner(cfg);
    const { assignments } = a.assign([n(0, 40, { track: 1 }), n(1, 80, { track: 2 })]);
    expect(assignments[0].hand).toBe('left');
    expect(assignments[1].hand).toBe('right');
  });

  test('unmapped track falls back to pitch split and flags a warning', () => {
    const cfg = {
      enabled: true,
      assignment: { mode: 'track', track_map: { left: [1], right: [2] }, pitch_split_note: 60 },
      hands: [{ id: 'left' }, { id: 'right' }]
    };
    const a = new HandAssigner(cfg);
    const { assignments, warnings } = a.assign([n(0, 40, { track: 99 })]);
    expect(assignments[0].hand).toBe('left'); // below 60 → left
    expect(warnings.some(w => w.code === 'auto_track_conflict')).toBe(true);
  });
});

describe('HandAssigner — auto mode', () => {
  test('promotes to track mode when multiple tracks present', () => {
    const cfg = {
      enabled: true,
      assignment: { mode: 'auto' },
      hands: [{ id: 'left' }, { id: 'right' }]
    };
    const a = new HandAssigner(cfg);
    const notes = [
      n(0, 40, { track: 1 }),
      n(1, 44, { track: 1 }),
      n(2, 72, { track: 2 }),
      n(3, 76, { track: 2 })
    ];
    const { assignments, resolvedMode } = a.assign(notes);
    expect(resolvedMode).toBe('track');
    expect(assignments[0].hand).toBe('left');
    expect(assignments[2].hand).toBe('right');
  });

  test('falls back to pitch split when no track info', () => {
    const cfg = {
      enabled: true,
      assignment: { mode: 'auto', pitch_split_note: 60 },
      hands: [{ id: 'left' }, { id: 'right' }]
    };
    const a = new HandAssigner(cfg);
    const { resolvedMode, assignments } = a.assign([n(0, 40), n(1, 80)]);
    expect(resolvedMode).toBe('pitch_split');
    expect(assignments[0].hand).toBe('left');
    expect(assignments[1].hand).toBe('right');
  });

  test('three-track song auto-splits extras toward nearest median', () => {
    const cfg = {
      enabled: true,
      assignment: { mode: 'auto' },
      hands: [{ id: 'left' }, { id: 'right' }]
    };
    const a = new HandAssigner(cfg);
    const notes = [
      ...[36, 40, 44].map((p, i) => n(i, p, { track: 0 })),         // lowest — left
      ...[55, 57, 59].map((p, i) => n(i + 10, p, { track: 1 })),    // middle — assigned by proximity
      ...[72, 76, 80].map((p, i) => n(i + 20, p, { track: 2 }))     // highest — right
    ];
    const { assignments, warnings } = a.assign(notes);
    expect(assignments.find(x => notes[x.idx].track === 0).hand).toBe('left');
    expect(assignments.find(x => notes[x.idx].track === 2).hand).toBe('right');
    // Middle track flagged as auto-assigned
    expect(warnings.some(w => w.code === 'auto_track_conflict')).toBe(true);
  });
});

describe('HandAssigner — single-hand shortcut', () => {
  test('one hand config tags every note to that hand', () => {
    const cfg = { enabled: true, hands: [{ id: 'left' }] };
    const a = new HandAssigner(cfg);
    const { assignments, resolvedMode } = a.assign([n(0, 40), n(1, 80)]);
    expect(resolvedMode).toBe('single_hand');
    expect(assignments.every(x => x.hand === 'left')).toBe(true);
  });
});

describe('HandAssigner — edge cases', () => {
  test('empty input returns empty output', () => {
    const a = new HandAssigner(twoHands);
    const { assignments, warnings } = a.assign([]);
    expect(assignments).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('null/undefined config still works (treated as empty)', () => {
    const a = new HandAssigner(null);
    // No hands defined and no single-hand shortcut → pitch_split path; both
    // notes end up on 'right' (default when no prior hand + note >= split).
    // We just assert it does not throw and produces assignments.
    expect(() => a.assign([n(0, 60)])).not.toThrow();
  });
});
