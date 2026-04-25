// tests/frontend/keyboard-preview.test.js
// E.6.4: KeyboardPreview is a small canvas widget for the routing-
// summary HandsPreviewPanel. Tests stub the 2D canvas API to count
// drawn shapes and inspect colour decisions; click handling is
// validated via a synthesized MouseEvent.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/auto-assign/KeyboardPreview.js'),
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
  new Function(src)();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

function makeCanvas(width = 600, height = 120) {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth',  { value: width,  configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  document.body.appendChild(canvas);
  return canvas;
}

describe('KeyboardPreview — construction + setters', () => {
  it('initialises with default A0..C8 range', () => {
    const kb = new window.KeyboardPreview(makeCanvas());
    expect(kb.rangeMin).toBe(21);
    expect(kb.rangeMax).toBe(108);
  });

  it('honours a custom range', () => {
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 36, rangeMax: 84 });
    expect(kb.rangeMin).toBe(36);
    expect(kb.rangeMax).toBe(84);
  });

  it('setRange swaps min/max if passed in reverse', () => {
    const kb = new window.KeyboardPreview(makeCanvas());
    kb.setRange(96, 60);
    expect(kb.rangeMin).toBe(60);
    expect(kb.rangeMax).toBe(96);
  });

  it('setActiveNotes stores a Set, ignoring non-finite entries', () => {
    const kb = new window.KeyboardPreview(makeCanvas());
    kb.setActiveNotes([60, 64, NaN, 67, undefined]);
    expect(kb.activeNotes.size).toBe(3);
    expect(kb.activeNotes.has(60)).toBe(true);
  });

  it('setUnplayableNotes accepts both number and {note} entries', () => {
    const kb = new window.KeyboardPreview(makeCanvas());
    kb.setUnplayableNotes([95, { note: 100, hand: 'right' }]);
    expect(kb.unplayableNotes.size).toBe(2);
    expect(kb.unplayableNotes.get(100).hand).toBe('right');
  });

  it('setHandBands filters malformed entries', () => {
    const kb = new window.KeyboardPreview(makeCanvas());
    kb.setHandBands([
      { id: 'left', low: 40, high: 54, color: '#3b82f6' },
      { id: 'bad', low: 'oops', high: 60, color: '#000000' },
      { id: 'right', low: 60, high: 74 } // missing color
    ]);
    expect(kb.handBands).toHaveLength(1);
    expect(kb.handBands[0].id).toBe('left');
  });
});

describe('KeyboardPreview — rendering', () => {
  it('paints a fillRect per white key + per black key', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 60, rangeMax: 71 }); // one octave
    kb.draw();
    const fillRects = ctx.calls.filter(c => c.method === 'fillRect');
    // background + 7 whites + 5 blacks = 13.
    expect(fillRects.length).toBeGreaterThanOrEqual(13);
  });

  it('uses a red fill for unplayable white keys', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 60, rangeMax: 71 });
    kb.setUnplayableNotes([60]);
    kb.draw();
    // Find the fillStyle just before the fillRect for white key 60.
    let lastFill = null;
    let foundRed = false;
    for (const c of ctx.calls) {
      if (c.method === 'set' && c.prop === 'fillStyle') lastFill = c.value;
      if (c.method === 'fillRect' && lastFill === '#fee2e2') {
        foundRed = true;
        break;
      }
    }
    expect(foundRed).toBe(true);
  });

  it('uses a red border around an unplayable white key', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 60, rangeMax: 71 });
    kb.setUnplayableNotes([60]);
    kb.draw();
    const strokeColors = ctx.calls
      .filter((c, i) => c.method === 'set' && c.prop === 'strokeStyle')
      .map(c => c.value);
    expect(strokeColors).toContain('#dc2626');
  });

  it('uses a red fill for unplayable black keys (the marker is on the black key itself)', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 60, rangeMax: 71 });
    kb.setUnplayableNotes([61]); // C#5 is black
    kb.draw();
    let lastFill = null;
    let found = false;
    for (const c of ctx.calls) {
      if (c.method === 'set' && c.prop === 'fillStyle') lastFill = c.value;
      // Black-key red fill is the strong red, not the light one.
      if (c.method === 'fillRect' && lastFill === '#dc2626') { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it('paints a hand band with the configured colour', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 21, rangeMax: 108 });
    kb.setHandBands([{ id: 'left', low: 40, high: 54, color: '#3b82f6' }]);
    kb.draw();
    const fillStyles = ctx.calls.filter(c => c.method === 'set' && c.prop === 'fillStyle').map(c => c.value);
    // Band fill uses an rgba derived from #3b82f6.
    expect(fillStyles.some(v => v.startsWith('rgba(59, 130, 246'))).toBe(true);
  });

  it('does not throw on a 0-width canvas (skips drawing)', () => {
    const canvas = makeCanvas(0, 120);
    const kb = new window.KeyboardPreview(canvas);
    expect(() => kb.draw()).not.toThrow();
  });
});

describe('KeyboardPreview — click handler', () => {
  it('calls onKeyClick with the MIDI number under the cursor', () => {
    const onKeyClick = vi.fn();
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, { rangeMin: 60, rangeMax: 71, onKeyClick });
    // 7 white keys → ~100px each. Click around the middle of the
    // first white (C5 = 60).
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }));
    expect(onKeyClick).toHaveBeenCalledWith(60);
  });

  it('does not call onKeyClick when none is registered', () => {
    const canvas = makeCanvas();
    const kb = new window.KeyboardPreview(canvas, { rangeMin: 60, rangeMax: 71 });
    expect(() => {
      canvas.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }));
    }).not.toThrow();
  });
});

