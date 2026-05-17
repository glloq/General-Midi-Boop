// ============================================================================
// KeyboardModal.js - DIV-based keyboard (no Canvas)
// Version: 1.1.0 - Support i18n
// ============================================================================

class KeyboardModal {
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
        // List view controls
        this.listViewYCC = null;              // null = vélocité, number = CC# pour l'axe Y
        this.listViewPitchBendEnabled = true; // pitch bend actif sur le drag horizontal (X)
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
        // View mode: 'piano' (default), 'fretboard' (string instr.), 'drumpad' (drum), 'piano-slider' (wind)
        this.viewMode = 'piano';
        // Wind instrument state (set when a wind GM instrument is selected)
        this.windPreset = null;
        this.currentArticulation = 'normal';
        // Fretboard: show chromatic note colors (12 colors, one per semitone)
        this.showNoteColors = false;
        // String instrument config (loaded when fretboard mode is enabled)
        this.stringInstrumentConfig = null;
        // Harp string config (loaded for the dedicated HarpView; kept
        // separate from stringInstrumentConfig so the InstrumentDetector
        // escape hatch — stringCfg forces fretboard — stays untouched).
        this._harpStringConfig = null;
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

        // Panel mode (embedded in a host container)
        this._panelMode = false;
        this._panelCallbacks = null;
        this._panelDialogEl = null;

        // InstrumentView migration (Phase C/D complete): the registry is the
        // authoritative owner of the active view's lifecycle. setViewMode()
        // resolves a registered InstrumentView and drives mount()/unmount()
        // on it; the view delegates the actual rendering to the legacy mixin
        // methods (strangler fig). Adding a new instrument view is now a
        // matter of dropping a XxxView.js + one registry rule — no change to
        // this class or to setViewMode.
        this._activeView = null;
        this._activeViewKind = null;
        // Options forwarded into the next view's ctx (e.g. { windPreset }).
        this._pendingViewOptions = {};

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

        const refresh = async () => {
            if (this.isOpen) {
                await this.loadDevices();
                this.populateDeviceSelect();
            }
        };

        this._eventUnsubs = [
            this.eventBus.on('bluetooth:connected',    async (_data) => { this.logger.info('[KeyboardModal] Bluetooth device connected, refreshing device list...'); await refresh(); }),
            this.eventBus.on('bluetooth:disconnected', async (_data) => { this.logger.info('[KeyboardModal] Bluetooth device disconnected, refreshing device list...'); await refresh(); }),
            this.eventBus.on('bluetooth:unpaired',     async (_data) => { this.logger.info('[KeyboardModal] Bluetooth device unpaired, refreshing device list...'); await refresh(); }),
        ];

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
        this._subscribeLocale();

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

        // Unsubscribe from EventBus events
        if (this._eventUnsubs) {
            this._eventUnsubs.forEach(unsub => { if (typeof unsub === 'function') unsub(); });
            this._eventUnsubs = [];
        }

        // Phase E (KM-M3): remove any DOM listener registered through _on().
        // Existing call sites still rely on detachEvents() above; new code
        // should prefer this._on() for automatic cleanup.
        if (typeof this._offAll === 'function') this._offAll();

        // Clean up string slide mode
        if (typeof this.destroyStringSliders === 'function') this.destroyStringSliders();

        // Release any held bow (bowed-string instruments) so document
        // listeners and CC state don't leak across modal lifecycles.
        if (typeof this._stopActiveBow === 'function') this._stopActiveBow();

        // Clean up keyboard list view interaction
        if (typeof this._destroyKeyboardListInteraction === 'function') this._destroyKeyboardListInteraction();

        // Destroy the fingers overlay renderer
        if (typeof this._cleanFingersCanvas === 'function') this._cleanFingersCanvas();

        // Clean up wind instrument controls and staccato timers
        if (typeof this._hideWindControls === 'function') this._hideWindControls();

        // Tear down the active InstrumentView. Without this its document-level
        // listeners (pointerup/pointercancel registered in mount()) leak across
        // every open/close cycle, and — because _activeView/_activeViewKind
        // would survive — a reopen would hit the _activateView() same-kind
        // fast-path and never re-mount, leaving the view bound to DOM removed
        // below.
        if (this._activeView && typeof this._activeView.unmount === 'function') {
            try { this._activeView.unmount(); }
            catch (e) { this.logger.warn('[KeyboardModal] view.unmount() in close() failed:', e); }
        }
        this._activeView = null;
        this._activeViewKind = null;

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

        // Move slide-system finger dots to the active fret position (≈8 mm before fret).
        if (this.viewMode === 'fretboard' && typeof this._updateSlideFingerPositions === 'function') {
            this._updateSlideFingerPositions();
        }

