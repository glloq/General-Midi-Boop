// tests/frontend/keyboard-chords-finger-spacing.test.js
// Guards finger layout for fret_sliding_fingers in the virtual piano modal.
//
// Invariants under test:
//  - Band spans exactly N fret cells, from fretPct(anchor-1) to fretPct(anchor+N-1),
//    aligned with the visible fret wires on the fretboard grid.
//  - Stripes are at the fret-wire positions within the band (log-spaced).
//  - Dots are uniformly spaced within the band: dot i at (i+0.5)/N × 100%.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
    resolve(__dirname, '../../public/js/features/keyboard/KeyboardChords.js'),
    'utf8'
);

beforeAll(() => {
    new Function(src)();
});

beforeEach(() => {
    document.body.innerHTML = '';
});

// Mirrors the fretPct() function from KeyboardChords.js
function fretPct(fret, maxFrets) {
    if (!maxFrets) return fret / 24 * 100;
    const total = 1 - Math.pow(2, -maxFrets / 12);
    return (1 - Math.pow(2, -fret / 12)) / total * 100;
}

// ── Helper: build a minimal mixin instance ────────────────────────────────────
function makeMixin(overrides = {}) {
    const mixin = window.KeyboardChordsMixin;
    const obj = Object.create(null);
    for (const k of Object.getOwnPropertyNames(mixin)) {
        obj[k] = typeof mixin[k] === 'function' ? mixin[k].bind(obj) : mixin[k];
    }
    obj.handAnchorFret    = 5;
    obj._cachedMaxFrets   = 22;
    obj._numFingers       = 4;
    obj._handSpanFrets    = 3;
    obj._handSpanMm       = 0;
    obj._scaleLengthMm    = 0;
    obj._mechanism        = 'fret_sliding_fingers';
    obj._cachedNumStrings = 6;
    obj._maxFingers       = 6;
    obj.stringInstrumentConfig = {};
    Object.assign(obj, overrides);
    return obj;
}

// Parse 'NN.N%' → number
function pct(str) { return parseFloat(str); }

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

// ── _renderFingerRangeRects : stripes centered on dot positions ───────────────
describe('_renderFingerRangeRects — fret_sliding_fingers stripe spacing', () => {
    it('places N stripes centered at (i+0.5)/N positions', () => {
        const count = 4;
        const obj = makeMixin({ _numFingers: count });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const stripes = rect.querySelectorAll('.hand-finger-range-fret');
        expect(stripes.length).toBe(count);

        for (let i = 0; i < count; i++) {
            const expected = (i + 0.5) / count * 100;
            expect(pct(stripes[i].style.left)).toBeCloseTo(expected, 4);
        }
    });

    it('single stripe at 50% for numFingers=1', () => {
        const obj = makeMixin({ _numFingers: 1 });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const stripes = rect.querySelectorAll('.hand-finger-range-fret');
        expect(stripes.length).toBe(1);
        expect(pct(stripes[0].style.left)).toBeCloseTo(50, 1);
    });

    it('gaps between consecutive stripe centers are equal', () => {
        const count = 5;
        const obj = makeMixin({ _numFingers: count });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const positions = Array.from(
            rect.querySelectorAll('.hand-finger-range-fret')
        ).map(s => pct(s.style.left));

        const gaps = positions.slice(1).map((v, i) => v - positions[i]);
        const expected = 100 / count;
        gaps.forEach(g => expect(g).toBeCloseTo(expected, 4));
    });
});

