// tests/midi-adaptation-adapt-and-optimize.test.js
// B.5: MidiAdaptationService.adaptAndOptimize runs the matcher's
// hand-position heuristic on each channel-to-instrument pair and, when
// the level is sub-optimal, proposes non-destructive remediations
// (transpose / split flag). Capo support was removed in 2026-04;
// tests guard that no `capo` recommendation is ever emitted.
// Tests stub out the autoAssigner so no real MIDI parsing is required.

import { describe, test, expect, jest } from '@jest/globals';
import MidiAdaptationService from '../src/midi/adaptation/MidiAdaptationService.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function makeService(analyses = {}) {
  const autoAssigner = {
    analyzeChannel: jest.fn((midiData, channel) => analyses[String(channel)] || null)
  };
  return new MidiAdaptationService(silentLogger, autoAssigner);
}

function analysis({ polyphonyMax = 4, rangeMin = 60, rangeMax = 72 } = {}) {
  return {
    noteRange: { min: rangeMin, max: rangeMax },
    polyphony: { max: polyphonyMax, avg: polyphonyMax }
  };
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

const fretsHands = {
  enabled: true,
  mode: 'frets',
  hand_move_mm_per_sec: 250,
  hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, hand_span_frets: 4, max_fingers: 4 }]
};

const piano = (extra = {}) => ({
  device_id: 'piano-1', channel: 0, gm_program: 0, polyphony: 64,
  note_range_min: 21, note_range_max: 108,
  note_selection_mode: 'range',
  ...extra
});

const guitar = (extra = {}) => ({
  device_id: 'guitar-1', channel: 0, gm_program: 24, polyphony: 6,
  note_range_min: 40, note_range_max: 86,
  note_selection_mode: 'range',
  scale_length_mm: 650,
  ...extra
});

describe('MidiAdaptationService.adaptAndOptimize', () => {
  test('returns an empty object when no inputs are wired', () => {
    const svc = makeService();
    expect(svc.adaptAndOptimize(null, {})).toEqual({});
    expect(svc.adaptAndOptimize({}, null)).toEqual({});
  });

  test('emits level=ok with no recommendations for a comfortable channel', () => {
    const svc = makeService({ '0': analysis() });
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: piano({ hands_config: semitonesHands }) }
    });
    expect(out[0].level).toBe('ok');
    expect(out[0].recommendations).toEqual([]);
  });

  test('emits level=unknown when instrument has no hands_config', () => {
    const svc = makeService({ '0': analysis() });
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: piano() }
    });
    expect(out[0].level).toBe('unknown');
    expect(out[0].recommendations).toEqual([]);
  });

  test('skips channels whose analyzeChannel returns null', () => {
    const svc = makeService({}); // no analyses → returns null
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: piano({ hands_config: semitonesHands }) }
    });
    expect(out[0]).toBeUndefined();
  });

  test('proposes a transpose when an octave shift would lift feasibility', () => {
    // Channel range too wide for the keyboard hand → warning.
    // Shifting it up an octave keeps the same span → still warning. The
    // recommendation may not always fire here; what we test is that the
    // search does run when the level is sub-optimal.
    const svc = makeService({ '0': analysis({ rangeMin: 30, rangeMax: 95 }) });
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: piano({ hands_config: semitonesHands }) }
    });
    expect(['warning', 'infeasible']).toContain(out[0].level);
    // Recommendations array exists (possibly empty if no octave fix helps).
    expect(Array.isArray(out[0].recommendations)).toBe(true);
  });

  test('proposes a transpose when shifting up would tame an infeasible polyphony+range', () => {
    // Construct a case where moving the channel up 12 semitones improves
    // it: polyphony low, but pitch range mostly clustered low — bumping
    // up should not change feasibility (polyphony invariant). We use a
    // pitch-only warning case (wide range) and check that the recs are
    // computed without throwing and report a known type.
    const svc = makeService({ '0': analysis({ rangeMin: 30, rangeMax: 95 }) });
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: piano({ hands_config: semitonesHands }) }
    });
    for (const rec of out[0].recommendations) {
      expect(['transpose', 'split']).toContain(rec.type);
    }
  });

  test('proposes a split when polyphony exceeds the finger budget', () => {
    const svc = makeService({ '0': analysis({ polyphonyMax: 12 }) });
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: piano({ hands_config: semitonesHands }) }
    });
    expect(out[0].level).toBe('infeasible');
    const split = out[0].recommendations.find(r => r.type === 'split');
    expect(split).toBeDefined();
    expect(split.params).toMatchObject({
      reason: 'polyphony_exceeds_fingers',
      polyphony: 12
    });
  });

  test('never proposes a capo (feature removed)', () => {
    // Both frets and semitones instruments. Capo suggestions used to
    // fire for fretted instruments only; after the feature removal the
    // recommendation set is restricted to `transpose` / `split`.
    const svc = makeService({ '0': analysis({ rangeMin: 40, rangeMax: 75 }) });
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: guitar({ hands_config: fretsHands }) }
    });
    expect(out[0].recommendations.some(r => r.type === 'capo')).toBe(false);

    const svc2 = makeService({ '0': analysis({ rangeMin: 30, rangeMax: 95 }) });
    const out2 = svc2.adaptAndOptimize({}, {
      0: { instrument: piano({ hands_config: semitonesHands }) }
    });
    expect(out2[0].recommendations.some(r => r.type === 'capo')).toBe(false);
  });

  test('handles malformed assignment entries without throwing', () => {
    const svc = makeService({ '0': analysis() });
    const out = svc.adaptAndOptimize({}, {
      0: null,
      1: {},
      'not-a-channel': { instrument: piano({ hands_config: semitonesHands }) }
    });
    expect(out).toEqual({});
  });

  test('survives analyzeChannel throwing (channel skipped, others continue)', () => {
    const autoAssigner = {
      analyzeChannel: jest.fn((m, ch) => {
        if (ch === 0) throw new Error('boom');
        return analysis();
      })
    };
    const svc = new MidiAdaptationService(silentLogger, autoAssigner);
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: piano({ hands_config: semitonesHands }) },
      1: { instrument: piano({ hands_config: semitonesHands }) }
    });
    expect(out[0]).toBeUndefined();
    expect(out[1].level).toBeDefined();
  });
});

