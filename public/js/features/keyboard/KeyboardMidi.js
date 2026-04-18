(function() {
    'use strict';
    const KeyboardMidi = {};

    KeyboardMidi.getSelectedChannel = function() {
        if (this.selectedDeviceCapabilities && this.selectedDeviceCapabilities.channel !== undefined) {
            return this.selectedDeviceCapabilities.channel;
        }
        if (this.selectedDevice && this.selectedDevice.channel !== undefined) {
            return this.selectedDevice.channel;
        }
        return 0;
    };

    KeyboardMidi.playNote = function(note) {
        if (note < 21 || note > 108) return;

        // Add to active notes
        this.activeNotes.add(note);
        this.updatePianoDisplay();

        // Send MIDI if device selected
        if (this.selectedDevice && this.backend) {
            const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

            // Virtual device: log only
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
    };

    KeyboardMidi.stopNote = function(note) {
        // Remove from active notes
        this.activeNotes.delete(note);
        this.updatePianoDisplay();

        // Send MIDI if device selected
        if (this.selectedDevice && this.backend) {
            const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

            // Virtual device: log only
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
    };

    KeyboardMidi.initModWheel = function() {
        const track = document.getElementById('mod-wheel-track');
        const thumb = document.getElementById('mod-wheel-thumb');
        const fill = document.getElementById('mod-wheel-fill');
        const display = document.getElementById('keyboard-modulation-display');
        if (!track || !thumb) return;

        this._updateModWheelPosition(64);

        const getValueFromY = (clientY) => {
            const rect = track.getBoundingClientRect();
            const relativeY = clientY - rect.top;
            const ratio = 1 - (relativeY / rect.height);
            const clamped = Math.max(0, Math.min(1, ratio));
            return Math.round(clamped * 127);
        };

        const onMove = (clientY) => {
            if (!this._modWheelDragging) return;
            const value = getValueFromY(clientY);
            this.modulation = value;
            this._updateModWheelPosition(value);
            if (display) display.textContent = value;
            this.sendModulation(value);
        };

        const onEnd = () => {
            if (!this._modWheelDragging) return;
            this._modWheelDragging = false;
            // Remove global listeners when drag ends
            document.removeEventListener('mousemove', this._modWheelOnMove);
            document.removeEventListener('mouseup', this._modWheelOnEnd);
            document.removeEventListener('touchmove', this._modWheelOnTouchMove);
            document.removeEventListener('touchend', this._modWheelOnEnd);
            document.removeEventListener('touchcancel', this._modWheelOnEnd);
            thumb.classList.remove('dragging');
            thumb.classList.add('returning');
            fill.classList.add('returning');
            this.modulation = 64;
            this._updateModWheelPosition(64);
            if (display) display.textContent = '64';
            this.sendModulation(64);
            setTimeout(() => {
                thumb.classList.remove('returning');
                fill.classList.remove('returning');
            }, 300);
        };

        // Mouse events - attach global listeners only during drag
        this._modWheelOnTrackDown = (e) => {
            e.preventDefault();
            this._modWheelDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            fill.classList.remove('returning');
            onMove(e.clientY);
            document.addEventListener('mousemove', this._modWheelOnMove);
            document.addEventListener('mouseup', this._modWheelOnEnd);
        };
        this._modWheelOnMove = (e) => onMove(e.clientY);
        this._modWheelOnEnd = onEnd;
        this._modWheelOnTouchStart = (e) => {
            e.preventDefault();
            this._modWheelDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            fill.classList.remove('returning');
            onMove(e.touches[0].clientY);
            document.addEventListener('touchmove', this._modWheelOnTouchMove, { passive: false });
            document.addEventListener('touchend', this._modWheelOnEnd);
            document.addEventListener('touchcancel', this._modWheelOnEnd);
        };
        this._modWheelOnTouchMove = (e) => {
            if (this._modWheelDragging) onMove(e.touches[0].clientY);
        };

        track.addEventListener('mousedown', this._modWheelOnTrackDown);
        track.addEventListener('touchstart', this._modWheelOnTouchStart, { passive: false });
    };

    KeyboardMidi._updateModWheelPosition = function(value) {
        const track = document.getElementById('mod-wheel-track');
        const thumb = document.getElementById('mod-wheel-thumb');
        const fill = document.getElementById('mod-wheel-fill');
        if (!track || !thumb) return;

        const trackHeight = track.clientHeight;
        const ratio = value / 127;
        const topPx = trackHeight * (1 - ratio);

        thumb.style.top = topPx + 'px';

        if (fill) {
            const centerPx = trackHeight * 0.5;
            if (topPx < centerPx) {
                fill.style.top = topPx + 'px';
                fill.style.height = (centerPx - topPx) + 'px';
            } else {
                fill.style.top = centerPx + 'px';
                fill.style.height = (topPx - centerPx) + 'px';
            }
        }
    };

    KeyboardMidi.sendModulation = function(value) {
        if (!this.selectedDevice || !this.backend) return;

        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

        if (this.selectedDevice.isVirtual) {
            this.logger.info(`🎹 [Virtual] Modulation CC#1 = ${value}`);
            return;
        }

        const channel = this.getSelectedChannel();
        this.backend.sendCommand('midi_send_cc', {
            deviceId: deviceId,
            channel: channel,
            controller: 1, // CC#1 = Modulation Wheel
            value: value
        }).catch(err => {
            this.logger.error('[KeyboardModal] Modulation CC send failed:', err);
        });
    };

    KeyboardMidi.updateSlidersVisibility = function() {
        const velocityPanel = document.getElementById('velocity-control-panel');
        const modulationPanel = document.getElementById('modulation-control-panel');

        if (!velocityPanel || !modulationPanel) return;

        const caps = this.selectedDeviceCapabilities;

        if (!caps) {
            velocityPanel.classList.remove('slider-hidden');
            modulationPanel.classList.add('slider-hidden');
            return;
        }

        // Velocity: always visible if instrument supports notes
        const hasNotes = (caps.note_range_min !== null && caps.note_range_min !== undefined) ||
                         (caps.note_range_max !== null && caps.note_range_max !== undefined) ||
                         caps.note_selection_mode === 'discrete';
        if (hasNotes) {
            velocityPanel.classList.remove('slider-hidden');
        } else {
            velocityPanel.classList.add('slider-hidden');
        }

        // Modulation: visible if CC#1 is in supported_ccs
        let supportsCCs = [];
        if (caps.supported_ccs) {
            try {
                supportsCCs = typeof caps.supported_ccs === 'string'
                    ? JSON.parse(caps.supported_ccs)
                    : caps.supported_ccs;
            } catch (e) {
                supportsCCs = [];
            }
        }

        if (Array.isArray(supportsCCs) && supportsCCs.includes(1)) {
            modulationPanel.classList.remove('slider-hidden');
        } else {
            modulationPanel.classList.add('slider-hidden');
        }
    };

    if (typeof window !== 'undefined') window.KeyboardMidi = KeyboardMidi;
})();
