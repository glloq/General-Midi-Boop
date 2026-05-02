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
        // In fretboard mode, tracks which specific string:fret positions are pressed
        // (same MIDI note can exist on several strings — only the pressed one should highlight).
        this.activeFretPositions = new Set();
        this.velocity = 80;
        this.modulation = 64; // CC#1 modulation wheel value (center)
        this._modWheelDragging = false;
        this.keyboardLayout = 'azerty';
        this.isMouseDown = false; // For dragging on the keyboard

        // Piano config
        this.octaves = 3; // 3 octaves by default (range: 1-8 octaves)
        this.minOctaves = 1;
        this.maxOctaves = 8;
        // Internal: number of visible notes (not always a multiple of 12 once
        // the user zooms by 4-note increments).
        this.visibleNoteCount = this.octaves * 12;
        this.minVisibleNotes = 12;
        this.maxVisibleNotes = 96;
        this.zoomStep = 4; // semitones added/removed per zoom click/wheel tick
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
        // Fretboard: show chromatic note colors (12 colors, one per semitone)
        this.showNoteColors = false;
        // String instrument config (loaded when fretboard mode is enabled)
        this.stringInstrumentConfig = null;
        // Per-string pitch bend slide mode active
        this._stringSlideActive = false;
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

        // Header group labels (resolved by their wrapping group classes)
        const setLabel = (selector, key) => {
            const el = this.container.querySelector(selector);
            if (el) el.textContent = this.t(key);
        };
        setLabel('.keyboard-header-controls .latency-group label', 'keyboard.latency');
        setLabel('.keyboard-header-controls .view-mode-group label', 'keyboard.view');
        setLabel('.keyboard-header-controls .notation-group label', 'keyboard.notation');

        // Note range display
        this._updateOctaveDisplay();

        // Refresh instrument trigger placeholder/name
        if (typeof this._updateInstrumentTrigger === 'function') {
            this._updateInstrumentTrigger();
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

        // Clean up string slide mode
        if (typeof this.destroyStringSliders === 'function') this.destroyStringSliders();

        // Clean up keyboard list view interaction
        if (typeof this._destroyKeyboardListInteraction === 'function') this._destroyKeyboardListInteraction();

        // Stop all active notes
        this.activeNotes.forEach(note => this.stopNote(note));

        // Reset state
        this.isMouseDown = false;
        this.mouseActiveNotes.clear();
        this.activeFretPositions.clear();
        this.selectedDevice = null;

        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.isOpen = false;
        this.logger.info('[KeyboardModal] Closed');
    }

    updatePianoDisplay() {
        if (this.viewMode === 'fretboard') {
            // In fretboard mode, highlight only the specific string:fret that was pressed.
            // The same MIDI note can appear on several strings — activeFretPositions
            // tracks exactly which dot was touched, so other strings stay unlit.
            document.querySelectorAll('.fretboard-container .fret-dot.piano-key').forEach(dot => {
                const pos = (dot.dataset.string !== undefined && dot.dataset.fret !== undefined)
                    ? `${dot.dataset.string}:${dot.dataset.fret}`
                    : null;
                dot.classList.toggle('active', pos !== null && this.activeFretPositions.has(pos));
            });
        } else {
            document.querySelectorAll('.piano-key').forEach(key => {
                key.classList.toggle('active', this.activeNotes.has(parseInt(key.dataset.note)));
            });
        }

        // Color the string line to the right of the active fret.
        if (this.viewMode === 'fretboard' && typeof this._updateFretboardStringColors === 'function') {
            this._updateFretboardStringColors();
        }
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
        if (this.viewMode === 'piano-slider') {
            // In slider mode, regenerate the equal-width strip instead
            if (typeof this.generatePianoSlider === 'function') this.generatePianoSlider();
            if (typeof this.renderMinimap === 'function') this.renderMinimap();
            if (typeof this.renderOctaveBar === 'function') this.renderOctaveBar();
            return;
        }

        if (this.viewMode === 'keyboard-list') {
            if (typeof this.renderKeyboardList === 'function') this.renderKeyboardList();
            if (typeof this.renderMinimap === 'function') this.renderMinimap();
            return;
        }

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
        this.visibleNoteCount = this.octaves * 12;

        this.logger.info(`[KeyboardModal] Nombre d'octaves changé: ${this.octaves} (${this.visibleNoteCount} touches)`);

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
     * Set the raw number of visible notes (not necessarily a multiple of 12).
     * Used by the zoom buttons / wheel which step by `this.zoomStep` semitones.
     */
    setVisibleNotes(count) {
        const clamped = Math.max(this.minVisibleNotes, Math.min(this.maxVisibleNotes, count));
        this.visibleNoteCount = clamped;
        // Keep `this.octaves` loosely in sync for downstream code that still
        // reads it (header dropdown, persisted settings).
        this.octaves = Math.max(this.minOctaves, Math.min(this.maxOctaves, Math.round(clamped / 12)));
        // Keep startNote within bounds for the new visible count.
        this.startNote = Math.max(0, Math.min(127 - this.visibleNoteCount, this.startNote));

        const select = document.getElementById('keyboard-octaves-count-select');
        if (select) {
            // Only reflect on the dropdown when the count matches a clean octave.
            if (clamped % 12 === 0) {
                select.value = String(this.octaves);
            } else {
                select.value = '';
            }
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
        this.activeFretPositions.clear();
    }

    handlePianoKeyDown(e) {
        this.isMouseDown = true;
        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        // Don't play if the key is disabled
        if (key.classList.contains('disabled')) {
            return;
        }

        // Track specific fretboard position BEFORE playNote triggers updatePianoDisplay.
        if (key.dataset.string !== undefined && key.dataset.fret !== undefined) {
            this.activeFretPositions.add(`${key.dataset.string}:${key.dataset.fret}`);
        }

        // Auto-move hand if the clicked fret is outside the current hand window.
        if (key.dataset.fret !== undefined && typeof this._maybeAutoMoveHand === 'function') {
            this._maybeAutoMoveHand(parseInt(key.dataset.fret, 10));
        }

        if (!this.activeNotes.has(note)) {
            this.mouseActiveNotes.add(note);
            // Fretboard cells carry data-string + data-fret so the receiving
            // instrument can pre-position its mechanical fingers before the
            // note-on. Send them right before playNote so the order on the
            // wire matches the playback path used elsewhere in the app.
            this._maybeSendStringFretCC(key);
            this.playNote(note);
        }
    }

    handlePianoKeyUp(e) {
        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        // Release specific fretboard position.
        if (key.dataset.string !== undefined && key.dataset.fret !== undefined) {
            this.activeFretPositions.delete(`${key.dataset.string}:${key.dataset.fret}`);
        }

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

        // Track specific fretboard position BEFORE playNote triggers updatePianoDisplay.
        if (key.dataset.string !== undefined && key.dataset.fret !== undefined) {
            this.activeFretPositions.add(`${key.dataset.string}:${key.dataset.fret}`);
        }

        if (!this.activeNotes.has(note)) {
            this.mouseActiveNotes.add(note);
            this._maybeSendStringFretCC(key);
            this.playNote(note);
        }
    }

    /**
     * If the clicked element belongs to the fretboard view, emit the
     * configured "select string" + "select fret" CC messages so the
     * instrument can pre-position its mechanical fingers before the note-on.
     * Reads CC numbers / ranges / offsets from the active string-instrument
     * config (or sensible defaults: CC20=string [1..12], CC21=fret [0..36]).
     * @param {HTMLElement} keyEl - The key DOM node (.fret-dot)
     */
    _maybeSendStringFretCC(keyEl) {
        if (!keyEl || !keyEl.dataset || keyEl.dataset.string === undefined || keyEl.dataset.fret === undefined) {
            return;
        }
        if (!this.selectedDevice || !this.backend) return;

        const cfg = this.stringInstrumentConfig || {};
        if (cfg.cc_enabled === false) return; // explicitly disabled on this instrument

        const stringIdx = parseInt(keyEl.dataset.string, 10);
        const fret = parseInt(keyEl.dataset.fret, 10);
        if (!Number.isFinite(stringIdx) || !Number.isFinite(fret)) return;

        const ccStringNumber = cfg.cc_string_number !== undefined ? cfg.cc_string_number : 20;
        const ccStringMin    = cfg.cc_string_min    !== undefined ? cfg.cc_string_min    : 1;
        const ccStringMax    = cfg.cc_string_max    !== undefined ? cfg.cc_string_max    : 12;
        const ccStringOffset = cfg.cc_string_offset || 0;
        const ccFretNumber   = cfg.cc_fret_number   !== undefined ? cfg.cc_fret_number   : 21;
        const ccFretMin      = cfg.cc_fret_min      !== undefined ? cfg.cc_fret_min      : 0;
        const ccFretMax      = cfg.cc_fret_max      !== undefined ? cfg.cc_fret_max      : 36;
        const ccFretOffset   = cfg.cc_fret_offset   || 0;

        const clamp127 = (v, lo, hi) => Math.max(0, Math.min(127, Math.max(lo, Math.min(hi, v))));
        const stringVal = clamp127(stringIdx + ccStringOffset, ccStringMin, ccStringMax);
        const fretVal   = clamp127(fret + ccFretOffset, ccFretMin, ccFretMax);

        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

        if (this.selectedDevice.isVirtual) {
            this.logger?.info?.(`🎸 [Virtual] CC${ccStringNumber}=${stringVal} (string ${stringIdx}) CC${ccFretNumber}=${fretVal} (fret ${fret})`);
            return;
        }

        const channel = this.getSelectedChannel();
        this.backend.sendCommand('midi_send_cc', {
            deviceId, channel, controller: ccStringNumber, value: stringVal
        }).catch(err => this.logger.error('[KeyboardModal] String CC send failed:', err));
        this.backend.sendCommand('midi_send_cc', {
            deviceId, channel, controller: ccFretNumber, value: fretVal
        }).catch(err => this.logger.error('[KeyboardModal] Fret CC send failed:', err));
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
            const endNote = this.startNote + this.visibleNoteCount - 1;
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
        // String: explicit "string" type, an active stringInstrumentConfig, or
        // a GM program in the guitar/bass/orchestral/ethnic-strings ranges.
        const stringByGm = !isDrum
            && gmProgram !== undefined && gmProgram !== null
            && (
                (gmProgram >= 24 && gmProgram <= 47) ||  // guitar, bass, orchestral strings
                gmProgram === 104 || // sitar
                gmProgram === 105 || // banjo
                gmProgram === 106 || // shamisen
                gmProgram === 107 || // koto
                gmProgram === 110    // fiddle
            );
        const canFretboard = type === 'string' || !!this.stringInstrumentConfig || stringByGm;
        return { canFretboard, isDrum, instrumentType: type, instrumentSubtype: subtype, gmProgram };
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
     * GM-program → default string-instrument geometry (num_strings, num_frets,
     * tuning in MIDI). Used as a fallback when the database has no per-channel
     * string-instrument config for the selected device.
     */
    _getStringPresetForGmProgram(gmProgram) {
        if (gmProgram === undefined || gmProgram === null) return null;
        // Acoustic Guitar (nylon)
        if (gmProgram === 24) return { num_strings: 6, num_frets: 19, tuning: [40, 45, 50, 55, 59, 64], is_fretless: false };
        // Acoustic Guitar (steel)
        if (gmProgram === 25) return { num_strings: 6, num_frets: 20, tuning: [40, 45, 50, 55, 59, 64], is_fretless: false };
        // Electric guitars (jazz, clean, muted, overdriven, distortion, harmonics)
        if (gmProgram >= 26 && gmProgram <= 31) return { num_strings: 6, num_frets: 22, tuning: [40, 45, 50, 55, 59, 64], is_fretless: false };
        // Acoustic Bass
        if (gmProgram === 32) return { num_strings: 4, num_frets: 20, tuning: [28, 33, 38, 43], is_fretless: false };
        // Electric basses (finger, pick, fretless, slap×2, synth×2)
        if (gmProgram === 35) return { num_strings: 4, num_frets: 0, tuning: [28, 33, 38, 43], is_fretless: true };
        if (gmProgram >= 33 && gmProgram <= 39) return { num_strings: 4, num_frets: 22, tuning: [28, 33, 38, 43], is_fretless: false };
        // Orchestral strings (violin, viola, cello, contrabass, tremolo, pizzicato, ensemble1, ensemble2)
        if (gmProgram === 40 || gmProgram === 110) return { num_strings: 4, num_frets: 0, tuning: [55, 62, 69, 76], is_fretless: true }; // violin / fiddle
        if (gmProgram === 41) return { num_strings: 4, num_frets: 0, tuning: [48, 55, 62, 69], is_fretless: true }; // viola
        if (gmProgram === 42) return { num_strings: 4, num_frets: 0, tuning: [36, 43, 50, 57], is_fretless: true }; // cello
        if (gmProgram === 43) return { num_strings: 4, num_frets: 0, tuning: [28, 33, 38, 43], is_fretless: true }; // contrabass
        if (gmProgram >= 44 && gmProgram <= 45) return { num_strings: 4, num_frets: 0, tuning: [55, 62, 69, 76], is_fretless: true }; // tremolo / pizzicato (default to violin)
        // Harp (special: many strings, no frets)
        if (gmProgram === 46) return { num_strings: 22, num_frets: 0, tuning: null, is_fretless: true };
        // Timpani — not a string instrument; fall through.
        // Sitar
        if (gmProgram === 104) return { num_strings: 7, num_frets: 20, tuning: [36, 43, 50, 55, 62, 69, 76], is_fretless: false };
        // Banjo
        if (gmProgram === 105) return { num_strings: 5, num_frets: 22, tuning: [62, 67, 50, 55, 50], is_fretless: false };
        // Shamisen (3 strings)
        if (gmProgram === 106) return { num_strings: 3, num_frets: 0, tuning: [50, 57, 62], is_fretless: true };
        // Koto (13 strings, traditional tuning approximate)
        if (gmProgram === 107) return { num_strings: 13, num_frets: 0, tuning: null, is_fretless: true };
        return null;
    }

    /**
     * Try to load string-instrument config (num_strings, num_frets, tuning) for
     * the selected instrument. Falls back to a GM-program preset when the
     * database has no per-channel config.
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
                this._mergeHandsConfigFromCapabilities();
                if (typeof this._updateSlideModeGroupVisibility === 'function') {
                    this._updateSlideModeGroupVisibility();
                }
                return;
            }
        } catch (e) { /* ignore — fallback below */ }

        // Fallback: GM-program-based defaults bundled in the frontend.
        const caps = this.selectedDeviceCapabilities;
        const gmProgram = (caps && caps.gm_program) ?? (this.selectedDevice && this.selectedDevice.gm_program);
        const preset = this._getStringPresetForGmProgram(gmProgram);
        if (preset) {
            this.stringInstrumentConfig = preset;
        }
        this._mergeHandsConfigFromCapabilities();
        if (typeof this._updateSlideModeGroupVisibility === 'function') {
            this._updateSlideModeGroupVisibility();
        }
    }

    /**
     * Merge hands_config from selectedDeviceCapabilities into stringInstrumentConfig.
     * This is needed because hands_config is saved via the instrument settings modal
     * (instrument_save_all) but stringInstrumentConfig is loaded from string_instrument_get.
     */
    _mergeHandsConfigFromCapabilities() {
        if (!this.stringInstrumentConfig) return;
        const caps = this.selectedDeviceCapabilities;
        if (caps && caps.hands_config) {
            this.stringInstrumentConfig.hands_config = caps.hands_config;
        }
    }

    populateDeviceSelect() {
        this._buildInstrumentDropdown();
        this._updateInstrumentTrigger();
    }

    _buildInstrumentDropdown() {
        const dropdown = document.getElementById('instrument-dropdown');
        if (!dropdown) return;

        dropdown.innerHTML = '';

        // "No selection" entry — spans full grid width
        const noneBtn = document.createElement('button');
        noneBtn.type = 'button';
        noneBtn.className = 'instrument-option option-none' + (!this.selectedDevice ? ' selected' : '');
        noneBtn.dataset.deviceId = '';
        noneBtn.innerHTML = `
            <div class="option-icon"><span class="option-emoji">🎵</span></div>
            <span class="option-name">— ${this.t('common.select')} —</span>
        `;
        noneBtn.addEventListener('click', () => this._selectInstrumentOption(''));
        dropdown.appendChild(noneBtn);

        this.devices.forEach(device => {
            const deviceId = device.device_id || device.id;
            const rawValue = device._multiInstrument ? `${deviceId}::${device.channel}` : deviceId;
            const gmProgram = device.gm_program;
            const channel = device.channel;

            const icon = window.InstrumentFamilies
                ? window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram, channel })
                : { svgUrl: null, emoji: '🎵' };

            const isSelected = this.selectedDevice
                && (this.selectedDevice.device_id === deviceId || this.selectedDevice.id === deviceId)
                && (!device._multiInstrument || device.channel === this.selectedDevice.channel);

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'instrument-option' + (isSelected ? ' selected' : '');
            btn.dataset.deviceId = rawValue;

            const name = device.displayName || device.name;
            const chLabel = device._multiInstrument
                ? `<span class="option-ch">Ch${(channel || 0) + 1}</span>`
                : '';

            const imgHtml = icon.svgUrl
                ? `<img class="option-svg" src="${icon.svgUrl}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'"><span class="option-emoji" style="display:none">${icon.emoji}</span>`
                : `<span class="option-emoji">${icon.emoji}</span>`;

            btn.innerHTML = `
                <div class="option-icon">${imgHtml}</div>
                <span class="option-name">${name}${chLabel}</span>
            `;
            btn.addEventListener('click', () => this._selectInstrumentOption(rawValue));
            dropdown.appendChild(btn);
        });
    }

    _updateInstrumentTrigger() {
        const triggerSvg = document.getElementById('instrument-trigger-svg');
        const triggerEmoji = document.getElementById('instrument-trigger-emoji');
        const triggerName = document.getElementById('instrument-trigger-name');
        if (!triggerName) return;

        if (!this.selectedDevice) {
            if (triggerSvg) triggerSvg.style.display = 'none';
            if (triggerEmoji) { triggerEmoji.textContent = '🎵'; triggerEmoji.style.display = 'inline'; }
            triggerName.textContent = `— ${this.t('common.select')} —`;
            return;
        }

        const gmProgram = this.selectedDevice.gm_program;
        const channel = this.selectedDevice.channel;
        const icon = window.InstrumentFamilies
            ? window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram, channel })
            : { svgUrl: null, emoji: '🎵' };

        if (icon.svgUrl && triggerSvg) {
            triggerSvg.src = icon.svgUrl;
            triggerSvg.style.display = 'block';
            triggerSvg.onerror = () => {
                triggerSvg.style.display = 'none';
                if (triggerEmoji) { triggerEmoji.textContent = icon.emoji; triggerEmoji.style.display = 'inline'; }
            };
            if (triggerEmoji) triggerEmoji.style.display = 'none';
        } else {
            if (triggerSvg) triggerSvg.style.display = 'none';
            if (triggerEmoji) { triggerEmoji.textContent = icon.emoji; triggerEmoji.style.display = 'inline'; }
        }

        triggerName.textContent = this.selectedDevice.displayName || this.selectedDevice.name;
    }

    async _selectInstrumentOption(rawValue) {
        // Close dropdown
        const dropdown = document.getElementById('instrument-dropdown');
        const selector = document.getElementById('header-instrument-selector');
        const trigger = document.getElementById('instrument-trigger');
        dropdown?.classList.remove('open');
        selector?.classList.remove('open');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');

        let deviceId = rawValue;
        let selectedChannel = undefined;

        if (rawValue.includes('::')) {
            const parts = rawValue.split('::');
            deviceId = parts[0];
            selectedChannel = parseInt(parts[1]);
        }

        this.selectedDevice = rawValue
            ? this.devices.find(d => {
                if (d._multiInstrument && selectedChannel !== undefined) {
                    return (d.device_id === deviceId || d.id === deviceId) && d.channel === selectedChannel;
                }
                return d.device_id === deviceId || d.id === deviceId;
            }) || null
            : null;

        this.stringInstrumentConfig = null;

        await this.loadDeviceCapabilities(deviceId || null, selectedChannel);
        this.autoCenterKeyboard();
        this.updateSlidersVisibility();

        this.modulation = 64;
        this._updateModWheelPosition(64);
        const modDisplay = document.getElementById('keyboard-modulation-display');
        if (modDisplay) modDisplay.textContent = '64';

        this.updateLatencyDisplay();
        this._updateInstrumentTrigger();
        this._buildInstrumentDropdown(); // refresh selected state

        const info = this.getInstrumentViewInfo();
        const viewGroup = document.getElementById('keyboard-view-mode-group');
        if (info.isDrum) {
            if (viewGroup) viewGroup.classList.remove('hidden');
            this.stringInstrumentConfig = null;
            this.setViewMode('drumpad');
        } else if (info.canFretboard) {
            await this.loadStringInstrumentConfig();
            if (viewGroup) viewGroup.classList.remove('hidden');
            this.setViewMode('fretboard');
        } else {
            this.stringInstrumentConfig = null;
            if (viewGroup) viewGroup.classList.add('hidden');
            this.setViewMode('piano');
        }

        this.regeneratePianoKeys();
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
if (typeof KeyboardChordsMixin !== 'undefined') {
    Object.assign(KeyboardModalNew.prototype, KeyboardChordsMixin);
}
if (typeof KeyboardSliderMixin !== 'undefined') {
    Object.assign(KeyboardModalNew.prototype, KeyboardSliderMixin);
}
if (typeof KeyboardListViewMixin !== 'undefined') {
    Object.assign(KeyboardModalNew.prototype, KeyboardListViewMixin);
}
