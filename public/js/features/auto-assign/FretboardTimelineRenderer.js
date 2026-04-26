/**
 * @file FretboardTimelineRenderer.js
 * @description Full-length tablature & hand-position timeline.
 *
 * Layout:
 *   - X axis: fret index (0 = nut, numFrets at the right). Same
 *     geometric spacing as `FretboardHandPreview` so the live aperçu
 *     above the timeline lines up with the columns below.
 *   - Y axis: time, descending (now at the top of the viewport,
 *     future below). Scroll wheel pans, Ctrl/Cmd + wheel zooms.
 *
 * Each chord is rendered as a row of small dots at
 * `(fretCenter[note.fret], secToY(chord.tick))`. The fretting hand's
 * trajectory is drawn as a translucent vertical ribbon spanning
 * `[handWindowX(anchor).x0 .. .x1]` between consecutive trajectory
 * points (with the warm yellow speed-warning curve carried over from
 * `FretboardHandPreview` PR2).
 *
 * Virtualization: only chords whose tick falls inside the viewport
 * (with a small margin) are drawn. Cost stays bounded even on
 * multi-thousand-chord tracks.
 *
 * Public API:
 *   const tr = new FretboardTimelineRenderer(canvas, {
 *     tuning, numFrets, scaleLengthMm?, handSpanMm?, handSpanFrets?,
 *     ticksPerSec, totalSec
 *   });
 *   tr.setTimeline(timelineEvents);     // [{type, tick, ...}] from engine
 *   tr.setTrajectory(trajectoryPoints); // fretting hand only
 *   tr.setPlayhead(currentSec);         // drive the now-line
 *   tr.setScrollSec(sec);               // pan
 *   tr.setPxPerSec(px);                 // zoom
 *   tr.draw();
 *   tr.destroy();
 */
