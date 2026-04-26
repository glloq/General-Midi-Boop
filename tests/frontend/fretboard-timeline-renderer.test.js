// tests/frontend/fretboard-timeline-renderer.test.js
// PR4 — smoke tests for the new full-length renderer:
//   - it draws once with empty data without throwing
//   - setTimeline / setTrajectory / setPlayhead trigger redraws
//   - chord dots only render inside the viewport (virtualization)
//   - infeasible motion segments emit yellow quadraticCurveTo
//   - wheel + ctrl+wheel update scroll / zoom respectively

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let calls;

function installCanvasStub() {
  calls = [];
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 8 });
      if (typeof prop === 'string' && /^(setTransform|fillRect|strokeRect|fillText|strokeText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|rect|clip|arc|bezierCurveTo|quadraticCurveTo)$/.test(prop)) {
        return (...args) => calls.push({ method: prop, args });
      }
      return undefined;
    },
    set(_t, prop, value) {
      calls.push({ method: 'set', prop, value });
      return true;
    }
  });
  HTMLCanvasElement.prototype.getContext = () => ctx;
  return ctx;
}

beforeAll(() => {
  const src = readFileSync(
    resolve(__dirname, '../../public/js/features/auto-assign/FretboardTimelineRenderer.js'),
    'utf8'
  );
  new Function(src)();
});

beforeEach(() => {
  installCanvasStub();
});

function makeCanvas(w = 600, h = 400) {
  const c = document.createElement('canvas');
  Object.defineProperty(c, 'clientWidth',  { get: () => w });
  Object.defineProperty(c, 'clientHeight', { get: () => h });
  c.width = w; c.height = h;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h });
  return c;
}

function yellowCurveCount() {
  let lastStroke = null;
  let n = 0;
  for (const c of calls) {
    if (c.method === 'set' && c.prop === 'strokeStyle') lastStroke = String(c.value);
    if (c.method === 'quadraticCurveTo' && lastStroke && /#f5c518/i.test(lastStroke)) n++;
  }
  return n;
}

describe('FretboardTimelineRenderer — smoke', () => {
  it('draws an empty board without throwing', () => {
    const tr = new window.FretboardTimelineRenderer(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      ticksPerSec: 480, totalSec: 60
    });
    expect(() => tr.draw()).not.toThrow();
    // Fret grid lines: at least one stroke per fret (minus the two at edges).
    const strokeCount = calls.filter(c => c.method === 'stroke').length;
    expect(strokeCount).toBeGreaterThan(0);
  });

  it('renders chord dots only inside the viewport (virtualization)', () => {
    const tr = new window.FretboardTimelineRenderer(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      ticksPerSec: 480, totalSec: 600
    });
    // 600 chord events spread over 600 s, one per second (tick = 480·sec).
    // Each chord has one fretted note, fret 5.
    const events = [];
    for (let s = 0; s < 600; s++) {
      events.push({
        type: 'chord',
        tick: s * 480,
        notes: [{ note: 64, fret: 5, string: 4 }],
        unplayable: []
      });
    }
    tr.setTimeline(events);
    tr.setScrollSec(100);
    tr.setPxPerSec(80); // viewport = 400 px / 80 = 5 sec
    calls.length = 0;
    tr.draw();
    const arcCount = calls.filter(c => c.method === 'arc').length;
    // Viewport ≈ 5 s + 1 s margin top + 1 s margin bottom = 7 s of chords
    // → at most ~10 arcs (one per chord). Definitely < 100.
    expect(arcCount).toBeLessThan(100);
    expect(arcCount).toBeGreaterThan(0);
  });

  it('emits a yellow quadraticCurveTo for infeasible motion segments', () => {
    const tr = new window.FretboardTimelineRenderer(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      ticksPerSec: 480, totalSec: 10
    });
    tr.setTrajectory([
      { tick: 0, anchor: 2 },
      { tick: 480, anchor: 14,
        motion: { requiredSec: 1.0, availableSec: 0.2, feasible: false } }
    ]);
    calls.length = 0;
    tr.draw();
    expect(yellowCurveCount()).toBeGreaterThanOrEqual(1);
  });

  it('updates scroll on wheel and zoom on ctrl+wheel', () => {
    const tr = new window.FretboardTimelineRenderer(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      ticksPerSec: 480, totalSec: 600
    });
    const initialScroll = tr.scrollSec;
    tr._handleWheel({ deltaY: 80, ctrlKey: false, preventDefault() {} });
    expect(tr.scrollSec).toBeGreaterThan(initialScroll);

    const initialPx = tr.pxPerSec;
    tr._handleWheel({ deltaY: -200, ctrlKey: true, preventDefault() {} });
    expect(tr.pxPerSec).toBeGreaterThan(initialPx);
  });

  it('seek via click invokes onSeek with the converted second', () => {
    let received = null;
    const tr = new window.FretboardTimelineRenderer(makeCanvas(600, 400), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      ticksPerSec: 480, totalSec: 600,
      onSeek: (s) => { received = s; }
    });
    tr.setScrollSec(10);
    tr.setPxPerSec(80);
    // y=160 → sec = scrollSec + 160/80 = 10 + 2 = 12
    tr._handleClick({ clientY: 160, clientX: 100 });
    expect(received).toBeCloseTo(12, 5);
  });
});
