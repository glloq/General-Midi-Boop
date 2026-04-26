/**
 * @file FretboardLookaheadStrip.js
 * @description Vertical timeline strip mounted ABOVE the live
 * fretboard preview for fretted instruments. Shows where the hand
 * is going to be over the next 2-5 seconds, like a piano roll
 * focused on the hand band — NOT on the falling notes.
 *
 * Layout: time runs vertically (now at the bottom, +windowSeconds
 * at the top). The X-axis matches the live fretboard's geometry
 * (same fret positions, same scale-mm logic) so the band's
 * horizontal range lines up with what's drawn on the manche below.
 *
 * Public API mirrors `FretboardHandPreview` for the trajectory side:
 *   - `setHandTrajectory(points)` (one-shot per engine setup)
 *   - `setTicksPerSec(tps)`
 *   - `setCurrentTime(sec)` (every tick, throttled).
 *
 * Renders for each segment between two consecutive trajectory
 * points:
 *   - HOLD rectangle at the previous anchor (from `tick` to
 *     `releaseTick`) — "hand stays here while the chord rings",
 *   - TRANSITION trapezoid between `releaseTick` and the next
 *     anchor's `tick` — "hand slides to the new position".
 * The colour is a single neutral hand-tone (no level distinction);
 * red is reserved for the live band on the fretboard.
 */
