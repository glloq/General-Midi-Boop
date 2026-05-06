// tests/frontend/keyboard-chords-finger-spacing.test.js
// Guards the logarithmic finger spacing for fret_sliding_fingers in the
// virtual piano modal.  Previously stripes/dots were uniformly distributed
// inside the hand band; they now follow equal-tempered fret geometry.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
    resolve(__dirname, '../../public/js/features/keyboard/KeyboardChords.js'),
    'utf8'
);

// ── DOM stub ──────────────────────────────────────────────────────────────────
// We only need getElementById + createElement; jsdom provides the rest.

beforeAll(() => {
    new Function(src)();
});

beforeEach(() => {
    document.body.innerHTML = '';
});

// ── Helper: build a minimal mixin instance ────────────────────────────────────
function makeMixin(overrides = {}) {
    const mixin = window.KeyboardChordsMixin;
    const obj = Object.create(null);
    for (const k of Object.getOwnPropertyNames(mixin)) {
        obj[k] = typeof mixin[k] === 'function' ? mixin[k].bind(obj) : mixin[k];
    }
    // Reset state to known values
    obj.handAnchorFret    = 5;
    obj._cachedMaxFrets   = 22;
    obj._numFingers       = 4;
    obj._handSpanFrets    = 3; // numFingers - 1
    obj._handSpanMm       = 0;
    obj._scaleLengthMm    = 0;
    obj._mechanism        = 'fret_sliding_fingers';
    obj._cachedNumStrings = 6;
    obj._maxFingers       = 6;
    obj.stringInstrumentConfig = {};
    Object.assign(obj, overrides);
    return obj;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildCoverageDOM() {
    const rect = document.createElement('div');
    rect.className = 'hand-finger-range-rect';
    rect.id = 'hand-finger-range-rect';
    document.body.appendChild(rect);
    return rect;
}

function buildBandDOM() {
    const band = document.createElement('div');
    band.id = 'fretboard-hand-band';
    band.style.left  = '0%';
    band.style.width = '100%';
    document.body.appendChild(band);
    return band;
}

// Parse 'NN.N%' → number
function pct(str) { return parseFloat(str); }

// ── _renderFingerRangeRects ───────────────────────────────────────────────────
describe('_renderFingerRangeRects — fret_sliding_fingers stripe spacing', () => {
    it('places 4 stripes with logarithmically increasing gaps (not uniform)', () => {
        const obj = makeMixin({ _numFingers: 4 });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const stripes = rect.querySelectorAll('.hand-finger-range-fret');
        expect(stripes.length).toBe(4);

        const positions = Array.from(stripes).map(s => pct(s.style.left));
        // Sorted ascending (they should already be)
        const sorted = [...positions].sort((a, b) => a - b);
        expect(positions).toEqual(sorted);

        // Log spacing: gaps should NOT be uniform.
        const gaps = sorted.slice(1).map((v, i) => v - sorted[i]);
        // First gap (fret 0→1 interval) should be larger than the last gap (fret 2→3),
        // because frets get narrower toward the body.
        expect(gaps[0]).toBeGreaterThan(gaps[gaps.length - 1]);
    });

    it('stripe positions match the equal-tempered formula', () => {
        // wire_pct_i = (1 − 2^(-(i+0.25)/12)) / (1 − 2^(-3/12)) × 100
        const count = 4;
        const denom = 1 - Math.pow(2, -3 / 12);
        const expected = Array.from({ length: count }, (_, i) =>
            (1 - Math.pow(2, -(i + 0.25) / 12)) / denom * 100
        );

        const obj = makeMixin({ _numFingers: count });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const stripes = rect.querySelectorAll('.hand-finger-range-fret');
        Array.from(stripes).forEach((s, i) => {
            expect(pct(s.style.left)).toBeCloseTo(expected[i], 2);
        });
    });

    it('places a single stripe at 50% for numFingers=1', () => {
        const obj = makeMixin({ _numFingers: 1 });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const stripes = rect.querySelectorAll('.hand-finger-range-fret');
        expect(stripes.length).toBe(1);
        expect(pct(stripes[0].style.left)).toBeCloseTo(50, 1);
    });

    it('places 2 stripes with correct log positions', () => {
        // For N=2: denom = 1-2^(-1/12) = 0.05612
        // stripe 0: (1-2^(-0.25/12))/0.05612 * 100 ≈ 25.5%
        // stripe 1: (1-2^(-1.25/12))/0.05612 * 100 ≈ 123.7% (beyond band)
        const count = 2;
        const denom = 1 - Math.pow(2, -1 / 12);
        const expected = [
            (1 - Math.pow(2, -0.25 / 12)) / denom * 100,
            (1 - Math.pow(2, -1.25 / 12)) / denom * 100,
        ];

        const obj = makeMixin({ _numFingers: count });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const stripes = rect.querySelectorAll('.hand-finger-range-fret');
        expect(pct(stripes[0].style.left)).toBeCloseTo(expected[0], 2);
        expect(pct(stripes[1].style.left)).toBeCloseTo(expected[1], 2);
    });

    it('positions are anchor-independent (same % regardless of handAnchorFret)', () => {
        const count = 4;

        const objA = makeMixin({ _numFingers: count, handAnchorFret: 1 });
        const rectA = buildCoverageDOM();
        objA._renderFingerRangeRects(rectA, 6);
        const posA = Array.from(rectA.querySelectorAll('.hand-finger-range-fret')).map(s => pct(s.style.left));

        rectA.remove();

        const objB = makeMixin({ _numFingers: count, handAnchorFret: 12 });
        const rectB = buildCoverageDOM();
        objB._renderFingerRangeRects(rectB, 6);
        const posB = Array.from(rectB.querySelectorAll('.hand-finger-range-fret')).map(s => pct(s.style.left));

        posA.forEach((v, i) => expect(v).toBeCloseTo(posB[i], 4));
    });
});

// ── _updateHandWidgetPosition — mm-based fret_sliding_fingers ─────────────────
describe('_updateHandWidgetPosition — fret_sliding_fingers physical mm band', () => {
    function buildBandContext(overrides = {}) {
        // Stub elements that _updateHandWidgetPosition accesses but we don't care about
        const arrowL = document.createElement('button');
        arrowL.id = 'hand-palm-arrow-left';
        const arrowR = document.createElement('button');
        arrowR.id = 'hand-palm-arrow-right';
        document.body.appendChild(arrowL);
        document.body.appendChild(arrowR);

        // Stub _updateCoverageOverlayPosition and _refreshFretSlidingLayout
        const obj = makeMixin({
            _scaleLengthMm : 648,   // standard guitar
            _handSpanMm    : 0,
            _numFingers    : 4,
            handAnchorFret : 5,
            _cachedMaxFrets: 22,
            _mechanism     : 'fret_sliding_fingers',
            _updateCoverageOverlayPosition: () => {},
            _refreshFretSlidingLayout     : () => {},
            _maxHandAnchorFret            : () => 18,
            ...overrides,
        });
        return obj;
    }

    it('uses physical mm: leftPct = (anchorMm − 8mm) / totalFretboardMm × 100', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: 5 });

        obj._updateHandWidgetPosition();

        const L        = 648;
        const maxFrets = 22;
        const totalMm  = L * (1 - Math.pow(2, -maxFrets / 12));
        const anchorMm = L * (1 - Math.pow(2, -5 / 12));
        const firstContactMm = anchorMm - 8;
        const expectedLeft   = firstContactMm / totalMm * 100;

        expect(pct(band.style.left)).toBeCloseTo(expectedLeft, 2);
    });

    it('band right edge = (lastFretMm − 8mm), giving correct width', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: 5, _numFingers: 4 });

        obj._updateHandWidgetPosition();

        const L          = 648;
        const maxFrets   = 22;
        const totalMm    = L * (1 - Math.pow(2, -maxFrets / 12));
        const anchorMm   = L * (1 - Math.pow(2, -5 / 12));
        const lastFretMm = L * (1 - Math.pow(2, -8 / 12)); // fret 5+4-1=8
        const firstContactMm = anchorMm   - 8;
        const lastContactMm  = lastFretMm - 8;
        const expectedWidth  = (lastContactMm - firstContactMm) / totalMm * 100;

        expect(pct(band.style.width)).toBeCloseTo(expectedWidth, 2);
    });

    it('first and last contact points are symmetrically 8mm before their fret', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: 3, _numFingers: 3 });

        obj._updateHandWidgetPosition();

        const L          = 648;
        const maxFrets   = 22;
        const totalMm    = L * (1 - Math.pow(2, -maxFrets / 12));

        // Finger 0: fret 3 → contact at (fret3_mm − 8mm)
        const fret3mm  = L * (1 - Math.pow(2, -3 / 12));
        // Finger 2: fret 5 → contact at (fret5_mm − 8mm)
        const fret5mm  = L * (1 - Math.pow(2, -5 / 12));
        const expectedLeft  = (fret3mm - 8) / totalMm * 100;
        const expectedRight = (fret5mm - 8) / totalMm * 100;
        const expectedWidth = expectedRight - expectedLeft;

        expect(pct(band.style.left)).toBeCloseTo(expectedLeft, 2);
        expect(pct(band.style.width)).toBeCloseTo(expectedWidth, 2);
    });

    it('falls back to fret-count path when scaleLengthMm is 0', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ _scaleLengthMm: 0, handAnchorFret: 5 });

        obj._updateHandWidgetPosition();

        // In fret-count fallback, left ≈ fretPct(anchor - 0.25, maxFrets)
        const maxFrets = 22;
        const total    = 1 - Math.pow(2, -maxFrets / 12);
        const displayAnchor = 5 - 0.25;
        const expectedLeft = (1 - Math.pow(2, -displayAnchor / 12)) / total * 100;

        expect(pct(band.style.left)).toBeCloseTo(expectedLeft, 2);
    });
});

