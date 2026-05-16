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
        static iconUrl = '/assets/instruments/harp.svg';
        static emoji = '🪕';
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

            // Strings follow the note selection configured in the
            // instrument-settings modal. For a harp (GM 46) that modal
            // does NOT expose the guitar "strings/tuning" tab — the
            // playable notes come from the Notes section saved in
            // capabilities and surfaced via getInstrumentNoteRange():
            //   • discrete selection → render EXACTLY those MIDI notes
            //     (count matches what the user entered, accidentals kept);
            //   • continuous range  → diatonic strings across the range
            //     (a harp is a diatonic instrument — accidentals are
            //     pedal/lever changes, not separate strings).
            // The configured selection always wins over the 47-string
            // Harpe preset; that preset is only the last resort when no
            // range is available at all (e.g. no instrument selected).
            let STRINGS;
            const rng = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            if (rng && Array.isArray(rng.notes) && rng.notes.length) {
                STRINGS = rng.notes.slice();
            } else if (rng && Number.isFinite(rng.min) && Number.isFinite(rng.max)) {
                STRINGS = diatonicStrings(rng.min, rng.max);
            } else {
                const cfg = modal._harpStringConfig;
                STRINGS = (cfg && Array.isArray(cfg.tuning) && cfg.tuning.length)
                    ? cfg.tuning.slice()
                    : diatonicStrings(DEFAULT_LO, DEFAULT_HI);
            }

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
                    + 'display:flex;flex-direction:column;'
                    + 'justify-content:flex-end;align-items:center;padding:0;'
                    + 'border:none;border-radius:3px;cursor:pointer;'
                    + 'background:' + (isC ? '#c0392b' : isF ? '#2c3e50' : '#cfd6dc')
                    + ';opacity:.85;transition:opacity .05s;';
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    s.style.background = modal.getNoteColor(midi).bg;
                }
                // Visible note label in the header-selected format
                // (US / FR / MIDI via modal.getNoteLabel). Vertical text so
                // it stays legible on a narrow string. pointer-events:none
                // keeps elementFromPoint hit-testing on the string itself.
                const lbl = document.createElement('span');
                lbl.className = 'harp-string-label';
                lbl.textContent = label(midi);
                lbl.style.cssText =
                    'pointer-events:none;user-select:none;white-space:nowrap;'
                    + 'font-size:10px;line-height:1;padding:4px 0;'
                    + 'color:' + (isC || isF ? '#f5f7fa' : '#1b2733')
                    + ';writing-mode:vertical-rl;text-orientation:mixed;';
                s.appendChild(lbl);
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

        // Resolve the string under the pointer. During a drag, pointermove
        // keeps e.target on the element that received pointerdown (implicit
        // pointer capture), so a glissando must hit-test the live pointer
        // position via elementFromPoint. Falls back to e.target (covers
        // synthetic test events with no coordinates).
        _resolveCell(e) {
            let el = null;
            if (typeof document.elementFromPoint === 'function'
                && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
                el = document.elementFromPoint(e.clientX, e.clientY);
            }
            if (!el && e.target) el = e.target;
            const cell = el && el.closest ? el.closest('.harp-string') : null;
            return (cell && this._root && this._root.contains(cell)) ? cell : null;
        }

        _pluck(e) {
            const cell = this._resolveCell(e);
            if (!cell) return;
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

    }

    if (typeof window !== 'undefined') window.HarpView = HarpView;
    if (typeof module !== 'undefined') module.exports = HarpView;
})();
