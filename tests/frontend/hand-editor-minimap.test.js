// tests/frontend/hand-editor-minimap.test.js
// Smoke tests for the editor's overview minimap.

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
    resolve(__dirname, '../../public/js/features/auto-assign/HandEditorMinimap.js'),
    'utf8'
  );
  new Function(src)();
});

beforeEach(() => {
  installCanvasStub();
});

function makeCanvas(w = 800, h = 48) {
  const c = document.createElement('canvas');
  Object.defineProperty(c, 'clientWidth', { get: () => w });
  Object.defineProperty(c, 'clientHeight', { get: () => h });
  c.width = w;
  c.height = h;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h });
  return c;
}

describe('HandEditorMinimap', () => {
  it('draws chord dots — red when unplayable, grey otherwise', () => {
    const m = new window.HandEditorMinimap(makeCanvas(), {
      totalSec: 10,
      ticksPerSec: 480,
      numFrets: 22
    });
    m.setTimeline([
      { type: 'chord', tick: 0, unplayable: [] },
      { type: 'chord', tick: 480, unplayable: [{ note: 60, reason: 'outside_window' }] }
    ]);
    calls.length = 0;
    m.draw();
    const fillSets = calls
      .filter((c) => c.method === 'set' && c.prop === 'fillStyle')
      .map((c) => String(c.value));
    expect(
      fillSets.some((v) => /239,\s*68,\s*68/.test(v)),
      'expected a red fillStyle for the unplayable chord'
    ).toBe(true);
    expect(
      fillSets.some((v) => /75,\s*85,\s*99/.test(v)),
      'expected a grey fillStyle for the OK chord'
    ).toBe(true);
  });

  it('clicking inside the viewport rect starts a drag, outside seeks', () => {
    let seeked = null,
      scrolled = null;
    const m = new window.HandEditorMinimap(makeCanvas(800, 48), {
      totalSec: 100,
      ticksPerSec: 480,
      numFrets: 22,
      onSeek: (s) => {
        seeked = s;
      },
      onScrollViewport: (s) => {
        scrolled = s;
      }
    });
    m.setViewport(40, 10); // viewport spans sec 40-50 → x=320..400 (800px / 100s)

    // Click outside viewport (at x=200 → sec 25): seek + scroll
    m._handleMouseDown({ clientX: 200, clientY: 24, preventDefault() {} });
    expect(seeked).toBeCloseTo(25, 1);
    expect(scrolled).not.toBeNull();
    expect(m._drag).toBeNull(); // outside-click does not start a drag

    // Click inside viewport (at x=350 → sec 43.75): drag, no seek
    seeked = null;
    scrolled = null;
    m._handleMouseDown({ clientX: 350, clientY: 24, preventDefault() {} });
    expect(seeked).toBeNull();
    expect(m._drag).not.toBeNull();
    m._handleMouseMove({ clientX: 360, clientY: 24 });
    expect(scrolled).not.toBeNull();
    m._handleMouseUp();
    expect(m._drag).toBeNull();
  });

  it('draws a yellow vertical bar for each infeasible shift', () => {
    const m = new window.HandEditorMinimap(makeCanvas(), {
      totalSec: 10,
      ticksPerSec: 480,
      numFrets: 22
    });
    m.setTimeline([
      { type: 'shift', tick: 1440, motion: { requiredSec: 1, availableSec: 0.2, feasible: false } }
    ]);
    calls.length = 0;
    m.draw();
    const fillSets = calls
      .filter((c) => c.method === 'set' && c.prop === 'fillStyle')
      .map((c) => String(c.value));
    expect(
      fillSets.some((v) => /#f5c518/i.test(v)),
      'expected the speed-warning yellow color'
    ).toBe(true);
  });
});
