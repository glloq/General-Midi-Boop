/**
 * @file HandsLookaheadStrip.js
 * @description Vertical "Synthesia-style" piano-roll showing the
 * next `windowSeconds` of upcoming notes during a HandsPreviewPanel
 * simulation. Keyboard families only — string instruments use the
 * fretboard (Feature E spec), so this component isn't mounted for
 * them.
 *
 * Visual:
 *   - x = pitch, aligned with the KeyboardPreview underneath. Each
 *     note renders directly ABOVE the key it will play.
 *   - y = time. Bottom of canvas = NOW (the moment the note hits
 *     the key); top of canvas = `windowSeconds` ahead.
 *   - As the simulation advances, notes fall toward the keyboard.
 *
 * The strip MUST share the same `rangeMin`/`rangeMax` as the
 * KeyboardPreview below it; HandsPreviewPanel passes them through
 * so both widgets agree on the white-key-index → x mapping.
 *
 * Public API:
 *   const strip = new HandsLookaheadStrip(canvas, {
 *     notes,            // [{tick, note, duration?, channel?}]
 *     ticksPerSecond,   // (ticksPerBeat * bpm) / 60
 *     rangeMin, rangeMax,
 *     windowSeconds: 4
 *   });
 *   strip.setCurrentTime(currentSec);
 *   strip.setRange(min, max);
 *   strip.setUnplayableNotes([{note} | midi]);
 *   strip.destroy();
 */