        // Move fret_sliding_fingers overlay dots to match active string:fret presses.
        if (this.viewMode === 'fretboard' && typeof this._updateFingerDotPositions === 'function') {
            const activeFrets = {};
            for (const pos of this.activeFretPositions) {
                const parts = pos.split(':');
                const str  = parseInt(parts[0], 10);
                const fret = parseInt(parts[1], 10);
                if (!isNaN(str) && !isNaN(fret) && fret > 0) activeFrets[str] = fret;
            }
            this._updateFingerDotPositions(activeFrets);
        }

        // Keep the fingers overlay in sync with the currently-sounding keys.
        if (typeof this._updateFingersActiveNotes === 'function') {
            this._updateFingersActiveNotes();
        }

        // Self-owned views render non-`.piano-key` DOM the legacy query
        // above never reaches; delegate the highlight. No-op for the
        // strangler-fig views (base setActiveNotes() does nothing).
        if (this._activeView && typeof this._activeView.setActiveNotes === 'function') {
            this._activeView.setActiveNotes(this.activeNotes);
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
     * Remove delegated piano container listeners.
     *
     * Pairs with KeyboardPiano._setupPianoDelegation. The new
     * implementation (Phase F swipe fix) tracks listeners in a single
     * `_pianoListeners` array and routes drag events through a
     * SwipeTracker — so cleanup is a uniform iteration.
     */
    _removePianoDelegation() {
        if (this._swipeTracker) {
            // End any in-flight pointer so we don't leak a note-on without
            // its matching note-off.
            this._swipeTracker.endAll();
            this._swipeTracker = null;
        }
        if (Array.isArray(this._pianoListeners)) {
            for (const [el, evt, h, opts] of this._pianoListeners) {
                try { el.removeEventListener(evt, h, opts); } catch (_) { /* ignore */ }
            }
            this._pianoListeners = [];
        }
    }

    // ========================================================================
    // INSTRUMENT-VIEW LIFECYCLE (registry-driven — KM-C1)
    // ========================================================================

    /**
     * Build the ViewContext handed to every InstrumentView.mount().
     * The view delegates rendering back through `modal.*` (Phase D), and
     * reads shared state from the same object.
     * @param {Object} options - Per-view options (e.g. { windPreset }).
     * @returns {Object}
     */
    _buildViewContext(options = {}) {
        return {
            modal: this,
            state: this,
            backend: this.backend,
            eventBus: this.eventBus,
            i18n: { t: (k, p) => this.t(k, p) },
            capabilities: this.selectedDeviceCapabilities,
            options: options || {}
        };
    }

    /**
     * Resolve the registered InstrumentView for `viewKind` and drive its
     * lifecycle. This is the single place that owns "which view is active":
     *  - same kind already mounted → refresh via setCapabilities()
     *  - different kind → unmount the previous view, mount the new one
     *  - registry/class unavailable → fall back to the legacy render switch
     *
     * The resolved view's mount() performs the actual DOM render by
     * delegating to the legacy mixin methods (renderFretboard, etc.).
     *
     * @param {string} viewKind - 'piano' | 'fretboard' | 'drumpad' |
     *                            'piano-slider' | 'keyboard-list' | …
     * @param {Object} [options] - Forwarded into the view ctx.
     */
    _activateView(viewKind, options = {}) {
        const registry = (typeof window !== 'undefined' && window.instrumentViews) || null;
        const ViewClass = registry && typeof registry.get === 'function'
            ? registry.get(viewKind)
            : null;

        // No registered view (older host, test without registry, or a brand
        // new kind not yet implemented) → keep the modal working via the
        // legacy render switch. This guarantees zero regression.
        if (typeof ViewClass !== 'function') {
            this._activeView = null;
            this._activeViewKind = viewKind;
            this._legacyRenderForMode(viewKind);
            return;
        }

        // Same kind still active → just refresh capabilities, no teardown.
        if (this._activeView && this._activeViewKind === viewKind && this._activeView.mounted) {
            if (typeof this._activeView.setCapabilities === 'function') {
                this._activeView.setCapabilities(this.selectedDeviceCapabilities);
            }
            return;
        }

        // Tear down the previous view (its unmount() releases view-specific
        // interaction state: string sliders, bow, list interaction, …).
        if (this._activeView && typeof this._activeView.unmount === 'function') {
            try { this._activeView.unmount(); }
            catch (e) { this.logger.warn('[KeyboardModal] view.unmount() failed:', e); }
        }

        let view = null;
        try {
            view = new ViewClass();
            view.mount(this._buildViewContext(options));
        } catch (e) {
            this.logger.error(`[KeyboardModal] view "${viewKind}" mount failed, using legacy render:`, e);
            this._activeView = null;
            this._activeViewKind = viewKind;
            this._legacyRenderForMode(viewKind);
            return;
        }

        this._activeView = view;
        this._activeViewKind = viewKind;
    }

    /**
     * Legacy render fallback — mirrors the historical tail of setViewMode().
     * Only used when no InstrumentView is registered for the kind (defensive;
     * the built-in 5 kinds are always registered via registerBuiltins.js).
     * @param {string} mode
     */
    _legacyRenderForMode(mode) {
        if (mode === 'fretboard' && typeof this.renderFretboard === 'function') this.renderFretboard();
        else if (mode === 'drumpad' && typeof this.renderDrumPad === 'function') this.renderDrumPad();
        else if (mode === 'piano-slider' && typeof this.generatePianoSlider === 'function') this.generatePianoSlider();
        else if (mode === 'keyboard-list' && typeof this.renderKeyboardList === 'function') this.renderKeyboardList();
        else if (typeof this.regeneratePianoKeys === 'function') this.regeneratePianoKeys();
    }

    /**
     * PE-2: single owner of the *mode-only* toolbar-group visibility
     * (octave bar, minimap, note-color group, list-view group). Pure
     * extraction of the formulas previously inlined in setViewMode —
     * behaviour is intentionally IDENTICAL (zero-regression).
     *
     * Mode-only group visibility is driven solely by `this.viewMode`.
     * Caps-aware groups (velocity/mod/pitch/slide/piano-slider/list-cc/
     * list-pb/wind) stay owned by updateSlidersVisibility /
     * _updateListViewControls / _updateSlideModeGroupVisibility /
     * _updatePianoSliderGroupVisibility. The view-mode group is owned by
     * _selectInstrumentOption (F2).
     */
    _applyToolbarGroups() {
        const vm = this.viewMode;
        const set = (id, hidden) => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('hidden', hidden);
        };
        // Octave bar: standard piano + piano-slider only.
        set('keyboard-octave-bar', vm !== 'piano' && vm !== 'piano-slider');
        // Minimap: piano-family (piano / piano-slider / keyboard-list).
        const isPianoFamily = vm === 'piano' || vm === 'piano-slider' || vm === 'keyboard-list';
        set('keyboard-minimap-row', !isPianoFamily);
        // Note-color (🎨) toggle: QA #3 — must stay VISIBLE on piano-slider
        // (and everywhere else); only a drum kit has no pitch colours, so
        // hide it solely in drumpad.
        set('keyboard-note-color-group', vm === 'drumpad');
        // List-view toggle: hidden in fretboard / drumpad context.
        set('keyboard-list-view-group', vm === 'fretboard' || vm === 'drumpad');
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
        if (document.activeElement?.matches('input, textarea, [contenteditable]')) return;

        const note = this._resolveKeyToNote(e.code);
        if (note === null) return;

        e.preventDefault();

        if (!this.activeNotes.has(note)) {
            this.playNote(note);
        }
    }

