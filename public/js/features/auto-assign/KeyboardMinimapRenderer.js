/**
 * @file KeyboardMinimapRenderer.js
 * @description Stand-alone canvas widget for the file-level minimap
 * shown above the piano-roll in the keyboard hand-position editor.
 *
 * The minimap renders the WHOLE file at once: notes as faint dots,
 * each hand's position trajectory as a translucent stripe, problem
 * markers on top, the lookahead viewport rectangle (= the slice
 * currently shown by the piano-roll above) and the playhead line.
 *
 * The widget owns its canvas + scrub interaction, but no application
 * data. The editor pushes inputs through setters and bridges scrub
 * gestures back through the `onSeek(sec)` callback.
 *
 *     onSeek(sec)                            // mousedown + drag scrub
 *     getDisplayedAnchor(handId) → number    // override-only fallback
 *
 * The optional `getDisplayedAnchor` callback lets the override-only
 * fallback (used before the simulator runs the first time) start
 * its trajectory at the live displayed anchor instead of the static
 * `hand.anchor`. Without it the trajectory still renders but the
 * very first sample is whatever the simulator (or hand seed) said.
 *
 * Public API:
 *
 *     const m = new KeyboardMinimapRenderer(canvas, host, {
 *         ticksPerSec, totalSec,
 *         bandFillAlpha: 0.18,
 *         onSeek,
 *         getDisplayedAnchor
 *     });
 *     m.setNotes(notes);
 *     m.setHands([{ id, span, color }, …]);
 *     m.setHandsTimeline(simulationTimelineMap);
 *     m.setOverrideAnchors([{ tick, handId, anchor }, …]); // hand_anchors[]
 *     m.setProblems([{ sec, kind: 'chord' | 'speed' }, …]);
 *     m.setRange({ lo, hi });
 *     m.setPlayhead(sec);
 *     m.setLookahead(sec);
 *     m.draw();
 *     m.destroy();
 */
