// tests/frontend/hand-position-feasibility-helper.test.js
// Client-side mirror of InstrumentMatcher._scoreHandPositionFeasibility.
// We duplicate the heuristic in JS so the RoutingSummary badge column
// renders without a backend round-trip; this suite pins the behaviour
// of the helper in isolation.

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
  document.body.innerHTML = '';
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
  hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, max_fingers: 4, hand_span_frets: 4 }]
};

function analysis({ polyphonyMax = 4, rangeMin = 60, rangeMax = 72 } = {}) {
  return {
    noteRange: { min: rangeMin, max: rangeMax },
    polyphony: { max: polyphonyMax }
  };
}

describe('HandPositionFeasibility.classify', () => {
  it('returns unknown when instrument has no hands_config', () => {
    const r = window.HandPositionFeasibility.classify(analysis(), {});
    expect(r.level).toBe('unknown');
  });

  it('returns unknown when hands_config is disabled', () => {
    const r = window.HandPositionFeasibility.classify(analysis(), {
      hands_config: { enabled: false, hands: [] }
    });
    expect(r.level).toBe('unknown');
  });

  it('parses hands_config from a JSON string', () => {
    const r = window.HandPositionFeasibility.classify(analysis(), {
      hands_config: JSON.stringify(semitonesHands)
    });
    expect(r.level).toBe('ok');
  });

  it('semitones: comfortable channel → ok', () => {
    const r = window.HandPositionFeasibility.classify(analysis(), { hands_config: semitonesHands });
    expect(r.level).toBe('ok');
  });

  it('semitones: wide pitch span → warning', () => {
    const r = window.HandPositionFeasibility.classify(
      analysis({ rangeMin: 30, rangeMax: 95 }),
      { hands_config: semitonesHands }
    );
    expect(r.level).toBe('warning');
  });

  it('semitones: polyphony > total fingers → infeasible', () => {
    const r = window.HandPositionFeasibility.classify(
      analysis({ polyphonyMax: 12 }),
      { hands_config: semitonesHands }
    );
    expect(r.level).toBe('infeasible');
  });

  it('frets: comfortable channel → ok', () => {
    const r = window.HandPositionFeasibility.classify(
      analysis({ polyphonyMax: 3, rangeMin: 50, rangeMax: 60 }),
      { hands_config: fretsHands }
    );
    expect(r.level).toBe('ok');
  });

  it('frets: polyphony > max_fingers → infeasible', () => {
    const r = window.HandPositionFeasibility.classify(
      analysis({ polyphonyMax: 6, rangeMin: 50, rangeMax: 60 }),
      { hands_config: fretsHands }
    );
    expect(r.level).toBe('infeasible');
  });

  it('frets: pitch span > 3 × hand_span_frets → warning', () => {
    const r = window.HandPositionFeasibility.classify(
      analysis({ polyphonyMax: 3, rangeMin: 40, rangeMax: 75 }),
      { hands_config: fretsHands }
    );
    expect(r.level).toBe('warning');
  });
});

describe('HandPositionFeasibility.renderBadge', () => {
  it('renders empty string for unknown / null / undefined', () => {
    expect(window.HandPositionFeasibility.renderBadge('unknown')).toBe('');
    expect(window.HandPositionFeasibility.renderBadge(null)).toBe('');
    expect(window.HandPositionFeasibility.renderBadge(undefined)).toBe('');
  });

  it('renders a single ok glyph with the rs-hand-ok class', () => {
    const html = window.HandPositionFeasibility.renderBadge('ok');
    expect(html).toMatch(/rs-hand-ok/);
    expect(html).toMatch(/✓/);
  });

  it('renders a single warning glyph with the rs-hand-warning class', () => {
    const html = window.HandPositionFeasibility.renderBadge('warning');
    expect(html).toMatch(/rs-hand-warning/);
    expect(html).toMatch(/⚠/);
  });

  it('renders a single infeasible glyph with the rs-hand-infeasible class', () => {
    const html = window.HandPositionFeasibility.renderBadge('infeasible');
    expect(html).toMatch(/rs-hand-infeasible/);
    expect(html).toMatch(/✗/);
  });

  it('appends the optional extra-title when provided', () => {
    const html = window.HandPositionFeasibility.renderBadge('warning', { extraTitle: 'span exceeds hand' });
    expect(html).toMatch(/span exceeds hand/);
  });
});

describe('HandPositionFeasibility.aggregateByChannel', () => {
  it('returns an empty Map for non-array input', () => {
    expect(window.HandPositionFeasibility.aggregateByChannel(null).size).toBe(0);
    expect(window.HandPositionFeasibility.aggregateByChannel(undefined).size).toBe(0);
  });

  it('aggregates per channel, picking the worst level', () => {
    const map = window.HandPositionFeasibility.aggregateByChannel([
      { channel: 0, level: 'ok' },
      { channel: 0, level: 'warning' },
      { channel: 1, level: 'ok' },
      { channel: 2, level: 'infeasible' },
      { channel: 2, level: 'ok' }
    ]);
    expect(map.get(0).level).toBe('warning');
    expect(map.get(1).level).toBe('ok');
    expect(map.get(2).level).toBe('infeasible');
  });

  it('preserves summary + message from the dominating entry', () => {
    const map = window.HandPositionFeasibility.aggregateByChannel([
      { channel: 0, level: 'warning', summary: { mode: 'frets' }, message: 'too wide' },
      { channel: 0, level: 'ok',      summary: { mode: 'frets' } }
    ]);
    expect(map.get(0).message).toBe('too wide');
  });
});