// ── _updateHandWidgetPosition — band aligned with fret cells ──────────────────
describe('_updateHandWidgetPosition — fret_sliding_fingers band aligned with fret cells', () => {
    function buildBandContext(overrides = {}) {
        const arrowL = document.createElement('button');
        arrowL.id = 'hand-palm-arrow-left';
        const arrowR = document.createElement('button');
        arrowR.id = 'hand-palm-arrow-right';
        document.body.appendChild(arrowL);
        document.body.appendChild(arrowR);

        const obj = makeMixin({
            _scaleLengthMm : 648,
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

    it('band left = fretPct(anchor-1, maxFrets)', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: 5, _numFingers: 4 });
        obj._updateHandWidgetPosition();

        const maxFrets = 22;
        const expectedLeft = fretPct(4, maxFrets); // anchor - 1 = 4
        expect(pct(band.style.left)).toBeCloseTo(expectedLeft, 2);
    });

    it('band width = fretPct(anchor+N-1) − fretPct(anchor-1)', () => {
        const band = buildBandDOM();
        const N = 4;
        const obj  = buildBandContext({ handAnchorFret: 5, _numFingers: N });
        obj._updateHandWidgetPosition();

        const maxFrets = 22;
        const expectedLeft  = fretPct(4, maxFrets);       // anchor - 1
        const expectedRight = fretPct(8, maxFrets);       // anchor + N - 1
        const expectedWidth = expectedRight - expectedLeft;
        expect(pct(band.style.width)).toBeCloseTo(expectedWidth, 2);
    });

    it('band position is the same regardless of scale_length_mm', () => {
        const N = 4;
        const band1 = buildBandDOM();
        buildBandContext({ _scaleLengthMm: 648, handAnchorFret: 5, _numFingers: N })
            ._updateHandWidgetPosition();
        const left1  = pct(band1.style.left);
        const width1 = pct(band1.style.width);

        document.body.innerHTML = '';
        const band2 = buildBandDOM();
        const arrowL = document.createElement('button');
        arrowL.id = 'hand-palm-arrow-left';
        const arrowR = document.createElement('button');
        arrowR.id = 'hand-palm-arrow-right';
        document.body.appendChild(arrowL);
        document.body.appendChild(arrowR);
        buildBandContext({ _scaleLengthMm: 0, handAnchorFret: 5, _numFingers: N })
            ._updateHandWidgetPosition();
        const left2  = pct(band2.style.left);
        const width2 = pct(band2.style.width);

        expect(left1).toBeCloseTo(left2, 2);
        expect(width1).toBeCloseTo(width2, 2);
    });

    it('band left = 0 when anchor = 1', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: 1, _numFingers: 4 });
        obj._updateHandWidgetPosition();

        expect(pct(band.style.left)).toBeCloseTo(0, 2);
    });

    it('band spans exactly N fret cells: width matches single-cell sum', () => {
        const N = 4, anchor = 5, maxFrets = 22;
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: anchor, _numFingers: N });
        obj._updateHandWidgetPosition();

        const expectedWidth = fretPct(anchor + N - 1, maxFrets) - fretPct(anchor - 1, maxFrets);
        expect(pct(band.style.width)).toBeCloseTo(expectedWidth, 2);
    });
});

// ── renderHandWidget — dot positions ─────────────────────────────────────────
describe('renderHandWidget — fret_sliding_fingers dot positions', () => {
    function makeDomContext() {
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
        obj._updateHandWidgetPosition     = () => {};
        obj._attachHandWidgetEvents       = () => {};
        obj._updateCoverageOverlayPosition = () => {};
        obj._refreshFretSlidingLayout      = () => {};
        obj._renderFingerRangeRects        = () => {};
        return obj;
    }

    it('dot i is at (i+0.5)/N × 100% for N=4', () => {
        const numF = 4;
        const stringsArea = makeDomContext();
        buildRenderObj(numF).renderHandWidget(stringsArea, { maxFretCount: 22 });

        const dots = collectDots(stringsArea);
        expect(dots.length).toBe(numF);
        dots.forEach((d, i) => {
            expect(pct(d.style.left)).toBeCloseTo((i + 0.5) / numF * 100, 4);
        });
    });

    it('all N values 1–6 produce (i+0.5)/N spacing', () => {
        [1, 2, 3, 4, 5, 6].forEach(numF => {
            document.body.innerHTML = '';
            const stringsArea = makeDomContext();
            buildRenderObj(numF).renderHandWidget(stringsArea, { maxFretCount: 22 });

            const dots = collectDots(stringsArea);
            expect(dots.length).toBe(numF);
            dots.forEach((d, i) => {
                const expected = numF === 1 ? 50 : (i + 0.5) / numF * 100;
                expect(pct(d.style.left)).toBeCloseTo(expected, 4);
            });
        });
    });

    it('gaps between consecutive dots are equal', () => {
        const numF = 4;
        const stringsArea = makeDomContext();
        buildRenderObj(numF).renderHandWidget(stringsArea, { maxFretCount: 22 });

        const dots = collectDots(stringsArea);
        const positions = dots.map(d => pct(d.style.left));
        const gaps = positions.slice(1).map((v, i) => v - positions[i]);
        const expected = 100 / numF;
        gaps.forEach(g => expect(g).toBeCloseTo(expected, 4));
    });
});
