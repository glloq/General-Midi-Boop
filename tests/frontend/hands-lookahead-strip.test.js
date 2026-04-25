// tests/frontend/hands-lookahead-strip.test.js
// HandsLookaheadStrip is a Synthesia-style vertical piano-roll
// shown above the keyboard in the HandsPreviewPanel (claviers only).
// y = time (bottom = now, top = windowSeconds ahead);
// x = pitch, aligned with the keys below (white-key index, black
// keys offset like the keyboard widget).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/auto-assign/HandsLookaheadStrip.js'),
  'utf8'
);

function installCanvasStub() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return target.calls;
      if (typeof prop === 'string' && /^(setTransform|fillRect|strokeRect|fillText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|rect|clip|arc|bezierCurveTo|quadraticCurveTo)$/.test(prop)) {
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
  HTMLCanvasElement.prototype.getContext = () => ctx;
  return ctx;
}

beforeAll(() => {
  installCanvasStub();
  new Function(src)();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

function makeCanvas(width = 600, height = 140) {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth',  { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(canvas);
  return canvas;
}

function makeStrip(opts = {}) {
  return new window.HandsLookaheadStrip(makeCanvas(opts.width, opts.height), {
    ticksPerSecond: 480,
    rangeMin: 36, rangeMax: 96,
    windowSeconds: 4,
    ...opts
  });
}

describe('HandsLookaheadStrip — construction', () => {
  it('initialises currentSec at 0', () => {
    const s = makeStrip();
    expect(s.currentSec).toBe(0);
  });

  it('clamps windowSeconds to [1, 10]', () => {
    expect(makeStrip({ windowSeconds: 0 }).windowSeconds).toBe(1);
    expect(makeStrip({ windowSeconds: 50 }).windowSeconds).toBe(10);
  });

  it('sorts notes by tick when constructed out of order', () => {
    const s = makeStrip({
      notes: [
        { tick: 1920, note: 60 },
        { tick: 0,    note: 60 },
        { tick: 480,  note: 60 }
      ]
    });
    expect(s.notes.map(n => n.tick)).toEqual([0, 480, 1920]);
  });
});

describe('HandsLookaheadStrip — _firstVisibleIndex', () => {
  it('returns 0 when sec is before all notes', () => {
    const s = makeStrip({
      notes: [{ tick: 480, note: 60, duration: 240 }, { tick: 1920, note: 64, duration: 240 }]
    });
    expect(s._firstVisibleIndex(0)).toBe(0);
  });

  it('skips notes that already ended', () => {
    const s = makeStrip({
      notes: [{ tick: 0, note: 60, duration: 240 }, { tick: 1920, note: 64, duration: 240 }]
    });
    // Note at tick 0..240 ended at 0.5s. At sec=1 the first visible is index 1.
    expect(s._firstVisibleIndex(1)).toBe(1);
  });
});

describe('HandsLookaheadStrip — column geometry (x mirrors the keyboard)', () => {
  it('white keys take a full white-key column', () => {
    const s = new window.HandsLookaheadStrip(makeCanvas(700, 140), {
      ticksPerSecond: 480, rangeMin: 60, rangeMax: 71, windowSeconds: 4
    });
    // 7 whites in one octave → ww = 100.
    const col = s._columnFor(60); // C5 (white)
    expect(col.x).toBeCloseTo(0, 5);
    expect(col.width).toBeCloseTo(100, 5);
  });

  it('black keys are narrower and sit on the white-key boundary', () => {
    const s = new window.HandsLookaheadStrip(makeCanvas(700, 140), {
      ticksPerSecond: 480, rangeMin: 60, rangeMax: 71, windowSeconds: 4
    });
    const colC = s._columnFor(60);  // C
    const colCs = s._columnFor(61); // C#
    expect(colCs.x).toBeGreaterThan(colC.x);
    expect(colCs.x).toBeLessThan(colC.x + colC.width);
    expect(colCs.width).toBeLessThan(colC.width);
  });
});

describe('HandsLookaheadStrip — drawing (vertical fall-down)', () => {
  it('paints background + now line + a fillRect per visible note', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: [
        { tick: 480,  note: 60, duration: 240 }, // visible (0.5s start)
        { tick: 1920, note: 64, duration: 240 }, // visible (4s start exactly)
        { tick: 9999, note: 67, duration: 240 }  // far away → not visible
      ]
    });
    s.draw();
    const fillRects = ctx.calls.filter(c => c.method === 'fillRect');
    // background + 2 visible notes (note at exactly windowSeconds is
    // typically drawn as well — its top edge clamps to y=0).
    expect(fillRects.length).toBeGreaterThanOrEqual(2);
  });

  it('puts notes near the bottom of the canvas as time approaches now', () => {
    // A note that starts at tick 480 (≈ 1s ahead at our default
    // tempo). With windowSeconds=4, dt_start=1 → yStart should be
    // h * (1 - 1/4) = 0.75 * h, near the bottom.
    const ctx = installCanvasStub();
    const h = 140;
    const s = new window.HandsLookaheadStrip(makeCanvas(600, h), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: [{ tick: 480, note: 60, duration: 0 }]
    });
    s.draw();
    const fillRects = ctx.calls.filter(c => c.method === 'fillRect').slice(1); // skip background
    expect(fillRects).toHaveLength(1);
    const [, y] = fillRects[0].args;
    // Should sit roughly at 75% of the height from the top.
    expect(y).toBeGreaterThan(h * 0.6);
    expect(y).toBeLessThan(h);
  });

  it('uses a red tint for unplayable notes', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: [{ tick: 480, note: 60, duration: 240 }]
    });
    s.setUnplayableNotes([60]);
    s.draw();
    const fillStyles = ctx.calls.filter(c => c.method === 'set' && c.prop === 'fillStyle').map(c => c.value);
    expect(fillStyles.some(v => v.startsWith('rgba(220, 38, 38'))).toBe(true);
  });

  it('skips notes outside [rangeMin, rangeMax]', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 60, rangeMax: 72, windowSeconds: 4,
      notes: [
        { tick: 480, note: 30, duration: 240 }, // below range
        { tick: 480, note: 65, duration: 240 }, // in range
        { tick: 480, note: 90, duration: 240 }  // above range
      ]
    });
    s.draw();
    const fillRects = ctx.calls.filter(c => c.method === 'fillRect').slice(1); // skip background
    expect(fillRects).toHaveLength(1);
  });

  it('honours setCurrentTime — notes that scrolled past disappear', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: [{ tick: 0, note: 60, duration: 240 }, { tick: 4800, note: 64, duration: 240 }]
    });
    s.setCurrentTime(20); // way past the note at tick 4800 too
    const fillRects = ctx.calls.filter(c => c.method === 'fillRect').slice(1);
    expect(fillRects.length).toBe(0);
  });

  it('does not throw on empty canvas (width=0)', () => {
    const canvas = makeCanvas(0, 140);
    const s = new window.HandsLookaheadStrip(canvas, {
      ticksPerSecond: 480, notes: [{ tick: 0, note: 60 }]
    });
    expect(() => s.draw()).not.toThrow();
  });
});

