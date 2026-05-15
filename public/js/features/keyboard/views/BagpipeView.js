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

    const DRONE = 45;                                   // A2 drone
    // GHB chanter (approx, A-mixolydian): Low G..High A
    const CHANTER = [55, 57, 59, 61, 62, 64, 66, 67, 69];

    class BagpipeView extends InstrumentView {
        static viewKind = 'bagpipe';
        static emoji = '🎵';
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

            const drone = document.createElement('button');
            drone.type = 'button';
            drone.id = 'bagpipe-drone-toggle';
            drone.className = 'bagpipe-drone active';
            drone.textContent = '🟢 Drone';
            drone.style.cssText =
                'padding:6px 14px;border-radius:16px;border:1px solid #555;'
                + 'background:#234d23;color:#dfe;cursor:pointer;font:12px sans-serif;';
            drone.addEventListener('click', () => this._toggleDrone());
            root.appendChild(drone);
            this._droneBtn = drone;

            const label = typeof modal.getNoteLabel === 'function'
                ? (n) => modal.getNoteLabel(n) : (n) => String(n);
            const chanter = document.createElement('div');
            chanter.className = 'bagpipe-chanter';
            chanter.style.cssText = 'display:flex;gap:6px;';
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
                chanter.appendChild(h);
            });
            root.appendChild(chanter);
            canvas.appendChild(root);

            this._root = root;
            this._pressed = new Map();
            this._droneOn = false;
            this._onDown = (e) => this._press(e);
            this._onDocUp = () => this._releaseAll();
            root.addEventListener('pointerdown', this._onDown);
            document.addEventListener('pointerup', this._onDocUp);
            document.addEventListener('pointercancel', this._onDocUp);

            this._startDrone();
        }

        _startDrone() {
            if (this._droneOn) return;
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.playNote === 'function') modal.playNote(DRONE);
            this._droneOn = true;
            if (this._droneBtn) {
                this._droneBtn.classList.add('active');
                this._droneBtn.textContent = '🟢 Drone';
            }
        }

        _stopDrone() {
            if (!this._droneOn) return;
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.stopNote === 'function') modal.stopNote(DRONE);
            this._droneOn = false;
            if (this._droneBtn) {
                this._droneBtn.classList.remove('active');
                this._droneBtn.textContent = '⚪ Drone';
            }
        }

        _toggleDrone() { this._droneOn ? this._stopDrone() : this._startDrone(); }

        _press(e) {
            const cell = e.target && e.target.closest
                ? e.target.closest('.bagpipe-hole') : null;
            if (!cell || !this._root.contains(cell)) return;
            if (e.cancelable) e.preventDefault();
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
            this._stopDrone();
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
            this._root.querySelectorAll('.bagpipe-hole').forEach(cell => {
                cell.classList.toggle('active',
                    this._pressed?.has(cell.dataset.idx)
                    || set.has(parseInt(cell.dataset.note, 10)));
            });
        }

        toolbarGroups() { return new Set(['notation', 'velocity', 'view-mode']); }
    }

    if (typeof window !== 'undefined') window.BagpipeView = BagpipeView;
    if (typeof module !== 'undefined') module.exports = BagpipeView;
})();
