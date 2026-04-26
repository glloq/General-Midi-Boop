// tests/frontend/hand-position-feasibility-note-assignments.test.js
// PR6 — verify the new public surface and behaviour:
//   - findStringCandidates lists every (string, fret) pair producing a
//     given MIDI pitch on a tuning, ordered by ascending fret.
//   - simulateHandWindows honours overrides.note_assignments BEFORE
//     the auto-resolver runs, so an operator-pinned (string, fret)
//     wins over the simulator's choice.

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

const guitar = {
  hands_config: {
    enabled: true,
    mode: 'frets',
    hands: [{ id: 'fretting', hand_span_frets: 4, max_fingers: 4,
              hand_move_semitones_per_sec: 80 }]
  },
  tuning: [40, 45, 50, 55, 59, 64], // standard 6-string EADGBE
  num_frets: 22
};

describe('HandPositionFeasibility.findStringCandidates', () => {
  it('returns all valid (string, fret) for a fretted note, sorted by fret', () => {
    // MIDI 64 = E4. On standard tuning that's:
    //   string 1 (E2, open=40) → fret 24 (out if num_frets<24, in here w/ 22 → out)
    //   string 2 (A2, open=45) → fret 19
    //   string 3 (D3, open=50) → fret 14
    //   string 4 (G3, open=55) → fret 9
    //   string 5 (B3, open=59) → fret 5
    //   string 6 (E4, open=64) → fret 0
    const candidates = window.HandPositionFeasibility.findStringCandidates(64, guitar);
    expect(candidates.length).toBeGreaterThan(0);
    // Sorted by fret ascending
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].fret).toBeGreaterThanOrEqual(candidates[i - 1].fret);
    }
    // Open string 6 must be present (E4 on the high-E open string)
    expect(candidates.find(c => c.string === 6 && c.fret === 0)).toBeDefined();
    // Fret-19 candidate on string 2 must be present (within num_frets=22)
    expect(candidates.find(c => c.string === 2 && c.fret === 19)).toBeDefined();
    // Fret-24 candidate on string 1 should NOT be present (num_frets=22)
    expect(candidates.find(c => c.string === 1 && c.fret === 24)).toBeUndefined();
  });

  it('returns an empty list when MIDI pitch is below every open string', () => {
    const candidates = window.HandPositionFeasibility.findStringCandidates(20, guitar);
    expect(candidates).toEqual([]);
  });

  it('returns an empty list with no tuning', () => {
    const cs = window.HandPositionFeasibility.findStringCandidates(60, { num_frets: 24 });
    expect(cs).toEqual([]);
  });
});

describe('HandPositionFeasibility.simulateHandWindows — note_assignments', () => {
  it('honours an operator-pinned (string, fret) for a specific note', () => {
    // MIDI 64 (E4) at tick 0; default resolver would pick fret 0 on
    // string 6 (open). Pin it to string 5 / fret 5 (B string, fret 5).
    const notes = [{ tick: 0, note: 64, duration: 240 }];
    const overrides = {
      hand_anchors: [],
      note_assignments: [{ tick: 0, note: 64, string: 5, fret: 5 }],
      version: 1
    };
    const out = window.HandPositionFeasibility.simulateHandWindows(notes, guitar, {
      overrides, ticksPerBeat: 480, bpm: 120
    });
    const chord = out.find(e => e.type === 'chord');
    expect(chord).toBeDefined();
    const tagged = chord.notes.find(n => n.note === 64);
    expect(tagged.string).toBe(5);
    expect(tagged.fret).toBe(5);
  });

  it('prefers an open string over a fretted alternative on a different string', () => {
    // E4 (MIDI 64) can be played:
    //   - open on string 6 (high E open = 64) — fret 0
    //   - fret 5 on string 5 (B3 + 5 = E4)
    //   - fret 9 on string 4 (G3 + 9 = E4)
    // With anchor=5, the in-band candidate fret 5 used to win. Open
    // strings are now boosted so they don't burn a finger when one
    // could ring open instead.
    const notes = [{ tick: 0, note: 64, duration: 240 }];
    const overrides = {
      hand_anchors: [{ tick: 0, handId: 'fretting', anchor: 5 }],
      version: 1
    };
    const out = window.HandPositionFeasibility.simulateHandWindows(notes, guitar, {
      overrides, ticksPerBeat: 480, bpm: 120
    });
    const chord = out.find(e => e.type === 'chord');
    const tagged = chord.notes.find(n => n.note === 64);
    expect(tagged.fret).toBe(0);
    expect(tagged.string).toBe(6);
  });

  it('does NOT touch other notes when only one is pinned', () => {
    // Two simultaneous notes; pin only the lower one. The other should
    // still be auto-resolved.
    const notes = [
      { tick: 0, note: 55, duration: 240 }, // G3 — open on string 4 (G)
      { tick: 0, note: 64, duration: 240 }  // E4 — open on string 6 (high E)
    ];
    const overrides = {
      hand_anchors: [],
      note_assignments: [{ tick: 0, note: 55, string: 3, fret: 5 }],
      version: 1
    };
    const out = window.HandPositionFeasibility.simulateHandWindows(notes, guitar, {
      overrides, ticksPerBeat: 480, bpm: 120
    });
    const chord = out.find(e => e.type === 'chord');
    const pinned = chord.notes.find(n => n.note === 55);
    const free = chord.notes.find(n => n.note === 64);
    expect(pinned.string).toBe(3);
    expect(pinned.fret).toBe(5);
    expect(free.string).toBeDefined();
    expect(free.fret).toBeDefined();
    // The auto-resolved note must NOT have been forced to the pinned
    // note's string (each string can only sound one pitch at a time).
    expect(free.string).not.toBe(3);
  });
});
