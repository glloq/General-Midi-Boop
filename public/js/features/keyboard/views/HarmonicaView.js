// =============================================================================
// HarmonicaView.js — Diatonic harmonica (GM 22) blow/draw hole layout.
// =============================================================================
// First instrument view that OWNS its DOM (no legacy-mixin delegation) —
// the reference implementation for the "add an instrument view" recipe
// (docs/piano-virtual-modal.md §20). 10-hole C Richter tuning:
//
//   Hole   1   2   3   4   5   6   7   8   9  10
//   Blow  C4  E4  G4  C5  E5  G5  C6  E6  G6  C7
//   Draw  D4  G4  B4  D5  F5  A5  B5  D6  F6  A6
//
// The view lazy-creates #harmonica-container inside the keyboard canvas on
// mount() and removes it (stopping any held note) on unmount(). It plays
// through modal.playNote()/stopNote() so MIDI routing, panel callbacks and
// the active-notes set all behave exactly like the other views.
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    // C diatonic Richter tuning (MIDI, C4 = 60) — reference 10-hole layout.
    const BLOW0 = [60, 64, 67, 72, 76, 79, 84, 88, 91, 96];
    const DRAW0 = [62, 67, 71, 74, 77, 81, 83, 86, 89, 93];

    // Transpose the Richter pattern so hole 1 blow sits at `lo`, then keep
    // only the holes that stay within [lo,hi] — so the number of holes
    // follows the instrument's configured range (QA) instead of a fixed 10.
    function richter(lo, hi) {
        if (!Number.isFinite(lo)) return { blow: BLOW0, draw: DRAW0 };
        const off = lo - BLOW0[0];
        const blow = [], draw = [];
        for (let i = 0; i < BLOW0.length; i++) {
            const b = BLOW0[i] + off, d = DRAW0[i] + off;
            if (Number.isFinite(hi) && (b > hi || d > hi)) break;
            blow.push(b); draw.push(d);
        }
        return blow.length ? { blow, draw } : { blow: [lo], draw: [lo] };
    }

    class HarmonicaView extends InstrumentView {
        static viewKind = 'harmonica';
        static emoji = '🎵';
        static labelKey = 'keyboard.viewHarmonica';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;

            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;

            // Remove a stale container from a previous (crashed) mount.
            document.getElementById('harmonica-container')?.remove();

            const root = document.createElement('div');
            root.id = 'harmonica-container';
            root.className = 'harmonica-view';
            root.style.cssText =
                'display:flex;flex-direction:column;gap:6px;padding:18px;'
                + 'align-items:center;justify-content:center;height:100%;';

            // QA: hole count follows the instrument's configured range.
            const rng = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const { blow, draw } = richter(
                rng ? rng.min : NaN, rng ? rng.max : NaN);
            root.appendChild(this._buildRow('blow', blow, modal));
            root.appendChild(this._buildRow('draw', draw, modal));
            canvas.appendChild(root);
            this._root = root;

            // Pressed holes tracked per (row:idx) so the same MIDI value on
            // two holes (e.g. G4 = hole2 draw & hole3 blow) is independent.
            this._pressed = new Map(); // key "row:idx" -> midi

            // Interaction model mirrors the rest of the modal
            // (KeyboardModal.handleGlobalMouseUp): a hole press starts a
            // note; a single global pointerup/cancel releases every held
            // hole. This is robust against drag-off and avoids stuck notes
            // without per-pointer bookkeeping.
            this._onDown = (e) => this._press(e);
            this._onDocUp = () => this._releaseAll();
            root.addEventListener('pointerdown', this._onDown);
            document.addEventListener('pointerup', this._onDocUp);
            document.addEventListener('pointercancel', this._onDocUp);
        }

        _buildRow(kind, notes, modal) {
            const row = document.createElement('div');
            row.className = `harmonica-row harmonica-row-${kind}`;
            row.style.cssText = 'display:flex;gap:6px;';
            const label = (typeof modal.getNoteLabel === 'function')
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            notes.forEach((midi, idx) => {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = `harmonica-hole harmonica-${kind}`;
                cell.dataset.row = kind;
                cell.dataset.idx = String(idx);
                cell.dataset.note = String(midi);
                cell.style.cssText =
                    'width:46px;height:64px;border-radius:6px;cursor:pointer;'
                    + 'border:1px solid #3a3a3a;background:'
                    + (kind === 'blow' ? '#2b3a4a' : '#3a2b3a')
                    + ';color:#e8e8e8;font:12px/1.2 sans-serif;'
                    + 'display:flex;flex-direction:column;align-items:center;'
                    + 'justify-content:center;gap:2px;touch-action:none;';
                cell.innerHTML =
                    `<span class="harmonica-hole-num">${idx + 1}</span>`
                    + `<span class="harmonica-hole-note">${label(midi)}</span>`;
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    cell.style.background = c.bg;
                    cell.style.color = c.text;
                }
                row.appendChild(cell);
            });
            return row;
        }

        _press(e) {
            const cell = e.target && e.target.closest
                ? e.target.closest('.harmonica-hole') : null;
            if (!cell || !this._root || !this._root.contains(cell)) return;
            e.preventDefault();
            const key = `${cell.dataset.row}:${cell.dataset.idx}`;
            if (this._pressed.has(key)) return;
            const midi = parseInt(cell.dataset.note, 10);
            this._pressed.set(key, midi);
            cell.classList.add('active');
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.playNote === 'function') modal.playNote(midi);
        }

        _releaseKey(key, cell) {
            if (!this._pressed.has(key)) return;
            const midi = this._pressed.get(key);
            this._pressed.delete(key);
            if (cell) cell.classList.remove('active');
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.stopNote === 'function') modal.stopNote(midi);
        }

        _releaseAll() {
            if (!this._pressed || this._pressed.size === 0) return;
            for (const [key] of [...this._pressed]) {
                const [row, idx] = key.split(':');
                const cell = this._root
                    ? this._root.querySelector(
                        `.harmonica-hole[data-row="${row}"][data-idx="${idx}"]`)
                    : null;
                this._releaseKey(key, cell);
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
            this._root.querySelectorAll('.harmonica-hole').forEach(cell => {
                const midi = parseInt(cell.dataset.note, 10);
                const key = `${cell.dataset.row}:${cell.dataset.idx}`;
                // Keep locally-pressed holes lit even if the set lags.
                cell.classList.toggle('active',
                    this._pressed?.has(key) || set.has(midi));
            });
        }

        toolbarGroups() {
            // Fixed-pitch reed: notation + velocity + the view-mode toggle
            // (escape hatch back to piano). No octave/minimap/pitch-bend.
            return new Set(['notation', 'velocity', 'view-mode']);
        }
    }

    if (typeof window !== 'undefined') window.HarmonicaView = HarmonicaView;
    if (typeof module !== 'undefined') module.exports = HarmonicaView;
})();
