// tests/frontend/hand-position-feasibility-warnings.test.js
// Covers summarizeFeasibilityWarnings — the formatter that turns the
// apply_assignments `handPositionWarnings` response into operator-facing
// lines (audit O3 / T2.4). Consumed by RoutingSummaryPage after an apply.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/auto-assign/HandPositionFeasibility.js'),
  'utf8'
);

beforeAll(() => {
  new Function(src)();
});

const summarize = (w) => window.HandPositionFeasibility.summarizeFeasibilityWarnings(w);

describe('summarizeFeasibilityWarnings', () => {
  it('returns count 0 for empty / non-array input', () => {
    expect(summarize([]).count).toBe(0);
    expect(summarize(null).count).toBe(0);
    expect(summarize(undefined).count).toBe(0);
  });

  it('ignores ok / unknown channels', () => {
    const out = summarize([
      { channel: 0, level: 'ok' },
      { channel: 1, level: 'unknown' }
    ]);
    expect(out.count).toBe(0);
    expect(out.lines).toEqual([]);
  });

  it('lists warning and infeasible channels with 1-based labels and names', () => {
    const out = summarize([
      { channel: 2, level: 'warning', instrumentName: 'Guitar', message: 'wide reach' },
      { channel: 5, level: 'infeasible', instrumentName: 'Bass', message: 'too many notes' }
    ]);
    expect(out.count).toBe(2);
    expect(out.infeasibleCount).toBe(1);
    // Channel labels are 1-based; sorted ascending by channel.
    expect(out.lines[0]).toMatch(/Canal 3/);
    expect(out.lines[0]).toMatch(/Guitar/);
    expect(out.lines[0]).toMatch(/wide reach/);
    expect(out.lines[1]).toMatch(/Canal 6/);
    expect(out.lines[1]).toMatch(/Bass/);
    // Infeasible uses ✗, warning uses ⚠.
    expect(out.lines[0].startsWith('⚠')).toBe(true);
    expect(out.lines[1].startsWith('✗')).toBe(true);
  });

  it('collapses split routings to the worst level per channel', () => {
    // Same channel, two segments: warning + infeasible → infeasible wins.
    const out = summarize([
      { channel: 4, level: 'warning', instrumentName: 'A', message: 'seg A' },
      { channel: 4, level: 'infeasible', instrumentName: 'A', message: 'seg B' }
    ]);
    expect(out.count).toBe(1);
    expect(out.infeasibleCount).toBe(1);
    expect(out.lines[0]).toMatch(/Canal 5/);
    expect(out.lines[0].startsWith('✗')).toBe(true);
  });
});