(function() {
    'use strict';

    const DEFAULT_WINDOW_SECONDS = 4;
    const BLACK_OFFSETS = new Set([1, 3, 6, 8, 10]);

    function isBlackKey(midi) {
        return BLACK_OFFSETS.has(((midi % 12) + 12) % 12);
    }

    function whiteKeyCount(rangeMin, rangeMax) {
        let n = 0;
        for (let m = rangeMin; m <= rangeMax; m++) if (!isBlackKey(m)) n++;
        return n;
    }

    /** Convert a #RRGGBB hex to rgba() with the given alpha. */
    function _alpha(hex, alpha) {
        if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    class HandsLookaheadStrip {
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.ctx = canvas && typeof canvas.getContext === 'function'
                ? canvas.getContext('2d') : null;

            this.notes = Array.isArray(opts.notes) ? opts.notes.slice().sort((a, b) => a.tick - b.tick) : [];
            this.ticksPerSecond = Number.isFinite(opts.ticksPerSecond) && opts.ticksPerSecond > 0
                ? opts.ticksPerSecond : 480;
            this.rangeMin = Number.isFinite(opts.rangeMin) ? opts.rangeMin : 36;
            this.rangeMax = Number.isFinite(opts.rangeMax) ? opts.rangeMax : 96;
            this.windowSeconds = Math.max(1, Math.min(10,
                Number.isFinite(opts.windowSeconds) ? opts.windowSeconds : DEFAULT_WINDOW_SECONDS));

            this.currentSec = 0;
            this.unplayableNotes = new Set();
            // Hand trajectories: array of
            //   {id, span, color, points:[{tick, anchor}, ...]}
            // The points are converted to seconds internally and drawn
            // as translucent vertical ribbons that "wave" between
            // anchors at each shift point.
            this.handTrajectories = [];

            // Pre-compute tick→sec for each note so we can binary-search by sec.
            this._noteTimes = this.notes.map(n => ({
                start: n.tick / this.ticksPerSecond,
                duration: (n.duration || 0) / this.ticksPerSecond,
                note: n.note,
                channel: n.channel
            }));

            // Geometry cache. Re-built lazily inside `_geo()` whenever
            // the canvas size or the range changes — column lookups
            // are dropped from O(N) per midi to O(1) array-indexed.
            this._geoCache = null;
            // Last paint marker so sub-pixel `setCurrentTime` updates
            // skip the heavy redraw.
            this._lastDrawSec = -Infinity;
        }

        /** @private — return a cached geometry table built once per
         *  (range, canvas-size) configuration. */
        _geo() {
            const w = (this.canvas?.clientWidth || this.canvas?.width) || 0;
            const cache = this._geoCache;
            if (cache && cache.w === w
                    && cache.rangeMin === this.rangeMin
                    && cache.rangeMax === this.rangeMax) {
                return cache;
            }
            const count = Math.max(1, whiteKeyCount(this.rangeMin, this.rangeMax));
            const ww = w / count;
            // Pre-compute white-key index + column [x, width] per MIDI
            // in [rangeMin..rangeMax]. Outside the range the entries
            // stay 0; callers should clamp their MIDI numbers.
            const whiteIdx = new Int16Array(128);
            const colX     = new Float32Array(128);
            const colW     = new Float32Array(128);
            let idx = 0;
            for (let m = this.rangeMin; m <= this.rangeMax; m++) {
                whiteIdx[m] = idx;
                if (!isBlackKey(m)) idx++;
            }
            for (let m = this.rangeMin; m <= this.rangeMax; m++) {
                if (!isBlackKey(m)) {
                    colX[m] = whiteIdx[m] * ww;
                    colW[m] = ww;
                } else {
                    colX[m] = whiteIdx[m - 1] * ww + ww * 0.65;
                    colW[m] = ww * 0.6;
                }
            }
            this._geoCache = { w, ww, rangeMin: this.rangeMin, rangeMax: this.rangeMax,
                                whiteIdx, colX, colW };
            return this._geoCache;
        }

        setCurrentTime(currentSec) {
            const next = Math.max(0, Number.isFinite(currentSec) ? currentSec : 0);
            // Skip the heavy redraw when the playhead hasn't moved by
            // at least one canvas pixel — the rAF loop drives this at
            // ~60 Hz and the strip is typically 140 px tall over a 4 s
            // window, so dt < ~30 ms is sub-pixel. Big CPU win for
            // long sustained chords where currentSec barely advances.
            const h = (this.canvas?.clientHeight || this.canvas?.height) || 1;
            const pxPerSec = h / this.windowSeconds;
            if (Math.abs(next - this._lastDrawSec) * pxPerSec < 1) {
                this.currentSec = next;
                return;
            }
            this.currentSec = next;
            this.draw();
        }

        setRange(min, max) {
            const lo = Math.max(0, Math.min(127, Number.isFinite(min) ? min : this.rangeMin));
            const hi = Math.max(0, Math.min(127, Number.isFinite(max) ? max : this.rangeMax));
            this.rangeMin = Math.min(lo, hi);
            this.rangeMax = Math.max(lo, hi);
            this._geoCache = null; // range changed → drop the column cache
            this.draw();
        }

        setWindowSeconds(seconds) {
            const s = Number.isFinite(seconds) ? seconds : DEFAULT_WINDOW_SECONDS;
            this.windowSeconds = Math.max(1, Math.min(10, s));
            this.draw();
        }

        setUnplayableNotes(notes) {
            this.unplayableNotes = new Set();
            if (Array.isArray(notes)) {
                for (const e of notes) {
                    const n = Number.isFinite(e?.note) ? e.note : (Number.isFinite(e) ? e : null);
                    if (n != null) this.unplayableNotes.add(n);
                }
            }
            this.draw();
        }

        /**
         * Replace the per-hand trajectory list. Each entry:
         *   {
         *     id, span, color,
         *     points: [{
         *       tick, anchor,
         *       prevAnchor?,    // anchor the hand came from (for transitions)
         *       releaseTick?,   // when THIS hand's notes release in the chord
         *       motion?: {      // speed-limit envelope of the shift
         *         requiredSec, availableSec, feasible
         *       }
         *     }, ...]
         *   }
         *
         * The ribbon holds the previous anchor until `releaseSec`,
         * then slides linearly to the new anchor. When `motion.feasible`
         * is false, the transition is painted in red and extended past
         * the chord tick by `(requiredSec − availableSec)` so the
         * operator sees the band "biting" into the next note.
         *
         * Pass `[]` or `null` to hide the ribbons.
         */
        setHandTrajectories(trajectories) {
            this.handTrajectories = [];
            if (!Array.isArray(trajectories)) { this.draw(); return; }
            for (const tr of trajectories) {
                if (!tr || !tr.id || !Number.isFinite(tr.span)) continue;
                const pts = Array.isArray(tr.points)
                    ? tr.points
                        .filter(p => p && Number.isFinite(p.tick) && Number.isFinite(p.anchor))
                        .map(p => {
                            const sec = p.tick / this.ticksPerSecond;
                            const releaseSec = Number.isFinite(p.releaseTick)
                                ? p.releaseTick / this.ticksPerSecond
                                : sec;
                            return {
                                sec,
                                anchor: p.anchor,
                                prevAnchor: Number.isFinite(p.prevAnchor) ? p.prevAnchor : p.anchor,
                                releaseSec,
                                motion: p.motion || { requiredSec: 0, availableSec: Infinity, feasible: true }
                            };
                        })
                        .sort((a, b) => a.sec - b.sec)
                    : [];
                this.handTrajectories.push({
                    id: tr.id,
                    span: tr.span,
                    color: tr.color || '#6b7280',
                    points: pts
                });
            }
            this.draw();
        }

        // -----------------------------------------------------------------
        //  Geometry helpers (same formulas as KeyboardPreview so the
        //  vertical alignment with the keys below is exact).
        // -----------------------------------------------------------------

        _whiteKeyWidth() {
            return this._geo().ww;
        }

        /** White-key index relative to rangeMin (0-based) for `midi`. */
        _whiteIndexForMidi(midi) {
            const g = this._geo();
            if (midi < this.rangeMin) return 0;
            if (midi > this.rangeMax) midi = this.rangeMax;
            return g.whiteIdx[midi];
        }

        /**
         * Return the [x, width] of the column above the given key.
         * White keys span a full white-width; black keys span 60%
         * of a white-width and sit on the boundary between adjacent
         * white keys — same offset as KeyboardPreview.
         */
        _columnFor(midi) {
            const g = this._geo();
            if (g.ww <= 0) return { x: 0, width: 0 };
            const m = Math.max(this.rangeMin, Math.min(this.rangeMax, midi));
            return { x: g.colX[m], width: g.colW[m] };
        }

        /** Index of the first note whose end is at or after `sec`. */
        _firstVisibleIndex(sec) {
            let lo = 0, hi = this._noteTimes.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                const t = this._noteTimes[mid];
                if ((t.start + t.duration) < sec) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }

        /** sec → y; bottom = currentSec, top = currentSec + windowSeconds. */
        _yAt(sec, h, start) {
            return h * (1 - (sec - start) / this.windowSeconds);
        }

        /**
         * Paint each hand's trajectory in three passes — the HOLD
         * background covers the WHOLE timeline so the operator can
         * read at a glance which keys each hand currently reaches:
         *
         *   1. HOLD background — for each segment, a span-wide
         *      rectangle at alpha 0.15 covers the period the hand
         *      stays steady on its anchor. Visible as a clear
         *      "playable band" running through the lookahead.
         *   2. TRANSITION sweep — between releaseSec (last per-hand
         *      note-off) and the time the hand finishes travelling,
         *      a same-alpha trapezoid sweeps from the old anchor's
         *      column to the new one. RED at alpha 0.28 when
         *      `motion.feasible === false` and extended past the
         *      chord tick to show the hand "biting" into the next
         *      note.
         *   3. ANCHOR centre stroke — a 1.5 px line at each anchor's
         *      column centre. Vertical during HOLD, diagonal during
         *      TRANSITION.
         *
         * @private
         */
        _drawHandTrajectories(w, h, start, end) {
            if (!this.handTrajectories || this.handTrajectories.length === 0) return;
            const ctx = this.ctx;
            const RED = '#ef4444';

            for (const tr of this.handTrajectories) {
                if (tr.points.length === 0) continue;

                // Build a synthetic series covering the visible window.
                let series = [];
                let lastBefore = null;
                for (const p of tr.points) {
                    if (p.sec <= start) lastBefore = p;
                    else if (p.sec <= end) series.push(p);
                    else break;
                }
                if (lastBefore) {
                    series.unshift({
                        sec: start,
                        anchor: lastBefore.anchor,
                        prevAnchor: lastBefore.prevAnchor ?? lastBefore.anchor,
                        releaseSec: Math.max(lastBefore.releaseSec ?? start, start),
                        motion: lastBefore.motion || { feasible: true, requiredSec: 0, availableSec: Infinity }
                    });
                } else if (series.length === 0) {
                    continue;
                } else {
                    series.unshift({
                        sec: start,
                        anchor: series[0].anchor,
                        prevAnchor: series[0].anchor,
                        releaseSec: start,
                        motion: { feasible: true, requiredSec: 0, availableSec: Infinity }
                    });
                }
                const last = series[series.length - 1];
                series.push({
                    sec: end,
                    anchor: last.anchor,
                    prevAnchor: last.anchor,
                    releaseSec: end,
                    motion: { feasible: true, requiredSec: 0, availableSec: Infinity }
                });

                // For every consecutive pair (a → b) compute the
                // physical motion envelope shared by all three passes:
                //   - releaseA: when this hand's chord-A notes release.
                //   - arrivalSec: when the hand reaches chord B's anchor.
                //     Feasible: releaseA + requiredSec (often EARLIER
                //       than b.sec → the hand waits at B until then).
                //     Infeasible: b.sec + (required − available) >
                //       b.sec → the ribbon overflows the next chord.
                //     No motion data: spread over the whole gap (=
                //       legacy behaviour, arrivalSec = b.sec).
                // The trapezoid + diagonal stop at arrivalSec, and an
                // EARLY-ARRIVAL hold rectangle covers
                // [arrivalSec, b.sec] at anchor B so the eye reads
                // "moves now, then waits" instead of "drags slowly
                // across the entire gap".
                const motionEnvelopes = new Array(series.length - 1);
                for (let i = 0; i + 1 < series.length; i++) {
                    const a = series[i], b = series[i + 1];
                    const releaseA = Math.max(a.sec, Math.min(a.releaseSec ?? a.sec, b.sec));
                    const motion = b.motion || { feasible: true, requiredSec: 0, availableSec: Infinity };
                    const isInfeasible = motion.feasible === false;
                    const useMotion = Number.isFinite(motion.requiredSec) && motion.requiredSec > 0;
                    let arrivalSec;
                    if (isInfeasible
                            && Number.isFinite(motion.requiredSec)
                            && Number.isFinite(motion.availableSec)) {
                        arrivalSec = b.sec + Math.max(0, motion.requiredSec - motion.availableSec);
                    } else if (useMotion && a.anchor !== b.anchor) {
                        arrivalSec = Math.min(b.sec, releaseA + motion.requiredSec);
                    } else {
                        arrivalSec = b.sec;
                    }
                    motionEnvelopes[i] = { releaseA, arrivalSec, isInfeasible };
                }

                // -------- Pass 1: HOLD backgrounds -----------------
                // (a) hold at the OLD anchor between a.sec and releaseA;
                // (b) EARLY-ARRIVAL hold at the NEW anchor between
                //     arrivalSec and b.sec when the move was fast.
                // Same alpha (0.15) for both so the band reads as a
                // continuous "playable range" running through the
                // entire lookahead.
                ctx.fillStyle = _alpha(tr.color, 0.15);
                for (let i = 0; i + 1 < series.length; i++) {
                    const a = series[i], b = series[i + 1];
                    const env = motionEnvelopes[i];
                    if (env.releaseA > a.sec + 1e-9) {
                        const yA = this._yAt(a.sec, h, start);
                        const yRel = this._yAt(env.releaseA, h, start);
                        const colA  = this._columnFor(a.anchor);
                        const colAR = this._columnFor(a.anchor + tr.span);
                        ctx.fillRect(colA.x, yRel,
                                      colAR.x + colAR.width - colA.x,
                                      yA - yRel);
                    }
                    if (!env.isInfeasible
                            && a.anchor !== b.anchor
                            && env.arrivalSec < b.sec - 1e-9) {
                        const yArr = this._yAt(env.arrivalSec, h, start);
                        const yB   = this._yAt(b.sec, h, start);
                        const colB  = this._columnFor(b.anchor);
                        const colBR = this._columnFor(b.anchor + tr.span);
                        ctx.fillRect(colB.x, yB,
                                      colBR.x + colBR.width - colB.x,
                                      yArr - yB);
                    }
                }

                // -------- Pass 2: TRANSITION sweep -----------------
                // Trapezoid from releaseA → arrivalSec (NOT b.sec when
                // the hand arrives early). Red on infeasible.
                for (let i = 0; i + 1 < series.length; i++) {
                    const a = series[i], b = series[i + 1];
                    const env = motionEnvelopes[i];
                    if (env.releaseA >= env.arrivalSec - 1e-9) continue;
                    if (a.anchor === b.anchor) continue;
                    const fillColor = env.isInfeasible ? RED : tr.color;
                    const yRelA = this._yAt(env.releaseA, h, start);
                    const yArr  = this._yAt(env.arrivalSec, h, start);
                    const colA  = this._columnFor(a.anchor);
                    const colAR = this._columnFor(a.anchor + tr.span);
                    const colB  = this._columnFor(b.anchor);
                    const colBR = this._columnFor(b.anchor + tr.span);
                    ctx.fillStyle = _alpha(fillColor, env.isInfeasible ? 0.28 : 0.18);
                    ctx.beginPath();
                    ctx.moveTo(colA.x, yRelA);
                    ctx.lineTo(colAR.x + colAR.width, yRelA);
                    ctx.lineTo(colBR.x + colBR.width, yArr);
                    ctx.lineTo(colB.x, yArr);
                    ctx.closePath();
                    ctx.fill();
                }

                // -------- Pass 3: ANCHOR centre stroke -------------
                // (a) vertical at A from yA to yRelA (HOLD A);
                // (b) diagonal from (xCenA, yRelA) to (xCenB, yArr);
                // (c) vertical at B from yArr to yB (EARLY-ARRIVAL hold).
                ctx.lineWidth = 1.5;
                for (let i = 0; i + 1 < series.length; i++) {
                    const a = series[i], b = series[i + 1];
                    const env = motionEnvelopes[i];
                    const yA   = this._yAt(a.sec, h, start);
                    const yRel = this._yAt(env.releaseA, h, start);
                    const yArr = this._yAt(env.arrivalSec, h, start);
                    const yB   = this._yAt(b.sec, h, start);
                    const colA  = this._columnFor(a.anchor);
                    const colAR = this._columnFor(a.anchor + tr.span);
                    const colB  = this._columnFor(b.anchor);
                    const colBR = this._columnFor(b.anchor + tr.span);
                    const xCenA = (colA.x + colAR.x + colAR.width) / 2;
                    const xCenB = (colB.x + colBR.x + colBR.width) / 2;

                    ctx.strokeStyle = _alpha(tr.color, 0.7);
                    if (yRel < yA - 1e-3) {
                        ctx.beginPath();
                        ctx.moveTo(xCenA, yA);
                        ctx.lineTo(xCenA, yRel);
                        ctx.stroke();
                    }
                    if (env.releaseA < env.arrivalSec - 1e-9 && a.anchor !== b.anchor) {
                        ctx.strokeStyle = _alpha(env.isInfeasible ? RED : tr.color, 0.85);
                        ctx.lineWidth = env.isInfeasible ? 2 : 1.5;
                        ctx.beginPath();
                        ctx.moveTo(xCenA, yRel);
                        ctx.lineTo(xCenB, yArr);
                        ctx.stroke();
                        ctx.lineWidth = 1.5;
                    }
                    // Early-arrival hold centerline at B.
                    if (!env.isInfeasible
                            && a.anchor !== b.anchor
                            && env.arrivalSec < b.sec - 1e-9) {
                        ctx.strokeStyle = _alpha(tr.color, 0.7);
                        ctx.beginPath();
                        ctx.moveTo(xCenB, yArr);
                        ctx.lineTo(xCenB, yB);
                        ctx.stroke();
                    }
                }
            }
        }

        // -----------------------------------------------------------------
        //  Rendering
        // -----------------------------------------------------------------

        draw() {
            if (!this.ctx || !this.canvas) return;
            const w = (this.canvas.clientWidth || this.canvas.width) || 0;
            const h = (this.canvas.clientHeight || this.canvas.height) || 0;
            if (w <= 0 || h <= 0) return;

            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
                this._geoCache = null; // canvas size changed → invalidate
            }
            const ctx = this.ctx;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            // Background.
            ctx.fillStyle = '#f9fafb';
            ctx.fillRect(0, 0, w, h);
            this._lastDrawSec = this.currentSec;

            const start = this.currentSec;
            const end = start + this.windowSeconds;

            // Hand trajectories — drawn first so the falling notes
            // (drawn last) stay perfectly readable on top.
            this._drawHandTrajectories(w, h, start, end);

            // Now line — bottom edge of the canvas (where notes meet
            // the keyboard below).
            ctx.strokeStyle = '#1d4ed8';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(0,     h - 0.5);
            ctx.lineTo(w,     h - 0.5);
            ctx.stroke();

            const i0 = this._firstVisibleIndex(start);

            for (let i = i0; i < this._noteTimes.length; i++) {
                const t = this._noteTimes[i];
                if (t.start > end) break; // sorted; nothing further is visible
                if (t.note < this.rangeMin || t.note > this.rangeMax) continue;

                const dtStart = t.start - start;
                const dtEnd = (t.start + t.duration) - start;
                // y axis: bottom = now (dt = 0), top = window end (dt = windowSeconds).
                const yStart = h * (1 - dtStart / this.windowSeconds);
                const yEnd   = h * (1 - dtEnd   / this.windowSeconds);
                const yTop    = Math.max(0, Math.min(h, yEnd));
                const yBottom = Math.max(0, Math.min(h, yStart));
                const noteH = Math.max(2, yBottom - yTop);

                const col = this._columnFor(t.note);
                const isUnplayable = this.unplayableNotes.has(t.note);
                const fill = isUnplayable ? 'rgba(220, 38, 38, 0.85)' : 'rgba(59, 130, 246, 0.75)';
                const stroke = isUnplayable ? '#b91c1c' : '#1e40af';

                ctx.fillStyle = fill;
                ctx.fillRect(col.x, yTop, Math.max(2, col.width - 1), noteH);
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 0.5;
                ctx.strokeRect(col.x + 0.5, yTop + 0.5, Math.max(1, col.width - 1.5), Math.max(1, noteH - 1));
            }
        }

        destroy() {
            this.notes = [];
            this._noteTimes = [];
            this.unplayableNotes.clear();
        }
    }

    if (typeof window !== 'undefined') {
        window.HandsLookaheadStrip = HandsLookaheadStrip;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HandsLookaheadStrip;
    }
})();
