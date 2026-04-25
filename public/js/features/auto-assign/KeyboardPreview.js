/**
 * @file KeyboardPreview.js
 * @description Compact, canvas-based read-only piano widget for the
 * routing-summary HandsPreviewPanel (E.6.6). Renders the playable
 * note range of the routed instrument, paints individual keys in red
 * when they fall outside the current hand window, and shows two
 * coloured bands under the keys representing the left/right hand
 * positions.
 *
 * Why a new component vs reusing KeyboardPiano (KeyboardModal.js):
 *   - KeyboardPiano is DOM-heavy (52+ elements per octave) and
 *     designed to live in a full-screen modal. The preview panel
 *     needs a small, embeddable canvas widget that paints fast on
 *     every simulation tick.
 *   - KeyboardPiano is interactive (sends MIDI on click). Here we
 *     want a primarily read-only display with a single click-to-
 *     toggle gesture for the edit mode (E.6.8).
 *
 * Public API:
 *   const kb = new KeyboardPreview(canvas, { rangeMin: 21, rangeMax: 108 });
 *   kb.setRange(min, max);                         // playable range bounds
 *   kb.setActiveNotes([60, 64, 67]);               // notes currently sounding
 *   kb.setUnplayableNotes([{note: 95, hand: 'right'}]);
 *   kb.setHandBands([
 *     { id: 'left',  low: 40, high: 54, color: '#3b82f6' },
 *     { id: 'right', low: 60, high: 74, color: '#10b981' }
 *   ]);
 *   kb.onKeyClick = (midiNote) => { ... };          // optional click handler
 *   kb.destroy();
 */