    handleKeyUp(e) {
        if (!this.isOpen) return;
        if (document.activeElement?.matches('input, textarea, [contenteditable]')) return;

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

    sendCC(controller, value) {
        if (!this.selectedDevice || !this.backend) return;
        if (this.selectedDevice.isVirtual) {
            this.logger.info(`🎹 [Virtual] CC#${controller} = ${value}`);
            return;
        }
        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;
        const channel = this.getSelectedChannel();
        this.backend.sendCommand('midi_send_cc', {
            deviceId, channel, controller, value
        }).catch(err => this.logger.error('[KeyboardModal] CC send failed:', err));
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
     * Chromatic colour for a MIDI note (1 colour per pitch class, octave
     * invariant). Same palette as FRET_NOTE_COLORS / LIST_NOTE_COLORS so
     * every view (piano, fretboard, list AND the self-owned instrument
     * views) shows consistent colours when the 🎨 toggle is on.
     * @param {number} midi
     * @returns {{bg:string,text:string}}
     */
    getNoteColor(midi) {
        const PALETTE = [
            { bg: '#EF4444', text: '#fff' },    // C
            { bg: '#F4622A', text: '#fff' },    // C#
            { bg: '#F97316', text: '#fff' },    // D
            { bg: '#FBBF24', text: '#1a1a1a' }, // D#
            { bg: '#EAB308', text: '#1a1a1a' }, // E
            { bg: '#84CC16', text: '#1a1a1a' }, // F
            { bg: '#22C55E', text: '#fff' },    // F#
            { bg: '#14B8A6', text: '#fff' },    // G
            { bg: '#06B6D4', text: '#fff' },    // G#
            { bg: '#3B82F6', text: '#fff' },    // A
            { bg: '#7C3AED', text: '#fff' },    // A#
            { bg: '#A855F7', text: '#fff' },    // B
        ];
        return PALETTE[(((midi | 0) % 12) + 12) % 12];
    }

    /**
     * Note range configured for the selected instrument (same source as
     * autoCenterKeyboard). Self-owned views use this instead of a hardcoded
     * span so they show exactly the configured number of notes.
     *
     * Priority: discrete selected_notes → caps note_range_min/max → the
     * modal's current visible window (startNote..+visibleNoteCount). The
     * window fallback is what makes the views actually follow the
     * configured note count even when an instrument declares no explicit
     * range in its capabilities (QA #2).
     *
     * @returns {{min:number,max:number,notes:number[]|null}}
     */
    getInstrumentNoteRange() {
        const caps = this.selectedDeviceCapabilities;
        if (caps) {

        if (caps.note_selection_mode === 'discrete' && caps.selected_notes) {
            try {
                const notes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes) : caps.selected_notes;
                if (Array.isArray(notes) && notes.length > 0) {
                    const sorted = [...notes].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
                    if (sorted.length) {
                        return { min: sorted[0], max: sorted[sorted.length - 1], notes: sorted };
                    }
                }
            } catch (_) { /* ignore */ }
        }

        const min = Number(caps.note_range_min);
        const max = Number(caps.note_range_max);
        if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
            return { min, max, notes: null };
        }
        } // end if (caps)

        // Fallback: the modal's current visible window (configured octaves
        // + autoCenter). Guarantees the views follow the configured note
        // count instead of a per-view hardcoded span (QA #2).
        const wMin = Number.isFinite(this.startNote) ? this.startNote : 48;
        const count = Number.isFinite(this.visibleNoteCount) && this.visibleNoteCount > 0
            ? this.visibleNoteCount : 36;
        return { min: wMin, max: wMin + count - 1, notes: null };
    }

