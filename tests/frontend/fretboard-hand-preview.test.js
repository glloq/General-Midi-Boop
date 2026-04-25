// tests/frontend/fretboard-hand-preview.test.js
// FretboardHandPreview is the horizontal fretboard widget mounted in
// HandsPreviewPanel for fretted instruments. We verify the geometric
// fret spacing, the hand-window rectangle (true mm scale + fret
// fallback), and the engine-driven setters (setActivePositions,
// setHandWindow).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let calls;

function installCanvasStub() {
  calls = [];
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 8 });
      if (typeof prop === 'string' && /^(setTransform|fillRect|strokeRect|fillText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|rect|clip|arc|bezierCurveTo|quadraticCurveTo)$/.test(prop)) {
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
  return c;
}

describe('FretboardHandPreview — geometric fret spacing', () => {
  it('places fret 12 at half the available scale length', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 24
    });
    const x0 = fb._fretX(0);
    const x12 = fb._fretX(12);
    const x24 = fb._fretX(24);
    // Fret 12 sits at L*(1-2^(-12/12)) = L/2 of total scale.
    // Total scale here is from fret 0 to fret 24 (the entire usable
    // width), so fret 12 should be at x0 + 0.5*(...) of the
    // numerator's normalised distance — close to the midpoint.
    const ratio = (x12 - x0) / (x24 - x0);
    // 0.5 / (1 - 2^-2) = 0.5 / 0.75 = 0.6667 — fret 12 sits 2/3 of
    // the way from nut to fret 24.
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.7);
  });

  it('higher frets are shorter than lower frets (compression)', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    const fret1Width = fb._fretX(1) - fb._fretX(0);
    const fret12Width = fb._fretX(12) - fb._fretX(11);
    const fret20Width = fb._fretX(20) - fb._fretX(19);
    expect(fret1Width).toBeGreaterThan(fret12Width);
    expect(fret12Width).toBeGreaterThan(fret20Width);
  });

  it('lays out strings with the lowest pitch at the bottom', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(600, 200), {
      tuning: [40, 45, 50, 55, 59, 64]
    });
    const yLow  = fb._stringY(1); // E2
    const yHigh = fb._stringY(6); // E4
    expect(yLow).toBeGreaterThan(yHigh);
  });
});

describe('FretboardHandPreview — hand window rectangle', () => {
  it('renders a translucent green band at the configured anchor', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22,
      scaleLengthMm: 650, handSpanMm: 80
    });
    fb.setHandWindow({ anchorFret: 5, spanFrets: 4, level: 'ok' });
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles.some(v => /rgba\(34,\s*197,\s*94/.test(v))).toBe(true);
  });

  it('warning level paints amber, infeasible paints red', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    fb.setHandWindow({ anchorFret: 0, spanFrets: 4, level: 'warning' });
    expect(calls.some(c => c.method === 'set' && c.prop === 'fillStyle'
      && /rgba\(245,\s*158,\s*11/.test(c.value))).toBe(true);
    fb.setHandWindow({ anchorFret: 0, spanFrets: 4, level: 'infeasible' });
    expect(calls.some(c => c.method === 'set' && c.prop === 'fillStyle'
      && /rgba\(239,\s*68,\s*68/.test(c.value))).toBe(true);
  });

  it('null hand window clears the band', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setHandWindow({ anchorFret: 5, spanFrets: 4 });
    expect(fb.handWindow).not.toBeNull();
    fb.setHandWindow(null);
    expect(fb.handWindow).toBeNull();
  });

  it('with scaleLengthMm + handSpanMm, the band has the same pixel width regardless of position (true mm scale)', () => {
    // The hand is physically 80mm wide. On a fretboard rendered at
    // true scale, the band's pixel width must be constant as the
    // anchor moves up the neck — it's the FRET COUNT under the band
    // that grows (compressed frets), not the band itself.
    function bandRect() {
      // Find the fillRect whose fillStyle is the green hand-window
      // tint. We track the preceding fillStyle for each fillRect
      // call so the fretboard background (a different colour) is
      // never confused with the band.
      let lastStyle = null;
      for (const c of calls) {
        if (c.method === 'set' && c.prop === 'fillStyle') lastStyle = c.value;
        if (c.method === 'fillRect' && /rgba\(34,/.test(lastStyle || '')) {
          return c;
        }
      }
      return null;
    }
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22,
      scaleLengthMm: 650, handSpanMm: 80
    });
    fb.setHandWindow({ anchorFret: 0, spanFrets: 4 });
    const bandAtNut = bandRect();
    expect(bandAtNut).not.toBeNull();
    const widthAtNutPx = bandAtNut.args[2];

    calls.length = 0;
    fb.setHandWindow({ anchorFret: 12, spanFrets: 4 });
    const bandAtH12 = bandRect();
    expect(bandAtH12).not.toBeNull();
    expect(bandAtH12.args[2]).toBeCloseTo(widthAtNutPx, 5);

    // …and the right edge at fret 12 covers MORE frets than at the
    // nut because fret spacing compresses upward.
    const reachAtNut  = bandAtNut.args[0]  + bandAtNut.args[2];
    const reachAtH12  = bandAtH12.args[0]  + bandAtH12.args[2];
    let fretsReachedAtNut = 0, fretsReachedAtH12 = 0;
    for (let f = 1; f <= fb.numFrets; f++) {
      if (fb._fretX(f) <= reachAtNut) fretsReachedAtNut = f;
      if (fb._fretX(f) <= reachAtH12) fretsReachedAtH12 = f - 12;
    }
    expect(fretsReachedAtH12).toBeGreaterThan(fretsReachedAtNut);
  });

  it('with no scaleLengthMm / handSpanMm, falls back to span frets', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
      // no scaleLengthMm, no handSpanMm
    });
    fb.setHandWindow({ anchorFret: 5, spanFrets: 4 });
    // Expected band right edge = fretX(5+4)=fretX(9).
    const expectedRight = fb._fretX(9);
    const x0 = fb._fretX(5);
    const expectedW = expectedRight - x0;
    const bandRect = calls
      .filter(c => c.method === 'fillRect')
      .find(c => Math.abs(c.args[0] - x0) < 0.5);
    expect(bandRect).toBeDefined();
    expect(bandRect.args[2]).toBeCloseTo(expectedW, 0);
  });
});

