/**
 * @file KeyboardFingersRenderer.js
 * @description Stand-alone canvas widget that draws the "fingers" overlay
 * for the keyboard hand-position editor.
 *
 * The widget is a pure renderer: it owns no application state. The
 * editor pushes everything it needs through explicit setters
 * (`setHands`, `setAnchors`, `setActiveNotes`, `setVisibleExtent`,
 * `setKeyboardWidget`, `setLayout`) and asks for a redraw via `draw()`.
 * Two layouts are supported:
 *
 *   - `chromatic` — every slot is the same finger height. Spacing is
 *     uniform across the hand's pixel span on the underlying keyboard
 *     widget. Used for xylophone, marimba, hangdrum and similar
 *     instruments where there is no white/black distinction.
 *
 *   - `piano`     — even-index slots render as short white-key fingers
 *     (tip at `keysH × whiteTipFraction`, centred on a white key);
 *     odd-index slots render as tall black-key fingers (tip at
 *     `blackH × blackTipFraction`, centred between two adjacent
 *     whites). Black fingers are painted FIRST so the white ones cap
 *     their bottom — same logical layering as a real keyboard where
 *     the white-key body hides the lower part of the black keys
 *     behind it. The pattern stays uniform across E–F and B–C
 *     transitions: the "virtual" black slot is still drawn, just
 *     never lights up because no real MIDI key sits there.
 *
 * Active-state lookup uses a chromatic mapping (slot N ≈ MIDI
 * `anchor + N × span / (numFingers − 1)`) so a sounding note lights
 * its closest finger no matter which layout is active.
 *
 * Off-screen check is MIDI-based BEFORE consulting the keyboard widget,
 * because `KeyboardPreview.keyXAt` clamps its result to the visible
 * MIDI range — without the MIDI check, a hand entirely beyond the
 * visible range would resolve to a finite x near the keyboard edge
 * and render its fingers in the wrong place.
 *
 * Public API:
 *
 *     const r = new KeyboardFingersRenderer(canvas, {
 *         bandHeight: 22,             // keyboard widget's band height
 *         whiteTipFraction: 0.5,      // piano white-finger tip Y / keysH
 *         blackTipFraction: 2 / 3,    // piano black-finger tip Y / blackH
 *         blackHeightRatio: 0.6,      // mirror KeyboardPreview's blackH/keysH
 *         chromaticTipFraction: 0.55  // chromatic uniform tip Y / handY
 *     });
 *     r.setKeyboardWidget(kb);                         // {keyXAt, keyWidth} or null
 *     r.setLayout('piano' | 'chromatic');
 *     r.setHands([{ id, span, numFingers, color }, …]);
 *     r.setAnchors(new Map([['h1', 60.5], …]));         // animated
 *     r.setActiveNotes(new Set([60, 64, 67]));
 *     r.setVisibleExtent({ lo: 21, hi: 108 });
 *     r.draw();
 *     r.destroy();
 *
 * Every setter validates its input. A missing or malformed input does
 * NOT throw — the next `draw()` simply skips the corresponding hand
 * (or the whole render if a global input is missing). This lets the
 * editor mount the widget early, before the simulator or the
 * keyboard widget have produced their first values, without a try-
 * catch around every call.
 */
