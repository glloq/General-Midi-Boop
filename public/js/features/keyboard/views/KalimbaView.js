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

    // Default = 17 diatonic tines from C4 (60) when nothing is configured.
    const DEFAULT_LO = 60, DEFAULT_COUNT = 17;
    const DEFAULT_STEPS = [0, 2, 4, 5, 7, 9, 11];

    // Ascending list of every note to render. Priority:
    //   1. explicit discrete note set (instrument settings — keeps sharps)
    //   2. all chromatic notes within [min,max] (range mode — keeps sharps)
    //   3. diatonic default of DEFAULT_COUNT tines from DEFAULT_LO
    function ascending(rng) {
        if (rng && Array.isArray(rng.notes) && rng.notes.length) {
            return [...rng.notes]
                .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        }
        const lo = rng && Number.isFinite(rng.min) ? rng.min : DEFAULT_LO;
        const hi = rng && Number.isFinite(rng.max) ? rng.max : undefined;
        const out = [];
        if (Number.isFinite(hi)) {
            for (let n = lo; n <= hi; n++) out.push(n);
        }
        if (!out.length) {
            for (let i = 0; out.length < DEFAULT_COUNT; i++) {
                out.push(lo + Math.floor(i / 7) * 12 + DEFAULT_STEPS[i % 7]);
            }
        }
        return out;
    }

    // Physical centre-out order: middle = lowest, then R, L, R, L …
    function physical(asc) {
        const n = asc.length;
        const pos = new Array(n);
        const mid = Math.floor(n / 2);
        let r = mid, l = mid;
        pos[mid] = asc[0];
        for (let i = 1; i < n; i++) {
            if (i % 2 === 1) { r += 1; pos[r] = asc[i]; }
            else { l -= 1; pos[l] = asc[i]; }
        }
        return pos;
    }

    class KalimbaView extends InstrumentView {
        static viewKind = 'kalimba';
        static iconUrl = '/assets/instruments/kalimba.svg';
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
            // Layout, wooden body and resonance hole live in keyboard.css.
            root.className = 'kalimba-view';

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);

            // QA: tines follow the instrument's configured notes/range.
            const rng = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const PHYSICAL = physical(ascending(rng));
            const mid = Math.floor(PHYSICAL.length / 2);

            PHYSICAL.forEach((midi, idx) => {
                // Taller toward the centre (longer tine = lower pitch);
                // ~110px at the edges up to ~260px in the middle so the
                // long centre tines hang down over the resonance hole.
                const h = 110 + (1 - Math.abs(idx - mid) / (mid || 1)) * 150;
                const t = document.createElement('button');
                t.type = 'button';
                t.className = 'kalimba-tine';
                t.dataset.idx = String(idx);
                t.dataset.note = String(midi);
                t.title = label(midi);
                t.style.height = `${Math.round(h)}px`;
                // Note label printed along the tine (uses the global
                // US/FR/MIDI format via modal.getNoteLabel).
                const lbl = document.createElement('span');
                lbl.className = 'kalimba-tine-label';
                lbl.textContent = label(midi);
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
            // Piano-like drag: slide across the tines for a glissando.
            this._initGlide({ root, selector: '.kalimba-tine' });
        }

        _glideKey(cell) { return cell.dataset.idx; }

        _pressCell(cell) {
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
            this._root.querySelectorAll('.kalimba-tine').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.idx)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }

    }

    if (typeof window !== 'undefined') window.KalimbaView = KalimbaView;
    if (typeof module !== 'undefined') module.exports = KalimbaView;
})();