describe('KeyboardPreview — band drag', () => {
  function dispatchOn(canvas, type, x, y) {
    const evt = new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y
    });
    canvas.dispatchEvent(evt);
  }
  function dispatchDocumentUp() {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  it('mousedown on a band starts a drag (no callback yet)', () => {
    const onBandDrag = vi.fn();
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, {
      rangeMin: 60, rangeMax: 71, onBandDrag
    });
    kb.setHandBands([{ id: 'left', low: 60, high: 64, color: '#3b82f6' }]);
    kb.draw();

    // Band sits in the bottom 8px of the canvas (bandHeight default).
    dispatchOn(canvas, 'mousedown', 30, 116);
    expect(kb._drag).not.toBeNull();
    expect(kb._drag.bandId).toBe('left');
    expect(onBandDrag).not.toHaveBeenCalled();
  });

  it('mousemove updates the band low/high and triggers a redraw', () => {
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, {
      rangeMin: 60, rangeMax: 71,
      onBandDrag: () => {}
    });
    kb.setHandBands([{ id: 'left', low: 60, high: 64, color: '#3b82f6' }]);
    kb.draw();
    dispatchOn(canvas, 'mousedown', 30, 116);
    // Move 200 px to the right — that's two whites (200/100 = 2 white
    // keys). Two whites starting at C5 reach E5 (64); since the click
    // started at C5 (offset 0), the band should now anchor at E5 (64).
    dispatchOn(canvas, 'mousemove', 230, 116);
    expect(kb.handBands[0].low).toBeGreaterThan(60);
  });

  it('mouseup fires onBandDrag with the new anchor', () => {
    const onBandDrag = vi.fn();
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, {
      rangeMin: 60, rangeMax: 71, onBandDrag
    });
    kb.setHandBands([{ id: 'left', low: 60, high: 64, color: '#3b82f6' }]);
    kb.draw();
    dispatchOn(canvas, 'mousedown', 30, 116);
    dispatchOn(canvas, 'mousemove', 230, 116);
    dispatchDocumentUp();
    expect(onBandDrag).toHaveBeenCalled();
    const [handId, anchor] = onBandDrag.mock.calls[0];
    expect(handId).toBe('left');
    expect(anchor).toBeGreaterThan(60);
  });

  it('a click without drag does NOT fire onBandDrag', () => {
    const onBandDrag = vi.fn();
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, {
      rangeMin: 60, rangeMax: 71, onBandDrag
    });
    kb.setHandBands([{ id: 'left', low: 60, high: 64, color: '#3b82f6' }]);
    kb.draw();
    dispatchOn(canvas, 'mousedown', 30, 116);
    dispatchDocumentUp(); // no movement in between
    expect(onBandDrag).not.toHaveBeenCalled();
  });

  it('clamps the anchor so the band stays inside [rangeMin, rangeMax]', () => {
    const onBandDrag = vi.fn();
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, {
      rangeMin: 60, rangeMax: 71, onBandDrag
    });
    kb.setHandBands([{ id: 'left', low: 60, high: 64, color: '#3b82f6' }]);
    kb.draw();
    dispatchOn(canvas, 'mousedown', 30, 116);
    // Drag way past the right edge.
    dispatchOn(canvas, 'mousemove', 9999, 116);
    dispatchDocumentUp();
    // span = 4; rangeMax = 71 → max anchor = 71 - 4 = 67.
    const anchor = onBandDrag.mock.calls[0][1];
    expect(anchor).toBeLessThanOrEqual(67);
  });

  it('does not start a drag when mousedown lands on a key (above the band zone)', () => {
    const onBandDrag = vi.fn();
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, {
      rangeMin: 60, rangeMax: 71, onBandDrag
    });
    kb.setHandBands([{ id: 'left', low: 60, high: 64, color: '#3b82f6' }]);
    kb.draw();
    dispatchOn(canvas, 'mousedown', 30, 50); // mid-canvas → on the keys
    expect(kb._drag).toBeNull();
  });

  it('a drag ending on the band suppresses the next key click', () => {
    const onKeyClick = vi.fn();
    const onBandDrag = vi.fn();
    const canvas = makeCanvas(700, 120);
    const kb = new window.KeyboardPreview(canvas, {
      rangeMin: 60, rangeMax: 71, onKeyClick, onBandDrag
    });
    kb.setHandBands([{ id: 'left', low: 60, high: 64, color: '#3b82f6' }]);
    kb.draw();
    dispatchOn(canvas, 'mousedown', 30, 116);
    dispatchOn(canvas, 'mousemove', 230, 116);
    dispatchDocumentUp();
    // The browser then dispatches a click — make sure we don't
    // accidentally interpret it as a key-click.
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 230, clientY: 116 }));
    expect(onKeyClick).not.toHaveBeenCalled();
  });
});

describe('KeyboardPreview — destroy', () => {
  it('clears caches and removes the click listener', () => {
    const onKeyClick = vi.fn();
    const canvas = makeCanvas();
    const kb = new window.KeyboardPreview(canvas, { rangeMin: 60, rangeMax: 71, onKeyClick });
    kb.setActiveNotes([60]);
    kb.destroy();
    expect(kb.activeNotes.size).toBe(0);
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }));
    expect(onKeyClick).not.toHaveBeenCalled();
  });
});
