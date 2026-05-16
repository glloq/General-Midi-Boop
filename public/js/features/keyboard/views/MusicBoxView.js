// =============================================================================
// MusicBoxView.js — Music Box (GM 10) — dedicated comb display.
// =============================================================================
// Reproduces a real cylinder-music-box mechanism: a pinned brass cylinder
// on top and, below it, the tuned-steel COMB — a thick anchored spine
// (screwed to the bedplate) from which thin parallel teeth hang. The teeth
// taper from the long bass tooth (left) to the short treble tooth (right);
// the longest bass teeth carry the characteristic lead tuning weights near
// their tips. One tooth = one MIDI note over the configured range. Pluck on
// pointerdown; the shared piano-like glissando lets you sweep the comb.
// Self-owned DOM.
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
                + 'box-sizing:border-box;padding:14px 16px 18px;gap:10px;'
                + 'background:linear-gradient(#241c12,#15110b);'
                + 'touch-action:none;';

            // ── Pinned brass cylinder (decorative, non-interactive) ──────────
            const cyl = document.createElement('div');
            cyl.className = 'music-box-cylinder';
            cyl.setAttribute('aria-hidden', 'true');
            cyl.style.cssText =
                'position:relative;flex:0 0 30px;border-radius:15px/8px;'
                + 'pointer-events:none;overflow:hidden;'
                + 'background:linear-gradient(#caa24a,#7a5a22 55%,#4d390f);'
                + 'box-shadow:inset 0 5px 7px rgba(255,255,255,.35),'
                + 'inset 0 -7px 9px rgba(0,0,0,.55);';
            // Rows of pins that pluck the comb.
            const pins = document.createElement('div');
            pins.style.cssText =
                'position:absolute;inset:6px 8px;'
                + 'background-image:radial-gradient(#fff 35%,transparent 38%);'
                + 'background-size:14px 11px;opacity:.5;';
            cyl.appendChild(pins);

            // ── Comb assembly ───────────────────────────────────────────────
            const comb = document.createElement('div');
            comb.className = 'music-box-comb';
            comb.style.cssText =
                'position:relative;flex:1 1 auto;min-height:140px;'
                + 'display:flex;flex-direction:column;align-items:stretch;';

            // Thick anchored spine (the part screwed onto the bedplate).
            const spine = document.createElement('div');
            spine.className = 'music-box-spine';
            spine.style.cssText =
                'flex:0 0 22px;border-radius:4px 4px 0 0;position:relative;'
                + 'background:linear-gradient(#9a9ea6,#5b5f66 60%,#3c3f45);'
                + 'box-shadow:inset 0 3px 4px rgba(255,255,255,.4),'
                + 'inset 0 -4px 6px rgba(0,0,0,.5);';
            for (const x of ['16%', '84%']) {           // two fixing screws
                const screw = document.createElement('div');
                screw.style.cssText =
                    `position:absolute;top:50%;left:${x};`
                    + 'width:11px;height:11px;margin:-6px 0 0 -6px;'
                    + 'border-radius:50%;background:radial-gradient('
                    + '#e9edf2,#7c828b 60%,#3a3d42);'
                    + 'box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);';
                const slot = document.createElement('div');
                slot.style.cssText =
                    'position:absolute;top:50%;left:50%;width:8px;height:2px;'
                    + 'background:#2a2c30;transform:translate(-50%,-50%) rotate(35deg);';
                screw.appendChild(slot);
                spine.appendChild(screw);
            }

            // Teeth: hang from the spine, full bleed, ~1px saw-cut slots so
            // the dark bedplate shows between lamellae. Length tapers from
            // the long bass tooth (left) to the short treble tooth (right).
            const teeth = document.createElement('div');
            teeth.className = 'music-box-teeth';
            teeth.style.cssText =
                'flex:1 1 auto;display:flex;align-items:flex-start;'
                + 'gap:1px;min-height:0;';

            const W = 100 / n;
            for (let i = 0; i < n; i++) {
                const midi = LO + i;
                const t = i / Math.max(1, n - 1);          // 0 bass → 1 treble
                const hPct = 100 - t * 56;                  // long → short
                const isBass = t < 0.36;

                const tooth = document.createElement('button');
                tooth.type = 'button';
                tooth.className = 'music-box-tooth';
                tooth.dataset.note = String(midi);
                tooth.title = label(midi);
                tooth.style.cssText =
                    'position:relative;box-sizing:border-box;flex:0 0 auto;'
                    + `width:${W}%;height:${hPct.toFixed(1)}%;`
                    + 'border:0;padding:0;cursor:pointer;outline:0;'
                    + 'border-radius:0 0 3px 3px;'
                    + 'background:linear-gradient(90deg,'
                    + '#6f7780 0,#cfd6de 22%,#eef2f6 45%,#aeb6bf 70%,#70777f 100%);'
                    + 'box-shadow:inset 0 -3px 5px rgba(0,0,0,.35),'
                    + '0 0 0 .5px rgba(0,0,0,.45);'
                    + 'transition:transform .04s,filter .04s;'
                    + 'display:flex;align-items:flex-end;justify-content:center;'
                    + 'overflow:visible;';

                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    tooth.style.background = c.bg;
                }

                // Lead tuning weight on the long bass teeth (near the tip).
                if (isBass) {
                    const w = document.createElement('span');
                    w.setAttribute('aria-hidden', 'true');
                    w.style.cssText =
                        'position:absolute;left:50%;bottom:6px;'
                        + 'width:78%;height:14%;max-height:26px;'
                        + 'transform:translateX(-50%);border-radius:2px;'
                        + 'background:linear-gradient(#4a4d53,#2b2d31);'
                        + 'box-shadow:inset 0 1px 1px rgba(255,255,255,.25);';
                    tooth.appendChild(w);
                }

                if (n <= 28) {
                    const lbl = document.createElement('span');
                    lbl.textContent = label(midi);
                    lbl.style.cssText =
                        'position:relative;z-index:1;font:9px sans-serif;'
                        + 'color:#1b2026;padding-bottom:3px;'
                        + 'writing-mode:vertical-rl;text-orientation:mixed;'
                        + 'pointer-events:none;user-select:none;';
                    tooth.appendChild(lbl);
                }
                teeth.appendChild(tooth);
            }

            comb.appendChild(spine);
            comb.appendChild(teeth);
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
            // Plucked-tooth feedback: brighten + a small downward flex.
            cell.style.filter = 'brightness(1.35)';
            cell.style.transform = 'translateY(2px)';
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
                if (cell) {
                    cell.classList.remove('active');
                    cell.style.filter = '';
                    cell.style.transform = '';
                }
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
                const on = this._pressed?.has(cell.dataset.note)
                    || set.has(parseInt(cell.dataset.note, 10));
                cell.classList.toggle('active', on);
                cell.style.filter = on ? 'brightness(1.35)' : '';
                cell.style.transform = on ? 'translateY(2px)' : '';
            });
        }
    }

    if (typeof window !== 'undefined') window.MusicBoxView = MusicBoxView;
    if (typeof module !== 'undefined') module.exports = MusicBoxView;
})();
