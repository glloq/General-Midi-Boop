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
            const knuckleTop = handY;          // flush with band top
            const whiteTipY = Math.max(0, keysH * opts.whiteTipFraction);
            const blackTipY = Math.max(0, blackH * opts.blackTipFraction);
            const whiteFingerH = Math.max(2, handY - whiteTipY);
            const blackFingerH = Math.max(2, handY - blackTipY);
            const kb = this._kb;

            for (const hand of this._hands) {
                const numFingers = this._effectiveNumFingers(hand);
                const a = this._anchorFor(hand);
                if (!Number.isFinite(a)) continue;

                const lowMidi  = Math.round(a);
                const highMidi = Math.round(a + (Number.isFinite(hand.span) ? hand.span : 0));
                if (this._isOffScreen(lowMidi, highMidi)) continue;

                // Strict white-key alignment: even slot i lands on
                // the actual centre of the (i/2)-th white key above
                // the anchor; odd slot i lands at the midpoint
                // between two adjacent whites — exactly where a
                // black key (real or virtual) sits.
                //
                // For numFingers = N, we need
                //   floor(N/2) + 1 white keys
                // (one per even slot, plus one extra so the last
                // odd slot has a "next white" to be between).
                const numWhites = Math.floor(numFingers / 2) + 1;
                const whites = this._whiteKeysFromAnchor(lowMidi, numWhites);
                if (whites.length < 2) continue;

                // Resolve each white's pixel centre from the
                // keyboard widget. We tolerate the rightmost
                // entries falling off the keyboard's range — the
                // slot loop below short-circuits when it runs past
                // `whiteCenters.length`. Also stop on duplicate
                // positions: `KeyboardPreview.keyXAt` clamps its
                // input to its own `rangeMax`, so two whites past
                // the keyboard's right edge would resolve to the
                // same pixel and stack the fingers on top of one
                // another.
                const whiteCenters = [];
                for (const m of whites) {
                    const x = kb.keyXAt(m);
                    const w = kb.keyWidth(m);
                    if (!Number.isFinite(x) || !Number.isFinite(w)) break;
                    const centre = x + w / 2;
                    const last = whiteCenters[whiteCenters.length - 1];
                    if (last != null && Math.abs(centre - last) < 1) break;
                    whiteCenters.push(centre);
                }
                if (whiteCenters.length < 2) continue;

                const slotCenterX = (i) => {
                    if ((i & 1) === 0) return whiteCenters[i >> 1];
                    return (whiteCenters[i >> 1] + whiteCenters[(i >> 1) + 1]) / 2;
                };

                // Slot → MIDI for the active-note lookup. Odd slots
                // map to the real black between the surrounding
                // whites; null when no black exists (E–F, B–C) — the
                // finger still draws but never lights up.
                const slotMidi = (i) => {
                    if ((i & 1) === 0) return whites[i >> 1];
                    const wLo = whites[i >> 1];
                    const wHi = whites[(i >> 1) + 1];
                    return (Number.isFinite(wLo) && Number.isFinite(wHi)
                            && wHi - wLo === 2) ? wLo + 1 : null;
                };

                // Finger body width = a fraction of a white-key
                // width so W and B fingers stay visually balanced.
                const refWw = kb.keyWidth(whites[0]);
                const wwSafe = Number.isFinite(refWw) && refWw > 0 ? refWw : 14;
                const fingerW = Math.max(3, wwSafe * 0.32);

                // Knuckle bar: from the leftmost slot's left edge to
                // the rightmost actually-drawable slot's right edge.
                // We compute the highest slot index whose pixel
                // centre is computable (= every white before it has
                // been resolved) so partially off-screen hands still
                // render their visible portion.
                let lastDrawableSlot = numFingers - 1;
                while (lastDrawableSlot >= 0
                        && (lastDrawableSlot & 1) === 1
                        && (lastDrawableSlot >> 1) + 1 >= whiteCenters.length) {
                    lastDrawableSlot--;
                }
                while (lastDrawableSlot >= 0
                        && (lastDrawableSlot & 1) === 0
                        && (lastDrawableSlot >> 1) >= whiteCenters.length) {
                    lastDrawableSlot--;
                }
                if (lastDrawableSlot < 0) continue;
                const leftX = slotCenterX(0) - fingerW / 2;
                const rightX = slotCenterX(lastDrawableSlot) + fingerW / 2;
                this._drawKnuckleBar(ctx, hand.color, leftX, rightX,
                                      knuckleTop, opts.knuckleHeight, W);

                // Pass 1 — black fingers (odd slot indices). Drawn
                // first so the white fingers cap their bottom.
                for (let i = 1; i <= lastDrawableSlot; i += 2) {
                    if ((i >> 1) + 1 >= whiteCenters.length) break;
                    const m = slotMidi(i);
                    const isActive = Number.isFinite(m) && this._activeNotes.has(m);
                    this._drawFingerBar(ctx, slotCenterX(i), blackTipY, blackFingerH,
                                         fingerW, isActive, W);
                }
                // Pass 2 — white fingers (even slot indices) on top.
                for (let i = 0; i <= lastDrawableSlot; i += 2) {
                    if ((i >> 1) >= whiteCenters.length) break;
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
         *  a black key (rare anchor position) we skip up to the
         *  next white. Returns fewer than `count` only when we run
         *  out of MIDI space (>127). */
        _whiteKeysFromAnchor(startMidi, count) {
            const out = [];
            let m = Math.max(0, Math.round(startMidi));
            if (this._isBlackKey(m)) m++;
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
