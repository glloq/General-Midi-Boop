// tests/frontend/fretboard-hand-preview-band-drag.test.js
// PR3 — verify that mouse-dragging the live hand band emits an
// onBandDrag callback with the new fret anchor, and that the band's
// displayed anchor follows the cursor while the drag is active.

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
  // jsdom returns a zero-rect by default; that's fine — clientX maps
  // 1:1 to the canvas's pixel x for this test.
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h });
  return c;
}

function placeBandAt(fb, anchor) {
  fb.setTicksPerSec(480);
  fb.setHandTrajectory([{ tick: 0, anchor, releaseTick: 0 }]);
  fb.setCurrentTime(0);
  fb.setLevel('ok');
}

describe('FretboardHandPreview — band drag (PR3)', () => {
  it('does nothing when onBandDrag is not provided', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    placeBandAt(fb, 5);
    const startAnchor = fb._currentDisplayedAnchor();
    // Simulate a click that would otherwise be on the band.
    const { x0 } = fb._handWindowX(5);
    fb._handleMouseDown({ clientX: x0 + 5, clientY: 80, preventDefault() {} });
    fb._handleMouseMove({ clientX: x0 + 80, clientY: 80, preventDefault() {} });
    fb._handleMouseUp();
    expect(fb._currentDisplayedAnchor()).toBe(startAnchor);
  });

  it('emits onBandDrag with an integer anchor when the band is dragged', () => {
    let received = null;
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      handId: 'fretting',
      onBandDrag: (id, anchor) => { received = { id, anchor }; }
    });
    placeBandAt(fb, 3);
    const { x0 } = fb._handWindowX(3);
    // Press inside the band (small offset from the left edge).
    fb._handleMouseDown({ clientX: x0 + 6, clientY: 80, preventDefault() {} });
    // Move the cursor near fret 9 — the band should follow.
    const xTarget = (fb._fretX(8) + fb._fretX(9)) / 2;
    fb._handleMouseMove({ clientX: xTarget + 6, clientY: 80, preventDefault() {} });
    expect(fb._currentDisplayedAnchor()).toBeGreaterThan(3);
    fb._handleMouseUp();

    expect(received, 'onBandDrag should fire on mouseup').not.toBeNull();
    expect(received.id).toBe('fretting');
    expect(Number.isInteger(received.anchor)).toBe(true);
    expect(received.anchor).toBeGreaterThanOrEqual(0);
    expect(received.anchor).toBeLessThanOrEqual(22 - 4);
  });

  it('does not fire onBandDrag if the click did not move the band', () => {
    let fired = false;
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      onBandDrag: () => { fired = true; }
    });
    placeBandAt(fb, 5);
    const { x0 } = fb._handWindowX(5);
    fb._handleMouseDown({ clientX: x0 + 4, clientY: 80, preventDefault() {} });
    fb._handleMouseUp();
    expect(fired).toBe(false);
  });

  it('clears the drag-anchor override when a fresh trajectory lands', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      onBandDrag: () => {}
    });
    placeBandAt(fb, 3);
    fb._dragAnchor = 9; // simulate a held drag override
    expect(fb._currentDisplayedAnchor()).toBe(9);
    // Engine pushes a new trajectory after the override is absorbed.
    fb.setHandTrajectory([{ tick: 0, anchor: 7, releaseTick: 0 }]);
    expect(fb._dragAnchor).toBeNull();
    expect(fb._currentDisplayedAnchor()).toBe(7);
  });
});
