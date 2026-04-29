// ============================================================================
// KeyboardModal.js - DIV-based keyboard (no Canvas)
// Version: 1.1.0 - Support i18n
// ============================================================================

class KeyboardModalNew {
    constructor(logger = null, eventBus = null) {
        this.backend = window.api;
        this.logger = logger || console;
        this.eventBus = eventBus || window.eventBus || null;
        this.isOpen = false;

        // i18n support
        this.localeUnsubscribe = null;

        // State
        this.devices = [];
        this.selectedDevice = null;
        this.selectedDeviceCapabilities = null; // Selected instrument capabilities
        this.activeNotes = new Set();
        this.mouseActiveNotes = new Set(); // Notes triggered by the mouse (for cleanup on global mouseup)
        this.velocity = 80;
        this.modulation = 64; // CC#1 modulation wheel value (center)
        this._modWheelDragging = false;
        this.keyboardLayout = 'azerty';
        this.isMouseDown = false; // For dragging on the keyboard

        // Piano config
        this.octaves = 3; // 3 octaves by default (range: 1-8 octaves)
        this.minOctaves = 1;
        this.maxOctaves = 8;
        this.startNote = 48; // First MIDI note displayed (C3 by default)
        this.defaultStartNote = 48; // Default value for reset
        // White notes: relative semitones within an octave
        this.whiteNoteOffsets = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
        // Semitones that have a black key (sharp)
        this.blackNoteSemitones = new Set([1, 3, 6, 8, 10]); // C# D# F# G# A#
        // Mapping tables for PC keys (generated dynamically)
        this.visibleWhiteNotes = [];
        this.visibleBlackNotes = [];

        // Note label format: 'english' (C/D/E), 'solfege' (Do/Ré/Mi), 'midi' (60)
        this.noteLabelFormat = 'english';
        // View mode: 'piano' (default), 'fretboard' (string instr.), 'drumpad' (drum)
        this.viewMode = 'piano';
        // String instrument config (loaded when fretboard mode is enabled)
        this.stringInstrumentConfig = null;
        // Minimap drag state
        this._minimapDragging = false;

        // The PC keyboard mapping is dynamic (see _resolveKeyToNote)

        // Bind handlers
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleKeyUp = this.handleKeyUp.bind(this);
        this.handleGlobalMouseUp = this.handleGlobalMouseUp.bind(this);

        this.container = null;

        // Setup event listeners
        this.setupEventListeners();
    }

    // ========================================================================
    // I18N SUPPORT
    // ========================================================================

    /**
     * Helper to translate a key
     * @param {string} key - Translation key
     * @param {Object} params - Interpolation parameters
     * @returns {string} - Texte traduit
     */
    t(key, params = {}) {
        return typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    }

