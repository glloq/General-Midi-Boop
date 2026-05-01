/**
 * @file KeyboardRollRenderer.js
 * @description Stand-alone canvas widget for the falling-note
 * piano-roll inside the keyboard hand-position editor.
 *
 * The widget owns its own canvas + interaction state, but no
 * application data. The editor pushes everything it needs through
 * setters (`setNotes`, `setHands`, `setHandsTimeline`,
 * `setNoteAssignments`, `setUnplayable`, `setVisibleExtent`,
 * `setLookahead`, `setPlayhead`) and bridges the user gestures back
 * through callbacks set in the constructor:
 *
 *     onNoteClick(note, evt)              // single click within the threshold
 *     onBandDragStart(handId)             // drag confirmed (>3 px move)
 *     onBandDragMove(handId, anchor)      // live, on every move
 *     onBandDragEnd(handId)               // mouseup after a real drag
 *     onSeek(sec)                         // empty-area pan + wheel scrub
 *     onZoom(factor)                      // ctrl+wheel
 *     getAnchorAt(handId, sec) → number   // hand-band hit-test lookup
 *     getDisplayedAnchor(handId) → number // first lane-sample anchor
 *
 * The renderer never reads the modal or the state directly. The two
 * `getAnchorAt` / `getDisplayedAnchor` callbacks let it ask for the
 * one piece of data it cannot reconstruct from its own setters: the
 * animated anchor at the current playhead and the simulator-target
 * anchor at an arbitrary future time. Both are O(1) on the editor's
 * side.
 *
 * Coordinate system: top of the roll is the future, bottom is the
 * playhead. `[startSec = playhead, endSec = playhead + lookahead]`
 * maps to `[H, 0]`. X uses uniform `pxPerPitch` based on the visible
 * MIDI extent.
 *
 * Drag-vs-click is disambiguated by a 3 px threshold. Mouseup before
 * the threshold opens the deferred note popover via `onNoteClick`;
 * past the threshold the popover is cancelled and the corresponding
 * `onBandDragEnd` / `onSeek` is fired instead.
 *
 * Public API:
 *
 *     const r = new KeyboardRollRenderer(canvas, host, {
 *         ticksPerSec, totalSec,
 *         bandFillAlpha: 0.18,
 *         onNoteClick, onBandDragStart, onBandDragMove,
 *         onBandDragEnd, onSeek, onZoom,
 *         getAnchorAt, getDisplayedAnchor
 *     });
 *     r.setNotes(notes);
 *     r.setHands([{ id, span, color }, …]);
 *     r.setHandsTimeline(timelineMap);
 *     r.setNoteAssignments(map);
 *     r.setUnplayable(set);
 *     r.setVisibleExtent({ lo, hi });
 *     r.setLookahead(sec);
 *     r.setPlayhead(sec);
 *     r.draw();
 *     r.destroy();
 */
