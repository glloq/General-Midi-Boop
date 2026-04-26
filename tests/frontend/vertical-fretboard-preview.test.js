// tests/frontend/vertical-fretboard-preview.test.js
// Smoke tests for the vertical sticky preview used in the editor modal.
// Verifies that the band stays in mm coordinates (constant pixel
// height across anchors) and that the drag-to-pin emits a callback.

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

function makeCanvas(w = 140, h = 600) {
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

describe('VerticalFretboardPreview', () => {
  it('draws strings as vertical lines and frets as horizontal lines', () => {
    const fb = new window.VerticalFretboardPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    fb.draw();
    const horizontalLines = calls.filter((c, i) => {
      if (c.method !== 'lineTo') return false;
      const move = calls[i - 1];
      return move?.method === 'moveTo' && Math.abs(move.args[1] - c.args[1]) < 0.5;
    });
    expect(horizontalLines.length).toBeGreaterThan(20); // ≥ 22 frets + nut
  });

  it('keeps a constant pixel band height as the anchor slides down the neck', () => {
    const fb = new window.VerticalFretboardPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    placeAt(fb, 3);
    const bandLow = calls.filter(c => c.method === 'fillRect')
      .find(c => c.args[3] > 20); // band is the only tall fillRect
    expect(bandLow).toBeDefined();
    const heightAtFret3 = bandLow.args[3];

    calls.length = 0;
    placeAt(fb, 15);
    const bandHigh = calls.filter(c => c.method === 'fillRect')
      .find(c => c.args[3] > 20);
    expect(bandHigh).toBeDefined();
    expect(bandHigh.args[3]).toBeCloseTo(heightAtFret3, 0);
  });

  it('drag emits onBandDrag with an integer fret anchor', () => {
    let received = null;
    const fb = new window.VerticalFretboardPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4,
      handId: 'fretting',
      onBandDrag: (id, anchor) => { received = { id, anchor }; }
    });
    placeAt(fb, 3);
    const { y0 } = fb._handWindowY(3);
    fb._handleMouseDown({ clientX: 70, clientY: y0 + 4, preventDefault() {} });
    // Move down toward fret 9.
    const yTarget = (fb._fretY(8) + fb._fretY(9)) / 2;
    fb._handleMouseMove({ clientX: 70, clientY: yTarget + 4, preventDefault() {} });
    fb._handleMouseUp();
    expect(received).not.toBeNull();
    expect(received.id).toBe('fretting');
    expect(Number.isInteger(received.anchor)).toBe(true);
    expect(received.anchor).toBeGreaterThan(3);
  });
});
