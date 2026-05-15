// =============================================================================
// KalimbaView.js — Kalimba / mbira (GM 108).
// =============================================================================
// 17 tines, C-major, in the authentic centre-out alternating physical
// order: the lowest tine sits in the middle, the next one to its right,
// the next to its left, and so on outward. Pluck on pointerdown, global
// pointerup release. Self-owned DOM.
// =============================================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    // 17 ascending C-major notes from C4 (60).
    const SCALE = [0, 2, 4, 5, 7, 9, 11];
    const ASC = (() => {
        const out = [];
        for (let i = 0; out.length < 17; i++) {
            out.push(60 + Math.floor(i / 7) * 12 + SCALE[i % 7]);
        }
        return out;
    })();
    // Physical centre-out order: middle = lowest, then R, L, R, L …
    const PHYSICAL = (() => {
        const n = ASC.length;
        const pos = new Array(n);
        const mid = Math.floor(n / 2);
        let r = mid, l = mid;
        pos[mid] = ASC[0];
        for (let i = 1; i < n; i++) {
            if (i % 2 === 1) { r += 1; pos[r] = ASC[i]; }
            else { l -= 1; pos[l] = ASC[i]; }
        }
        return pos;
    })();

    class KalimbaView extends InstrumentView {
        static viewKind = 'kalimba';
        static emoji = '🎵';
        static labelKey = 'keyboard.viewKalimba';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;
            document.getElementById('kalimba-container')?.remove();

            const root = document.createElement('div');
            root.id = 'kalimba-container';
            root.className = 'kalimba-view';
            // Top-anchored: tines hang from the top edge and extend
            // downward (played from the top, like a real kalimba).
            root.style.cssText =
                'display:flex;align-items:flex-start;justify-content:center;'
                + 'gap:4px;padding:18px;height:100%;touch-action:none;';

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            const mid = Math.floor(PHYSICAL.length / 2);

            PHYSICAL.forEach((midi, idx) => {
                // Taller toward the centre (longer tine = lower pitch).
                const h = 60 + (1 - Math.abs(idx - mid) / mid) * 80;
                const t = document.createElement('button');
                t.type = 'button';
                t.className = 'kalimba-tine';
                t.dataset.idx = String(idx);
                t.dataset.note = String(midi);
                t.title = label(midi);
                t.style.cssText =
                    `width:24px;height:${Math.round(h)}px;border:none;`
                    + 'border-radius:3px 3px 10px 10px;cursor:pointer;'
                    + 'background:linear-gradient(#9aa3ab,#cfd6dc);'
                    + 'position:relative;display:flex;align-items:flex-end;'
                    + 'justify-content:center;padding-bottom:4px;';
                // Note label printed along the tine (uses the global
                // US/FR/MIDI format via modal.getNoteLabel).
                const lbl = document.createElement('span');
                lbl.className = 'kalimba-tine-label';
                lbl.textContent = label(midi);
                lbl.style.cssText =
                    'writing-mode:vertical-rl;text-orientation:mixed;'
                    + 'transform:rotate(180deg);font:10px/1 sans-serif;'
                    + 'color:#1a1a1a;pointer-events:none;user-select:none;';
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    t.style.background = c.bg;
                    lbl.style.color = c.text;
                }
                t.appendChild(lbl);
                root.appendChild(t);
            });

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
                ? e.target.closest('.kalimba-tine') : null;
            if (!cell || !this._root.contains(cell)) return;
            if (e.cancelable) e.preventDefault();
            const key = cell.dataset.idx;
            if (this._pressed.has(key)) return;
            const note = parseInt(cell.dataset.note, 10);
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
                    ? this._root.querySelector(`.kalimba-tine[data-idx="${key}"]`) : null;
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
            this._root.querySelectorAll('.kalimba-tine').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.idx)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }

        toolbarGroups() { return new Set(['notation', 'velocity', 'view-mode']); }
    }

    if (typeof window !== 'undefined') window.KalimbaView = KalimbaView;
    if (typeof module !== 'undefined') module.exports = KalimbaView;
})();
