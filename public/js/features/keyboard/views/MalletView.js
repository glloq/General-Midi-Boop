// =============================================================================
// MalletView.js — Mallet percussion (GM 12 Marimba … 15 Dulcimer).
// =============================================================================
// Marimba/xylophone bar layout: a bottom row of naturals and an offset
// top row of accidentals (the classic two-tier mallet keyboard). Two
// octaves C4..B5. Self-owned DOM; strike on pointerdown, global pointerup
// release (notes decay naturally on the synth).
// =============================================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    const DEFAULT_LO = 60, DEFAULT_HI = 83;       // C4..B5 fallback
    const BLACK = new Set([1, 3, 6, 8, 10]);      // semitone classes with a sharp

    class MalletView extends InstrumentView {
        static viewKind = 'mallet';
        static emoji = '🎵';
        static labelKey = 'keyboard.viewMallet';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;
            document.getElementById('mallet-container')?.remove();

            // QA: use the instrument's configured note range, not a forced
            // fixed span. Fall back to C4..B5 when no capabilities.
            const r = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const LO = r ? r.min : DEFAULT_LO;
            const HI = r ? r.max : DEFAULT_HI;

            const root = document.createElement('div');
            root.id = 'mallet-container';
            root.className = 'mallet-view';
            root.style.cssText =
                'display:flex;align-items:center;justify-content:center;'
                + 'height:100%;padding:18px;overflow:auto;touch-action:none;';

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);

            // Piano-like geometry: naturals form a contiguous row, the
            // accidentals (sharps) sit ABOVE the gap between the right
            // naturals — exactly like a marimba / piano keyboard.
            const NAT_W = 30, GAP = 4, ACC_W = 22;
            const STEP = NAT_W + GAP;

            // Count naturals strictly below a midi (its position index).
            let naturalsCount = 0;
            for (let n = LO; n <= HI; n++) if (!BLACK.has(((n % 12) + 12) % 12)) naturalsCount++;

            const board = document.createElement('div');
            board.className = 'mallet-board';
            board.style.cssText =
                'position:relative;height:150px;'
                + `width:${Math.max(1, naturalsCount) * STEP}px;`;

            let natIdx = 0;
            const mkBar = (n, isBlack, x, opts) => {
                const bar = document.createElement('button');
                bar.type = 'button';
                bar.className = 'mallet-bar' + (isBlack ? ' mallet-bar-acc' : ' mallet-bar-nat');
                bar.dataset.note = String(n);
                bar.title = label(n);
                bar.textContent = label(n);
                bar.style.cssText =
                    'position:absolute;border:1px solid #2a2a2a;border-radius:3px;'
                    + 'cursor:pointer;font:10px sans-serif;display:flex;'
                    + 'align-items:flex-end;justify-content:center;padding-bottom:3px;'
                    + `left:${Math.round(x)}px;width:${opts.w}px;`
                    + `height:${opts.h}px;${opts.pos}`
                    + `z-index:${isBlack ? 2 : 1};`
                    + (isBlack ? 'background:#7a5a2a;color:#fff;'
                               : 'background:#d8b46a;color:#222;');
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(n);
                    bar.style.background = c.bg;
                    bar.style.color = c.text;
                }
                return bar;
            };

            for (let n = LO; n <= HI; n++) {
                const isBlack = BLACK.has(((n % 12) + 12) % 12);
                if (!isBlack) {
                    board.appendChild(mkBar(n, false, natIdx * STEP,
                        { w: NAT_W, h: 110, pos: 'bottom:0;' }));
                    natIdx++;
                } else {
                    // Centred on the boundary between the previous natural
                    // (natIdx-1) and the next one.
                    const x = natIdx * STEP - GAP / 2 - ACC_W / 2;
                    board.appendChild(mkBar(n, true, x,
                        { w: ACC_W, h: 70, pos: 'top:0;' }));
                }
            }

            root.appendChild(board);
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
                ? e.target.closest('.mallet-bar') : null;
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
                    ? this._root.querySelector(`.mallet-bar[data-note="${key}"]`) : null;
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
            this._root.querySelectorAll('.mallet-bar').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.note)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }

        toolbarGroups() { return new Set(['notation', 'velocity', 'view-mode']); }
    }

    if (typeof window !== 'undefined') window.MalletView = MalletView;
    if (typeof module !== 'undefined') module.exports = MalletView;
})();
