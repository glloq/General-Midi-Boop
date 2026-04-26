/**
 * @file FretboardTimelineRenderer.js
 * @description Full-length tablature & hand-position timeline.
 *
 * Layout (horizontal):
 *   - X axis: time, ascending left → right. The playhead's row is
 *     `playheadSec * pxPerSec`. Mouse wheel pans, Ctrl/Cmd + wheel
 *     zooms.
 *   - Y axis: fret index — fret 0 (nut) at the top, last fret at the
 *     bottom. Same fret math as VerticalFretboardPreview so the two
 *     widgets line up when stacked / placed side by side.
 *
 * Each chord is rendered as a small dot at `(secToX(chord.tick), fretCenter[note.fret])`.
 * The fretting hand's trajectory is drawn as a translucent horizontal
 * ribbon spanning `[handWindowY(anchor).y0 .. .y1]` between consecutive
 * trajectory points. A yellow dashed Bézier links two ribbon segments
 * whose `motion.feasible === false`.
 *
 * Public API:
 *   const tr = new FretboardTimelineRenderer(canvas, {
 *     tuning, numFrets, scaleLengthMm?, handSpanMm?, handSpanFrets?,
 *     ticksPerSec, totalSec
 *   });
 *   tr.setTimeline(events);
 *   tr.setTrajectory(points);
 *   tr.setPlayhead(currentSec);
 *   tr.setScrollSec(sec);
 *   tr.setPxPerSec(px);
 *   tr.draw();
 *   tr.destroy();
 */