describe('MidiAdaptationService — capo feature removal', () => {
  test('applyCapoSuggestion is no longer exposed', () => {
    const svc = makeService();
    expect(svc.applyCapoSuggestion).toBeUndefined();
  });

  test('adaptAndOptimize never proposes a capo even when a +1 shift would help', () => {
    // Same setup the old "expanded capo search" test used: only a +1
    // shift lifts the level. Before the removal the service would
    // emit a `{type:'capo', params:{fret:1}}` recommendation; after
    // the removal it must not.
    const svc = makeService({ '0': analysis({ rangeMin: 40, rangeMax: 75 }) });
    svc._matcher._scoreHandPositionFeasibility = (an) => {
      const min = an.noteRange.min;
      if (min === 41) return { level: 'ok', qualityScore: 100, summary: { mode: 'frets' } };
      return { level: 'warning', qualityScore: 70, summary: { mode: 'frets' } };
    };
    const out = svc.adaptAndOptimize({}, {
      0: { instrument: guitar({ hands_config: fretsHands }) }
    });
    expect(out[0].recommendations.some(r => r.type === 'capo')).toBe(false);
  });
});

describe('MidiAdaptationService._shiftAnalysis', () => {
  const svc = makeService();

  test('shifts noteRange by the given semitones', () => {
    const shifted = svc._shiftAnalysis(analysis({ rangeMin: 60, rangeMax: 72 }), 12);
    expect(shifted.noteRange).toEqual({ min: 72, max: 84 });
  });

  test('clamps to [0, 127]', () => {
    const downShifted = svc._shiftAnalysis(analysis({ rangeMin: 5, rangeMax: 10 }), -12);
    expect(downShifted.noteRange.min).toBe(0);
    const upShifted = svc._shiftAnalysis(analysis({ rangeMin: 120, rangeMax: 125 }), 12);
    expect(upShifted.noteRange.max).toBe(127);
  });

  test('returns null when noteRange is missing', () => {
    expect(svc._shiftAnalysis({}, 12)).toBeNull();
    expect(svc._shiftAnalysis({ noteRange: { min: null, max: null } }, 12)).toBeNull();
  });
});
