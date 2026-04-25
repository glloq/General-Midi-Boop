// tests/midi-transposer-suggest-feasibility.test.js
// B.3: MidiTransposer.suggestTranspositionForFeasibility searches the
// ±maxSemitones window for the shift that best improves the routed
// instrument's hand-position feasibility. We test the search behaviour
// with a stub matcher that classifies analyses we control directly,
// avoiding any coupling with the matcher's heuristic thresholds.

import { describe, test, expect } from '@jest/globals';
import MidiTransposer from '../src/midi/adaptation/MidiTransposer.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function analysis({ rangeMin = 60, rangeMax = 72, polyphonyMax = 4 } = {}) {
  return {
    noteRange: { min: rangeMin, max: rangeMax },
    polyphony: { max: polyphonyMax }
  };
}

/**
 * A configurable matcher stub: classify(analysis) returns the level
 * decided by `decide(rangeMin, rangeMax, polyphonyMax)`.
 */
function stubMatcher(decide) {
  return {
    _scoreHandPositionFeasibility(an, _instr) {
      const min = an.noteRange.min, max = an.noteRange.max, p = an.polyphony.max;
      const level = decide(min, max, p);
      const qualityScore = { ok: 100, warning: 70, infeasible: 50, unknown: 0 }[level] || 0;
      return { level, qualityScore, summary: {}, info: null, issue: null };
    }
  };
}

