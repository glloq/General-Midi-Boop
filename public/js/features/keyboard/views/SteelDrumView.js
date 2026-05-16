// =============================================================================
// SteelDrumView.js — Steel pan / steel drum (GM 114).
// =============================================================================
// Notes laid out as sections around a circle (as on a real tenor pan).
// Two chromatic octaves C4..B5 positioned radially. Strike on
// pointerdown, global pointerup release. Self-owned DOM.
// =============================================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    const LO = 60, HI = 83; // C4..B5 (24 sections)

    class SteelDrumView extends InstrumentView {
        static viewKind = 'steel-drum';
        static iconUrl = '/assets/instruments/steel_drums.svg';
        static emoji = '🛢️';
        static labelKey = 'keyboard.viewSteelDrum';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;
            document.getElementById('steel-drum-container')?.remove();

            const root = document.createElement('div');
            root.id = 'steel-drum-container';
            root.className = 'steel-drum-view';
            // Responsive pan: square that shrinks with the modal (never wider
            // than the viewport), positions + tile size are PERCENT-based so
            // the whole range always fits with no overlap and no manual zoom.
            root.style.cssText =
                'position:relative;width:min(440px,92%);max-width:100%;'
                + 'aspect-ratio:1/1;margin:auto;border-radius:50%;'
                + 'background:radial-gradient(#5a5f66,#2c2f33);touch-action:none;';

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            // QA: follow the instrument's configured range, not a fixed span.
            const r = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const lo = r ? r.min : LO;
            const hi = r ? r.max : HI;
            const n = Math.max(1, hi - lo + 1);

            // Ring radius = 38 % of the pan. The tile diameter must not
            // exceed the centre-to-centre arc between two adjacent tiles
            // (2·R·sin(π/n)); clamp it to a sane on-screen range.
            const Rpct = 38;
            const arcPct = 2 * Rpct * Math.sin(Math.PI / n);
            const tilePct = Math.max(5, Math.min(20, arcPct * 0.85));

            for (let i = 0; i < n; i++) {
                const midi = lo + i;
                const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
                const cx = 50 + Math.cos(ang) * Rpct;
                const cy = 50 + Math.sin(ang) * Rpct;
                const s = document.createElement('button');
                s.type = 'button';
                s.className = 'steel-section';
                s.dataset.note = String(midi);
                s.title = label(midi);
                s.style.cssText =
                    'position:absolute;border-radius:50%;'
                    + `width:${tilePct.toFixed(2)}%;aspect-ratio:1/1;`
                    + `left:${cx.toFixed(2)}%;top:${cy.toFixed(2)}%;`
                    + 'transform:translate(-50%,-50%);box-sizing:border-box;'
                    + 'border:1px solid #888;background:#9aa3ab;color:#1a1a1a;'
                    + 'cursor:pointer;font:10px sans-serif;'
                    + 'display:flex;align-items:center;justify-content:center;'
                    + 'overflow:hidden;';
                s.textContent = label(midi);
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    s.style.background = c.bg;
                    s.style.color = c.text;
                }
                root.appendChild(s);
            }
            canvas.appendChild(root);

            this._root = root;
            this._pressed = new Map();
            this._onDown = (e) => this._press(e);
            this._onDocUp = () => this._releaseAll();
            root.addEventListener('pointerdown', this._onDown);
            document.addEventListener('pointerup', this._onDocUp);
            document.addEventListener('pointercancel', this._onDocUp);
        }

        _press(e) {
            const cell = e.target && e.target.closest
                ? e.target.closest('.steel-section') : null;
            if (!cell || !this._root.contains(cell)) return;
            if (e.cancelable) e.preventDefault();
            const key = cell.dataset.note;
            if (this._pressed.has(key)) return;
            const note = parseInt(key, 10);
            this._pressed.set(key, note);
            cell.classList.add('active');
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.playNote === 'function') modal.playNote(note);
        }

        _releaseAll() {
            if (!this._pressed || this._pressed.size === 0) return;
            const modal = this.ctx && this.ctx.modal;
            for (const [key, note] of [...this._pressed]) {
                this._pressed.delete(key);
                const cell = this._root
                    ? this._root.querySelector(`.steel-section[data-note="${key}"]`) : null;
                if (cell) cell.classList.remove('active');
                if (modal && typeof modal.stopNote === 'function') modal.stopNote(note);
            }
        }

        unmount() {
            this._releaseAll();
            if (this._root) {
                this._root.removeEventListener('pointerdown', this._onDown);
                this._root.remove();
                this._root = null;
            }
            document.removeEventListener('pointerup', this._onDocUp);
            document.removeEventListener('pointercancel', this._onDocUp);
            this._pressed = null;
            super.unmount();
        }

        setActiveNotes(activeMidiSet) {
            if (!this._root) return;
            const set = activeMidiSet instanceof Set ? activeMidiSet : new Set();
            this._root.querySelectorAll('.steel-section').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.note)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }

    }

    if (typeof window !== 'undefined') window.SteelDrumView = SteelDrumView;
    if (typeof module !== 'undefined') module.exports = SteelDrumView;
})();
