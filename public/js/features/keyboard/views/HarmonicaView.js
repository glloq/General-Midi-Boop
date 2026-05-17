// =============================================================================
// HarmonicaView.js — Harmonica (GM 22) blow/draw hole layout.
// =============================================================================
// Self-owned DOM (no legacy-mixin delegation). Two tunings:
//
//  • Diatonic (Richter), 10-hole reference in C:
//      Hole   1   2   3   4   5   6   7   8   9  10
//      Blow  C4  E4  G4  C5  E5  G5  C6  E6  G6  C7
//      Draw  D4  G4  B4  D5  F5  A5  B5  D6  F6  A6
//  • Chromatic (solo tuning) + a slide button that raises every note one
//    semitone while engaged. Per repeating 4-hole group:
//      Blow  C  E  G  C      Draw  D  F  A  B
//
// The tuning, musical key and hole count come from the instrument config:
//   modal.getHarmonicaConfig() → { type:'diatonic'|'chromatic', key:'C'..'B' }
//   modal.getInstrumentNoteRange() → { min, max }  (hole count follows it)
// Absence of config preserves the previous behaviour (diatonic C, 10 holes).
//
// The chromatic flag lives ONLY in harmonica_config.type — keyboard_type is
// never set for a harmonica (that would divert GM22 to the keyboard-list
// view). The view renders a realistic side view (curved metal cover plates,
// a comb with numbered holes, the "Souffler ↑" / "Aspirer ↓" labels in a
// left column outside the device, and — chromatic only — a slide button
// protruding from the right side) and plays through modal.playNote()/
// stopNote() so MIDI routing and the active-notes set behave exactly like
// the other views.
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    // C diatonic Richter tuning (MIDI, C4 = 60) — reference 10-hole layout.
    const BLOW0 = [60, 64, 67, 72, 76, 79, 84, 88, 91, 96];
    const DRAW0 = [62, 67, 71, 74, 77, 81, 83, 86, 89, 93];

    // Chromatic solo tuning, semitone offsets from each 4-hole group root:
    // blow C E G C, draw D F A B. The slide adds +1 to every note.
    const SOLO_BLOW = [0, 4, 7, 12];
    const SOLO_DRAW = [2, 5, 9, 11];

    const KEY_PC = {
        'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5,
        'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11
    };

    // Diatonic Richter transposed by the chosen key, then clamped to the
    // instrument's range so the hole count follows the range. With no
    // configured range it keeps the fixed 10-hole reference; for the default
    // (key C → keyOff 0, no range) it is byte-identical to the old layout.
    function richterKeyed(lo, hi, keyOff) {
        if (!Number.isFinite(lo)) {
            return {
                blow: BLOW0.map(n => n + keyOff),
                draw: DRAW0.map(n => n + keyOff)
            };
        }
        const off = lo - BLOW0[0] + keyOff;
        const blow = [], draw = [];
        for (let i = 0; i < BLOW0.length; i++) {
            const b = BLOW0[i] + off, d = DRAW0[i] + off;
            if (Number.isFinite(hi) && (b > hi || d > hi)) break;
            blow.push(b); draw.push(d);
        }
        return blow.length ? { blow, draw } : { blow: [lo], draw: [lo] };
    }

    // Chromatic solo tuning: emit as many 4-hole groups as the range allows
    // (default 12 holes / 3 groups when no range is configured). A hole is
    // dropped — not truncated mid-group — as soon as its blow or draw note
    // exceeds the range max, mirroring the richter() clamp semantics.
    function chromaticSolo(lo, hi, keyOff) {
        const base = Number.isFinite(lo) ? lo : BLOW0[0];
        const root = base + keyOff;
        const blow = [], draw = [];
        for (let g = 0; ; g++) {
            for (let k = 0; k < 4; k++) {
                const b = root + 12 * g + SOLO_BLOW[k];
                const d = root + 12 * g + SOLO_DRAW[k];
                if (Number.isFinite(hi) && (b > hi || d > hi)) {
                    return blow.length
                        ? { blow, draw } : { blow: [base], draw: [base] };
                }
                blow.push(b); draw.push(d);
            }
            // No configured upper bound → stop after 3 groups (12 holes).
            if (!Number.isFinite(hi) && g >= 2) break;
        }
        return blow.length ? { blow, draw } : { blow: [base], draw: [base] };
    }

    // Count-driven layouts. When the instrument has a discrete note
    // selection, the hole count follows it: 1 hole = 1 blow + 1 draw, so
    // N configured notes → round(N / 2) holes. The pattern is extended past
    // the 10-hole reference by octave (period-3 tiling, +12) so an arbitrary
    // hole count stays musically coherent.
    const BLOW_REL = BLOW0.map(n => n - BLOW0[0]);
    const DRAW_REL = DRAW0.map(n => n - BLOW0[0]);

    function relOff(rel, i) {
        return i < rel.length ? rel[i] : relOff(rel, i - 3) + 12;
    }

    function holesFromCount(noteCount) {
        return Math.max(1, Math.round(noteCount / 2));
    }

    function richterCount(base, keyOff, holes) {
        const off = base + keyOff;
        const blow = [], draw = [];
        for (let i = 0; i < holes; i++) {
            blow.push(off + relOff(BLOW_REL, i));
            draw.push(off + relOff(DRAW_REL, i));
        }
        return { blow, draw };
    }

    function chromaticCount(base, keyOff, holes) {
        const root = base + keyOff;
        const blow = [], draw = [];
        for (let i = 0; i < holes; i++) {
            const g = Math.floor(i / 4), k = i % 4;
            blow.push(root + 12 * g + SOLO_BLOW[k]);
            draw.push(root + 12 * g + SOLO_DRAW[k]);
        }
        return { blow, draw };
    }

    class HarmonicaView extends InstrumentView {
        static viewKind = 'harmonica';
        static iconUrl = '/assets/instruments/harmonica.svg';
        static emoji = '🎼';
        static labelKey = 'keyboard.viewHarmonica';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;

            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;

            // Remove a stale container from a previous (crashed) mount.
            document.getElementById('harmonica-container')?.remove();

            const cfg = (typeof modal.getHarmonicaConfig === 'function'
                ? modal.getHarmonicaConfig() : null) || { type: 'diatonic', key: 'C' };
            this._chromatic = cfg.type === 'chromatic';
            const keyOff = KEY_PC[cfg.key] || 0;

            // Hole count follows the instrument's configured notes. With a
            // discrete note selection it is count-driven (1 hole = blow +
            // draw, so N notes → round(N/2) holes, pattern extended by
            // octave). Otherwise it follows the min/max range (clamped
            // reference layout) — unchanged legacy behaviour.
            const rng = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const lo = rng ? rng.min : NaN;
            const hi = rng ? rng.max : NaN;
            const count = (rng && Array.isArray(rng.notes) && rng.notes.length)
                ? rng.notes.length : null;
            let blow, draw;
            if (count != null) {
                const holes = holesFromCount(count);
                ({ blow, draw } = this._chromatic
                    ? chromaticCount(lo, keyOff, holes)
                    : richterCount(lo, keyOff, holes));
            } else {
                ({ blow, draw } = this._chromatic
                    ? chromaticSolo(lo, hi, keyOff)
                    : richterKeyed(lo, hi, keyOff));
            }

            // Note label resolver, reused by the rows and by _setSlide() so
            // the displayed pitch tracks the slide.
            this._noteLabel = (typeof modal.getNoteLabel === 'function')
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);

            const root = document.createElement('div');
            root.id = 'harmonica-container';
            root.className = 'harmonica-view'
                + (this._chromatic ? ' harmonica-chromatic' : ' harmonica-diatonic');

            // Souffler/Aspirer labels live OUTSIDE the device, in a left
            // column aligned with the blow/draw rows.
            const labels = this._buildLabels();

            const device = document.createElement('div');
            device.className = 'harmonica-device';

            const coverTop = document.createElement('div');
            coverTop.className = 'harmonica-cover harmonica-cover-top';
            const coverBottom = document.createElement('div');
            coverBottom.className = 'harmonica-cover harmonica-cover-bottom';

            const body = document.createElement('div');
            body.className = 'harmonica-body';

            const comb = document.createElement('div');
            comb.className = 'harmonica-comb';
            comb.appendChild(this._buildRow('blow', blow, modal));
            comb.appendChild(this._buildRow('draw', draw, modal));
            body.appendChild(comb);

            if (this._chromatic) {
                const slide = document.createElement('button');
                slide.type = 'button';
                slide.className = 'harmonica-slide';
                slide.setAttribute('aria-pressed', 'false');
                slide.innerHTML =
                    `<span class="harmonica-slide-label">`
                    + `${this._t('keyboard.harmonicaSlide', 'Glissière')}</span>`
                    + `<span class="harmonica-slide-track">`
                    + `<span class="harmonica-slide-knob"></span></span>`;
                this._slideBtn = slide;
                // Click to toggle (click again to release) — not hold.
                this._onSlideClick = (e) => {
                    e.preventDefault();
                    this._setSlide(!this._slide);
                };
                slide.addEventListener('click', this._onSlideClick);
            }

            device.appendChild(coverTop);
            device.appendChild(body);
            device.appendChild(coverBottom);
            // The slide is a real button protruding from the RIGHT side of
            // the device, so it lives on the device (positioned), not in body.
            if (this._slideBtn) device.appendChild(this._slideBtn);
            root.appendChild(labels);
            root.appendChild(device);
            canvas.appendChild(root);
            this._root = root;

            // Pressed holes tracked per (row:idx) so the same MIDI value on
            // two holes (e.g. G4 = hole2 draw & hole3 blow) is independent.
            // Value = { base, sounding }: `base` is the un-shifted hole pitch
            // (kept in data-note); `sounding` is what is actually playing
            // (base + 1 while the slide is engaged) so a held note tracks the
            // slide and the correct pitch is always the one we stop.
            this._pressed = new Map();
            this._slide = false;

            // Piano-like drag: slide across the holes for a glissando
            // (slide-aware — each entered hole sounds at base + slide).
            // The chromatic slide is an independent click-to-toggle latch:
            // its `.harmonica-slide` button is not a `.harmonica-hole`, so
            // a pointerdown there never starts a glide and the latch is NOT
            // dropped on pointerup.
            this._initGlide({ root, selector: '.harmonica-hole' });
        }

        // The Souffler/Aspirer labels, as a left column OUTSIDE the device.
        // One label per row (blow, draw); CSS aligns each on its row.
        _buildLabels() {
            const wrap = document.createElement('div');
            wrap.className = 'harmonica-labels';
            for (const kind of ['blow', 'draw']) {
                const label = document.createElement('span');
                label.className = `harmonica-row-label harmonica-row-label-${kind}`;
                label.textContent = kind === 'blow'
                    ? this._t('keyboard.harmonicaBlow', 'Souffler ↑')
                    : this._t('keyboard.harmonicaDraw', 'Aspirer ↓');
                wrap.appendChild(label);
            }
            return wrap;
        }

        _buildRow(kind, notes, modal) {
            const row = document.createElement('div');
            row.className = `harmonica-row harmonica-row-${kind}`;
            const label = this._noteLabel;
            notes.forEach((midi, idx) => {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = `harmonica-hole harmonica-${kind}`;
                cell.dataset.row = kind;
                cell.dataset.idx = String(idx);
                cell.dataset.note = String(midi);
                cell.innerHTML =
                    `<span class="harmonica-hole-num">${idx + 1}</span>`
                    + `<span class="harmonica-hole-note">${label(midi)}</span>`;
                // Optional chromatic colour override wins over the CSS skin
                // (kept inline, keyed on the un-shifted pitch so it is stable
                // as the slide toggles).
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    cell.style.background = c.bg;
                    cell.style.color = c.text;
                }
                row.appendChild(cell);
            });
            return row;
        }

        _glideKey(cell) {
            return `${cell.dataset.row}:${cell.dataset.idx}`;
        }

        _pressCell(cell) {
            const key = `${cell.dataset.row}:${cell.dataset.idx}`;
            if (this._pressed.has(key)) return;
            const base = parseInt(cell.dataset.note, 10);
            const sounding = base + (this._slide ? 1 : 0);
            this._pressed.set(key, { base, sounding });
            cell.classList.add('active');
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.playNote === 'function') modal.playNote(sounding);
        }

        _releaseKey(key, cell) {
            if (!this._pressed.has(key)) return;
            const st = this._pressed.get(key);
            this._pressed.delete(key);
            if (cell) cell.classList.remove('active');
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.stopNote === 'function') modal.stopNote(st.sounding);
        }

        // Release every held hole. The slide is a separate latch and is
        // intentionally NOT reset here — a global pointerup must not undo
        // the user's click-toggled slide.
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

        // Toggle the slide. Rewrites every hole's displayed note to the
        // shifted pitch (+1 when engaged) and re-pitches any held hole so a
        // sustained note tracks the slide, exactly like a real chromatic
        // harmonica. Stop the old pitch, start the new one.
        _setSlide(on) {
            on = !!on;
            if (on === this._slide) return;
            this._slide = on;
            if (this._slideBtn) {
                this._slideBtn.classList.toggle('engaged', on);
                this._slideBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
            const shift = on ? 1 : 0;
            // Displayed note follows the slide on every hole.
            if (this._root && this._noteLabel) {
                this._root.querySelectorAll('.harmonica-hole').forEach((cell) => {
                    const base = parseInt(cell.dataset.note, 10);
                    const noteEl = cell.querySelector('.harmonica-hole-note');
                    if (noteEl) noteEl.textContent = this._noteLabel(base + shift);
                });
            }
            const modal = this.ctx && this.ctx.modal;
            for (const st of this._pressed.values()) {
                const next = st.base + shift;
                if (next === st.sounding) continue;
                if (modal && typeof modal.stopNote === 'function') modal.stopNote(st.sounding);
                st.sounding = next;
                if (modal && typeof modal.playNote === 'function') modal.playNote(next);
            }
        }

        unmount() {
            this._releaseAll();
            if (this._slideBtn && this._onSlideClick) {
                this._slideBtn.removeEventListener('click', this._onSlideClick);
            }
            this._teardownGlide();
            if (this._root) {
                this._root.remove();
                this._root = null;
            }
            this._slideBtn = null;
            this._slide = false;
            this._pressed = null;
            super.unmount();
        }

        setActiveNotes(activeMidiSet) {
            if (!this._root) return;
            const set = activeMidiSet instanceof Set ? activeMidiSet : new Set();
            const shift = this._slide ? 1 : 0;
            this._root.querySelectorAll('.harmonica-hole').forEach(cell => {
                const base = parseInt(cell.dataset.note, 10);
                const key = `${cell.dataset.row}:${cell.dataset.idx}`;
                // Keep locally-pressed holes lit even if the set lags.
                cell.classList.toggle('active',
                    this._pressed?.has(key) || set.has(base + shift));
            });
        }

        // A note-format / colour toggle rebuilds the view (unmount+mount).
        // Preserve the chromatic slide latch across the rebuild so toggling
        // the label format mid-performance doesn't silently release it.
        rerender() {
            const wasSlid = !!this._slide;
            super.rerender();
            if (wasSlid && this._slideBtn) this._setSlide(true);
        }
    }

    if (typeof window !== 'undefined') window.HarmonicaView = HarmonicaView;
    if (typeof module !== 'undefined') module.exports = HarmonicaView;
})();
