// tests/frontend/tablature-renderer-warnings.test.js
// C.5: TablatureRenderer gains a setHandWarnings API + paints a
// colored border around problematic events. Tests focus on the API
// shape, the per-event matching logic, and the paint side effect via
// a stubbed canvas context.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/TablatureRenderer.js'),
  'utf8'
);

function installCanvasStub() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return target.calls;
      if (prop === 'measureText') return () => ({ width: 8 });
      if (typeof prop === 'string' && /^(setTransform|fillRect|strokeRect|fillText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|rect|clip|arc)$/.test(prop)) {
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
  new Function(src + '\nwindow.TablatureRenderer = TablatureRenderer;')();
});

beforeEach(() => {
  document.body.innerHTML = '<canvas id="tab"></canvas>';
});

function makeRenderer() {
  const canvas = document.getElementById('tab');
  canvas.width = 800;
  canvas.height = 200;
  return new window.TablatureRenderer(canvas, {
    tuning: [40, 45, 50, 55, 59, 64],
    numFrets: 24,
    isFretless: false
  });
}

describe('TablatureRenderer.setHandWarnings', () => {
  it('initialises with an empty list', () => {
    const r = makeRenderer();
    expect(r.handWarnings).toEqual([]);
  });

  it('stores valid warning + infeasible entries', () => {
    const r = makeRenderer();
    r.setHandWarnings([
      { tick: 100, level: 'warning', code: 'chord_span_exceeded' },
      { tick: 480, level: 'infeasible', code: 'too_many_fingers', string: 3 }
    ]);
    expect(r.handWarnings).toHaveLength(2);
    expect(r.handWarnings[1].string).toBe(3);
  });

  it('filters out non-warning levels (ok / unknown / null)', () => {
    const r = makeRenderer();
    r.setHandWarnings([
      { tick: 100, level: 'ok' },
      { tick: 200, level: 'unknown' },
      { tick: 300, level: 'warning' }
    ]);
    expect(r.handWarnings).toHaveLength(1);
    expect(r.handWarnings[0].tick).toBe(300);
  });

  it('drops entries with non-finite tick', () => {
    const r = makeRenderer();
    r.setHandWarnings([
      { tick: NaN, level: 'warning' },
      { tick: 'oops', level: 'warning' },
      { level: 'warning' }
    ]);
    expect(r.handWarnings).toHaveLength(0);
  });

  it('clears markers when called with null / non-array', () => {
    const r = makeRenderer();
    r.setHandWarnings([{ tick: 100, level: 'warning' }]);
    r.setHandWarnings(null);
    expect(r.handWarnings).toEqual([]);
    r.setHandWarnings([{ tick: 100, level: 'warning' }]);
    r.setHandWarnings('not an array');
    expect(r.handWarnings).toEqual([]);
  });
});

describe('TablatureRenderer._eventWarningLevel', () => {
  it('returns null when no warnings are set', () => {
    const r = makeRenderer();
    expect(r._eventWarningLevel({ tick: 100, string: 1, fret: 3 })).toBeNull();
  });

  it('matches by tick within ±30 ticks tolerance', () => {
    const r = makeRenderer();
    r.setHandWarnings([{ tick: 100, level: 'warning' }]);
    expect(r._eventWarningLevel({ tick: 90,  string: 1, fret: 3 })).toBe('warning');
    expect(r._eventWarningLevel({ tick: 130, string: 1, fret: 3 })).toBe('warning');
    expect(r._eventWarningLevel({ tick: 150, string: 1, fret: 3 })).toBeNull();
  });

  it('chord-wide warnings (no string) cover every event at that tick', () => {
    const r = makeRenderer();
    r.setHandWarnings([{ tick: 480, level: 'infeasible', code: 'too_many_fingers' }]);
    expect(r._eventWarningLevel({ tick: 480, string: 1, fret: 3 })).toBe('infeasible');
    expect(r._eventWarningLevel({ tick: 480, string: 5, fret: 7 })).toBe('infeasible');
  });

  it('per-event warnings (with string) only match the right string', () => {
    const r = makeRenderer();
    r.setHandWarnings([{ tick: 480, string: 1, level: 'warning' }]);
    expect(r._eventWarningLevel({ tick: 480, string: 1, fret: 3 })).toBe('warning');
    expect(r._eventWarningLevel({ tick: 480, string: 2, fret: 3 })).toBeNull();
  });

  it('picks the worst level when several warnings match', () => {
    const r = makeRenderer();
    r.setHandWarnings([
      { tick: 480, level: 'warning' },
      { tick: 480, level: 'infeasible' }
    ]);
    expect(r._eventWarningLevel({ tick: 480, string: 1, fret: 3 })).toBe('infeasible');
  });
});

describe('TablatureRenderer._drawTabEvents — warning border', () => {
  it('draws an amber strokeRect around an event with a warning', () => {
    const ctx = installCanvasStub();
    document.body.innerHTML = '<canvas id="tab"></canvas>';
    const canvas = document.getElementById('tab');
    canvas.width = 800; canvas.height = 200;
    const r = new window.TablatureRenderer(canvas, { tuning: [40,45,50,55,59,64] });
    r.scrollX = 0;
    r.setTabEvents([
      { tick: 100, string: 1, fret: 5, duration: 480, midiNote: 64, channel: 0 }
    ]);
    r.setHandWarnings([{ tick: 100, level: 'warning' }]);
    r._drawTabEvents(800, 200);

    // Find the strokeStyle set just before a strokeRect.
    let lastStroke = null;
    for (const c of ctx.calls) {
      if (c.method === 'set' && c.prop === 'strokeStyle') lastStroke = c.value;
      if (c.method === 'strokeRect') break;
    }
    expect(lastStroke).toBe('#f59e0b');
  });

  it('draws a red strokeRect for level=infeasible', () => {
    const ctx = installCanvasStub();
    document.body.innerHTML = '<canvas id="tab"></canvas>';
    const canvas = document.getElementById('tab');
    canvas.width = 800; canvas.height = 200;
    const r = new window.TablatureRenderer(canvas, { tuning: [40,45,50,55,59,64] });
    r.scrollX = 0;
    r.setTabEvents([
      { tick: 100, string: 1, fret: 5, duration: 480, midiNote: 64, channel: 0 }
    ]);
    r.setHandWarnings([{ tick: 100, level: 'infeasible' }]);
    r._drawTabEvents(800, 200);

    let lastStroke = null;
    for (const c of ctx.calls) {
      if (c.method === 'set' && c.prop === 'strokeStyle') lastStroke = c.value;
      if (c.method === 'strokeRect') break;
    }
    expect(lastStroke).toBe('#ef4444');
  });

  it('does not draw a border when no warning matches', () => {
    const ctx = installCanvasStub();
    document.body.innerHTML = '<canvas id="tab"></canvas>';
    const canvas = document.getElementById('tab');
    canvas.width = 800; canvas.height = 200;
    const r = new window.TablatureRenderer(canvas, { tuning: [40,45,50,55,59,64] });
    r.scrollX = 0;
    r.setTabEvents([
      { tick: 100, string: 1, fret: 5, duration: 480, midiNote: 64, channel: 0 }
    ]);
    r.setHandWarnings([]); // empty
    r._drawTabEvents(800, 200);

    expect(ctx.calls.filter(c => c.method === 'strokeRect').length).toBe(0);
  });
});