(function() {
    'use strict';

    // Match FretboardHandPreview / FretboardLookaheadStrip so columns line up.
    const FINGER_BEFORE_FRET_MM = 10;
    const DEFAULT_PX_PER_SEC = 80;
    const MIN_PX_PER_SEC = 20;
    const MAX_PX_PER_SEC = 400;
    const VIEWPORT_MARGIN_SEC = 1; // extra render slack above/below viewport

    function _hex(c) { return `#${c.toString(16).padStart(6, '0')}`; }

    class FretboardTimelineRenderer {
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

            this.ticksPerSec = Number.isFinite(opts.ticksPerSec) && opts.ticksPerSec > 0
                ? opts.ticksPerSec : 480;
            this.totalSec = Number.isFinite(opts.totalSec) && opts.totalSec > 0
                ? opts.totalSec : 0;

            // Pre-indexed chord/shift events by ascending tick. Updated
            // via setTimeline so virtualised draws can binary-search
            // the visible window in O(log n).
            this._chords = [];
            this._shifts = [];
            this._trajectory = [];

            this.pxPerSec = Number.isFinite(opts.pxPerSec) && opts.pxPerSec > 0
                ? opts.pxPerSec : DEFAULT_PX_PER_SEC;
            this.scrollSec = 0;
            this.playheadSec = 0;

            // Match FretboardHandPreview margins so columns align.
            this.margin = { top: 0, right: 56, bottom: 0, left: 56 };

            this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : null;
            this.onNoteClick = typeof opts.onNoteClick === 'function' ? opts.onNoteClick : null;
            // Per-note hit-zones rebuilt on each draw so onNoteClick can
            // identify the (chord, note) under the cursor without
            // re-running geometry from scratch.
            this._noteHits = [];

            this._dirty = true;
            this._rafHandle = null;

            if (this.canvas && typeof this.canvas.addEventListener === 'function') {
                this._wheelHandler = (e) => this._handleWheel(e);
                this._clickHandler = (e) => this._handleClick(e);
                this.canvas.addEventListener('wheel', this._wheelHandler, { passive: false });
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
            this.playheadSec = Number.isFinite(currentSec) ? Math.max(0, currentSec) : 0;
            this._scheduleDraw();
        }

        setScrollSec(sec) {
            const max = Math.max(0, this.totalSec - this._viewportSec());
            this.scrollSec = Math.max(0, Math.min(max, Number.isFinite(sec) ? sec : 0));
            this._scheduleDraw();
        }

        setPxPerSec(px) {
            const next = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC,
                Number.isFinite(px) ? px : this.pxPerSec));
            if (next === this.pxPerSec) return;
            // Keep the playhead row stable when zooming (anchor the
            // visible center on the playhead if it's on screen).
            const oldPxPerSec = this.pxPerSec;
            const playheadY = (this.playheadSec - this.scrollSec) * oldPxPerSec;
            this.pxPerSec = next;
            const newScroll = this.playheadSec - playheadY / next;
            const max = Math.max(0, this.totalSec - this._viewportSec());
            this.scrollSec = Math.max(0, Math.min(max, newScroll));
            this._scheduleDraw();
        }

        setTotalSec(totalSec) {
            this.totalSec = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
            this.setScrollSec(this.scrollSec); // re-clamp
        }

        // ----------------------------------------------------------------
        //  Geometry
        // ----------------------------------------------------------------

        _usableWidth() {
            const w = this.canvas?.clientWidth || this.canvas?.width || 0;
            return Math.max(0, w - this.margin.left - this.margin.right);
        }

        _viewportSec() {
            const h = this.canvas?.clientHeight || this.canvas?.height || 0;
            const usable = Math.max(0, h - this.margin.top - this.margin.bottom);
            return usable / Math.max(1, this.pxPerSec);
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
            return this.margin.left + (mm / totalDistMm) * this._usableWidth();
        }

        _handWindowX(anchor) {
            const safe = Math.max(0, anchor);
            let x0, x1;
            if (this.scaleLengthMm && this.handSpanMm) {
                const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -safe / 12));
                const leftMm = Math.max(0, anchorMm - FINGER_BEFORE_FRET_MM);
                x0 = this._xFromMm(leftMm);
                const rightMm = leftMm + this.handSpanMm;
                const lastFretMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
                x1 = rightMm > lastFretMm
                    ? this._fretX(this.numFrets)
                    : this._xFromMm(rightMm);
            } else {
                x0 = this._fretX(safe);
                x1 = this._fretX(Math.min(this.numFrets, safe + this.handSpanFrets));
            }
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
            if (!e) return;
            if (e.preventDefault) e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                // Zoom: deltaY > 0 → zoom out, deltaY < 0 → zoom in.
                const factor = Math.pow(1.0015, -(e.deltaY || 0));
                this.setPxPerSec(this.pxPerSec * factor);
                return;
            }
            // Pan: convert the deltaY pixels into seconds at the current zoom.
            const dySec = (e.deltaY || 0) / Math.max(1, this.pxPerSec);
            this.setScrollSec(this.scrollSec + dySec);
        }

        _handleClick(e) {
            const rect = this.canvas?.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            const x = (e.clientX || 0) - rect.left;
            const y = (e.clientY || 0) - rect.top;
            // Hit-test note dots first — clicking on a note opens the
            // string-alternative menu; clicking elsewhere just seeks.
            if (this.onNoteClick) {
                for (const hit of this._noteHits) {
                    const dx = x - hit.x;
                    const dy = y - hit.y;
                    if (dx * dx + dy * dy <= hit.r * hit.r) {
                        try { this.onNoteClick(hit, { clientX: e.clientX, clientY: e.clientY }); }
                        catch (err) { console.warn('[FretboardTimelineRenderer] onNoteClick failed:', err); }
                        return;
                    }
                }
            }
            if (!this.onSeek) return;
            const sec = Math.max(0, Math.min(this.totalSec, this._yToSec(y)));
            try { this.onSeek(sec); } catch (err) {
                console.warn('[FretboardTimelineRenderer] onSeek failed:', err);
            }
        }

        // ----------------------------------------------------------------
        //  Render scheduling
        // ----------------------------------------------------------------

        _scheduleDraw() {
            this._dirty = true;
            if (this._rafHandle != null) return;
            const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
                ? window.requestAnimationFrame.bind(window)
                : (cb) => setTimeout(cb, 16);
            this._rafHandle = raf(() => {
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

            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            if (this.canvas.width !== Math.round(w * dpr)
                    || this.canvas.height !== Math.round(h * dpr)) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
                this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            const ctx = this.ctx;
            ctx.fillStyle = '#f5f7fb';
            ctx.fillRect(0, 0, w, h);

            this._drawFretGrid(w, h);
            this._drawHandRibbon();
            this._drawInfeasibleCurves();
            this._drawChords();
            this._drawPlayhead(w);
        }

        _drawFretGrid(w, h) {
            const ctx = this.ctx;
            // Faint vertical lines for each fret (skip 0 = nut, drawn heavier).
            ctx.strokeStyle = 'rgba(120, 120, 120, 0.18)';
            ctx.lineWidth = 1;
            for (let f = 1; f <= this.numFrets; f++) {
                const x = this._fretX(f);
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
            // Nut line (slightly thicker)
            ctx.strokeStyle = 'rgba(60, 60, 60, 0.5)';
            ctx.lineWidth = 1.5;
            const xNut = this._fretX(0);
            ctx.beginPath();
            ctx.moveTo(xNut, 0);
            ctx.lineTo(xNut, h);
            ctx.stroke();
        }

        /** Translucent vertical ribbon following the fretting hand
         *  anchor over time. Only the trajectory points whose
         *  [tick, releaseTick] interval intersects the viewport are
         *  rendered (virtualisation). */
        _drawHandRibbon() {
            if (!this._trajectory.length) return;
            const ctx = this.ctx;
            const yTop = this._secToY(Math.max(0, this.scrollSec - VIEWPORT_MARGIN_SEC));
            const yBot = this._secToY(this.scrollSec + this._viewportSec() + VIEWPORT_MARGIN_SEC);
            ctx.fillStyle = 'rgba(34, 197, 94, 0.18)';
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.45)';
            ctx.lineWidth = 1;

            for (let i = 0; i < this._trajectory.length; i++) {
                const cur = this._trajectory[i];
                const next = this._trajectory[i + 1];
                const startSec = this._tickToSec(cur.tick);
                const endSec = next ? this._tickToSec(next.tick) : this.totalSec;
                if (endSec < this.scrollSec - VIEWPORT_MARGIN_SEC) continue;
                if (startSec > this.scrollSec + this._viewportSec() + VIEWPORT_MARGIN_SEC) break;

                const { x0, x1 } = this._handWindowX(cur.anchor);
                if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) continue;
                const yStart = Math.max(yTop, this._secToY(startSec));
                const yEnd = Math.min(yBot, this._secToY(endSec));
                if (yEnd <= yStart) continue;
                ctx.fillRect(x0, yStart, x1 - x0, yEnd - yStart);
                ctx.strokeRect(x0, yStart, x1 - x0, yEnd - yStart);
            }
        }

        /** Yellow dashed Bézier between two consecutive ribbon segments
         *  whose `motion.feasible === false`. Mirrors PR2's behaviour
         *  on the static fretboard. */
        _drawInfeasibleCurves() {
            if (this._trajectory.length < 2) return;
            const ctx = this.ctx;
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
                if (endSec < this.scrollSec - VIEWPORT_MARGIN_SEC) continue;
                if (startSec > this.scrollSec + this._viewportSec() + VIEWPORT_MARGIN_SEC) break;
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
                ctx.quadraticCurveTo(xMid + offset, yMid, x2, y2);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        _anchorCenterX(anchor) {
            const bracket = this._handWindowX(anchor);
            if (!bracket || !Number.isFinite(bracket.x0) || !Number.isFinite(bracket.x1)) {
                return null;
            }
            return (bracket.x0 + bracket.x1) / 2;
        }

        _drawChords() {
            this._noteHits = [];
            if (!this._chords.length) return;
            const ctx = this.ctx;
            const lo = this.scrollSec - VIEWPORT_MARGIN_SEC;
            const hi = this.scrollSec + this._viewportSec() + VIEWPORT_MARGIN_SEC;
            const loTick = lo * this.ticksPerSec;
            const hiTick = hi * this.ticksPerSec;

            // Binary-search the first chord with tick >= loTick.
            let i = this._lowerBoundChord(loTick);
            for (; i < this._chords.length; i++) {
                const ch = this._chords[i];
                if (ch.tick > hiTick) break;
                const y = this._secToY(this._tickToSec(ch.tick));
                const notes = Array.isArray(ch.notes) ? ch.notes : [];
                const unplayable = Array.isArray(ch.unplayable)
                    ? new Set(ch.unplayable
                        .filter(u => Number.isFinite(u.note))
                        .map(u => u.note)) : new Set();
                for (const n of notes) {
                    if (!Number.isFinite(n.fret)) continue;
                    const xCol = n.fret === 0
                        ? this._fretX(0) - 6
                        : (this._fretX(n.fret - 1) + this._fretX(n.fret)) / 2;
                    const isUnplayable = unplayable.has(n.note);
                    ctx.fillStyle = isUnplayable
                        ? 'rgba(239, 68, 68, 0.55)'
                        : 'rgba(37, 99, 235, 0.85)';
                    ctx.beginPath();
                    ctx.arc(xCol, y, 4, 0, Math.PI * 2);
                    ctx.fill();
                    // Record a hit-zone for onNoteClick (PR6). 8 px is
                    // generous enough to give the operator a usable
                    // click target even when zoomed out.
                    this._noteHits.push({
                        x: xCol, y, r: 8,
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
            this._chords = [];
            this._shifts = [];
            this._trajectory = [];
            if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
                if (this._wheelHandler) this.canvas.removeEventListener('wheel', this._wheelHandler);
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
