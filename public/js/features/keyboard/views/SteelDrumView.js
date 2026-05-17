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
            // Responsive pan: positions + pocket sizes are PERCENT-based so
            // the whole range always fits with no overlap and no manual zoom.
            // The metallic look (concave bowl, rolled rim, hammered texture)
            // lives in keyboard.css; JS owns only the polar geometry below.

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            // QA: follow the instrument's configured range, not a fixed span.
            const r = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const lo = r ? r.min : LO;
            const hi = r ? r.max : HI;
            const n = Math.max(1, hi - lo + 1);

            // Ring radius = 38 % of the pan. A pocket diameter must never
            // exceed the centre-to-centre arc between two adjacent pockets
            // (2·R·sin(π/n)). Real pans have larger pockets for low notes:
            // each is scaled 1.30×(lowest) → 0.75×(highest); the base is
            // derived so even the largest still fits the arc (no overlap).
            const Rpct = 38;
            const arcPct = 2 * Rpct * Math.sin(Math.PI / n);
            const maxTile = arcPct * 0.92;
            const baseTile = Math.max(4.5, Math.min(16, maxTile / 1.30));

            for (let i = 0; i < n; i++) {
                const midi = lo + i;
                const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
                const cx = 50 + Math.cos(ang) * Rpct;
                const cy = 50 + Math.sin(ang) * Rpct;
                const pitch = n > 1 ? i / (n - 1) : 0;   // 0 = low … 1 = high
                const tilePct = Math.max(
                    4, Math.min(maxTile, baseTile * (1.30 - 0.55 * pitch)));
                const s = document.createElement('button');
                s.type = 'button';
                s.className = 'steel-section';
                s.dataset.note = String(midi);
                s.title = label(midi);
                // Only the computed polar placement is inline; the metallic
                // pocket look is in keyboard.css (.steel-section).
                s.style.cssText =
                    `width:${tilePct.toFixed(2)}%;`
                    + `left:${cx.toFixed(2)}%;top:${cy.toFixed(2)}%;`;
                const lbl = document.createElement('span');
                lbl.className = 'steel-section-label';
                lbl.textContent = label(midi);
                s.appendChild(lbl);
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    s.style.background = c.bg;
                    lbl.style.color = c.text;
                }
                root.appendChild(s);
            }
            canvas.appendChild(root);

            this._root = root;
            this._pressed = new Map();
            // Piano-like drag: slide across the sections for a glissando.
            this._initGlide({ root, selector: '.steel-section' });
        }

        _glideKey(cell) { return cell.dataset.note; }

        _pressCell(cell) {
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
            this._teardownGlide();
            if (this._root) {
                this._root.remove();
                this._root = null;
            }
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