(function() {
    'use strict';

    const DEFAULT_OPTIONS = {
        bandHeight: 22,
        // White fingers are short stubs that hug the band — they
        // mark "this finger lands on the white key in front of the
        // hand" without obscuring the key body. tipY = keysH × 0.75
        // makes the finger occupy the bottom quarter of the keys
        // area; half the height of the older 0.5 layout.
        whiteTipFraction: 0.75,
        // Black fingers reach much further forward, into the black-
        // key zone (which spans the top 60 % of the keys area).
        // tipY = blackH × 2/3 lands the tip 1/3 of the way into the
        // black key, leaving its top two thirds visible above.
        blackTipFraction: 2 / 3,
        blackHeightRatio: 0.6,
        chromaticTipFraction: 0.55,
        // Cosmetic — kept here so the editor can theme the widget
        // without re-opening the renderer's source file later.
        idleFingerFill: '#94a3b8',
        activeFingerFill: '#3b82f6',
        fingerStroke: 'rgba(15,23,42,0.65)',
        knuckleHeight: 2,
        fingerWidthRatio: 0.7  // finger body width = slotWidth × this
    };

    class KeyboardFingersRenderer {
        /**
         * @param {HTMLCanvasElement} canvas
         * @param {Object} [opts]
         */
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.options = Object.assign({}, DEFAULT_OPTIONS, opts);

            // Inputs — every field is set via a public setter. The
            // setters validate and (when relevant) assign defaults
            // so `draw()` can iterate without re-checking each frame.
            this._kb = null;                  // {keyXAt(midi), keyWidth(midi)}
            this._layout = 'chromatic';
            this._hands = [];                 // [{id, span, numFingers, color}]
            this._anchors = new Map();        // handId → anchor (animated)
            this._activeNotes = new Set();    // Set<midi>
            this._extent = { lo: 0, hi: 127 };
        }

        // -----------------------------------------------------------------
        //  Public setters
        // -----------------------------------------------------------------

        /** Plug the underlying keyboard widget so the renderer can ask
         *  it for pixel positions (`keyXAt`) and key widths
         *  (`keyWidth`). Pass `null` to detach (e.g. when the keyboard
         *  is being rebuilt) — the next `draw()` will become a no-op. */
        setKeyboardWidget(kb) {
            this._kb = (kb && typeof kb.keyXAt === 'function'
                        && typeof kb.keyWidth === 'function') ? kb : null;
        }

        /** Switch between `'piano'` (W/B alternation) and
         *  `'chromatic'` (uniform). Unknown values fall back to
         *  chromatic so a malformed instrument config doesn't
         *  break the overlay. */
        setLayout(layout) {
            this._layout = layout === 'piano' ? 'piano' : 'chromatic';
        }

        /** `[{ id, span, numFingers, color }, …]`. Hands without an id
         *  or with a non-finite span are silently dropped. */
        setHands(hands) {
            this._hands = Array.isArray(hands)
                ? hands.filter(h => h && h.id
                    && Number.isFinite(h.span)
                    && typeof h.color === 'string')
                : [];
        }

        /** Map from `handId` to the (live, animated) anchor in MIDI
         *  semitones. Accepts a Map or a plain object — the latter
         *  is normalised once for cheap per-frame lookup. */
        setAnchors(anchors) {
            if (anchors instanceof Map) {
                this._anchors = anchors;
            } else if (anchors && typeof anchors === 'object') {
                this._anchors = new Map(Object.entries(anchors));
            } else {
                this._anchors = new Map();
            }
        }

        /** Set of currently sounding MIDI semitones; only fingers
         *  that map to one of these light up. Accepts a Set, a plain
         *  array, or null/undefined. */
        setActiveNotes(notes) {
            if (notes instanceof Set) {
                this._activeNotes = notes;
            } else if (Array.isArray(notes)) {
                this._activeNotes = new Set(notes);
            } else {
                this._activeNotes = new Set();
            }
        }

        /** `{lo, hi}` — the MIDI range currently rendered by the
         *  underlying keyboard widget. Used for the off-screen check
         *  BEFORE consulting `keyXAt` (see file header). */
        setVisibleExtent(extent) {
            if (extent && Number.isFinite(extent.lo) && Number.isFinite(extent.hi)
                    && extent.hi > extent.lo) {
                this._extent = { lo: extent.lo, hi: extent.hi };
            }
        }

        // -----------------------------------------------------------------
        //  Render
        // -----------------------------------------------------------------

        /** Redraw the overlay. Safe to call without inputs (no-ops). */
        draw() {
            const c = this.canvas;
            if (!c) return;
            const W = c.clientWidth;
            const H = c.clientHeight;
            if (W <= 0 || H <= 0) return;

            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            const wantW = Math.round(W * dpr);
            const wantH = Math.round(H * dpr);
            if (c.width !== wantW || c.height !== wantH) {
                c.width = wantW;
                c.height = wantH;
            }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);

            if (this._hands.length === 0) return;

            if (this._layout === 'piano') {
                this._drawPiano(ctx, W, H);
            } else {
                this._drawChromatic(ctx, W, H);
            }
        }

        /** Detach from the canvas. The widget is single-canvas and
         *  attaches no DOM listeners (it's a pure renderer); destroy
         *  just clears its inputs so subsequent calls are cheap and
         *  GC-friendly. Provided for symmetry with sibling widgets. */
        destroy() {
            this._kb = null;
            this._hands = [];
            this._anchors = new Map();
            this._activeNotes = new Set();
        }

        // -----------------------------------------------------------------
        //  Piano layout — fingers distributed across the declared span
        // -----------------------------------------------------------------

        _drawPiano(ctx, W, H) {
            // Without the keyboard widget we can't compute per-key
            // pixel positions accurately; fall back to chromatic.
            if (!this._kb) {
                this._drawChromatic(ctx, W, H);
                return;
            }

            const opts = this.options;
            const bandH = opts.bandHeight;
            const handY = Math.max(0, H - bandH);
            const keysH = handY;
            const blackH = keysH * opts.blackHeightRatio;
            const knuckleTop = handY;
            const kb = this._kb;

            const rangeMin = Number.isFinite(kb.rangeMin) ? kb.rangeMin : this._extent.lo;
            const rangeMax = Number.isFinite(kb.rangeMax) ? kb.rangeMax : this._extent.hi;

            // Build a white-key index table. Only white keys get an index ≥ 0;
            // black key entries stay -1 so `keyCenter` can branch on it.
            const whiteIdxOf = new Int16Array(128).fill(-1);
            let wIdx = 0;
            for (let m = rangeMin; m <= rangeMax; m++) {
                if (!this._isBlackKey(m)) whiteIdxOf[m] = wIdx++;
            }
            const numWhites = wIdx;
            if (numWhites <= 0) return;
            const ww = W / numWhites;          // pixels per white key

            // Pixel centre of any key (white or black).
            // White  → index × ww + half white key.
            // Black  → midpoint of its two surrounding white key centres,
            //          which matches the DOM placement of `left: (i+0.7)*ww%`.
            const keyCenter = (midi) => {
                const m = Math.max(rangeMin, Math.min(rangeMax, Math.round(midi)));
                if (!this._isBlackKey(m)) {
                    const i = whiteIdxOf[m];
                    return (i >= 0 ? i : 0) * ww + ww * 0.5;
                }
                const wL = m - 1, wR = m + 1;
                const xL = (wL >= rangeMin && whiteIdxOf[wL] >= 0)
                    ? whiteIdxOf[wL] * ww + ww * 0.5 : 0;
                const xR = (wR <= rangeMax && whiteIdxOf[wR] >= 0)
                    ? whiteIdxOf[wR] * ww + ww * 0.5 : W;
                return (xL + xR) * 0.5;
            };

            // T-shape dimensions (shared across all hands in this draw call).
            // Gap slots (black-key positions): bar tip at the bottom of black keys.
            // White-key fingers: bar tip at the vertical centre of the white-only
            // area (the wider lower section of each white key, below black keys).
            const blackSlotTipY = blackH;
            const whiteKeyTipY  = Math.round((blackH + keysH) * 0.5);
            const tBarH   = Math.max(5, Math.round(keysH * 0.14));  // ≈8 px bar height
            const whiteBarW = Math.max(5, ww * 0.82);   // nearly full white key
            const gapBarW   = Math.max(4, ww * 0.52);   // ≈ black key width
            const tStemW    = Math.max(2, ww * 0.34);   // narrower than bar

            for (const hand of this._hands) {
                const numFingers = this._effectiveNumFingers(hand);
                const a = this._anchorFor(hand);
                if (!Number.isFinite(a)) continue;

                const lowMidi  = Math.round(a);
                const highMidi = Math.round(a + (Number.isFinite(hand.span) ? hand.span : 0));
                if (this._isOffScreen(lowMidi, highMidi)) continue;

                // Piano mode: alternating W–G–W–G–W pattern gives exactly
                // numFingers visual elements. ceil(n/2) fall on consecutive
                // white keys; floor(n/2) fall in the gaps between them as
                // virtual black-key-style slots (real black key if it exists,
                // empty visual slot over E–F / B–C gaps).
                const numWhites = Math.ceil(numFingers / 2);
                const numGaps   = Math.floor(numFingers / 2);
                // Even numFingers ends on a gap, which needs the next white
                // key (after the last finger) to compute its x position.
                const keysToFetch = numWhites + (numGaps >= numWhites ? 1 : 0);
                const fetchedWhites = this._whiteKeysFromAnchor(a, keysToFetch)
                    .filter(m => m >= rangeMin && m <= rangeMax);

                const whiteFingers = fetchedWhites.slice(0, numWhites);
                if (whiteFingers.length === 0) continue;

                const gapSlots = [];
                for (let i = 0; i < numGaps && (i + 1) < fetchedWhites.length; i++) {
                    const left  = whiteFingers[i];
                    const right = fetchedWhites[i + 1];
                    const blackMidi = left + 1;
                    const hasBlack = this._isBlackKey(blackMidi) && blackMidi < right
                                     && blackMidi >= rangeMin && blackMidi <= rangeMax;
                    gapSlots.push({
                        xCenter: (keyCenter(left) + keyCenter(right)) * 0.5,
                        isActive: hasBlack && this._activeNotes.has(blackMidi),
                    });
                }

                const kLeft  = keyCenter(whiteFingers[0]) - ww * 0.5;
                const kRight = Math.max(
                    keyCenter(whiteFingers[whiteFingers.length - 1]) + ww * 0.5,
                    gapSlots.length > 0 ? gapSlots[gapSlots.length - 1].xCenter + ww * 0.3 : 0
                );
                this._drawKnuckleBar(ctx, hand.color, kLeft, kRight,
                                      knuckleTop, opts.knuckleHeight, W);

                // Pass 1 — gap (black-key position) T-shapes first so white
                // fingers overdraw their stem bottoms (same layering as real keys).
                for (const slot of gapSlots) {
                    this._drawPianoFinger(ctx, slot.xCenter,
                        blackSlotTipY, keysH, gapBarW, tStemW, tBarH, slot.isActive, W);
                }
                // Pass 2 — white-key T-shapes on top.
                for (const mi of whiteFingers) {
                    this._drawPianoFinger(ctx, keyCenter(mi),
                        whiteKeyTipY, keysH, whiteBarW, tStemW, tBarH,
                        this._activeNotes.has(mi), W);
                }
            }
        }

        // -----------------------------------------------------------------
        //  Chromatic layout — uniform spacing AND uniform height
        // -----------------------------------------------------------------

        _drawChromatic(ctx, W, H) {
            const opts = this.options;
            const kb = this._kb;

            // Pixel-per-semitone computed against the fingers canvas
            // width (NOT via `kb.keyXAt`). See the same rationale in
            // `_drawPiano`: the keyboard canvas can have a stale
            // size cached, while the fingers canvas reports the
            // accurate live clientWidth.
            const rangeMin = (kb && Number.isFinite(kb.rangeMin)) ? kb.rangeMin : this._extent.lo;
            const rangeMax = (kb && Number.isFinite(kb.rangeMax)) ? kb.rangeMax : this._extent.hi;
            const semitoneCount = Math.max(1, rangeMax - rangeMin + 1);
            const pxPerPitch = W / semitoneCount;
            const xLeftOf = (midi) => (midi - rangeMin) * pxPerPitch;
            const xRightOf = (midi) => (midi - rangeMin + 1) * pxPerPitch;

            const bandH = opts.bandHeight;
            const handY = Math.max(0, H - bandH);
            const knuckleTop = handY;
            const tipY = handY * opts.chromaticTipFraction;
            const fingerH = Math.max(2, handY - tipY);

            for (const hand of this._hands) {
                const numFingers = this._effectiveNumFingers(hand);
                const a = this._anchorFor(hand);
                if (!Number.isFinite(a)) continue;

                const lowMidi  = Math.round(a);
                const highMidi = Math.round(a + (Number.isFinite(hand.span) ? hand.span : 0));
                if (this._isOffScreen(lowMidi, highMidi)) continue;

                const handLeftX  = xLeftOf(Math.floor(a));
                const handRightX = xRightOf(Math.floor(a) + Math.round(hand.span));
                if (!(handRightX > handLeftX)) continue;
                const handPxW = handRightX - handLeftX;
                // Finger width = one semitone cell × ratio; keeps each finger
                // proportional to the note cell it sits over regardless of span.
                const fingerW = Math.max(3, pxPerPitch * opts.fingerWidthRatio);

                this._drawKnuckleBar(ctx, hand.color, handLeftX, handRightX,
                                      knuckleTop, opts.knuckleHeight, W);

                for (let i = 0; i < numFingers; i++) {
                    const m = this._slotMidi(a, hand.span, numFingers, i);
                    // Align finger centre with its MIDI note cell; fall back to
                    // uniform spacing when the slot midi is not finite.
                    const xCenter = Number.isFinite(m)
                        ? (m - rangeMin + 0.5) * pxPerPitch
                        : handLeftX + (i + 0.5) * (handPxW / numFingers);
                    const isActive = Number.isFinite(m) && this._activeNotes.has(m);
                    this._drawFingerBar(ctx, xCenter, tipY, fingerH,
                                         fingerW, isActive, W);
                }
            }
        }

        // -----------------------------------------------------------------
        //  Internals
        // -----------------------------------------------------------------

        /** Animated anchor for a hand. Prefers the value the editor
         *  pushed via `setAnchors` (Map keyed by handId), falling
         *  back to the hand's own static `anchor` field when no
         *  animated value has been pushed yet — that mirrors the
         *  modal's `_displayedAnchorMapForRender` fallback so the
         *  hand still renders during the first frames after mount
         *  (or any time the animation map briefly drops an entry). */
        _anchorFor(hand) {
            const animated = this._anchors.get(hand.id);
            if (Number.isFinite(animated)) return animated;
            if (hand && Number.isFinite(hand.anchor)) return hand.anchor;
            return NaN;
        }

        /** Honour the configured `numFingers`, falling back to
         *  `span + 1` (the chromatic convention: one slot per
         *  semitone) when the hands_config didn't set the field. */
        _effectiveNumFingers(hand) {
            if (Number.isFinite(hand.numFingers) && hand.numFingers > 0) {
                return Math.max(1, Math.round(hand.numFingers));
            }
            return Math.max(1, Math.round(hand.span) + 1);
        }

        /** Slot → MIDI mapping. Even when `numFingers` exceeds
         *  `span + 1` (e.g. 16 fingers on a 14-semitone span), the
         *  rounded value keeps `activeNotes.has(slot)` looking up an
         *  integer MIDI value. The drawing pass uses the slot
         *  INDEX, not the semitone, for visual placement so the
         *  alternating white/black pattern stays uniform. */
        _slotMidi(anchor, span, numFingers, i) {
            if (!Number.isFinite(anchor) || !Number.isFinite(span)) return NaN;
            if (numFingers <= 1) return Math.round(anchor);
            return Math.round(anchor + (i * span) / (numFingers - 1));
        }

        /** True when the hand's MIDI window sits entirely outside the
         *  current visible extent. Faster than a pixel-based check
         *  and immune to `KeyboardPreview.keyXAt`'s clamping. */
        _isOffScreen(lowMidi, highMidi) {
            return highMidi < this._extent.lo || lowMidi > this._extent.hi;
        }

        /** True when MIDI `m` is a black-key pitch class (C#, D#,
         *  F#, G#, A#). Used by `_whiteKeysFromAnchor` to skip
         *  blacks while building the alternation sequence. */
        _isBlackKey(midi) {
            const v = ((midi % 12) + 12) % 12;
            return v === 1 || v === 3 || v === 6 || v === 8 || v === 10;
        }

        /** Walk MIDI from `startMidi` upward, collecting `count`
         *  consecutive white keys. If `startMidi` happens to be on
         *  a black key (rare anchor position) we snap back to the
         *  preceding white so the pattern stays in phase with the
         *  keyboard (e.g. C# anchor → thumb on C, index on C#).
         *  Returns fewer than `count` only when we run out of MIDI
         *  space (>127). */
        _whiteKeysFromAnchor(startMidi, count) {
            const out = [];
            let m = Math.max(0, Math.round(startMidi));
            if (this._isBlackKey(m)) m--;
            while (out.length < count && m <= 127) {
                if (!this._isBlackKey(m)) out.push(m);
                m++;
            }
            return out;
        }

        /** Draw the hand-coloured knuckle bar inside the band's top
         *  edge. Clipped to the canvas so a partially off-screen hand
         *  still draws its on-screen portion cleanly. */
        _drawKnuckleBar(ctx, color, leftX, rightX, top, height, W) {
            const x0 = Math.max(0, leftX);
            const x1 = Math.min(W, rightX);
            if (x1 <= x0) return;
            ctx.fillStyle = color;
            ctx.fillRect(x0, top, x1 - x0, height);
        }

        /** Draw a T-shaped piano finger.
         *  The wide horizontal bar represents the fingertip pressing the key;
         *  the narrower stem below connects to the knuckle band.
         *  `tipY`  — top of the bar (where the finger meets the key surface).
         *  `handY` — bottom of the stem (= knuckle line = keysH).
         *  `barW`  — full width of the horizontal bar.
         *  `stemW` — width of the stem (narrower than the bar).
         *  `barH`  — height of the horizontal bar. */
        _drawPianoFinger(ctx, xCenter, tipY, handY, barW, stemW, barH, isActive, W) {
            if (xCenter < -barW || xCenter > W + barW) return;
            const opts = this.options;
            const barBottom = Math.min(tipY + barH, handY);
            const bL = xCenter - barW  * 0.5;
            const bR = xCenter + barW  * 0.5;
            const sL = xCenter - stemW * 0.5;
            const sR = xCenter + stemW * 0.5;
            ctx.fillStyle = isActive ? opts.activeFingerFill : opts.idleFingerFill;
            ctx.beginPath();
            ctx.moveTo(bL, tipY);
            ctx.lineTo(bR, tipY);
            ctx.lineTo(bR, barBottom);
            ctx.lineTo(sR, barBottom);
            ctx.lineTo(sR, handY);
            ctx.lineTo(sL, handY);
            ctx.lineTo(sL, barBottom);
            ctx.lineTo(bL, barBottom);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = opts.fingerStroke;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        /** Draw a single finger rectangle (body + outline). Skips
         *  fingers whose centre falls outside the canvas plus a
         *  half-finger margin so an animation that briefly overshoots
         *  the edge doesn't smear. */
        _drawFingerBar(ctx, xCenter, tip, height, fingerW, isActive, W) {
            if (xCenter < -fingerW || xCenter > W + fingerW) return;
            const fx = xCenter - fingerW / 2;
            const opts = this.options;
            ctx.fillStyle = isActive ? opts.activeFingerFill : opts.idleFingerFill;
            ctx.fillRect(fx, tip, fingerW, height);
            ctx.strokeStyle = opts.fingerStroke;
            ctx.lineWidth = 1;
            ctx.strokeRect(fx + 0.5, tip + 0.5,
                            Math.max(1, fingerW - 1),
                            Math.max(1, height - 1));
        }
    }

    if (typeof window !== 'undefined') {
        window.KeyboardFingersRenderer = KeyboardFingersRenderer;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { KeyboardFingersRenderer };
    }
})();
