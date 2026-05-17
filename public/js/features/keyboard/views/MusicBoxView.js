// =============================================================================
// MusicBoxView.js — Music Box (GM 10) — dedicated comb display.
// =============================================================================
// Reproduces a real cylinder-music-box mechanism: the pinned brass drive
// roller ("rouleau d'entraînement") on top, on its end axle/pivots, and
// below it the tuned-steel COMB. The thin parallel tines ("lames/tiges")
// rise UP from a thick anchored base (screwed to the bedplate) at the
// bottom toward the roller, with a fine even slot between every tine; the
// long bass tines carry the characteristic lead tuning weights near their
// free tips. One tine = one MIDI note over the configured range. Pluck on
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

            // ── Pinned brass drive roller, on its end axle (decorative) ──────
            const cyl = document.createElement('div');
            cyl.className = 'music-box-cylinder';
            cyl.setAttribute('aria-hidden', 'true');
            cyl.style.cssText =
                'position:relative;flex:0 0 46px;pointer-events:none;';

            // Cylinder body — vertical sheen gradient reads as a round tube.
            const cylBody = document.createElement('div');
            cylBody.style.cssText =
                'position:absolute;top:0;bottom:0;left:14px;right:14px;'
                + 'border-radius:23px;overflow:hidden;'
                + 'background:linear-gradient(#3a2c12,#caa24a 22%,'
                + '#efce82 38%,#9a7330 62%,#4d390f 100%);'
                + 'box-shadow:inset 0 3px 5px rgba(255,255,255,.45),'
                + 'inset 0 -8px 11px rgba(0,0,0,.6),'
                + '0 2px 4px rgba(0,0,0,.5);';
            // Discreet row of pins near the comb-facing (bottom) edge.
            const pins = document.createElement('div');
            pins.style.cssText =
                'position:absolute;left:10px;right:10px;bottom:5px;height:9px;'
                + 'background-image:radial-gradient('
                + 'rgba(255,255,255,.7) 30%,transparent 34%);'
                + 'background-size:13px 9px;opacity:.28;';
            cylBody.appendChild(pins);
            cyl.appendChild(cylBody);

            // End axle / pivot caps poking out of each end of the roller.
            for (const side of ['left', 'right']) {
                const pivot = document.createElement('div');
                pivot.style.cssText =
                    `position:absolute;top:50%;${side}:0;`
                    + 'width:18px;height:18px;margin-top:-9px;'
                    + 'border-radius:50%;background:radial-gradient('
                    + 'circle at 38% 32%,#f2e8c8,#9c7a3a 58%,#4a3713);'
                    + 'box-shadow:inset 0 0 0 1px rgba(0,0,0,.35),'
                    + '0 1px 2px rgba(0,0,0,.55);';
                const hub = document.createElement('div');
                hub.style.cssText =
                    'position:absolute;top:50%;left:50%;width:6px;height:6px;'
                    + 'margin:-3px 0 0 -3px;border-radius:50%;'
                    + 'background:radial-gradient(#6b521f,#2c2009);';
                pivot.appendChild(hub);
                cyl.appendChild(pivot);
            }

            // ── Comb assembly ───────────────────────────────────────────────
            const comb = document.createElement('div');
            comb.className = 'music-box-comb';
            comb.style.cssText =
                'position:relative;flex:1 1 auto;min-height:140px;'
                + 'display:flex;flex-direction:column;align-items:stretch;';

            // Thick anchored base at the bottom (screwed onto the bedplate);
            // the tines are rooted here and rise toward the roller.
            const spine = document.createElement('div');
            spine.className = 'music-box-spine';
            spine.style.cssText =
                'flex:0 0 24px;border-radius:0 0 4px 4px;position:relative;'
                + 'background:linear-gradient(#aab0b8,#6b7077 55%,#3c3f45);'
                + 'box-shadow:inset 0 4px 5px rgba(255,255,255,.4),'
                + 'inset 0 -4px 6px rgba(0,0,0,.55);';
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

            // Tines: rooted in the base at the bottom and rising toward the
            // roller, drawn as thin centred steel rods so a fine, even dark
            // slot always shows between every tige. Near-flat profile: bass
            // (left) only a touch longer than treble (right).
            const teeth = document.createElement('div');
            teeth.className = 'music-box-teeth';
            teeth.style.cssText =
                'flex:1 1 auto;display:flex;align-items:flex-end;'
                + 'gap:1px;min-height:0;';

            const W = 100 / n;
            for (let i = 0; i < n; i++) {
                const midi = LO + i;
                const t = i / Math.max(1, n - 1);          // 0 bass → 1 treble
                const hPct = 100 - t * 12;                  // near-flat row
                const isBass = t < 0.36;

                const tooth = document.createElement('button');
                tooth.type = 'button';
                tooth.className = 'music-box-tooth';
                tooth.dataset.note = String(midi);
                tooth.title = label(midi);
                tooth.style.cssText =
                    'position:relative;box-sizing:border-box;flex:0 0 auto;'
                    + `width:${W}%;height:${hPct.toFixed(1)}%;`
                    + 'border:0;padding:0;margin:0;cursor:pointer;outline:0;'
                    + 'border-radius:3px 3px 0 0;'
                    + 'background-color:transparent;'
                    + 'background-image:linear-gradient(90deg,'
                    + '#5f666e 0,#aab2bb 18%,#eef2f6 44%,'
                    + '#cfd6de 60%,#878e96 80%,#5b6068 100%);'
                    + 'background-repeat:no-repeat;background-position:center;'
                    + 'background-size:max(2px,calc(100% - 3px)) 100%;'
                    + 'transform-origin:bottom;'
                    + 'transition:transform .05s,filter .05s;'
                    + 'display:flex;align-items:flex-end;justify-content:center;'
                    + 'overflow:visible;';

                let noteColor = null;
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    noteColor = modal.getNoteColor(midi);
                    tooth.style.backgroundImage = noteColor.bg;
                }

                // Lead tuning weight on the long bass tines (near the free
                // tip, now at the top).
                if (isBass) {
                    const w = document.createElement('span');
                    w.setAttribute('aria-hidden', 'true');
                    w.style.cssText =
                        'position:absolute;left:50%;top:6px;'
                        + 'width:78%;height:14%;max-height:26px;'
                        + 'transform:translateX(-50%);border-radius:2px;'
                        + 'background:linear-gradient(#4a4d53,#2b2d31);'
                        + 'box-shadow:inset 0 1px 1px rgba(255,255,255,.25);';
                    tooth.appendChild(w);
                }

                // Note name engraved at the base of every tine (vertical,
                // rising from the embase). The C of each octave is an
                // "anchor" label kept readable even when tines get thin;
                // the US / FR / MIDI format follows modal.getNoteLabel via
                // the inherited rerender(). Sizing is applied post-layout
                // by _sizeLabels().
                const isOctave = (midi % 12) === 0;
                const lbl = document.createElement('span');
                lbl.className = 'music-box-label'
                    + (isOctave ? ' is-octave' : '');
                lbl.textContent = label(midi);
                lbl.style.cssText =
                    'position:relative;z-index:1;'
                    + 'color:' + (noteColor ? noteColor.text : '#1b2026') + ';'
                    + 'padding-bottom:3px;font-family:sans-serif;'
                    + 'font-weight:' + (isOctave ? '700' : '600') + ';'
                    + 'line-height:1;white-space:nowrap;'
                    + 'writing-mode:vertical-rl;text-orientation:mixed;'
                    + 'pointer-events:none;user-select:none;';
                tooth.appendChild(lbl);
                teeth.appendChild(tooth);
            }

            comb.appendChild(teeth);
            comb.appendChild(spine);
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
                if (dense && isOctave) {
                    el.style.fontSize = '8px';
                    el.style.textShadow = '0 0 2px rgba(255,255,255,.75)';
                } else {
                    el.style.fontSize = fs + 'px';
                    el.style.textShadow = '';
                }
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