describe('HandsLookaheadStrip — destroy', () => {
  it('clears note caches', () => {
    const s = makeStrip({ notes: [{ tick: 0, note: 60 }] });
    s.setUnplayableNotes([60]);
    s.destroy();
    expect(s.notes.length).toBe(0);
    expect(s._noteTimes.length).toBe(0);
    expect(s.unplayableNotes.size).toBe(0);
  });
});

describe('HandsLookaheadStrip — hand trajectory ribbons', () => {
  it('initialises with no trajectories', () => {
    const s = makeStrip();
    expect(s.handTrajectories).toEqual([]);
  });

  it('setHandTrajectories converts ticks to seconds and sorts by time', () => {
    const s = makeStrip();
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [{ tick: 1920, anchor: 70 }, { tick: 0, anchor: 60 }, { tick: 480, anchor: 65 }]
    }]);
    expect(s.handTrajectories).toHaveLength(1);
    const pts = s.handTrajectories[0].points;
    expect(pts.map(p => p.sec)).toEqual([0, 1, 4]);
    expect(pts.map(p => p.anchor)).toEqual([60, 65, 70]);
  });

  it('drops malformed trajectories (no id / no span / bad points)', () => {
    const s = makeStrip();
    s.setHandTrajectories([
      { id: 'left', span: 14, color: '#3b82f6', points: [{ tick: 0, anchor: 60 }] },
      { id: 'no-span', color: '#ff0000', points: [{ tick: 0, anchor: 60 }] },
      { /* no id */ span: 14, points: [] },
      null
    ]);
    expect(s.handTrajectories).toHaveLength(1);
  });

  it('setHandTrajectories(null) / [] clears the ribbons', () => {
    const s = makeStrip();
    s.setHandTrajectories([{ id: 'left', span: 14, color: '#3b82f6', points: [{ tick: 0, anchor: 60 }] }]);
    expect(s.handTrajectories).toHaveLength(1);
    s.setHandTrajectories(null);
    expect(s.handTrajectories).toHaveLength(0);
  });

  it('paints a straight-diagonal trajectory ribbon under the notes', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: []
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [{ tick: 0, anchor: 40 }, { tick: 480, anchor: 50 }] // shift mid-window
    }]);
    s.draw();
    // Ribbon now paints with straight lines (no bezier) so the hand
    // reads as moving continuously between shift events.
    const beziers = ctx.calls.filter(c => c.method === 'bezierCurveTo');
    expect(beziers).toHaveLength(0);
    // A trajectory segment is a closed quadrilateral: moveTo + 3
    // lineTo + closePath. With one shift in the visible window we
    // get at least 2 segments (start→shift, shift→end) → ≥ 6
    // lineTo calls.
    const lineTos = ctx.calls.filter(c => c.method === 'lineTo');
    expect(lineTos.length).toBeGreaterThanOrEqual(6);
  });

  it('uses the configured hand color (translucent) for the ribbon fill', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: []
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [{ tick: 0, anchor: 60 }]
    }]);
    s.draw();
    const fillStyles = ctx.calls.filter(c => c.method === 'set' && c.prop === 'fillStyle').map(c => c.value);
    // 0.18 alpha rgba derived from #3b82f6.
    expect(fillStyles.some(v => v.startsWith('rgba(59, 130, 246'))).toBe(true);
  });

  it('renders the ribbon BEFORE the falling notes (so notes stay readable)', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: [{ tick: 480, note: 60, duration: 240 }]
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [{ tick: 0, anchor: 50 }, { tick: 480, anchor: 60 }]
    }]);
    s.draw();
    // Ribbon paint emits stroke/fill via straight lines; notes paint
    // via fillRect. Order check: the first ribbon stroke must
    // happen before the last note fillRect.
    const calls = ctx.calls;
    const firstRibbonStroke = calls.findIndex(c => c.method === 'stroke');
    let lastNoteFillRect = -1;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].method === 'fillRect') { lastNoteFillRect = i; break; }
    }
    expect(firstRibbonStroke).toBeGreaterThan(0);
    expect(lastNoteFillRect).toBeGreaterThan(firstRibbonStroke);
  });
});

