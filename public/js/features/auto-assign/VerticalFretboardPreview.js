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

    const FINGER_BEFORE_FRET_MM = 10;
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
            this.activePositions = Array.isArray(positions)
                ? positions
                    .filter(p => p && Number.isFinite(p.string) && Number.isFinite(p.fret))
                    .slice()
                : [];
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
            let cur = null;
            for (const p of this._trajectory) {
                if (p.tick / tps <= sec) cur = p;
                else break;
            }
            return cur ? cur.anchor : this._trajectory[0].anchor;
        }

        _currentDisplayedAnchor() {
            if (Number.isFinite(this._dragAnchor)) return this._dragAnchor;
            return this._anchorFromTrajectory(this._currentSec);
        }

        _currentMotionTransition() {
            const traj = this._trajectory;
            const tps = this._ticksPerSec;
            if (!traj.length || !tps) return null;
            let prev = null;
            for (const p of traj) {
                const pSec = p.tick / tps;
                if (pSec <= this._currentSec) { prev = p; continue; }
                if (!prev) return null;
                if (!p.motion || p.motion.feasible !== false) return null;
                if (!Number.isFinite(prev.anchor) || !Number.isFinite(p.anchor)) return null;
                return { prevAnchor: prev.anchor, nextAnchor: p.anchor, motion: p.motion };
            }
            return null;
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
            }

            const infeasible = this._currentMotionTransition();
            if (infeasible) {
                this._drawInfeasibleMotionCurve(fbX, fbW,
                    infeasible.prevAnchor, infeasible.nextAnchor);
            }

            this._drawFretLines(fbX, fbW);
            this._drawStringLines(fbY, fbH);
            this._drawTuningLabels();
            this._drawActivePositions();
            this._drawUnplayablePositions();
        }

        _drawHandBand(fbX, fbW, anchor) {
            const { y0, y1 } = this._handWindowY(anchor);
            if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) return;
            const fills = {
                ok:         'rgba(34, 197, 94, 0.22)',
                warning:    'rgba(245, 158, 11, 0.24)',
                infeasible: 'rgba(239, 68, 68, 0.26)'
            };
            const strokes = {
                ok:         'rgba(34, 197, 94, 0.65)',
                warning:    'rgba(245, 158, 11, 0.75)',
                infeasible: 'rgba(239, 68, 68, 0.75)'
            };
            const ctx = this.ctx;
            const xLeft = fbX - HAND_BAND_X_OVERFLOW;
            const bandW = fbW + 2 * HAND_BAND_X_OVERFLOW;
            ctx.fillStyle = fills[this._level] || fills.ok;
            ctx.fillRect(xLeft, y0, bandW, y1 - y0);
            ctx.strokeStyle = strokes[this._level] || strokes.ok;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(xLeft, y0, bandW, y1 - y0);
            ctx.setLineDash([]);
        }

        _drawInfeasibleMotionCurve(fbX, fbW, prevAnchor, nextAnchor) {
            const ctx = this.ctx;
            const y1 = this._anchorBandCenterY(prevAnchor);
            const y2 = this._anchorBandCenterY(nextAnchor);
            if (!Number.isFinite(y1) || !Number.isFinite(y2)) return;
            const xBase = fbX + Math.min(14, fbW * 0.18);
            const arcWidth = Math.max(16, fbW * 0.32);
            const yMid = (y1 + y2) / 2;
            const xPeak = xBase - arcWidth;
            ctx.save();
            ctx.strokeStyle = '#f5c518';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(xBase, y1);
            ctx.quadraticCurveTo(xPeak, yMid, xBase, y2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }

        _anchorBandCenterY(anchor) {
            const { y0, y1 } = this._handWindowY(anchor);
            if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
            return (y0 + y1) / 2;
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
