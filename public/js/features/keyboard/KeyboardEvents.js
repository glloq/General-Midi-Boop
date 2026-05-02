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
            const totalNotes = this.visibleNoteCount;
            this.startNote = Math.min(127 - totalNotes, this.startNote + 12);
            this._updateOctaveDisplay();
            this.regeneratePianoKeys();
        });

        document.getElementById('keyboard-octave-down')?.addEventListener('click', () => {
            this.startNote = Math.max(0, this.startNote - 12);
            this._updateOctaveDisplay();
            this.regeneratePianoKeys();
        });

        // Zoom in/out — step by `this.zoomStep` notes (4 by default).
        document.getElementById('keyboard-zoom-in')?.addEventListener('click', () => {
            const next = this.visibleNoteCount - this.zoomStep;
            if (next >= this.minVisibleNotes) {
                this.setVisibleNotes(next);
                this.saveOctavesToSettings();
                this._updateOctaveDisplay();
                this.regeneratePianoKeys();
            }
        });
        document.getElementById('keyboard-zoom-out')?.addEventListener('click', () => {
            const next = this.visibleNoteCount + this.zoomStep;
            if (next <= this.maxVisibleNotes) {
                this.setVisibleNotes(next);
                this.saveOctavesToSettings();
                this._updateOctaveDisplay();
                this.regeneratePianoKeys();
            }
        });

        // Wheel zoom over the canvas (only while hovering it)
        const canvasContainer = document.getElementById('keyboard-canvas-container');
        if (canvasContainer) {
            this._canvasWheelHandler = (e) => {
                if (this.viewMode !== 'piano' && this.viewMode !== 'piano-slider' && this.viewMode !== 'keyboard-list') return;
                e.preventDefault();
                const delta = Math.sign(e.deltaY);
                if (delta < 0) {
                    const next = this.visibleNoteCount - this.zoomStep;
                    if (next >= this.minVisibleNotes) {
                        this.setVisibleNotes(next);
                        this.saveOctavesToSettings();
                        this._updateOctaveDisplay();
                        this.regeneratePianoKeys();
                    }
                } else if (delta > 0) {
                    const next = this.visibleNoteCount + this.zoomStep;
                    if (next <= this.maxVisibleNotes) {
                        this.setVisibleNotes(next);
                        this.saveOctavesToSettings();
                        this._updateOctaveDisplay();
                        this.regeneratePianoKeys();
                    }
                }
            };
            canvasContainer.addEventListener('wheel', this._canvasWheelHandler, { passive: false });
        }

        // Minimap navigation — the minimap shows the full MIDI range (0-127).
        const minimapTrack = document.getElementById('keyboard-minimap-track');
        if (minimapTrack) {
            const minMidi = 0;
            const maxMidi = 127;
            const totalRange = maxMidi - minMidi + 1;
            const moveTo = (clientX) => {
                const rect = minimapTrack.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                const totalNotes = this.visibleNoteCount;
                // Center the viewport on the click position
                const centerMidi = minMidi + ratio * totalRange;
                let newStart = Math.round(centerMidi - totalNotes / 2);
                newStart = Math.max(0, Math.min(127 - totalNotes, newStart));
                this.startNote = newStart;
                this._updateOctaveDisplay();
                this.regeneratePianoKeys();
            };
            this._minimapMouseDown = (e) => {
                e.preventDefault();
                this._minimapDragging = true;
                moveTo(e.clientX);
            };
            this._minimapMouseMove = (e) => {
                if (this._minimapDragging) moveTo(e.clientX);
            };
            this._minimapMouseUp = () => { this._minimapDragging = false; };
            minimapTrack.addEventListener('mousedown', this._minimapMouseDown);
            document.addEventListener('mousemove', this._minimapMouseMove);
            document.addEventListener('mouseup', this._minimapMouseUp);
        }

        // Notation selector (radio-style group of buttons)
        const notationToggle = document.getElementById('keyboard-notation-toggle');
        if (notationToggle) {
            notationToggle.addEventListener('click', (e) => {
                const btn = e.target.closest('.notation-btn');
                if (!btn) return;
                const value = btn.dataset.notation;
                if (!['english', 'solfege', 'midi'].includes(value)) return;
                this.noteLabelFormat = value;
                // Update active state on all buttons
                notationToggle.querySelectorAll('.notation-btn').forEach(b => {
                    const isActive = b.dataset.notation === value;
                    b.classList.toggle('active', isActive);
                    b.setAttribute('aria-checked', isActive ? 'true' : 'false');
                });
                try {
                    const saved = localStorage.getItem('gmboop_settings');
                    const settings = saved ? JSON.parse(saved) : {};
                    settings.keyboardNotation = this.noteLabelFormat;
                    localStorage.setItem('gmboop_settings', JSON.stringify(settings));
                } catch (err) { /* ignore */ }
                this._updateOctaveDisplay();
                this.regeneratePianoKeys();
                if (this.viewMode === 'fretboard') this.renderFretboard();
                if (this.viewMode === 'drumpad') this.renderDrumPad();
            });
        }

        // Note-color toggle (piano and fretboard modes)
        document.getElementById('keyboard-note-colors-toggle')?.addEventListener('click', () => {
            this.showNoteColors = !this.showNoteColors;
            const btn = document.getElementById('keyboard-note-colors-toggle');
            if (btn) btn.classList.toggle('active', this.showNoteColors);
            if (this.viewMode === 'fretboard') this.renderFretboard();
            else if (this.viewMode === 'keyboard-list') {
                if (typeof this.renderKeyboardList === 'function') this.renderKeyboardList();
            } else if (this.viewMode === 'piano') this.regeneratePianoKeys();
        });

        // String slide mode toggle
        document.getElementById('keyboard-slide-toggle')?.addEventListener('click', () => {
            if (typeof this._toggleStringSlideMode === 'function') {
                this._toggleStringSlideMode();
            }
        });

        // Piano slider toggle (equal-width chromatic keys + pitch bend)
        document.getElementById('keyboard-piano-slider-toggle')?.addEventListener('click', () => {
            if (this.viewMode === 'piano-slider') {
                this.setViewMode('piano');
            } else {
                this.setViewMode('piano-slider');
            }
        });

        // List view toggle
        document.getElementById('keyboard-list-view-toggle')?.addEventListener('click', () => {
            if (this.viewMode === 'keyboard-list') {
                this.setViewMode('piano');
            } else {
                this.setViewMode('keyboard-list');
            }
        });

        // View mode toggle (piano <-> fretboard / drumpad)
        // piano-slider is treated as part of piano family → exits to fretboard/drumpad normally
        document.getElementById('keyboard-view-toggle')?.addEventListener('click', () => {
            const info = this.getInstrumentViewInfo();
            if (info.isDrum) {
                this.setViewMode(this.viewMode === 'drumpad' ? 'piano' : 'drumpad');
            } else if (info.canFretboard) {
                this.setViewMode(this.viewMode === 'fretboard' ? 'piano' : 'fretboard');
            } else {
                this.setViewMode('piano');
            }
        });

        // Instrument trigger: open/close custom dropdown
        const instrumentTrigger = document.getElementById('instrument-trigger');
        if (instrumentTrigger) {
            this._instrumentTriggerClick = (e) => {
                e.stopPropagation();
                const dropdown = document.getElementById('instrument-dropdown');
                const selector = document.getElementById('header-instrument-selector');
                if (!dropdown || !selector) return;
                const isOpen = dropdown.classList.contains('open');
                dropdown.classList.toggle('open', !isOpen);
                selector.classList.toggle('open', !isOpen);
                instrumentTrigger.setAttribute('aria-expanded', String(!isOpen));
            };
            instrumentTrigger.addEventListener('click', this._instrumentTriggerClick);
        }

        // Close dropdown when clicking outside
        this._closeDropdownOnOutside = (e) => {
            const selector = document.getElementById('header-instrument-selector');
            if (selector && !selector.contains(e.target)) {
                const dropdown = document.getElementById('instrument-dropdown');
                const trigger = document.getElementById('instrument-trigger');
                dropdown?.classList.remove('open');
                selector.classList.remove('open');
                if (trigger) trigger.setAttribute('aria-expanded', 'false');
            }
        };
        document.addEventListener('click', this._closeDropdownOnOutside);

        // Velocity
        document.getElementById('keyboard-velocity')?.addEventListener('input', (e) => {
            this.velocity = parseInt(e.target.value);
            document.getElementById('keyboard-velocity-display').textContent = this.velocity;
        });

        // Modulation wheel (custom drag)
        this.initModWheel();

        // Pitch bend wheel (custom drag, springs back to center)
        if (typeof this.initPitchBendWheel === 'function') {
            this.initPitchBendWheel();
        }

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

        // Instrument dropdown outside-click handler
        if (this._closeDropdownOnOutside) {
            document.removeEventListener('click', this._closeDropdownOnOutside);
            this._closeDropdownOnOutside = null;
        }

        // Instrument trigger click handler
        const instrumentTrigger = document.getElementById('instrument-trigger');
        if (instrumentTrigger && this._instrumentTriggerClick) {
            instrumentTrigger.removeEventListener('click', this._instrumentTriggerClick);
            this._instrumentTriggerClick = null;
        }

        // Remove canvas wheel zoom
        const canvasContainer = document.getElementById('keyboard-canvas-container');
        if (canvasContainer && this._canvasWheelHandler) {
            canvasContainer.removeEventListener('wheel', this._canvasWheelHandler);
            this._canvasWheelHandler = null;
        }

        // Remove minimap listeners
        if (this._minimapMouseMove) {
            document.removeEventListener('mousemove', this._minimapMouseMove);
            document.removeEventListener('mouseup', this._minimapMouseUp);
            this._minimapMouseMove = null;
            this._minimapMouseUp = null;
            this._minimapMouseDown = null;
        }

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
