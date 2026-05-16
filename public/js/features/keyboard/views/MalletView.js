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
        static iconUrl = '/assets/instruments/marimba.svg';
        static emoji = '🎶';
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
                'display:flex;align-items:stretch;justify-content:stretch;'
                + 'height:100%;padding:14px 10px;box-sizing:border-box;'
                + 'touch-action:none;';

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);

            // Responsive piano-like geometry expressed in PERCENT so the
            // whole configured range always fits the window (no overflow,
            // no manual zoom). Naturals fill the width; accidentals sit
            // ABOVE the boundary between the right naturals (sharps are
            // shorter and anchored to the very top → visually higher).
            let naturalsCount = 0;
            for (let n = LO; n <= HI; n++) if (!BLACK.has(((n % 12) + 12) % 12)) naturalsCount++;
            naturalsCount = Math.max(1, naturalsCount);
            const NAT_W = 100 / naturalsCount;          // % of board width
            const ACC_W = NAT_W * 0.62;

            const board = document.createElement('div');
            board.className = 'mallet-board';
            board.style.cssText =
                'position:relative;width:100%;height:100%;min-height:160px;';

            let natIdx = 0;
            const mkBar = (n, isBlack, leftPct, widthPct, posCss) => {
                const bar = document.createElement('button');
                bar.type = 'button';
                bar.className = 'mallet-bar' + (isBlack ? ' mallet-bar-acc' : ' mallet-bar-nat');
                bar.dataset.note = String(n);
                bar.title = label(n);
                bar.textContent = label(n);
                bar.style.cssText =
                    'position:absolute;box-sizing:border-box;'
                    + 'border:1px solid #2a2a2a;border-radius:0 0 4px 4px;'
                    + 'cursor:pointer;font:10px sans-serif;display:flex;'
                    + 'align-items:flex-end;justify-content:center;padding-bottom:4px;'
                    + `left:${leftPct}%;width:${widthPct}%;${posCss}`
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
                    // Naturals: lower band (bottom 58%).
                    board.appendChild(mkBar(n, false, natIdx * NAT_W, NAT_W,
                        'bottom:0;height:58%;'));
                    natIdx++;
                } else {
                    // Accidentals: centred on the boundary, anchored to the
                    // TOP and shorter → clearly higher than the naturals.
                    const leftPct = natIdx * NAT_W - ACC_W / 2;
                    board.appendChild(mkBar(n, true, leftPct, ACC_W,
                        'top:0;height:46%;border-radius:4px;'));
                }
            }

            root.appendChild(board);
            canvas.appendChild(root);

            this._root = root;
            this._pressed = new Map();
            // Piano-like drag: slide across the bars for a glissando.
            this._initGlide({ root, selector: '.mallet-bar' });
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
                    ? this._root.querySelector(`.mallet-bar[data-note="${key}"]`) : null;
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
            this._root.querySelectorAll('.mallet-bar').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.note)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }

    }

    if (typeof window !== 'undefined') window.MalletView = MalletView;
    if (typeof module !== 'undefined') module.exports = MalletView;
})();
