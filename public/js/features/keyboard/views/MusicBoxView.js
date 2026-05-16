// =============================================================================
// MusicBoxView.js — Music Box (GM 10) — dedicated display.
// =============================================================================
// A music box reads a pinned cylinder that plucks a steel comb: bass teeth
// are long, treble teeth are short. We render exactly that: a decorative
// (non-interactive) rotating cylinder on top, and below it the playable
// comb — one tooth per MIDI note over the configured range, lengths
// tapering from the lowest (longest) to the highest (shortest). Pluck on
// pointerdown; the shared piano-like glissando lets you sweep across the
// teeth. Self-owned DOM.
// =============================================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    const DEFAULT_LO = 60, DEFAULT_HI = 84;       // C4..C6 fallback

    class MusicBoxView extends InstrumentView {
        static viewKind = 'music-box';
        static iconUrl = '/assets/instruments/music_box.svg';
        static emoji = '🎁';
        static labelKey = 'keyboard.viewMusicBox';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;
            document.getElementById('music-box-container')?.remove();

            const r = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const LO = r ? r.min : DEFAULT_LO;
            const HI = r ? r.max : DEFAULT_HI;
            const n = Math.max(1, HI - LO + 1);
            const label = typeof modal.getNoteLabel === 'function'
                ? (m) => modal.getNoteLabel(m) : (m) => String(m);

            const root = document.createElement('div');
            root.id = 'music-box-container';
            root.className = 'music-box-view';
            root.style.cssText =
                'display:flex;flex-direction:column;height:100%;'
                + 'box-sizing:border-box;padding:10px 12px;gap:8px;'
                + 'touch-action:none;';

            // Decorative pinned cylinder (non-interactive).
            const cyl = document.createElement('div');
            cyl.className = 'music-box-cylinder';
            cyl.setAttribute('aria-hidden', 'true');
            cyl.style.cssText =
                'flex:0 0 34px;border-radius:8px;pointer-events:none;'
                + 'background:repeating-linear-gradient(90deg,'
                + '#6b4f2a 0 6px,#8a6a38 6px 12px);'
                + 'box-shadow:inset 0 -6px 10px rgba(0,0,0,.45),'
                + 'inset 0 4px 6px rgba(255,255,255,.15);'
                + 'position:relative;overflow:hidden;';

            // Comb plate holding the teeth.
            const comb = document.createElement('div');
            comb.className = 'music-box-comb';
            comb.style.cssText =
                'position:relative;flex:1 1 auto;min-height:120px;'
                + 'display:flex;align-items:flex-start;'
                + 'border-top:6px solid #b9952f;border-radius:0 0 6px 6px;'
                + 'background:linear-gradient(#3a3a42,#23232a);';

            const W = 100 / n;                              // % per tooth
            for (let i = 0; i < n; i++) {
                const midi = LO + i;
                // Lowest note = longest tooth (95%), highest = shortest (45%).
                const hPct = 95 - (i / Math.max(1, n - 1)) * 50;
                const tooth = document.createElement('button');
                tooth.type = 'button';
                tooth.className = 'music-box-tooth';
                tooth.dataset.note = String(midi);
                tooth.title = label(midi);
                tooth.style.cssText =
                    'position:relative;box-sizing:border-box;'
                    + `width:${W}%;height:${hPct.toFixed(1)}%;`
                    + 'margin-top:0;border:none;border-right:1px solid #1a1a1f;'
                    + 'border-radius:0 0 3px 3px;cursor:pointer;padding:0;'
                    + 'background:linear-gradient(#d9dde2,#9aa1ab);'
                    + 'display:flex;align-items:flex-end;justify-content:center;'
                    + 'font:9px sans-serif;color:#1b2733;'
                    + 'padding-bottom:3px;overflow:hidden;';
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    tooth.style.background = c.bg;
                    tooth.style.color = c.text;
                }
                if (n <= 30) tooth.textContent = label(midi);
                comb.appendChild(tooth);
            }

            root.appendChild(cyl);
            root.appendChild(comb);
            canvas.appendChild(root);

            this._root = root;
            this._pressed = new Map();
            // Piano-like drag: sweep across the comb teeth for a glissando.
            this._initGlide({ root, selector: '.music-box-tooth' });
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
                    ? this._root.querySelector(`.music-box-tooth[data-note="${key}"]`)
                    : null;
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
            this._root.querySelectorAll('.music-box-tooth').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.note)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }
    }

    if (typeof window !== 'undefined') window.MusicBoxView = MusicBoxView;
    if (typeof module !== 'undefined') module.exports = MusicBoxView;
})();
