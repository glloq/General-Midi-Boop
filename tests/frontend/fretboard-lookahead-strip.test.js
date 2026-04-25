// tests/frontend/fretboard-lookahead-strip.test.js
// V.2: FretboardLookaheadStrip is the vertical timeline mounted
// above the live fretboard for fretted instruments. It paints a
// neutral hand band over the next 2-5 seconds, derived from the
// engine's trajectory + ticksPerSec + currentSec.

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
    resolve(__dirname, '../../public/js/features/auto-assign/FretboardLookaheadStrip.js'),
    'utf8'
  );
  new Function(src)();
});

beforeEach(() => {
  installCanvasStub();
});

function makeCanvas(w = 600, h = 140) {
  const c = document.createElement('canvas');
  Object.defineProperty(c, 'clientWidth',  { get: () => w });
  Object.defineProperty(c, 'clientHeight', { get: () => h });
  c.width = w; c.height = h;
  return c;
}

function makeStrip(opts = {}) {
  return new window.FretboardLookaheadStrip(makeCanvas(opts.w, opts.h), {
    tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
    windowSeconds: 4, ...opts
  });
}

describe('FretboardLookaheadStrip — geometry alignment with live fretboard', () => {
  it('uses the SAME fret-x formula as FretboardHandPreview (margins included)', () => {
    const s = makeStrip();
    // Fret 12 should sit at L*(1-2^-12/12) of the visible scale.
    const x0 = s._fretX(0);
    const x12 = s._fretX(12);
    const x22 = s._fretX(22);
    const ratio = (x12 - x0) / (x22 - x0);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.7);
  });
});

describe('FretboardLookaheadStrip — drawing', () => {
  it('paints nothing trajectory-related when no trajectory is loaded', () => {
    const s = makeStrip();
    s.draw();
    // Background fill + the now-line stroke is OK; no trapezoid /
    // band rectangle paint happens.
    const fillRects = calls.filter(c => c.method === 'fillRect');
    // Only the background (covering the whole canvas).
    expect(fillRects.length).toBeLessThanOrEqual(1);
  });

  it('paints a HOLD rectangle for the current trajectory point', () => {
    const s = makeStrip();
    s.setTicksPerSec(480);
    s.setHandTrajectory([
      { tick: 0, anchor: 5, releaseTick: 480 } // 1-sec hold from now
    ]);
    s.setCurrentTime(0);
    const fills = calls.filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    // HOLD fill is the green tint at alpha 0.20.
    expect(fills.some(v => /rgba\(34, 197, 94, 0\.20\)/.test(v))).toBe(true);
  });

  it('paints a TRANSITION trapezoid between consecutive shifts', () => {
    const s = makeStrip();
    s.setTicksPerSec(480);
    s.setHandTrajectory([
      { tick: 0,    anchor: 5, releaseTick: 240 },
      { tick: 1000, anchor: 12, releaseTick: 1100 }
    ]);
    s.setCurrentTime(0);
    // The transition uses a closed quadrilateral path. Count the
    // moveTo/lineTo/closePath sequences.
    const closes = calls.filter(c => c.method === 'closePath');
    expect(closes.length).toBeGreaterThan(0);
  });

  it('time runs vertically: future at the top, now at the bottom', () => {
    const s = makeStrip({ w: 600, h: 140 });
    expect(s._yAt(0, 140)).toBeCloseTo(140, 1);   // currentSec → bottom
    expect(s._yAt(4, 140)).toBeCloseTo(0, 1);     // currentSec + windowSeconds → top
  });

  it('the X-axis matches the live fretboard span at anchor=5', () => {
    const s = makeStrip();
    const { x0, x1 } = s._handWindowX(5);
    // Anchor=5 with span=4 → band covers fret slots [4..8].
    // x0 = _fretX(4); x1 = _fretX(4+4) = _fretX(8).
    expect(x0).toBeCloseTo(s._fretX(4), 1);
    expect(x1).toBeCloseTo(s._fretX(8), 1);
  });
});

describe('FretboardLookaheadStrip — throttle', () => {
  it('skips redraws when the playhead moves less than one pixel', () => {
    installCanvasStub();
    const s = makeStrip({ h: 140 });
    s.setTicksPerSec(480);
    s.setHandTrajectory([{ tick: 0, anchor: 5, releaseTick: 480 }]);
    // First setCurrentTime triggers a draw.
    calls.length = 0;
    s.setCurrentTime(0.001);
    // 0.001 s × (140 / 4) ≈ 0.035 px → sub-pixel → no redraw.
    const fillRects = calls.filter(c => c.method === 'fillRect');
    expect(fillRects.length).toBe(0);
  });
});

describe('FretboardLookaheadStrip — lifecycle', () => {
  it('destroy() drops state and does not throw on a follow-up draw', () => {
    const s = makeStrip();
    s.setHandTrajectory([{ tick: 0, anchor: 5 }]);
    s.destroy();
    expect(s._trajectory).toEqual([]);
    expect(() => s.draw()).not.toThrow();
  });
});