describe('FretboardHandPreview — active positions', () => {
  it('paints a finger dot at the centre of the (string × fret) cell', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    calls.length = 0;
    fb.setActivePositions([{ string: 3, fret: 5, velocity: 100 }]);
    const arcCalls = calls.filter(c => c.method === 'arc');
    expect(arcCalls.length).toBeGreaterThan(0);
    const expectedX = (fb._fretX(4) + fb._fretX(5)) / 2;
    const expectedY = fb._stringY(3);
    expect(arcCalls.some(c => Math.abs(c.args[0] - expectedX) < 1
                          && Math.abs(c.args[1] - expectedY) < 1)).toBe(true);
  });

  it('open-string notes paint an OPEN dot before the nut', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    calls.length = 0;
    fb.setActivePositions([{ string: 6, fret: 0, velocity: 100 }]);
    const arcCalls = calls.filter(c => c.method === 'arc');
    expect(arcCalls.length).toBeGreaterThan(0);
    const lastArc = arcCalls[arcCalls.length - 1];
    // x is left of fret 0 (the nut).
    expect(lastArc.args[0]).toBeLessThan(fb._fretX(0));
  });

  it('clearing active positions stops painting fingers', () => {
    // Use fret 2 — not a standard inlay marker — so the only arc
    // matching that x-coordinate would be a finger dot.
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setActivePositions([{ string: 3, fret: 2 }]);
    const expectedX = (fb._fretX(1) + fb._fretX(2)) / 2;
    const expectedY = fb._stringY(3);
    calls.length = 0;
    fb.setActivePositions([]);
    const arcCalls = calls.filter(c => c.method === 'arc');
    expect(arcCalls.some(c => Math.abs(c.args[0] - expectedX) < 1
                          && Math.abs(c.args[1] - expectedY) < 1)).toBe(false);
  });
});

describe('FretboardHandPreview — unplayable positions', () => {
  it('setUnplayablePositions paints a red disc on top of the fret cell', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    calls.length = 0;
    fb.setUnplayablePositions([{ string: 3, fret: 7, reason: 'too_many_fingers' }]);
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles.some(v => /rgba\(239, 68, 68, 0\.55\)/.test(v))).toBe(true);
    // Plus a stroke at the same position with the dark red border.
    const strokeStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'strokeStyle')
      .map(c => c.value);
    expect(strokeStyles).toContain('#dc2626');
  });

  it('filters malformed entries (missing string or fret)', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setUnplayablePositions([
      { string: 3, fret: 5 },
      { string: 'bad' },             // dropped
      { fret: 7 },                   // dropped
      null,                          // dropped
      { string: 1, fret: 0 }
    ]);
    expect(fb.unplayablePositions).toHaveLength(2);
  });

  it('passing [] clears the overlay', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setUnplayablePositions([{ string: 3, fret: 5 }]);
    expect(fb.unplayablePositions).toHaveLength(1);
    fb.setUnplayablePositions([]);
    expect(fb.unplayablePositions).toHaveLength(0);
  });
});

describe('FretboardHandPreview — ghost anchor', () => {
  it('setGhostAnchor renders a faint translucent rectangle', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    fb.setGhostAnchor({ anchorFret: 5, spanFrets: 4, level: 'ok' });
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    // Ghost ok fill is rgba(34, 197, 94, 0.10) — distinct from the
    // active hand window's 0.22.
    expect(fillStyles.some(v => /rgba\(34, 197, 94, 0\.10\)/.test(v))).toBe(true);
  });

  it('ghost anchor uses warning/infeasible tints when its motion is at risk', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setGhostAnchor({ anchorFret: 5, spanFrets: 4, level: 'infeasible' });
    expect(calls.some(c => c.method === 'set' && c.prop === 'fillStyle'
        && /rgba\(239, 68, 68, 0\.14\)/.test(c.value))).toBe(true);
  });

  it('null ghost anchor clears the overlay', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setGhostAnchor({ anchorFret: 5, spanFrets: 4 });
    expect(fb.ghostAnchor).not.toBeNull();
    fb.setGhostAnchor(null);
    expect(fb.ghostAnchor).toBeNull();
  });

  it('rejects malformed ghost anchor input', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setGhostAnchor({ anchorFret: 'bad', spanFrets: 4 });
    expect(fb.ghostAnchor).toBeNull();
    fb.setGhostAnchor({ anchorFret: 5, spanFrets: -1 });
    expect(fb.ghostAnchor).toBeNull();
  });
});

describe('FretboardHandPreview — lifecycle', () => {
  it('destroy() drops state but does not throw on a follow-up draw', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setActivePositions([{ string: 3, fret: 5 }]);
    fb.setHandWindow({ anchorFret: 5, spanFrets: 4 });
    fb.destroy();
    expect(fb.activePositions).toEqual([]);
    expect(fb.handWindow).toBeNull();
    expect(() => fb.draw()).not.toThrow();
  });
});
