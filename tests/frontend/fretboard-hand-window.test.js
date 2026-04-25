// tests/frontend/fretboard-hand-window.test.js
// C.4: FretboardDiagram gains a setHandWindow API + a translucent
// band drawn between anchorFret and anchorFret+spanFrets. The band's
// tint follows the same level taxonomy the rest of the hand-position
// pipeline uses.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/FretboardDiagram.js'),
  'utf8'
);

function installCanvasStub() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return target.calls;
      if (typeof prop === 'string' && /^(setTransform|fillRect|strokeRect|fillText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|measureText|rect|clip|arc)$/.test(prop)) {
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
  new Function(src + '\nwindow.FretboardDiagram = FretboardDiagram;')();
});

beforeEach(() => {
  document.body.innerHTML = '<canvas id="fb"></canvas>';
});

function makeDiagram(opts = {}) {
  const canvas = document.getElementById('fb');
  Object.defineProperty(canvas, 'clientWidth',  { value: 300, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
  return new window.FretboardDiagram(canvas, opts);
}

describe('FretboardDiagram.setHandWindow', () => {
  it('initialises with no hand window', () => {
    const d = makeDiagram();
    expect(d.handWindow).toBeNull();
  });

  it('stores a valid hand window with default level=ok', () => {
    const d = makeDiagram();
    d.setHandWindow({ anchorFret: 5, spanFrets: 4 });
    expect(d.handWindow).toEqual({ anchorFret: 5, spanFrets: 4, level: 'ok' });
  });

  it('honours the level argument', () => {
    const d = makeDiagram();
    d.setHandWindow({ anchorFret: 5, spanFrets: 4, level: 'warning' });
    expect(d.handWindow.level).toBe('warning');
    d.setHandWindow({ anchorFret: 5, spanFrets: 4, level: 'infeasible' });
    expect(d.handWindow.level).toBe('infeasible');
  });

  it('clamps anchorFret to ≥ 0', () => {
    const d = makeDiagram();
    d.setHandWindow({ anchorFret: -3, spanFrets: 4 });
    expect(d.handWindow.anchorFret).toBe(0);
  });

  it('clears the window on null / undefined input', () => {
    const d = makeDiagram();
    d.setHandWindow({ anchorFret: 5, spanFrets: 4 });
    d.setHandWindow(null);
    expect(d.handWindow).toBeNull();
    d.setHandWindow({ anchorFret: 5, spanFrets: 4 });
    d.setHandWindow(undefined);
    expect(d.handWindow).toBeNull();
  });

  it('rejects invalid spanFrets (≤0 / NaN)', () => {
    const d = makeDiagram();
    d.setHandWindow({ anchorFret: 5, spanFrets: 0 });
    expect(d.handWindow).toBeNull();
    d.setHandWindow({ anchorFret: 5, spanFrets: -1 });
    expect(d.handWindow).toBeNull();
    d.setHandWindow({ anchorFret: 5, spanFrets: NaN });
    expect(d.handWindow).toBeNull();
  });

  it('destroy() clears the hand window', () => {
    const d = makeDiagram();
    d.setHandWindow({ anchorFret: 5, spanFrets: 4 });
    d.destroy();
    expect(d.handWindow).toBeNull();
  });
});

describe('FretboardDiagram._drawHandWindow — paint side effect', () => {
  it('draws a fillRect + dashed strokeRect when a window is set', () => {
    const ctx = installCanvasStub();
    document.body.innerHTML = '<canvas id="fb"></canvas>';
    const canvas = document.getElementById('fb');
    Object.defineProperty(canvas, 'clientWidth',  { value: 300, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    const d = new window.FretboardDiagram(canvas);
    d.setHandWindow({ anchorFret: 5, spanFrets: 4, level: 'warning' });
    // _drawHandWindow needs the fret-Y cache populated.
    d._drawHandWindow(300, 600);

    const fillRects = ctx.calls.filter(c => c.method === 'fillRect');
    const strokeRects = ctx.calls.filter(c => c.method === 'strokeRect');
    expect(fillRects.length).toBeGreaterThanOrEqual(1);
    expect(strokeRects.length).toBeGreaterThanOrEqual(1);
    // Dashed stroke: setLineDash called once with a non-empty array,
    // then once with [] to reset.
    const dashCalls = ctx.calls.filter(c => c.method === 'setLineDash');
    expect(dashCalls.length).toBe(2);
    expect(dashCalls[0].args[0]).toEqual([4, 3]);
    expect(dashCalls[1].args[0]).toEqual([]);
  });

  it('uses an amber tint for level=warning', () => {
    const ctx = installCanvasStub();
    document.body.innerHTML = '<canvas id="fb"></canvas>';
    const canvas = document.getElementById('fb');
    Object.defineProperty(canvas, 'clientWidth',  { value: 300, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    const d = new window.FretboardDiagram(canvas);
    d.setHandWindow({ anchorFret: 5, spanFrets: 4, level: 'warning' });
    d._drawHandWindow(300, 600);

    // Capture the most recent fillStyle before the fillRect call.
    let lastFill = null;
    for (const c of ctx.calls) {
      if (c.method === 'set' && c.prop === 'fillStyle') lastFill = c.value;
      if (c.method === 'fillRect') break;
    }
    expect(lastFill).toMatch(/245.*158.*11/); // amber rgba
  });

  it('uses a red tint for level=infeasible', () => {
    const ctx = installCanvasStub();
    document.body.innerHTML = '<canvas id="fb"></canvas>';
    const canvas = document.getElementById('fb');
    Object.defineProperty(canvas, 'clientWidth',  { value: 300, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    const d = new window.FretboardDiagram(canvas);
    d.setHandWindow({ anchorFret: 5, spanFrets: 4, level: 'infeasible' });
    d._drawHandWindow(300, 600);
    let lastFill = null;
    for (const c of ctx.calls) {
      if (c.method === 'set' && c.prop === 'fillStyle') lastFill = c.value;
      if (c.method === 'fillRect') break;
    }
    expect(lastFill).toMatch(/239.*68.*68/); // red rgba
  });
});
