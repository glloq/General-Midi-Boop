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

            // QA #3/#4: per-side play possibilities (NO hand show/hide —
            // an accordion always has both sides).
            const acfg = typeof modal.getAccordionConfig === 'function'
                ? modal.getAccordionConfig()
                : { bass_system: 'stradella', right_display: 'buttons' };

            // Two distinct sides, always both present: left side (bass) on
            // the left, right side (melody) on the right.
            const sides = document.createElement('div');
            sides.className = 'accordion-sides';
            sides.style.cssText =
                'display:flex;gap:24px;align-items:flex-start;'
                + 'justify-content:center;flex:1;width:100%;';

            // Left side — bass, per the configured bass system.
            let bass;
            if (acfg.bass_system === 'stradella') {
                bass = this._row('accordion-bass', BASS_LO, BASS_HI, modal, '#3a2b3a');
            } else {
                const bHi = (r ? r.min : TREBLE_LO) - 1;
                bass = this._row('accordion-bass', bHi - 23, bHi, modal, '#3a2b3a');
            }
            sides.appendChild(this._zone(
                `Côté gauche · ${acfg.bass_system === 'stradella' ? 'Stradella' : 'Basses libres'}`,
                bass));

            // Right side — melody, buttons or piano keyboard.
            const right = acfg.right_display === 'keyboard'
                ? this._pianoRow('accordion-treble', tLo, tHi, modal)
                : this._row('accordion-treble', tLo, tHi, modal, '#2b3a4a');
            sides.appendChild(this._zone(
                `Côté droit · ${acfg.right_display === 'keyboard' ? 'Clavier' : 'Boutons'}`,
                right));

            root.appendChild(sides);
            canvas.appendChild(root);
            this._root = root;
            this._pressed = new Map();
            this._onDown = (e) => this._press(e);
            this._onDocUp = () => this._releaseAll();
            root.addEventListener('pointerdown', this._onDown);
            document.addEventListener('pointerup', this._onDocUp);
            document.addEventListener('pointercancel', this._onDocUp);
        }

        // Titled, bordered panel around one hand's controls (QA #4).
        _zone(title, contentEl) {
            const z = document.createElement('div');
            z.className = 'accordion-zone';
            z.style.cssText =
                'display:flex;flex-direction:column;gap:6px;padding:10px;'
                + 'border:1px solid #444;border-radius:8px;background:#1f1f24;';
            const h = document.createElement('div');
            h.className = 'accordion-zone-title';
            h.textContent = title;
            h.style.cssText = 'font:11px sans-serif;color:#9fb3c8;text-align:center;';
            z.appendChild(h);
            z.appendChild(contentEl);
            return z;
        }

        // Piano-style right hand (QA #4 "option clavier"): white keys in a
        // flex row, black keys absolutely positioned over the gaps. Keeps
        // the `.accordion-key` contract so press/release logic is shared.
        _pianoRow(cls, lo, hi, modal) {
            const BLACK = new Set([1, 3, 6, 8, 10]);
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            let whites = 0;
            for (let n = lo; n <= hi; n++) if (!BLACK.has(((n % 12) + 12) % 12)) whites++;
            whites = Math.max(1, whites);
            const W = 100 / whites;

            const row = document.createElement('div');
            row.className = `accordion-row ${cls} accordion-piano`;
            row.style.cssText = 'position:relative;width:' + (whites * 26)
                + 'px;max-width:70vw;height:120px;';
            let wIdx = 0;
            const mk = (n, black, leftPct, wPct, css) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'accordion-key' + (black ? ' accordion-key-black' : '');
                b.dataset.note = String(n);
                b.title = label(n);
                b.style.cssText =
                    'position:absolute;box-sizing:border-box;border:1px solid #222;'
                    + 'cursor:pointer;font:9px sans-serif;display:flex;'
                    + 'align-items:flex-end;justify-content:center;padding-bottom:3px;'
                    + `left:${leftPct}%;width:${wPct}%;${css}`
                    + (black ? 'background:#1a1a1a;color:#eee;z-index:2;'
                             : 'background:#f4f4f4;color:#222;z-index:1;');
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    b.style.background = modal.getNoteColor(n).bg;
                    b.style.color = modal.getNoteColor(n).text;
                }
                return b;
            };
            for (let n = lo; n <= hi; n++) {
                const black = BLACK.has(((n % 12) + 12) % 12);
                if (!black) {
                    row.appendChild(mk(n, false, wIdx * W, W, 'bottom:0;height:100%;'));
                    wIdx++;
                } else {
                    row.appendChild(mk(n, true, wIdx * W - W * 0.3, W * 0.6,
                        'top:0;height:62%;'));
                }
            }
            return row;
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
