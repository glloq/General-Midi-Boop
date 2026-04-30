// tests/hand-assigner-n-hands.test.js
// HandAssigner: N-hand support (1 / 3 / 4) using the canonical h1..h4
// id scheme. Two-hand cases are still covered by hand-assigner.test.js.

import { describe, test, expect } from '@jest/globals';
import HandAssigner from '../src/midi/adaptation/HandAssigner.js';

const n = (time, note, extra = {}) => ({ time, note, ...extra });

describe('HandAssigner — N hands (h1..h4 ids)', () => {
  test('three hands: pitch_split with two ascending boundaries', () => {
    const cfg = {
      enabled: true,
      assignment: { mode: 'pitch_split', pitch_split_notes: [50, 70], pitch_split_hysteresis: 1 },
      hands: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }]
    };
    const a = new HandAssigner(cfg);
    const { assignments } = a.assign([n(0, 40), n(1, 60), n(2, 80)]);
    expect(assignments[0].hand).toBe('h1');
    expect(assignments[1].hand).toBe('h2');
    expect(assignments[2].hand).toBe('h3');
  });

  test('four hands: track mode honours every key in the map', () => {
    const cfg = {
      enabled: true,
      assignment: {
        mode: 'track',
        track_map: { h1: [0], h2: [1], h3: [2], h4: [3] }
      },
      hands: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }, { id: 'h4' }]
    };
    const a = new HandAssigner(cfg);
    const notes = [
      n(0, 40, { track: 0 }), n(1, 50, { track: 1 }),
      n(2, 70, { track: 2 }), n(3, 90, { track: 3 })
    ];
    const { assignments } = a.assign(notes);
    expect(assignments.map(x => x.hand)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  test('one hand: every note is tagged with that single id', () => {
    const a = new HandAssigner({ enabled: true, hands: [{ id: 'h1' }] });
    const { assignments, resolvedMode } = a.assign([n(0, 40), n(1, 80)]);
    expect(resolvedMode).toBe('single_hand');
    expect(assignments.every(x => x.hand === 'h1')).toBe(true);
  });

  test('auto with 4 tracks promotes to track mode and clusters by median', () => {
    const cfg = {
      enabled: true,
      assignment: { mode: 'auto' },
      hands: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }, { id: 'h4' }]
    };
    const a = new HandAssigner(cfg);
    const notes = [
      ...[36, 38].map((p, i) => n(i, p, { track: 0 })),       // lowest → h1
      ...[52, 54].map((p, i) => n(i + 10, p, { track: 1 })),  // → h2
      ...[68, 70].map((p, i) => n(i + 20, p, { track: 2 })),  // → h3
      ...[84, 86].map((p, i) => n(i + 30, p, { track: 3 }))   // → h4
    ];
    const { assignments, resolvedMode } = a.assign(notes);
    expect(resolvedMode).toBe('track');
    expect(assignments.find(x => notes[x.idx].track === 0).hand).toBe('h1');
    expect(assignments.find(x => notes[x.idx].track === 3).hand).toBe('h4');
  });

  test('legacy left/right ids still work alongside the new scheme', () => {
    const a = new HandAssigner({
      enabled: true,
      assignment: { mode: 'pitch_split', pitch_split_note: 60 },
      hands: [{ id: 'left' }, { id: 'right' }]
    });
    const { assignments } = a.assign([n(0, 40), n(1, 80)]);
    expect(assignments[0].hand).toBe('left');
    expect(assignments[1].hand).toBe('right');
  });
});
