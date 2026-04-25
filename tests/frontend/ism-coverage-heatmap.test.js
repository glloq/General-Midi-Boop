// tests/frontend/ism-coverage-heatmap.test.js
// C.7: ISMSections gains a fret coverage heat-map (canvas) below the
// hand-span input. Tests focus on the pure helpers (color mapping,
// approxFretsAt, drawCoverageHeatmap with a stubbed canvas context)
// since rendering inside the full modal is wired by ISMListeners and
// is exercised by the existing ism-sections-hands suite.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const familiesSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/InstrumentFamilies.js'),
  'utf8'
);
const sectionsSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/ISMSections.js'),
  'utf8'
);

beforeAll(() => {
  new Function(familiesSrc)();
  window.InstrumentSettingsModal = { GM_CATEGORY_EMOJIS: {} };
  new Function(sectionsSrc)();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

function makeCanvasStub() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return target.calls;
      if (typeof prop === 'string' && /^(setTransform|fillRect|strokeRect|fillText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|measureText)$/.test(prop)) {
        return (...args) => target.calls.push({ method: prop, args });
      }
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      target.calls.push({ method: 'set', prop, value });
      return true;
    }
  });
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 60;
  Object.defineProperty(canvas, 'clientWidth',  { value: 600, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 60,  configurable: true });
  canvas.getContext = () => ctx;
  document.body.appendChild(canvas);
  return { canvas, ctx };
}

describe('ISMSections._coverageColor', () => {
  it('returns gray for non-finite input', () => {
    expect(window.ISMSections._coverageColor(NaN)).toBe('#6b7280');
    expect(window.ISMSections._coverageColor(undefined)).toBe('#6b7280');
  });

  it('returns red for very tight coverage (≤2 frets)', () => {
    expect(window.ISMSections._coverageColor(1.5)).toBe('#dc2626');
    expect(window.ISMSections._coverageColor(2)).toBe('#dc2626');
  });

  it('returns green for comfortable coverage (≥6 frets)', () => {
    expect(window.ISMSections._coverageColor(6)).toBe('#16a34a');
    expect(window.ISMSections._coverageColor(8)).toBe('#16a34a');
  });

  it('returns intermediate colors for the middle range', () => {
    expect(window.ISMSections._coverageColor(3)).toBe('#ea580c');
    expect(window.ISMSections._coverageColor(4)).toBe('#ca8a04');
    expect(window.ISMSections._coverageColor(5)).toBe('#65a30d');
  });
});

describe('ISMSections._drawCoverageHeatmap', () => {
  it('paints one rectangle per fret column (1..maxFrets)', () => {
    const { canvas, ctx } = makeCanvasStub();
    window.ISMSections._drawCoverageHeatmap(canvas, 650, 80, 22);
    const fillRectCalls = ctx.calls.filter(c => c.method === 'fillRect');
    // Background + 22 fret columns = 23 fillRects.
    expect(fillRectCalls.length).toBeGreaterThanOrEqual(22);
  });

  it('draws fret-number labels every 5 frets (0, 5, 10, 15, 20)', () => {
    const { canvas, ctx } = makeCanvasStub();
    window.ISMSections._drawCoverageHeatmap(canvas, 650, 80, 22);
    const labels = ctx.calls.filter(c => c.method === 'fillText').map(c => c.args[0]);
    expect(labels).toEqual(expect.arrayContaining(['0', '5', '10', '15', '20']));
    expect(labels).not.toContain('1');
    expect(labels).not.toContain('3');
  });

  it('is a no-op when scale_length or hand_span is invalid', () => {
    const { canvas, ctx } = makeCanvasStub();
    window.ISMSections._drawCoverageHeatmap(canvas, 0, 80, 22);
    window.ISMSections._drawCoverageHeatmap(canvas, NaN, 80, 22);
    window.ISMSections._drawCoverageHeatmap(canvas, 650, 0, 22);
    window.ISMSections._drawCoverageHeatmap(canvas, 650, NaN, 22);
    expect(ctx.calls.filter(c => c.method === 'fillRect').length).toBe(0);
  });

  it('is a no-op for a missing canvas (defensive)', () => {
    expect(() => window.ISMSections._drawCoverageHeatmap(null, 650, 80, 22)).not.toThrow();
    expect(() => window.ISMSections._drawCoverageHeatmap(undefined, 650, 80, 22)).not.toThrow();
  });

  it('uses redder columns near the nut and greener columns up the neck', () => {
    const { canvas, ctx } = makeCanvasStub();
    window.ISMSections._drawCoverageHeatmap(canvas, 650, 80, 22);
    // The fillStyle is set as `set` events on the proxy. Capture the
    // sequence of fillStyle values that preceded fillRect calls.
    const fills = [];
    let lastStyle = null;
    for (const c of ctx.calls) {
      if (c.method === 'set' && c.prop === 'fillStyle') lastStyle = c.value;
      if (c.method === 'fillRect') fills.push(lastStyle);
    }
    // First entry is the background fill (#f3f4f6), drop it.
    const columnFills = fills.slice(1, 23);
    // Column 1 is at the nut, very tight reach → red-ish.
    expect(columnFills[0]).toBe('#dc2626');
    // Column 22 is far up the neck, very comfortable → green-ish.
    expect(columnFills[columnFills.length - 1]).toBe('#16a34a');
  });

  it('honours a custom maxFrets argument', () => {
    const { canvas, ctx } = makeCanvasStub();
    window.ISMSections._drawCoverageHeatmap(canvas, 650, 80, 12);
    const fillRects = ctx.calls.filter(c => c.method === 'fillRect');
    // Background + 12 fret columns.
    expect(fillRects.length).toBe(13);
  });
});

describe('ISMSections._approxFretsAt — sanity', () => {
  it('grows monotonically with the anchor fret', () => {
    const a = window.ISMSections._approxFretsAt(650, 80, 1);
    const b = window.ISMSections._approxFretsAt(650, 80, 7);
    const c = window.ISMSections._approxFretsAt(650, 80, 14);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('returns Infinity when the hand reaches past the bridge', () => {
    expect(window.ISMSections._approxFretsAt(650, 700, 0)).toBe(Infinity);
  });
});
