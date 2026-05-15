// =============================================================================
// HarpView.js — Concert-harp view (GM 46): vertical strings + glissando.
// =============================================================================
// Second self-owned-DOM view (after HarmonicaView). 22 vertical strings,
// C-major diatonic from C3 (MIDI 48) up three octaves to C6 — matching the
// historical 22-string harp preset. Pluck a string with pointerdown;
// dragging horizontally across strings performs a glissando (each newly
// entered string is plucked). A single global pointerup releases every
// ringing string (same model as HarmonicaView / handleGlobalMouseUp).
//
// Traditional colour cue: C strings red, F strings dark — the reference
// landmarks a harpist uses.
//
// Detection: InstrumentDetector excludes GM 46 from the fretboard range
// and maps it to viewKind 'harp'; registerBuiltins adds a matching rule
// *before* the 24-47 fretboard rule. An explicit instrument_type='string'
// or a manual stringInstrumentConfig still forces the fretboard view.
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    // C-major diatonic. Default span C3 (48) → C6 (84) when the
    // instrument declares no range.
    const SCALE = new Set([0, 2, 4, 5, 7, 9, 11]);
    const DEFAULT_LO = 48, DEFAULT_HI = 84;

    // Diatonic (C-major) MIDI notes within [lo,hi] inclusive.
    function diatonicStrings(lo, hi) {
        const out = [];
        for (let n = lo; n <= hi; n++) if (SCALE.has(((n % 12) + 12) % 12)) out.push(n);
        return out.length ? out : [lo];
    }

    class HarpView extends InstrumentView {
        static viewKind = 'harp';
        static emoji = '🎵';
        static labelKey = 'keyboard.viewHarp';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;

            document.getElementById('harp-container')?.remove();

            const root = document.createElement('div');
            root.id = 'harp-container';
            root.className = 'harp-view';
            root.style.cssText =
                'display:flex;align-items:stretch;justify-content:center;'
                + 'gap:4px;padding:18px;height:100%;touch-action:none;';

            const label = (typeof modal.getNoteLabel === 'function')
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);

            // QA: strings span the instrument's configured range.
            const rng = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const STRINGS = diatonicStrings(
                rng ? rng.min : DEFAULT_LO, rng ? rng.max : DEFAULT_HI);

            STRINGS.forEach((midi, idx) => {
                const cls = midi % 12;
                const isC = cls === 0;
                const isF = cls === 5;
                const s = document.createElement('button');
                s.type = 'button';
                s.className = 'harp-string'
                    + (isC ? ' harp-string-c' : isF ? ' harp-string-f' : '');
                s.dataset.idx = String(idx);
                s.dataset.note = String(midi);
                s.title = label(midi);
                s.style.cssText =
                    'flex:1 1 0;min-width:16px;max-width:34px;height:100%;'
                    + 'border:none;border-radius:3px;cursor:pointer;'
                    + 'background:' + (isC ? '#c0392b' : isF ? '#2c3e50' : '#cfd6dc')
                    + ';opacity:.85;transition:opacity .05s;';
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    s.style.background = modal.getNoteColor(midi).bg;
                }
                root.appendChild(s);
            });

            canvas.appendChild(root);
            this._root = root;
            this._pressed = new Map(); // idx -> midi
            this._isDown = false;

            this._onDown = (e) => { this._isDown = true; this._pluck(e); };
            this._onMove = (e) => { if (this._isDown) this._pluck(e); };
            this._onDocUp = () => { this._isDown = false; this._releaseAll(); };
            root.addEventListener('pointerdown', this._onDown);
            root.addEventListener('pointermove', this._onMove);
            document.addEventListener('pointerup', this._onDocUp);
            document.addEventListener('pointercancel', this._onDocUp);
        }

        _pluck(e) {
            const cell = e.target && e.target.closest
                ? e.target.closest('.harp-string') : null;
            if (!cell || !this._root || !this._root.contains(cell)) return;
            if (e.cancelable) e.preventDefault();
            const idx = cell.dataset.idx;
            if (this._pressed.has(idx)) return;        // already ringing
            const midi = parseInt(cell.dataset.note, 10);
            this._pressed.set(idx, midi);
            cell.classList.add('active');
            cell.style.opacity = '1';
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.playNote === 'function') modal.playNote(midi);
        }

        _releaseAll() {
            if (!this._pressed || this._pressed.size === 0) return;
            const modal = this.ctx && this.ctx.modal;
            for (const [idx, midi] of [...this._pressed]) {
                this._pressed.delete(idx);
                const cell = this._root
                    ? this._root.querySelector(`.harp-string[data-idx="${idx}"]`)
                    : null;
                if (cell) { cell.classList.remove('active'); cell.style.opacity = '.85'; }
                if (modal && typeof modal.stopNote === 'function') modal.stopNote(midi);
            }
        }

        unmount() {
            this._isDown = false;
            this._releaseAll();
            if (this._root) {
                this._root.removeEventListener('pointerdown', this._onDown);
                this._root.removeEventListener('pointermove', this._onMove);
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
            this._root.querySelectorAll('.harp-string').forEach(cell => {
                const midi = parseInt(cell.dataset.note, 10);
                const on = this._pressed?.has(cell.dataset.idx) || set.has(midi);
                cell.classList.toggle('active', on);
                cell.style.opacity = on ? '1' : '.85';
            });
        }

        toolbarGroups() {
            // Diatonic plucked strings: notation + velocity + the view-mode
            // toggle (escape back to piano). No octave/minimap/pitch-bend.
            return new Set(['notation', 'velocity', 'view-mode']);
        }
    }

    if (typeof window !== 'undefined') window.HarpView = HarpView;
    if (typeof module !== 'undefined') module.exports = HarpView;
})();
