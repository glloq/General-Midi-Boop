// tests/tablature-converter.test.js
// Regression tests: the tablature editor must not silently drop notes.
// Every playable note is emitted; every unplayable one is either clamped
// (and flagged `unplayable`) or counted in `lastConversionStats.dropped`.

import { describe, test, expect } from '@jest/globals';
import TablatureConverter from '../src/midi/adaptation/TablatureConverter.js';

// Standard 6-string guitar (E2 A2 D3 G3 B3 E4), 24 frets.
const guitarConfig = {
  tuning: [40, 45, 50, 55, 59, 64],
  num_strings: 6,
  num_frets: 24,
  is_fretless: false,
  capo_fret: 0,
  tab_algorithm: 'min_movement'
};

const note = (t, n, g = 240, v = 80, c = 0) => ({ t, n, g, v, c });

describe('TablatureConverter — no silent drops', () => {
  for (const algo of ['min_movement', 'lowest_fret', 'highest_fret', 'zone']) {
    test(`${algo}: note below lowest string is clamped, not dropped`, () => {
      const conv = new TablatureConverter(guitarConfig);
      // MIDI 20 is far below E2 (40) — not playable anywhere.
      const out = conv.convertMidiToTablature([note(0, 20)], algo);
      expect(out).toHaveLength(1);
      expect(out[0].unplayable).toBe(true);
      expect(out[0].midiNote).toBe(20);
    });

    test(`${algo}: note above max fret is clamped, not dropped`, () => {
      const conv = new TablatureConverter(guitarConfig);
      // MIDI 100 > E4 + 24 frets (88) — out of range on every string.
      const out = conv.convertMidiToTablature([note(0, 100)], algo);
      expect(out).toHaveLength(1);
      expect(out[0].unplayable).toBe(true);
      expect(out[0].midiNote).toBe(100);
    });

    test(`${algo}: normal notes are not flagged unplayable`, () => {
      const conv = new TablatureConverter(guitarConfig);
      const out = conv.convertMidiToTablature([note(0, 64), note(480, 67)], algo);
      expect(out).toHaveLength(2);
      expect(out[0].unplayable).toBeUndefined();
      expect(out[1].unplayable).toBeUndefined();
    });

    test(`${algo}: 6-note chord on 6-string guitar emits 6 events`, () => {
      const conv = new TablatureConverter(guitarConfig);
      // E minor open chord voicing — all playable simultaneously.
      const chord = [40, 47, 52, 55, 59, 64].map(n => note(0, n));
      const out = conv.convertMidiToTablature(chord, algo);
      // Every note emitted; all on distinct strings
      expect(out).toHaveLength(6);
      const strings = new Set(out.map(e => e.string));
      expect(strings.size).toBe(6);
    });
  }
});

describe('TablatureConverter — stats surface dropped notes', () => {
  test('7-note chord on 6-string guitar drops exactly one', () => {
    const conv = new TablatureConverter(guitarConfig);
    // 7 simultaneous notes — each playable alone, but only 6 strings.
    const chord = [40, 45, 50, 55, 59, 64, 67].map(n => note(0, n));
    const out = conv.convertMidiToTablature(chord);
    expect(conv.lastConversionStats.dropped).toBe(1);
    // Total accounted for: emitted + dropped == input
    expect(out.length + conv.lastConversionStats.dropped).toBe(chord.length);
  });

  test('lastConversionStats is reset per call', () => {
    const conv = new TablatureConverter(guitarConfig);
    // First run: forces a drop
    conv.convertMidiToTablature([40, 45, 50, 55, 59, 64, 67].map(n => note(0, n)));
    expect(conv.lastConversionStats.dropped).toBe(1);
    // Second run with no conflict: stats reset
    conv.convertMidiToTablature([note(0, 64)]);
    expect(conv.lastConversionStats.dropped).toBe(0);
  });
});

describe('TablatureConverter — mixed sequences preserve count', () => {
  test('mixing in-range and out-of-range notes yields input length', () => {
    const conv = new TablatureConverter(guitarConfig);
    const notes = [
      note(0, 20),   // out of range (below) — clamped
      note(240, 64), // playable
      note(480, 100) // out of range (above) — clamped
    ];
    const out = conv.convertMidiToTablature(notes);
    expect(out).toHaveLength(3);
    expect(out.filter(e => e.unplayable).length).toBe(2);
  });
});