(function() {
    'use strict';

    const WHITE_KEYS_PER_OCTAVE = 7;
    const BLACK_OFFSETS = new Set([1, 3, 6, 8, 10]); // semitone offsets in an octave

    // Pitch-class → index of the white key in the octave (0..6).
    // C, D, E, F, G, A, B.
    const WHITE_INDEX_BY_PC = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };

    function isBlackKey(midi) {
        return BLACK_OFFSETS.has(((midi % 12) + 12) % 12);
    }

    function whiteKeyCount(rangeMin, rangeMax) {
        let n = 0;
        for (let m = rangeMin; m <= rangeMax; m++) if (!isBlackKey(m)) n++;
        return n;
    }

    function rgbaWithAlpha(hex, alpha) {
        // Accept "#RRGGBB" only (callers control the palette).
        if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    class KeyboardPreview {
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.ctx = canvas && typeof canvas.getContext === 'function'
                ? canvas.getContext('2d') : null;

            this.rangeMin = Number.isFinite(opts.rangeMin) ? opts.rangeMin : 21;  // A0
            this.rangeMax = Number.isFinite(opts.rangeMax) ? opts.rangeMax : 108; // C8
            this.activeNotes = new Set();
            this.unplayableNotes = new Map(); // midi → { hand }
            this.handBands = [];              // [{id, low, high, color}]
            this.bandHeight = Number.isFinite(opts.bandHeight) ? opts.bandHeight : 8;

            // Click handler (set by caller). Only fires when within key area.
            this.onKeyClick = opts.onKeyClick || null;
            // Band-drag callback (id, newAnchor) → user repositions a
            // hand by dragging its band under the keys.
            this.onBandDrag = opts.onBandDrag || null;

            // Drag state for the hand-band interaction. Set on
            // mousedown over a band, cleared on mouseup.
            this._drag = null;

            this._clickHandler     = (e) => this._handleClick(e);
            this._mouseDownHandler = (e) => this._handleMouseDown(e);
            this._mouseMoveHandler = (e) => this._handleMouseMove(e);
            this._mouseUpHandler   = (e) => this._handleMouseUp(e);

            if (this.canvas && typeof this.canvas.addEventListener === 'function') {
                this.canvas.addEventListener('click',     this._clickHandler);
                this.canvas.addEventListener('mousedown', this._mouseDownHandler);
                this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
                // Listen on the document for mouseup so a drag that
                // ends outside the canvas still releases cleanly.
                if (typeof document !== 'undefined') {
                    document.addEventListener('mouseup', this._mouseUpHandler);
                }
            }
        }

        setRange(min, max) {
            const lo = Math.max(0, Math.min(127, Number.isFinite(min) ? min : this.rangeMin));
            const hi = Math.max(0, Math.min(127, Number.isFinite(max) ? max : this.rangeMax));
            this.rangeMin = Math.min(lo, hi);
            this.rangeMax = Math.max(lo, hi);
            this.draw();
        }

        setActiveNotes(notes) {
            this.activeNotes = new Set(Array.isArray(notes) ? notes.filter(n => Number.isFinite(n)) : []);
            this.draw();
        }

        setUnplayableNotes(entries) {
            this.unplayableNotes = new Map();
            if (Array.isArray(entries)) {
                for (const e of entries) {
                    const note = Number.isFinite(e?.note) ? e.note : (Number.isFinite(e) ? e : null);
                    if (note != null) this.unplayableNotes.set(note, { hand: e?.hand || null });
                }
            }
            this.draw();
        }

        setHandBands(bands) {
            this.handBands = Array.isArray(bands) ? bands.filter(b => b
                && Number.isFinite(b.low) && Number.isFinite(b.high)
                && typeof b.color === 'string' && b.id) : [];
            this.draw();
        }

        // -----------------------------------------------------------------
        //  Geometry helpers
        // -----------------------------------------------------------------

        _whiteKeyWidth() {
            const w = (this.canvas?.clientWidth || this.canvas?.width) || 0;
            const count = Math.max(1, whiteKeyCount(this.rangeMin, this.rangeMax));
            return w / count;
        }

        _whiteIndexForMidi(midi) {
            // Position of the lowest white key within [rangeMin..midi]
            let idx = 0;
            for (let m = this.rangeMin; m < midi; m++) if (!isBlackKey(m)) idx++;
            return idx;
        }

        /** Pixel x of the LEFT edge of the key (white) or the centre (black). */
        _xOf(midi) {
            const ww = this._whiteKeyWidth();
            if (!isBlackKey(midi)) {
                return this._whiteIndexForMidi(midi) * ww;
            }
            // Black key: sit on top of the left-adjacent white key,
            // shifted right by a full white-width. Width of the black key
            // is ~60% of a white.
            return this._whiteIndexForMidi(midi - 1) * ww + ww * 0.65;
        }

        _midiAtX(x) {
            const ww = this._whiteKeyWidth();
            if (ww <= 0) return null;
            // Walk through white keys; the black-key zone is a thin band
            // ABOVE the lower 50% of the canvas. We treat every click as
            // a white-key hit — close enough for the preview panel.
            const whiteIdx = Math.floor(x / ww);
            let count = 0;
            for (let m = this.rangeMin; m <= this.rangeMax; m++) {
                if (!isBlackKey(m)) {
                    if (count === whiteIdx) return m;
                    count++;
                }
            }
            return null;
        }

        _handleClick(e) {
            if (!this.onKeyClick) return;
            // Suppress the click that closes a drag — it would
            // otherwise toggle the underlying key as a side-effect.
            if (this._suppressNextClick) {
                this._suppressNextClick = false;
                return;
            }
            const rect = this.canvas.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            const x = (e.clientX || 0) - rect.left;
            const y = (e.clientY || 0) - rect.top;
            // Don't toggle a key when the click landed on a band.
            if (this._bandIndexAt(y) != null) return;
            const midi = this._midiAtX(x);
            if (midi != null) this.onKeyClick(midi);
        }

        // -----------------------------------------------------------------
        //  Band drag (E.6.8 follow-up)
        // -----------------------------------------------------------------

        /** Y-zone of band index `i` (0-based, top-to-bottom). */
        _bandRect(i) {
            const h = (this.canvas?.clientHeight || this.canvas?.height) || 0;
            const bandsH = this.bandHeight * Math.max(1, this.handBands.length);
            const keysH = h - bandsH;
            return { yTop: keysH + i * this.bandHeight, yBot: keysH + (i + 1) * this.bandHeight };
        }

        _bandIndexAt(y) {
            if (!this.handBands || this.handBands.length === 0) return null;
            for (let i = 0; i < this.handBands.length; i++) {
                const r = this._bandRect(i);
                if (y >= r.yTop && y < r.yBot) return i;
            }
            return null;
        }

        _handleMouseDown(e) {
            if (!this.onBandDrag) return;
            const rect = this.canvas.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            const x = (e.clientX || 0) - rect.left;
            const y = (e.clientY || 0) - rect.top;
            const i = this._bandIndexAt(y);
            if (i == null) return;
            const band = this.handBands[i];
            const span = Math.max(0, band.high - band.low);
            const anchorMidi = this._midiAtX(x);
            // Offset between the click and the band's left edge — keeps
            // the band visually under the cursor while dragging.
            const offset = anchorMidi != null ? (anchorMidi - band.low) : 0;
            this._drag = {
                bandIndex: i,
                bandId: band.id,
                span,
                offset,
                moved: false
            };
            if (e.preventDefault) e.preventDefault();
        }

        _handleMouseMove(e) {
            if (!this._drag) return;
            const rect = this.canvas.getBoundingClientRect
                ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
            const cssWidth = (this.canvas?.clientWidth || this.canvas?.width) || 0;
            const xRaw = (e.clientX || 0) - rect.left;
            // Clamp to the canvas's drawable area so a drag past the
            // right edge still pins the anchor at the upper boundary
            // (rangeMax − span) instead of silently doing nothing.
            const x = Math.max(0, Math.min(cssWidth - 1, xRaw));
            let midi = this._midiAtX(x);
            if (midi == null) {
                midi = xRaw <= 0 ? this.rangeMin : this.rangeMax;
            }
            const newAnchor = Math.max(this.rangeMin,
                Math.min(this.rangeMax - this._drag.span, midi - this._drag.offset));
            const band = this.handBands[this._drag.bandIndex];
            if (newAnchor !== band.low) {
                band.low  = newAnchor;
                band.high = newAnchor + this._drag.span;
                this._drag.moved = true;
                this.draw();
            }
        }

        _handleMouseUp() {
            if (!this._drag) return;
            const drag = this._drag;
            this._drag = null;
            if (!drag.moved) return;
            this._suppressNextClick = true;
            const band = this.handBands[drag.bandIndex];
            if (band && this.onBandDrag) {
                this.onBandDrag(drag.bandId, band.low);
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

            // Match canvas pixel size to its CSS size for crisp rendering.
            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
            }
            const ctx = this.ctx;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            const ww = this._whiteKeyWidth();
            const bandsH = this.bandHeight * Math.max(1, this.handBands.length);
            const keysH = h - bandsH;

            // Background
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);

            // Pass 1 — white keys.
            for (let m = this.rangeMin; m <= this.rangeMax; m++) {
                if (isBlackKey(m)) continue;
                const x = this._xOf(m);
                const isActive = this.activeNotes.has(m);
                const isUnplayable = this.unplayableNotes.has(m);
                let fill = '#ffffff';
                if (isUnplayable) fill = '#fee2e2';        // light red
                else if (isActive) fill = '#bfdbfe';       // light blue
                ctx.fillStyle = fill;
                ctx.fillRect(x, 0, ww - 0.5, keysH);
                ctx.strokeStyle = '#9ca3af';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x, 0, ww - 0.5, keysH);
                if (isUnplayable) {
                    // Heavier red border so it pops against neighbouring whites.
                    ctx.strokeStyle = '#dc2626';
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(x + 0.5, 0.5, ww - 1.5, keysH - 1);
                }
            }

            // Pass 2 — black keys (drawn on top).
            const blackH = keysH * 0.6;
            const blackW = ww * 0.6;
            for (let m = this.rangeMin; m <= this.rangeMax; m++) {
                if (!isBlackKey(m)) continue;
                const x = this._xOf(m);
                const isActive = this.activeNotes.has(m);
                const isUnplayable = this.unplayableNotes.has(m);
                ctx.fillStyle = isUnplayable ? '#dc2626' : (isActive ? '#1d4ed8' : '#1f2937');
                ctx.fillRect(x, 0, blackW, blackH);
            }

            // Pass 3 — hand bands (under the keys).
            for (let i = 0; i < this.handBands.length; i++) {
                const band = this.handBands[i];
                const lo = Math.max(this.rangeMin, band.low);
                const hi = Math.min(this.rangeMax, band.high);
                if (hi < lo) continue;
                const x1 = this._xOf(lo);
                const x2 = this._xOf(hi) + (isBlackKey(hi) ? blackW : ww);
                const yTop = keysH + i * this.bandHeight;
                ctx.fillStyle = rgbaWithAlpha(band.color, 0.4);
                ctx.fillRect(x1, yTop, Math.max(2, x2 - x1), this.bandHeight - 1);
                ctx.strokeStyle = band.color;
                ctx.lineWidth = 1;
                ctx.strokeRect(x1, yTop + 0.5, Math.max(2, x2 - x1), this.bandHeight - 2);
            }
        }

        destroy() {
            if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
                this.canvas.removeEventListener('click',     this._clickHandler);
                this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
                this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
            }
            if (typeof document !== 'undefined') {
                document.removeEventListener('mouseup', this._mouseUpHandler);
            }
            this.activeNotes.clear();
            this.unplayableNotes.clear();
            this.handBands = [];
            this._drag = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.KeyboardPreview = KeyboardPreview;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = KeyboardPreview;
    }
})();
