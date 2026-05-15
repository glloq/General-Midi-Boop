// tests/frontend/vertical-fretboard-preview.test.js
// Smoke tests for the sticky neck preview used in the editor modal.
// The neck is drawn HORIZONTALLY (frets on X, strings as rows). The
// class/global name is kept (VerticalFretboardPreview) for backward
// compatibility. Verifies that the band stays in mm coordinates
// (constant pixel WIDTH across anchors) and that the drag-to-pin emits
// a callback.

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
    resolve(__dirname, '../../public/js/features/auto-assign/VerticalFretboardPreview.js'),
    'utf8'
  );
  new Function(src)();
});

beforeEach(() => {
  installCanvasStub();
});

function makeCanvas(w = 600, h = 150) {
  const c = document.createElement('canvas');
  Object.defineProperty(c, 'clientWidth',  { get: () => w });
  Object.defineProperty(c, 'clientHeight', { get: () => h });
  c.width = w; c.height = h;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h });
  return c;
}

function placeAt(fb, anchor) {
  fb.setTicksPerSec(480);
  fb.setHandTrajectory([{ tick: 0, anchor, releaseTick: 0 }]);
  fb.setCurrentTime(0);
  fb.setLevel('ok');
}

// Find the green hand-band fillRect by tracking the fillStyle set just
// before each fillRect call.
function bandRect() {
  let lastFill = null;
  for (const c of calls) {
    if (c.method === 'set' && c.prop === 'fillStyle') lastFill = String(c.value);
    if (c.method === 'fillRect' && lastFill && /34, 197, 94/.test(lastFill)) {
      return c.args; // [x, y, w, h]
    }
  }
  return null;
}

describe('VerticalFretboardPreview (horizontal neck)', () => {
  it('draws strings as horizontal lines and frets as vertical lines', () => {
    const fb = new window.VerticalFretboardPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    fb.draw();
    const verticalLines = calls.filter((c, i) => {
      if (c.method !== 'lineTo') return false;
      const move = calls[i - 1];
      return move?.method === 'moveTo' && Math.abs(move.args[0] - c.args[0]) < 0.5;
    });
    expect(verticalLines.length).toBeGreaterThan(20); // ≥ 22 frets + nut
  });

  it('keeps a constant pixel band width as the anchor slides along the neck', () => {
    const fb = new window.VerticalFretboardPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    placeAt(fb, 3);
    const low = bandRect();
    expect(low).not.toBeNull();
    const widthAtFret3 = low[2];

    calls.length = 0;
    placeAt(fb, 15);
    const high = bandRect();
    expect(high).not.toBeNull();
    expect(high[2]).toBeCloseTo(widthAtFret3, 0);
  });

  it('drag emits onBandDrag with an integer fret anchor', () => {
    let received = null;
    const fb = new window.VerticalFretboardPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      handId: 'fretting',
      onBandDrag: (id, anchor) => { received = { id, anchor }; }
    });
    placeAt(fb, 3);
    const { x0 } = fb._handWindowX(3);
    fb._handleMouseDown({ clientX: x0 + 4, clientY: 70, preventDefault() {} });
    // Move right toward fret 9.
    const xTarget = (fb._fretX(8) + fb._fretX(9)) / 2;
    fb._handleMouseMove({ clientX: xTarget + 4, clientY: 70, preventDefault() {} });
    fb._handleMouseUp();
    expect(received).not.toBeNull();
    expect(received.id).toBe('fretting');
    expect(Number.isInteger(received.anchor)).toBe(true);
    expect(received.anchor).toBeGreaterThan(3);
  });
});