    /**
     * Instrument-specific bagpipe settings. Read from the same per-instrument
     * capabilities object the instrument-settings modal already populates
     * (like hands_config) — optional `caps.bagpipe_config`. Accepts the
     * legacy `drones:number[]` shape and the `[{note,enabled}]` shape via
     * the shared normalizer. `drones` returns only the *enabled* notes
     * (what should actually sound); `droneObjs` is the full list.
     * Defaults match the previous behaviour (single A2 drone, enabled).
     * @returns {{drones:number[], droneObjs:Array<{note:number,enabled:boolean}>, enabled:boolean}}
     */
    getBagpipeConfig() {
        const caps = this.selectedDeviceCapabilities;
        const c = (caps && caps.bagpipe_config) || {};
        const enabled = c.enabled !== false;
        const objs = window.MidiConstants.normalizeBagpipeDrones(c.drones);
        if (!objs.length) {
            return { drones: [45], droneObjs: [{ note: 45, enabled: true }], enabled };
        }
        const drones = objs.filter(d => d.enabled !== false).map(d => d.note);
        return { drones, droneObjs: objs, enabled };
    }

    /**
     * Instrument-specific accordion settings (optional `caps.accordion_config`).
     * The accordion ALWAYS has both sides — this only describes the play
     * possibilities of each side (no hand show/hide):
     *   - right side: `right_display` 'buttons' | 'keyboard'
     *   - left  side: `bass_system` 'stradella' | 'free' (legacy 'chromatic'
     *     is normalized → 'free' at read time; no data migration)
     *   - left  side span: `bass_range` {min,max} MIDI, only used by the
     *     free-bass system (Stradella is fixed). Defaults to C2..C4.
     * Defaults preserve the previous look (Stradella bass, button right).
     * @returns {{bass_system:'stradella'|'free',
     *            right_display:'buttons'|'keyboard',
     *            bass_range:{min:number,max:number}}}
     */
    getAccordionConfig() {
        const caps = this.selectedDeviceCapabilities;
        const c = (caps && caps.accordion_config) || {};
        const rawBass = c.bass_system === 'chromatic' ? 'free' : c.bass_system;
        const bass_system = ['stradella', 'free'].includes(rawBass)
            ? rawBass : 'stradella';
        const right_display = ['buttons', 'keyboard'].includes(c.right_display)
            ? c.right_display : 'buttons';
        // Free-bass default span C2..C4 — kept in sync with ISMSections
        // _ACCORDION_BASS_DEFAULT and AccordionView FREE_BASS_LO/HI.
        const note = (v, dflt) => {
            const n = Number(v);
            return Number.isInteger(n) && n >= 0 && n <= 127 ? n : dflt;
        };
        const br = (c.bass_range && typeof c.bass_range === 'object') ? c.bass_range : {};
        let min = note(br.min, 36);
        let max = note(br.max, 60);
        if (min > max) { const t = min; min = max; max = t; }
        // Stradella geometry (left side). Canonical function order; an
        // empty/invalid selection falls back to the full 6-function board.
        const ALL_FUNCS = ['counterbass', 'bass', 'major', 'minor', 'dom7', 'dim7'];
        const ci = Number(c.bass_cols);
        const bass_cols = Number.isInteger(ci) && ci >= 1 && ci <= 20 ? ci : 12;
        const bass_base = note(c.bass_base, 36);
        let bass_funcs = Array.isArray(c.bass_funcs)
            ? ALL_FUNCS.filter((f) => c.bass_funcs.includes(f)) : [];
        if (bass_funcs.length === 0) bass_funcs = ALL_FUNCS.slice();
        return { bass_system, right_display, bass_range: { min, max },
            bass_cols, bass_base, bass_funcs };
    }

