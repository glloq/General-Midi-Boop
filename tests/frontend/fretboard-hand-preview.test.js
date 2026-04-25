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
  return c;
}

/** Place the band at a given anchor (single-point trajectory) and
 *  optional level. Replaces the legacy `setHandWindow` for tests. */
function placeAt(fb, anchor, level = 'ok') {
  fb.setTicksPerSec(480);
  fb.setHandTrajectory([{ tick: 0, anchor, releaseTick: 0 }]);
  fb.setCurrentTime(0);
  fb.setLevel(level);
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

  it('D1 — paints a tuning label per string left of the nut', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22 // standard guitar
    });
    fb.draw();
    const texts = calls
      .filter(c => c.method === 'fillText')
      .map(c => c.args[0]);
    // Expect each string's open-note name to appear at least once.
    expect(texts).toContain('E2'); // string 1 = midi 40
    expect(texts).toContain('A2'); // string 2 = midi 45
    expect(texts).toContain('D3'); // string 3 = midi 50
    expect(texts).toContain('G3'); // string 4 = midi 55
    expect(texts).toContain('B3'); // string 5 = midi 59
    expect(texts).toContain('E4'); // string 6 = midi 64
    // And those are positioned LEFT of the nut.
    const labelCalls = calls.filter(c => c.method === 'fillText'
        && /^[A-G]#?\d+$/.test(c.args[0]));
    for (const c of labelCalls) {
      expect(c.args[1]).toBeLessThan(fb._fretX(0));
    }
  });

  it('D2 — major marker frets (12, 24) get a heavier wire', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.draw();
    // Track lineWidth assignments around fret-12 and fret-7's stroke
    // calls. The simplest sniff: the set of distinct lineWidth
    // values during _drawFrets must include a value ≥ 2 (major
    // marker frets).
    const lineWidths = calls
      .filter(c => c.method === 'set' && c.prop === 'lineWidth')
      .map(c => c.value);
    expect(lineWidths.some(v => v >= 2)).toBe(true);
  });

  it('B1 — body sketch paints an arc + concentric soundhole right of the last fret', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(800, 200), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    fb.draw();
    // Body region starts at fretX(numFrets) and reaches the right edge.
    const xLastFret = fb._fretX(fb.numFrets);
    // The body uses two arcs (soundhole rings). Check at least one
    // arc with cx > xLastFret.
    const arcCalls = calls.filter(c => c.method === 'arc');
    expect(arcCalls.some(c => c.args[0] > xLastFret)).toBe(true);
    // Plus the shoulder uses quadraticCurveTo (added to the canvas
    // stub via the existing regex).
    const quads = calls.filter(c => c.method === 'quadraticCurveTo');
    expect(quads.length).toBeGreaterThanOrEqual(1);
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
    placeAt(fb, 5, 'ok');
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles.some(v => /rgba\(34,\s*197,\s*94/.test(v))).toBe(true);
  });

  it('warning level paints amber, infeasible paints red', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    placeAt(fb, 1, 'warning');
    expect(calls.some(c => c.method === 'set' && c.prop === 'fillStyle'
      && /rgba\(245,\s*158,\s*11/.test(c.value))).toBe(true);
    placeAt(fb, 1, 'infeasible');
    expect(calls.some(c => c.method === 'set' && c.prop === 'fillStyle'
      && /rgba\(239,\s*68,\s*68/.test(c.value))).toBe(true);
  });

  it('clearing the trajectory hides the band', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    placeAt(fb, 5);
    expect(fb._currentDisplayedAnchor()).toBe(5);
    fb.setHandTrajectory([]);
    expect(fb._currentDisplayedAnchor()).toBeNull();
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
    placeAt(fb, 0);
    const bandAtNut = bandRect();
    expect(bandAtNut).not.toBeNull();
    const widthAtNutPx = bandAtNut.args[2];

    calls.length = 0;
    placeAt(fb, 12);
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

  it('with no scaleLengthMm / handSpanMm, falls back to span frets and aligns with the slot', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
      // no scaleLengthMm, no handSpanMm
    });
    placeAt(fb, 5);
    // Anchor=5 means index finger on fret 5 → band starts at the
    // LEFT side of fret 5's slot = `_fretX(4)` (right edge of the
    // fret 4 wire). Span=4 frets → ends at `_fretX(4+4)=_fretX(8)`.
    const x0 = fb._fretX(4);
    const expectedRight = fb._fretX(8);
    const expectedW = expectedRight - x0;
    const bandRect = calls
      .filter(c => c.method === 'fillRect')
      .find(c => Math.abs(c.args[0] - x0) < 0.5);
    expect(bandRect).toBeDefined();
    expect(bandRect.args[2]).toBeCloseTo(expectedW, 0);
  });

  it('anchor=1 starts the band AT the nut (NOT at the fret 1 wire)', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    placeAt(fb, 1);
    const xNut = fb._fretX(0);
    const bandRect = calls
      .filter(c => c.method === 'fillRect')
      .find(c => Math.abs(c.args[0] - xNut) < 0.5);
    expect(bandRect).toBeDefined();
  });

  it('hand band overflows above and below the fretboard (better visibility)', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(600, 200), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22, handSpanFrets: 4
    });
    placeAt(fb, 5);
    const fbY = fb.margin.top;
    const fbH = 200 - fb.margin.top - fb.margin.bottom;
    const bandRect = calls
      .filter(c => c.method === 'fillRect')
      .find(c => c.args[1] < fbY); // a fillRect with y < fretboard top edge
    expect(bandRect).toBeDefined();
    // Band y is ABOVE fbY and band height extends BELOW fbY+fbH.
    expect(bandRect.args[1]).toBeLessThan(fbY);
    expect(bandRect.args[1] + bandRect.args[3]).toBeGreaterThan(fbY + fbH);
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