(function() {
    'use strict';

    // Must match FretboardHandPreview's FINGER_BEFORE_FRET_MM so the
    // lookahead trajectories line up with the live band on the manche.
    const FINGER_BEFORE_FRET_MM = 10;

    class FretboardLookaheadStrip {
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.numFrets = Number.isFinite(opts.numFrets) && opts.numFrets > 0 ? opts.numFrets : 24;
            this.scaleLengthMm = Number.isFinite(opts.scaleLengthMm) && opts.scaleLengthMm > 0
                ? opts.scaleLengthMm : null;
            this.handSpanMm = Number.isFinite(opts.handSpanMm) && opts.handSpanMm > 0
                ? opts.handSpanMm : null;
            this.handSpanFrets = Number.isFinite(opts.handSpanFrets) && opts.handSpanFrets > 0
                ? opts.handSpanFrets : 4;
            this.windowSeconds = Math.max(2, Math.min(8,
                Number.isFinite(opts.windowSeconds) ? opts.windowSeconds : 4));

            // Margins MUST match `FretboardHandPreview` so the
            // band's X-axis lines up perfectly with the live
            // fretboard below.
            this.margin = { top: 6, right: 56, bottom: 6, left: 56 };

            this._trajectory = [];
            this._ticksPerSec = null;
            this._currentSec = 0;
            this._lastDrawnSec = -Infinity;
        }

        // -----------------------------------------------------------------
        //  Public API
        // -----------------------------------------------------------------

        setHandTrajectory(points) {
            this._trajectory = Array.isArray(points)
                ? points
                    .filter(p => p && Number.isFinite(p.tick) && Number.isFinite(p.anchor))
                    .slice()
                    .sort((a, b) => a.tick - b.tick)
                : [];
            this._lastDrawnSec = -Infinity;
            this.draw();
        }

        setTicksPerSec(ticksPerSec) {
            this._ticksPerSec = Number.isFinite(ticksPerSec) && ticksPerSec > 0
                ? ticksPerSec : null;
        }

        setCurrentTime(currentSec) {
            const next = Math.max(0, Number.isFinite(currentSec) ? currentSec : 0);
            // Throttle: only redraw when the playhead moves at least
            // one canvas pixel (keeps CPU low on long sustained chords
            // where the strip barely changes).
            const h = (this.canvas?.clientHeight || this.canvas?.height) || 1;
            const pxPerSec = h / this.windowSeconds;
            if (Math.abs(next - this._lastDrawnSec) * pxPerSec < 1) {
                this._currentSec = next;
                return;
            }
            this._currentSec = next;
            this.draw();
        }

        // -----------------------------------------------------------------
        //  Geometry (shared formulas with FretboardHandPreview)
        // -----------------------------------------------------------------

        _usableWidth() {
            const w = this.canvas.clientWidth || this.canvas.width || 0;
            return Math.max(0, w - this.margin.left - this.margin.right);
        }

        _fretX(n) {
            const usableW = this._usableWidth();
            const totalDist = 1 - Math.pow(2, -this.numFrets / 12);
            if (totalDist <= 0) return this.margin.left;
            const frac = (1 - Math.pow(2, -n / 12)) / totalDist;
            return this.margin.left + frac * usableW;
        }

        _xFromMm(mm) {
            if (!this.scaleLengthMm) return null;
            const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            if (totalDistMm <= 0) return this.margin.left;
            const usableW = this._usableWidth();
            return this.margin.left + (mm / totalDistMm) * usableW;
        }

        // Band aligned with the simulator window — see the equivalent
        // helper in FretboardHandPreview.js for the rationale (the old
        // `slotLeft = anchor − 1` approximation made the band drift
        // one fret to the left of the playability range).
        _handWindowX(anchorFret) {
            const safeAnchor = Math.max(0, anchorFret);
            let x0, x1;
            if (this.scaleLengthMm && this.handSpanMm) {
                const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -safeAnchor / 12));
                // Same finger-before-fret offset as FretboardHandPreview so
                // the lookahead trapezoids line up with the live band.
                const leftMm = Math.max(0, anchorMm - FINGER_BEFORE_FRET_MM);
                x0 = this._xFromMm(leftMm);
                const rightMm = leftMm + this.handSpanMm;
                const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
                x1 = rightMm >= totalDistMm
                    ? this._fretX(this.numFrets)
                    : this._xFromMm(rightMm);
            } else {
                x0 = this._fretX(safeAnchor);
                x1 = this._fretX(Math.min(this.numFrets, safeAnchor + this.handSpanFrets));
            }
            return { x0, x1 };
        }

        /** sec → y; bottom = currentSec, top = currentSec + windowSeconds. */
        _yAt(sec, h) {
            return h * (1 - (sec - this._currentSec) / this.windowSeconds);
        }

        // -----------------------------------------------------------------
        //  Rendering
        // -----------------------------------------------------------------

        draw() {
            if (!this.ctx || !this.canvas) return;
            const w = this.canvas.clientWidth || this.canvas.width || 0;
            const h = this.canvas.clientHeight || this.canvas.height || 0;
            if (w <= 0 || h <= 0) return;

            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            if (this.canvas.width !== Math.round(w * dpr)
                    || this.canvas.height !== Math.round(h * dpr)) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
            }
            const ctx = this.ctx;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            // Background.
            ctx.fillStyle = '#f5f7fb';
            ctx.fillRect(0, 0, w, h);
            this._lastDrawnSec = this._currentSec;

            if (!this._ticksPerSec || this._trajectory.length === 0) {
                this._drawNowLine(w, h);
                return;
            }

            const tps = this._ticksPerSec;
            const start = this._currentSec;
            const end = start + this.windowSeconds;

            // Build the visible series: pad with the last point at
            // or before `start` so the bottom of the strip always
            // shows where the hand IS now.
            let lastBefore = null;
            const visible = [];
            for (const p of this._trajectory) {
                const pSec = p.tick / tps;
                if (pSec <= start) lastBefore = p;
                else if (pSec <= end) visible.push(p);
                else break;
            }
            if (lastBefore) visible.unshift(lastBefore);
            if (visible.length === 0) {
                this._drawNowLine(w, h);
                return;
            }

            // For each consecutive pair, paint:
            //  - HOLD rect at prev.anchor between prev.sec and
            //    prev.releaseSec (clamped to [start, end]).
            //  - TRANSITION trapezoid from prev (at releaseSec) to
            //    next (at next.sec).
            // Clamping ensures geometry stays inside the canvas.
            const HOLD_FILL = 'rgba(34, 197, 94, 0.20)';
            const HOLD_STROKE = 'rgba(34, 197, 94, 0.55)';
            const TRANSITION_FILL = 'rgba(34, 197, 94, 0.12)';
            const TRANSITION_STROKE = 'rgba(34, 197, 94, 0.40)';

            ctx.lineWidth = 1;
            for (let i = 0; i < visible.length - 1; i++) {
                const a = visible[i];
                const b = visible[i + 1];
                const aSec = Math.max(start, a.tick / tps);
                const aReleaseSec = Math.max(aSec, Math.min(b.tick / tps,
                    (Number.isFinite(a.releaseTick) ? a.releaseTick : a.tick) / tps));
                const bSec = Math.min(end, b.tick / tps);

                const colA = this._handWindowX(a.anchor);
                const colB = this._handWindowX(b.anchor);
                const yA = this._yAt(aSec, h);
                const yARelease = this._yAt(aReleaseSec, h);
                const yB = this._yAt(bSec, h);

                // HOLD at A from aSec → aReleaseSec.
                if (yARelease < yA - 0.5) {
                    ctx.fillStyle = HOLD_FILL;
                    ctx.fillRect(colA.x0, yARelease,
                                  colA.x1 - colA.x0, yA - yARelease);
                    ctx.strokeStyle = HOLD_STROKE;
                    ctx.strokeRect(colA.x0 + 0.5, yARelease + 0.5,
                                    colA.x1 - colA.x0 - 1, yA - yARelease - 1);
                }

                // TRANSITION trapezoid from A (at yARelease) → B (at yB).
                if (yB < yARelease - 0.5) {
                    ctx.fillStyle = TRANSITION_FILL;
                    ctx.beginPath();
                    ctx.moveTo(colA.x0, yARelease);
                    ctx.lineTo(colA.x1, yARelease);
                    ctx.lineTo(colB.x1, yB);
                    ctx.lineTo(colB.x0, yB);
                    ctx.closePath();
                    ctx.fill();
                    ctx.strokeStyle = TRANSITION_STROKE;
                    ctx.stroke();
                }
            }

            // Tail: the LAST visible point's HOLD region extends to
            // the end of the visible window so the strip always
            // shows "the hand will sit at this anchor for the
            // remainder".
            const last = visible[visible.length - 1];
            const lastSec = Math.max(start, last.tick / tps);
            const colLast = this._handWindowX(last.anchor);
            const yLast = this._yAt(lastSec, h);
            const yEnd = this._yAt(end, h); // = 0 (top of canvas)
            if (yEnd < yLast - 0.5) {
                ctx.fillStyle = HOLD_FILL;
                ctx.fillRect(colLast.x0, yEnd,
                              colLast.x1 - colLast.x0, yLast - yEnd);
                ctx.strokeStyle = HOLD_STROKE;
                ctx.strokeRect(colLast.x0 + 0.5, yEnd + 0.5,
                                colLast.x1 - colLast.x0 - 1, yLast - yEnd - 1);
            }

            this._drawNowLine(w, h);
        }

        /** A thin horizontal line at the bottom of the canvas
         *  marks the playhead position (= "now"). @private */
        _drawNowLine(w, h) {
            const ctx = this.ctx;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, h - 0.5);
            ctx.lineTo(w, h - 0.5);
            ctx.stroke();
        }

        destroy() {
            this._trajectory = [];
            this._ticksPerSec = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.FretboardLookaheadStrip = FretboardLookaheadStrip;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FretboardLookaheadStrip;
    }
})();
