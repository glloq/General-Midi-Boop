// =============================================================================
// AccordionView.js — Accordion (GM 21 Accordion / 23 Tango Accordion).
// =============================================================================
// Right-hand 2-octave chromatic treble strip + 12 Stradella bass root
// buttons + a bellows slider whose pressure scales note velocity
// (willPlayNote). Self-owned DOM (no legacy-mixin delegation).
//
// GM 22 (Harmonica) is deliberately NOT routed here — it has its own
// HarmonicaView. registerBuiltins maps 21 & 23 to 'accordion'.
// =============================================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    const TREBLE_LO = 60, TREBLE_HI = 83;   // C4..B5 chromatic (24 keys)
    const BASS_LO = 36, BASS_HI = 47;       // C2..B2 Stradella roots (12)

    class AccordionView extends InstrumentView {
        static viewKind = 'accordion';
        static emoji = '🪗';
        static labelKey = 'keyboard.viewAccordion';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;
            document.getElementById('accordion-container')?.remove();

            const root = document.createElement('div');
            root.id = 'accordion-container';
            root.className = 'accordion-view';
            root.style.cssText =
                'display:flex;flex-direction:column;gap:10px;padding:16px;'
                + 'align-items:center;justify-content:center;height:100%;'
                + 'touch-action:none;';

            // Bellows (pressure → velocity factor)
            this._bellows = 64;
            const bellows = document.createElement('input');
            bellows.type = 'range';
            bellows.id = 'accordion-bellows';
            bellows.min = '0'; bellows.max = '127'; bellows.value = '64';
            bellows.style.cssText = 'width:60%;';
            bellows.addEventListener('input', () => {
                this._bellows = parseInt(bellows.value, 10) || 0;
            });
            root.appendChild(bellows);

            // QA #2: the right-hand (treble) follows the configured range.
            const r = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const tLo = r ? r.min : TREBLE_LO;
            const tHi = r ? r.max : TREBLE_HI;

            // QA #3: instrument-specific accordion settings (hands +
            // bass system) from the per-instrument capabilities.
            const acfg = typeof modal.getAccordionConfig === 'function'
                ? modal.getAccordionConfig() : { bass_system: 'stradella', hands: 'both' };

            if (acfg.hands === 'both' || acfg.hands === 'right') {
                root.appendChild(this._row('accordion-treble', tLo, tHi, modal, '#2b3a4a'));
            }
            if (acfg.hands === 'both' || acfg.hands === 'left') {
                if (acfg.bass_system === 'stradella') {
                    // 12 Stradella root buttons (fixed).
                    root.appendChild(this._row('accordion-bass', BASS_LO, BASS_HI, modal, '#3a2b3a'));
                } else {
                    // Free-bass / chromatic: a chromatic left-hand keyboard
                    // one octave below the treble's low note.
                    const bHi = (r ? r.min : TREBLE_LO) - 1;
                    const bLo = bHi - 23;            // 2 octaves
                    root.appendChild(this._row('accordion-bass', bLo, bHi, modal, '#3a2b3a'));
                }
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

        _row(cls, lo, hi, modal, bg) {
            const row = document.createElement('div');
            row.className = `accordion-row ${cls}`;
            row.style.cssText = 'display:flex;gap:4px;';
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            for (let n = lo; n <= hi; n++) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'accordion-key';
                b.dataset.note = String(n);
                b.title = label(n);
                b.style.cssText =
                    'width:34px;height:54px;border:1px solid #333;border-radius:4px;'
                    + `background:${bg};color:#e8e8e8;cursor:pointer;font:11px sans-serif;`;
                b.textContent = label(n);
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(n);
                    b.style.background = c.bg;
                    b.style.color = c.text;
                }
                row.appendChild(b);
            }
            return row;
        }

        _press(e) {
            const cell = e.target && e.target.closest
                ? e.target.closest('.accordion-key') : null;
            if (!cell || !this._root.contains(cell)) return;
            if (e.cancelable) e.preventDefault();
            const note = parseInt(cell.dataset.note, 10);
            const key = cell.dataset.note;
            if (this._pressed.has(key)) return;
            this._pressed.set(key, note);
            cell.classList.add('active');
            const modal = this.ctx && this.ctx.modal;
            // Bellows pressure scales velocity via willPlayNote(), which the
            // base KeyboardModal.playNote() now invokes for the active view
            // (KM-C4) — no local workaround needed.
            if (modal && typeof modal.playNote === 'function') modal.playNote(note);
        }

        _releaseAll() {
            if (!this._pressed || this._pressed.size === 0) return;
            const modal = this.ctx && this.ctx.modal;
            for (const [key, note] of [...this._pressed]) {
                this._pressed.delete(key);
                const cell = this._root
                    ? this._root.querySelector(`.accordion-key[data-note="${key}"]`) : null;
                if (cell) cell.classList.remove('active');
                if (modal && typeof modal.stopNote === 'function') modal.stopNote(note);
            }
        }

        // Bellows pressure scales velocity (centre 64 = ×1).
        willPlayNote(midi, velocity, opts) {
            const factor = Math.max(0.1, Math.min(2, (this._bellows || 64) / 64));
            return { midi, velocity: Math.max(1, Math.min(127, Math.round(velocity * factor))), opts };
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
            this._root.querySelectorAll('.accordion-key').forEach(cell => {
                const midi = parseInt(cell.dataset.note, 10);
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.note) || set.has(midi));
            });
        }

        toolbarGroups() { return new Set(['notation', 'velocity', 'view-mode']); }
    }

    if (typeof window !== 'undefined') window.AccordionView = AccordionView;
    if (typeof module !== 'undefined') module.exports = AccordionView;
})();