    /**
     * Instrument-specific harmonica settings (optional `caps.harmonica_config`).
     *   - `type`: 'diatonic' (Richter) | 'chromatic' (solo tuning + slide)
     *   - `key` : musical key root, one of the 12 pitch classes
     * Defaults preserve the previous behaviour (diatonic, C). The chromatic
     * flag lives ONLY here — `keyboard_type` is never set for a harmonica
     * (that would divert GM22 to the equal-width keyboard-list view).
     * @returns {{type:'diatonic'|'chromatic', key:string}}
     */
    getHarmonicaConfig() {
        const caps = this.selectedDeviceCapabilities;
        const c = (caps && caps.harmonica_config) || {};
        const type = c.type === 'chromatic' ? 'chromatic' : 'diatonic';
        const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const key = KEYS.includes(c.key) ? c.key : 'C';
        return { type, key };
    }

    /**
     * Detect whether the selected instrument should switch to a special view.
     * @returns {{ canFretboard: boolean, isDrum: boolean, instrumentType: string }}
     */
    getInstrumentViewInfo() {
        // Delegates to the pure InstrumentDetector module (Phase B).
        // Callers continue to receive the legacy { canFretboard, isBowed,
        // isDrum, isWind, windPreset, instrumentType, instrumentSubtype,
        // gmProgram } shape. `viewKind` is additionally exposed for the
        // upcoming InstrumentView registry (Phase C+).
        const detector = (typeof window !== 'undefined' && window.InstrumentDetector) || null;
        if (!detector) {
            // Defensive fallback — should never happen in production since
            // InstrumentDetector.js is loaded before KeyboardModal.js.
            return {
                viewKind: 'piano', canFretboard: false, isBowed: false,
                isDrum: false, isWind: false, windPreset: null,
                instrumentType: 'unknown', instrumentSubtype: '', gmProgram: undefined
            };
        }
        return detector.detect({
            capabilities: this.selectedDeviceCapabilities,
            selectedDevice: this.selectedDevice,
            stringInstrumentConfig: this.stringInstrumentConfig,
            windDb: typeof WindInstrumentDatabase !== 'undefined' ? WindInstrumentDatabase : null
        });
    }

    /**
     * Whether the currently selected instrument is a bowed-string family
     * (violin, viola, cello, contrabass, tremolo, pizzicato, fiddle).
     * Used by the fretboard renderer + chord bar to swap pluck/strum
     * controls for the continuous-bow controls.
     * @returns {boolean}
     */
    _isBowedInstrument() {
        if (typeof this.getInstrumentViewInfo !== 'function') return false;
        const info = this.getInstrumentViewInfo();
        return info && info.isBowed === true;
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
        // Harp (special: many strings, no frets). 47-string concert harp:
        // C-major diatonic from C1 (MIDI 24) up to G7 (MIDI 103). Matches
        // the "Harpe" preset (StringInstrumentPresets.js → num_strings: 47).
        if (gmProgram === 46) {
            const STEP = [2, 2, 1, 2, 2, 2, 1]; // C-major intervals
            const tuning = [];
            let n = 24;
            for (let i = 0; i < 47; i++) {
                tuning.push(n);
                n += STEP[i % 7];
            }
            return { num_strings: 47, num_frets: 0, tuning, is_fretless: true };
        }
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
     * Last-resort string set for the dedicated HarpView. A harp (GM 46) is
     * NOT a "string" instrument in the settings modal — it has no
     * strings/tuning tab; its playable notes come from the Notes section
     * (note range / discrete selection) which HarpView reads via
     * getInstrumentNoteRange(). This preset is only used when no range is
     * available at all. Kept off this.stringInstrumentConfig so the
     * InstrumentDetector escape hatch (a present stringCfg forces the
     * fretboard view for GM 46) stays untouched.
     * @returns {{tuning:number[], num_strings:number}|null}
     */
    _harpPresetStringConfig() {
        const caps = this.selectedDeviceCapabilities;
        const gmProgram = (caps && caps.gm_program) ?? (this.selectedDevice && this.selectedDevice.gm_program);
        const preset = this._getStringPresetForGmProgram(gmProgram);
        if (preset && Array.isArray(preset.tuning) && preset.tuning.length) {
            return { tuning: preset.tuning, num_strings: preset.num_strings };
        }
        return null;
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

        // Build off-DOM with a DocumentFragment so we attach ~138 nodes
        // in one paint, then swap children atomically.
        const frag = document.createDocumentFragment();

        // "No selection" entry — spans full grid width
        const noneBtn = document.createElement('button');
        noneBtn.type = 'button';
        noneBtn.className = 'instrument-option option-none' + (!this.selectedDevice ? ' selected' : '');
        noneBtn.dataset.deviceId = '';
        noneBtn.innerHTML = `
            <div class="option-icon"><span class="option-emoji">🎵</span></div>
            <span class="option-name">— ${this.t('common.select')} —</span>
        `;
        frag.appendChild(noneBtn);

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

            // `name` is a user-configurable device label → never interpolate
            // it into innerHTML. The icon markup and chLabel are built from
            // internal/numeric data only, so they stay as markup.
            btn.innerHTML = `<div class="option-icon">${imgHtml}</div><span class="option-name"></span>`;
            const nameSpan = btn.querySelector('.option-name');
            nameSpan.textContent = name;
            if (chLabel) nameSpan.insertAdjacentHTML('beforeend', chLabel);
            frag.appendChild(btn);
        });

