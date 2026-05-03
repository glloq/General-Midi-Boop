/**
 * @file VerticalFretboardPreview.js
 * @description Vertical-orientation fretboard widget mounted in the
 * left column of the full-length editor modal. Mirrors the geometry of
 * FretboardHandPreview but with axes swapped:
 *   - Y axis: along the neck — fret 0 (nut) at the top, last fret at
 *     the bottom. The hand band's height equals the constant
 *     `hand_span_mm` mapped through the fret formula.
 *   - X axis: across the strings — leftmost string at X=margin.left,
 *     rightmost at X=W-margin.right. Strings are vertical lines.
 *
 * The same engine drives this widget as the horizontal preview:
 *   setHandTrajectory(points), setTicksPerSec(tps), setCurrentTime(sec),
 *   setActivePositions([{string, fret, velocity}]),
 *   setUnplayablePositions([{string, fret, reason, direction}]),
 *   setLevel('ok'|'warning'|'infeasible').
 *
 * Drag-to-pin: same `onBandDrag(handId, newAnchor)` callback as the
 * horizontal preview.
 */
(function() {
    'use strict';

    const FINGER_BEFORE_FRET_MM = 8;
    const HAND_BAND_X_OVERFLOW = 6;

    class VerticalFretboardPreview {
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.tuning = Array.isArray(opts.tuning) ? opts.tuning.slice() : [40, 45, 50, 55, 59, 64];
            this.numStrings = this.tuning.length;
            this.numFrets = Number.isFinite(opts.numFrets) && opts.numFrets > 0 ? opts.numFrets : 24;
            this.handSpanFrets = Number.isFinite(opts.handSpanFrets) && opts.handSpanFrets > 0
                ? opts.handSpanFrets : 4;
            // Mechanism + max_fingers drive the per-finger reach
            // rectangle. Both can be undefined for non-fretted setups
            // — the renderer simply skips drawing the rectangle then.
            this.mechanism = typeof opts.mechanism === 'string' ? opts.mechanism : null;
            this.maxFingers = Number.isFinite(opts.maxFingers) && opts.maxFingers > 0
                ? opts.maxFingers : 4;
            this.showFingerRange = !!opts.showFingerRange;
            // Constant-mm band geometry — see FretboardHandPreview.
            this.scaleLengthMm = Number.isFinite(opts.scaleLengthMm) && opts.scaleLengthMm > 0
                ? opts.scaleLengthMm : 648;
            if (Number.isFinite(opts.handSpanMm) && opts.handSpanMm > 0) {
                this.handSpanMm = opts.handSpanMm;
            } else {
                const refFret = Math.max(1, Math.round(this.numFrets * 0.25));
                const startMm = this.scaleLengthMm * (1 - Math.pow(2, -refFret / 12));
                const endMm = this.scaleLengthMm
                    * (1 - Math.pow(2, -(refFret + this.handSpanFrets) / 12));
                this.handSpanMm = Math.max(1, endMm - startMm);
            }

            this.activePositions = [];
            this.unplayablePositions = [];
            this._trajectory = [];
            this._ticksPerSec = null;
            this._currentSec = 0;
            this._level = 'ok';

            // Margins. Top hosts the tuning labels, left/right keep the
            // first/last string from sitting on the canvas edge.
            this.margin = { top: 24, right: 18, bottom: 14, left: 18 };

            this.onBandDrag = typeof opts.onBandDrag === 'function' ? opts.onBandDrag : null;
            this.handId = typeof opts.handId === 'string' ? opts.handId : 'fretting';
            this._drag = null;
            this._dragAnchor = null;

            if (this.canvas?.addEventListener) {
                this._mouseDownHandler = (e) => this._handleMouseDown(e);
                this._mouseMoveHandler = (e) => this._handleMouseMove(e);
                this._mouseUpHandler = () => this._handleMouseUp();
                this.canvas.addEventListener('mousedown', this._mouseDownHandler);
                this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
                document.addEventListener('mouseup', this._mouseUpHandler);
            }
        }

        // ----------------------------------------------------------------
        //  Public API (mirrors FretboardHandPreview)
        // ----------------------------------------------------------------

        setActivePositions(positions) {
            // Longitudinal model invariant: one finger per string ⇒ at
            // most one active note per string at any instant. Dedup by
            // string, keeping the entry with the highest velocity (or
            // the last one as a stable fallback) so a chord with two
            // events on the same string never draws two finger dots.
            const byString = new Map();
            if (Array.isArray(positions)) {
                for (const p of positions) {
                    if (!p || !Number.isFinite(p.string) || !Number.isFinite(p.fret)) continue;
                    const prev = byString.get(p.string);
                    if (!prev || (p.velocity ?? 0) >= (prev.velocity ?? 0)) {
                        byString.set(p.string, p);
                    }
                }
            }
            this.activePositions = [...byString.values()];
            this._activeFretByString = new Map();
            for (const p of this.activePositions) this._activeFretByString.set(p.string, p.fret);
            this.draw();
        }

        /**
         * Mark a set of strings as currently carrying an anchored finger
         * (held note above the anchor-min duration threshold). Used by
         * the longitudinal model to overlay an anchor marker on the
         * relevant per-string finger range. Pass an Iterable<number>
         * (Set, Array of string indices) or null to clear.
         */
        setAnchoredStrings(strings) {
            if (strings == null) {
                this._anchoredStrings = null;
            } else {
                this._anchoredStrings = new Set();
                for (const s of strings) {
                    if (Number.isInteger(s) && s >= 1) this._anchoredStrings.add(s);
                }
            }
            this.draw();
        }

        /**
         * Set the set of currently-sounding notes (note-on already
         * happened, note-off not yet). Unlike setActivePositions which
         * only carries the chord that just started, this list keeps
         * sustaining notes alive so the per-string finger marker stays
         * pinned to the held fret while the hand band slides around it
         * — the visual translation of the planner's anchoring rule
         * (the operator sees the finger stretching to the band's edge
         * instead of jumping back to the rest position).
         *
         * Pass an array of { string, fret, anchored?:boolean } or null
         * to clear. The renderer applies the same rule as setActivePositions
         * (one entry per string max, dedup by velocity).
         */
        setSustainingFingers(list) {
            this._sustainingByString = new Map();
            this._sustainingAnchored = new Set();
            if (Array.isArray(list)) {
                for (const item of list) {
                    if (!item || !Number.isInteger(item.string) || !Number.isFinite(item.fret)) continue;
                    if (item.fret <= 0) continue; // open strings: no fretting finger
                    this._sustainingByString.set(item.string, item.fret);
                    if (item.anchored) this._sustainingAnchored.add(item.string);
                }
            }
            this.draw();
        }

        setUnplayablePositions(positions) {
            this.unplayablePositions = Array.isArray(positions)
                ? positions
                    .filter(p => p && Number.isFinite(p.string) && Number.isFinite(p.fret))
                    .slice()
                : [];
            this.draw();
        }

        setHandTrajectory(points) {
            this._trajectory = Array.isArray(points)
                ? points
                    .filter(p => p && Number.isFinite(p.tick) && Number.isFinite(p.anchor))
                    .slice()
                    .sort((a, b) => a.tick - b.tick)
                : [];
            this._dragAnchor = null;
            this.draw();
        }

        setTicksPerSec(tps) {
            this._ticksPerSec = Number.isFinite(tps) && tps > 0 ? tps : null;
        }

        setCurrentTime(sec) {
            this._currentSec = Number.isFinite(sec) ? Math.max(0, sec) : 0;
            this.draw();
        }

        setLevel(level) {
            this._level = ['ok', 'warning', 'infeasible'].includes(level) ? level : 'ok';
            this.draw();
        }

        setShowFingerRange(show) {
            const next = !!show;
            if (this.showFingerRange === next) return;
            this.showFingerRange = next;
            this.draw();
        }

        // ----------------------------------------------------------------
        //  Geometry — neck on Y, strings on X
        // ----------------------------------------------------------------

        _usableHeight() {
            const h = this.canvas?.clientHeight || this.canvas?.height || 0;
            return Math.max(1, h - this.margin.top - this.margin.bottom);
        }

        _usableWidth() {
            const w = this.canvas?.clientWidth || this.canvas?.width || 0;
            return Math.max(1, w - this.margin.left - this.margin.right);
        }

        /** Y-coordinate of the fret-`n` wire. n=0 is the nut. */
        _fretY(n) {
            const totalDist = 1 - Math.pow(2, -this.numFrets / 12);
            const frac = (1 - Math.pow(2, -n / 12)) / totalDist;
            return this.margin.top + frac * this._usableHeight();
        }

        /** Y-coordinate at a given mm distance from the nut. */
        _yFromMm(mm) {
            const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            return this.margin.top + (mm / totalDistMm) * this._usableHeight();
        }

        /** X-coordinate of string `s` (1-based, 1 = lowest pitch). The
         *  highest-pitch string sits at the right edge — same convention
         *  as the horizontal preview's vertical axis (low at bottom,
         *  high at top), rotated 90° clockwise: low at left, high at
         *  right. */
        _stringX(s) {
            if (this.numStrings <= 1) return this.margin.left + this._usableWidth() / 2;
            const idx = Math.max(0, Math.min(this.numStrings - 1, s - 1));
            return this.margin.left + (idx / (this.numStrings - 1)) * this._usableWidth();
        }

        /** Returns `{y0, y1}` of the hand band given a fret anchor. */
        _handWindowY(anchor) {
            const safe = Math.max(0, anchor);
            const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -safe / 12));
            const topMm = Math.max(0, anchorMm - FINGER_BEFORE_FRET_MM);
            const y0 = this._yFromMm(topMm);
            const bottomMm = topMm + this.handSpanMm;
            const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            const y1 = bottomMm >= totalDistMm
                ? this._fretY(this.numFrets)
                : this._yFromMm(bottomMm);
            return { y0, y1 };
        }

        /** Inverse of `_fretY` — converts a pixel Y back to a (fractional)
         *  fret index. Used by drag hit-tests. */
        _fretAtY(py) {
            if (!Number.isFinite(py)) return null;
            const y0 = this._fretY(0);
            const yN = this._fretY(this.numFrets);
            if (py <= y0) return 0;
            if (py >= yN) return this.numFrets;
            for (let f = 1; f <= this.numFrets; f++) {
                const a = this._fretY(f - 1);
                const b = this._fretY(f);
                if (py <= b) {
                    const t = (py - a) / Math.max(1e-6, b - a);
                    return (f - 1) + t;
                }
            }
            return this.numFrets;
        }

        // ----------------------------------------------------------------
        //  Trajectory inspection (mirror of FretboardHandPreview)
        // ----------------------------------------------------------------

        _anchorFromTrajectory(sec) {
            if (!this._trajectory.length || !this._ticksPerSec) return null;
            const tps = this._ticksPerSec;
            // Find the bracketing waypoints around `sec` so we can lerp
            // the anchor instead of stepping. The planner already
            // saturates motion at hand_move_mm_per_sec, so a simple
            // linear interpolation between two consecutive feasible
            // waypoints yields a smooth, speed-respecting hand glide.
            let prev = null;
            let next = null;
            for (const p of this._trajectory) {
                const pSec = p.tick / tps;
                if (pSec <= sec) prev = p;
                else { next = p; break; }
            }
            if (!prev) return this._trajectory[0].anchor;
            if (!next) return prev.anchor;
            const tA = prev.tick / tps;
            const tB = next.tick / tps;
            const span = tB - tA;
            if (span <= 0) return next.anchor;
            const u = Math.max(0, Math.min(1, (sec - tA) / span));
            return prev.anchor + (next.anchor - prev.anchor) * u;
        }

        _currentDisplayedAnchor() {
            if (Number.isFinite(this._dragAnchor)) return this._dragAnchor;
            return this._anchorFromTrajectory(this._currentSec);
        }

        // ----------------------------------------------------------------
        //  Drawing
        // ----------------------------------------------------------------

        draw() {
            if (!this.ctx || !this.canvas) return;
            const w = this.canvas.clientWidth || this.canvas.width || 0;
            const h = this.canvas.clientHeight || this.canvas.height || 0;
            if (w <= 0 || h <= 0) return;

            const dpr = window.devicePixelRatio || 1;
            if (this.canvas.width !== Math.round(w * dpr)
                    || this.canvas.height !== Math.round(h * dpr)) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
                this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            const ctx = this.ctx;
            // Background — neutral light, then a wood-tone strip for the
            // fretboard so it reads as "the manche" at a glance.
            ctx.fillStyle = '#f5f7fb';
            ctx.fillRect(0, 0, w, h);
            const fbX = this.margin.left;
            const fbY = this.margin.top;
            const fbW = w - this.margin.left - this.margin.right;
            const fbH = h - this.margin.top - this.margin.bottom;
            ctx.fillStyle = '#c8b898';
            ctx.fillRect(fbX, fbY, fbW, fbH);

            const liveAnchor = this._currentDisplayedAnchor();
            if (Number.isFinite(liveAnchor)) {
                this._drawHandBand(fbX, fbW, liveAnchor);
                // The finger displacement zones + per-finger markers are
                // always rendered (no longer gated on showFingerRange):
                // the longitudinal anchored model needs them visible at
                // all times so the operator can see which fingers are
                // pressed, anchored, or hovering at rest.
                this._drawFingerRange(fbX, fbW, liveAnchor);
            }

            this._drawFretLines(fbX, fbW);
            this._drawStringLines(fbY, fbH);
            this._drawTuningLabels();
            // For string_sliding_fingers the active positions are
            // already drawn as filled circles inside _drawFingerRange,
            // so we skip the redundant overlay. fret_sliding_fingers
            // and other mechanisms still get the legacy markers.
            if (this.mechanism !== 'string_sliding_fingers') {
                this._drawActivePositions();
            }
            this._drawUnplayablePositions();
        }

        _drawHandBand(fbX, fbW, anchor) {
            const { y0, y1 } = this._handWindowY(anchor);
            if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) return;
            // Always-on anchored model: the band is the hand's reachable
            // window. Infeasible chords are now expressed by speed
            // saturation in the planner (warnings) rather than a visual
            // overlay, so we keep a single green tint and let the smooth
            // band motion convey the displacement itself.
            const ctx = this.ctx;
            const xLeft = fbX - HAND_BAND_X_OVERFLOW;
            const bandW = fbW + 2 * HAND_BAND_X_OVERFLOW;
            ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
            ctx.fillRect(xLeft, y0, bandW, y1 - y0);
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.65)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(xLeft, y0, bandW, y1 - y0);
            ctx.setLineDash([]);
        }

        /**
         * Per-finger reach rectangles inside the hand band.
         *
         *   - `string_sliding_fingers`: each finger is locked to ONE
         *     string and slides along the band. We draw one slim
         *     dashed vertical rectangle per finger, centered on a
         *     different string column, spanning the full band height,
         *     plus a small dot marking the active finger position.
         *   - `fret_sliding_fingers`: each finger is locked to a
         *     fret offset and slides across strings. We draw a single
         *     dashed rectangle covering the band width with a center
         *     dot marking the active position.
         */
        _drawFingerRange(fbX, fbW, anchor) {
            if (!this.mechanism) return;
            const { y0, y1 } = this._handWindowY(anchor);
            if (!Number.isFinite(y0) || !Number.isFinite(y1)) return;
            const ctx = this.ctx;
            ctx.save();
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
            ctx.fillStyle = 'rgba(37, 99, 235, 0.22)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            if (this.mechanism === 'string_sliding_fingers') {
                this._drawStringSlidingFingerRanges(y0, y1);
            } else if (this.mechanism === 'fret_sliding_fingers') {
                this._drawFretSlidingFingerRange(fbX, fbW, anchor);
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        _drawStringSlidingFingerRanges(y0, y1) {
            const ctx = this.ctx;
            const numF = Math.max(1, Math.min(this.maxFingers, this.numStrings));
            // Longitudinal anchored model: one finger per string, indexed
            // 1..numF. Each finger can move freely within the hand's
            // reach band (y0..y1) along its own string. We draw, for
            // every string:
            //   1. the per-string displacement zone (slim dashed rectangle)
            //      so the user always sees how far the finger could move,
            //   2. the finger marker, whose shape encodes the state:
            //        - inactive          → outline-only (hollow) circle
            //                               at the resting position
            //                               (centre of the band),
            //        - active note-on    → solid filled circle at the
            //                               played fret,
            //        - anchored (held)   → larger filled circle at the
            //                               anchored fret (the finger
            //                               sticks to the fret as the
            //                               band slides — see commit C).
            const rectW = 10;
            const restY = y0;
            // Source of truth for finger state: the sustaining map
            // (notes currently sounding, anchored or not). The
            // chord-event activeFret map is used as a fallback for
            // mechanisms that don't have a sustaining feed yet, but the
            // longitudinal pipeline pumps `setSustainingFingers` from
            // the modal's tick handler so anchored fingers stay pinned
            // to their fret as the band slides.
            const sustainingMap = this._sustainingByString || new Map();
            const sustainingAnchored = this._sustainingAnchored || new Set();
            const fallbackActive = this._activeFretByString || new Map();
            const anchoredFallback = this._anchoredStrings || null;
            for (let s = 1; s <= numF; s++) {
                const cx = this._stringX(s);
                ctx.fillRect(cx - rectW / 2, y0, rectW, y1 - y0);
                ctx.strokeRect(cx - rectW / 2, y0, rectW, y1 - y0);

                ctx.save();
                ctx.setLineDash([]);
                let activeFretOnString = sustainingMap.get(s);
                if (!Number.isFinite(activeFretOnString)) activeFretOnString = fallbackActive.get(s);
                const isActive = Number.isFinite(activeFretOnString) && activeFretOnString > 0;
                const isAnchored = sustainingAnchored.has(s)
                    || (anchoredFallback && anchoredFallback.has(s));

                let cy = restY;
                if (isActive) {
                    // Place the marker at the actual fret on this string.
                    cy = (this._fretY(activeFretOnString - 1) + this._fretY(activeFretOnString)) / 2;
                }

                if (isAnchored) {
                    ctx.fillStyle = 'rgba(37, 99, 235, 1)';
                    ctx.beginPath();
                    ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                    ctx.lineWidth = 1.2;
                    ctx.stroke();
                } else if (isActive) {
                    ctx.fillStyle = 'rgba(37, 99, 235, 0.95)';
                    ctx.beginPath();
                    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    // Hollow circle: the finger is hovering at its
                    // resting position, nothing pressed.
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
                    ctx.beginPath();
                    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
                ctx.restore();
            }
        }

        _drawFretSlidingFingerRange(fbX, fbW, anchor) {
            const ctx = this.ctx;
            const numF = Math.max(1, this.maxFingers);
            const lineH = 3;
            for (let i = 0; i < numF; i++) {
                // Place each line at the physical fret position anchor+i, matching
                // the 8mm-before-fret convention. Linear y0→y1 interpolation was
                // wrong: y1 = _fretY(anchor+numFingers), placing the last stripe
                // one fret too far (at anchor+numFingers instead of anchor+numFingers-1).
                const cy = this._fretY(anchor + i);
                ctx.fillRect(fbX, cy - lineH / 2, fbW, lineH);
                ctx.strokeRect(fbX, cy - lineH / 2, fbW, lineH);
                ctx.save();
                ctx.setLineDash([]);
                ctx.fillStyle = 'rgba(37, 99, 235, 0.85)';
                ctx.beginPath();
                ctx.arc(fbX + fbW / 2, cy, 2.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }

        _drawFretLines(fbX, fbW) {
            const ctx = this.ctx;
            ctx.strokeStyle = 'rgba(60, 40, 20, 0.6)';
            ctx.lineWidth = 1;
            for (let f = 1; f <= this.numFrets; f++) {
                const y = this._fretY(f);
                ctx.beginPath();
                ctx.moveTo(fbX, y);
                ctx.lineTo(fbX + fbW, y);
                ctx.stroke();
            }
            // Nut — heavier line at fret 0.
            ctx.strokeStyle = '#3a2a1a';
            ctx.lineWidth = 2;
            const yNut = this._fretY(0);
            ctx.beginPath();
            ctx.moveTo(fbX, yNut);
            ctx.lineTo(fbX + fbW, yNut);
            ctx.stroke();
        }

        _drawStringLines(fbY, fbH) {
            const ctx = this.ctx;
            ctx.strokeStyle = 'rgba(40, 30, 20, 0.75)';
            ctx.lineWidth = 1.2;
            for (let s = 1; s <= this.numStrings; s++) {
                const x = this._stringX(s);
                ctx.beginPath();
                ctx.moveTo(x, fbY);
                ctx.lineTo(x, fbY + fbH);
                ctx.stroke();
            }
        }

        _drawTuningLabels() {
            const ctx = this.ctx;
            ctx.fillStyle = '#374151';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
            const yLabel = this.margin.top - 12;
            for (let s = 1; s <= this.numStrings; s++) {
                const midi = this.tuning[s - 1];
                if (!Number.isFinite(midi)) continue;
                const name = `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
                ctx.fillText(name, this._stringX(s), yLabel);
            }
        }

        _drawActivePositions() {
            if (!this.activePositions.length) return;
            const ctx = this.ctx;
            for (const p of this.activePositions) {
                const x = this._stringX(p.string);
                const y = p.fret === 0
                    ? this._fretY(0) - 8
                    : (this._fretY(p.fret - 1) + this._fretY(p.fret)) / 2;
                ctx.fillStyle = 'rgba(37, 99, 235, 0.85)';
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        _drawUnplayablePositions() {
            if (!this.unplayablePositions.length) return;
            const ctx = this.ctx;
            const liveAnchor = this._currentDisplayedAnchor();
            let bandTopY = null, bandBottomY = null;
            if (Number.isFinite(liveAnchor)) {
                const { y0, y1 } = this._handWindowY(liveAnchor);
                if (Number.isFinite(y0) && Number.isFinite(y1)) {
                    bandTopY = y0;
                    bandBottomY = y1;
                }
            }
            for (const pos of this.unplayablePositions) {
                const x = this._stringX(pos.string);
                let y;
                let chevron = null;
                // direction='left' on the horizontal preview meant
                // "below the anchor" — in the vertical layout that's
                // ABOVE the band (toward the nut).
                if (pos.direction === 'left' && bandTopY != null) {
                    y = bandTopY - 12;
                    chevron = 'up';
                } else if (pos.direction === 'right' && bandBottomY != null) {
                    y = bandBottomY + 12;
                    chevron = 'down';
                } else if (pos.fret === 0) {
                    y = this._fretY(0) - 8;
                } else {
                    y = (this._fretY(pos.fret - 1) + this._fretY(pos.fret)) / 2;
                }
                ctx.fillStyle = 'rgba(239, 68, 68, 0.55)';
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#dc2626';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.stroke();
                if (chevron) {
                    const dy = chevron === 'up' ? -7 : 7;
                    const tip = chevron === 'up' ? -3 : 3;
                    ctx.strokeStyle = '#b91c1c';
                    ctx.beginPath();
                    ctx.moveTo(x - 3, y + dy - tip);
                    ctx.lineTo(x, y + dy);
                    ctx.lineTo(x + 3, y + dy - tip);
                    ctx.stroke();
                }
            }
        }

        // ----------------------------------------------------------------
        //  Drag-to-pin
        // ----------------------------------------------------------------

        _pointerXY(e) {
            const rect = this.canvas?.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            return {
                x: (e.clientX || 0) - rect.left,
                y: (e.clientY || 0) - rect.top
            };
        }

        _handleMouseDown(e) {
            if (!this.onBandDrag) return;
            const liveAnchor = this._currentDisplayedAnchor();
            if (!Number.isFinite(liveAnchor)) return;
            const { y0, y1 } = this._handWindowY(liveAnchor);
            if (!Number.isFinite(y0) || !Number.isFinite(y1)) return;
            const { x, y } = this._pointerXY(e);
            const fbX = this.margin.left;
            const fbW = (this.canvas.clientWidth || this.canvas.width || 0)
                - this.margin.left - this.margin.right;
            // Hit zone: inside the band, across the full neck width.
            if (x < fbX - HAND_BAND_X_OVERFLOW || x > fbX + fbW + HAND_BAND_X_OVERFLOW) return;
            if (y < y0 || y > y1) return;
            const fract = this._fretAtY(y);
            if (fract == null) return;
            this._drag = { offset: fract - liveAnchor, moved: false };
            if (e.preventDefault) e.preventDefault();
        }

        _handleMouseMove(e) {
            if (!this._drag) return;
            const { y } = this._pointerXY(e);
            const fract = this._fretAtY(y);
            if (fract == null) return;
            const maxAnchor = Math.max(0, this.numFrets - this.handSpanFrets);
            const newAnchor = Math.max(0, Math.min(maxAnchor,
                Math.round(fract - this._drag.offset)));
            if (this._dragAnchor !== newAnchor) {
                this._dragAnchor = newAnchor;
                this._drag.moved = true;
                this.draw();
            }
        }

        _handleMouseUp() {
            if (!this._drag) return;
            const drag = this._drag;
            this._drag = null;
            if (!drag.moved || !Number.isFinite(this._dragAnchor)) {
                this._dragAnchor = null;
                return;
            }
            const finalAnchor = this._dragAnchor;
            this.onBandDrag?.(this.handId, finalAnchor);
        }

        // ----------------------------------------------------------------
        //  Lifecycle
        // ----------------------------------------------------------------

        destroy() {
            this.activePositions = [];
            this.unplayablePositions = [];
            this._trajectory = [];
            this._drag = null;
            this._dragAnchor = null;
            if (this.canvas?.removeEventListener) {
                if (this._mouseDownHandler) this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
                if (this._mouseMoveHandler) this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
            }
            if (this._mouseUpHandler) {
                document.removeEventListener('mouseup', this._mouseUpHandler);
            }
            this._mouseDownHandler = null;
            this._mouseMoveHandler = null;
            this._mouseUpHandler = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.VerticalFretboardPreview = VerticalFretboardPreview;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = VerticalFretboardPreview;
    }
})();
