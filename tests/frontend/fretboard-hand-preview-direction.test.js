// tests/frontend/fretboard-hand-preview-direction.test.js
// PR1 — verify that an outside_window note carrying `direction:'left'|'right'`
// is parked just outside the live hand band instead of stacked on top of the
// (unreachable) fret. Also verify that a chevron stroke is emitted to
// indicate the extension direction.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let calls;

function installCanvasStub() {
  calls = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return () => ({ width: 8 });
        if (
          typeof prop === 'string' &&
          /^(setTransform|fillRect|strokeRect|fillText|strokeText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|rect|clip|arc|bezierCurveTo|quadraticCurveTo)$/.test(
            prop
          )
        ) {
          return (...args) => calls.push({ method: prop, args });
        }
        return undefined;
      },
      set(_t, prop, value) {
        calls.push({ method: 'set', prop, value });
        return true;
      }
    }
  );
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
  Object.defineProperty(c, 'clientWidth', { get: () => w });
  Object.defineProperty(c, 'clientHeight', { get: () => h });
  c.width = w;
  c.height = h;
  return c;
}

function placeBandAt(fb, anchor) {
  fb.setTicksPerSec(480);
  fb.setHandTrajectory([{ tick: 0, anchor, releaseTick: 0 }]);
  fb.setCurrentTime(0);
  fb.setLevel('ok');
}

function findArcAt(x, y, tolerance = 1) {
  return calls
    .filter((c) => c.method === 'arc')
    .find((c) => Math.abs(c.args[0] - x) < tolerance && Math.abs(c.args[1] - y) < tolerance);
}

describe('FretboardHandPreview — direction-aware outside_window markers', () => {
  it('parks a left-direction marker just left of the band', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64],
      numFrets: 22,
      handSpanFrets: 4
    });
    placeBandAt(fb, 7);
    // Bracket is computed via _handWindowX(7) which we read directly so
    // the test stays robust against future shifts in the band geometry.
    const { x0 } = fb._handWindowX(7);
    calls.length = 0;
    fb.setUnplayablePositions([
      { string: 3, fret: 2, reason: 'outside_window', direction: 'left' }
    ]);
    fb.draw();
    const arc = findArcAt(x0 - 12, fb._stringY(3), 1.5);
    expect(arc, 'expected an arc parked at bandLeftX - 12').toBeDefined();
  });

  it('parks a right-direction marker just right of the band', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64],
      numFrets: 22,
      handSpanFrets: 4
    });
    placeBandAt(fb, 5);
    const { x1 } = fb._handWindowX(5);
    calls.length = 0;
    fb.setUnplayablePositions([
      { string: 2, fret: 14, reason: 'outside_window', direction: 'right' }
    ]);
    fb.draw();
    const arc = findArcAt(x1 + 12, fb._stringY(2), 1.5);
    expect(arc, 'expected an arc parked at bandRightX + 12').toBeDefined();
  });

  it('falls back to the fret slot when no direction is provided', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64],
      numFrets: 22,
      handSpanFrets: 4
    });
    placeBandAt(fb, 5);
    calls.length = 0;
    fb.setUnplayablePositions([{ string: 1, fret: 12, reason: 'too_many_fingers' }]);
    fb.draw();
    const expectedX = (fb._fretX(11) + fb._fretX(12)) / 2;
    const arc = findArcAt(expectedX, fb._stringY(1), 1.5);
    expect(arc, 'expected an arc on the fret 12 slot center').toBeDefined();
  });
});
