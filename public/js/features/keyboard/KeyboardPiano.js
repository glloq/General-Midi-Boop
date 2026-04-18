// Auto-extracted from KeyboardModal.js
(function() {
    'use strict';
    const KeyboardPianoMixin = {};


    KeyboardPianoMixin.createModal = function() {
        const endNote = this.startNote + this.octaves * 12 - 1;
        const display = `${this.getNoteNameFromNumber(this.startNote)} - ${this.getNoteNameFromNumber(endNote)}`;

        this.container = document.createElement('div');
        this.container.className = 'keyboard-modal';
        this.container.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <div class="keyboard-header-row">
                        <h2>🎹 ${this.t('keyboard.title')}</h2>
                        <div class="keyboard-header-controls">
                            <div class="control-group">
                                <label>${this.t('keyboard.instrument')}</label>
                                <select class="device-select" id="keyboard-device-select">
                                    <option value="">${this.t('common.select')}</option>
                                </select>
                            </div>

                            <div class="control-group octave-controls">
                                <button class="btn-octave-down" id="keyboard-octave-down">◄</button>
                                <span class="octave-display" id="keyboard-octave-display">${display}</span>
                                <button class="btn-octave-up" id="keyboard-octave-up">►</button>
                            </div>

                            <div class="control-group">
                                <label>${this.t('keyboard.layout')}</label>
                                <select class="layout-select" id="keyboard-layout-select">
                                    <option value="azerty">${this.t('keyboard.layoutAzerty')}</option>
                                    <option value="qwerty">${this.t('keyboard.layoutQwerty')}</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <button class="modal-close" id="keyboard-close-btn">&times;</button>
                </div>

                <div class="modal-body">
                    <div class="keyboard-layout">
                        <!-- Slider vélocité vertical à gauche -->
                        <div class="velocity-control-vertical" id="velocity-control-panel">
                            <div class="velocity-label-vertical">${this.t('keyboard.velocity')}</div>
                            <div class="velocity-slider-wrapper">
                                <input type="range"
                                       id="keyboard-velocity"
                                       class="velocity-slider-vertical"
                                       min="1"
                                       max="127"
                                       value="80"
                                       orient="vertical">
                            </div>
                            <div class="velocity-value-vertical" id="keyboard-velocity-display">80</div>
                        </div>

                        <!-- Mod wheel custom -->
                        <div class="velocity-control-vertical modulation-control-vertical" id="modulation-control-panel">
                            <div class="velocity-label-vertical">${this.t('keyboard.modulation')}</div>
                            <div class="mod-wheel-wrapper">
                                <div class="mod-wheel-track" id="mod-wheel-track">
                                    <div class="mod-wheel-center-line"></div>
                                    <div class="mod-wheel-fill" id="mod-wheel-fill"></div>
                                    <div class="mod-wheel-thumb" id="mod-wheel-thumb"></div>
                                </div>
                            </div>
                            <div class="velocity-value-vertical modulation-value-vertical" id="keyboard-modulation-display">64</div>
                        </div>

                        <!-- Zone principale du clavier -->
                        <div class="keyboard-main">
                            <div class="keyboard-canvas-container">
                                <div id="piano-container" class="piano-container"></div>
                            </div>
                            <div class="keyboard-help-bar">
                                <span class="info-label">${this.t('keyboard.pcKeys')}</span>
                                <span class="info-value" id="keyboard-help-text">${this.t('keyboard.azertyHelp')}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.container);

        // Générer les touches du piano
        this.generatePianoKeys();
    }

    // ========================================================================
    // PIANO KEYS GENERATION (DIVs)
    // ========================================================================

    KeyboardPianoMixin.generatePianoKeys = function() {
        const pianoContainer = document.getElementById('piano-container');
        if (!pianoContainer) return;

        pianoContainer.innerHTML = ''; // Clear

        const totalNotes = this.octaves * 12;
        const endNote = this.startNote + totalNotes;
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // Collecter les touches blanches et noires
        this.visibleWhiteNotes = [];
        this.visibleBlackNotes = [];

        for (let midi = this.startNote; midi < endNote; midi++) {
            const semitone = midi % 12;
            if (!this.blackNoteSemitones.has(semitone)) {
                this.visibleWhiteNotes.push(midi);
            } else {
                this.visibleBlackNotes.push(midi);
            }
        }

        const totalWhiteKeys = this.visibleWhiteNotes.length;

        // Générer les touches blanches
        for (let i = 0; i < totalWhiteKeys; i++) {
            const noteNumber = this.visibleWhiteNotes[i];
            const octave = Math.floor(noteNumber / 12) - 1;
            const noteName = noteNames[noteNumber % 12];

            const whiteKey = document.createElement('div');
            whiteKey.className = 'piano-key white-key';
            whiteKey.dataset.note = noteNumber;
            whiteKey.dataset.noteName = noteName + octave;

            if (!this.isNotePlayable(noteNumber)) {
                whiteKey.classList.add('disabled');
            }

            const label = document.createElement('span');
            label.className = 'key-label';
            label.textContent = noteName + octave;
            whiteKey.appendChild(label);

            pianoContainer.appendChild(whiteKey);
        }

        // Générer les touches noires positionnées sur les blanches
        for (const blackNote of this.visibleBlackNotes) {
            const octave = Math.floor(blackNote / 12) - 1;
            const noteName = noteNames[blackNote % 12];

            // Trouver la touche blanche juste avant cette noire
            const whiteBelow = blackNote - 1; // la blanche en dessous
            const whiteIndex = this.visibleWhiteNotes.indexOf(whiteBelow);
            if (whiteIndex < 0) continue; // bord du clavier

            const blackKey = document.createElement('div');
            blackKey.className = 'piano-key black-key';
            blackKey.dataset.note = blackNote;
            blackKey.dataset.noteName = noteName + octave;

            if (!this.isNotePlayable(blackNote)) {
                blackKey.classList.add('disabled');
            }

            // Positionner entre la blanche courante et la suivante
            blackKey.style.left = `calc(${whiteIndex * (100 / totalWhiteKeys)}% + ${(100 / totalWhiteKeys) * 0.7}%)`;

            pianoContainer.appendChild(blackKey);
        }
    }

    /**
     * Vérifier si une note est jouable par l'instrument sélectionné
     * @param {number} noteNumber - Numéro MIDI de la note
     * @returns {boolean} - true si la note est jouable
     */
    KeyboardPianoMixin.isNotePlayable = function(noteNumber) {
        if (!this.selectedDeviceCapabilities) {
            return true; // Pas de restrictions si pas de capacités définies
        }

        const caps = this.selectedDeviceCapabilities;

        // Mode discrete : vérifier si la note est dans la liste
        if (caps.note_selection_mode === 'discrete') {
            // Si pas de notes sélectionnées, autoriser toutes les notes
            if (!caps.selected_notes) {
                return true;
            }
            try {
                const selectedNotes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                // Si la liste est vide, autoriser toutes les notes
                if (!Array.isArray(selectedNotes) || selectedNotes.length === 0) {
                    return true;
                }
                return selectedNotes.includes(noteNumber);
            } catch (e) {
                return true;
            }
        }

        // Mode range : vérifier si la note est dans la plage
        const minNote = caps.note_range_min;
        const maxNote = caps.note_range_max;

        // Si aucune plage définie, autoriser toutes les notes
        if ((minNote === null || minNote === undefined) &&
            (maxNote === null || maxNote === undefined)) {
            return true;
        }

        if (minNote !== null && minNote !== undefined && noteNumber < minNote) {
            return false;
        }
        if (maxNote !== null && maxNote !== undefined && noteNumber > maxNote) {
            return false;
        }

        return true;
    }

    /**
     * Délégation d'événements sur le conteneur piano
     * Remplace les listeners individuels par touche (évite les fuites mémoire)
     */
    KeyboardPianoMixin._setupPianoDelegation = function() {
        const container = document.getElementById('piano-container');
        if (!container) return;

        // Retirer les anciens listeners délégués s'ils existent
        if (this._pianoMouseDown) {
            container.removeEventListener('mousedown', this._pianoMouseDown);
            container.removeEventListener('mouseup', this._pianoMouseUp);
            container.removeEventListener('mouseleave', this._pianoMouseLeave, true);
            container.removeEventListener('mouseenter', this._pianoMouseEnter, true);
            container.removeEventListener('touchstart', this._pianoTouchStart);
            container.removeEventListener('touchend', this._pianoTouchEnd);
        }

        const getKey = (e) => e.target.closest('.piano-key');

        this._pianoMouseDown = (e) => {
            const key = getKey(e);
            if (key) {
                e.preventDefault(); // Empêcher le drag/sélection du navigateur
                this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} });
            }
        };
        this._pianoMouseUp = (e) => {
            const key = getKey(e);
            if (key) { this.handlePianoKeyUp({ currentTarget: key }); }
        };
        this._pianoMouseLeave = (e) => {
            if (e.target.classList?.contains('piano-key')) {
                const note = parseInt(e.target.dataset.note);
                this.mouseActiveNotes.delete(note);
                this.handlePianoKeyUp({ currentTarget: e.target });
            }
        };
        this._pianoMouseEnter = (e) => {
            if (e.target.classList?.contains('piano-key')) {
                this.handlePianoKeyEnter({ currentTarget: e.target });
            }
        };
        this._pianoTouchStart = (e) => {
            const key = getKey(e);
            if (key) { e.preventDefault(); this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} }); }
        };
        this._pianoTouchEnd = (e) => {
            const key = getKey(e);
            if (key) { e.preventDefault(); this.handlePianoKeyUp({ currentTarget: key }); }
        };

        container.addEventListener('mousedown', this._pianoMouseDown);
        container.addEventListener('mouseup', this._pianoMouseUp);
        container.addEventListener('mouseleave', this._pianoMouseLeave, true);
        container.addEventListener('mouseenter', this._pianoMouseEnter, true);
        container.addEventListener('touchstart', this._pianoTouchStart, { passive: false });
        container.addEventListener('touchend', this._pianoTouchEnd, { passive: false });
    }

    /**
     * Auto-centrer le clavier sur la plage de notes de l'instrument
     * Calcule startNote avec une précision à la note (pas à l'octave)
     */
    KeyboardPianoMixin.autoCenterKeyboard = function() {
        const caps = this.selectedDeviceCapabilities;
        if (!caps) {
            this.startNote = this.defaultStartNote;
            this._updateOctaveDisplay();
            this.logger.info('[KeyboardModal] Auto-center: no capabilities, reset to default');
            return;
        }

        // Déterminer la plage effective selon le mode
        let effectiveMin, effectiveMax;

        if (caps.note_selection_mode === 'discrete' && caps.selected_notes) {
            // Mode percussion : calculer min/max depuis les notes discrètes
            try {
                const notes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                if (Array.isArray(notes) && notes.length > 0) {
                    effectiveMin = Math.min(...notes);
                    effectiveMax = Math.max(...notes);
                }
            } catch (e) { /* ignore */ }
        }

        // Fallback sur note_range_min/max
        if (effectiveMin === undefined || effectiveMax === undefined) {
            const minNote = Number(caps.note_range_min);
            const maxNote = Number(caps.note_range_max);
            if (!isFinite(minNote) && !isFinite(maxNote)) {
                this.startNote = this.defaultStartNote;
                this._updateOctaveDisplay();
                this.logger.info('[KeyboardModal] Auto-center: no note range, reset to default');
                return;
            }
            effectiveMin = isFinite(minNote) ? minNote : 21;
            effectiveMax = isFinite(maxNote) ? maxNote : 108;
        }

        // Centre de la plage jouable
        const rangeCenter = (effectiveMin + effectiveMax) / 2;
        const totalNotes = this.octaves * 12;

        // startNote idéal pour centrer la vue sur la plage jouable
        const idealStart = Math.round(rangeCenter - totalNotes / 2);

        // Clamper dans les limites MIDI (0-127)
        this.startNote = Math.max(0, Math.min(127 - totalNotes, idealStart));

        this._updateOctaveDisplay();
        this.logger.info(`[KeyboardModal] Auto-center: range ${effectiveMin}-${effectiveMax}, center ${rangeCenter}, startNote ${this.startNote} (${this.getNoteNameFromNumber(this.startNote)})`);
    }

    if (typeof window !== 'undefined') window.KeyboardPianoMixin = KeyboardPianoMixin;
})();
