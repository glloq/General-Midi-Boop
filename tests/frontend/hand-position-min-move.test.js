// tests/frontend/hand-position-min-move.test.js
// Verifies the simulator produces minimum-displacement shifts in
// every hand-count branch:
//   - 1-hand semitones (sameHand path in _simulateSemitones)
//   - 2-hand semitones (cost-based partition, untouched)
//   - 3+ hand semitones (N-way partition in _simulateSemitonesNHands)
//
// The historical bug: all paths except 2-hand snapped the new anchor
// to `lo` (chord bottom) regardless of direction, overshooting upward
// shifts by `(hi - lo)` semitones. The N-hand path additionally
// piled the entire opening chord onto h1 because its greedy "Pass 2"
// distance was zero for every uninitialised hand.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

beforeAll(() => {
  const src = readFileSync(
    resolve(__dirname, '../../public/js/features/auto-assign/HandPositionFeasibility.js'),
    'utf8'
  );
  new Function(src)();
});

const span14 = 14;

function oneHand() {
  return {
    enabled: true, mode: 'semitones',
    hands: [{ id: 'left', cc_position_number: 23, hand_span_semitones: span14 }]
  };
}
function twoHand() {
  return {
    enabled: true, mode: 'semitones',
    hands: [
      { id: 'left',  cc_position_number: 23, hand_span_semitones: span14 },
      { id: 'right', cc_position_number: 24, hand_span_semitones: span14 }
    ]
  };
}
function nHand(K) {
  return {
    enabled: true, mode: 'semitones',
    hands: Array.from({ length: K }, (_, i) => ({
      id: `h${i + 1}`, cc_position_number: 20 + i, hand_span_semitones: span14
    }))
  };
}

function realShifts(out) {
  return out.filter(e => e.type === 'shift'
                      && e.fromAnchor !== null
                      && e.fromAnchor !== e.toAnchor);
}
function chordAt(out, tick) {
  return out.find(e => e.type === 'chord' && e.tick === tick);
}

describe('1-hand semitones — minimum-displacement shifts', () => {
  it('upward shift uses hi − span (not lo)', () => {
    // anchor 60 (covers 60..74); next chord 70..80 (range 10 ≤ span).
    // Optimal anchor: 80 − 14 = 66 (distance 6).
    // Buggy: anchor = lo = 70 (distance 10).
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 60 }, { tick: 480, note: 70 }, { tick: 480, note: 80 }],
      { hands_config: oneHand() }
    );
    const shifts = realShifts(out);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].handId).toBe('left');
    expect(shifts[0].fromAnchor).toBe(60);
    expect(shifts[0].toAnchor).toBe(66);
  });

  it('downward shift uses lo (already correct, no regression)', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 70 }, { tick: 0, note: 84 },
       { tick: 480, note: 60 }, { tick: 480, note: 65 }],
      { hands_config: oneHand() }
    );
    const shifts = realShifts(out).filter(s => s.tick === 480);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].toAnchor).toBe(60);
  });

  it('chord already in window emits no follow-up shift', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 60 }, { tick: 480, note: 65 }, { tick: 480, note: 72 }],
      { hands_config: oneHand() }
    );
    const followUp = realShifts(out).filter(s => s.tick === 480);
    expect(followUp).toHaveLength(0);
  });
});