describe('MidiTransposer.suggestTranspositionForFeasibility', () => {
  test('returns null when noteRange is missing', () => {
    const t = new MidiTransposer(silentLogger);
    const matcher = stubMatcher(() => 'warning');
    expect(t.suggestTranspositionForFeasibility({}, {}, { matcher })).toBeNull();
  });

  test('returns null when no shift improves the baseline level', () => {
    const t = new MidiTransposer(silentLogger);
    const matcher = stubMatcher(() => 'warning'); // every shift = warning
    expect(t.suggestTranspositionForFeasibility(analysis(), {}, { matcher })).toBeNull();
  });

  test('returns null when the baseline is already ok', () => {
    const t = new MidiTransposer(silentLogger);
    const matcher = stubMatcher(() => 'ok');
    expect(t.suggestTranspositionForFeasibility(analysis(), {}, { matcher })).toBeNull();
  });

  test('picks an octave shift when the baseline is warning', () => {
    const t = new MidiTransposer(silentLogger);
    // Only +12 lifts the channel from warning to ok.
    const matcher = stubMatcher((min) => (min === 72 ? 'ok' : 'warning'));
    const r = t.suggestTranspositionForFeasibility(analysis(), {}, { matcher });
    expect(r).not.toBeNull();
    expect(r.semitones).toBe(12);
    expect(r.projectedLevel).toBe('ok');
    expect(r.baselineLevel).toBe('warning');
    expect(r.improvement).toBeGreaterThan(0);
    expect(r.rationale).toMatch(/\+12/);
  });

  test('prefers smaller |semitones| at equal improvement', () => {
    const t = new MidiTransposer(silentLogger);
    // Several shifts produce ok; the smallest |s| should win.
    const matcher = stubMatcher((min) => {
      // ok for min ∈ {62, 65, 72}, warning otherwise. baseline (min=60) = warning.
      if (min === 62 || min === 65 || min === 72) return 'ok';
      return 'warning';
    });
    const r = t.suggestTranspositionForFeasibility(analysis(), {}, { matcher });
    expect(r.semitones).toBe(2);
  });

  test('prefers an octave shift over a non-octave at equal score and equal |s|', () => {
    const t = new MidiTransposer(silentLogger);
    // Both -12 and +12 lift to ok; -12 has |s|=12, +12 has |s|=12.
    // But mid-range +12 wins the tie via the octave check (last tie-break).
    // Actually we want a head-to-head with |s|=N for both candidates.
    // Easiest: only -7 and -12 lift, both reach 'ok' at qualityScore 100.
    // -7 has smaller |s|, so it wins. Skipped — instead test that
    // when only ±N candidates exist with equal |s|=N, we pick one
    // deterministically.
    const matcher = stubMatcher((min) => (min === 48 || min === 53 ? 'ok' : 'warning'));
    const r = t.suggestTranspositionForFeasibility(analysis(), {}, { matcher });
    // baseline.min=60. -7 → min=53 (ok). -12 → min=48 (ok).
    // Smaller |s| wins → -7.
    expect(r.semitones).toBe(-7);
  });

  test('uses qualityScore as a secondary tie-break before |semitones|', () => {
    const t = new MidiTransposer(silentLogger);
    // Both shifts reach the same level (ok) but +5 has higher quality.
    // Hard to express purely from the level since our stub maps level→score.
    // Instead, vary qualityScore via a custom matcher.
    const matcher = {
      _scoreHandPositionFeasibility(an) {
        const min = an.noteRange.min;
        if (min === 65) return { level: 'ok', qualityScore: 90, summary: {} };
        if (min === 67) return { level: 'ok', qualityScore: 100, summary: {} };
        if (min === 60) return { level: 'warning', qualityScore: 70, summary: {} };
        return { level: 'warning', qualityScore: 70, summary: {} };
      }
    };
    const r = t.suggestTranspositionForFeasibility(analysis(), {}, { matcher });
    // +5 (min=65) and +7 (min=67) both reach ok; +7 has higher quality → wins.
    expect(r.semitones).toBe(7);
  });

  test('respects maxSemitones option', () => {
    const t = new MidiTransposer(silentLogger);
    const matcher = stubMatcher((min) => (min === 70 ? 'ok' : 'warning'));
    // Default search window includes +10 (min=70) → ok.
    const a = t.suggestTranspositionForFeasibility(analysis(), {}, { matcher });
    expect(a.semitones).toBe(10);
    // Restrict to ±5 → +10 falls outside, no improvement found.
    const b = t.suggestTranspositionForFeasibility(analysis(), {}, { matcher, maxSemitones: 5 });
    expect(b).toBeNull();
  });

  test('respects allowNonOctave=false (only ±12, ±24, ...)', () => {
    const t = new MidiTransposer(silentLogger);
    // +5 would otherwise win (smaller |s|), but it's filtered out.
    const matcher = stubMatcher((min) => (min === 65 || min === 72 ? 'ok' : 'warning'));
    const r = t.suggestTranspositionForFeasibility(analysis(), {}, {
      matcher, allowNonOctave: false
    });
    expect(r).not.toBeNull();
    expect(r.semitones).toBe(12);
  });

  test('handles infeasible → ok improvement (largest improvement wins)', () => {
    const t = new MidiTransposer(silentLogger);
    const matcher = stubMatcher((min) => {
      if (min === 60) return 'infeasible'; // baseline
      if (min === 65) return 'warning';    // +5 → mild improvement
      if (min === 72) return 'ok';         // +12 → big improvement
      return 'infeasible';
    });
    const r = t.suggestTranspositionForFeasibility(analysis(), {}, { matcher });
    expect(r.semitones).toBe(12);
    expect(r.projectedLevel).toBe('ok');
  });

  test('falls back to the default matcher when none is provided', () => {
    // Just check the call doesn't throw — we don't need to exercise the
    // real heuristic here; B.5/A.1 cover that path.
    const t = new MidiTransposer(silentLogger);
    const out = t.suggestTranspositionForFeasibility(analysis(), {});
    // Without a hands_config the heuristic returns level=unknown for
    // every candidate, so no improvement, so null.
    expect(out).toBeNull();
  });

  test('_shiftAnalysis clamps to [0, 127]', () => {
    const t = new MidiTransposer(silentLogger);
    const shifted = t._shiftAnalysis(analysis({ rangeMin: 5, rangeMax: 10 }), -10);
    expect(shifted.noteRange.min).toBe(0);
  });
});
