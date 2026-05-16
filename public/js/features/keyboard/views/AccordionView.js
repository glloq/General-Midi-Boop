// =============================================================================
// AccordionView.js — Accordion (GM 21 Accordion / 23 Tango Accordion).
// =============================================================================
// Front-facing accordion layout:
//   • LEFT   = melody/treble — piano keyboard or chromatic button board
//              (driven by accordion_config.right_display).
//   • CENTRE = decorative, non-interactive bellows (soufflet).
//   • RIGHT  = bass — full 6-row Stradella grid (counter-bass, bass, major,
//              minor, dominant 7th, diminished 7th; columns = circle of
//              fifths) OR a chromatic single-note board for free-bass.
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

    // Stradella: 12 columns on the circle of fifths, centred on C.
    //   pitchClass(col) = (7*(col-5)) mod 12 → Db Ab Eb Bb F C G D A E B F#
    const STRADELLA_COLS = 12;
    // Rows top → bottom. 'note' = single MIDI note (low octave from C2);
    // 'chord' = intervals voiced inside one octave from C3 (MIDI 48). The
    // dominant 7th and diminished 7th omit the 5th (authentic Stradella).
    const STRADELLA_ROWS = [
        { label: 'CB', kind: 'note',  base: 36, off: 4 },           // counter-bass
        { label: 'B',  kind: 'note',  base: 36, off: 0 },           // fundamental bass
        { label: 'M',  kind: 'chord', base: 48, iv: [0, 4, 7] },    // major
        { label: 'm',  kind: 'chord', base: 48, iv: [0, 3, 7] },    // minor
        { label: '7',  kind: 'chord', base: 48, iv: [0, 4, 10] },   // dominant 7th
        { label: '°', kind: 'chord', base: 48, iv: [0, 3, 9] },// diminished 7th
    ];

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
                'display:flex;align-items:center;justify-content:center;'
                + 'height:100%;padding:16px;touch-action:none;';

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

            const sides = document.createElement('div');
            sides.className = 'accordion-sides';
            sides.style.cssText =
                'display:flex;gap:18px;align-items:stretch;'
                + 'justify-content:center;flex:1;width:100%;height:100%;';

            // LEFT — melody/treble (the accordion's "côté droit").
            const melody = acfg.right_display === 'keyboard'
                ? this._pianoRow('accordion-treble', tLo, tHi, modal)
                : this._buttonBoard('accordion-treble', tLo, tHi, modal, '#2b3a4a');
            sides.appendChild(this._zone(
                `Côté droit · ${acfg.right_display === 'keyboard' ? 'Clavier' : 'Boutons'}`,
                melody));

            // CENTRE — decorative bellows (soufflet), non-interactive.
            sides.appendChild(this._bellowsVisual());

            // RIGHT — bass (the accordion's "côté gauche").
            let bass, bassTitle;
            if (acfg.bass_system === 'stradella') {
                bass = this._stradellaGrid('accordion-bass', modal);
                bassTitle = 'Côté gauche · Stradella';
            } else {
                let bLo = clampNote(acfg.bass_range?.min ?? FREE_BASS_LO);
                let bHi = clampNote(acfg.bass_range?.max ?? FREE_BASS_HI);
                if (bLo > bHi) { const t = bLo; bLo = bHi; bHi = t; }
                bass = this._buttonBoard('accordion-bass', bLo, bHi, modal, '#3a2b3a');
                bassTitle = 'Côté gauche · Basses libres';
            }
            sides.appendChild(this._zone(bassTitle, bass));

            root.appendChild(sides);
            canvas.appendChild(root);
            this._root = root;
            this._onDown = (e) => this._press(e);
            this._onDocUp = () => this._releaseAll();
            root.addEventListener('pointerdown', this._onDown);
            document.addEventListener('pointerup', this._onDocUp);
            document.addEventListener('pointercancel', this._onDocUp);
        }

        // Titled, bordered panel around one side's controls.
        _zone(title, contentEl) {
            const z = document.createElement('div');
            z.className = 'accordion-zone';
            z.style.cssText =
                'display:flex;flex-direction:column;gap:6px;padding:10px;'
                + 'border:1px solid #444;border-radius:8px;background:#1f1f24;'
                + 'align-items:center;justify-content:center;';
            const h = document.createElement('div');
            h.className = 'accordion-zone-title';
            h.textContent = title;
            h.style.cssText = 'font:11px sans-serif;color:#9fb3c8;text-align:center;';
            z.appendChild(h);
            z.appendChild(contentEl);
            return z;
        }

        // Decorative pleated bellows between the two playable sides. No
        // listeners and pointer-events:none so it never intercepts presses.
        _bellowsVisual() {
            const b = document.createElement('div');
            b.className = 'accordion-bellows-visual';
            b.setAttribute('aria-hidden', 'true');
            b.style.cssText =
                'flex:0 0 90px;align-self:stretch;min-height:130px;'
                + 'border:1px solid #444;border-radius:8px;pointer-events:none;'
                + 'background:repeating-linear-gradient(135deg,'
                + '#2a2a30 0 9px,#3c3c46 9px 18px);'
                + 'box-shadow:inset 0 0 16px rgba(0,0,0,0.55);';
            return b;
        }

        // Shared round "point" button. `notes` is the full MIDI set the
        // button triggers; `data-note` keeps a representative single note
        // so the generic lifecycle contract (data-note) still holds.
        _mkRound(notes, title, bg, modal) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'accordion-key accordion-round';
            b.dataset.note = String(notes[0]);
            b.dataset.notes = notes.join(',');
            b.dataset.key = 'k' + (this._keyId++);
            b.title = title;
            b.textContent = title;
            b.style.cssText =
                'width:34px;height:34px;border-radius:50%;border:1px solid #333;'
                + `background:${bg};color:#e8e8e8;cursor:pointer;padding:0;`
                + 'font:9px sans-serif;display:flex;align-items:center;'
                + 'justify-content:center;';
            if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                const c = modal.getNoteColor(notes[0]);
                b.style.background = c.bg;
                b.style.color = c.text;
            }
            return b;
        }

        // Chromatic round-button board (C-griff style): 3 diagonal rows.
        // Used for the treble in 'buttons' mode and for the free-bass side.
        _buttonBoard(cls, lo, hi, modal, bg) {
            const wrap = document.createElement('div');
            wrap.className = `accordion-row ${cls} accordion-board`;
            const cols = Math.max(1, Math.ceil((hi - lo + 1) / 3));
            wrap.style.cssText =
                'display:grid;gap:5px;align-content:center;justify-content:center;'
                + `grid-template-rows:repeat(3,1fr);`
                + `grid-template-columns:repeat(${cols},1fr);`;
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            for (let i = 0, n = lo; n <= hi; n++, i++) {
                const b = this._mkRound([n], label(n), bg, modal);
                b.style.gridRow = String((i % 3) + 1);
                b.style.gridColumn = String(Math.floor(i / 3) + 1);
                wrap.appendChild(b);
            }
            return wrap;
        }

        // Full Stradella bass grid: 6 rows × 12 circle-of-fifths columns.
        _stradellaGrid(cls, modal) {
            const wrap = document.createElement('div');
            wrap.className = `accordion-row ${cls} accordion-stradella`;
            wrap.style.cssText =
                'display:grid;gap:5px;align-content:center;justify-content:center;'
                + `grid-template-columns:auto repeat(${STRADELLA_COLS},1fr);`
                + `grid-template-rows:repeat(${STRADELLA_ROWS.length},1fr);`;
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            STRADELLA_ROWS.forEach((rowDef, ri) => {
                const lab = document.createElement('div');
                lab.className = 'accordion-stradella-rowlabel';
                lab.textContent = rowDef.label;
                lab.style.cssText =
                    `grid-row:${ri + 1};grid-column:1;display:flex;`
                    + 'align-items:center;justify-content:flex-end;'
                    + 'padding-right:6px;font:10px sans-serif;color:#9fb3c8;';
                wrap.appendChild(lab);
                for (let col = 0; col < STRADELLA_COLS; col++) {
                    const p = mod12(7 * (col - 5));
                    let notes, title;
                    if (rowDef.kind === 'note') {
                        notes = [clampNote(rowDef.base + mod12(p + rowDef.off))];
                        title = label(notes[0]);
                    } else {
                        notes = rowDef.iv.map(
                            (iv) => clampNote(rowDef.base + mod12(p + iv)));
                        title = label(rowDef.base + p) + rowDef.label;
                    }
                    const b = this._mkRound(notes, title, '#3a2b3a', modal);
                    b.style.gridRow = String(ri + 1);
                    b.style.gridColumn = String(col + 2);
                    wrap.appendChild(b);
                }
            });
            return wrap;
        }

        // Piano-style treble ("option clavier"): white keys in a flex row,
        // black keys absolutely positioned over the gaps. Keeps the
        // `.accordion-key` contract so press/release logic is shared.
        _pianoRow(cls, lo, hi, modal) {
            const BLACK = new Set([1, 3, 6, 8, 10]);
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            let whites = 0;
            for (let n = lo; n <= hi; n++) if (!BLACK.has(mod12(n))) whites++;
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
                b.dataset.notes = String(n);
                b.dataset.key = 'k' + (this._keyId++);
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
                const black = BLACK.has(mod12(n));
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

        _press(e) {
            const cell = e.target && e.target.closest
                ? e.target.closest('.accordion-key') : null;
            if (!cell || !this._root.contains(cell)) return;
            if (e.cancelable) e.preventDefault();
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
            this._root.querySelectorAll('.accordion-key').forEach((cell) => {
                const id = cell.dataset.key || cell.dataset.note;
                const local = this._pressed?.has(id);
                const notes = (cell.dataset.notes || cell.dataset.note || '')
                    .split(',').map((s) => parseInt(s, 10));
                cell.classList.toggle('active',
                    !!local || notes.some((n) => set.has(n)));
            });
        }

        toolbarGroups() { return new Set(['notation', 'velocity', 'view-mode']); }
    }

    if (typeof window !== 'undefined') window.AccordionView = AccordionView;
    if (typeof module !== 'undefined') module.exports = AccordionView;
})();
