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
 *   fb.setHandTrajectory(points);
 *   fb.draw();
 *   fb.destroy();
 *
 * Hand-width contract: the painted band ALWAYS reflects the
 * configured `handSpanMm` (physical mode) or `handSpanFrets`
 * (fallback) — never a chord-derived span. The configured value comes
 * from `hands_config.hands[0].hand_span_mm` (or `hand_span_frets`)
 * via {@link HandsPreviewPanel}, so what the operator sees on the
 * fretboard is exactly what they set in the instrument settings.
 */
(function() {
    'use strict';

    const STANDARD_MARKER_FRETS  = [3, 5, 7, 9, 15, 17, 19, 21];
    const DOUBLE_MARKER_FRETS    = [12, 24];
    // Vertical overflow for the hand band (top + bottom). Makes the
    // band read as "the hand", not "the fret slot" — it brackets
    // the strings rather than sitting flush with the wood-tone fill.
    const HAND_BAND_Y_OVERFLOW   = 6;
    // A finger pressing fret n actually rests just *behind* the fret
    // wire (toward the nut), not on top of it. Shift the band's left
    // edge by this much so the hand reads as physically realistic
    // instead of "glued to" the fret. Physical-mode only; the fret-
    // based fallback has no mm scale to anchor the offset.
    const FINGER_BEFORE_FRET_MM  = 10;
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F',
                         'F#', 'G', 'G#', 'A', 'A#', 'B'];

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

            // Single source of truth for the hand band. Position is
            // DERIVED from `_trajectory` + `_currentSec`; level is
            // chord-driven. No more `handWindow.anchorFret` /
            // `_displayedAnchor` / `_animation` triple.
            this._trajectory = [];
            this._ticksPerSec = null;
            this._currentSec = 0;
            this._level = 'ok';
            // Throttle: skip draw when the displayed anchor barely
            // moved AND at least one frame budget (~33 ms = 30 fps)
            // has elapsed since the last paint.
            this._lastDrawnAnchor = null;
            this._lastDrawnAt = 0;

            // Wider left margin holds the tuning labels (D1) plus
            // the O / X glyph column (N3); wider right margin holds
            // the body sketch (B1).
            this.margin = { top: 14, right: 56, bottom: 24, left: 56 };

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
         * Set the per-hand trajectory used to drive the band's
         * position. Each entry: `{tick, anchor, releaseTick?,
         * motion?}`. Posed ONCE per engine setup (and on
         * `setOverrides`). The band + ghost positions are derived
         * from this + `_currentSec`, never set explicitly.
         */
        setHandTrajectory(points) {
            this._trajectory = Array.isArray(points)
                ? points
                    .filter(p => p && Number.isFinite(p.tick) && Number.isFinite(p.anchor))
                    .slice()
                    .sort((a, b) => a.tick - b.tick)
                : [];
            this._lastDrawnAnchor = null; // force first paint
            this.draw();
        }

        /** Conversion factor for tick → sec used by the trajectory
         *  interpolator. Posed once. */
        setTicksPerSec(ticksPerSec) {
            this._ticksPerSec = Number.isFinite(ticksPerSec) && ticksPerSec > 0
                ? ticksPerSec : null;
        }

        /**
         * Drive the animation from the simulated playhead. Cheap:
         * walks the trajectory once, computes the derived anchor,
         * and only redraws when the anchor moved enough OR a frame
         * budget has elapsed.
         */
        setCurrentTime(currentSec) {
            this._currentSec = Number.isFinite(currentSec) ? currentSec : 0;
            const newAnchor = this._currentDisplayedAnchor();
            if (this._lastDrawnAnchor != null && newAnchor != null) {
                const delta = Math.abs(newAnchor - this._lastDrawnAnchor);
                const now = (typeof performance !== 'undefined' && performance.now)
                    ? performance.now() : Date.now();
                if (delta < 0.05 && (now - this._lastDrawnAt) < 33) return;
            }
            this.draw();
        }

        /**
         * Set the chord-level reachability of the CURRENT chord.
         * Drives the band colour. Speed-related infeasibility is
         * NOT communicated here — the trajectory animation already
         * shows the hand visually lagging behind the music.
         *
         * Accepted values: `'ok' | 'warning' | 'infeasible'`.
         */
        setLevel(level) {
            this._level = (level === 'warning' || level === 'infeasible') ? level : 'ok';
            this.draw();
        }

        /** @private — Anchor for the CURRENT playhead. Returns
         *  `null` when no trajectory is loaded so the caller can
         *  decide what to do. Stable: callable from any code path. */
        _currentDisplayedAnchor() {
            return this._anchorFromTrajectory(this._currentSec);
        }

        /** @private — Anchor of the FIRST upcoming shift after the
         *  playhead, used to render the ghost rectangle. Returns
         *  `null` when no future shift exists. */
        _nextShiftAnchor() {
            const traj = this._trajectory;
            const tps  = this._ticksPerSec;
            if (!traj || traj.length === 0 || !tps) return null;
            for (const p of traj) {
                if (p.tick / tps > this._currentSec) return p.anchor;
            }
            return null;
        }

        /** @private — Compute the anchor at `currentSec` by walking
         *  the trajectory: hold the previous anchor while its chord
         *  rings, then lerp toward the next anchor at the physical
         *  travel speed (`motion.requiredSec`). When the move is
         *  infeasible (`requiredSec > gap`), the band visually lags
         *  behind the music — that's the correct cue. */
        _anchorFromTrajectory(currentSec) {
            const traj = this._trajectory;
            const tps  = this._ticksPerSec;
            if (!traj || traj.length === 0 || !tps) return null;
            let prev = null, next = null;
            for (const p of traj) {
                const pSec = p.tick / tps;
                if (pSec <= currentSec) prev = p;
                else { next = p; break; }
            }
            if (!prev && !next) return null;
            if (!prev) return next.anchor;     // before any shift
            if (!next) return prev.anchor;     // after the last shift
            const prevReleaseSec = (Number.isFinite(prev.releaseTick)
                ? prev.releaseTick : prev.tick) / tps;
            if (currentSec <= prevReleaseSec) return prev.anchor;
            let toSec = next.tick / tps;
            if (next.motion && Number.isFinite(next.motion.requiredSec)
                    && next.motion.requiredSec > 0) {
                toSec = prevReleaseSec + next.motion.requiredSec;
            }
            if (toSec <= prevReleaseSec) return next.anchor;
            if (currentSec >= toSec) return next.anchor;
            const t = (currentSec - prevReleaseSec) / (toSec - prevReleaseSec);
            return prev.anchor + (next.anchor - prev.anchor) * t;
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

            // Body sketch right of the last fret (B1) — drawn under
            // the strings so they don't extend into the body.
            this._drawBodyHint(w, h);

            // Anchors derived from the trajectory + playhead — the
            // hand position is never set explicitly. Both the band
            // and the ghost share the same data path.
            const liveAnchor = this._currentDisplayedAnchor();
            const nextAnchor = this._nextShiftAnchor();
            // Ghost first (= upcoming anchor), drawn under so the
            // live band paints on top. Skipped when ghost ≈ live
            // (= no upcoming shift visible) or when no live anchor.
            if (Number.isFinite(nextAnchor) && Number.isFinite(liveAnchor)
                    && Math.abs(nextAnchor - liveAnchor) > 0.5) {
                this._drawGhostAnchor(fbY, fbH, nextAnchor);
            }
            // Live hand band — always painted when an anchor is
            // derivable; level (= colour) is purely chord-driven via
            // `setLevel`.
            if (Number.isFinite(liveAnchor)) {
                this._drawHandWindow(fbX, fbY, fbW, fbH, w, liveAnchor, this._level);
            }

            // Inlay dots.
            this._drawInlayMarkers(fbY, fbH);

            // Frets (vertical lines).
            this._drawFrets(fbY, fbH);

            // Strings (horizontal lines).
            this._drawStrings();

            // N1 — Bright segments on active strings, drawn ON the
            // strings so they read as "lit-up portions of the cord".
            this._drawActiveStringSegments();

            // Tuning labels left of the nut (D1).
            this._drawTuningLabels();

            // N3 — Open / muted glyphs left of the tuning labels.
            this._drawOpenMutedIndicators();

            // Fret numbers below the board.
            this._drawFretNumbers(fbY, fbH);

            // Active note positions.
            this._drawActivePositions();
            // Unplayable overlay (red discs on top of the active dots).
            this._drawUnplayablePositions();

            // Mark the current paint state so `setCurrentTime` can
            // skip redraws that wouldn't move anything visibly.
            this._lastDrawnAnchor = liveAnchor;
            this._lastDrawnAt = (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
        }

        /**
         * Compute the [x0, x1] horizontal extent of a hand band on
         * the fretboard.
         *
         * The band MUST match the simulator's playability window 1:1
         * — otherwise the operator sees notes drawn outside the green
         * rectangle that the simulator considers playable, and vice
         * versa. So:
         *   - x0 sits at the anchor's mm position from the nut
         *     (anchorMm = L · (1 − 2^(−anchor/12))).
         *   - x1 sits at anchorMm + handSpanMm (physical mode) or at
         *     `anchor + handSpanFrets` (fallback).
         *
         * The hand width on screen is ALWAYS the configured value
         * (`handSpanMm` / `handSpanFrets`) — no caller can stretch or
         * shrink it. The previous "slotLeft = anchor − 1" approximation
         * was dropped because it shifted the band ~one fret behind the
         * simulator window, producing the false-positive "playable note
         * outside the band" we were seeing for chords whose lowest
         * fret was ≥ 2.
         * @private
         */
        _handWindowX(anchorFret) {
            const safeAnchor = Math.max(0, anchorFret);
            let x0, x1;
            if (this.scaleLengthMm && this.handSpanMm) {
                const anchorMm = this.scaleLengthMm * (1 - Math.pow(2, -safeAnchor / 12));
                // Shift the whole band toward the nut by FINGER_BEFORE_FRET_MM
                // so the index finger reads as resting *behind* the target
                // fret wire rather than on top of it. Clamped at 0 so the
                // band never starts before the nut.
                const leftMm = Math.max(0, anchorMm - FINGER_BEFORE_FRET_MM);
                x0 = this._xFromMm(leftMm);
                const rightMm = leftMm + this.handSpanMm;
                const totalDistMm = this.scaleLengthMm * (1 - Math.pow(2, -this.numFrets / 12));
                if (rightMm >= totalDistMm) {
                    x1 = this._fretX(this.numFrets);
                } else {
                    x1 = this._xFromMm(rightMm);
                }
            } else {
                x0 = this._fretX(safeAnchor);
                x1 = this._fretX(Math.min(this.numFrets, safeAnchor + this.handSpanFrets));
            }
            return { x0, x1 };
        }

        /**
         * Paint the upcoming-anchor "ghost" rectangle. ALWAYS
         * neutral grey — never red — so the ghost never doubles as
         * a feasibility signal (that's the live band's job). Span
         * is shared with the live band.
         */
        _drawGhostAnchor(fbY, fbH, anchorFret) {
            const { x0, x1 } = this._handWindowX(anchorFret);
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return;
            const ctx = this.ctx;
            const yOverflow = HAND_BAND_Y_OVERFLOW;
            const yTop = fbY - yOverflow;
            const bandH = fbH + 2 * yOverflow;
            ctx.fillStyle   = 'rgba(120, 120, 140, 0.10)';
            ctx.fillRect(x0, yTop, x1 - x0, bandH);
            ctx.strokeStyle = 'rgba(120, 120, 140, 0.55)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]);
            ctx.strokeRect(x0, yTop, x1 - x0, bandH);
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

        _drawHandWindow(fbX, fbY, fbW, fbH, _canvasW, anchor, level) {
            const { x0, x1 } = this._handWindowX(anchor);
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
            const yOverflow = HAND_BAND_Y_OVERFLOW;
            const yTop = fbY - yOverflow;
            const bandH = fbH + 2 * yOverflow;
            ctx.fillStyle = fills[level] || fills.ok;
            ctx.fillRect(x0, yTop, x1 - x0, bandH);
            ctx.strokeStyle = strokes[level] || strokes.ok;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(x0, yTop, x1 - x0, bandH);
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
                    // D2 — heavier wires on marker frets so the eye
                    // can find the 12 / 5 / 7 / etc. without counting.
                    const isMajor = DOUBLE_MARKER_FRETS.includes(f);
                    const isMinor = STANDARD_MARKER_FRETS.includes(f);
                    ctx.strokeStyle = isMajor ? '#3a3f4d' : (isMinor ? '#5a6173' : '#9098a8');
                    ctx.lineWidth = isMajor ? 2.5 : (isMinor ? 1.7 : 1);
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

        /** D1 — Letter labels left of the nut, one per string,
         *  showing the open-string note name (e.g. "E2"). */
        _drawTuningLabels() {
            const ctx = this.ctx;
            ctx.fillStyle = '#374151';
            ctx.font = 'bold 10px monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const xLabel = this._fretX(0) - 6;
            for (let s = 1; s <= this.numStrings; s++) {
                const midi = this.tuning[s - 1];
                if (!Number.isFinite(midi)) continue;
                const y = this._stringY(s);
                const name = NOTE_NAMES[((midi % 12) + 12) % 12];
                const octave = Math.floor(midi / 12) - 1;
                ctx.fillText(`${name}${octave}`, xLabel, y);
            }
        }

        /** B1 — Stylised body sketch right of the last fret: shoulder
         *  curve + soundhole rosette. Decorative but orients the eye. */
        _drawBodyHint(canvasW, canvasH) {
            const ctx = this.ctx;
            const fbY = this.margin.top;
            const fbH = canvasH - this.margin.top - this.margin.bottom;
            const x0 = this._fretX(this.numFrets);
            const xEnd = canvasW - 4;
            if (xEnd <= x0 + 8) return; // not enough space
            const midY = fbY + fbH / 2;
            // Shoulder curve — cuts in slightly toward the centre so
            // the body looks like it bulges out and back in.
            ctx.fillStyle = '#d8c5a3';
            ctx.beginPath();
            ctx.moveTo(x0, fbY - 4);
            ctx.quadraticCurveTo(x0 + 8, midY, x0, fbY + fbH + 4);
            ctx.lineTo(xEnd, fbY + fbH + 4);
            ctx.quadraticCurveTo(xEnd - 6, midY, xEnd, fbY - 4);
            ctx.closePath();
            ctx.fill();
            // Soundhole rosette — concentric rings at the body centre.
            const cx = (x0 + xEnd) / 2;
            const r = Math.min(12, fbH * 0.18);
            ctx.fillStyle = '#3a3225';
            ctx.beginPath();
            ctx.arc(cx, midY, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#8a7a5e';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cx, midY, r + 3, 0, Math.PI * 2);
            ctx.stroke();
        }

        /** N1 — Bright segment over the VIBRATING portion of each
         *  active string. For pressed notes that's from the centre
         *  of the pressed slot (where the finger sits) to the end of
         *  the fretboard (= the bridge side); the muted segment
         *  between the nut and the finger is left untouched. Open
         *  strings (fret 0) light up end-to-end. */
        _drawActiveStringSegments() {
            if (!this.activePositions || this.activePositions.length === 0) return;
            const ctx = this.ctx;
            const xEnd = this._fretX(this.numFrets);
            for (const pos of this.activePositions) {
                if (!Number.isFinite(pos.string) || !Number.isFinite(pos.fret)) continue;
                const y = this._stringY(pos.string);
                let xStart;
                if (pos.fret === 0) {
                    // Open string sounds end-to-end.
                    xStart = this._fretX(0);
                } else {
                    // Pressed fret: only the segment from the finger
                    // to the bridge actually vibrates.
                    xStart = (this._fretX(pos.fret - 1) + this._fretX(pos.fret)) / 2;
                }
                const thickness = 4 + (this.numStrings - pos.string) * 0.4;
                ctx.strokeStyle = 'rgba(255, 215, 64, 0.9)'; // amber, easy on the wood tone
                ctx.lineWidth = thickness;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(xStart, y);
                ctx.lineTo(xEnd, y);
                ctx.stroke();
            }
            ctx.lineCap = 'butt';
        }

        /** N3 — O / X indicators left of the nut. Open strings get
         *  a green circle ("O"), unplayable / muted strings get a
         *  red cross ("X"). Conventional chord-diagram glyphs. */
        _drawOpenMutedIndicators() {
            const ctx = this.ctx;
            const x = this._fretX(0) - 18; // sits left of the tuning labels
            const seen = new Set();

            // Open strings — drawn from currently active positions
            // with fret === 0. Use the string number as the dedupe key.
            for (const pos of this.activePositions || []) {
                if (!Number.isFinite(pos.string) || pos.fret !== 0) continue;
                const key = `O:${pos.string}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const y = this._stringY(pos.string);
                ctx.fillStyle = '#06d6a0';
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 9px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('O', x, y);
            }

            // Muted strings — derived from unplayablePositions (any
            // string that has at least one unplayable entry).
            const mutedStrings = new Set();
            for (const pos of this.unplayablePositions || []) {
                if (Number.isFinite(pos.string)) mutedStrings.add(pos.string);
            }
            ctx.fillStyle = '#dc2626';
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 2;
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const s of mutedStrings) {
                const key = `X:${s}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const y = this._stringY(s);
                ctx.fillText('X', x, y);
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
            this._trajectory = [];
            this._ticksPerSec = null;
            this._level = 'ok';
        }
    }

    if (typeof window !== 'undefined') {
        window.FretboardHandPreview = FretboardHandPreview;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FretboardHandPreview;
    }
})();
