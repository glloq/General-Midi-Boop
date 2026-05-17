// =============================================================================
// AccordionView.js — Accordion (GM 21 Accordion / 23 Tango Accordion).
// =============================================================================
// Front-facing accordion layout. Everything runs VERTICALLY (keys and
// button rows stacked top→bottom) to mirror a real accordion seen from
// the front:
//   • LEFT   = melody/treble — vertical piano keyboard or vertical
//              chromatic button board (driven by accordion_config.
//              right_display).
//   • CENTRE = decorative, non-interactive bellows (soufflet).
//   • RIGHT  = bass — full Stradella board: 12 circle-of-fifths steps
//              running vertically × 6 function columns (counter-bass,
//              bass, major, minor, dominant 7th, diminished 7th) OR a
//              vertical chromatic single-note board for free-bass.
// No bellows/volume slider: velocity comes from the toolbar velocity slider.
//
// GM 22 (Harmonica) is deliberately NOT routed here — it has its own
// HarmonicaView. registerBuiltins maps 21 & 23 to 'accordion'.
// =============================================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    const TREBLE_LO = 60, TREBLE_HI = 83;   // C4..B5 chromatic (24 keys)
    // Free-bass default span C2..C4 — kept in sync with ISMSections
    // _ACCORDION_BASS_DEFAULT and KeyboardModal.getAccordionConfig().
    const FREE_BASS_LO = 36, FREE_BASS_HI = 60;
    const clampNote = (n) => Math.max(0, Math.min(127, n | 0));
    const mod12 = (n) => ((n % 12) + 12) % 12;

    // Stradella geometry is configurable from the instrument settings
    // (accordion_config): `bass_cols` circle-of-fifths steps run VERTICALLY,
    // the selected `bass_funcs` run HORIZONTALLY, all built around the
    // reference fundamental `bass_base`. Defaults reproduce the classic
    // 12-step × 6-function board centred on C2.
    const STRADELLA_DEFAULT_COLS = 12;
    const STRADELLA_DEFAULT_BASE = 36;          // C2 fundamental
    // Canonical function order. 'note' = single MIDI note (bass octave);
    // 'chord' = intervals voiced one octave above the bass. The dominant
    // 7th and diminished 7th omit the 5th (authentic Stradella).
    const FUNC_ORDER = ['counterbass', 'bass', 'major', 'minor', 'dom7', 'dim7'];
    const FUNC_DEFS = {
        counterbass: { label: 'CB', kind: 'note',  off: 4 },
        bass:        { label: 'B',  kind: 'note',  off: 0 },
        major:       { label: 'M',  kind: 'chord', iv: [0, 4, 7] },
        minor:       { label: 'm',  kind: 'chord', iv: [0, 3, 7] },
        dom7:        { label: '7',  kind: 'chord', iv: [0, 4, 10] },
        dim7:        { label: '°', kind: 'chord', iv: [0, 3, 9] },
    };

    class AccordionView extends InstrumentView {
        static viewKind = 'accordion';
        static iconUrl = '/assets/instruments/accordion.svg';
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
                'display:flex;align-items:stretch;justify-content:center;'
                + 'height:100%;box-sizing:border-box;padding:0;'
                + 'touch-action:none;';

            // Right-hand (treble) follows the configured note range.
            const r = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const tLo = r ? r.min : TREBLE_LO;
            const tHi = r ? r.max : TREBLE_HI;

            const acfg = typeof modal.getAccordionConfig === 'function'
                ? modal.getAccordionConfig()
                : { bass_system: 'stradella', right_display: 'buttons',
                    bass_range: { min: FREE_BASS_LO, max: FREE_BASS_HI } };

            this._keyId = 0;
            this._pressed = new Map();

            // Theme-aware base palette. The current dark scheme stays for
            // body.dark-mode; the normal (default, colored) theme — where
            // the keyboard canvas is white — gets a light scheme so the
            // accordion no longer reads as a dark island. Note colors
            // (modal.showNoteColors) still override these bases as before.
            const dark = typeof document !== 'undefined'
                && document.body
                && document.body.classList.contains('dark-mode');
            this._pal = dark ? {
                zoneBg: '#1f1f24', zoneBorder: '#444',
                treble: '#2b3a4a', bass: '#3a2b3a',
                keyBorder: '#333', keyText: '#e8e8e8',
            } : {
                // Corps rouge nacré (dégradé celluloïd vintage), boutons
                // sombres avec relief — voir styles/keyboard.css pour le
                // soufflet cuir assorti.
                zoneBg: 'linear-gradient(135deg,#d6404f 0%,#a3122a 45%,'
                    + '#c4324a 70%,#7d0f20 100%)',
                zoneBorder: '#5e0c18',
                treble: 'linear-gradient(180deg,#35475c 0%,#243140 100%)',
                bass: 'linear-gradient(180deg,#46354a 0%,#2e2233 100%)',
                keyBorder: '#1b1b21', keyText: '#eaeaf0',
            };
            const pal = this._pal;

            const sides = document.createElement('div');
            sides.className = 'accordion-sides';
            sides.style.cssText =
                'display:flex;gap:0;align-items:stretch;'
                + 'justify-content:center;flex:1;width:100%;height:100%;';

            // LEFT — melody/treble (the accordion's "côté droit").
            const melody = acfg.right_display === 'keyboard'
                ? this._pianoRow('accordion-treble', tLo, tHi, modal)
                : this._cbaBoard('accordion-treble', tLo, tHi, modal, pal.treble);
            sides.appendChild(this._zone(melody, 'treble'));

            // CENTRE — slightly wider central section: a thin rigid
            // "interface" strip (body colour, square edges, no fillet) on
            // each side of the decorative bellows, all non-interactive.
            sides.appendChild(this._interfaceStrip(pal));
            sides.appendChild(this._bellowsVisual());
            sides.appendChild(this._interfaceStrip(pal));

            // RIGHT — bass (the accordion's "côté gauche").
            let bass;
            if (acfg.bass_system === 'stradella') {
                bass = this._stradellaGrid('accordion-bass', modal, acfg);
            } else {
                let bLo = clampNote(acfg.bass_range?.min ?? FREE_BASS_LO);
                let bHi = clampNote(acfg.bass_range?.max ?? FREE_BASS_HI);
                if (bLo > bHi) { const t = bLo; bLo = bHi; bHi = t; }
                bass = this._buttonBoard('accordion-bass', bLo, bHi, modal, pal.bass);
            }
            sides.appendChild(this._zone(bass, 'bass'));

            root.appendChild(sides);
            canvas.appendChild(root);
            this._root = root;
            // Piano-like drag (shared helper): fixes the previous
            // touch-drag bug where hit-testing used only e.target — with
            // implicit pointer capture a touch glissando never crossed to
            // the next button. Now resolved via elementFromPoint like the
            // piano. A button = one or more notes (Stradella chords).
            this._initGlide({ root, selector: '.accordion-key' });
        }

        _glideKey(cell) { return cell.dataset.key || cell.dataset.note; }

        // Bordered panel around one side's controls (no caption). The
        // content fills the full available height (no top/bottom gap).
        // `side` squares the edge that meets the bellows (no fillet there):
        // 'treble' squares the right edge, 'bass' the left edge.
        _zone(contentEl, side) {
            const z = document.createElement('div');
            z.className = 'accordion-zone';
            const pal = this._pal || { zoneBg: '#1f1f24', zoneBorder: '#444' };
            const radius = side === 'treble'
                ? '8px 0 0 8px'
                : side === 'bass' ? '0 8px 8px 0' : '8px';
            z.style.cssText =
                'display:flex;flex-direction:column;padding:6px;'
                + `border:1px solid ${pal.zoneBorder};border-radius:${radius};`
                + `background:${pal.zoneBg};`
                + 'box-sizing:border-box;height:100%;';
            const body = document.createElement('div');
            body.className = 'accordion-zone-body';
            body.style.cssText =
                'flex:1 1 auto;min-height:0;display:flex;align-items:stretch;'
                + 'justify-content:center;width:100%;overflow:hidden;';
            body.appendChild(contentEl);
            z.appendChild(body);
            return z;
        }

        // Thin rigid "interface" between a manual case and the bellows:
        // a slim rectangle in the accordion body colour, square edges (no
        // fillet), non-interactive. One on each side widens the central
        // section slightly to read as the real junction.
        _interfaceStrip(pal) {
            const s = document.createElement('div');
            s.className = 'accordion-bellows-interface';
            s.setAttribute('aria-hidden', 'true');
            const bg = (pal && pal.zoneBg) || '#1f1f24';
            s.style.cssText =
                'flex:0 0 6px;align-self:stretch;pointer-events:none;'
                + `background:${bg};border-radius:0;`;
            return s;
        }

        // Decorative bellows (soufflet) between the two playable sides.
        // The realistic look (leather pleats, bronze frame, metal corner
        // protectors, zigzag tips) lives in CSS (.accordion-bellows-visual).
        // Only the structural sizing and pointer-events:none stay inline so
        // it never intercepts presses and stretches to the full height.
        _bellowsVisual() {
            const b = document.createElement('div');
            b.className = 'accordion-bellows-visual';
            b.setAttribute('aria-hidden', 'true');
            b.style.cssText =
                'flex:0 0 90px;align-self:stretch;pointer-events:none;';
            return b;
        }

        // Shared "point" button. `notes` is the full MIDI set the button
        // triggers; `data-note` keeps a representative single note so the
        // generic lifecycle contract (data-note) still holds. The MIDI note
        // number is shown small; the button scales to the available height.
        _mkRound(notes, title, bg, modal) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'accordion-key accordion-round';
            b.dataset.note = String(notes[0]);
            b.dataset.notes = notes.join(',');
            b.dataset.key = 'k' + (this._keyId++);
            b.title = title;                       // tooltip
            // Note label follows the US / FR / MIDI toolbar toggle
            // (the base rerender() rebuilds the view on change).
            b.textContent = title;
            const pal = this._pal || { keyBorder: '#333', keyText: '#e8e8e8' };
            b.style.cssText =
                'flex:1 1 0;min-height:0;width:100%;box-sizing:border-box;'
                + `border-radius:9999px;border:1px solid ${pal.keyBorder};`
                + `background:${bg};`
                + `cursor:pointer;padding:0;touch-action:none;color:${pal.keyText};`
                + 'display:flex;align-items:center;justify-content:center;'
                + 'overflow:hidden;font:8px/1 monospace;';
            if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                const c = modal.getNoteColor(notes[0]);
                b.style.background = c.bg;
                b.style.color = c.text;
            }
            return b;
        }

        // Generic chromatic single-note board: tall vertical columns of
        // round buttons, ascending top→bottom, successive columns to the
        // side, every other column staggered half a slot. Used for the
        // FREE-BASS side (a plain ascending chromatic field).
        _buttonBoard(cls, lo, hi, modal, bg) {
            const PER_COL = STRADELLA_DEFAULT_COLS;
            const STAGGER = 16;
            const wrap = document.createElement('div');
            wrap.className = `accordion-row ${cls} accordion-board`;
            wrap.style.cssText =
                'display:flex;gap:5px;align-items:stretch;'
                + 'justify-content:center;height:100%;';
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            const nCols = Math.max(1, Math.ceil((hi - lo + 1) / PER_COL));
            for (let c = 0; c < nCols; c++) {
                const col = document.createElement('div');
                col.className = 'accordion-board-col';
                const pad = c % 2
                    ? `padding-top:${STAGGER}px;`
                    : `padding-bottom:${STAGGER}px;`;
                col.style.cssText =
                    'display:flex;flex-direction:column;gap:6px;'
                    + 'align-items:center;height:100%;width:42px;'
                    + 'box-sizing:border-box;' + pad;
                for (let r = 0; r < PER_COL; r++) {
                    const n = lo + c * PER_COL + r;
                    if (n > hi) break;
                    col.appendChild(this._mkRound([n], label(n), bg, modal));
                }
                wrap.appendChild(col);
            }
            return wrap;
        }

        // Realistic chromatic-button-accordion right-hand manual
        // (C-system / C-griff) for the MELODY side: FIVE diagonal ranks.
        // Within a rank consecutive buttons rise a minor third (+3
        // semitones). The three principal ranks are offset +1 semitone
        // each (covering every chromatic note once); the two extra
        // "auxiliary" ranks duplicate ranks 1 & 2 — exactly like a real
        // 5-row C-griff. A pitch therefore lives at several button
        // positions, so pressing one lights its twin(s) (see
        // setActiveNotes), reproducing the real instrument's behaviour.
        // Alternating half-slot stagger forms the diagonal honeycomb.
        _cbaBoard(cls, lo, hi, modal, bg) {
            // 3 principal ranks (offsets 0,1,2) + 2 auxiliary ranks that
            // repeat ranks 0 & 1 (the C-griff helper rows).
            const RANK_OFFSETS = [0, 1, 2, 0, 1];
            const STEP = 3;                 // minor third within a rank
            const STAGGER = 16;
            const wrap = document.createElement('div');
            wrap.className = `accordion-row ${cls} accordion-board accordion-cba`;
            wrap.style.cssText =
                'display:flex;gap:5px;align-items:flex-start;'
                + 'justify-content:center;height:100%;';
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            RANK_OFFSETS.forEach((off, ri) => {
                const col = document.createElement('div');
                col.className = 'accordion-board-col accordion-cba-row';
                // Odd ranks dropped half a slot → diagonal honeycomb.
                const pad = ri % 2
                    ? `padding-top:${STAGGER}px;`
                    : `padding-bottom:${STAGGER}px;`;
                col.style.cssText =
                    'display:flex;flex-direction:column;gap:6px;'
                    + 'align-items:center;height:100%;width:42px;'
                    + 'box-sizing:border-box;' + pad;
                for (let n = lo + off; n <= hi; n += STEP) {
                    col.appendChild(this._mkRound([n], label(n), bg, modal));
                }
                wrap.appendChild(col);
            });
            return wrap;
        }

        // Configurable Stradella bass board, oriented like a real accordion
        // seen from the front: `bass_cols` circle-of-fifths steps stacked
        // vertically (grid rows) × the selected `bass_funcs` columns, all
        // built around the reference fundamental `bass_base`.
        _stradellaGrid(cls, modal, acfg) {
            acfg = acfg || {};
            const ci = Number(acfg.bass_cols);
            const cols = Number.isInteger(ci) && ci >= 1 && ci <= 20
                ? ci : STRADELLA_DEFAULT_COLS;
            const bb = Number(acfg.bass_base);
            const base = Number.isInteger(bb) && bb >= 0 && bb <= 127
                ? bb : STRADELLA_DEFAULT_BASE;
            let funcs = Array.isArray(acfg.bass_funcs)
                ? FUNC_ORDER.filter((f) => acfg.bass_funcs.includes(f))
                : [];
            if (funcs.length === 0) funcs = FUNC_ORDER.slice();

            const rootPc = base % 12;
            const bassLow = base - rootPc;      // octave floor of the reference
            const chordLow = clampNote(bassLow + 12);
            const centerIdx = Math.floor((cols - 1) / 2);

            const STAGGER = 16;
            const wrap = document.createElement('div');
            wrap.className = `accordion-row ${cls} accordion-stradella`;
            wrap.style.cssText =
                'display:flex;gap:5px;align-items:stretch;'
                + 'justify-content:center;height:100%;';
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);

            // One vertical column per function. Buttons scale to the full
            // height (no scrollbar, no text). Every other column is offset
            // half a slot so the buttons are NOT in a straight line
            // (staggered, like a real Stradella board).
            funcs.forEach((id, fi) => {
                const f = FUNC_DEFS[id];
                const colEl = document.createElement('div');
                colEl.className = 'accordion-stradella-col';
                const pad = fi % 2
                    ? `padding-top:${STAGGER}px;`
                    : `padding-bottom:${STAGGER}px;`;
                colEl.style.cssText =
                    'display:flex;flex-direction:column;gap:6px;'
                    + 'align-items:center;height:100%;width:42px;'
                    + 'box-sizing:border-box;' + pad;
                for (let step = 0; step < cols; step++) {
                    const pc = mod12(rootPc + 7 * (step - centerIdx));
                    let notes, title;
                    if (f.kind === 'note') {
                        notes = [clampNote(bassLow + mod12(pc + f.off))];
                        title = label(notes[0]);
                    } else {
                        notes = f.iv.map(
                            (iv) => clampNote(chordLow + mod12(pc + iv)));
                        title = label(clampNote(chordLow + pc)) + f.label;
                    }
                    colEl.appendChild(this._mkRound(
                        notes, title, (this._pal && this._pal.bass) || '#3a2b3a',
                        modal));
                }
                wrap.appendChild(colEl);
            });
            return wrap;
        }

        // Vertical piano-style treble ("option clavier"): white keys stacked
        // top→bottom, black keys absolutely positioned over the boundaries
        // on the inner edge. Keeps the `.accordion-key` contract so
        // press/release logic is shared.
        _pianoRow(cls, lo, hi, modal) {
            const BLACK = new Set([1, 3, 6, 8, 10]);
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            let whites = 0;
            for (let n = lo; n <= hi; n++) if (!BLACK.has(mod12(n))) whites++;
            whites = Math.max(1, whites);
            const H = 100 / whites;

            const col = document.createElement('div');
            col.className = `accordion-row ${cls} accordion-piano`;
            col.style.cssText = 'position:relative;width:168px;flex:0 0 auto;'
                + 'height:100%;';
            let wIdx = 0;
            const mk = (n, black, topPct, hPct, css) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'accordion-key' + (black ? ' accordion-key-black' : '');
                b.dataset.note = String(n);
                b.dataset.notes = String(n);
                b.dataset.key = 'k' + (this._keyId++);
                b.title = label(n);
                // Name only on white keys, aligned to the left. Follows
                // the US / FR / MIDI toolbar toggle (base rerender()).
                if (!black) b.textContent = label(n);
                b.style.cssText =
                    'position:absolute;box-sizing:border-box;border:1px solid #222;'
                    + 'cursor:pointer;font:8px/1 monospace;display:flex;'
                    + 'align-items:center;justify-content:flex-start;padding-left:3px;'
                    + 'overflow:hidden;'
                    + `top:${topPct}%;height:${hPct}%;${css}`
                    + (black ? 'background:#1a1a1a;color:#eee;z-index:2;'
                             : 'background:#f4f4f4;color:#222;z-index:1;');
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    b.style.background = modal.getNoteColor(n).bg;
                    b.style.color = modal.getNoteColor(n).text;
                }
                return b;
            };
            for (let n = lo; n <= hi; n++) {
                const black = BLACK.has(mod12(n));
                if (!black) {
                    col.appendChild(mk(n, false, wIdx * H, H, 'left:0;width:100%;'));
                    wIdx++;
                } else {
                    col.appendChild(mk(n, true, wIdx * H - H * 0.3, H * 0.6,
                        'right:0;width:62%;'));
                }
            }
            return col;
        }

        _pressCell(cell) {
            const id = cell.dataset.key || cell.dataset.note;
            if (this._pressed.has(id)) return;
            const notes = (cell.dataset.notes || cell.dataset.note || '')
                .split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
            if (notes.length === 0) return;
            this._pressed.set(id, { cell, notes });
            cell.classList.add('active');
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.playNote === 'function') {
                notes.forEach((n) => modal.playNote(n));
            }
        }

        _releaseAll() {
            if (!this._pressed || this._pressed.size === 0) return;
            const modal = this.ctx && this.ctx.modal;
            for (const [id, { cell, notes }] of [...this._pressed]) {
                this._pressed.delete(id);
                if (cell) cell.classList.remove('active');
                if (modal && typeof modal.stopNote === 'function') {
                    notes.forEach((n) => modal.stopNote(n));
                }
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

        // Highlighting is driven purely by local press state (not the
        // modal's global note set), so the two manuals never cross-light
        // and external playback stays unambiguous.
        //   • TREBLE side: realistic CBA behaviour — a pitch lives at
        //     several button positions, so pressing one lights every
        //     treble button that produces the same note. Only notes held
        //     FROM the treble side reflect (bass presses never leak here).
        //   • BASS side: the pressed button(s) only.
        setActiveNotes(_activeMidiSet) {
            if (!this._root) return;
            const trebleNotes = new Set();
            if (this._pressed) {
                for (const { cell, notes } of this._pressed.values()) {
                    if (cell && cell.closest
                        && cell.closest('.accordion-treble')) {
                        notes.forEach((n) => trebleNotes.add(n));
                    }
                }
            }
            this._root.querySelectorAll('.accordion-key').forEach((cell) => {
                const id = cell.dataset.key || cell.dataset.note;
                let on = !!(this._pressed && this._pressed.has(id));
                if (!on && trebleNotes.size
                    && cell.closest('.accordion-treble')) {
                    const notes = (cell.dataset.notes || cell.dataset.note
                        || '').split(',').map((s) => parseInt(s, 10));
                    on = notes.some((n) => trebleNotes.has(n));
                }
                cell.classList.toggle('active', on);
            });
        }

    }

    if (typeof window !== 'undefined') window.AccordionView = AccordionView;
    if (typeof module !== 'undefined') module.exports = AccordionView;
})();
