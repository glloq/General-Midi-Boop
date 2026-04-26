// tests/frontend/fretboard-hand-preview-motion-curve.test.js
// PR2 — verify that an infeasible motion (motion.feasible === false)
// between two trajectory points triggers a yellow dashed curve drawn
// between the corresponding band centers.

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
    resolve(__dirname, '../../public/js/features/auto-assign/FretboardHandPreview.js'),
    'utf8'
  );
  new Function(src)();
});

beforeEach(() => {
  installCanvasStub();
});

function makeCanvas(w = 600, h = 160) {
  const c = document.createElement('canvas');
  Object.defineProperty(c, 'clientWidth',  { get: () => w });
  Object.defineProperty(c, 'clientHeight', { get: () => h });
  c.width = w; c.height = h;
  return c;
}

/**
 * Count quadraticCurveTo calls whose most-recent preceding strokeStyle
 * was the warm yellow used for the infeasible-motion cue. Filters out
 * the body sketch shoulder which also uses quadraticCurveTo but with
 * a wood-tone stroke.
 */
function yellowQuadraticCurves() {
  let lastStroke = null;
  let count = 0;
  for (const c of calls) {
    if (c.method === 'set' && c.prop === 'strokeStyle') lastStroke = String(c.value);
    if (c.method === 'quadraticCurveTo' && lastStroke && /#f5c518/i.test(lastStroke)) {
      count++;
    }
  }
  return count;
}

describe('FretboardHandPreview — infeasible motion curve', () => {
  it('emits a yellow dashed quadraticCurveTo when motion.feasible is false', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    fb.setTicksPerSec(480);
    // prev=fret 2 at tick 0 ; next=fret 14 at tick 240, motion.feasible=false
    fb.setHandTrajectory([
      { tick: 0, anchor: 2, releaseTick: 60 },
      { tick: 240, anchor: 14, releaseTick: 360,
        motion: { requiredSec: 1.2, availableSec: 0.4, feasible: false } }
    ]);
    fb.setCurrentTime(0.1); // playhead between prev and next
    // setCurrentTime triggers a draw — collect calls AFTER reset.
    calls.length = 0;
    fb.draw();

    expect(yellowQuadraticCurves(), 'expected ≥ 1 yellow curve').toBeGreaterThanOrEqual(1);

    // Sanity: the dash pattern [6,4] must have been set right before
    // the yellow stroke.
    const dashCall = calls.find(c => c.method === 'setLineDash'
      && Array.isArray(c.args[0]) && c.args[0][0] === 6 && c.args[0][1] === 4);
    expect(dashCall, 'expected setLineDash([6,4]) before the curve').toBeDefined();
  });

  it('does NOT draw the curve when motion.feasible is true', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    fb.setTicksPerSec(480);
    fb.setHandTrajectory([
      { tick: 0, anchor: 2, releaseTick: 60 },
      { tick: 480, anchor: 6, releaseTick: 600,
        motion: { requiredSec: 0.2, availableSec: 0.9, feasible: true } }
    ]);
    fb.setCurrentTime(0.1);
    calls.length = 0;
    fb.draw();
    expect(yellowQuadraticCurves()).toBe(0);
  });

  it('does NOT draw the curve once the playhead has crossed the destination tick', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    fb.setTicksPerSec(480);
    fb.setHandTrajectory([
      { tick: 0, anchor: 2, releaseTick: 60 },
      { tick: 240, anchor: 14, releaseTick: 360,
        motion: { requiredSec: 1.2, availableSec: 0.4, feasible: false } }
    ]);
    // Playhead well past tick 240 → no upcoming infeasible move.
    fb.setCurrentTime(2.0);
    calls.length = 0;
    fb.draw();
    expect(yellowQuadraticCurves()).toBe(0);
  });
});
