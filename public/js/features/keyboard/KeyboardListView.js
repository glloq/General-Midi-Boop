// =============================================================================
// KeyboardListView.js — Vue clavier horizontal compact avec fondu entre les notes
// Notes disposées de gauche (grave) à droite (aigu), hauteur identique au piano.
// - Clic Y → vélocité (haut = fort, bas = doux)
// - Drag X → pitch bend (gauche/droite), uniquement si pitch_bend_enabled
// - Glow radial centré sur la note active → fondu visuel vers les notes voisines
// - Support des couleurs chromatiques (bouton 🎨) avec glow coloré adaptatif
// =============================================================================
(function () {
    'use strict';

    const KeyboardListViewMixin = {};

    // Couleurs chromatiques (12 demi-tons, identiques à FRET_NOTE_COLORS dans KeyboardPiano.js)
    const LIST_NOTE_COLORS = [
        { bg: '#EF4444', text: '#fff' }, // C  - Rouge
        { bg: '#F4622A', text: '#fff' }, // C# - Rouge-orangé
        { bg: '#F97316', text: '#fff' }, // D  - Orange
        { bg: '#FBBF24', text: '#1a1a1a' }, // D# - Jaune-orangé
        { bg: '#EAB308', text: '#1a1a1a' }, // E  - Jaune
        { bg: '#84CC16', text: '#1a1a1a' }, // F  - Jaune-vert
        { bg: '#22C55E', text: '#fff' }, // F# - Vert
        { bg: '#14B8A6', text: '#fff' }, // G  - Vert-cyan
        { bg: '#06B6D4', text: '#fff' }, // G# - Cyan
        { bg: '#3B82F6', text: '#fff' }, // A  - Bleu
        { bg: '#7C3AED', text: '#fff' }, // A# - Bleu-violet
        { bg: '#A855F7', text: '#fff' }, // B  - Violet
    ];

    // Convertit un code hex (#RRGGBB) en rgba(r, g, b, alpha)
    const hexToRgba = (hex, alpha) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    };

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
        container.style.removeProperty('--glow-color-hi');
        container.style.removeProperty('--glow-color-lo');
        container.classList.remove('has-active-note');

        const totalNotes = this.visibleNoteCount;
        const endNote = this.startNote + totalNotes - 1;

        // Largeur du glow adaptée au nombre de notes visibles
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

            // Couleur chromatique
            if (this.showNoteColors) {
                const c = LIST_NOTE_COLORS[semitone];
                key.style.background = c.bg;
                key.style.color = c.text;
                key.classList.add('note-colored');
            }

            // Label : toujours sur les Do, sur toutes les touches si peu de notes visibles
            if (isC || totalNotes <= 24) {
                const lbl = document.createElement('span');
                lbl.className = 'keyboard-list-key-label';
                lbl.textContent = label;
                if (this.showNoteColors) {
                    lbl.style.color = LIST_NOTE_COLORS[semitone].text;
                    lbl.style.opacity = '0.85';
                }
                key.appendChild(lbl);
            }

            // Curseur pitch bend (ligne verticale ambrée)
            const cursor = document.createElement('div');
            cursor.className = 'keyboard-list-pb-cursor';
            key.appendChild(cursor);

            keysRow.appendChild(key);
        }

        container.appendChild(keysRow);
        this._initKeyboardListInteraction(container);

        // Mount the fingers overlay below the list keys if the instrument has hands.
        if (typeof this._mountFingersOverlay === 'function') {
            this._mountFingersOverlay('chromatic');
        }
    };

    // -------------------------------------------------------------------------
    // Interaction
    // -------------------------------------------------------------------------

    KeyboardListViewMixin._initKeyboardListInteraction = function (container) {
        this._destroyKeyboardListInteraction();

        let activeNote = null;
        let activeKey = null;
        let startX = null; // X de référence pour le pitch bend relatif

        const hasPitchBend = () => {
            const caps = this.selectedDeviceCapabilities;
            return !!(caps && caps.pitch_bend_enabled) && this.listViewPitchBendEnabled;
        };

        // Y → vélocité (haut = 127, bas = 1)
        const getVelocityFromY = (key, clientY) => {
            const rect = key.getBoundingClientRect();
            const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
            return Math.max(1, Math.min(127, Math.round(ratio * 127)));
        };

        // Δx relatif au clic initial → pitch bend (±largeur de touche = ±8191)
        const getPitchBendFromDelta = (key, deltaX) => {
            const rect = key.getBoundingClientRect();
            const ratio = Math.max(-1, Math.min(1, deltaX / rect.width));
            return Math.round(ratio * 8191);
        };

        // Met à jour le glow : position X + couleur adaptée à la note si colors actifs
        const updateGlow = (clientX, noteNumber) => {
            const row = document.getElementById('keyboard-list-keys-row');
            if (!row) return;
            const rect = row.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            container.style.setProperty('--glow-x', pct + '%');

            if (this.showNoteColors && noteNumber !== undefined) {
                const c = LIST_NOTE_COLORS[noteNumber % 12];
                container.style.setProperty('--glow-color-hi', hexToRgba(c.bg, 0.70));
                container.style.setProperty('--glow-color-lo', hexToRgba(c.bg, 0.25));
            } else {
                container.style.removeProperty('--glow-color-hi');
                container.style.removeProperty('--glow-color-lo');
            }

            container.classList.add('has-active-note');
        };

        const clearGlow = () => {
            container.classList.remove('has-active-note');
            container.style.removeProperty('--glow-color-hi');
            container.style.removeProperty('--glow-color-lo');
        };

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

        const sendYCC = (key, clientY) => {
            if (this.listViewYCC === null) return;
            const val = getVelocityFromY(key, clientY); // même mapping 1-127
            if (typeof this.sendCC === 'function') this.sendCC(this.listViewYCC, val);
        };

        const onDown = (key, clientX, clientY) => {
            const note = parseInt(key.dataset.note, 10);
            if (isNaN(note) || key.classList.contains('disabled')) return;

            activeNote = note;
            activeKey = key;
            startX = clientX; // référence pour le pitch bend relatif

            const vel = getVelocityFromY(key, clientY);
            this.velocity = vel;
            updateVelocityUI(vel);

            this.mouseActiveNotes.add(note);
            this.playNote(note);

            updateGlow(clientX, note);

            sendYCC(key, clientY);

            // Clic = note exacte → pitch bend à zéro, curseur masqué jusqu'au drag
            if (hasPitchBend()) this._sendPitchBend(0);
        };

        const onMove = (clientX, clientY) => {
            if (activeNote === null || !activeKey || startX === null) return;

            updateGlow(clientX, activeNote);

            sendYCC(activeKey, clientY);

            if (hasPitchBend()) {
                const bend = getPitchBendFromDelta(activeKey, clientX - startX);
                this._sendPitchBend(bend);
                showPBCursor(activeKey, clientX);
            }

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
                startX = null;
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