(function() {
    'use strict';

    const _BAND_FILL_CACHE = new Map();
    function _bandFill(hex, alpha) {
        const key = `${hex}|${alpha}`;
        let v = _BAND_FILL_CACHE.get(key);
        if (v) return v;
        if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') {
            v = `rgba(107,114,128,${alpha})`;
        } else {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            v = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        _BAND_FILL_CACHE.set(key, v);
        return v;
    }

    class KeyboardMinimapRenderer {
        /**
         * @param {HTMLCanvasElement} canvas
         * @param {HTMLElement} host
         * @param {Object} [opts]
         */
        constructor(canvas, host, opts = {}) {
            this.canvas = canvas;
            this.host = host;
            this.ticksPerSec = Number.isFinite(opts.ticksPerSec) && opts.ticksPerSec > 0
                ? opts.ticksPerSec : 480;
            this.totalSec = Number.isFinite(opts.totalSec) && opts.totalSec > 0
                ? opts.totalSec : 0;
            this.bandFillAlpha = Number.isFinite(opts.bandFillAlpha)
                ? opts.bandFillAlpha : 0.18;

            this.onSeek = opts.onSeek || (() => {});
            this.getDisplayedAnchor = typeof opts.getDisplayedAnchor === 'function'
                ? opts.getDisplayedAnchor : null;

            this._notes = [];
            this._hands = [];
            this._handsTimeline = new Map();
            this._overrideAnchors = [];
            this._problems = [];
            this._range = { lo: 0, hi: 127 };
            this._playheadSec = 0;
            this._lookaheadSec = 4;

            this._scrubMove = null;
            this._scrubUp = null;

            this._mouseDownHandler = (e) => this._onMouseDown(e);
            if (this.canvas && this.canvas.addEventListener) {
                this.canvas.addEventListener('mousedown', this._mouseDownHandler);
            }
        }

        // -----------------------------------------------------------------
        //  Public setters
        // -----------------------------------------------------------------

        setNotes(notes) {
            this._notes = Array.isArray(notes) ? notes : [];
        }

        /** `[{ id, span, color }, …]`. Trajectory rendering needs
         *  span (for the band's pitch height) and color (for the
         *  translucent fill). */
        setHands(hands) {
            this._hands = Array.isArray(hands)
                ? hands.filter(h => h && h.id
                    && Number.isFinite(h.span)
                    && typeof h.color === 'string')
                : [];
        }

        setHandsTimeline(timeline) {
            this._handsTimeline = (timeline instanceof Map) ? timeline : new Map();
        }

        /** `hand_anchors` overrides — used as a fallback when the
         *  simulator hasn't run yet so the minimap still shows the
         *  user-pinned positions. Each entry: `{ tick, handId, anchor }`. */
        setOverrideAnchors(list) {
            this._overrideAnchors = Array.isArray(list) ? list : [];
        }

        setProblems(list) {
            this._problems = Array.isArray(list) ? list : [];
        }

        setRange(extent) {
            if (extent && Number.isFinite(extent.lo) && Number.isFinite(extent.hi)
                    && extent.hi > extent.lo) {
                this._range = { lo: extent.lo, hi: extent.hi };
            }
        }

        setPlayhead(sec) {
            if (Number.isFinite(sec) && sec >= 0) this._playheadSec = sec;
        }

        setLookahead(sec) {
            if (Number.isFinite(sec) && sec > 0) this._lookaheadSec = sec;
        }

        setTotalSec(sec) {
            if (Number.isFinite(sec) && sec >= 0) this.totalSec = sec;
        }

        // -----------------------------------------------------------------
        //  Render
        // -----------------------------------------------------------------

        draw() {
            const c = this.canvas;
            const host = this.host;
            if (!c || !host) return;
            const W = host.clientWidth;
            const H = host.clientHeight;
            if (W <= 0 || H <= 0) return;

            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            const wantW = Math.round(W * dpr);
            const wantH = Math.round(H * dpr);
            if (c.width !== wantW || c.height !== wantH) {
                c.width = wantW;
                c.height = wantH;
                c.style.width = W + 'px';
                c.style.height = H + 'px';
            }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(0, 0, W, H);
            if (!this.totalSec) return;

            const ext = this._range;
            const pitchRange = Math.max(1, ext.hi - ext.lo);
            const xPerSec = W / this.totalSec;

            // Note dots.
            ctx.fillStyle = 'rgba(148,163,184,0.55)';
            for (const n of this._notes) {
                const sec = n.tick / this.ticksPerSec;
                const x = sec * xPerSec;
                const y = H - ((n.note - ext.lo) / pitchRange) * H;
                const w = Math.max(1, xPerSec * (n.duration || 0) / this.ticksPerSec);
                ctx.fillRect(x, y - 0.5, w, 1.5);
            }

            // Hand trajectories.
            const yOfPitch = (p) => H - ((p - ext.lo) / pitchRange) * H;
            for (const hand of this._hands) {
                const samples = this._samplesFor(hand);
                if (samples.length < 2) continue;
                const fill = _bandFill(hand.color, this.bandFillAlpha);
                this._drawTrajectoryBands(ctx, samples, hand, xPerSec, yOfPitch, fill);
                this._drawTrajectoryCenterline(ctx, samples, hand, xPerSec, yOfPitch);
            }

            // Problem markers — drawn before the viewport rectangle
            // so its translucent fill desaturates them slightly when
            // they fall inside the current view (still readable).
            for (const p of this._problems) {
                const x = p.sec * xPerSec;
                ctx.fillStyle = p.kind === 'speed' ? '#f59e0b' : '#dc2626';
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x - 3, 6);
                ctx.lineTo(x + 3, 6);
                ctx.closePath();
                ctx.fill();
            }

            // Lookahead viewport.
            const vpX = this._playheadSec * xPerSec;
            const vpW = Math.max(2, this._lookaheadSec * xPerSec);
            ctx.fillStyle = 'rgba(248,250,252,0.08)';
            ctx.fillRect(vpX, 0, vpW, H);
            ctx.strokeStyle = 'rgba(248,250,252,0.45)';
            ctx.lineWidth = 1;
            ctx.strokeRect(vpX + 0.5, 0.5, vpW - 1, H - 1);

            // Playhead line.
            ctx.strokeStyle = 'rgba(248,113,113,0.95)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(vpX + 0.5, 0);
            ctx.lineTo(vpX + 0.5, H);
            ctx.stroke();
        }

        destroy() {
            if (this.canvas && this.canvas.removeEventListener) {
                this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
            }
            this._endScrub();
            this._notes = [];
            this._hands = [];
            this._handsTimeline = new Map();
            this._overrideAnchors = [];
            this._problems = [];
        }

        // -----------------------------------------------------------------
        //  Trajectory rendering helpers
        // -----------------------------------------------------------------

        /** Stable rectangles + slide parallelograms for one hand. */
        _drawTrajectoryBands(ctx, samples, hand, xPerSec, yOfPitch, fill) {
            const infeasibleFill = 'rgba(220, 38, 38, 0.35)';
            for (let i = 0; i < samples.length - 1; i++) {
                const cur = samples[i];
                const next = samples[i + 1];
                const stableEndSec = Number.isFinite(next.fromSec) ? next.fromSec : next.sec;
                if (stableEndSec > cur.sec) {
                    const x0 = cur.sec * xPerSec;
                    const x1 = stableEndSec * xPerSec;
                    const yTop = yOfPitch(cur.anchor + hand.span);
                    const yBot = yOfPitch(cur.anchor);
                    ctx.fillStyle = fill;
                    ctx.fillRect(x0, yTop, Math.max(1, x1 - x0), yBot - yTop);
                }
                if (Number.isFinite(next.fromSec) && Number.isFinite(next.fromAnchor)
                        && next.fromSec < next.sec) {
                    const xA = next.fromSec * xPerSec;
                    const xB = next.sec * xPerSec;
                    const yA1 = yOfPitch(next.fromAnchor + hand.span);
                    const yA2 = yOfPitch(next.fromAnchor);
                    const yB1 = yOfPitch(next.anchor + hand.span);
                    const yB2 = yOfPitch(next.anchor);
                    ctx.fillStyle = next.feasible === false ? infeasibleFill : fill;
                    ctx.beginPath();
                    ctx.moveTo(xA, yA1);
                    ctx.lineTo(xB, yB1);
                    ctx.lineTo(xB, yB2);
                    ctx.lineTo(xA, yA2);
                    ctx.closePath();
                    ctx.fill();
                    ctx.save();
                    if (next.feasible === false) {
                        ctx.strokeStyle = '#dc2626';
                        ctx.setLineDash([3, 2]);
                        ctx.lineWidth = 1;
                    } else {
                        ctx.strokeStyle = hand.color;
                        ctx.lineWidth = 0.75;
                    }
                    ctx.beginPath();
                    ctx.moveTo(xA, yA1);
                    ctx.lineTo(xB, yB1);
                    ctx.lineTo(xB, yB2);
                    ctx.lineTo(xA, yA2);
                    ctx.closePath();
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }

        /** Centerline through the band's anchor — gives the trajectory
         *  visual continuity at a glance. */
        _drawTrajectoryCenterline(ctx, samples, hand, xPerSec, yOfPitch) {
            ctx.strokeStyle = hand.color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
                const s = samples[i];
                if (Number.isFinite(s.fromSec) && Number.isFinite(s.fromAnchor)) {
                    ctx.lineTo(s.fromSec * xPerSec, yOfPitch(s.fromAnchor + hand.span / 2));
                }
                const x = s.sec * xPerSec;
                const y = yOfPitch(s.anchor + hand.span / 2);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        /** Pull the per-hand sample list from the simulator timeline
         *  when available, falling back to the override-derived list
         *  before the simulator runs the first time. Same shape in
         *  both cases so the renderer doesn't branch. */
        _samplesFor(hand) {
            const series = this._handsTimeline.get(hand.id);
            if (Array.isArray(series) && series.length > 0) {
                const out = [];
                const first = series[0];
                const seedAnchor = Number.isFinite(first.fromAnchor)
                    ? first.fromAnchor : first.anchor;
                out.push({ sec: 0, anchor: seedAnchor });
                for (const s of series) out.push(s);
                if (out[out.length - 1].sec < this.totalSec) {
                    out.push({ sec: this.totalSec, anchor: out[out.length - 1].anchor });
                }
                return out;
            }
            return this._overrideOnlySamplesFor(hand);
        }

        /** Build a sorted `[{sec, anchor}]` list from the
         *  `hand_anchors` overrides (latest-wins per tick). The seed
         *  uses the editor's displayed anchor when available so the
         *  trajectory visibly meets the live band. */
        _overrideOnlySamplesFor(hand) {
            const list = this._overrideAnchors
                .filter(a => a && a.handId === hand.id
                    && Number.isFinite(a.tick) && Number.isFinite(a.anchor))
                .sort((a, b) => a.tick - b.tick);
            let seed = NaN;
            if (this.getDisplayedAnchor) {
                const v = this.getDisplayedAnchor(hand.id);
                if (Number.isFinite(v)) seed = v;
            }
            if (!Number.isFinite(seed)) seed = list.length ? list[0].anchor : NaN;
            if (!Number.isFinite(seed)) return [];
            const out = [{ sec: 0, anchor: seed }];
            for (const a of list) {
                out.push({ sec: a.tick / this.ticksPerSec, anchor: a.anchor });
            }
            const tail = list.length ? list[list.length - 1].anchor : seed;
            out.push({ sec: this.totalSec, anchor: tail });
            return out;
        }

        // -----------------------------------------------------------------
        //  Scrub interaction
        // -----------------------------------------------------------------

        _onMouseDown(e) {
            if (e.button !== 0) return;
            e.preventDefault();
            this._scrubFromEvent(e);
            const onMove = (ev) => this._scrubFromEvent(ev);
            const onUp = () => this._endScrub();
            this._scrubMove = onMove;
            this._scrubUp = onUp;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        _scrubFromEvent(e) {
            if (!this.totalSec) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            const sec = (x / rect.width) * this.totalSec;
            this.onSeek(Math.max(0, Math.min(this.totalSec, sec)));
        }

        _endScrub() {
            if (this._scrubMove) {
                document.removeEventListener('mousemove', this._scrubMove);
                this._scrubMove = null;
            }
            if (this._scrubUp) {
                document.removeEventListener('mouseup', this._scrubUp);
                this._scrubUp = null;
            }
        }
    }

    if (typeof window !== 'undefined') {
        window.KeyboardMinimapRenderer = KeyboardMinimapRenderer;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { KeyboardMinimapRenderer };
    }
})();
