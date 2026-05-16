// =============================================================================
// BagpipeView.js — Great Highland Bagpipe (GM 109).
// =============================================================================
// A constant drone (Low A) that sounds while the view is mounted, plus a
// 9-note chanter scale (Low G … High A). The drone can be toggled. The
// chanter is monophonic-feel but tracked per key; a global pointerup
// releases held chanter notes (the drone is independent). Self-owned DOM.
// =============================================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    // GHB chanter (approx, A-mixolydian): Low G..High A — reference.
    const CHANTER0 = [55, 57, 59, 61, 62, 64, 66, 67, 69];

    // Transpose the chanter so its lowest note is `lo`, trim to `hi`, so
    // the number of chanter holes follows the configured range (QA).
    function chanterNotes(lo, hi) {
        if (!Number.isFinite(lo)) return CHANTER0;
        const off = lo - CHANTER0[0];
        const out = [];
        for (const c of CHANTER0) {
            const m = c + off;
            if (Number.isFinite(hi) && m > hi) break;
            out.push(m);
        }
        return out.length ? out : [lo];
    }

    class BagpipeView extends InstrumentView {
        static viewKind = 'bagpipe';
        static iconUrl = '/assets/instruments/bagpipe.svg';
        static emoji = '🎐';
        static labelKey = 'keyboard.viewBagpipe';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            const canvas = document.getElementById('keyboard-canvas-container');
            if (!canvas) return;
            document.getElementById('bagpipe-container')?.remove();

            const root = document.createElement('div');
            root.id = 'bagpipe-container';
            root.className = 'bagpipe-view';
            root.style.cssText =
                'display:flex;flex-direction:column;gap:12px;padding:18px;'
                + 'align-items:center;justify-content:center;height:100%;'
                + 'touch-action:none;';

            // Instrument-specific drone notes from the per-instrument
            // capabilities. Each configured drone is an independent
            // instance (duplicates like the Great Highland's two A's are
            // kept) and gets its own toggle inside the master control; a
            // master button toggles them all at once. Drones never sound
            // automatically — the player turns them on.
            const bcfg = typeof modal.getBagpipeConfig === 'function'
                ? modal.getBagpipeConfig()
                : { drones: [45], droneObjs: [{ note: 45, enabled: true }], enabled: true };
            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            const droneObjs = Array.isArray(bcfg.droneObjs)
                ? bcfg.droneObjs
                : (bcfg.drones || []).map(n => ({ note: n, enabled: true }));
            // Per-drone runtime state. Drones never sound automatically:
            // they all start silent and the player enables them.
            this._drones = droneObjs.map(o => ({ note: o.note, on: false }));
            // Reference count per MIDI note so two drones on the same note
            // don't silence each other when only one is turned off.
            this._noteRefs = new Map();

            // The per-drone buttons live *inside* the master "all drones"
            // control: one bordered card whose header toggles every drone
            // and whose body holds an individual toggle per drone.
            const droneBox = document.createElement('div');
            droneBox.className = 'bagpipe-drones';
            droneBox.style.cssText =
                'display:flex;flex-direction:column;gap:8px;align-items:center;'
                + 'padding:8px 12px;border-radius:18px;border:1px solid #6a6;'
                + 'background:#1d3a1d;';

            const master = document.createElement('button');
            master.type = 'button';
            master.id = 'bagpipe-drone-toggle';
            master.className = 'bagpipe-drone bagpipe-drone-master';
            master.style.cssText =
                'padding:6px 14px;border-radius:16px;border:1px solid #6a6;'
                + 'background:#234d23;color:#dfe;cursor:pointer;font:12px sans-serif;';
            droneBox.appendChild(master);
            this._droneMaster = master;

            const list = document.createElement('div');
            list.className = 'bagpipe-drone-list';
            list.style.cssText =
                'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;';
            this._droneBtns = this._drones.map((d, idx) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'bagpipe-drone bagpipe-drone-one';
                b.dataset.idx = String(idx);
                b.style.cssText =
                    'padding:5px 11px;border-radius:14px;border:1px solid #555;'
                    + 'background:#2c422c;color:#dfe;cursor:pointer;font:11px sans-serif;';
                b._noteLabel = label(d.note);
                list.appendChild(b);
                return b;
            });
            droneBox.appendChild(list);

            this._onDroneClick = (e) => {
                const closest = e.target && e.target.closest
                    ? (s) => e.target.closest(s) : () => null;
                const one = closest('.bagpipe-drone-one');
                if (one && droneBox.contains(one)) {
                    const idx = parseInt(one.dataset.idx, 10);
                    if (Number.isInteger(idx) && this._drones[idx]) {
                        this._setDrone(idx, !this._drones[idx].on);
                    }
                    return;
                }
                if (closest('#bagpipe-drone-toggle')) this._toggleAllDrones();
            };
            droneBox.addEventListener('click', this._onDroneClick);
            root.appendChild(droneBox);
            this._droneRow = droneBox;
            const chanter = document.createElement('div');
            chanter.className = 'bagpipe-chanter';
            chanter.style.cssText = 'display:flex;gap:6px;';
            const rng = typeof modal.getInstrumentNoteRange === 'function'
                ? modal.getInstrumentNoteRange() : null;
            const CHANTER = chanterNotes(rng ? rng.min : NaN, rng ? rng.max : NaN);
            CHANTER.forEach((midi, idx) => {
                const h = document.createElement('button');
                h.type = 'button';
                h.className = 'bagpipe-hole';
                h.dataset.idx = String(idx);
                h.dataset.note = String(midi);
                h.title = label(midi);
                h.style.cssText =
                    'width:40px;height:70px;border-radius:20px;border:1px solid #444;'
                    + 'background:#3a352b;color:#e8e8e8;cursor:pointer;font:11px sans-serif;';
                h.textContent = label(midi);
                if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
                    const c = modal.getNoteColor(midi);
                    h.style.background = c.bg;
                    h.style.color = c.text;
                }
                chanter.appendChild(h);
            });
            root.appendChild(chanter);
            canvas.appendChild(root);

            this._root = root;
            this._pressed = new Map();
            // Piano-like drag on the chanter (the `.bagpipe-hole` selector
            // means a pointerdown on a drone button never starts a glide;
            // the drones keep their own click-toggle handler + sustain
            // independently of the chanter).
            this._initGlide({ root, selector: '.bagpipe-hole' });

            // Drones start silent — only paint the buttons.
            this._syncDroneBtns();
        }

        _droneNoteOn(note) {
            const refs = this._noteRefs;
            const c = (refs.get(note) || 0) + 1;
            refs.set(note, c);
            if (c === 1) {
                const modal = this.ctx && this.ctx.modal;
                if (modal && typeof modal.playNote === 'function') modal.playNote(note);
            }
        }

        _droneNoteOff(note) {
            const refs = this._noteRefs;
            const c = refs.get(note) || 0;
            if (c <= 0) return;
            if (c === 1) {
                refs.delete(note);
                const modal = this.ctx && this.ctx.modal;
                if (modal && typeof modal.stopNote === 'function') modal.stopNote(note);
            } else {
                refs.set(note, c - 1);
            }
        }

        _setDrone(idx, on) {
            const d = this._drones && this._drones[idx];
            if (!d || d.on === !!on) return;
            d.on = !!on;
            if (d.on) this._droneNoteOn(d.note);
            else this._droneNoteOff(d.note);
            this._syncDroneBtns();
        }

        // Master button: any drone on → silence them all; otherwise sound all.
        _toggleAllDrones() {
            if (!this._drones) return;
            const anyOn = this._drones.some(d => d.on);
            this._drones.forEach((d, idx) => this._setDrone(idx, !anyOn));
        }

        _syncDroneBtns() {
            const total = this._drones ? this._drones.length : 0;
            const active = this._drones
                ? this._drones.filter(d => d.on).length : 0;
            if (this._droneMaster) {
                this._droneMaster.classList.toggle('active', active > 0);
                const allLbl = this._t('keyboard.bagpipeAllDrones', 'Tous les bourdons');
                this._droneMaster.textContent =
                    `${active > 0 ? '🟢' : '⚪'} ${allLbl} (${active}/${total})`;
            }
            if (this._droneBtns) {
                this._droneBtns.forEach((b, idx) => {
                    const on = !!(this._drones[idx] && this._drones[idx].on);
                    b.classList.toggle('active', on);
                    b.textContent = `${on ? '🟢' : '⚪'} ${b._noteLabel}`;
                });
            }
        }

        _glideKey(cell) { return cell.dataset.idx; }

        _pressCell(cell) {
            const key = cell.dataset.idx;
            if (this._pressed.has(key)) return;
            const note = parseInt(cell.dataset.note, 10);
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
                    ? this._root.querySelector(`.bagpipe-hole[data-idx="${key}"]`) : null;
                if (cell) cell.classList.remove('active');
                if (modal && typeof modal.stopNote === 'function') modal.stopNote(note);
            }
        }

        unmount() {
            this._releaseAll();
            if (this._drones) {
                this._drones.forEach((d) => {
                    if (d.on) { d.on = false; this._droneNoteOff(d.note); }
                });
            }
            if (this._droneRow && this._onDroneClick) {
                this._droneRow.removeEventListener('click', this._onDroneClick);
            }
            this._droneRow = null;
            this._droneMaster = null;
            this._droneBtns = null;
            this._drones = null;
            this._noteRefs = null;
            this._onDroneClick = null;
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
            this._root.querySelectorAll('.bagpipe-hole').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.idx)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }

        // A note-format / colour toggle rebuilds the view (unmount+mount),
        // which would silence every drone. Capture the per-drone on/off
        // state and restore it after the rebuild so a sustained drone keeps
        // sounding across a label-format change.
        rerender() {
            const wasOn = Array.isArray(this._drones)
                ? this._drones.map(d => !!d.on) : null;
            super.rerender();
            if (wasOn && Array.isArray(this._drones)) {
                wasOn.forEach((on, idx) => { if (on) this._setDrone(idx, true); });
            }
        }
    }

    if (typeof window !== 'undefined') window.BagpipeView = BagpipeView;
    if (typeof module !== 'undefined') module.exports = BagpipeView;
})();
