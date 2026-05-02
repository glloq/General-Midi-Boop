// =============================================================================
// KeyboardListView.js — Vue clavier horizontal compact avec fondu entre les notes
// Notes disposées de gauche (grave) à droite (aigu), hauteur fixe.
// - Clic Y → vélocité (haut = fort, bas = doux)
// - Drag X → pitch bend (gauche/droite), uniquement si pitch_bend_enabled
// - Glow radial centré sur la note active → fondu visuel vers les notes voisines
// =============================================================================
(function () {
    'use strict';

    const KeyboardListViewMixin = {};

    /**
     * Render the horizontal keyboard list: equal-width note cells, left = low.
     * A radial glow layer creates the fondu effect between adjacent notes.
     */
    KeyboardListViewMixin.renderKeyboardList = function () {
        const container = document.getElementById('keyboard-list-container');
        if (!container) return;

        container.innerHTML = '';
        container.style.removeProperty('--glow-x');
        container.style.removeProperty('--glow-w');
        container.classList.remove('has-active-note');

        const totalNotes = this.visibleNoteCount;
        const endNote = this.startNote + totalNotes - 1;

        // Glow width adapts to visible range: narrower when many notes, wider when few
        const glowW = Math.max(5, Math.min(22, Math.round(280 / totalNotes)));
        container.style.setProperty('--glow-w', glowW + '%');

        const keysRow = document.createElement('div');
        keysRow.className = 'keyboard-list-keys-row';
        keysRow.id = 'keyboard-list-keys-row';

        for (let midi = this.startNote; midi <= endNote; midi++) {
            const semitone = midi % 12;
            const isBlack = this.blackNoteSemitones.has(semitone);
            const isC = semitone === 0;
            const label = this.getNoteLabel(midi);
            const playable = this.isNotePlayable(midi);

            const key = document.createElement('div');
            key.className = [
                'keyboard-list-key',
                'piano-key',
                isBlack ? 'keyboard-list-black' : 'keyboard-list-white',
                isC ? 'keyboard-list-c' : '',
                playable ? '' : 'disabled'
            ].filter(Boolean).join(' ');
            key.dataset.note = midi;

            // Label: always on C notes; also on every note when zoomed in
            if (isC || totalNotes <= 24) {
                const lbl = document.createElement('span');
                lbl.className = 'keyboard-list-key-label';
                lbl.textContent = label;
                key.appendChild(lbl);
            }

            // Pitch bend cursor (vertical amber line, slides left-right)
            const cursor = document.createElement('div');
            cursor.className = 'keyboard-list-pb-cursor';
            key.appendChild(cursor);

            keysRow.appendChild(key);
        }

        container.appendChild(keysRow);
        this._initKeyboardListInteraction(container);
    };

    // -------------------------------------------------------------------------
    // Interaction
    // -------------------------------------------------------------------------

    KeyboardListViewMixin._initKeyboardListInteraction = function (container) {
        this._destroyKeyboardListInteraction();

        let activeNote = null;
        let activeKey = null;

        const hasPitchBend = () => {
            const caps = this.selectedDeviceCapabilities;
            return !!(caps && caps.pitch_bend_enabled);
        };

        // Y position within key → velocity (top = 127, bottom = 1)
        const getVelocityFromY = (key, clientY) => {
            const rect = key.getBoundingClientRect();
            const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
            return Math.max(1, Math.min(127, Math.round(ratio * 127)));
        };

        // X position within key → pitch bend (left = -8191, center = 0, right = +8191)
        const getPitchBendFromX = (key, clientX) => {
            const rect = key.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            return Math.round((ratio - 0.5) * 2 * 8191);
        };

        // Glow layer follows cursor X for fondu effect
        const updateGlow = (clientX) => {
            const row = document.getElementById('keyboard-list-keys-row');
            if (!row) return;
            const rect = row.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            container.style.setProperty('--glow-x', pct + '%');
            container.classList.add('has-active-note');
        };

        const clearGlow = () => container.classList.remove('has-active-note');

        const showPBCursor = (key, clientX) => {
            const cursor = key.querySelector('.keyboard-list-pb-cursor');
            if (!cursor) return;
            const rect = key.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            cursor.style.left = pct + '%';
            cursor.style.display = 'block';
        };

        const hidePBCursor = (key) => {
            const c = key?.querySelector('.keyboard-list-pb-cursor');
            if (c) c.style.display = 'none';
        };

        const updateVelocityUI = (vel) => {
            const display = document.getElementById('keyboard-velocity-display');
            if (display) display.textContent = vel;
            const slider = document.getElementById('keyboard-velocity');
            if (slider) slider.value = vel;
        };

        const onDown = (key, clientX, clientY) => {
            const note = parseInt(key.dataset.note, 10);
            if (isNaN(note) || key.classList.contains('disabled')) return;

            activeNote = note;
            activeKey = key;

            const vel = getVelocityFromY(key, clientY);
            this.velocity = vel;
            updateVelocityUI(vel);

            this.mouseActiveNotes.add(note);
            this.playNote(note);

            // Glow centered on cursor for immediate fondu feedback
            updateGlow(clientX);

            if (hasPitchBend()) {
                this._sendPitchBend(getPitchBendFromX(key, clientX));
                showPBCursor(key, clientX);
            }
        };

        const onMove = (clientX, clientY) => {
            if (activeNote === null || !activeKey) return;

            // Glow follows cursor → fondu into neighboring notes during drag
            updateGlow(clientX);

            if (hasPitchBend()) {
                this._sendPitchBend(getPitchBendFromX(activeKey, clientX));
                showPBCursor(activeKey, clientX);
            }

            // Velocity feedback from vertical drag
            updateVelocityUI(getVelocityFromY(activeKey, clientY));
        };

        const onUp = () => {
            if (activeNote !== null) {
                if (hasPitchBend()) this._sendPitchBend(0);
                hidePBCursor(activeKey);
                clearGlow();
                this.mouseActiveNotes.delete(activeNote);
                this.stopNote(activeNote);
                activeNote = null;
                activeKey = null;
            }
        };

        this._klvMouseDown = (e) => {
            const key = e.target.closest('.keyboard-list-key');
            if (!key) return;
            e.preventDefault();
            onDown(key, e.clientX, e.clientY);
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
            const key = e.target.closest('.keyboard-list-key');
            if (!key) return;
            e.preventDefault();
            onDown(key, e.touches[0].clientX, e.touches[0].clientY);
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