(function() {
    'use strict';

    const FINGER_BEFORE_FRET_MM = 10;
    const DEFAULT_PX_PER_SEC = 80;
    const MIN_PX_PER_SEC = 20;
    const MAX_PX_PER_SEC = 400;
    const VIEWPORT_MARGIN_SEC = 1;

    class FretboardTimelineRenderer {
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

            this.ticksPerSec = Number.isFinite(opts.ticksPerSec) && opts.ticksPerSec > 0
                ? opts.ticksPerSec : 480;
            this.totalSec = Number.isFinite(opts.totalSec) && opts.totalSec > 0
                ? opts.totalSec : 0;

            this._chords = [];
            this._shifts = [];
            this._trajectory = [];

            this.pxPerSec = Number.isFinite(opts.pxPerSec) && opts.pxPerSec > 0
                ? opts.pxPerSec : DEFAULT_PX_PER_SEC;
            this.scrollSec = 0;
            this.playheadSec = 0;

            // Top margin matches VerticalFretboardPreview so the two
            // widgets align when placed side by side.
            this.margin = { top: 24, right: 0, bottom: 14, left: 0 };

            this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : null;
            this.onNoteClick = typeof opts.onNoteClick === 'function' ? opts.onNoteClick : null;
            this._noteHits = [];

            this._dirty = true;
            this._rafHandle = null;
            this._frame = null;

            if (this.canvas?.addEventListener) {
                this._wheelHandler = (e) => this._handleWheel(e);
                this._clickHandler = (e) => this._handleClick(e);
                this._wheelOpts = { passive: false };
                this.canvas.addEventListener('wheel', this._wheelHandler, this._wheelOpts);
                this.canvas.addEventListener('click', this._clickHandler);
            }
        }

        // ----------------------------------------------------------------
        //  Public API
        // ----------------------------------------------------------------

        setTimeline(events) {
            const list = Array.isArray(events) ? events : [];
            this._chords = list.filter(e => e && e.type === 'chord' && Number.isFinite(e.tick));
            this._shifts = list.filter(e => e && e.type === 'shift' && Number.isFinite(e.tick));
            this._chords.sort((a, b) => a.tick - b.tick);
            this._shifts.sort((a, b) => a.tick - b.tick);
            // Precompute the per-chord unplayable note set so the draw
            // loop doesn't allocate a fresh Set every frame.
            for (const ch of this._chords) {
                ch._unplayableNotes = Array.isArray(ch.unplayable)
                    ? new Set(ch.unplayable
                        .filter(u => Number.isFinite(u.note))
                        .map(u => u.note))
                    : null;
            }
            this._scheduleDraw();
        }

        setTrajectory(points) {
            this._trajectory = Array.isArray(points)
                ? points
                    .filter(p => p && Number.isFinite(p.tick) && Number.isFinite(p.anchor))
                    .slice()
                    .sort((a, b) => a.tick - b.tick)
                : [];
            this._scheduleDraw();
        }

        setPlayhead(currentSec) {
            const next = Number.isFinite(currentSec) ? Math.max(0, currentSec) : 0;
            if (next === this.playheadSec) return;
            this.playheadSec = next;
            this._scheduleDraw();
        }

        setScrollSec(sec) {
            const max = Math.max(0, this.totalSec - this._viewportSec());
            const next = Math.max(0, Math.min(max, Number.isFinite(sec) ? sec : 0));
            if (next === this.scrollSec) return;
            this.scrollSec = next;
            this._scheduleDraw();
        }

        setPxPerSec(px) {
            const next = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC,
                Number.isFinite(px) ? px : this.pxPerSec));
            if (next === this.pxPerSec) return;
            // Keep the playhead column stable when zooming.
            const oldPxPerSec = this.pxPerSec;
            const playheadX = (this.playheadSec - this.scrollSec) * oldPxPerSec;
            this.pxPerSec = next;
            const newScroll = this.playheadSec - playheadX / next;
            const max = Math.max(0, this.totalSec - this._viewportSec());
            this.scrollSec = Math.max(0, Math.min(max, newScroll));
            this._scheduleDraw();
        }

        setTotalSec(totalSec) {
            this.totalSec = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
            this.setScrollSec(this.scrollSec);
        }

        // ----------------------------------------------------------------
        //  Geometry — frets on Y, time on X
        // ----------------------------------------------------------------

        _usableHeight() {
            const h = this.canvas?.clientHeight || this.canvas?.height || 0;
            return Math.max(1, h - this.margin.top - this.margin.bottom);
        }

        _viewportSec() {
            const w = this.canvas?.clientWidth || this.canvas?.width || 0;
            const usable = Math.max(0, w - this.margin.left - this.margin.right);
            return usable / Math.max(1, this.pxPerSec);
        }

        _fretY(n) {
            const totalDist = 1 - Math.pow(2, -this.numFrets / 12);
            const frac = (1 - Math.pow(2, -n / 12)) / totalDist;
            return this.margin.top + frac * this._usableHeight();
        }

        _yFromMm(mm) {
            const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            return this.margin.top + (mm / totalDistMm) * this._usableHeight();
        }

        _handWindowY(anchor) {
            const safe = Math.max(0, anchor);
            const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -safe / 12));
            const topMm = Math.max(0, anchorMm - FINGER_BEFORE_FRET_MM);
            const y0 = this._yFromMm(topMm);
            const bottomMm = topMm + this.handSpanMm;
            const lastFretMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            const y1 = bottomMm > lastFretMm
                ? this._fretY(this.numFrets)
                : this._yFromMm(bottomMm);
            return { y0, y1 };
        }

        _secToX(sec) {
            return this.margin.left + (sec - this.scrollSec) * this.pxPerSec;
        }

        _xToSec(x) {
            return this.scrollSec + (x - this.margin.left) / this.pxPerSec;
        }

        _tickToSec(tick) {
            return tick / Math.max(1, this.ticksPerSec);
        }

        // ----------------------------------------------------------------
        //  Interaction
        // ----------------------------------------------------------------

        _handleWheel(e) {
            if (e.preventDefault) e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const factor = Math.pow(1.0015, -(e.deltaY || 0));
                this.setPxPerSec(this.pxPerSec * factor);
                return;
            }
            // Shift+wheel and trackpad horizontal swipes ship deltaX —
            // honor it; otherwise use deltaY for vertical-wheel pans.
            const dxPx = e.deltaX || e.deltaY || 0;
            this.setScrollSec(this.scrollSec + dxPx / Math.max(1, this.pxPerSec));
        }

        _handleClick(e) {
            const rect = this.canvas?.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            const x = (e.clientX || 0) - rect.left;
            const y = (e.clientY || 0) - rect.top;
            if (this.onNoteClick) {
                const hit = this._noteHits.find(h => {
                    const dx = x - h.x;
                    const dy = y - h.y;
                    return dx * dx + dy * dy <= h.r * h.r;
                });
                if (hit) {
                    this.onNoteClick(hit, { clientX: e.clientX, clientY: e.clientY });
                    return;
                }
            }
            if (!this.onSeek) return;
            const sec = Math.max(0, Math.min(this.totalSec, this._xToSec(x)));
            this.onSeek(sec);
        }

        // ----------------------------------------------------------------
        //  Render scheduling
        // ----------------------------------------------------------------

        _scheduleDraw() {
            this._dirty = true;
            if (this._rafHandle != null) return;
            this._rafHandle = window.requestAnimationFrame(() => {
                this._rafHandle = null;
                if (this._dirty) this.draw();
            });
        }

        // ----------------------------------------------------------------
        //  Drawing
        // ----------------------------------------------------------------

        draw() {
            this._dirty = false;
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
            ctx.fillStyle = '#f5f7fb';
            ctx.fillRect(0, 0, w, h);

            const viewportSec = this._viewportSec();
            const lo = this.scrollSec - VIEWPORT_MARGIN_SEC;
            const hi = this.scrollSec + viewportSec + VIEWPORT_MARGIN_SEC;
            this._frame = { w, h, viewportSec, lo, hi };

            this._drawFretGrid(w, h);
            this._drawHandRibbon(w);
            this._drawInfeasibleCurves(w);
            this._drawChords();
            this._drawPlayhead(h);
            this._frame = null;
        }

        _drawFretGrid(w, h) {
            const ctx = this.ctx;
            ctx.strokeStyle = 'rgba(120, 120, 120, 0.18)';
            ctx.lineWidth = 1;
            for (let f = 1; f <= this.numFrets; f++) {
                const y = this._fretY(f);
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(w, y);
                ctx.stroke();
            }
            ctx.strokeStyle = 'rgba(60, 60, 60, 0.5)';
            ctx.lineWidth = 1.5;
            const yNut = this._fretY(0);
            ctx.beginPath();
            ctx.moveTo(0, yNut);
            ctx.lineTo(w, yNut);
            ctx.stroke();
        }

        _drawHandRibbon(w) {
            if (!this._trajectory.length) return;
            const ctx = this.ctx;
            const { lo, hi } = this._frame;
            const xLeft = this._secToX(Math.max(0, lo));
            const xRight = this._secToX(hi);
            ctx.fillStyle = 'rgba(34, 197, 94, 0.18)';
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.45)';
            ctx.lineWidth = 1;

            for (let i = 0; i < this._trajectory.length; i++) {
                const cur = this._trajectory[i];
                const next = this._trajectory[i + 1];
                const startSec = this._tickToSec(cur.tick);
                const endSec = next ? this._tickToSec(next.tick) : this.totalSec;
                if (endSec < lo) continue;
                if (startSec > hi) break;

                const { y0, y1 } = this._handWindowY(cur.anchor);
                if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) continue;
                const xStart = Math.max(xLeft, this._secToX(startSec));
                const xEnd = Math.min(xRight, this._secToX(endSec));
                if (xEnd <= xStart) continue;
                ctx.fillRect(xStart, y0, xEnd - xStart, y1 - y0);
                ctx.strokeRect(xStart, y0, xEnd - xStart, y1 - y0);
            }
        }

        _drawInfeasibleCurves(w) {
            if (this._trajectory.length < 2) return;
            const ctx = this.ctx;
            const { lo, hi } = this._frame;
            ctx.save();
            ctx.strokeStyle = '#f5c518';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([6, 4]);
            for (let i = 1; i < this._trajectory.length; i++) {
                const prev = this._trajectory[i - 1];
                const curr = this._trajectory[i];
                const motion = curr.motion;
                if (!motion || motion.feasible !== false) continue;
                const startSec = this._tickToSec(prev.tick);
                const endSec = this._tickToSec(curr.tick);
                if (endSec < lo) continue;
                if (startSec > hi) break;
                const y1 = this._anchorCenterY(prev.anchor);
                const y2 = this._anchorCenterY(curr.anchor);
                if (!Number.isFinite(y1) || !Number.isFinite(y2)) continue;
                const x1 = this._secToX(startSec);
                const x2 = this._secToX(endSec);
                const xMid = (x1 + x2) / 2;
                const yMid = (y1 + y2) / 2;
                const offset = Math.max(20, Math.min(60, Math.abs(y2 - y1) * 0.2));
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.quadraticCurveTo(xMid, yMid - offset, x2, y2);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        _anchorCenterY(anchor) {
            const { y0, y1 } = this._handWindowY(anchor);
            if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
            return (y0 + y1) / 2;
        }

        _drawChords() {
            this._noteHits.length = 0;
            if (!this._chords.length) return;
            const ctx = this.ctx;
            const { lo, hi } = this._frame;
            const loTick = lo * this.ticksPerSec;
            const hiTick = hi * this.ticksPerSec;

            let i = this._lowerBoundChord(loTick);
            for (; i < this._chords.length; i++) {
                const ch = this._chords[i];
                if (ch.tick > hiTick) break;
                const x = this._secToX(this._tickToSec(ch.tick));
                const notes = Array.isArray(ch.notes) ? ch.notes : [];
                const unplayableSet = ch._unplayableNotes;
                for (const n of notes) {
                    if (!Number.isFinite(n.fret)) continue;
                    const yRow = n.fret === 0
                        ? this._fretY(0) - 6
                        : (this._fretY(n.fret - 1) + this._fretY(n.fret)) / 2;
                    const isUnplayable = unplayableSet ? unplayableSet.has(n.note) : false;
                    ctx.fillStyle = isUnplayable
                        ? 'rgba(239, 68, 68, 0.55)'
                        : 'rgba(37, 99, 235, 0.85)';
                    ctx.beginPath();
                    ctx.arc(x, yRow, 4, 0, Math.PI * 2);
                    ctx.fill();
                    this._noteHits.push({
                        x, y: yRow, r: 8,
                        tick: ch.tick,
                        note: n.note,
                        string: n.string,
                        fret: n.fret
                    });
                }
            }
        }

        _drawPlayhead(h) {
            if (!Number.isFinite(this.playheadSec)) return;
            const x = this._secToX(this.playheadSec);
            const w = this.canvas.clientWidth || this.canvas.width || 0;
            if (x < -2 || x > w + 2) return;
            const ctx = this.ctx;
            ctx.save();
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            ctx.restore();
        }

        _lowerBoundChord(tick) {
            let lo = 0, hi = this._chords.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (this._chords[mid].tick < tick) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }

        // ----------------------------------------------------------------
        //  Lifecycle
        // ----------------------------------------------------------------

        destroy() {
            this._chords = [];
            this._shifts = [];
            this._trajectory = [];
            if (this.canvas?.removeEventListener) {
                if (this._wheelHandler) this.canvas.removeEventListener('wheel', this._wheelHandler, this._wheelOpts);
                if (this._clickHandler) this.canvas.removeEventListener('click', this._clickHandler);
            }
            this._wheelHandler = null;
            this._clickHandler = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.FretboardTimelineRenderer = FretboardTimelineRenderer;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FretboardTimelineRenderer;
    }
})();