    /**
     * Updates the translated content of the modal
     */
    updateTranslations() {
        if (!this.container) return;

        // Velocity
        const velocityLabel = this.container.querySelector('#velocity-control-panel .velocity-label-vertical');
        if (velocityLabel) velocityLabel.textContent = this.t('keyboard.velocity');

        // Modulation
        const modulationLabel = this.container.querySelector('#modulation-control-panel .velocity-label-vertical');
        if (modulationLabel) modulationLabel.textContent = this.t('keyboard.modulation');

        // Instrument / layout / octaves labels
        const labels = this.container.querySelectorAll('.keyboard-header-controls .control-group label');
        if (labels[0]) labels[0].textContent = this.t('keyboard.instrument');
        if (labels[1]) labels[1].textContent = this.t('keyboard.layout');
        if (labels[2]) labels[2].textContent = this.t('settings.keyboard.octaveCount');

        // Note range display
        this._updateOctaveDisplay();

        // PC Keys label
        const pcKeysLabel = this.container.querySelector('.keyboard-help-bar .info-label');
        if (pcKeysLabel) pcKeysLabel.textContent = this.t('keyboard.pcKeys');

        // Keyboard help text
        const helpText = document.getElementById('keyboard-help-text');
        if (helpText) {
            helpText.textContent = this.keyboardLayout === 'azerty'
                ? this.t('keyboard.azertyHelp')
                : this.t('keyboard.qwertyHelp');
        }

        // Default select
        const deviceSelect = document.getElementById('keyboard-device-select');
        if (deviceSelect && deviceSelect.options.length > 0) {
            deviceSelect.options[0].textContent = this.t('common.select');
        }
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    setupEventListeners() {
        if (!this.eventBus) {
            this.logger.warn('[KeyboardModal] No eventBus available - device list will not auto-refresh');
            return;
        }

        // Listen for Bluetooth connects/disconnects to refresh the list
        this.eventBus.on('bluetooth:connected', async (_data) => {
            this.logger.info('[KeyboardModal] Bluetooth device connected, refreshing device list...');
            if (this.isOpen) {
                await this.loadDevices();
                this.populateDeviceSelect();
            }
        });

        this.eventBus.on('bluetooth:disconnected', async (_data) => {
            this.logger.info('[KeyboardModal] Bluetooth device disconnected, refreshing device list...');
            if (this.isOpen) {
                await this.loadDevices();
                this.populateDeviceSelect();
            }
        });

        this.eventBus.on('bluetooth:unpaired', async (_data) => {
            this.logger.info('[KeyboardModal] Bluetooth device unpaired, refreshing device list...');
            if (this.isOpen) {
                await this.loadDevices();
                this.populateDeviceSelect();
            }
        });

        this.logger.debug('[KeyboardModal] Event listeners configured');
    }

    // ========================================================================
    // OPEN / CLOSE
    // ========================================================================

    async open() {
        if (this.isOpen) return;

        // Load saved settings to apply the key count
        this.loadSettings();

        this.createModal();
        this.isOpen = true;

        // Load devices
        await this.loadDevices();
        this.populateDeviceSelect();

        // Attach events
        this.attachEvents();

        // Initialize slider visibility (hide modulation by default)
        this.updateSlidersVisibility();

        // Subscribe to locale changes
        if (typeof i18n !== 'undefined') {
            this.localeUnsubscribe = i18n.onLocaleChange(() => {
                this.updateTranslations();
                this.populateDeviceSelect();
            });
        }

        this.logger.info('[KeyboardModal] Opened');
    }

    close() {
        if (!this.isOpen) return;

        this.detachEvents();

        // Unsubscribe from locale changes
        if (this.localeUnsubscribe) {
            this.localeUnsubscribe();
            this.localeUnsubscribe = null;
        }

        // Stop all active notes
        this.activeNotes.forEach(note => this.stopNote(note));

        // Reset state
        this.isMouseDown = false;
        this.mouseActiveNotes.clear();
        this.selectedDevice = null;

        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.isOpen = false;
        this.logger.info('[KeyboardModal] Closed');
    }

    updatePianoDisplay() {
        const allKeys = document.querySelectorAll('.piano-key');
        allKeys.forEach(key => {
            const note = parseInt(key.dataset.note);

            // Highlight if active
            if (this.activeNotes.has(note)) {
                key.classList.add('active');
            } else {
                key.classList.remove('active');
            }
        });
    }

    /**
     * Load an instrument's capabilities
     * @param {string} deviceId - Device ID
     * @param {number} [channel] - MIDI channel (for multi-instrument devices)
     */
    async loadDeviceCapabilities(deviceId, channel) {
        if (!deviceId) {
            this.selectedDeviceCapabilities = null;
            return;
        }

        try {
            const params = { deviceId };
            if (channel !== undefined) {
                params.channel = channel;
            }
            const response = await this.backend.sendCommand('instrument_get_capabilities', params);
            this.selectedDeviceCapabilities = response.capabilities || null;
            this.logger.info(`[KeyboardModal] Capacités chargées pour ${deviceId} ch${channel}:`, this.selectedDeviceCapabilities);
        } catch (error) {
            this.logger.warn(`[KeyboardModal] Impossible de charger les capacités pour ${deviceId}:`, error);
            this.selectedDeviceCapabilities = null;
        }
    }

    regeneratePianoKeys() {
        this.generatePianoKeys();

        // Event delegation: a single listener on the container instead of 6 per key
        this._setupPianoDelegation();

        // Refresh the navigation aids that depend on visible notes.
        if (typeof this.renderMinimap === 'function') this.renderMinimap();
        if (typeof this.renderOctaveBar === 'function') this.renderOctaveBar();

        this.updatePianoDisplay();
    }

    /**
     * Remove delegated piano container listeners
     */
    _removePianoDelegation() {
        const container = document.getElementById('keyboard-canvas-container')
                       || document.getElementById('piano-container');
        if (!container || !this._pianoMouseDown) return;

        container.removeEventListener('mousedown', this._pianoMouseDown);
        container.removeEventListener('mouseup', this._pianoMouseUp);
        container.removeEventListener('mouseleave', this._pianoMouseLeave, true);
        container.removeEventListener('mouseenter', this._pianoMouseEnter, true);
        container.removeEventListener('touchstart', this._pianoTouchStart);
        container.removeEventListener('touchend', this._pianoTouchEnd);

        this._pianoMouseDown = null;
        this._pianoMouseUp = null;
        this._pianoMouseLeave = null;
        this._pianoMouseEnter = null;
        this._pianoTouchStart = null;
        this._pianoTouchEnd = null;
    }

    /**
     * Set the number of keyboard octaves
     * @param {number} octaves - Number of octaves (1-4)
     */
    setOctaves(octaves) {
        // Clamp between min and max octaves
        this.octaves = Math.max(this.minOctaves, Math.min(this.maxOctaves, octaves));

        this.logger.info(`[KeyboardModal] Nombre d'octaves changé: ${this.octaves} (${this.octaves * 12} touches)`);

        // Keep header select in sync
        const select = document.getElementById('keyboard-octaves-count-select');
        if (select && parseInt(select.value) !== this.octaves) {
            select.value = String(this.octaves);
        }

        // Regenerate the keyboard if the modal is open
        if (this.isOpen) {
            this.regeneratePianoKeys();
        }
    }

    /**
     * Persist the current octave count to localStorage
     */
    saveOctavesToSettings() {
        try {
            const saved = localStorage.getItem('gmboop_settings');
            const settings = saved ? JSON.parse(saved) : {};
            settings.keyboardOctaves = this.octaves;
            localStorage.setItem('gmboop_settings', JSON.stringify(settings));
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to save octaves:', error);
        }
    }

    /**
     * Set the number of keyboard keys (DEPRECATED - use setOctaves)
     * @param {number} numberOfKeys - Number of keys (12-48 keys)
     * @deprecated Use setOctaves() instead
     */
    setNumberOfKeys(numberOfKeys) {
        // Compute the number of octaves to display
        const octaves = Math.ceil(numberOfKeys / 12);
        this.setOctaves(octaves);
    }

    handleGlobalMouseUp() {
        this.isMouseDown = false;

        // Stop all notes triggered by the mouse
        // (avoids "stuck" notes if the mouseup happens outside a key)
        if (this.mouseActiveNotes.size > 0) {
            for (const note of this.mouseActiveNotes) {
                this.stopNote(note);
            }
            this.mouseActiveNotes.clear();
        }
    }

    handlePianoKeyDown(e) {
        this.isMouseDown = true;
        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        // Don't play if the key is disabled
        if (key.classList.contains('disabled')) {
            return;
        }

        if (!this.activeNotes.has(note)) {
            this.mouseActiveNotes.add(note);
            this.playNote(note);
        }
    }

    handlePianoKeyUp(e) {
        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        this.mouseActiveNotes.delete(note);

        // Stop the note only if it is active
        if (this.activeNotes.has(note)) {
            this.stopNote(note);
        }
    }

    handlePianoKeyEnter(e) {
        // Play the note only if the mouse is pressed (drag)
        if (!this.isMouseDown) return;

        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        // Don't play if the key is disabled
        if (key.classList.contains('disabled')) {
            return;
        }

        if (!this.activeNotes.has(note)) {
            this.mouseActiveNotes.add(note);
            this.playNote(note);
        }
    }

    handleKeyDown(e) {
        if (!this.isOpen) return;

        const note = this._resolveKeyToNote(e.code);
        if (note === null) return;

        e.preventDefault();

        if (!this.activeNotes.has(note)) {
            this.playNote(note);
        }
    }

    handleKeyUp(e) {
        if (!this.isOpen) return;

        const note = this._resolveKeyToNote(e.code);
        if (note === null) return;

        e.preventDefault();

        this.stopNote(note);
    }

    // ========================================================================
    // MIDI
    // ========================================================================

    /**
     * Return the MIDI channel of the selected instrument (from capabilities or the device)
     * @returns {number} MIDI channel (0-15)
     */
    getSelectedChannel() {
        if (this.selectedDeviceCapabilities && this.selectedDeviceCapabilities.channel !== undefined) {
            return this.selectedDeviceCapabilities.channel;
        }
        if (this.selectedDevice && this.selectedDevice.channel !== undefined) {
            return this.selectedDevice.channel;
        }
        return 0;
    }

    sendModulation(value) {
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
    }

    /**
     * Updates the note-range display in the header
     */
    _updateOctaveDisplay() {
        const octaveDisplayEl = document.getElementById('keyboard-octave-display');
        if (octaveDisplayEl) {
            const endNote = this.startNote + this.octaves * 12 - 1;
            const startName = this.getNoteLabel(this.startNote);
            const endName = this.getNoteLabel(endNote);
            octaveDisplayEl.textContent = `${startName} - ${endName}`;
        }
        // Keep the minimap viewport in sync with the visible range.
        if (typeof this.renderMinimap === 'function') {
            this.renderMinimap();
        }
    }

    /**
     * Get a note's name from its MIDI number
     * @param {number} noteNumber - MIDI number (0-127)
     * @returns {string} - Note name (e.g. "C4", "F#5")
     */
    getNoteNameFromNumber(noteNumber) {
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(noteNumber / 12) - 1;
        const noteName = noteNames[noteNumber % 12];
        return `${noteName}${octave}`;
    }

    /**
     * Format a note label according to the user-selected note format.
     * @param {number} noteNumber - MIDI number
     * @returns {string}
     */
    getNoteLabel(noteNumber) {
        const englishNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const solfegeNames = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
        const octave = Math.floor(noteNumber / 12) - 1;
        const idx = noteNumber % 12;
        if (this.noteLabelFormat === 'midi') {
            return String(noteNumber);
        }
        if (this.noteLabelFormat === 'solfege') {
            return `${solfegeNames[idx]}${octave}`;
        }
        return `${englishNames[idx]}${octave}`;
    }

    /**
     * Detect whether the selected instrument should switch to a special view.
     * @returns {{ canFretboard: boolean, isDrum: boolean, instrumentType: string }}
     */
    getInstrumentViewInfo() {
        const caps = this.selectedDeviceCapabilities;
        const type = (caps && caps.instrument_type) || 'unknown';
        const subtype = (caps && caps.instrument_subtype) || '';
        // Drum: explicit type "drum", or MIDI channel 9, or GM program ≥ 128
        const channel = caps && caps.channel !== undefined ? caps.channel
                      : (this.selectedDevice && this.selectedDevice.channel !== undefined
                            ? this.selectedDevice.channel : null);
        const gmProgram = (caps && caps.gm_program) ?? (this.selectedDevice && this.selectedDevice.gm_program);
        const isDrum = type === 'drum' || channel === 9 || (gmProgram !== undefined && gmProgram !== null && gmProgram >= 128);
        // String: explicit type "string", or stringInstrumentConfig is loaded
        const canFretboard = type === 'string' || !!this.stringInstrumentConfig;
        return { canFretboard, isDrum, instrumentType: type, instrumentSubtype: subtype };
    }

    /**
     * Refresh the latency display in the header from the selected instrument.
     */
    updateLatencyDisplay() {
        const el = document.getElementById('keyboard-latency-display');
        if (!el) return;
        const caps = this.selectedDeviceCapabilities;
        const delay = caps && typeof caps.sync_delay === 'number' ? caps.sync_delay : null;
        if (delay === null || !this.selectedDevice) {
            el.classList.add('latency-empty');
            el.textContent = '—';
        } else {
            el.classList.remove('latency-empty');
            const sign = delay > 0 ? '+' : '';
            el.textContent = `${sign}${delay} ms`;
        }
    }

    /**
     * Try to load string-instrument config (num_strings, num_frets, tuning) for
     * the selected instrument. Falls back to a preset matching gm_program.
     */
    async loadStringInstrumentConfig() {
        this.stringInstrumentConfig = null;
        if (!this.selectedDevice) return;
        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;
        const channel = this.getSelectedChannel();
        try {
            const resp = await this.backend.sendCommand('string_instrument_get', {
                device_id: deviceId,
                channel: channel
            });
            if (resp && resp.instrument) {
                this.stringInstrumentConfig = resp.instrument;
                return;
            }
        } catch (e) { /* ignore — fallback below */ }

        // Fallback: try matching a preset by gm_program
        const caps = this.selectedDeviceCapabilities;
        const gmProgram = (caps && caps.gm_program) ?? (this.selectedDevice && this.selectedDevice.gm_program);
        if (gmProgram === undefined || gmProgram === null) return;
        try {
            const presetsResp = await this.backend.sendCommand('string_instrument_get_presets');
            const presets = (presetsResp && presetsResp.presets) || [];
            // Some backends return geometry presets, others return tuning presets.
            // Look for an entry that lists the gm_program in `gm_programs`.
            const match = presets.find(p => Array.isArray(p.gm_programs) && p.gm_programs.includes(gmProgram));
            if (match) {
                this.stringInstrumentConfig = {
                    num_strings: match.num_strings || 6,
                    num_frets: match.num_frets ?? 22,
                    tuning: match.tuning || null,
                    is_fretless: (match.num_frets === 0)
                };
            }
        } catch (e) { /* ignore */ }
    }

    populateDeviceSelect() {
        const select = document.getElementById('keyboard-device-select');
        if (!select) return;

        select.innerHTML = `<option value="">${this.t('common.select')}</option>`;

        this.devices.forEach(device => {
            const option = document.createElement('option');
            // For multi-instrument devices, include the channel in the value
            if (device._multiInstrument) {
                option.value = `${device.device_id}::${device.channel}`;
                const chLabel = `Ch${(device.channel || 0) + 1}`;
                option.textContent = `${device.displayName || device.name} [${chLabel}]`;
            } else {
                option.value = device.device_id;
                option.textContent = device.displayName || device.name;
            }
            select.appendChild(option);
        });
    }

    /**
     * Refresh the device list if the modal is open
     */
    async refreshDevices() {
        if (!this.isOpen) return;

        this.logger.info('[KeyboardModal] Refreshing devices...');
        await this.loadDevices();
        this.populateDeviceSelect();
    }
}

// Apply mixins (loaded via <script> tags before this file)
if (typeof KeyboardPianoMixin !== 'undefined') {
    Object.assign(KeyboardModalNew.prototype, KeyboardPianoMixin);
}
if (typeof KeyboardEventsMixin !== 'undefined') {
    Object.assign(KeyboardModalNew.prototype, KeyboardEventsMixin);
}
if (typeof KeyboardControlsMixin !== 'undefined') {
    Object.assign(KeyboardModalNew.prototype, KeyboardControlsMixin);
}