describe('3-hand semitones — partition + minimum-displacement', () => {
  it('opening chord distributes one note per hand (no piling on h1)', () => {
    // The buggy greedy assigned all three notes to h1 because every
    // uninitialised hand reported distance 0.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 30 }, { tick: 0, note: 60 }, { tick: 0, note: 90 }],
      { hands_config: nHand(3) }
    );
    const chord = chordAt(out, 0);
    expect(chord).toBeDefined();
    const byNote = new Map(chord.notes.map(n => [n.note, n.handId]));
    expect(byNote.get(30)).toBe('h1');
    expect(byNote.get(60)).toBe('h2');
    expect(byNote.get(90)).toBe('h3');
  });

  it('follow-up note inside h3 window emits no shift', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 30 }, { tick: 0, note: 60 }, { tick: 0, note: 90 },
       { tick: 480, note: 100 }],
      { hands_config: nHand(3) }
    );
    const followUp = realShifts(out).filter(s => s.tick === 480);
    expect(followUp).toHaveLength(0);
    // h3 keeps the note (was already covering 90..104 → 100 fits).
    const chord = chordAt(out, 480);
    expect(chord.notes[0].handId).toBe('h3');
  });

  it('follow-up note outside h3 window shifts h3 by the minimum', () => {
    // h3 anchor 90 (covers 90..104); new note 110 forces shift.
    // Optimal: anchor = 110 − 14 = 96 (distance 6). Buggy: 90 → 110 (dist 20).
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 30 }, { tick: 0, note: 60 }, { tick: 0, note: 90 },
       { tick: 480, note: 110 }],
      { hands_config: nHand(3) }
    );
    const followUp = realShifts(out).filter(s => s.tick === 480);
    expect(followUp).toHaveLength(1);
    expect(followUp[0].handId).toBe('h3');
    expect(followUp[0].fromAnchor).toBe(90);
    expect(followUp[0].toAnchor).toBe(96);
  });

  it('honours operator-pinned hand assignments', () => {
    // Pin the middle note 60 to h3. The simulator must place it
    // on h3 even though the natural distribution would put it on
    // h2. With 3 notes spanning 60 semitones across 3 hands of
    // span 14, no partition can avoid all overflow (the wider
    // pinned slice forces it) — but the pin contract still holds.
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 30 }, { tick: 0, note: 60 }, { tick: 0, note: 90 }],
      { hands_config: nHand(3) },
      { overrides: {
          hand_anchors: [], disabled_notes: [],
          note_assignments: [{ tick: 0, note: 60, handId: 'h3' }]
      } }
    );
    const chord = chordAt(out, 0);
    const byNote = new Map(chord.notes.map(n => [n.note, n.handId]));
    expect(byNote.get(60)).toBe('h3');
    // Pin order is preserved by construction (slices are
    // pitch-monotonic): note 30 lands somewhere ≤ h3, note 90 ≥ h3.
    const idxOf = (id) => Number(id.slice(1));
    expect(idxOf(byNote.get(30))).toBeLessThanOrEqual(idxOf(byNote.get(60)));
    expect(idxOf(byNote.get(90))).toBeGreaterThanOrEqual(idxOf(byNote.get(60)));
  });
});

describe('4-hand semitones — partition + minimum-displacement', () => {
  it('opening chord with 4 notes distributes one per hand', () => {
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 30 }, { tick: 0, note: 50 },
       { tick: 0, note: 70 }, { tick: 0, note: 90 }],
      { hands_config: nHand(4) }
    );
    const chord = chordAt(out, 0);
    const byNote = new Map(chord.notes.map(n => [n.note, n.handId]));
    expect(byNote.get(30)).toBe('h1');
    expect(byNote.get(50)).toBe('h2');
    expect(byNote.get(70)).toBe('h3');
    expect(byNote.get(90)).toBe('h4');
  });

  it('follow-up shift on a 4-hand keyboard uses minimum displacement', () => {
    // h4 at 90..104; new note 105 → optimal anchor = 105 − 14 = 91 (dist 1).
    const out = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 30 }, { tick: 0, note: 50 },
       { tick: 0, note: 70 }, { tick: 0, note: 90 },
       { tick: 480, note: 105 }],
      { hands_config: nHand(4) }
    );
    const followUp = realShifts(out).filter(s => s.tick === 480);
    expect(followUp).toHaveLength(1);
    expect(followUp[0].handId).toBe('h4');
    expect(followUp[0].fromAnchor).toBe(90);
    expect(followUp[0].toAnchor).toBe(91);
  });
});

describe('2-hand semitones — preserved minimum-displacement (no regression)', () => {
  it('upward shift on right hand uses hi − span', () => {
    // Initial chord pins left=50, right=80. Then note 90 alone needs
    // right's window to cover it. Right is at 80..94 → already covers
    // 90 → no shift.
    const noShift = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 50 }, { tick: 0, note: 80 }, { tick: 480, note: 90 }],
      { hands_config: twoHand() }
    );
    expect(realShifts(noShift).filter(s => s.tick === 480)).toHaveLength(0);

    // Now force a real shift: right at 80, new note 100 (out of 80..94).
    // Optimal: right shifts 80 → 86 (dist 6) so window covers 86..100.
    const withShift = window.HandPositionFeasibility.simulateHandWindows(
      [{ tick: 0, note: 50 }, { tick: 0, note: 80 }, { tick: 480, note: 100 }],
      { hands_config: twoHand() }
    );
    const followUp = realShifts(withShift).filter(s => s.tick === 480);
    expect(followUp).toHaveLength(1);
    expect(followUp[0].handId).toBe('right');
    expect(followUp[0].fromAnchor).toBe(80);
    expect(followUp[0].toAnchor).toBe(86);
  });
});
