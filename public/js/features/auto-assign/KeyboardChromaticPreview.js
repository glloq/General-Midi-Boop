/**
 * @file KeyboardChromaticPreview.js
 * @description Compact chromatic keyboard widget for the keyboard
 * hand-position editor. Used as the bottom-strip preview when the
 * instrument's `hands_config.keyboard_type` isn't `'piano'` —
 * xylophone, marimba, hangdrum, vibraphone, etc. Where
 * `KeyboardPreview` draws white-and-black piano keys, this widget
 * draws every semitone as an identical rectangle (uniform key
 * widths) so the fingers overlay can lay them out without worrying
 * about the white/black geometry.
 *
 * The public API is intentionally identical to `KeyboardPreview`'s
 * subset that the editor consumes — `setRange`, `setHandBands`,
 * `setActiveNotes`, `keyXAt`, `keyWidth`, `draw`, `destroy` — so
 * `_pushFingersState`, `_pushActiveNotesToKeyboard` and everything
 * else can drive either widget without branching on instrument
 * layout.
 *
 * Public API:
 *
 *     const w = new KeyboardChromaticPreview(canvas, {
 *         rangeMin: 21, rangeMax: 108,
 *         bandHeight: 22
 *     });
 *     w.setRange(min, max);
 *     w.setHandBands([{ id, low, high, color }, …]);
 *     w.setActiveNotes([midi, …] | [{ midi, handId }, …]);
 *     w.keyXAt(midi);
 *     w.keyWidth(midi);
 *     w.draw();
 *     w.destroy();
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

    class KeyboardChromaticPreview {
        /**
         * @param {HTMLCanvasElement} canvas
         * @param {Object} [opts]
         */
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.rangeMin = Number.isFinite(opts.rangeMin) ? opts.rangeMin : 21;
            this.rangeMax = Number.isFinite(opts.rangeMax) ? opts.rangeMax : 108;
            this.bandHeight = Number.isFinite(opts.bandHeight) ? opts.bandHeight : 22;
            this.bandFillAlpha = Number.isFinite(opts.bandFillAlpha)
                ? opts.bandFillAlpha : 0.18;
            this._bands = [];
            // midi → handId | null. Active keys override their base
            // tint with the assigned hand's colour (or a generic
            // blue when no hand covers them).
            this._activeNotes = new Map();
            // Public marker so the editor can detect the widget
            // type if it ever needs to (we currently rely on the
            // shared API instead, so nothing reads this).
            this.layout = 'chromatic';
        }

        // -----------------------------------------------------------------
        //  Public setters
        // -----------------------------------------------------------------

        setRange(min, max) {
            const lo = Math.max(0, Math.min(127, Number.isFinite(min) ? min : this.rangeMin));
            const hi = Math.max(0, Math.min(127, Number.isFinite(max) ? max : this.rangeMax));
            this.rangeMin = Math.min(lo, hi);
            this.rangeMax = Math.max(lo, hi);
            this.draw();
        }

        setHandBands(bands) {
            this._bands = Array.isArray(bands) ? bands.filter(b => b
                && Number.isFinite(b.low) && Number.isFinite(b.high)
                && typeof b.color === 'string' && b.id) : [];
            this.draw();
        }

        /** Accepts either `[midi, …]` or `[{ midi, handId }, …]`. */
        setActiveNotes(notes) {
            this._activeNotes = new Map();
            if (Array.isArray(notes)) {
                for (const e of notes) {
                    if (Number.isFinite(e)) {
                        this._activeNotes.set(e, null);
                    } else if (e && Number.isFinite(e.midi)) {
                        this._activeNotes.set(e.midi, e.handId || null);
                    }
                }
            }
            this.draw();
        }

        // -----------------------------------------------------------------
        //  Geometry helpers (mirror KeyboardPreview's public API)
        // -----------------------------------------------------------------

        /** Pixel width of one chromatic cell at the current canvas size. */
        _pxPerNote() {
            const W = (this.canvas && this.canvas.clientWidth) || 0;
            const range = Math.max(1, this.rangeMax - this.rangeMin + 1);
            return W / range;
        }

        /** Pixel x of the LEFT edge of `midi`'s key. Accepts fractional
         *  MIDI values for smooth animation. */
        keyXAt(midi) {
            if (!Number.isFinite(midi)) return 0;
            return (midi - this.rangeMin) * this._pxPerNote();
        }

        /** Pixel width of the key at `midi` (uniform across all
         *  semitones in this layout). */
        keyWidth(/*midi*/) { return this._pxPerNote(); }

        // -----------------------------------------------------------------
        //  Render
        // -----------------------------------------------------------------

        draw() {
            const canvas = this.canvas;
            if (!canvas) return;
            const W = canvas.clientWidth;
            const H = canvas.clientHeight;
            if (W <= 0 || H <= 0) return;

            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            const wantW = Math.round(W * dpr);
            const wantH = Math.round(H * dpr);
            if (canvas.width !== wantW || canvas.height !== wantH) {
                canvas.width = wantW;
                canvas.height = wantH;
            }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, W, H);

            const bandH = this.bandHeight;
            const keysH = H - bandH;
            const range = Math.max(1, this.rangeMax - this.rangeMin + 1);
            const pxPerNote = W / range;

            // Quick id → colour map so active keys can be tinted
            // with their assigned hand's colour.
            const bandColorById = new Map();
            for (const b of this._bands) bandColorById.set(b.id, b.color);

            // Notes as identical cells. C of every octave gets a
            // brighter base tint so the operator finds the octave
            // boundaries quickly. Active notes override the base
            // tint with the hand's colour.
            for (let m = this.rangeMin; m <= this.rangeMax; m++) {
                const x = (m - this.rangeMin) * pxPerNote;
                let fill;
                if (this._activeNotes.has(m)) {
                    const hid = this._activeNotes.get(m);
                    fill = (hid && bandColorById.get(hid)) || '#3b82f6';
                } else {
                    fill = (m % 12 === 0) ? '#f8fafc' : '#cbd5e1';
                }
                ctx.fillStyle = fill;
                ctx.fillRect(x + 0.5, 0, Math.max(1, pxPerNote - 1), keysH);
                if (m % 12 === 0 && pxPerNote > 18) {
                    ctx.fillStyle = this._activeNotes.has(m) ? '#f8fafc' : '#0f172a';
                    ctx.font = '10px sans-serif';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(`C${(m / 12) - 1}`, x + 3, keysH - 2);
                }
            }

            // Hand bands flush against the bottom of the strip,
            // single row (matches KeyboardPreview's bandsOnSingleRow).
            for (const b of this._bands) {
                const lo = Math.max(this.rangeMin, b.low);
                const hi = Math.min(this.rangeMax, b.high);
                if (hi < lo) continue;
                const x1 = (lo - this.rangeMin) * pxPerNote;
                const x2 = (hi - this.rangeMin + 1) * pxPerNote;
                ctx.fillStyle = _bandFill(b.color, this.bandFillAlpha);
                ctx.fillRect(x1, keysH, x2 - x1, bandH);
                ctx.strokeStyle = b.color;
                ctx.lineWidth = 1;
                ctx.strokeRect(x1 + 0.5, keysH + 0.5, x2 - x1 - 1, bandH - 1);
            }
        }

        destroy() {
            this._bands = [];
            this._activeNotes = new Map();
        }
    }

    if (typeof window !== 'undefined') {
        window.KeyboardChromaticPreview = KeyboardChromaticPreview;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { KeyboardChromaticPreview };
    }
})();
