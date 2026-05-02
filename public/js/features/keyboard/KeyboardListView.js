// =============================================================================
// KeyboardListView.js — Vue liste du clavier virtuel
// Affiche les notes dans une liste verticale (une ligne par note).
// - Clic Y → vélocité (haut = fort, bas = doux)
// - Drag X → pitch bend (gauche/droite), uniquement si pitch_bend_enabled
// =============================================================================
(function () {
    'use strict';

    const KeyboardListViewMixin = {};

    /**
     * Render the keyboard list: one horizontal bar per note, highest note first.
     */
    KeyboardListViewMixin.renderKeyboardList = function () {
        const container = document.getElementById('keyboard-list-container');
        if (!container) return;

        container.innerHTML = '';

        const endNote = this.startNote + this.visibleNoteCount - 1;

        // Top of list = highest note (mirrors piano orientation)
        for (let midi = endNote; midi >= this.startNote; midi--) {
            const semitone = midi % 12;
            const isBlack = this.blackNoteSemitones.has(semitone);
            const isC = semitone === 0;
            const label = this.getNoteLabel(midi);
            const playable = this.isNotePlayable(midi);

            const row = document.createElement('div');
            row.className = [
                'keyboard-list-key',
                'piano-key',
                isBlack ? 'keyboard-list-black' : 'keyboard-list-white',
                isC ? 'keyboard-list-c' : '',
                playable ? '' : 'disabled'
            ].filter(Boolean).join(' ');
            row.dataset.note = midi;

            const labelEl = document.createElement('span');
            labelEl.className = 'keyboard-list-key-label';
            labelEl.textContent = label;
            row.appendChild(labelEl);

            // Pitch bend cursor (vertical line, slides left/right)
            const cursor = document.createElement('div');
            cursor.className = 'keyboard-list-pb-cursor';
            row.appendChild(cursor);

            container.appendChild(row);
        }

        this._initKeyboardListInteraction(container);
    };

    // -------------------------------------------------------------------------
    // Interaction: velocity from Y, pitch bend from X
    // -------------------------------------------------------------------------

    KeyboardListViewMixin._initKeyboardListInteraction = function (container) {
        this._destroyKeyboardListInteraction();

        let activeNote = null;
        let activeRow = null;

        const hasPitchBend = () => {
            const caps = this.selectedDeviceCapabilities;
            return !!(caps && caps.pitch_bend_enabled);
        };

        const getVelocityFromY = (row, clientY) => {
            const rect = row.getBoundingClientRect();
            const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
            return Math.max(1, Math.min(127, Math.round(ratio * 127)));
        };

        const getPitchBendFromX = (row, clientX) => {
            const rect = row.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            // Map [0..1] → [-8191..+8191]
            return Math.round((ratio - 0.5) * 2 * 8191);
        };

        const showPBCursor = (row, clientX) => {
            const cursor = row.querySelector('.keyboard-list-pb-cursor');
            if (!cursor) return;
            const rect = row.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            cursor.style.left = pct + '%';
            cursor.style.display = 'block';
        };

        const hidePBCursor = (row) => {
            const cursor = row?.querySelector('.keyboard-list-pb-cursor');
            if (cursor) cursor.style.display = 'none';
        };

        const updateVelocityUI = (vel) => {
            const display = document.getElementById('keyboard-velocity-display');
            if (display) display.textContent = vel;
            const slider = document.getElementById('keyboard-velocity');
            if (slider) slider.value = vel;
        };

        const onDown = (row, clientX, clientY) => {
            const note = parseInt(row.dataset.note, 10);
            if (isNaN(note) || row.classList.contains('disabled')) return;

            activeNote = note;
            activeRow = row;

            const vel = getVelocityFromY(row, clientY);
            this.velocity = vel;
            updateVelocityUI(vel);

            this.mouseActiveNotes.add(note);
            this.playNote(note);

            if (hasPitchBend()) {
                this._sendPitchBend(getPitchBendFromX(row, clientX));
                showPBCursor(row, clientX);
            }
        };

        const onMove = (clientX, clientY) => {
            if (activeNote === null || !activeRow) return;

            if (hasPitchBend()) {
                this._sendPitchBend(getPitchBendFromX(activeRow, clientX));
                showPBCursor(activeRow, clientX);
            }

            // Reflect vertical drag as velocity feedback (visual only after note-on)
            updateVelocityUI(getVelocityFromY(activeRow, clientY));
        };

        const onUp = () => {
            if (activeNote !== null) {
                if (hasPitchBend()) this._sendPitchBend(0);
                hidePBCursor(activeRow);
                this.mouseActiveNotes.delete(activeNote);
                this.stopNote(activeNote);
                activeNote = null;
                activeRow = null;
            }
        };

        this._klvMouseDown = (e) => {
            const row = e.target.closest('.keyboard-list-key');
            if (!row) return;
            e.preventDefault();
            onDown(row, e.clientX, e.clientY);
            const moveH = (ev) => onMove(ev.clientX, ev.clientY);
            const upH = () => {
                onUp();
                document.removeEventListener('mousemove', moveH);
                document.removeEventListener('mouseup', upH);
            };
            document.addEventListener('mousemove', moveH);
            document.addEventListener('mouseup', upH);
        };

        this._klvTouchStart = (e) => {
            const row = e.target.closest('.keyboard-list-key');
            if (!row) return;
            e.preventDefault();
            onDown(row, e.touches[0].clientX, e.touches[0].clientY);
        };
        this._klvTouchMove = (e) => {
            e.preventDefault();
            if (e.touches.length > 0) onMove(e.touches[0].clientX, e.touches[0].clientY);
        };
        this._klvTouchEnd = () => onUp();

        container.addEventListener('mousedown', this._klvMouseDown);
        container.addEventListener('touchstart', this._klvTouchStart, { passive: false });
        container.addEventListener('touchmove', this._klvTouchMove, { passive: false });
        container.addEventListener('touchend', this._klvTouchEnd);

        this._klvContainer = container;
    };

    KeyboardListViewMixin._destroyKeyboardListInteraction = function () {
        const c = this._klvContainer;
        if (!c) return;
        if (this._klvMouseDown) c.removeEventListener('mousedown', this._klvMouseDown);
        if (this._klvTouchStart) c.removeEventListener('touchstart', this._klvTouchStart);
        if (this._klvTouchMove) c.removeEventListener('touchmove', this._klvTouchMove);
        if (this._klvTouchEnd) c.removeEventListener('touchend', this._klvTouchEnd);
        this._klvMouseDown = null;
        this._klvTouchStart = null;
        this._klvTouchMove = null;
        this._klvTouchEnd = null;
        this._klvContainer = null;
    };

    if (typeof window !== 'undefined') window.KeyboardListViewMixin = KeyboardListViewMixin;
})();
