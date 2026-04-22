// Auto-extracted from KeyboardModal.js
(function() {
    'use strict';
    const KeyboardEventsMixin = {};


    // ========================================================================
    // EVENTS
    // ========================================================================

    KeyboardEventsMixin.attachEvents = function() {
        // Buttons
        document.getElementById('keyboard-close-btn')?.addEventListener('click', () => this.close());

        document.getElementById('keyboard-octave-up')?.addEventListener('click', () => {
            const totalNotes = this.octaves * 12;
            this.startNote = Math.min(127 - totalNotes, this.startNote + 12);
            this._updateOctaveDisplay();
            this.regeneratePianoKeys();
        });

        document.getElementById('keyboard-octave-down')?.addEventListener('click', () => {
            this.startNote = Math.max(0, this.startNote - 12);
            this._updateOctaveDisplay();
            this.regeneratePianoKeys();
        });

        // Device select
        document.getElementById('keyboard-device-select')?.addEventListener('change', async (e) => {
            const rawValue = e.target.value;
            let deviceId = rawValue;
            let selectedChannel = undefined;

            // Parse the "deviceId::channel" format for multi-instrument devices
            if (rawValue.includes('::')) {
                const parts = rawValue.split('::');
                deviceId = parts[0];
                selectedChannel = parseInt(parts[1]);
            }

            this.selectedDevice = this.devices.find(d => {
                if (d._multiInstrument && selectedChannel !== undefined) {
                    return (d.device_id === deviceId || d.id === deviceId) && d.channel === selectedChannel;
                }
                return d.device_id === deviceId || d.id === deviceId;
            }) || null;

            // Load the selected instrument's capabilities
            await this.loadDeviceCapabilities(deviceId, selectedChannel);

            // Auto-center the keyboard on the instrument's note range
            this.autoCenterKeyboard();

            // Update the slider visibility
            this.updateSlidersVisibility();

            // Reset modulation wheel to center when changing instrument
            this.modulation = 64;
            this._updateModWheelPosition(64);
            const modDisplay = document.getElementById('keyboard-modulation-display');
            if (modDisplay) modDisplay.textContent = '64';

            // Regenerate the keyboard to apply the restrictions
            this.regeneratePianoKeys();
        });

        // Velocity
        document.getElementById('keyboard-velocity')?.addEventListener('input', (e) => {
            this.velocity = parseInt(e.target.value);
            document.getElementById('keyboard-velocity-display').textContent = this.velocity;
        });

        // Modulation wheel (custom drag)
        this.initModWheel();

        // Octave count selector (number of octaves displayed)
        document.getElementById('keyboard-octaves-count-select')?.addEventListener('change', (e) => {
            const octaves = parseInt(e.target.value);
            this.setOctaves(octaves);
            this.saveOctavesToSettings();
            // Re-center the keyboard for the newly selected size
            this.autoCenterKeyboard();
            this.regeneratePianoKeys();
        });

        // Layout
        document.getElementById('keyboard-layout-select')?.addEventListener('change', (e) => {
            this.keyboardLayout = e.target.value;
            // Update the help text
            const helpText = document.getElementById('keyboard-help-text');
            if (helpText) {
                helpText.textContent = this.keyboardLayout === 'azerty'
                    ? this.t('keyboard.azertyHelp')
                    : this.t('keyboard.qwertyHelp');
            }
        });

        // Piano keys - use delegated listeners on the container (not individual per key)
        this._setupPianoDelegation();

        // Global mouseup handling for the drag
        document.addEventListener('mouseup', this.handleGlobalMouseUp);

        // PC keyboard
        window.addEventListener('keydown', this.handleKeyDown);
        window.addEventListener('keyup', this.handleKeyUp);
    }

    KeyboardEventsMixin.detachEvents = function() {
        document.removeEventListener('mouseup', this.handleGlobalMouseUp);
        window.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('keyup', this.handleKeyUp);

        // Remove delegated piano container listeners
        this._removePianoDelegation();

        // Cleanup mod wheel listeners
        if (this._modWheelOnMove) {
            const track = document.getElementById('mod-wheel-track');
            if (track) {
                track.removeEventListener('mousedown', this._modWheelOnTrackDown);
                track.removeEventListener('touchstart', this._modWheelOnTouchStart);
            }
            document.removeEventListener('mousemove', this._modWheelOnMove);
            document.removeEventListener('mouseup', this._modWheelOnEnd);
            document.removeEventListener('touchmove', this._modWheelOnTouchMove);
            document.removeEventListener('touchend', this._modWheelOnEnd);
            document.removeEventListener('touchcancel', this._modWheelOnEnd);
        }
    }

    /**
     * Resolve a PC key to a MIDI note via the visible keys
     * White keys map to the lower letter row, black keys to the upper letter row.
     * AZERTY: Q S D F G H J K L M ù * (white) / Z E T Y U O P (black)
     * QWERTY: S D F G H J K L ; (white) / W E T Y U O P (black)
     */
    KeyboardEventsMixin._resolveKeyToNote = function(code) {
        // Mapping of PC keys to indices of visible white keys
        // event.code reflects the physical (US-QWERTY) position; AZERTY users press
        // their labeled letter, which on hardware corresponds to the US-QWERTY name below.
        const whiteKeyIndices = this.keyboardLayout === 'qwerty'
            ? { 'KeyS': 0, 'KeyD': 1, 'KeyF': 2, 'KeyG': 3, 'KeyH': 4, 'KeyJ': 5, 'KeyK': 6, 'KeyL': 7, 'Semicolon': 8 }
            : {
                'KeyA': 0,        // Q
                'KeyS': 1,        // S
                'KeyD': 2,        // D
                'KeyF': 3,        // F
                'KeyG': 4,        // G
                'KeyH': 5,        // H
                'KeyJ': 6,        // J
                'KeyK': 7,        // K
                'KeyL': 8,        // L
                'Semicolon': 9,   // M
                'Quote': 10,      // ù
                'Backslash': 11   // *
            };

        // Black keys: between which white keys (index of the white key on the left)
        const blackKeyIndices = this.keyboardLayout === 'qwerty'
            ? { 'KeyW': 0, 'KeyE': 1, 'KeyT': 3, 'KeyY': 4, 'KeyU': 5, 'KeyO': 7, 'KeyP': 8 }
            : {
                'KeyW': 0,  // Z
                'KeyE': 1,  // E
                'KeyT': 3,  // T
                'KeyY': 4,  // Y
                'KeyU': 5,  // U
                'KeyO': 7,  // O
                'KeyP': 8   // P
            };

        // White key?
        if (whiteKeyIndices[code] !== undefined) {
            const idx = whiteKeyIndices[code];
            return idx < this.visibleWhiteNotes.length ? this.visibleWhiteNotes[idx] : null;
        }

        // Black key? Find the black key just above the matching white key
        if (blackKeyIndices[code] !== undefined) {
            const whiteIdx = blackKeyIndices[code];
            if (whiteIdx >= this.visibleWhiteNotes.length) return null;
            const whiteNote = this.visibleWhiteNotes[whiteIdx];
            // The black key is 1 semitone above if it exists among the visible ones
            const blackNote = whiteNote + 1;
            return this.visibleBlackNotes.includes(blackNote) ? blackNote : null;
        }

        return null;
    }

    KeyboardEventsMixin.playNote = function(note) {
        if (note < 21 || note > 108) return;

        // Add to active notes
        this.activeNotes.add(note);
        this.updatePianoDisplay();

        // Send MIDI if a device is selected
        if (this.selectedDevice && this.backend) {
            const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

            // If it is the virtual device, send to logs
            if (this.selectedDevice.isVirtual) {
                const noteName = this.getNoteNameFromNumber(note);
                const message = `🎹 ${this.t('keyboard.virtualNoteOn', { note: noteName, number: note, velocity: this.velocity })}`;
                if (this.logger && this.logger.info) {
                    this.logger.info(message);
                } else {
                    console.log(message);
                }
                return;
            }

            const channel = this.getSelectedChannel();
            this.backend.sendNoteOn(deviceId, note, this.velocity, channel)
                .catch(err => {
                    this.logger.error('[KeyboardModal] Note ON failed:', err);
                });
        }
    }

    KeyboardEventsMixin.stopNote = function(note) {
        // Remove from active notes
        this.activeNotes.delete(note);
        this.updatePianoDisplay();

        // Send MIDI if a device is selected
        if (this.selectedDevice && this.backend) {
            const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

            // If it is the virtual device, send to logs
            if (this.selectedDevice.isVirtual) {
                const noteName = this.getNoteNameFromNumber(note);
                const message = `🎹 ${this.t('keyboard.virtualNoteOff', { note: noteName, number: note })}`;
                if (this.logger && this.logger.info) {
                    this.logger.info(message);
                } else {
                    console.log(message);
                }
                return;
            }

            const channel = this.getSelectedChannel();
            this.backend.sendNoteOff(deviceId, note, channel)
                .catch(err => {
                    this.logger.error('[KeyboardModal] Note OFF failed:', err);
                });
        }
    }

    if (typeof window !== 'undefined') window.KeyboardEventsMixin = KeyboardEventsMixin;
})();