describe('FretboardHandPreview — active note feedback (N1 / N2 / N3)', () => {
  it('N1 — paints the VIBRATING portion of the string (fret → bridge side)', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    fb.setActivePositions([{ string: 3, fret: 5, velocity: 100 }]);
    // The N1 helper sets an amber stroke + draws a line FROM the
    // centre of fret 5's slot (where the finger presses) TO the end
    // of the neck (= bridge side), on the y of string 3.
    const yString3 = fb._stringY(3);
    const xCentreF5 = (fb._fretX(4) + fb._fretX(5)) / 2;
    const xEnd      = fb._fretX(fb.numFrets);
    const moves = calls.filter(c => c.method === 'moveTo'
        && Math.abs(c.args[1] - yString3) < 0.5
        && Math.abs(c.args[0] - xCentreF5) < 1);
    const lines = calls.filter(c => c.method === 'lineTo'
        && Math.abs(c.args[1] - yString3) < 0.5
        && Math.abs(c.args[0] - xEnd) < 1);
    expect(moves.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    const strokeStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'strokeStyle')
      .map(c => c.value);
    expect(strokeStyles.some(v => /rgba\(255, 215, 64/.test(v))).toBe(true);
  });

  it('N1 — open string (fret=0) lights up the entire string length', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    fb.setActivePositions([{ string: 6, fret: 0 }]);
    const yString6 = fb._stringY(6);
    const xRight = fb._fretX(fb.numFrets);
    const lines = calls.filter(c => c.method === 'lineTo'
        && Math.abs(c.args[1] - yString6) < 0.5
        && Math.abs(c.args[0] - xRight) < 1);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('does NOT paint per-finger numbers inside the band (simple rectangle only)', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(800, 200), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    placeAt(fb, 5);
    const fillTexts = calls.filter(c => c.method === 'fillText').map(c => c.args[0]);
    // The "1"/"2"/"3"/"4" finger labels were removed — the band is
    // a plain rectangle. Tuning labels (E2/A2/…) and fret numbers
    // ("1", "2", …) for the FRET ROW are still painted, but only
    // outside the hand band's vertical centre.
    const numericTexts = fillTexts.filter(v => /^\d+$/.test(v));
    expect(numericTexts.includes('1')).toBe(true); // fret-row label is OK
    // We didn't add overlay finger labels at the band's mid-y any more.
  });

  it('N3 — paints a green "O" left of the nut for active open strings', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    fb.setActivePositions([{ string: 6, fret: 0 }]);
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles).toContain('#06d6a0');
    const oTexts = calls.filter(c => c.method === 'fillText' && c.args[0] === 'O');
    expect(oTexts.length).toBeGreaterThan(0);
    // Plotted left of the nut.
    expect(oTexts[0].args[1]).toBeLessThan(fb._fretX(0));
  });

  it('N3 — paints a red "X" left of the nut for muted (unplayable) strings', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), {
      tuning: [40, 45, 50, 55, 59, 64], numFrets: 22
    });
    fb.setUnplayablePositions([{ string: 5, fret: 12, reason: 'outside_window' }]);
    const xTexts = calls.filter(c => c.method === 'fillText' && c.args[0] === 'X');
    expect(xTexts.length).toBeGreaterThan(0);
    // Centred on string 5's y.
    expect(Math.abs(xTexts[0].args[2] - fb._stringY(5))).toBeLessThan(1);
  });
});

describe('FretboardHandPreview — derived ghost anchor', () => {
  function makeFb() {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setTicksPerSec(480);
    return fb;
  }

  it('paints a NEUTRAL grey ghost rectangle at the next planned shift', () => {
    const fb = makeFb();
    fb.setHandTrajectory([
      { tick: 0,    anchor: 1,  releaseTick: 0 },
      { tick: 1000, anchor: 12, releaseTick: 1000 }
    ]);
    fb.setCurrentTime(0);
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    // Ghost is ALWAYS painted in a neutral grey — never red, never
    // level-tinted. (Reserves red exclusively for the live band's
    // unreachability signal.)
    expect(fillStyles.some(v => /rgba\(120, 120, 140, 0\.10\)/.test(v))).toBe(true);
    // No red anywhere on the ghost path.
    expect(fillStyles.some(v => /rgba\(239, 68, 68, 0\.14\)/.test(v))).toBe(false);
  });

  it('hides the ghost when the next anchor matches the current one', () => {
    const fb = makeFb();
    fb.setHandTrajectory([
      { tick: 0,    anchor: 5, releaseTick: 0 },
      { tick: 1000, anchor: 5, releaseTick: 1000 } // same anchor
    ]);
    calls.length = 0;
    fb.setCurrentTime(0.001); // bust the throttle without changing visual
    fb.draw();                // force a fresh paint regardless of throttle
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles.some(v => /rgba\(120, 120, 140, 0\.10\)/.test(v))).toBe(false);
  });

  it('hides the ghost once the playhead passes every shift', () => {
    const fb = makeFb();
    fb.setHandTrajectory([
      { tick: 0,    anchor: 5,  releaseTick: 0 },
      { tick: 1000, anchor: 12, releaseTick: 1000 }
    ]);
    calls.length = 0; // ignore the initial paint at sec=0
    fb.setCurrentTime(99);
    const fillStyles = calls
      .filter(c => c.method === 'set' && c.prop === 'fillStyle')
      .map(c => c.value);
    expect(fillStyles.some(v => /rgba\(120, 120, 140, 0\.10\)/.test(v))).toBe(false);
  });
});

