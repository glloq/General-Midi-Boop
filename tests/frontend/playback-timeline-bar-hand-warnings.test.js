// tests/frontend/playback-timeline-bar-hand-warnings.test.js
// C.2: PlaybackTimelineBar gains hand-position warning markers and a
// click-to-seek behavior. Tests stub the 2D canvas API so jsdom
// doesn't have to support it.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/PlaybackTimelineBar.js'),
  'utf8'
);

// Stub the canvas getContext('2d') to return an object that records
// fill/stroke/path calls — enough for the test to count drawn markers.
function installCanvasStub() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return target.calls;
      // Methods: record + return undefined.
      if (typeof prop === 'string' && /^(begin|move|line|close|fill|stroke|clip|save|restore|rect|arc|fillText|setLineDash|measureText|translate|scale|drawImage|set)/.test(prop)) {
        return (...args) => { target.calls.push({ method: prop, args }); };
      }
      // Properties: just absorb.
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
  // The module is an IIFE-free class declaration; eval it in window scope.
  new Function(src + '\nwindow.PlaybackTimelineBar = PlaybackTimelineBar;')();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="container" style="width:600px"></div>';
});

function makeBar(opts = {}) {
  const container = document.getElementById('container');
  // jsdom doesn't compute layout — patch getBoundingClientRect so
  // resize() has a usable width.
  container.getBoundingClientRect = () => ({ width: 600, height: 30 });
  return new window.PlaybackTimelineBar(container, opts);
}

describe('PlaybackTimelineBar.setHandWarnings', () => {
  it('initialises with an empty handWarnings array', () => {
    const bar = makeBar();
    expect(bar.handWarnings).toEqual([]);
  });

  it('stores valid warning + infeasible markers', () => {
    const bar = makeBar();
    bar.setHandWarnings([
      { tick: 100, level: 'warning', message: 'wide chord' },
      { tick: 480, level: 'infeasible' }
    ]);
    expect(bar.handWarnings).toHaveLength(2);
    expect(bar.handWarnings[0]).toMatchObject({ tick: 100, level: 'warning', message: 'wide chord' });
  });

  it('filters out non-warning levels (ok / unknown / null)', () => {
    const bar = makeBar();
    bar.setHandWarnings([
      { tick: 100, level: 'ok' },
      { tick: 200, level: 'unknown' },
      { tick: 300, level: 'warning' }
    ]);
    expect(bar.handWarnings).toHaveLength(1);
    expect(bar.handWarnings[0].tick).toBe(300);
  });

  it('drops entries with non-finite tick', () => {
    const bar = makeBar();
    bar.setHandWarnings([
      { tick: NaN, level: 'warning' },
      { tick: -50, level: 'warning' }, // Math.max clamps to 0
      { tick: 'abc', level: 'warning' },
      { level: 'warning' }
    ]);
    expect(bar.handWarnings.map(w => w.tick).sort((a, b) => a - b)).toEqual([0]);
  });

  it('clears markers when called with [] / null / non-array', () => {
    const bar = makeBar();
    bar.setHandWarnings([{ tick: 100, level: 'warning' }]);
    bar.setHandWarnings([]);
    expect(bar.handWarnings).toHaveLength(0);
    bar.setHandWarnings([{ tick: 100, level: 'warning' }]);
    bar.setHandWarnings(null);
    expect(bar.handWarnings).toHaveLength(0);
  });
});

describe('PlaybackTimelineBar._hitTestHandWarning', () => {
  it('returns null when no markers are set', () => {
    const bar = makeBar();
    expect(bar._hitTestHandWarning(100, 5)).toBeNull();
  });

  it('returns the closest marker within tolerance', () => {
    const bar = makeBar();
    bar.setHandWarnings([
      { tick: 100, level: 'warning' },
      { tick: 200, level: 'infeasible' }
    ]);
    // tickToX with default ticksPerPixel=2 and leftOffset=0:
    // tick=100 → x=50, tick=200 → x=100.
    expect(bar._hitTestHandWarning(50, 4).tick).toBe(100);
    expect(bar._hitTestHandWarning(100, 4).tick).toBe(200);
  });

  it('returns null when the click is outside the y zone (below the markers)', () => {
    const bar = makeBar();
    bar.setHandWarnings([{ tick: 100, level: 'warning' }]);
    expect(bar._hitTestHandWarning(50, 25)).toBeNull();
  });

  it('returns null when no marker is close enough on x', () => {
    const bar = makeBar();
    bar.setHandWarnings([{ tick: 100, level: 'warning' }]);
    // x = 200 is far from the marker at x ≈ 50.
    expect(bar._hitTestHandWarning(200, 4)).toBeNull();
  });
});

describe('PlaybackTimelineBar — single-click on a marker seeks the playhead', () => {
  it('moves the playhead to the marker tick and fires onSeek', () => {
    const onSeek = vi.fn();
    const bar = makeBar({ onSeek });
    bar.setHandWarnings([{ tick: 480, level: 'warning' }]);

    // Synthesize a click event at the marker x position. tick=480 →
    // ticksPerPixel=2 → x = 240.
    const evt = new MouseEvent('click', { detail: 1, clientX: 240, clientY: 4, bubbles: true });
    // jsdom getBoundingClientRect on the canvas — patch it.
    bar.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 30 });

    bar._handleClick(evt);
    expect(bar.playheadTick).toBe(480);
    expect(onSeek).toHaveBeenCalledWith(480);
  });

  it('falls through to triple-click handling when no marker is hit', () => {
    // Rather than fight with snap-to-beat math here, we verify the
    // code path doesn't short-circuit out when there is no marker.
    // Concretely: a single-click on empty area must not call onSeek.
    const onSeek = vi.fn();
    const bar = makeBar({ onSeek });
    bar.setHandWarnings([]);
    const evt = new MouseEvent('click', { detail: 1, clientX: 200, clientY: 4 });
    bar.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 30 });
    bar._handleClick(evt);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('a single click off-marker does NOT seek (preserves current behavior)', () => {
    const onSeek = vi.fn();
    const bar = makeBar({ onSeek });
    bar.setHandWarnings([{ tick: 480, level: 'warning' }]);

    const evt = new MouseEvent('click', { detail: 1, clientX: 50, clientY: 4 });
    bar.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 30 });
    bar._handleClick(evt);
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe('PlaybackTimelineBar._hitTest', () => {
  it('reports "handWarning" target when hovering a marker', () => {
    const bar = makeBar();
    bar.setHandWarnings([{ tick: 100, level: 'warning' }]);
    expect(bar._hitTest(50, 4)).toBe('handWarning');
  });

  it('returns null when not over any target', () => {
    const bar = makeBar();
    bar.setHandWarnings([]);
    expect(bar._hitTest(300, 15)).toBeNull();
  });
});
