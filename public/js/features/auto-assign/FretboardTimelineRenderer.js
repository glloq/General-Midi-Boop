/**
 * @file FretboardTimelineRenderer.js
 * @description Full-length tablature & hand-position timeline.
 *
 * Layout (vertical-time):
 *   - X axis: fret index — fret 0 (nut) at the left, last fret at the
 *     right. Same fret math + left/right margins as
 *     VerticalFretboardPreview so the two widgets line up when stacked
 *     (the sticky neck on top, this timeline below it).
 *   - Y axis: time, ascending top → bottom. The playhead's row is
 *     `(playheadSec - scrollSec) * pxPerSec`. Mouse wheel pans in
 *     time, Ctrl/Cmd + wheel zooms.
 *
 * Each chord is rendered as a small dot at
 * `(fretCenterX[note.fret], secToY(chord.tick))`. The fretting hand's
 * trajectory is drawn as a translucent vertical ribbon spanning
 * `[handWindowX(anchor).x0 .. .x1]` between consecutive trajectory
 * points. A yellow dashed Bézier links two ribbon segments whose
 * `motion.feasible === false`.
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

            // Left/right margins match VerticalFretboardPreview so the
            // fret X grid is shared when the two widgets are stacked.
            this.margin = { top: 0, right: 18, bottom: 0, left: 34 };

            this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : null;
            this.onNoteClick = typeof opts.onNoteClick === 'function' ? opts.onNoteClick : null;
            this.onNoteDrag = typeof opts.onNoteDrag === 'function' ? opts.onNoteDrag : null;
            this.onViewportChange = typeof opts.onViewportChange === 'function'
                ? opts.onViewportChange : null;
            this._noteHits = [];
            // Drag state for the note-edit interaction. While set, the
            // dragged note's dot is drawn at the cursor's snapped X so
            // the operator gets immediate visual feedback.
            this._noteDrag = null;

            this._dirty = true;
            this._rafHandle = null;
            this._frame = null;

            if (this.canvas?.addEventListener) {
                this._wheelHandler = (e) => this._handleWheel(e);
                this._clickHandler = (e) => this._handleClick(e);
                this._mouseDownHandler = (e) => this._handleMouseDown(e);
                this._mouseMoveHandler = (e) => this._handleMouseMove(e);
                this._mouseUpHandler = (e) => this._handleMouseUp(e);
                this._wheelOpts = { passive: false };
                this.canvas.addEventListener('wheel', this._wheelHandler, this._wheelOpts);
                this.canvas.addEventListener('click', this._clickHandler);
                this.canvas.addEventListener('mousedown', this._mouseDownHandler);
                document.addEventListener('mousemove', this._mouseMoveHandler);
                document.addEventListener('mouseup', this._mouseUpHandler);
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
            this.onViewportChange?.(this.scrollSec, this._viewportSec());
        }

        setPxPerSec(px) {
            const next = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC,
                Number.isFinite(px) ? px : this.pxPerSec));
            if (next === this.pxPerSec) return;
            // Keep the playhead row stable when zooming.
            const oldPxPerSec = this.pxPerSec;
            const playheadPos = (this.playheadSec - this.scrollSec) * oldPxPerSec;
            this.pxPerSec = next;
            const newScroll = this.playheadSec - playheadPos / next;
            const max = Math.max(0, this.totalSec - this._viewportSec());
            this.scrollSec = Math.max(0, Math.min(max, newScroll));
            this._scheduleDraw();
            this.onViewportChange?.(this.scrollSec, this._viewportSec());
        }

        setTotalSec(totalSec) {
            this.totalSec = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
            this.setScrollSec(this.scrollSec);
        }

        // ----------------------------------------------------------------
        //  Geometry — frets on X, time on Y
        // ----------------------------------------------------------------

        _usableWidth() {
            const w = this.canvas?.clientWidth || this.canvas?.width || 0;
            return Math.max(1, w - this.margin.left - this.margin.right);
        }

        _viewportSec() {
            const h = this.canvas?.clientHeight || this.canvas?.height || 0;
            const usable = Math.max(0, h - this.margin.top - this.margin.bottom);
            return usable / Math.max(1, this.pxPerSec);
        }

        _fretX(n) {
            const totalDist = 1 - Math.pow(2, -this.numFrets / 12);
            const frac = (1 - Math.pow(2, -n / 12)) / totalDist;
            return this.margin.left + frac * this._usableWidth();
        }

        _xFromMm(mm) {
            const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            return this.margin.left + (mm / totalDistMm) * this._usableWidth();
        }

        _handWindowX(anchor) {
            const safe = Math.max(0, anchor);
            const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -safe / 12));
            const leftMm = Math.max(0, anchorMm - FINGER_BEFORE_FRET_MM);
            const x0 = this._xFromMm(leftMm);
            const rightMm = leftMm + this.handSpanMm;
            const lastFretMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
            const x1 = rightMm > lastFretMm
                ? this._fretX(this.numFrets)
                : this._xFromMm(rightMm);
            return { x0, x1 };
        }

        _secToY(sec) {
            return this.margin.top + (sec - this.scrollSec) * this.pxPerSec;
        }

        _yToSec(y) {
            return this.scrollSec + (y - this.margin.top) / this.pxPerSec;
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
            // Vertical wheel pans time; trackpad horizontal swipes ship
            // deltaX — honor it as a fallback.
            const dPx = e.deltaY || e.deltaX || 0;
            this.setScrollSec(this.scrollSec + dPx / Math.max(1, this.pxPerSec));
        }

        _handleClick(e) {
            // A drag that ended just now gets the click event too —
            // skip it so the popover doesn't open over the just-dropped
            // note. `_lastDragEndAt` is set by `_handleMouseUp`.
            if (this._lastDragEndAt && performance.now() - this._lastDragEndAt < 200) {
                this._lastDragEndAt = 0;
                return;
            }
            const rect = this.canvas?.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            const x = (e.clientX || 0) - rect.left;
            const y = (e.clientY || 0) - rect.top;
            if (this.onNoteClick) {
                const hit = this._hitTestNote(x, y);
                if (hit) {
                    this.onNoteClick(hit, { clientX: e.clientX, clientY: e.clientY });
                    return;
                }
            }
            if (!this.onSeek) return;
            const sec = Math.max(0, Math.min(this.totalSec, this._yToSec(y)));
            this.onSeek(sec);
        }

        _hitTestNote(x, y) {
            return this._noteHits.find(h => {
                const dx = x - h.x;
                const dy = y - h.y;
                return dx * dx + dy * dy <= h.r * h.r;
            });
        }

        _pointerXY(e) {
            const rect = this.canvas?.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            return {
                x: (e.clientX || 0) - rect.left,
                y: (e.clientY || 0) - rect.top
            };
        }

        /** Inverse of `_fretX` — converts a pixel X back to a (fractional)
         *  fret index. Used by the note-drag hit-tests. */
        _fretAtX(px) {
            if (!Number.isFinite(px)) return null;
            const x0 = this._fretX(0);
            const xN = this._fretX(this.numFrets);
            if (px <= x0) return 0;
            if (px >= xN) return this.numFrets;
            for (let f = 1; f <= this.numFrets; f++) {
                const a = this._fretX(f - 1);
                const b = this._fretX(f);
                if (px <= b) {
                    const t = (px - a) / Math.max(1e-6, b - a);
                    return (f - 1) + t;
                }
            }
            return this.numFrets;
        }

        _handleMouseDown(e) {
            if (!this.onNoteDrag) return;
            const { x, y } = this._pointerXY(e);
            const hit = this._hitTestNote(x, y);
            if (!hit) return;
            this._noteDrag = {
                hit,
                startX: x,
                startY: y,
                draggedX: x,
                moved: false
            };
            if (e.preventDefault) e.preventDefault();
        }

        _handleMouseMove(e) {
            if (!this._noteDrag) return;
            const { x } = this._pointerXY(e);
            const dx = x - this._noteDrag.startX;
            // Tiny jitters shouldn't open a drag — wait for ≥4 px.
            if (!this._noteDrag.moved && Math.abs(dx) < 4) return;
            this._noteDrag.moved = true;
            this._noteDrag.draggedX = x;
            this._scheduleDraw();
        }

        _handleMouseUp(e) {
            if (!this._noteDrag) return;
            const drag = this._noteDrag;
            this._noteDrag = null;
            this._scheduleDraw();
            if (!drag.moved) return;
            this._lastDragEndAt = performance.now();
            const { x } = this._pointerXY(e);
            this.onNoteDrag(drag.hit, { x, fret: this._fretAtX(x) });
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
            this._drawHandRibbon();
            this._drawInfeasibleCurves();
            this._drawChords();
            this._drawPlayhead(w);
            this._frame = null;
        }

        _drawFretGrid(w, h) {
            const ctx = this.ctx;
            ctx.strokeStyle = 'rgba(120, 120, 120, 0.18)';
            ctx.lineWidth = 1;
            for (let f = 1; f <= this.numFrets; f++) {
                const x = this._fretX(f);
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
            ctx.strokeStyle = 'rgba(60, 60, 60, 0.5)';
            ctx.lineWidth = 1.5;
            const xNut = this._fretX(0);
            ctx.beginPath();
            ctx.moveTo(xNut, 0);
            ctx.lineTo(xNut, h);
            ctx.stroke();
        }

        _drawHandRibbon() {
            if (!this._trajectory.length) return;
            const ctx = this.ctx;
            const { lo, hi } = this._frame;
            const yTop = this._secToY(Math.max(0, lo));
            const yBottom = this._secToY(hi);
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

                const { x0, x1 } = this._handWindowX(cur.anchor);
                if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) continue;
                const yStart = Math.max(yTop, this._secToY(startSec));
                const yEnd = Math.min(yBottom, this._secToY(endSec));
                if (yEnd <= yStart) continue;
                ctx.fillRect(x0, yStart, x1 - x0, yEnd - yStart);
                ctx.strokeRect(x0, yStart, x1 - x0, yEnd - yStart);
            }
        }

        _drawInfeasibleCurves() {
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
                const x1 = this._anchorCenterX(prev.anchor);
                const x2 = this._anchorCenterX(curr.anchor);
                if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;
                const y1 = this._secToY(startSec);
                const y2 = this._secToY(endSec);
                const xMid = (x1 + x2) / 2;
                const yMid = (y1 + y2) / 2;
                const offset = Math.max(20, Math.min(60, Math.abs(x2 - x1) * 0.2));
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.quadraticCurveTo(xMid - offset, yMid, x2, y2);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        _anchorCenterX(anchor) {
            const { x0, x1 } = this._handWindowX(anchor);
            if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
            return (x0 + x1) / 2;
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
                const y = this._secToY(this._tickToSec(ch.tick));
                const notes = Array.isArray(ch.notes) ? ch.notes : [];
                const unplayableSet = ch._unplayableNotes;
                for (const n of notes) {
                    if (!Number.isFinite(n.fret)) continue;
                    const xColDefault = n.fret === 0
                        ? this._fretX(0) - 6
                        : (this._fretX(n.fret - 1) + this._fretX(n.fret)) / 2;
                    // While dragged, this note follows the cursor so the
                    // operator gets immediate visual feedback before the
                    // engine rebuild lands.
                    const isDragged = this._noteDrag?.moved
                        && this._noteDrag.hit.tick === ch.tick
                        && this._noteDrag.hit.note === n.note;
                    const xCol = isDragged ? this._noteDrag.draggedX : xColDefault;
                    const isUnplayable = unplayableSet ? unplayableSet.has(n.note) : false;
                    // Anchor segment: any non-open held note longer than
                    // ANCHOR_MIN_DURATION_MS pins its finger on the
                    // string. Draw a vertical segment along the played
                    // fret for the duration of the note so the operator
                    // sees which fingers stay anchored across hand
                    // shifts.
                    const ANCHOR_MIN_DURATION_MS = 60;
                    if (Number.isFinite(n.duration)
                            && this.ticksPerSec > 0
                            && (n.duration / this.ticksPerSec) * 1000 >= ANCHOR_MIN_DURATION_MS
                            && n.fret > 0
                            && !isDragged
                            && !isUnplayable) {
                        const yEnd = this._secToY(this._tickToSec(ch.tick + n.duration));
                        ctx.save();
                        ctx.strokeStyle = 'rgba(37, 99, 235, 0.55)';
                        ctx.lineWidth = 3;
                        ctx.lineCap = 'round';
                        ctx.beginPath();
                        ctx.moveTo(xColDefault, y + 4);
                        ctx.lineTo(xColDefault, Math.max(y + 4, yEnd - 2));
                        ctx.stroke();
                        ctx.restore();
                    }
                    ctx.fillStyle = isDragged
                        ? 'rgba(245, 158, 11, 0.95)'
                        : (isUnplayable
                            ? 'rgba(239, 68, 68, 0.55)'
                            : 'rgba(37, 99, 235, 0.85)');
                    ctx.beginPath();
                    ctx.arc(xCol, y, isDragged ? 6 : 4, 0, Math.PI * 2);
                    ctx.fill();
                    this._noteHits.push({
                        x: xColDefault, y, r: 8,
                        tick: ch.tick,
                        note: n.note,
                        string: n.string,
                        fret: n.fret
                    });
                }
            }
        }

        _drawPlayhead(w) {
            if (!Number.isFinite(this.playheadSec)) return;
            const y = this._secToY(this.playheadSec);
            const h = this.canvas.clientHeight || this.canvas.height || 0;
            if (y < -2 || y > h + 2) return;
            const ctx = this.ctx;
            ctx.save();
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
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
            if (this._rafHandle != null) {
                cancelAnimationFrame(this._rafHandle);
                this._rafHandle = null;
            }
            this._chords = [];
            this._shifts = [];
            this._trajectory = [];
            this._noteDrag = null;
            if (this.canvas?.removeEventListener) {
                if (this._wheelHandler) this.canvas.removeEventListener('wheel', this._wheelHandler, this._wheelOpts);
                if (this._clickHandler) this.canvas.removeEventListener('click', this._clickHandler);
                if (this._mouseDownHandler) this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
            }
            if (this._mouseMoveHandler) document.removeEventListener('mousemove', this._mouseMoveHandler);
            if (this._mouseUpHandler) document.removeEventListener('mouseup', this._mouseUpHandler);
            this._wheelHandler = null;
            this._clickHandler = null;
            this._mouseDownHandler = null;
            this._mouseMoveHandler = null;
            this._mouseUpHandler = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.FretboardTimelineRenderer = FretboardTimelineRenderer;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FretboardTimelineRenderer;
    }
})();
