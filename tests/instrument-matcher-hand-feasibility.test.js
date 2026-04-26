// tests/instrument-matcher-hand-feasibility.test.js
// A.1: InstrumentMatcher.calculateCompatibility now exposes a structured
// `handPositionFeasibility` field derived from the channel's aggregated
// analysis (polyphony max + pitch span) and the instrument's hands_config.
// Verifies: unknown when no hands_config, ok / warning / infeasible
// classifications for both modes, info/issue plumbing, no impact on the
// existing 0-100 score in this commit (A.2 will wire the score later).

import { describe, test, expect } from '@jest/globals';
import InstrumentMatcher from '../src/midi/adaptation/InstrumentMatcher.js';
import ScoringConfig from '../src/midi/adaptation/ScoringConfig.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function baseAnalysis({ polyphonyMax = 4, rangeMin = 60, rangeMax = 72, channel = 0, program = 0 } = {}) {
  return {
    channel,
    primaryProgram: program,
    bankMSB: null,
    bankLSB: null,
    noteRange: { min: rangeMin, max: rangeMax },
    polyphony: { max: polyphonyMax, avg: polyphonyMax },
    usedCCs: [],
    estimatedType: 'keyboard',
    typeConfidence: 1,
    typeScores: {},
    estimatedCategory: null,
    estimatedSubtype: null,
    timingAnalysis: null,
    totalNotes: 100
  };
}

function pianoInstrument(extra = {}) {
  return {
    device_id: 'piano-1',
    channel: 0,
    gm_program: 0,
    polyphony: 64,
    note_range_min: 21,
    note_range_max: 108,
    note_selection_mode: 'range',
    selected_notes: null,
    supported_ccs: null,
    type: 'keyboard',
    ...extra
  };
}

function guitarInstrument(extra = {}) {
  return {
    device_id: 'guitar-1',
    channel: 0,
    gm_program: 24,
    polyphony: 6,
    note_range_min: 40,
    note_range_max: 86,
    note_selection_mode: 'range',
    selected_notes: null,
    supported_ccs: null,
    type: 'guitar',
    ...extra
  };
}

