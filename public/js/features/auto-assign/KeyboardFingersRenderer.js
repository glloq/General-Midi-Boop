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
        whiteTipFraction: 0.5,
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
        //  Piano layout — strict W/B alternation
        // -----------------------------------------------------------------

        _drawPiano(ctx, W, H) {
            // Without the keyboard widget we can't compute the per-key
            // pixel positions accurately, so fall back to the
            // chromatic uniform-spacing renderer. Same visual hands,
            // no W/B alternation.
            if (!this._kb) {
                this._drawChromatic(ctx, W, H);
                return;
            }

            const opts = this.options;
            const bandH = opts.bandHeight;
            const handY = Math.max(0, H - bandH);
            const keysH = handY;
            const blackH = keysH * opts.blackHeightRatio;
            const knuckleTop = handY;          // flush with band top
            const whiteTipY = Math.max(0, keysH * opts.whiteTipFraction);
            const blackTipY = Math.max(0, blackH * opts.blackTipFraction);
            const whiteFingerH = Math.max(2, handY - whiteTipY);
            const blackFingerH = Math.max(2, handY - blackTipY);
            const view = this._extent;
            const kb = this._kb;

            for (const hand of this._hands) {
                const numFingers = this._effectiveNumFingers(hand);
                const a = this._anchorFor(hand);
                if (!Number.isFinite(a)) continue;

                const lowMidi  = Math.round(a);
                const highMidi = Math.round(a + (Number.isFinite(hand.span) ? hand.span : 0));
                if (this._isOffScreen(lowMidi, highMidi)) continue;

                const handLeftX  = kb.keyXAt(lowMidi);
                const rightWidth = kb.keyWidth(highMidi);
                const handRightX = kb.keyXAt(highMidi)
                    + (Number.isFinite(rightWidth) && rightWidth > 0 ? rightWidth : 0);
                if (!Number.isFinite(handLeftX) || !Number.isFinite(handRightX)) continue;
                if (handRightX <= 0 || handLeftX >= W) continue;
                const bandPxW = Math.max(1, handRightX - handLeftX);

                const slotW = bandPxW / numFingers;
                const fingerW = Math.max(3, slotW * opts.fingerWidthRatio);
                const slotCenterX = (i) => handLeftX + (i + 0.5) * slotW;
                const slotMidi = (i) => this._slotMidi(a, hand.span, numFingers, i);

                this._drawKnuckleBar(ctx, hand.color, handLeftX, handRightX,
                                      knuckleTop, opts.knuckleHeight, W);

                // Pass 1 — black fingers (odd slot indices). Drawn
                // first so the white fingers cap their bottom.
                for (let i = 1; i < numFingers; i += 2) {
                    const m = slotMidi(i);
                    const isActive = Number.isFinite(m) && this._activeNotes.has(m);
                    this._drawFingerBar(ctx, slotCenterX(i), blackTipY, blackFingerH,
                                         fingerW, isActive, W);
                }
                // Pass 2 — white fingers (even slot indices) on top.
                for (let i = 0; i < numFingers; i += 2) {
                    const m = slotMidi(i);
                    const isActive = Number.isFinite(m) && this._activeNotes.has(m);
                    this._drawFingerBar(ctx, slotCenterX(i), whiteTipY, whiteFingerH,
                                         fingerW, isActive, W);
                }
            }
        }

        // -----------------------------------------------------------------
        //  Chromatic layout — uniform spacing AND uniform height
        // -----------------------------------------------------------------

        _drawChromatic(ctx, W, H) {
            const opts = this.options;
            const view = this._extent;
            const fallbackPxPerPitch = W / Math.max(1, view.hi - view.lo + 1);
            const kb = this._kb;

            // Same `keyLeftX` / `keyRightX` lookups as the piano
            // renderer, but with a linear fallback when the keyboard
            // widget isn't wired yet so the overlay still renders
            // sensibly during the first few frames after mount.
            const keyLeftX = (midi) => {
                if (kb) {
                    const v = kb.keyXAt(midi);
                    if (Number.isFinite(v)) return v;
                }
                return (midi - view.lo) * fallbackPxPerPitch;
            };
            const keyRightX = (midi) => {
                if (kb) {
                    const x = kb.keyXAt(midi);
                    const w = kb.keyWidth(midi);
                    if (Number.isFinite(x) && Number.isFinite(w) && w > 0) return x + w;
                }
                return (midi - view.lo + 1) * fallbackPxPerPitch;
            };

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

                const handLeftX  = keyLeftX(Math.floor(a));
                const handRightX = keyRightX(Math.floor(a) + Math.round(hand.span));
                if (!(handRightX > handLeftX)) continue;
                if (handRightX <= 0 || handLeftX >= W) continue;
                const handPxW = handRightX - handLeftX;
                const slotW = handPxW / numFingers;
                const fingerW = Math.max(3, slotW * opts.fingerWidthRatio);

                this._drawKnuckleBar(ctx, hand.color, handLeftX, handRightX,
                                      knuckleTop, opts.knuckleHeight, W);

                for (let i = 0; i < numFingers; i++) {
                    const xCenter = handLeftX + (i + 0.5) * slotW;
                    const m = this._slotMidi(a, hand.span, numFingers, i);
                    const isActive = Number.isFinite(m) && this._activeNotes.has(m);
                    this._drawFingerBar(ctx, xCenter, tipY, fingerH,
                                         fingerW, isActive, W);
                }
            }
        }

        // -----------------------------------------------------------------
        //  Internals
        // -----------------------------------------------------------------

        /** Animated anchor for a hand, falling back to no value when
         *  the editor hasn't pushed an entry yet. The renderer then
         *  skips the hand for this frame instead of guessing. */
        _anchorFor(hand) {
            const v = this._anchors.get(hand.id);
            return Number.isFinite(v) ? v : NaN;
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