// ── Dot positions in renderHandWidget (via DOM inspection) ────────────────────
describe('renderHandWidget — fret_sliding_fingers dot positions', () => {
    function makeDomContext() {
        // Minimal DOM that renderHandWidget builds into
        const stringsArea = document.createElement('div');
        stringsArea.className = 'fretboard-strings-area';
        document.body.appendChild(stringsArea);
        return stringsArea;
    }

    function collectDots(stringsArea) {
        return Array.from(
            stringsArea.querySelectorAll('.hand-finger-dot-pos[data-finger]')
        );
    }

    function buildRenderObj(numFingers, scaleLengthMm = 648) {
        const obj = makeMixin({
            _numFingers   : numFingers,
            _scaleLengthMm: scaleLengthMm,
            _handSpanMm   : 0,
            _mechanism    : 'fret_sliding_fingers',
            stringInstrumentConfig: {
                hands_config: {
                    enabled  : true,
                    mechanism: 'fret_sliding_fingers',
                    hands    : [{ num_fingers: numFingers, max_fingers: 6 }],
                },
                scale_length_mm: scaleLengthMm,
                num_strings: 6,
            },
        });
        // Stub methods called by renderHandWidget that we don't test here
        obj._updateHandWidgetPosition     = () => {};
        obj._attachHandWidgetEvents       = () => {};
        obj._updateCoverageOverlayPosition = () => {};
        obj._refreshFretSlidingLayout      = () => {};
        obj._renderFingerRangeRects        = () => {};
        return obj;
    }

    it('dot positions follow log formula for N=4', () => {
        const numF  = 4;
        const denom = 1 - Math.pow(2, -(numF - 1) / 12);
        const expected = Array.from({ length: numF }, (_, i) =>
            i === 0 ? 0 : (1 - Math.pow(2, -i / 12)) / denom * 100
        );

        const stringsArea = makeDomContext();
        const obj = buildRenderObj(numF);
        obj.renderHandWidget(stringsArea, { maxFretCount: 22, isFretless: false });

        const dots = collectDots(stringsArea);
        expect(dots.length).toBe(numF);
        dots.forEach((d, i) => {
            expect(pct(d.style.left)).toBeCloseTo(expected[i], 2);
        });
    });

    it('first dot at 0%, last dot at 100% for any N >= 2', () => {
        [2, 3, 4, 5].forEach(numF => {
            document.body.innerHTML = '';
            const stringsArea = makeDomContext();
            const obj = buildRenderObj(numF);
            obj.renderHandWidget(stringsArea, { maxFretCount: 22 });

            const dots = collectDots(stringsArea);
            expect(dots.length).toBe(numF);
            expect(pct(dots[0].style.left)).toBeCloseTo(0, 2);
            expect(pct(dots[numF - 1].style.left)).toBeCloseTo(100, 2);
        });
    });

    it('single finger dot at 50%', () => {
        const stringsArea = makeDomContext();
        const obj = buildRenderObj(1);
        obj.renderHandWidget(stringsArea, { maxFretCount: 22 });

        const dots = collectDots(stringsArea);
        expect(dots.length).toBe(1);
        expect(pct(dots[0].style.left)).toBeCloseTo(50, 1);
    });

    it('dot positions are NOT uniform for N=4 (log ≠ linear)', () => {
        const stringsArea = makeDomContext();
        const obj = buildRenderObj(4);
        obj.renderHandWidget(stringsArea, { maxFretCount: 22 });

        const dots = collectDots(stringsArea);
        const positions = dots.map(d => pct(d.style.left));
        const gaps = positions.slice(1).map((v, i) => v - positions[i]);

        // Log gap[0] > gap[1] (wider at low fret numbers)
        expect(gaps[0]).toBeGreaterThan(gaps[1]);

        // Sanity: NOT uniform — first gap and last gap differ by > 3%.
        // (uniform gaps would each be 33.33%; log gaps are 35.27%, 33.3%, 31.43%)
        expect(gaps[0] - gaps[gaps.length - 1]).toBeGreaterThan(3);
    });
});