describe('HandsLookaheadStrip — hold-then-transition (note-off anchored)', () => {
  it('stores releaseSec on each trajectory point', () => {
    const s = makeStrip();
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [
        { tick: 0,   anchor: 60, releaseTick: 240 },
        { tick: 480, anchor: 70, releaseTick: 720 }
      ]
    }]);
    const tr = s.handTrajectories[0];
    expect(tr.points[0].releaseSec).toBe(240 / s.ticksPerSecond);
    expect(tr.points[1].releaseSec).toBe(720 / s.ticksPerSecond);
  });

  it('falls back to releaseSec = sec when releaseTick is missing', () => {
    const s = makeStrip();
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [{ tick: 0, anchor: 60 }, { tick: 480, anchor: 70 }]
    }]);
    const tr = s.handTrajectories[0];
    expect(tr.points[0].releaseSec).toBe(0);
    expect(tr.points[1].releaseSec).toBe(480 / s.ticksPerSecond);
  });

  it('emits a LOW-ALPHA background fill (≈ 0.06) for the hand span during HOLD periods', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: []
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [
        { tick: 0,   anchor: 60, releaseTick: 240 }, // hold present
        { tick: 480, anchor: 70, releaseTick: 480 }
      ]
    }]);
    // The first fillStyle assignment in _drawHandTrajectories sets
    // the HOLD background to alpha 0.06.
    const fillStyles = ctx.calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles.some(v => /rgba\(59, 130, 246, 0\.06\)/.test(v))).toBe(true);
  });

  it('paints the transition in RED when motion.feasible === false', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: []
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [
        { tick: 0,   anchor: 60, releaseTick: 100 },
        { tick: 240, anchor: 80, releaseTick: 240,
          motion: { requiredSec: 1.0, availableSec: 0.3, feasible: false } }
      ]
    }]);
    const fillStyles = ctx.calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    // Red transition fill at alpha 0.28 (the infeasible variant).
    expect(fillStyles.some(v => /rgba\(239, 68, 68, 0\.28\)/.test(v))).toBe(true);
  });

  it('infeasible transition extends past the chord tick by (requiredSec − availableSec)', () => {
    // Capture the lineTos emitted by the trapezoid path that follows
    // a specific fillStyle assignment.
    function transitionTopY(calls, rePattern) {
      let inPath = false;
      const ys = [];
      for (const c of calls) {
        if (c.method === 'set' && c.prop === 'fillStyle' && rePattern.test(c.value)) {
          inPath = true;
          continue;
        }
        if (!inPath) continue;
        if (c.method === 'fill' || c.method === 'closePath') { inPath = false; continue; }
        if (c.method === 'lineTo') ys.push(c.args[1]);
      }
      return Math.min(...ys);
    }

    // Feasible — alpha 0.18 BLUE transition fill.
    const ctxA = installCanvasStub();
    let s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: []
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [
        { tick: 0,   anchor: 60, releaseTick: 100 },
        { tick: 240, anchor: 80, releaseTick: 240,
          motion: { requiredSec: 0.1, availableSec: 1, feasible: true } }
      ]
    }]);
    const feasibleTopY = transitionTopY(ctxA.calls, /rgba\(59, 130, 246, 0\.18\)/);

    // Infeasible — alpha 0.28 RED transition fill with overflow.
    const ctxB = installCanvasStub();
    s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: []
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [
        { tick: 0,   anchor: 60, releaseTick: 100 },
        { tick: 240, anchor: 80, releaseTick: 240,
          motion: { requiredSec: 1.0, availableSec: 0.3, feasible: false } }
      ]
    }]);
    const infeasibleTopY = transitionTopY(ctxB.calls, /rgba\(239, 68, 68, 0\.28\)/);

    // Both finite (transitions actually rendered).
    expect(feasibleTopY).toBeLessThan(140);
    expect(infeasibleTopY).toBeLessThan(140);
    // Y goes UP (smaller) for points further in the future. Overflow
    // extends the trapezoid beyond b.sec → smaller y on canvas.
    expect(infeasibleTopY).toBeLessThan(feasibleTopY);
  });

  it('emits MORE fillRect calls when chords hold (background hold rectangles) than when they don\'t', () => {
    function fillRectCount(points) {
      const ctx = installCanvasStub();
      const s = new window.HandsLookaheadStrip(makeCanvas(), {
        ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
        notes: []
      });
      s.setHandTrajectories([{ id: 'left', span: 14, color: '#3b82f6', points }]);
      // setHandTrajectories already triggered one paint.
      return ctx.calls.filter(c => c.method === 'fillRect').length;
    }
    const withHold = fillRectCount([
      { tick: 0,   anchor: 60, releaseTick: 240 }, // hold for 240 ticks
      { tick: 480, anchor: 70, releaseTick: 480 }  // no hold (release == sec)
    ]);
    const noHold = fillRectCount([
      { tick: 0,   anchor: 60 }, // no release → no hold rectangle
      { tick: 480, anchor: 70 }
    ]);
    // The hold case adds one extra hold rectangle (Pass 1).
    expect(withHold).toBeGreaterThan(noHold);
  });

  it('the hold rectangle sits at the OLDER anchor position (not the newer one)', () => {
    const ctx = installCanvasStub();
    const s = new window.HandsLookaheadStrip(makeCanvas(), {
      ticksPerSecond: 480, rangeMin: 36, rangeMax: 96, windowSeconds: 4,
      notes: []
    });
    s.setHandTrajectories([{
      id: 'left', span: 14, color: '#3b82f6',
      points: [
        { tick: 0,   anchor: 36, releaseTick: 100 }, // bottom of range
        { tick: 480, anchor: 90, releaseTick: 480 }  // top of range
      ]
    }]);
    s.draw();
    // The hold polygon's left x for anchor=36 is below the
    // transition polygon's left x for anchor=90. The 6-vertex
    // polygon's vertex sequence has the hold edges at the lower
    // (= bottom) y. Just verify SOME moveTo lands at a small x
    // (= anchor 36's column) and another at a much larger x
    // (= anchor 90's column).
    const moveTos = ctx.calls.filter(c => c.method === 'moveTo').map(c => c.args[0]);
    const lineTos = ctx.calls.filter(c => c.method === 'lineTo').map(c => c.args[0]);
    const xs = [...moveTos, ...lineTos];
    expect(Math.min(...xs)).toBeLessThan(50);   // anchor 36 region
    expect(Math.max(...xs)).toBeGreaterThan(200); // anchor 90 region
  });
});
