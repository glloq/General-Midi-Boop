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

  it('setActiveNotes accepts a flat list of midi numbers (legacy form)', () => {
    const kb = new window.KeyboardPreview(makeCanvas());
    kb.setActiveNotes([60, 64, NaN, 67, undefined]);
    expect(kb.activeNotes.size).toBe(3);
    expect(kb.activeNotes.has(60)).toBe(true);
    expect(kb.activeNotes.get(60)).toBeNull();
  });

  it('setActiveNotes accepts tagged shape [{midi, handId}, …]', () => {
    const kb = new window.KeyboardPreview(makeCanvas());
    kb.setActiveNotes([
      { midi: 60, handId: 'left' },
      { midi: 64, handId: 'right' },
      { midi: 100 } // no handId → null
    ]);
    expect(kb.activeNotes.size).toBe(3);
    expect(kb.activeNotes.get(60)).toBe('left');
    expect(kb.activeNotes.get(64)).toBe('right');
    expect(kb.activeNotes.get(100)).toBeNull();
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

  it('paints an active WHITE key in the colour of its assigned hand band', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 60, rangeMax: 71 });
    kb.setHandBands([{ id: 'left', low: 60, high: 74, color: '#3b82f6' }]);
    kb.setActiveNotes([{ midi: 60, handId: 'left' }]); // C5 is white
    // Active white note 60 should fill with rgba derived from #3b82f6
    // (alpha 0.45) BEFORE the unplayable-red fill.
    const fillStyles = ctx.calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles.some(v => /rgba\(59, 130, 246, 0\.45\)/.test(v))).toBe(true);
  });

  it('paints an active BLACK key in the FULL hand colour (not the legacy blue)', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 60, rangeMax: 71 });
    kb.setHandBands([{ id: 'right', low: 60, high: 74, color: '#10b981' }]);
    kb.setActiveNotes([{ midi: 61, handId: 'right' }]); // C#5 is black
    const fillStyles = ctx.calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles).toContain('#10b981');
    // The legacy active-black colour should NOT be used.
    expect(fillStyles).not.toContain('#1d4ed8');
  });

  it('falls back to the legacy active blue when activeNotes have no handId', () => {
    const ctx = installCanvasStub();
    const kb = new window.KeyboardPreview(makeCanvas(), { rangeMin: 60, rangeMax: 71 });
    kb.setActiveNotes([60]); // legacy form
    const fillStyles = ctx.calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles).toContain('#bfdbfe');
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

describe('KeyboardPreview — public key-position API (for fingers overlay)', () => {
  it('keyXAt + keyWidth describe each key as the renderer draws it', () => {
    // Single-octave window 60..71 (C4..B4) on a 700px canvas →
    // 7 white keys + 5 black. White key width = 100px each.
    const kb = new window.KeyboardPreview(makeCanvas(700, 120), {
      rangeMin: 60, rangeMax: 71
    });
    kb._geo();
    // White keys: C, D, E, F, G, A, B at indices 0..6.
    expect(kb.keyXAt(60)).toBe(0);          // C4 left edge
    expect(kb.keyWidth(60)).toBeCloseTo(100, 1);
    expect(kb.keyXAt(62)).toBeCloseTo(100, 1); // D4 left edge (after C4)
    expect(kb.keyXAt(64)).toBeCloseTo(200, 1); // E4
    expect(kb.keyXAt(71)).toBeCloseTo(600, 1); // B4 (7th white key, idx 6)
    // Black key C#4 sits at 65% offset of C4's white-key width.
    expect(kb.keyXAt(61)).toBeCloseTo(65, 1);
    expect(kb.keyWidth(61)).toBeCloseTo(60, 1); // narrower than white
  });

  it('keyCenterAt interpolates between adjacent keys for smooth animation', () => {
    const kb = new window.KeyboardPreview(makeCanvas(700, 120), {
      rangeMin: 60, rangeMax: 71
    });
    kb._geo();
    const cC = kb.keyCenterAt(60); // C4 centre = 0 + 50 = 50
    const cCs = kb.keyCenterAt(61); // C#4 centre = 65 + 30 = 95
    expect(cC).toBeCloseTo(50, 1);
    expect(cCs).toBeCloseTo(95, 1);
    // Halfway through animation: should sit between the two centres.
    const cMid = kb.keyCenterAt(60.5);
    expect(cMid).toBeCloseTo((50 + 95) / 2, 1);
  });

  it('keyXAt clamps to the visible range so out-of-range queries are safe', () => {
    const kb = new window.KeyboardPreview(makeCanvas(700, 120), {
      rangeMin: 60, rangeMax: 71
    });
    kb._geo();
    // Below range — clamped to 60.
    expect(kb.keyXAt(50)).toBe(kb.keyXAt(60));
    // Above range — clamped to 71.
    expect(kb.keyXAt(80)).toBe(kb.keyXAt(71));
  });

  it('every C in the 88-key range has its actual centre (not uniform)', () => {
    // Regression: a uniform pxPerPitch mapping drifts visibly across
    // the 88-key span. The fingers overlay used to use that and
    // fingers slid off the keys at the extremes.
    const kb = new window.KeyboardPreview(makeCanvas(800, 140), {
      rangeMin: 21, rangeMax: 108
    });
    kb._geo();
    const ww = kb._whiteKeyWidth();
    // C4 is the 24th white key from A0 (idx 23).
    expect(kb.keyCenterAt(60)).toBeCloseTo(23 * ww + ww / 2, 1);
    // C8 (108) is the 52nd white key (idx 51) — last key of the range.
    expect(kb.keyCenterAt(108)).toBeCloseTo(51 * ww + ww / 2, 1);
    // Compare with the uniform-pxPerPitch fallback the modal used
    // to use: those would diverge by several pixels at the extremes.
    const uniformC8 = (108 - 21 + 0.5) * (800 / 88);
    const realC8    = kb.keyCenterAt(108);
    expect(Math.abs(realC8 - uniformC8)).toBeGreaterThan(2);
  });
});