describe('InstrumentMatcher.handPositionFeasibility — unknown', () => {
  test('returns unknown when instrument has no hands_config', () => {
    const m = new InstrumentMatcher(silentLogger);
    const r = m.calculateCompatibility(baseAnalysis(), pianoInstrument());
    expect(r.handPositionFeasibility).toBeDefined();
    expect(r.handPositionFeasibility.level).toBe('unknown');
    expect(r.handPositionFeasibility.qualityScore).toBe(0);
  });

  test('returns unknown when hands_config is explicitly disabled', () => {
    const m = new InstrumentMatcher(silentLogger);
    const r = m.calculateCompatibility(
      baseAnalysis(),
      pianoInstrument({ hands_config: { enabled: false, hands: [] } })
    );
    expect(r.handPositionFeasibility.level).toBe('unknown');
  });

  test('parses hands_config from a JSON string', () => {
    const m = new InstrumentMatcher(silentLogger);
    const handsJson = JSON.stringify({
      enabled: true,
      mode: 'semitones',
      hand_move_semitones_per_sec: 60,
      hands: [
        { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
        { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
      ]
    });
    const r = m.calculateCompatibility(baseAnalysis(), pianoInstrument({ hands_config: handsJson }));
    expect(r.handPositionFeasibility.level).not.toBe('unknown');
  });

  test('malformed hands_config JSON keeps level unknown (defensive)', () => {
    const m = new InstrumentMatcher(silentLogger);
    const r = m.calculateCompatibility(
      baseAnalysis(),
      pianoInstrument({ hands_config: '{ not json' })
    );
    expect(r.handPositionFeasibility.level).toBe('unknown');
  });
});

describe('InstrumentMatcher.handPositionFeasibility — semitones mode', () => {
  const semitonesHands = {
    enabled: true,
    mode: 'semitones',
    hand_move_semitones_per_sec: 60,
    hands: [
      { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
      { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
    ]
  };

  test('comfortable channel yields level "ok"', () => {
    const m = new InstrumentMatcher(silentLogger);
    const analysis = baseAnalysis({ polyphonyMax: 4, rangeMin: 60, rangeMax: 72 });
    const r = m.calculateCompatibility(analysis, pianoInstrument({ hands_config: semitonesHands }));
    expect(r.handPositionFeasibility.level).toBe('ok');
    expect(r.handPositionFeasibility.qualityScore).toBe(100);
  });

  test('wide pitch span (> 2 × total span) flags "warning"', () => {
    const m = new InstrumentMatcher(silentLogger);
    // total span = 28 semitones; 60-ish span = 60 > 56 → warning.
    const analysis = baseAnalysis({ polyphonyMax: 4, rangeMin: 30, rangeMax: 95 });
    const r = m.calculateCompatibility(analysis, pianoInstrument({ hands_config: semitonesHands }));
    expect(r.handPositionFeasibility.level).toBe('warning');
    expect(r.handPositionFeasibility.qualityScore).toBeLessThan(100);
  });

  test('polyphony exceeding total fingers flags "infeasible"', () => {
    const m = new InstrumentMatcher(silentLogger);
    // total fingers = 2 × 5 = 10; polyphony 12 > 10.
    const analysis = baseAnalysis({ polyphonyMax: 12, rangeMin: 60, rangeMax: 72 });
    const r = m.calculateCompatibility(analysis, pianoInstrument({ hands_config: semitonesHands }));
    expect(r.handPositionFeasibility.level).toBe('infeasible');
    expect(r.handPositionFeasibility.issue).not.toBeNull();
    expect(r.handPositionFeasibility.issue.type).toBe('warning');
  });
});

describe('InstrumentMatcher.handPositionFeasibility — frets mode', () => {
  const fretsHands = {
    enabled: true,
    mode: 'frets',
    mechanism: 'string_sliding_fingers',
    hand_move_mm_per_sec: 250,
    hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, hand_span_frets: 4, max_fingers: 4 }]
  };

  test('comfortable channel yields level "ok"', () => {
    const m = new InstrumentMatcher(silentLogger);
    const analysis = baseAnalysis({ polyphonyMax: 3, rangeMin: 50, rangeMax: 60, channel: 0, program: 24 });
    const r = m.calculateCompatibility(analysis, guitarInstrument({ hands_config: fretsHands }));
    expect(r.handPositionFeasibility.level).toBe('ok');
    expect(r.handPositionFeasibility.summary.mode).toBe('frets');
  });

  test('polyphony > max_fingers flags "infeasible"', () => {
    const m = new InstrumentMatcher(silentLogger);
    const analysis = baseAnalysis({ polyphonyMax: 6, rangeMin: 50, rangeMax: 60, program: 24 });
    const r = m.calculateCompatibility(analysis, guitarInstrument({ hands_config: fretsHands }));
    expect(r.handPositionFeasibility.level).toBe('infeasible');
    expect(r.handPositionFeasibility.issue.message).toMatch(/finger/);
  });

  test('pitch span >> hand_span_frets flags "warning"', () => {
    const m = new InstrumentMatcher(silentLogger);
    // hand_span_frets = 4; threshold = 12; rangeSpan = 30 → warning.
    const analysis = baseAnalysis({ polyphonyMax: 3, rangeMin: 40, rangeMax: 75, program: 24 });
    const r = m.calculateCompatibility(analysis, guitarInstrument({ hands_config: fretsHands }));
    expect(r.handPositionFeasibility.level).toBe('warning');
  });

  test('no max_fingers → no infeasible from polyphony alone', () => {
    const m = new InstrumentMatcher(silentLogger);
    const noMaxFingers = {
      ...fretsHands,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
    };
    const analysis = baseAnalysis({ polyphonyMax: 6, rangeMin: 50, rangeMax: 60, program: 24 });
    const r = m.calculateCompatibility(analysis, guitarInstrument({ hands_config: noMaxFingers }));
    expect(r.handPositionFeasibility.level).not.toBe('infeasible');
  });
});

describe('InstrumentMatcher.handPositionFeasibility — A.2 scoring contribution', () => {
  // A throwaway config that overrides one section without mutating the
  // global ScoringConfig (which would leak into the rest of the suite).
  function makeConfig(overrides) {
    return Object.assign(Object.create(ScoringConfig), overrides);
  }

  const semitonesHands = {
    enabled: true,
    mode: 'semitones',
    hand_move_semitones_per_sec: 60,
    hands: [
      { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
      { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
    ]
  };

  test('hands_config with enabled=false does not move the score (opt-out)', () => {
    const cfg = makeConfig({ handPosition: { enabled: false } });
    const m = new InstrumentMatcher(silentLogger, cfg);
    const analysis = baseAnalysis();
    const baseline = m.calculateCompatibility(analysis, pianoInstrument()).score;
    const withHands = m.calculateCompatibility(analysis, pianoInstrument({ hands_config: semitonesHands })).score;
    expect(withHands).toBe(baseline);
  });

  test('level=ok adds the configured bonus', () => {
    const m = new InstrumentMatcher(silentLogger);
    const analysis = baseAnalysis({ polyphonyMax: 4, rangeMin: 60, rangeMax: 72 });
    const baseline = m.calculateCompatibility(analysis, pianoInstrument()).score;
    const withHands = m.calculateCompatibility(analysis, pianoInstrument({ hands_config: semitonesHands })).score;
    // Default config: okBonus = +4 (clamped to 100 ceiling).
    expect(withHands).toBeGreaterThanOrEqual(baseline);
    expect(withHands - baseline).toBeLessThanOrEqual(4);
  });

  test('level=warning subtracts the configured penalty', () => {
    const m = new InstrumentMatcher(silentLogger);
    // Wide pitch span → warning.
    const analysis = baseAnalysis({ polyphonyMax: 4, rangeMin: 30, rangeMax: 95 });
    const baseline = m.calculateCompatibility(analysis, pianoInstrument()).score;
    const withHands = m.calculateCompatibility(analysis, pianoInstrument({ hands_config: semitonesHands })).score;
    expect(withHands).toBeLessThan(baseline);
  });

  test('level=infeasible subtracts the larger penalty', () => {
    const m = new InstrumentMatcher(silentLogger);
    const analysis = baseAnalysis({ polyphonyMax: 12, rangeMin: 60, rangeMax: 72 });
    const baseline = m.calculateCompatibility(analysis, pianoInstrument()).score;
    const withHands = m.calculateCompatibility(analysis, pianoInstrument({ hands_config: semitonesHands })).score;
    expect(baseline - withHands).toBeGreaterThanOrEqual(15);
  });

  test('level=unknown (no hands_config) leaves the score unchanged', () => {
    const m = new InstrumentMatcher(silentLogger);
    const analysis = baseAnalysis();
    const a = m.calculateCompatibility(analysis, pianoInstrument()).score;
    const b = m.calculateCompatibility(analysis, pianoInstrument()).score;
    expect(a).toBe(b);
    // And that score is still the un-bonused baseline.
    const handPositionFeasibility = m.calculateCompatibility(analysis, pianoInstrument()).handPositionFeasibility;
    expect(handPositionFeasibility.level).toBe('unknown');
  });

  test('per-mode penalties produce a strict ordering: infeasible < warning < ok', () => {
    const m = new InstrumentMatcher(silentLogger);

    // Same instrument config, three different channel analyses spanning
    // the three feasibility levels.
    const ok       = m.calculateCompatibility(baseAnalysis({ polyphonyMax: 4, rangeMin: 60, rangeMax: 72 }), pianoInstrument({ hands_config: semitonesHands })).score;
    const warning  = m.calculateCompatibility(baseAnalysis({ polyphonyMax: 4, rangeMin: 30, rangeMax: 95 }), pianoInstrument({ hands_config: semitonesHands })).score;
    const infeas   = m.calculateCompatibility(baseAnalysis({ polyphonyMax: 12, rangeMin: 60, rangeMax: 72 }), pianoInstrument({ hands_config: semitonesHands })).score;

    expect(ok).toBeGreaterThan(warning);
    expect(warning).toBeGreaterThan(infeas);
  });
});
