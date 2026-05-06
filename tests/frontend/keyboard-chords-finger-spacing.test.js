// tests/frontend/keyboard-chords-finger-spacing.test.js
// Guards finger layout for fret_sliding_fingers in the virtual piano modal.
//
// Invariants under test:
//  - Stripes/dots are UNIFORMLY spaced within the band (equal slots)
//  - The band extends half a slot beyond the first and last contact points
//    so both edge dots are fully visible (not clipped)
//  - First finger: contact point exactly 8mm before anchor fret wire
//  - Last finger : contact point exactly 8mm before (anchor + N-1) fret wire

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

// ── _renderFingerRangeRects : uniform slot stripes ────────────────────────────
describe('_renderFingerRangeRects — fret_sliding_fingers stripe spacing', () => {
    it('places N stripes with uniform right-edge positions (i+1)/N', () => {
        const count = 4;
        const obj = makeMixin({ _numFingers: count });
        const rect = buildCoverageDOM();
        obj._renderFingerRangeRects(rect, 6);

        const stripes = rect.querySelectorAll('.hand-finger-range-fret');
        expect(stripes.length).toBe(count);

        for (let i = 0; i < count; i++) {
            const expected = (i + 1) / count * 100;
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

    it('gaps between consecutive stripe right edges are equal', () => {
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

// ── _updateHandWidgetPosition — band covers half-slot on each side ─────────────
describe('_updateHandWidgetPosition — fret_sliding_fingers band with half-slot padding', () => {
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

    it('mm path: band left = firstContact − halfSlot', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: 5, _numFingers: 4 });
        obj._updateHandWidgetPosition();

        const L = 648, maxFrets = 22, N = 4;
        const totalMm      = L * (1 - Math.pow(2, -maxFrets / 12));
        const anchorMm     = L * (1 - Math.pow(2, -5 / 12));
        const lastFretMm   = L * (1 - Math.pow(2, -8 / 12)); // fret 5+3
        const firstContact = anchorMm   - 8;
        const lastContact  = lastFretMm - 8;
        const halfSlot     = (lastContact - firstContact) / (2 * (N - 1));
        const expectedLeft = Math.max(0, firstContact - halfSlot) / totalMm * 100;

        expect(pct(band.style.left)).toBeCloseTo(expectedLeft, 2);
    });

    it('mm path: band right = lastContact + halfSlot', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ handAnchorFret: 5, _numFingers: 4 });
        obj._updateHandWidgetPosition();

        const L = 648, maxFrets = 22, N = 4;
        const totalMm      = L * (1 - Math.pow(2, -maxFrets / 12));
        const anchorMm     = L * (1 - Math.pow(2, -5 / 12));
        const lastFretMm   = L * (1 - Math.pow(2, -8 / 12));
        const firstContact = anchorMm   - 8;
        const lastContact  = lastFretMm - 8;
        const halfSlot     = (lastContact - firstContact) / (2 * (N - 1));
        const paddedLeft   = Math.max(0, firstContact - halfSlot) / totalMm * 100;
        const paddedRight  = Math.min(totalMm, lastContact + halfSlot) / totalMm * 100;
        const expectedWidth = paddedRight - paddedLeft;

        expect(pct(band.style.width)).toBeCloseTo(expectedWidth, 2);
    });

    it('mm path: first/last contact points are at 0.5/N and (N-0.5)/N within band', () => {
        const band = buildBandDOM();
        const N = 4;
        const obj = buildBandContext({ handAnchorFret: 5, _numFingers: N });
        obj._updateHandWidgetPosition();

        const L = 648, maxFrets = 22;
        const totalMm      = L * (1 - Math.pow(2, -maxFrets / 12));
        const anchorMm     = L * (1 - Math.pow(2, -5 / 12));
        const lastFretMm   = L * (1 - Math.pow(2, -8 / 12));
        const firstContact = anchorMm   - 8;
        const lastContact  = lastFretMm - 8;
        const halfSlot     = (lastContact - firstContact) / (2 * (N - 1));
        const paddedLeftMm = Math.max(0, firstContact - halfSlot);
        const paddedWidth  = (Math.min(totalMm, lastContact + halfSlot) - paddedLeftMm);

        // first contact relative to padded band
        const firstPct = (firstContact - paddedLeftMm) / paddedWidth * 100;
        // last contact relative to padded band
        const lastPct  = (lastContact  - paddedLeftMm) / paddedWidth * 100;

        expect(firstPct).toBeCloseTo(0.5 / N * 100, 1);
        expect(lastPct).toBeCloseTo((N - 0.5) / N * 100, 1);
    });

    it('fret-count fallback: left = fretPct(displayAnchor − 0.5)', () => {
        const band = buildBandDOM();
        const obj  = buildBandContext({ _scaleLengthMm: 0, handAnchorFret: 5, _numFingers: 4 });
        obj._updateHandWidgetPosition();

        const maxFrets = 22;
        const total = 1 - Math.pow(2, -maxFrets / 12);
        const displayAnchor = 5 - 0.25;
        const expectedLeft = (1 - Math.pow(2, -(displayAnchor - 0.5) / 12)) / total * 100;

        expect(pct(band.style.left)).toBeCloseTo(expectedLeft, 2);
    });

    it('fret-count fallback: band spans N slots (displayAnchor−0.5 to displayAnchor+N−0.5)', () => {
        const band = buildBandDOM();
        const N = 4;
        const obj = buildBandContext({ _scaleLengthMm: 0, handAnchorFret: 5, _numFingers: N });
        obj._updateHandWidgetPosition();

        const maxFrets = 22;
        const total = 1 - Math.pow(2, -maxFrets / 12);
        const displayAnchor = 5 - 0.25;
        const leftPct  = (1 - Math.pow(2, -(displayAnchor - 0.5) / 12)) / total * 100;
        const rightPct = (1 - Math.pow(2, -(displayAnchor + N - 0.5) / 12)) / total * 100;
        const expectedWidth = rightPct - leftPct;

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