(function() {
    'use strict';

    const DRAG_THRESHOLD_PX = 3;

    /** Convert a `#rrggbb` hand colour into a translucent fill for
     *  the lane background. Cached so the per-frame draw doesn't
     *  re-parse the same hex string on every segment. */
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

    class KeyboardRollRenderer {
        /**
         * @param {HTMLCanvasElement} canvas
         * @param {HTMLElement} host - the canvas's bounding container
         *        (used for `clientWidth`/`clientHeight` and for the
         *        `is-panning` cursor class during a time pan).
         * @param {Object} [opts]
         */
        constructor(canvas, host, opts = {}) {
            this.canvas = canvas;
            this.host = host;
            this.ticksPerSec = Number.isFinite(opts.ticksPerSec) && opts.ticksPerSec > 0
                ? opts.ticksPerSec : 480;
            this.totalSec = Number.isFinite(opts.totalSec) && opts.totalSec > 0
                ? opts.totalSec : 0;
            this.bandFillAlpha = Number.isFinite(opts.bandFillAlpha) ? opts.bandFillAlpha : 0.18;

            // Callbacks (no-op fallbacks so the renderer works even
            // when the editor only wires a subset).
            this.onNoteClick      = opts.onNoteClick      || (() => {});
            this.onBandDragStart  = opts.onBandDragStart  || (() => {});
            this.onBandDragMove   = opts.onBandDragMove   || (() => {});
            this.onBandDragEnd    = opts.onBandDragEnd    || (() => {});
            this.onSeek           = opts.onSeek           || (() => {});
            this.onZoom           = opts.onZoom           || (() => {});
            this.getAnchorAt        = typeof opts.getAnchorAt === 'function'
                ? opts.getAnchorAt : null;
            this.getDisplayedAnchor = typeof opts.getDisplayedAnchor === 'function'
                ? opts.getDisplayedAnchor : null;

            // Inputs (set by the editor).
            this._notes = [];
            this._hands = [];
            this._handsTimeline = new Map();
            this._noteAssignments = new Map();
            this._unplayable = new Set();
            this._extent = { lo: 0, hi: 127 };
            this._lookaheadSec = 4;
            this._playheadSec = 0;

            // Derived per-frame; populated by `draw()` and consumed
            // by the hit-test on the next mousedown.
            this._noteHits = [];

            // Drag / click state.
            this._rollDrag = null;
            this._pendingNoteClick = null;
            this._pendingMoveListener = null;
            this._pendingUpListener = null;

            this._mouseDownHandler = (e) => this._onMouseDown(e);
            this._clickHandler     = (e) => this._onClick(e);
            this._wheelHandler     = (e) => this._onWheel(e);

            if (this.canvas && this.canvas.addEventListener) {
                this.canvas.addEventListener('mousedown', this._mouseDownHandler);
                this.canvas.addEventListener('click',     this._clickHandler);
            }
            if (this.host && this.host.addEventListener) {
                this.host.addEventListener('wheel', this._wheelHandler, { passive: false });
            }
        }

        // -----------------------------------------------------------------
        //  Public setters
        // -----------------------------------------------------------------

        setNotes(notes) {
            this._notes = Array.isArray(notes) ? notes : [];
        }

        /** `[{ id, span, color }, …]`. Used both for the lane
         *  rendering (color → translucent fill) and for the band
         *  hit-test (id + span). */
        setHands(hands) {
            this._hands = Array.isArray(hands)
                ? hands.filter(h => h && h.id
                    && Number.isFinite(h.span)
                    && typeof h.color === 'string')
                : [];
        }

        /** `Map<handId, [{sec, anchor, fromSec?, fromAnchor?, feasible?}]>`
         *  built by `KeyboardHandPositionState.setSimulationResult`. */
        setHandsTimeline(timeline) {
            this._handsTimeline = (timeline instanceof Map) ? timeline : new Map();
        }

        /** `Map<"tick:note", handId>` — used to pick a note's fill
         *  colour from the matching hand's palette. */
        setNoteAssignments(map) {
            this._noteAssignments = (map instanceof Map) ? map : new Map();
        }

        /** `Set<"tick:note">` — notes the simulator marked as
         *  unplayable. They render in red regardless of any
         *  assignment. */
        setUnplayable(set) {
            this._unplayable = (set instanceof Set) ? set : new Set();
        }

        setVisibleExtent(extent) {
            if (extent && Number.isFinite(extent.lo) && Number.isFinite(extent.hi)
                    && extent.hi > extent.lo) {
                this._extent = { lo: extent.lo, hi: extent.hi };
            }
        }

        setLookahead(sec) {
            if (Number.isFinite(sec) && sec > 0) this._lookaheadSec = sec;
        }

        setPlayhead(sec) {
            if (Number.isFinite(sec) && sec >= 0) this._playheadSec = sec;
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
            // Reallocating canvas.width/height invalidates the backing
            // store so we only do it when the size actually changes —
            // a 60 Hz redraw would otherwise trigger ~120 buffer
            // reallocs per second.
            if (c.width !== wantW || c.height !== wantH) {
                c.width = wantW;
                c.height = wantH;
                c.style.width = W + 'px';
                c.style.height = H + 'px';
            }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, W, H);

            const ext = this._extent;
            const semitoneCount = ext.hi - ext.lo + 1;
            const pxPerPitch = W / Math.max(1, semitoneCount);
            const lookaheadSec = this._lookaheadSec;
            const startSec = this._playheadSec;
            const endSec = startSec + lookaheadSec;

            // Octave grid lines.
            ctx.strokeStyle = 'rgba(148,163,184,0.15)';
            ctx.lineWidth = 1;
            for (let p = ext.lo; p <= ext.hi; p++) {
                if (p % 12 === 0) {
                    const x = (p - ext.lo) * pxPerPitch + 0.5;
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, H);
                    ctx.stroke();
                }
            }

            // Hand-position lanes — translucent stripe per hand
            // showing where each will be at every moment of the
            // visible window. Drawn under the notes so the operator
            // can see at a glance which note is "covered" by which
            // hand and which falls outside any window.
            this._drawHandLanes(ctx, ext, pxPerPitch, startSec, lookaheadSec, H);

            // Playhead line at the bottom of the roll (= present moment).
            ctx.strokeStyle = 'rgba(248,113,113,0.7)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, H - 1);
            ctx.lineTo(W, H - 1);
            ctx.stroke();

            // Notes.
            const handColorById = new Map();
            for (const h of this._hands) handColorById.set(h.id, h.color);
            const hits = [];
            for (const n of this._notes) {
                const noteSec = n.tick / this.ticksPerSec;
                const dur = (n.duration || 0) / this.ticksPerSec;
                if (noteSec + dur < startSec) continue;
                if (noteSec > endSec) continue;
                const yBottom = H - ((noteSec - startSec) / lookaheadSec) * H;
                const yTop = H - ((noteSec + dur - startSec) / lookaheadSec) * H;
                const y = Math.max(0, yTop);
                const h = Math.min(H, yBottom) - y;
                if (h <= 0) continue;
                const x = (n.note - ext.lo) * pxPerPitch;
                const w = Math.max(2, pxPerPitch - 1);
                const handId = this._noteAssignments.get(`${n.tick}:${n.note}`) || null;
                const isUnplayable = this._unplayable.has(`${n.tick}:${n.note}`);
                if (isUnplayable) {
                    ctx.fillStyle = '#dc2626';
                    ctx.fillRect(x, y, w, h);
                    ctx.strokeStyle = '#fecaca';
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                    ctx.lineWidth = 1;
                } else {
                    ctx.fillStyle = (handId && handColorById.get(handId)) || '#94a3b8';
                    ctx.fillRect(x, y, w, h);
                    ctx.strokeStyle = 'rgba(15,23,42,0.6)';
                    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                }
                hits.push({ x, y, w, h, note: n });
            }
            this._noteHits = hits;
        }

        destroy() {
            if (this.canvas && this.canvas.removeEventListener) {
                this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
                this.canvas.removeEventListener('click', this._clickHandler);
            }
            if (this.host && this.host.removeEventListener) {
                this.host.removeEventListener('wheel', this._wheelHandler);
            }
            this._endRollDrag();
            this._cancelPendingNoteClick();
            this._notes = [];
            this._hands = [];
            this._handsTimeline = new Map();
            this._noteAssignments = new Map();
            this._unplayable = new Set();
            this._noteHits = [];
        }

        // -----------------------------------------------------------------
        //  Lane rendering
        // -----------------------------------------------------------------

        _drawHandLanes(ctx, ext, pxPerPitch, startSec, lookaheadSec, H) {
            if (this._hands.length === 0) return;
            const endSec = startSec + lookaheadSec;
            const yOf = (sec) => H - ((sec - startSec) / lookaheadSec) * H;
            const infeasibleFill = 'rgba(220, 38, 38, 0.28)';
            for (const hand of this._hands) {
                const samples = this._laneSamplesFor(hand, startSec, endSec);
                if (samples.length === 0) continue;
                const fill = _bandFill(hand.color, this.bandFillAlpha);
                const w = hand.span * pxPerPitch;
                for (let i = 0; i < samples.length - 1; i++) {
                    const cur = samples[i];
                    const next = samples[i + 1];
                    if (next.sec <= startSec || cur.sec >= endSec) continue;
                    // Stable rectangle from `cur.sec` to the start of
                    // the next slide (or to `next.sec` if it isn't a
                    // shift).
                    const stableEndSec = Number.isFinite(next.fromSec) ? next.fromSec : next.sec;
                    if (stableEndSec > cur.sec) {
                        const a = Math.max(cur.sec, startSec);
                        const b = Math.min(stableEndSec, endSec);
                        if (b > a) {
                            ctx.fillStyle = fill;
                            const x = (cur.anchor - ext.lo) * pxPerPitch;
                            ctx.fillRect(x, yOf(b), w, yOf(a) - yOf(b));
                        }
                    }
                    // Sliding parallelogram — only when `next` is a
                    // shift carrying explicit fromSec / fromAnchor.
                    // Slope (Δanchor / Δsec) matches the configured
                    // max hand-move speed when the shift is feasible
                    // and is steeper when infeasible — the operator
                    // can read the speed limit straight off the lane
                    // geometry.
                    if (Number.isFinite(next.fromSec) && Number.isFinite(next.fromAnchor)
                            && next.fromSec < next.sec) {
                        const a = Math.max(next.fromSec, startSec);
                        const b = Math.min(next.sec, endSec);
                        if (b > a) {
                            const slope = (next.anchor - next.fromAnchor) / (next.sec - next.fromSec);
                            const aAnchor = next.fromAnchor + slope * (a - next.fromSec);
                            const bAnchor = next.fromAnchor + slope * (b - next.fromSec);
                            const xA = (aAnchor - ext.lo) * pxPerPitch;
                            const xB = (bAnchor - ext.lo) * pxPerPitch;
                            const yA = yOf(a);
                            const yB = yOf(b);
                            ctx.fillStyle = next.feasible === false ? infeasibleFill : fill;
                            ctx.beginPath();
                            ctx.moveTo(xA, yA);
                            ctx.lineTo(xA + w, yA);
                            ctx.lineTo(xB + w, yB);
                            ctx.lineTo(xB, yB);
                            ctx.closePath();
                            ctx.fill();
                            // Outline. Heavier dashed stroke when
                            // infeasible so it reads as a warning.
                            if (next.feasible === false) {
                                ctx.save();
                                ctx.strokeStyle = '#dc2626';
                                ctx.setLineDash([4, 3]);
                                ctx.lineWidth = 1.5;
                            } else {
                                ctx.strokeStyle = hand.color;
                                ctx.lineWidth = 1;
                            }
                            ctx.beginPath();
                            ctx.moveTo(xA, yA);
                            ctx.lineTo(xA + w, yA);
                            ctx.lineTo(xB + w, yB);
                            ctx.lineTo(xB, yB);
                            ctx.closePath();
                            ctx.stroke();
                            if (next.feasible === false) ctx.restore();
                        }
                    }
                }
            }
        }

        /** `[{sec, anchor}]` samples covering `[startSec, endSec]`
         *  for one hand, drawn from the simulator timeline. The
         *  first sample is the live displayed anchor (so the lane
         *  visibly meets the live band), the last is the constant
         *  prolongation to `endSec` for the segment-pair walk. */
        _laneSamplesFor(hand, startSec, endSec) {
            const series = this._handsTimeline.get(hand.id) || [];
            const out = [];
            // Initial anchor at the start of the view: prefer the
            // displayed (animated) value when the editor exposes one
            // so the lane visibly meets the live band.
            let firstAnchor = NaN;
            if (this.getDisplayedAnchor) {
                const v = this.getDisplayedAnchor(hand.id);
                if (Number.isFinite(v)) firstAnchor = v;
            }
            if (!Number.isFinite(firstAnchor) && this.getAnchorAt) {
                const v = this.getAnchorAt(hand.id, startSec);
                if (Number.isFinite(v)) firstAnchor = v;
            }
            if (!Number.isFinite(firstAnchor)) return out;
            out.push({ sec: startSec, anchor: firstAnchor });
            for (const s of series) {
                const slideStart = Number.isFinite(s.fromSec) ? s.fromSec : s.sec;
                if (s.sec <= startSec) continue;
                if (slideStart >= endSec) break;
                out.push({
                    sec: s.sec,
                    anchor: s.anchor,
                    fromSec: s.fromSec,
                    fromAnchor: s.fromAnchor,
                    feasible: s.feasible !== false
                });
            }
            out.push({ sec: endSec, anchor: out[out.length - 1].anchor });
            return out;
        }

        // -----------------------------------------------------------------
        //  Hit-test
        // -----------------------------------------------------------------

        _localXY(e) {
            const rect = this.canvas.getBoundingClientRect();
            return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        }

        _hitNote(x, y) {
            const hits = this._noteHits;
            for (let i = hits.length - 1; i >= 0; i--) {
                const h = hits[i];
                if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
            }
            return null;
        }

        /** Walk the hand list and find the band whose `[anchor,
         *  anchor + span]` range contains the click x at the click's
         *  y-mapped time. Uses `getAnchorAt` to pick up the simulator
         *  target (the lane the operator sees) instead of the
         *  static hand.anchor. */
        _hitHandBand(x, y) {
            if (this._hands.length === 0) return null;
            const W = this.host.clientWidth;
            const H = this.host.clientHeight;
            if (W <= 0 || H <= 0) return null;
            const ext = this._extent;
            const pxPerPitch = W / Math.max(1, ext.hi - ext.lo + 1);
            const tFromBottom = (H - y) / H;
            const seedSec = this._playheadSec + tFromBottom * (this._lookaheadSec || 0);
            for (const hand of this._hands) {
                const anchor = this.getAnchorAt
                    ? this.getAnchorAt(hand.id, seedSec)
                    : NaN;
                if (!Number.isFinite(anchor)) continue;
                const xLeft  = (anchor - ext.lo) * pxPerPitch;
                const xRight = (anchor + hand.span - ext.lo + 1) * pxPerPitch;
                if (x >= xLeft && x <= xRight) {
                    return {
                        handId: hand.id,
                        offsetPx: x - xLeft,
                        pxPerPitch,
                        ext
                    };
                }
            }
            return null;
        }

        // -----------------------------------------------------------------
        //  Pointer interactions
        // -----------------------------------------------------------------

        _onMouseDown(e) {
            if (e.button !== 0) return;
            const { x, y } = this._localXY(e);
            const note = this._hitNote(x, y);
            if (note) {
                // Defer to mouseup → click; cancel if movement
                // exceeds the threshold (= the user is dragging
                // across the note rather than clicking it).
                this._armPendingNoteClick(note, e);
                return;
            }
            e.preventDefault();
            this._cancelPendingNoteClick();
            const band = this._hitHandBand(x, y);
            if (band) this._startBandDrag(band, x);
            else      this._startTimePan(y);
        }

        _onClick(e) {
            const pending = this._pendingNoteClick;
            this._pendingNoteClick = null;
            if (!pending) return;
            this.onNoteClick(pending.hit.note, e);
        }

        _onWheel(e) {
            // Skip horizontal-only wheel events (touchpad sideways
            // scroll) so the browser can still use them.
            if (e.deltaY === 0) return;
            e.preventDefault();
            if (e.ctrlKey) {
                const factor = e.deltaY < 0 ? 1.25 : 0.8;
                this.onZoom(factor);
                return;
            }
            // Wheel scrubs the timeline — one notch ≈ 10 % of the
            // visible window so a single scroll always moves the
            // playhead by a noticeable but predictable amount no
            // matter the zoom level.
            const step = (this._lookaheadSec || 4) * 0.1;
            const target = this._playheadSec + Math.sign(e.deltaY) * step;
            this.onSeek(this._clampSec(target));
        }

        _armPendingNoteClick(noteHit, downEvt) {
            this._cancelPendingNoteClick();
            this._pendingNoteClick = { hit: noteHit, evt: downEvt };
            const startX = downEvt.clientX;
            const startY = downEvt.clientY;
            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
                    this._cancelPendingNoteClick();
                }
            };
            const onUp = () => this._cancelPendingNoteClick();
            this._pendingMoveListener = onMove;
            this._pendingUpListener = onUp;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        _cancelPendingNoteClick() {
            this._pendingNoteClick = null;
            if (this._pendingMoveListener) {
                document.removeEventListener('mousemove', this._pendingMoveListener);
                this._pendingMoveListener = null;
            }
            if (this._pendingUpListener) {
                document.removeEventListener('mouseup', this._pendingUpListener);
                this._pendingUpListener = null;
            }
        }

        _startBandDrag(hit, startX) {
            const drag = {
                kind: 'band',
                handId: hit.handId,
                offsetPx: hit.offsetPx,
                pxPerPitch: hit.pxPerPitch,
                ext: hit.ext,
                startX,
                started: false
            };
            this._rollDrag = drag;
            const onMove = (ev) => {
                // Re-fetch the canvas rect every move so a window
                // resize or page scroll during the drag doesn't
                // strand the band on the old viewport position.
                const rect = this.canvas.getBoundingClientRect();
                const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
                if (!drag.started) {
                    if (Math.abs(x - drag.startX) < DRAG_THRESHOLD_PX) return;
                    drag.started = true;
                    this.onBandDragStart(drag.handId);
                }
                const pitchAtLeftEdge = drag.ext.lo + (x - drag.offsetPx) / drag.pxPerPitch;
                // Pass the FRACTIONAL pitch so the editor can decide
                // how to snap it (chromatic = round to nearest
                // semitone, piano = round to nearest white key, etc.).
                // Rounding here would lose the sub-semitone position
                // and force every consumer into the same snap policy.
                this.onBandDragMove(drag.handId, pitchAtLeftEdge);
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this._rollDrag = null;
                if (drag.started) this.onBandDragEnd(drag.handId);
            };
            this._rollDrag.onMove = onMove;
            this._rollDrag.onUp = onUp;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        _startTimePan(startY) {
            const drag = {
                kind: 'pan',
                startY,
                startSec: this._playheadSec,
                lookahead: this._lookaheadSec || 4,
                started: false
            };
            this._rollDrag = drag;
            const host = this.host;
            const onMove = (ev) => {
                const rect = this.canvas.getBoundingClientRect();
                const y = ev.clientY - rect.top;
                if (!drag.started) {
                    if (Math.abs(y - drag.startY) < DRAG_THRESHOLD_PX) return;
                    drag.started = true;
                    if (host && host.classList) host.classList.add('is-panning');
                }
                // Drag DOWN = travel back in time, drag UP = travel
                // forward. Feels like grabbing the timeline strip
                // itself.
                const H = host.clientHeight || 1;
                const deltaSec = ((y - drag.startY) / H) * drag.lookahead * -1;
                this.onSeek(this._clampSec(drag.startSec + deltaSec));
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (host && host.classList) host.classList.remove('is-panning');
                this._rollDrag = null;
            };
            this._rollDrag.onMove = onMove;
            this._rollDrag.onUp = onUp;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        _endRollDrag() {
            const drag = this._rollDrag;
            if (!drag) return;
            if (drag.onMove) document.removeEventListener('mousemove', drag.onMove);
            if (drag.onUp)   document.removeEventListener('mouseup', drag.onUp);
            this._rollDrag = null;
        }

        _clampSec(sec) {
            const total = this.totalSec || 0;
            return Math.max(0, Math.min(total, sec));
        }
    }

    if (typeof window !== 'undefined') {
        window.KeyboardRollRenderer = KeyboardRollRenderer;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { KeyboardRollRenderer };
    }
})();
