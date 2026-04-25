/**
 * @file FretboardHandPreview.js
 * @description Horizontal fretboard view dedicated to the hands
 * preview in `HandsPreviewPanel` for fretted instruments. Unlike the
 * playback `FretboardDiagram` (vertical, click-to-play, scrolling),
 * this widget paints the neck horizontally with realistic geometric
 * fret spacing so the operator can see at a glance:
 *
 *   - where the fretting hand currently sits (shaded rectangle whose
 *     width equals the configured `hand_span_mm`, mapped onto the
 *     instrument's `scale_length_mm`),
 *   - which fret/string positions are active in the current chord
 *     (translucent dots on the string × fret intersections),
 *   - the fret numbers + standard inlay markers.
 *
 * Falls back to a constant-fret span when `scale_length_mm` /
 * `hand_span_mm` aren't configured: the rectangle then spans
 * `hand_span_frets` frets.
 *
 * Public API mirrors the slice of `FretboardDiagram` used by
 * `HandsPreviewPanel` so the two are interchangeable:
 *
 *   const fb = new FretboardHandPreview(canvas, {
 *     tuning, numFrets, scaleLengthMm?, handSpanMm?, handSpanFrets?
 *   });
 *   fb.setActivePositions([{ string, fret, velocity }, …]);
 *   fb.setHandWindow({ anchorFret, spanFrets, level }); // null clears
 *   fb.draw();
 *   fb.destroy();
 */