        dropdown.replaceChildren(frag);

        // ── TEMP DIAGNOSTIC (dropdown render count) ───────────────────────
        try {
            const opts = dropdown.querySelectorAll('.instrument-option:not(.option-none)').length;
            const virt = this.devices.filter(d => d.isVirtual).length;
            const multi = this.devices.filter(d => d._multiInstrument).length;
            this.logger.info(
                `[DIAG dropdown] this.devices=${this.devices.length} `
                + `(virtual=${virt} multiInstrument=${multi}) `
                + `→ DOM option buttons=${opts}`);
        } catch (e) { /* diagnostic only */ }
        // ── END TEMP DIAGNOSTIC ───────────────────────────────────────────

        // Event delegation: a single listener on the container, instead of
        // one per button. Guard on the element itself (not an instance flag)
        // so each freshly created #instrument-dropdown gets its own listener;
        // a stale instance flag would skip rebinding after close()/mountAsPanel().
        if (!dropdown._instrumentClickBound) {
            dropdown.addEventListener('click', (e) => {
                const opt = e.target.closest('.instrument-option');
                if (!opt || !dropdown.contains(opt)) return;
                const rawValue = opt.dataset.deviceId ?? '';
                this._selectInstrumentOption(rawValue);
            });
            dropdown._instrumentClickBound = true;
        }
    }

    // Adapt the instrument dropdown to the number of instruments: widen it
    // (more columns, up to the screen edge) then grow its height to the
    // viewport so everything shows with as little scrolling as possible.
    // CSS `auto-fill` can't pick a column count proportional to a dynamic
    // item count without a definite width, so we compute it here on open
    // and clear the inline sizing on close (the dropdown is reused across
    // the standalone modal and the loop-editor panel mount).
    _sizeInstrumentDropdown(isOpen) {
        const dropdown = document.getElementById('instrument-dropdown');
        if (!dropdown) return;

        if (!isOpen) {
            dropdown.style.width = '';
            dropdown.style.maxHeight = '';
            dropdown.style.gridTemplateColumns = '';
            return;
        }

        const trigger = document.getElementById('instrument-trigger');
        const cell = dropdown.querySelector('.instrument-option:not(.option-none)');
        if (!trigger || !cell) return;

        const cs = getComputedStyle(dropdown);
        const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const gap = parseFloat(cs.rowGap || cs.gap) || 2;

        const itemW = cell.offsetWidth || 78;
        const rowH = cell.offsetHeight || 64;

        const noneEl = dropdown.querySelector('.option-none');
        let noneH = 0;
        if (noneEl) {
            const nb = parseFloat(getComputedStyle(noneEl).marginBottom) || 0;
            noneH = noneEl.offsetHeight + nb + gap;
        }

        const nData = dropdown.querySelectorAll('.instrument-option:not(.option-none)').length;
        if (nData === 0) {
            dropdown.style.width = '';
            dropdown.style.maxHeight = '';
            dropdown.style.gridTemplateColumns = '';
            return;
        }

        const rect = trigger.getBoundingClientRect();
        const panelMode = !!dropdown.closest('.modal-dialog.km-panel-mode');

        let availW = Math.min(window.innerWidth - 12, window.innerWidth - rect.left - 8);
        availW = Math.max(320, availW);
        const availH = Math.max(
            160,
            panelMode ? rect.top - 12 : window.innerHeight - rect.bottom - 12
        );

        const colsForW = (w) => Math.max(1, Math.floor((w - padX + gap) / (itemW + gap)));
        // Compact baseline = the column count that fills the 320px min-width
        // (≈ today's look); never go below it so the few-instrument case is
        // unchanged. Cap = how many columns fit out to the screen edge.
        const minCols = colsForW(320);
        const maxCols = Math.max(minCols, colsForW(availW));

        const heightFor = (cols) => {
            const rows = Math.ceil(nData / cols);
            return padY + noneH + rows * rowH + (rows - 1) * gap;
        };

        // Stay compact when everything already fits; otherwise widen just
        // enough to fit the viewport height. If even the widest grid can't
        // fit, use the widest one (scroll minimized "au max").
        let cols = maxCols;
        for (let c = minCols; c <= maxCols; c++) {
            if (heightFor(c) <= availH) { cols = c; break; }
        }

        const width = Math.min(
            availW,
            Math.max(320, cols * itemW + (cols - 1) * gap + padX)
        );

        dropdown.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        dropdown.style.width = `${Math.round(width)}px`;
        dropdown.style.maxHeight = `${Math.round(availH)}px`;
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
        this._sizeInstrumentDropdown(false);

        // Stop any held bow before swapping instruments — the new chord bar
        // about to be rendered won't reuse the previous button reference, and
        // the chord notes would otherwise keep ringing until the next mouseup.
        if (typeof this._stopActiveBow === 'function') this._stopActiveBow();

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
        // keyboard_type:'chromatic' instruments (xylophone, marimba, hangdrum …) use
        // the equal-width list view as their default so fingers align with uniform slots.
        const caps = this.selectedDeviceCapabilities;
        const handsKbType = caps && caps.hands_config && caps.hands_config.keyboard_type;
        const isChromatic = handsKbType === 'chromatic' || caps && caps.keyboard_type === 'chromatic';

        // Always reset wind controls before re-evaluating the new instrument
        if (typeof this._hideWindControls === 'function') this._hideWindControls();

        if (info.isDrum) {
            if (viewGroup) viewGroup.classList.remove('hidden');
            this.stringInstrumentConfig = null;
            this._harpStringConfig = null;
            this.setViewMode('drumpad');
        } else if (info.canFretboard) {
            await this.loadStringInstrumentConfig();
            this._harpStringConfig = null;
            if (viewGroup) viewGroup.classList.remove('hidden');
            this.setViewMode('fretboard');
        } else if (info.isWind) {
            this.stringInstrumentConfig = null;
            this._harpStringConfig = null;
            // Keep the view-mode toggle visible so the user can switch a
            // wind instrument to the standard piano (and back).
            if (viewGroup) viewGroup.classList.remove('hidden');
            // Show wind articulation panel and switch to piano-slider (chromatic keys)
            if (typeof this._showWindControls === 'function') {
                this._showWindControls(info.windPreset);
            }
            this.setViewMode('piano-slider');
            // Comfort zone is applied inside generatePianoSlider via _applyWindComfortZone
        } else if (isChromatic) {
            this.stringInstrumentConfig = null;
            this._harpStringConfig = null;
            if (viewGroup) viewGroup.classList.add('hidden');
            this.setViewMode('keyboard-list');
        } else if (info.viewKind === 'harp') {
            // Dedicated vertical-string HarpView. stringInstrumentConfig is
            // kept null so the InstrumentDetector escape hatch doesn't flip
            // a re-selected harp to the fretboard. HarpView derives its
            // strings from the configured note selection via
            // getInstrumentNoteRange(); _harpStringConfig is only the
            // last-resort 47-string preset when no range is available.
            this.stringInstrumentConfig = null;
            this._harpStringConfig = this._harpPresetStringConfig();
            if (viewGroup) viewGroup.classList.remove('hidden');
            this.setViewMode('harp');
        } else if (['harmonica', 'accordion', 'mallet', 'music-box',
                     'kalimba', 'bagpipe', 'steel-drum', 'perc-pad',
                     'theremin']
            .includes(info.viewKind)) {
            // Dedicated self-owned views. The view owns its DOM host; no
            // built-in container or string config involved. The view-mode
            // toggle group stays VISIBLE so the standard virtual piano is
            // always reachable for any specific instrument (the toggle
            // handler swaps this.viewMode ↔ 'piano' symmetrically).
            this.stringInstrumentConfig = null;
            this._harpStringConfig = null;
            if (viewGroup) viewGroup.classList.remove('hidden');
            this.setViewMode(info.viewKind);
        } else {
            this.stringInstrumentConfig = null;
            this._harpStringConfig = null;
            if (viewGroup) viewGroup.classList.add('hidden');
            this.setViewMode('piano');
        }

        this.regeneratePianoKeys();

        if (this._panelCallbacks?.onInstrumentSelected) {
            // Pass the detected instrument type alongside the raw routing
            // info so hosts (LoopEditor) don't have to re-derive isDrum /
            // isWind from `gmProgram` + `channel` — those two alone miss
            // drum kits whose device exposes a melodic gm_program on a
            // non-9 channel. `info` comes from `getInstrumentViewInfo()`
            // which already folds `caps.instrument_type === 'drum'` into
            // the flag. `viewMode === 'drumpad'` is the authoritative
            // tiebreaker — if we activated drum-pad UI just above, the
            // user is clearly playing drums even if caps doesn't agree.
            const finalIsDrum = info.isDrum === true || this.viewMode === 'drumpad';
            this._panelCallbacks.onInstrumentSelected({
                deviceId: this.selectedDevice?.device_id || this.selectedDevice?.id || null,
                channel: this.getSelectedChannel(),
                gmProgram: this.selectedDeviceCapabilities?.gm_program ?? 0,
                instrumentType: info.instrumentType || this.selectedDeviceCapabilities?.instrument_type || null,
                isDrum: finalIsDrum,
                isWind: info.isWind === true,
                viewMode: this.viewMode
            });
        }
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

    _subscribeLocale() {
        if (typeof i18n !== 'undefined') {
            this.localeUnsubscribe = i18n.onLocaleChange(() => {
                this.updateTranslations();
                this.populateDeviceSelect();
            });
        }
    }

    mountAsPanel(panelContainer, callbacks = {}) {
        if (this._panelMode) return;
        if (this.isOpen) this.close();

        this._panelCallbacks = callbacks;
        this._panelMode = true;

        this.loadSettings();
        this.createModal();
        this.isOpen = true;
        this.container.classList.add('km-panel-host'); // hide overlay shell — display:flex!important in CSS would override style.display

        const dialogEl = this.container.querySelector('.modal-dialog');
        if (dialogEl) {
            dialogEl.classList.add('km-panel-mode');
            panelContainer.appendChild(dialogEl);
            this._panelDialogEl = dialogEl;
        }

        this.loadDevices().then(() => this.populateDeviceSelect());
        this.attachEvents();
        this.updateSlidersVisibility();
        this._subscribeLocale();
    }

    unmountPanel() {
        if (!this._panelMode) return;

        if (this._panelDialogEl && this.container) {
            this._panelDialogEl.classList.remove('km-panel-mode');
            this.container.classList.remove('km-panel-host');
            this.container.appendChild(this._panelDialogEl);
            this._panelDialogEl = null;
        }

        this._panelMode = false;
        this._panelCallbacks = null;
        this.close(); // detachEvents, stop notes, removes this.container
    }
}

