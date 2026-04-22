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

                            <div class="control-group octaves-count-group">
                                <label>${this.t('settings.keyboard.octaveCount')}</label>
                                <select class="octaves-count-select" id="keyboard-octaves-count-select">
                                    <option value="1" ${this.octaves === 1 ? 'selected' : ''}>1</option>
                                    <option value="2" ${this.octaves === 2 ? 'selected' : ''}>2</option>
                                    <option value="3" ${this.octaves === 3 ? 'selected' : ''}>3</option>
                                    <option value="4" ${this.octaves === 4 ? 'selected' : ''}>4</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <button class="modal-close" id="keyboard-close-btn">&times;</button>
                </div>

                <div class="modal-body">
                    <div class="keyboard-layout">
                        <!-- Vertical velocity slider on the left -->
                        <div class="velocity-control-vertical no-transition" id="velocity-control-panel">
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

                        <!-- Mod wheel custom (hidden by default, shown if instrument supports CC#1) -->
                        <div class="velocity-control-vertical modulation-control-vertical slider-hidden no-transition" id="modulation-control-panel">
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

                        <!-- Main keyboard area -->
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

        // Generate the piano keys
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

        // Collect the white and black keys
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

        // Generate the white keys
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

        // Generate the black keys positioned over the white keys
        for (const blackNote of this.visibleBlackNotes) {
            const octave = Math.floor(blackNote / 12) - 1;
            const noteName = noteNames[blackNote % 12];

            // Find the white key just before this black one
            const whiteBelow = blackNote - 1; // the white key below
            const whiteIndex = this.visibleWhiteNotes.indexOf(whiteBelow);
            if (whiteIndex < 0) continue; // edge of the keyboard

            const blackKey = document.createElement('div');
            blackKey.className = 'piano-key black-key';
            blackKey.dataset.note = blackNote;
            blackKey.dataset.noteName = noteName + octave;

            if (!this.isNotePlayable(blackNote)) {
                blackKey.classList.add('disabled');
            }

            // Width and position scaled relative to the number of white keys
            // so black keys stay narrower than white keys regardless of octave count.
            const whiteKeyPercent = 100 / totalWhiteKeys;
            blackKey.style.width = `${whiteKeyPercent * 0.6}%`;
            blackKey.style.left = `${whiteKeyPercent * (whiteIndex + 0.7)}%`;

            pianoContainer.appendChild(blackKey);
        }
    }

    /**
     * Check whether a note is playable by the selected instrument
     * @param {number} noteNumber - MIDI note number
     * @returns {boolean} - true if the note is playable
     */
    KeyboardPianoMixin.isNotePlayable = function(noteNumber) {
        if (!this.selectedDeviceCapabilities) {
            return true; // No restrictions if no capabilities defined
        }

        const caps = this.selectedDeviceCapabilities;

        // Discrete mode: check whether the note is in the list
        if (caps.note_selection_mode === 'discrete') {
            // If no notes selected, allow all notes
            if (!caps.selected_notes) {
                return true;
            }
            try {
                const selectedNotes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                // If the list is empty, allow all notes
                if (!Array.isArray(selectedNotes) || selectedNotes.length === 0) {
                    return true;
                }
                return selectedNotes.includes(noteNumber);
            } catch (e) {
                return true;
            }
        }

        // Range mode: check whether the note is within the range
        const minNote = caps.note_range_min;
        const maxNote = caps.note_range_max;

        // If no range defined, allow all notes
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
     * Event delegation on the piano container
     * Replaces per-key individual listeners (avoids memory leaks)
     */
    KeyboardPianoMixin._setupPianoDelegation = function() {
        const container = document.getElementById('piano-container');
        if (!container) return;

        // Remove the old delegated listeners if they exist
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
                e.preventDefault(); // Prevent the browser's drag/selection
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
     * Auto-center the keyboard on the instrument's note range
     * Computes startNote with per-note precision (not per-octave)
     */
    KeyboardPianoMixin.autoCenterKeyboard = function() {
        const caps = this.selectedDeviceCapabilities;
        if (!caps) {
            this.startNote = this.defaultStartNote;
            this._updateOctaveDisplay();
            this.logger.info('[KeyboardModal] Auto-center: no capabilities, reset to default');
            return;
        }

        // Determine the effective range based on mode
        let effectiveMin, effectiveMax;

        if (caps.note_selection_mode === 'discrete' && caps.selected_notes) {
            // Percussion mode: compute min/max from the discrete notes
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

        // Fall back to note_range_min/max
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

        // Center of the playable range
        const rangeCenter = (effectiveMin + effectiveMax) / 2;
        const totalNotes = this.octaves * 12;

        // Ideal startNote to center the view on the playable range
        const idealStart = Math.round(rangeCenter - totalNotes / 2);

        // Clamp within MIDI bounds (0-127)
        this.startNote = Math.max(0, Math.min(127 - totalNotes, idealStart));

        this._updateOctaveDisplay();
        this.logger.info(`[KeyboardModal] Auto-center: range ${effectiveMin}-${effectiveMax}, center ${rangeCenter}, startNote ${this.startNote} (${this.getNoteNameFromNumber(this.startNote)})`);
    }

    if (typeof window !== 'undefined') window.KeyboardPianoMixin = KeyboardPianoMixin;
})();