(function() {
    'use strict';

    const STANDARD_MARKER_FRETS  = [3, 5, 7, 9, 15, 17, 19, 21];
    const DOUBLE_MARKER_FRETS    = [12, 24];

    class FretboardHandPreview {
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.tuning = Array.isArray(opts.tuning) ? opts.tuning.slice() : [40, 45, 50, 55, 59, 64];
            this.numStrings = this.tuning.length;
            this.numFrets = Number.isFinite(opts.numFrets) && opts.numFrets > 0 ? opts.numFrets : 24;
            this.scaleLengthMm = Number.isFinite(opts.scaleLengthMm) && opts.scaleLengthMm > 0
                ? opts.scaleLengthMm : null;
            this.handSpanMm = Number.isFinite(opts.handSpanMm) && opts.handSpanMm > 0
                ? opts.handSpanMm : null;
            this.handSpanFrets = Number.isFinite(opts.handSpanFrets) && opts.handSpanFrets > 0
                ? opts.handSpanFrets : 4;

            this.activePositions = [];
            this.unplayablePositions = [];
            this.handWindow = null;
            this.ghostAnchor = null;

            this.margin = { top: 14, right: 12, bottom: 24, left: 24 };

            this._dprSyncedSize = { w: 0, h: 0 };
        }

        // -----------------------------------------------------------------
        //  Configuration
        // -----------------------------------------------------------------

        setActivePositions(positions) {
            this.activePositions = Array.isArray(positions) ? positions.slice() : [];
            this.draw();
        }

        /**
         * Mark string × fret positions as UNPLAYABLE — currently
         * triggered by `outside_window` and `too_many_fingers`. Each
         * entry: `{string, fret, reason?}`. Painted as a translucent
         * red disc on top of the existing finger dot, plus a thin
         * red border, so the operator sees at a glance which notes
         * the simulator considers at risk.
         */
        setUnplayablePositions(positions) {
            this.unplayablePositions = Array.isArray(positions)
                ? positions.filter(p => p
                    && Number.isFinite(p.string) && Number.isFinite(p.fret)).slice()
                : [];
            this.draw();
        }

        /**
         * Set a translucent "ghost" rectangle showing where the hand
         * is GOING for the next planned shift. Same shape as the
         * regular `setHandWindow` payload but rendered with a more
         * faded fill + dashed outline so the eye reads "future
         * position, not current". Pass `null` to clear.
         */
        setGhostAnchor(window) {
            if (window == null) {
                this.ghostAnchor = null;
                this.draw();
                return;
            }
            const anchor = parseInt(window.anchorFret, 10);
            const spanFrets = parseInt(window.spanFrets, 10);
            if (!Number.isFinite(anchor) || !Number.isFinite(spanFrets) || spanFrets <= 0) {
                this.ghostAnchor = null;
                this.draw();
                return;
            }
            this.ghostAnchor = {
                anchorFret: Math.max(0, anchor),
                spanFrets,
                level: window.level || 'ok'
            };
            this.draw();
        }

        setHandWindow(handWindow) {
            if (handWindow == null) {
                this.handWindow = null;
                this.draw();
                return;
            }
            const anchor = parseInt(handWindow.anchorFret, 10);
            const spanFrets = parseInt(handWindow.spanFrets, 10);
            if (!Number.isFinite(anchor) || !Number.isFinite(spanFrets) || spanFrets <= 0) {
                this.handWindow = null;
                this.draw();
                return;
            }
            this.handWindow = {
                anchorFret: Math.max(0, anchor),
                spanFrets,
                level: handWindow.level || 'ok'
            };
            this.draw();
        }

        // -----------------------------------------------------------------
        //  Geometry
        // -----------------------------------------------------------------

        /** Pixel x of the LEFT side of fret n (n=0 is the nut). */
        _fretX(n) {
            const usableW = this._usableWidth();
            const totalDist = 1 - Math.pow(2, -this.numFrets / 12);
            if (totalDist <= 0) return this.margin.left;
            const frac = (1 - Math.pow(2, -n / 12)) / totalDist;
            return this.margin.left + frac * usableW;
        }

        /** Pixel x at a given mm-from-nut distance, when scale_length is known. */
        _xFromMm(mm) {
            if (!this.scaleLengthMm) return null;
            const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            if (totalDistMm <= 0) return this.margin.left;
            const usableW = this._usableWidth();
            return this.margin.left + (mm / totalDistMm) * usableW;
        }

        /** Pixel y of string `s` (1-based; s=1 is the lowest pitch, drawn at the bottom). */
        _stringY(s) {
            const usableH = this._usableHeight();
            const spacing = usableH / Math.max(1, this.numStrings - 1);
            return this.margin.top + (this.numStrings - s) * spacing;
        }

        _usableWidth() {
            const w = this.canvas.clientWidth || this.canvas.width || 0;
            return Math.max(0, w - this.margin.left - this.margin.right);
        }

        _usableHeight() {
            const h = this.canvas.clientHeight || this.canvas.height || 0;
            return Math.max(0, h - this.margin.top - this.margin.bottom);
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
            if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
                this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            const ctx = this.ctx;

            // Clear background.
            ctx.fillStyle = '#f5f7fb';
            ctx.fillRect(0, 0, w, h);

            const fbX = this.margin.left;
            const fbY = this.margin.top;
            const fbW = w - this.margin.left - this.margin.right;
            const fbH = h - this.margin.top - this.margin.bottom;

            // Fretboard wood-tone fill.
            ctx.fillStyle = '#c8b898';
            ctx.fillRect(fbX, fbY, fbW, fbH);

            // Ghost anchor (= upcoming planned position) drawn first
            // so the live hand window paints on top.
            if (this.ghostAnchor) this._drawGhostAnchor(fbY, fbH);
            // Hand window (under strings/dots so finger dots stay legible).
            if (this.handWindow) this._drawHandWindow(fbX, fbY, fbW, fbH, w);

            // Inlay dots.
            this._drawInlayMarkers(fbY, fbH);

            // Frets (vertical lines).
            this._drawFrets(fbY, fbH);

            // Strings (horizontal lines).
            this._drawStrings();

            // Fret numbers below the board.
            this._drawFretNumbers(fbY, fbH);

            // Active note positions.
            this._drawActivePositions();
            // Unplayable overlay (red discs on top of the active dots).
            this._drawUnplayablePositions();
        }

        _drawGhostAnchor(fbY, fbH) {
            const { anchorFret, spanFrets, level } = this.ghostAnchor;
            const x0 = this._fretX(anchorFret);
            let x1;
            if (this.scaleLengthMm && this.handSpanMm) {
                const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -anchorFret / 12));
                const rightMm = anchorMm + this.handSpanMm;
                if (rightMm >= this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12))) {
                    x1 = this._fretX(this.numFrets);
                } else {
                    x1 = this._xFromMm(rightMm);
                }
            } else {
                x1 = this._fretX(Math.min(this.numFrets, anchorFret + (spanFrets || this.handSpanFrets)));
            }
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return;

            // Faded fills (≈ 40 % of handWindow alpha) so the ghost
            // never out-shouts the live band but is still readable.
            const fills = {
                ok:         'rgba(34, 197, 94, 0.10)',
                warning:    'rgba(245, 158, 11, 0.12)',
                infeasible: 'rgba(239, 68, 68, 0.14)'
            };
            const strokes = {
                ok:         'rgba(34, 197, 94, 0.55)',
                warning:    'rgba(245, 158, 11, 0.65)',
                infeasible: 'rgba(239, 68, 68, 0.65)'
            };
            const ctx = this.ctx;
            ctx.fillStyle = fills[level] || fills.ok;
            ctx.fillRect(x0, fbY, x1 - x0, fbH);
            ctx.strokeStyle = strokes[level] || strokes.ok;
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]);
            ctx.strokeRect(x0, fbY, x1 - x0, fbH);
            ctx.setLineDash([]);
        }

        _drawUnplayablePositions() {
            if (this.unplayablePositions.length === 0) return;
            const ctx = this.ctx;
            for (const pos of this.unplayablePositions) {
                const y = this._stringY(pos.string);
                let x;
                if (pos.fret === 0) {
                    x = this._fretX(0) - 8;
                } else {
                    x = (this._fretX(pos.fret - 1) + this._fretX(pos.fret)) / 2;
                }
                const fretW = pos.fret > 0
                    ? this._fretX(pos.fret) - this._fretX(pos.fret - 1)
                    : 16;
                const r = Math.max(4, Math.min(7, fretW * 0.36));
                ctx.fillStyle = 'rgba(239, 68, 68, 0.55)';
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#dc2626';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        _drawHandWindow(fbX, fbY, fbW, fbH, _canvasW) {
            const { anchorFret, spanFrets, level } = this.handWindow;
            const x0 = this._fretX(anchorFret);
            let x1;
            if (this.scaleLengthMm && this.handSpanMm) {
                const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -anchorFret / 12));
                const rightMm = anchorMm + this.handSpanMm;
                if (rightMm >= this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12))) {
                    x1 = this._fretX(this.numFrets);
                } else {
                    x1 = this._xFromMm(rightMm);
                }
            } else {
                x1 = this._fretX(Math.min(this.numFrets, anchorFret + (spanFrets || this.handSpanFrets)));
            }
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return;

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
            ctx.fillStyle = fills[level] || fills.ok;
            ctx.fillRect(x0, fbY, x1 - x0, fbH);
            ctx.strokeStyle = strokes[level] || strokes.ok;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(x0, fbY, x1 - x0, fbH);
            ctx.setLineDash([]);
        }

        _drawInlayMarkers(fbY, fbH) {
            const ctx = this.ctx;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            const midY = fbY + fbH / 2;
            for (let f = 1; f <= this.numFrets; f++) {
                const isDouble = DOUBLE_MARKER_FRETS.includes(f);
                const isSingle = STANDARD_MARKER_FRETS.includes(f);
                if (!isDouble && !isSingle) continue;
                const cx = (this._fretX(f - 1) + this._fretX(f)) / 2;
                const fretW = this._fretX(f) - this._fretX(f - 1);
                const radius = Math.max(2, Math.min(4, fretW * 0.18));
                if (isDouble) {
                    ctx.beginPath();
                    ctx.arc(cx, fbY + fbH * 0.3, radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.arc(cx, fbY + fbH * 0.7, radius, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    ctx.beginPath();
                    ctx.arc(cx, midY, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        _drawFrets(fbY, fbH) {
            const ctx = this.ctx;
            for (let f = 0; f <= this.numFrets; f++) {
                const x = this._fretX(f);
                if (f === 0) {
                    // Nut: thicker pale bar instead of a thin line.
                    ctx.fillStyle = '#e8e0d0';
                    ctx.fillRect(x - 2, fbY, 4, fbH);
                } else {
                    ctx.strokeStyle = '#9098a8';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, fbY);
                    ctx.lineTo(x, fbY + fbH);
                    ctx.stroke();
                }
            }
        }

        _drawStrings() {
            const ctx = this.ctx;
            const xL = this._fretX(0);
            const xR = this._fretX(this.numFrets);
            for (let s = 1; s <= this.numStrings; s++) {
                const y = this._stringY(s);
                ctx.strokeStyle = '#404a6b';
                ctx.lineWidth = 1 + (this.numStrings - s) * 0.35;
                ctx.beginPath();
                ctx.moveTo(xL, y);
                ctx.lineTo(xR, y);
                ctx.stroke();
            }
        }

        _drawFretNumbers(fbY, fbH) {
            const ctx = this.ctx;
            ctx.fillStyle = '#6b7280';
            ctx.font = '9px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (let f = 1; f <= this.numFrets; f++) {
                const cx = (this._fretX(f - 1) + this._fretX(f)) / 2;
                const fretW = this._fretX(f) - this._fretX(f - 1);
                if (fretW < 8) continue; // skip cramped frets at the high end
                ctx.fillText(f.toString(), cx, fbY + fbH + 3);
            }
        }

        _drawActivePositions() {
            const ctx = this.ctx;
            for (const pos of this.activePositions) {
                if (pos.string == null || pos.fret == null) continue;
                const y = this._stringY(pos.string);
                let x;
                if (pos.fret === 0) {
                    x = this._fretX(0) - 8;
                    ctx.fillStyle = '#06d6a0';
                } else {
                    x = (this._fretX(pos.fret - 1) + this._fretX(pos.fret)) / 2;
                    ctx.fillStyle = '#667eea';
                }
                const fretW = pos.fret > 0
                    ? this._fretX(pos.fret) - this._fretX(pos.fret - 1)
                    : 16;
                const r = Math.max(3, Math.min(6, fretW * 0.32));
                const alpha = 0.55 + (pos.velocity || 100) / 254;
                ctx.globalAlpha = Math.min(1, alpha);
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;

                if (pos.fret > 0 && fretW >= 14) {
                    ctx.fillStyle = '#ffffff';
                    ctx.font = `bold ${Math.min(9, fretW * 0.4)}px monospace`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(pos.fret.toString(), x, y);
                }
            }
        }

        // -----------------------------------------------------------------
        //  Lifecycle
        // -----------------------------------------------------------------

        destroy() {
            this.activePositions = [];
            this.unplayablePositions = [];
            this.handWindow = null;
            this.ghostAnchor = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.FretboardHandPreview = FretboardHandPreview;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FretboardHandPreview;
    }
})();