// ============================================================================
// MIXIN COMPOSITION (legacy — slated for replacement by InstrumentView
// classes per AUDIT_KEYBOARD_MODAL_2026-05-14.md KM-C1, KM-C4).
// ============================================================================
// The 7 mixins below are attached on KeyboardModal.prototype in a specific
// order: each later mixin can read methods from earlier ones. (KM-C4 done:
// the wind mixin no longer wraps `playNote` — articulation/staccato moved
// to PianoSliderView via the willPlayNote/afterPlayNote contract.)
//
// Until the InstrumentView migration is complete, _applyMixin() emits a
// warning whenever a mixin silently overrides a method already on the
// prototype — this catches accidental collisions early.
// ============================================================================

/**
 * Apply a mixin to KeyboardModal.prototype, warning on collisions.
 * @param {string} label    Mixin name (for diagnostics).
 * @param {Object} mixin    Object whose own properties become prototype methods.
 */
function _applyMixin(label, mixin) {
    if (!mixin) return;
    for (const key of Object.keys(mixin)) {
        if (Object.prototype.hasOwnProperty.call(KeyboardModal.prototype, key)) {
            // eslint-disable-next-line no-console
            console.warn(
                `[KeyboardModal] mixin "${label}" overrides existing method "${key}". ` +
                `Expected only for KeyboardWind._updatePianoSliderGroupVisibility ` +
                `(intentional, documented in KeyboardWind.js).`
            );
        }
        KeyboardModal.prototype[key] = mixin[key];
    }
}

