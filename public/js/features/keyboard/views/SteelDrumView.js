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
        static emoji = '🥁';
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
            root.style.cssText =
                'position:relative;width:340px;height:340px;margin:auto;'
                + 'border-radius:50%;background:radial-gradient(#5a5f66,#2c2f33);'
                + 'touch-action:none;';

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            const n = HI - LO + 1;
            for (let i = 0; i < n; i++) {
                const midi = LO + i;
                const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
                const R = 130;
                const cx = 170 + Math.cos(ang) * R;
                const cy = 170 + Math.sin(ang) * R;
                const s = document.createElement('button');
                s.type = 'button';
                s.className = 'steel-section';
                s.dataset.note = String(midi);
                s.title = label(midi);
                s.style.cssText =
                    'position:absolute;width:48px;height:48px;border-radius:50%;'
                    + `left:${Math.round(cx - 24)}px;top:${Math.round(cy - 24)}px;`
                    + 'border:1px solid #888;background:#9aa3ab;color:#1a1a1a;'
                    + 'cursor:pointer;font:10px sans-serif;';
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

        toolbarGroups() { return new Set(['velocity', 'view-mode']); }
    }

    if (typeof window !== 'undefined') window.SteelDrumView = SteelDrumView;
    if (typeof module !== 'undefined') module.exports = SteelDrumView;
})();