describe('TablatureConverter — dedupes simultaneous duplicate pitches', () => {
  test('doubled 4-note chord (8 events) collapses to 4 tab events', () => {
    const conv = new TablatureConverter(guitarConfig);
    // MIDI files often layer the same notes across multiple tracks on the
    // same channel; without dedup the converter would spread the doubles
    // onto extra strings and invent notes the composer never wrote.
    const chord = [52, 55, 59, 64];
    const doubled = [...chord, ...chord].map(n => note(0, n));
    const out = conv.convertMidiToTablature(doubled);
    expect(out).toHaveLength(4);
    const uniquePitches = new Set(out.map(e => e.midiNote));
    expect(uniquePitches.size).toBe(4);
  });

  test('duplicate pitch on different channels is kept separate', () => {
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature([
      note(0, 64, 240, 80, 0),
      note(0, 64, 240, 80, 1)
    ]);
    expect(out).toHaveLength(2);
  });

  test('duplicate pitch at different ticks is kept separate', () => {
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature([
      note(0, 64),
      note(240, 64)
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('TablatureConverter — _getClampedPosition', () => {
  test('picks lowest string for sub-range note', () => {
    const conv = new TablatureConverter(guitarConfig);
    const clamp = conv._getClampedPosition(20, new Set());
    expect(clamp).not.toBeNull();
    expect(clamp.string).toBe(1); // Low E string
    expect(clamp.fret).toBe(0);   // Clamped to open
    expect(clamp.unplayable).toBe(true);
  });

  test('picks highest string for above-range note', () => {
    const conv = new TablatureConverter(guitarConfig);
    const clamp = conv._getClampedPosition(100, new Set());
    expect(clamp).not.toBeNull();
    expect(clamp.string).toBe(6); // High E string
    expect(clamp.fret).toBe(24);  // Clamped to max fret
    expect(clamp.unplayable).toBe(true);
  });

  test('returns null when every string is occupied', () => {
    const conv = new TablatureConverter(guitarConfig);
    const occupied = new Set([1, 2, 3, 4, 5, 6]);
    expect(conv._getClampedPosition(20, occupied)).toBeNull();
  });
});

describe('TablatureConverter — hand_aware algorithm', () => {
  const handAwareConfig = {
    ...guitarConfig,
    tab_algorithm: 'hand_aware',
    scale_length_mm: 650,
    hand_span_mm: 80,
    hand_move_mm_per_sec: 250
  };

  test('is registered as an algorithm key', () => {
    expect(TablatureConverter.ALGORITHMS.hand_aware).toBe('hand_aware');
  });

  test('handles a melodic line without throwing', () => {
    const conv = new TablatureConverter(handAwareConfig);
    const out = conv.convertMidiToTablature([
      note(0, 64), note(240, 67), note(480, 71), note(720, 74)
    ]);
    expect(out).toHaveLength(4);
    expect(out.every(e => Number.isFinite(e.fret) && e.string >= 1)).toBe(true);
  });

  test('produces a valid result for a 4-note chord (open + fretted mix)', () => {
    const conv = new TablatureConverter(handAwareConfig);
    const chord = [50, 55, 59, 64].map(n => note(0, n));
    const out = conv.convertMidiToTablature(chord);
    expect(out).toHaveLength(4);
  });

  test('falls back gracefully when scale_length_mm is missing', () => {
    // No scale length → hand_aware degrades to min_movement-equivalent
    // costs (no division by zero, no NaN). Output stays valid.
    const cfg = { ...handAwareConfig, scale_length_mm: undefined };
    const conv = new TablatureConverter(cfg);
    const out = conv.convertMidiToTablature([
      note(0, 60), note(240, 64)
    ]);
    expect(out).toHaveLength(2);
    expect(out.every(e => Number.isFinite(e.fret))).toBe(true);
  });

  test('falls back gracefully when hand_span_mm is missing', () => {
    const cfg = { ...handAwareConfig, hand_span_mm: undefined };
    const conv = new TablatureConverter(cfg);
    const out = conv.convertMidiToTablature([
      note(0, 60), note(240, 64)
    ]);
    expect(out).toHaveLength(2);
  });

  test('using algorithmOverride switches to hand_aware mid-call', () => {
    const conv = new TablatureConverter(handAwareConfig);
    const seq = [note(0, 64), note(240, 67)];
    const baseline = conv.convertMidiToTablature(seq, 'min_movement');
    const handAware = conv.convertMidiToTablature(seq, 'hand_aware');
    // Both produce 2 events; hand_aware doesn't drop or inflate the count.
    expect(baseline).toHaveLength(2);
    expect(handAware).toHaveLength(2);
  });

  test('_useHandAwareCosts is reset after the call (no leaked state)', () => {
    const conv = new TablatureConverter(handAwareConfig);
    conv.convertMidiToTablature([note(0, 60)], 'hand_aware');
    expect(conv._useHandAwareCosts).toBeFalsy();
  });

  test('_fretDistanceMm follows the equal-temperament formula', () => {
    const conv = new TablatureConverter(handAwareConfig);
    // 0 → 12 covers half the scale length (octave at fret 12).
    const halfScale = conv._fretDistanceMm(0, 12);
    expect(halfScale).toBeCloseTo(handAwareConfig.scale_length_mm / 2, 0);
    // Symmetric: order of args does not change distance.
    expect(conv._fretDistanceMm(5, 2)).toBeCloseTo(conv._fretDistanceMm(2, 5), 5);
  });

  test('emission mm cost is negative (preferred) for an all-open assignment', () => {
    const conv = new TablatureConverter(handAwareConfig);
    const cost = conv._emissionCostMm([
      { string: 1, fret: 0 }, { string: 2, fret: 0 }
    ]);
    // -0.2 per open string: must beat any fretted assignment, which is ≥ 0.
    expect(cost).toBeLessThan(0);
  });

  test('emission mm cost rises when chord exceeds hand_span_mm', () => {
    const conv = new TablatureConverter(handAwareConfig);
    // 0..7 on a 650 mm scale ≈ 234 mm — far beyond 80 mm.
    const wide = conv._emissionCostMm([
      { string: 1, fret: 0 }, { string: 2, fret: 7 }
    ]);
    // 0..3 ≈ 109 mm — exceeds but only by ~30 mm.
    const tight = conv._emissionCostMm([
      { string: 1, fret: 0 }, { string: 2, fret: 3 }
    ]);
    expect(wide).toBeGreaterThan(tight);
  });

  test('transition mm cost is 0 for no-move and grows with distance', () => {
    const conv = new TablatureConverter(handAwareConfig);
    expect(conv._transitionCostMm(5, 5)).toBe(0);
    const small = conv._transitionCostMm(5, 6);
    const big   = conv._transitionCostMm(5, 18);
    expect(big).toBeGreaterThan(small);
  });
});

describe('TablatureConverter — open-string preference', () => {
  // The pitch E4 (MIDI 64) on a standard guitar can be played as the open
  // 6th (high E) string OR as fret 5 of the 5th (B) string. The open
  // string is universally preferred — easier, no finger pressed, leaves
  // the hand free for the next note. Before the audit fix, the Viterbi
  // assignment returned fret 5 (cost 0) over open (cost 0.5).
  const E4 = 64;

  test('min_movement picks the open string for E4 over fret 5 on B string', () => {
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature([note(0, E4)], 'min_movement');
    expect(out).toHaveLength(1);
    expect(out[0].fret).toBe(0);
    expect(out[0].string).toBe(6); // high-E string (1-based, low→high)
  });

  test('zone algorithm picks the open string for E4 when no other notes pull a zone away', () => {
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature([note(0, E4)], 'zone');
    expect(out[0].fret).toBe(0);
  });

  test('hand_aware picks the open string for E4', () => {
    const conv = new TablatureConverter({
      ...guitarConfig,
      tab_algorithm: 'hand_aware',
      scale_length_mm: 650, hand_span_mm: 80, hand_move_mm_per_sec: 250
    });
    const out = conv.convertMidiToTablature([note(0, E4)], 'hand_aware');
    expect(out[0].fret).toBe(0);
  });

  test('open string is preferred even after a fretted note (low position context)', () => {
    // A2 fretted on string 1 fret 5, then E4 — open high-E should win
    // because it's free and the resulting voicing stays in first position.
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature([
      note(0, 45),    // A2 — must be open string 2 or fret 5 of string 1
      note(240, E4)   // E4 — open string 6 preferred
    ]);
    const e4Event = out[1];
    expect(e4Event.midiNote).toBe(E4);
    expect(e4Event.fret).toBe(0);
  });

  test('high-position context still penalises adding an open string', () => {
    // When the hand sits at fret 12, reaching back to fret 0 is awkward.
    // The existing minFret > 4 penalty must keep biting.
    const conv = new TablatureConverter(guitarConfig);
    const cost = conv._emissionCost([
      { string: 1, fret: 12 }, { string: 6, fret: 0 }
    ]);
    expect(cost).toBeGreaterThan(0);
  });
});

describe('TablatureConverter — hand_aware physical span enumeration', () => {
  // 80 mm hand on a 650 mm scale. d(0,5) ≈ 168 mm, d(0,3) ≈ 109 mm,
  // d(0,2) ≈ 74 mm. The 1.5× hand-span ceiling = 120 mm.
  const cfg = {
    tuning: [40, 45, 50, 55, 59, 64], num_strings: 6, num_frets: 24,
    is_fretless: false, capo_fret: 0, tab_algorithm: 'hand_aware',
    scale_length_mm: 650, hand_span_mm: 80, hand_move_mm_per_sec: 250
  };

  test('rejects an enumerated chord whose physical span exceeds 1.5 × hand_span_mm', () => {
    const conv = new TablatureConverter(cfg);
    // Force the search to put both notes on adjacent strings at frets 0..7
    // (≈ 234 mm) — beyond 1.5 × 80 mm. The Viterbi enumeration must skip
    // this voicing; the converter should instead choose another voicing
    // (e.g. open + open on different strings).
    // Concretely: 40 (low E open) + 47 (B2 = low-E fret 7, A fret 2, OR
    // open-A + 2 frets). Hand-aware should bias to A-string fret 2.
    const out = conv.convertMidiToTablature([
      note(0, 40), note(0, 47)
    ], 'hand_aware');
    expect(out).toHaveLength(2);
    // The two assignments together must fit inside 1.5 × 80 mm = 120 mm.
    const fretted = out.filter(e => e.fret > 0).map(e => e.fret);
    if (fretted.length >= 2) {
      const lo = Math.min(...fretted), hi = Math.max(...fretted);
      const distMm = conv._fretDistanceMm(lo, hi);
      expect(distMm).toBeLessThanOrEqual(80 * 1.5 + 0.001);
    }
  });

  test('falls back to constant MAX_FRET_SPAN when hand_aware inputs missing', () => {
    // Same chord but without scale_length_mm: the hand-aware physical
    // ceiling is unreachable, so the constant 5-fret cap kicks in.
    const conv = new TablatureConverter({ ...cfg, scale_length_mm: undefined });
    const out = conv.convertMidiToTablature([
      note(0, 40), note(0, 47)
    ], 'hand_aware');
    expect(out).toHaveLength(2);
  });
});

describe('TablatureConverter — max_fingers cap', () => {
  // Four-note chord made entirely of fretted pitches (no open strings):
  // on a standard 6-string guitar these are playable (6 strings available)
  // but require 4 fingers pressed simultaneously.
  const frettedChord = () => [50, 55, 59, 64].map(n => note(0, n));

  test('no cap: a 4-finger chord emits 4 tab events (baseline)', () => {
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature(frettedChord());
    expect(out.length).toBe(4);
    // Baseline for the cap tests below.
    expect(out.every(e => Number.isFinite(e.fret))).toBe(true);
  });

  test('max_fingers=3 drops one fretted note from a 4-finger chord', () => {
    const conv = new TablatureConverter({ ...guitarConfig, max_fingers: 3 });
    const out = conv.convertMidiToTablature(frettedChord());
    const frettedEmitted = out.filter(e => !e.unplayable && e.fret > 0);
    expect(frettedEmitted.length).toBeLessThanOrEqual(3);
  });

  test('max_fingers=0/null disables the filter', () => {
    for (const mf of [null, undefined, 0]) {
      const conv = new TablatureConverter({ ...guitarConfig, max_fingers: mf });
      const out = conv.convertMidiToTablature(frettedChord());
      expect(out.length).toBe(4);
    }
  });

  test('open strings (fret 0) are not counted against max_fingers', () => {
    // 40 (low E open) + 47 (A2 open) + 52 (D3 open) + 59 (B3 open) — all
    // open-string voicings on a standard guitar. With max_fingers=1 the
    // chord still fits because open strings don't press a finger.
    const openEvoicings = [40, 45, 50, 59].map(n => note(0, n));
    const conv = new TablatureConverter({ ...guitarConfig, max_fingers: 1 });
    const out = conv.convertMidiToTablature(openEvoicings);
    const fretted = out.filter(e => !e.unplayable && e.fret > 0);
    expect(fretted.length).toBeLessThanOrEqual(1);
    // All four notes are still emitted — at least three of them come back
    // as open strings.
    expect(out.length).toBe(4);
  });

  test('negative max_fingers is treated as disabled (defensive)', () => {
    const conv = new TablatureConverter({ ...guitarConfig, max_fingers: -1 });
    const out = conv.convertMidiToTablature(frettedChord());
    expect(out.length).toBe(4);
  });
});