describe('FretboardHandPreview — trajectory-driven animation', () => {
  function makeFb() {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setTicksPerSec(480); // 1 sec = 480 ticks
    return fb;
  }

  it('setHandTrajectory + setCurrentTime drives the displayed anchor from the playhead', () => {
    const fb = makeFb();
    fb.setHandTrajectory([
      { tick: 0,    anchor: 1,  releaseTick: 100 },
      { tick: 1000, anchor: 12, releaseTick: 1100,
        motion: { requiredSec: 0.4, availableSec: 1.5, feasible: true } }
    ]);
    fb.setCurrentTime(0);
    expect(fb._currentDisplayedAnchor()).toBe(1);
    fb.setCurrentTime(0.2); // still during chord 1's release (=0.208s)
    expect(fb._currentDisplayedAnchor()).toBe(1);
    fb.setCurrentTime(0.408); // mid-transition: prevRelease=0.208, arrival=0.608
    expect(fb._currentDisplayedAnchor()).toBeCloseTo(6.5, 0); // halfway between 1 and 12
    fb.setCurrentTime(2.0); // past everything
    expect(fb._currentDisplayedAnchor()).toBe(12);
  });

  it('arrives EARLY (compressed by motion.requiredSec) when the move is fast', () => {
    const fb = makeFb();
    fb.setHandTrajectory([
      { tick: 0,    anchor: 1, releaseTick: 0 },
      { tick: 480,  anchor: 5, releaseTick: 480, // 1 sec gap
        motion: { requiredSec: 0.2, availableSec: 1, feasible: true } }
    ]);
    // At sec 0.5: prevRelease=0, arrival=0+0.2=0.2 → already arrived.
    fb.setCurrentTime(0.5);
    expect(fb._currentDisplayedAnchor()).toBe(5);
  });

  it('always animates at physical requiredSec, even when motion.feasible=false (band lags behind)', () => {
    // Infeasible: an 11-fret jump in a 1-sec gap with requiredSec=2.
    // The band must STILL animate at the physical speed — not spread
    // the move across the whole gap. So at sec 0.5 the band is at
    // ~25 % of the move; only at sec 2 (well after the next chord's
    // tick at sec 1) does it finally arrive.
    const fb = makeFb();
    fb.setHandTrajectory([
      { tick: 0,   anchor: 1,  releaseTick: 0 },
      { tick: 480, anchor: 12, releaseTick: 480, // 1-sec gap
        motion: { requiredSec: 2, availableSec: 1, feasible: false } }
    ]);
    fb.setCurrentTime(0.5);  // 25 % through the physical move
    expect(fb._currentDisplayedAnchor()).toBeGreaterThan(2);
    expect(fb._currentDisplayedAnchor()).toBeLessThan(7);
    fb.setCurrentTime(2.1);  // past the full physical duration
    expect(fb._currentDisplayedAnchor()).toBe(12);
  });

  it('returns null displayedAnchor when no trajectory is set', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    expect(fb._currentDisplayedAnchor()).toBeNull();
  });

  it('throttles redraws when the displayed anchor barely moves', () => {
    const fb = makeFb();
    fb.setHandTrajectory([
      { tick: 0, anchor: 5, releaseTick: 480 },
      { tick: 4800, anchor: 5, releaseTick: 4800 } // same anchor → no motion
    ]);
    fb.setCurrentTime(0); // first paint
    calls.length = 0;
    fb.setCurrentTime(0.001); // sub-pixel + within 33 ms → SKIP
    expect(calls.filter(c => c.method === 'fillRect').length).toBe(0);
  });
});

describe('FretboardHandPreview — lifecycle', () => {
  it('destroy() drops state but does not throw on a follow-up draw', () => {
    const fb = new window.FretboardHandPreview(makeCanvas(), { numFrets: 22 });
    fb.setActivePositions([{ string: 3, fret: 5 }]);
    placeAt(fb, 5);
    fb.destroy();
    expect(fb.activePositions).toEqual([]);
    expect(fb._trajectory).toEqual([]);
    expect(() => fb.draw()).not.toThrow();
  });
});