if (typeof KeyboardPianoMixin     !== 'undefined') _applyMixin('Piano',     KeyboardPianoMixin);
if (typeof KeyboardEventsMixin    !== 'undefined') _applyMixin('Events',    KeyboardEventsMixin);
if (typeof KeyboardControlsMixin  !== 'undefined') _applyMixin('Controls',  KeyboardControlsMixin);
if (typeof KeyboardChordsMixin    !== 'undefined') _applyMixin('Chords',    KeyboardChordsMixin);
if (typeof KeyboardSliderMixin    !== 'undefined') _applyMixin('Slider',    KeyboardSliderMixin);
if (typeof KeyboardListViewMixin  !== 'undefined') _applyMixin('ListView',  KeyboardListViewMixin);
// KM-C4 done: KeyboardWindMixin no longer overrides playNote. Wind
// articulation + staccato now live in PianoSliderView via the
// willPlayNote / afterPlayNote contract, so the `_windOrigPlayNote`
// workaround is gone and the mixin applies like any other.
if (typeof KeyboardWindMixin      !== 'undefined') _applyMixin('Wind', KeyboardWindMixin);

// ─── Tracked DOM listeners (Phase E helper, KM-M3) ──────────────────────────
// Subsequent code can call `this._on(el, 'click', fn)` instead of
// `el.addEventListener('click', fn)` to get automatic cleanup in close().
// Existing call sites are not migrated yet — this is opt-in for new code.

KeyboardModal.prototype._on = function (el, evt, handler, opts) {
    if (!el || !evt || typeof handler !== 'function') return;
    el.addEventListener(evt, handler, opts);
    (this._trackedListeners ||= []).push([el, evt, handler, opts]);
};

KeyboardModal.prototype._offAll = function () {
    if (!this._trackedListeners) return;
    for (const [el, evt, h, o] of this._trackedListeners) {
        try { el.removeEventListener(evt, h, o); } catch (_) { /* ignore */ }
    }
    this._trackedListeners.length = 0;
};

// Expose the class on window so test runners + late-loading helpers can
// inspect prototype.
if (typeof window !== 'undefined') {
    window.KeyboardModal = KeyboardModal;
}
