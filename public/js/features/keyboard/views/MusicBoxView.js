// =============================================================================
// MusicBoxView.js — Music Box (GM 10) — dedicated comb display.
// =============================================================================
// Reproduces a music-box mechanism: a rectangular drive roller
// ("rouleau d'entraînement") on top — flat rectangular "rotating
// hammer" lugs along its comb-facing edge, squared end faces, no
// rounding — and below it the tuned-steel COMB. Every tine tip is
// aligned at the roller; the tines have different visible steel
// lengths (long bass → short treble) so the shared dark base that
// connects them all rises toward the treble. The note name is
// engraved on that base under each tine; the long bass tines carry
// the characteristic lead tuning weights near their tips. One tine =
// one MIDI note. Pluck on pointerdown; the shared piano-like
// glissando lets you sweep the comb. Self-owned DOM.
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

            // ── Drive roller (rectangular, decorative, non-interactive) ──────
            // A plain rectangle — no rounded corners — with flat rectangular
            // "rotating hammer" lugs along its comb-facing edge and squared
            // end faces. No pins/spikes.
            const cyl = document.createElement('div');
            cyl.className = 'music-box-cylinder';
            cyl.setAttribute('aria-hidden', 'true');
            cyl.style.cssText =
                'position:relative;flex:0 0 42px;pointer-events:none;'
                + 'background:linear-gradient(#b98f3e,#e7c97f 30%,'
                + '#caa24a 52%,#7a5a22 78%,#4d390f 100%);'
                + 'box-shadow:inset 0 2px 3px rgba(255,255,255,.4),'
                + 'inset 0 -3px 5px rgba(0,0,0,.55),'
                + '0 2px 4px rgba(0,0,0,.5);';
            // Row of flat rectangular hammer lugs on the comb-facing edge.
            const hammers = document.createElement('div');
            hammers.style.cssText =
                'position:absolute;left:6px;right:6px;bottom:4px;height:11px;'
                + 'background-image:repeating-linear-gradient(90deg,'
                + '#33270f 0,#33270f 4px,transparent 4px,transparent 11px);'
                + 'opacity:.6;';
            cyl.appendChild(hammers);
            // Squared end faces (rectangular, no rounding).
            for (const side of ['left', 'right']) {
                const cap = document.createElement('div');
                cap.style.cssText =
                    `position:absolute;top:0;bottom:0;${side}:0;width:6px;`
                    + 'background:linear-gradient(#6a5012,#2c2009);';
                cyl.appendChild(cap);
            }

            // ── Comb ────────────────────────────────────────────────────────
            const comb = document.createElement('div');
            comb.className = 'music-box-comb';
            comb.style.cssText =
                'position:relative;flex:1 1 auto;min-height:140px;'
                + 'display:flex;flex-direction:column;align-items:stretch;';

            // Tines: all tips aligned at the top against the roller. Each
            // tine is a full-height column whose visible steel length differs
            // (long bass → short treble); the remaining lower part is the
            // shared dark base that connects every tine and carries the
            // engraved note name. A fine 1px saw-cut shows between columns.
            const teeth = document.createElement('div');
            teeth.className = 'music-box-teeth';
            teeth.style.cssText =
                'flex:1 1 auto;display:flex;align-items:stretch;'
                + 'gap:1px;min-height:0;';

            const STEEL = 'linear-gradient(90deg,#5f666e 0,#aab2bb 18%,'
                + '#eef2f6 44%,#cfd6de 60%,#878e96 80%,#5b6068 100%)';
            const BASE = 'linear-gradient(#454b54,#2c3037 55%,#191c21)';
            const STEEL_MAX = 86, STEEL_MIN = 42;        // % of column height

            for (let i = 0; i < n; i++) {
                const midi = LO + i;
                const t = i / Math.max(1, n - 1);          // 0 bass → 1 treble
                const steelPct = STEEL_MAX - t * (STEEL_MAX - STEEL_MIN);
                const basePct = 100 - steelPct;
                const isBass = t < 0.36;

                const tooth = document.createElement('button');
                tooth.type = 'button';
                tooth.className = 'music-box-tooth';
                tooth.dataset.note = String(midi);
                tooth.title = label(midi);
                tooth.style.cssText =
                    'position:relative;box-sizing:border-box;'
                    + 'flex:1 1 0;min-width:0;height:100%;'
                    + 'border:0;padding:0;margin:0;cursor:pointer;outline:0;'
                    + 'border-radius:0;background-color:transparent;'
                    + `background-image:${STEEL},${BASE};`
                    + 'background-repeat:no-repeat,no-repeat;'
                    + 'background-position:center top,center bottom;'
                    + 'background-size:'
                    + `max(2px,calc(100% - 3px)) ${steelPct.toFixed(2)}%,`
                    + `100% ${basePct.toFixed(2)}%;`
                    + 'transform-origin:bottom;'
                    + 'transition:transform .05s,filter .05s;'
                    + 'display:flex;align-items:flex-end;justify-content:center;'
                    + 'overflow:visible;';

                let noteColor = null;
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    noteColor = modal.getNoteColor(midi);
                    tooth.style.backgroundImage =
                        `linear-gradient(${noteColor.bg},${noteColor.bg}),${BASE}`;
                }

                // Lead tuning weight near the aligned tip of the long bass
                // tines.
                if (isBass) {
                    const w = document.createElement('span');
                    w.setAttribute('aria-hidden', 'true');
                    w.style.cssText =
                        'position:absolute;left:50%;top:7px;'
                        + 'width:74%;height:7%;max-height:20px;'
                        + 'transform:translateX(-50%);border-radius:2px;'
                        + 'background:linear-gradient(#4a4d53,#2b2d31);'
                        + 'box-shadow:inset 0 1px 1px rgba(255,255,255,.25);';
                    tooth.appendChild(w);
                }

                // Note name engraved on the shared base at the bottom of
                // every tine (vertical, light on the dark base). The C of
                // each octave is an "anchor" label kept readable even when
                // tines get thin; the US / FR / MIDI format follows
                // modal.getNoteLabel via the inherited rerender(). Sizing is
                // applied post-layout by _sizeLabels().
                const isOctave = (midi % 12) === 0;
                const lbl = document.createElement('span');
                lbl.className = 'music-box-label'
                    + (isOctave ? ' is-octave' : '');
                lbl.textContent = label(midi);
                lbl.style.cssText =
                    'position:relative;z-index:1;'
                    + 'color:' + (isOctave ? '#ffffff' : '#cdd4dd') + ';'
                    + 'padding-bottom:3px;font-family:sans-serif;'
                    + 'font-weight:' + (isOctave ? '700' : '600') + ';'
                    + 'line-height:1;white-space:nowrap;'
                    + 'text-shadow:0 1px 1px rgba(0,0,0,.7);'
                    + 'writing-mode:vertical-rl;text-orientation:mixed;'
                    + 'pointer-events:none;user-select:none;';
                tooth.appendChild(lbl);
                teeth.appendChild(tooth);
            }

            comb.appendChild(teeth);
            root.appendChild(cyl);
            root.appendChild(comb);
            canvas.appendChild(root);

            this._root = root;
            this._pressed = new Map();
            // Piano-like drag: sweep across the comb teeth for a glissando.
            this._initGlide({ root, selector: '.music-box-tooth' });

            // Size the engraved note names once the comb has been laid out,
            // and keep them sized if the modal is resized.
            if (typeof requestAnimationFrame === 'function') {
                this._raf = requestAnimationFrame(() => {
                    this._raf = 0;
                    this._sizeLabels();
                });
            } else {
                this._sizeLabels();
            }
            if (typeof ResizeObserver === 'function') {
                this._ro = new ResizeObserver(() => this._sizeLabels());
                this._ro.observe(teeth);
            }
        }

        // Auto-fit the vertical note names to the tine width. Below a
        // readability floor only the octave "C" anchors are kept, so the
        // names never collapse into an unreadable smear on wide ranges.
        _sizeLabels() {
            if (!this._root) return;
            const teeth = this._root.querySelector('.music-box-teeth');
            if (!teeth) return;
            const labels = this._root.querySelectorAll('.music-box-label');
            if (!labels.length) return;
            const colPx = teeth.clientWidth / labels.length;
            let fs = Math.floor(colPx * 0.82);
            fs = Math.max(5, Math.min(11, fs));
            const READ_FLOOR = 7;
            const dense = fs < READ_FLOOR;
            labels.forEach(el => {
                const isOctave = el.classList.contains('is-octave');
                if (dense && !isOctave) {
                    el.style.display = 'none';
                    return;
                }
                el.style.display = '';
                el.style.fontSize = (dense && isOctave) ? '8px' : fs + 'px';
                el.style.textShadow = '0 1px 1px rgba(0,0,0,.7)';
            });
        }

        _glideKey(cell) { return cell.dataset.note; }

        _pressCell(cell) {
            const key = cell.dataset.note;
            if (this._pressed.has(key)) return;
            const note = parseInt(key, 10);
            this._pressed.set(key, note);
            cell.classList.add('active');
            // Plucked-tine feedback: brighten + a small base-anchored flex.
            cell.style.filter = 'brightness(1.35)';
            cell.style.transform = 'scaleY(.96)';
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
            if (this._raf) {
                cancelAnimationFrame(this._raf);
                this._raf = 0;
            }
            if (this._ro) {
                this._ro.disconnect();
                this._ro = null;
            }
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
                cell.style.transform = on ? 'scaleY(.96)' : '';
            });
        }
    }

    if (typeof window !== 'undefined') window.MusicBoxView = MusicBoxView;
    if (typeof module !== 'undefined') module.exports = MusicBoxView;
})();
