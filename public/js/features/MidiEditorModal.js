// ============================================================================
// File: public/js/features/MidiEditorModal.js
// Built on the vendored webaudio-pianoroll (g200kg) element with project i18n
// Description: MIDI editor modal built on webaudio-pianoroll
// ============================================================================

class MidiEditorModal {
    constructor(eventBus, apiClient) {
        this.eventBus = eventBus;
        this.api = apiClient;
        this.logger = window.logger || console;

        this.container = null;
        this.isOpen = false;
        this.pianoRoll = null;

        // i18n support
        this.localeUnsubscribe = null;

        // State
        this.currentFile = null;  // fileId
        this.currentFilename = null;  // filename used for display
        this.midiData = null;
        this.isDirty = false;

        // Note sequence for webaudio-pianoroll
        this.sequence = [];
        this.fullSequence = []; // All notes (all channels)
        this.activeChannels = new Set(); // Active channels to display
        this.channels = []; // Information about available channels

        // Clipboard for copy/paste
        this.clipboard = [];

        // Current edit mode
        this.editMode = 'drag-view'; // 'select', 'drag-notes', 'drag-view', 'edit' - drag-view by default for navigation

        // Touch mode: shows separate Move/Add/Resize buttons instead of the unified pencil button
        this.touchMode = this._loadTouchModePref();

        // Playback feedback preferences
        this.keyboardPlaybackEnabled = this._loadKeyboardPlaybackPref();
        this.dragPlaybackEnabled = this._loadDragPlaybackPref();

        // Instrument selected for new channels (GM MIDI program)
        this.selectedInstrument = 0; // Piano by default

        // CC/Pitchbend/Velocity/Tempo Editor
        this.ccEditor = null;
        this.velocityEditor = null;
        this.tempoEditor = null;
        this.currentCCType = 'cc1'; // 'cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc76', 'cc77', 'cc78', 'cc91', 'pitchbend', 'velocity', 'tempo'
        this.ccEvents = []; // CC and pitchbend events
        this.tempoEvents = []; // Tempo events
        this.ccSectionExpanded = false; // Collapse state of the CC section

        // Connected instrument used for routing
        this.connectedDevices = []; // List of connected MIDI devices

        // Per-channel routing: Map<channel, deviceValue> (e.g. "deviceId" or "deviceId::channel")
        this.channelRouting = new Map();
        // Per-channel disabled state: Set<channel>
        this.channelDisabled = new Set();
        // Currently open channel settings popover channel (-1 = none)
        this._channelSettingsOpen = -1;
        // Per-channel playable notes highlights: Map<channel, Set<noteNumber>>
        this.channelPlayableHighlights = new Map();
        // Cache of routed instrument gm_program per channel: Map<channel, number>
        this._routedGmPrograms = new Map();
        // Preview source: 'gm' (original MIDI file instruments) or 'routed' (routed instrument gm_program)
        this.previewSource = 'gm';
        // Per-channel playable note sets for routed preview: Map<channel, Set<noteNumber>|null>
        this._routedPlayableNotes = new Map();
        // Global toggle: auto-show playable notes for all routed channels
        this.showPlayableNotes = false;

        // Channel panel (manages tablature buttons, device selector, instrument selector)
        this.channelPanel = typeof MidiEditorChannelPanel !== 'undefined' ? new MidiEditorChannelPanel(this) : null;

        // Confirmation dialogs sub-component (P2-F.10a — replaces mixin).
        // Instantiated before the mixin loop so the mixin forwarders find it.
        this.dialogs = typeof MidiEditorDialogs !== 'undefined' ? new MidiEditorDialogs(this) : null;

        // Draw settings popover sub-component (P2-F.10b).
        this.drawSettings = typeof MidiEditorDrawSettings !== 'undefined' ? new MidiEditorDrawSettings(this) : null;

        // CC picker sub-component (P2-F.10c). All 22 methods now live on
        // the class itself — callsites use `modal.ccPicker.<method>(...)`.
        // The mixin has been removed from the prototype.
        this.ccPicker = typeof MidiEditorCCPicker !== 'undefined' ? new MidiEditorCCPicker(this) : null;

        // Remaining 9 facades (P2-F.10-wire). Thin auto-generated facades
        // around the legacy mixins ; callsites migrate progressively from
        // `this.<method>()` to `this.<facade>.<method>()`. Property names
        // chosen to avoid collisions with existing state.
        this.sequenceOps  = typeof MidiEditorSequence        !== 'undefined' ? new MidiEditorSequence(this)        : null;
        this.ccOps        = typeof MidiEditorCC              !== 'undefined' ? new MidiEditorCC(this)              : null;
        this.fileOps      = typeof MidiEditorFileOps         !== 'undefined' ? new MidiEditorFileOps(this)         : null;
        this.renderer     = typeof MidiEditorRenderer        !== 'undefined' ? new MidiEditorRenderer(this)        : null;
        this.routingOps   = typeof MidiEditorRouting         !== 'undefined' ? new MidiEditorRouting(this)         : null;
        this.editActions  = typeof MidiEditorEditActions     !== 'undefined' ? new MidiEditorEditActions(this)     : null;
        this.events       = typeof MidiEditorEvents          !== 'undefined' ? new MidiEditorEvents(this)          : null;
        this.tablatureOps = typeof MidiEditorTablature !== 'undefined' ? new MidiEditorTablature(this) : null;
        this.lifecycle    = typeof MidiEditorLifecycle       !== 'undefined' ? new MidiEditorLifecycle(this)       : null;

        // Tablature editor (for string instruments)
        this.tablatureEditor = null;

        // Drum pattern editor (for percussion channels)
        this.drumPatternEditor = null;

        // Wind instrument editor (for brass/reed/pipe channels)
        this.windInstrumentEditor = null;

        // Playback (embedded synthesizer)
        this.synthesizer = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.playbackStartTick = 0;
        this.playbackEndTick = 0

        // Playback manager (delegate)
        this._playback = typeof MidiEditorPlayback !== 'undefined' ? new MidiEditorPlayback(this) : null;

        // Constants shared from MidiEditorConstants
        const constants = (typeof MidiEditorConstants !== 'undefined') ? MidiEditorConstants : {};
        this.snapValues = constants.snapValues || [
            { ticks: 120, label: '1/1' }, { ticks: 60, label: '1/2' },
            { ticks: 30, label: '1/4' }, { ticks: 15, label: '1/8' }, { ticks: 1, label: '1/16' }
        ];
        this.currentSnapIndex = constants.defaultSnapIndex !== undefined ? constants.defaultSnapIndex : 3;
        this.channelColors = constants.channelColors || [
            '#FF0066','#00FFFF','#FF00FF','#FFFF00','#00FF00','#FF6600','#9D00FF','#00FF99',
            '#FF0000','#00BFFF','#FFD700','#FF1493','#00FFAA','#FF4500','#7FFF00','#FF69B4'
        ];
        this.gmInstruments = constants.gmInstruments || [];
    }

    // ========================================================================
    // LIFECYCLE FORWARDERS (P2-F.10l)
    // ------------------------------------------------------------------------
    // Hot lifecycle methods (`log`, `close`, `showNotification`, …) remain
    // reachable directly on the modal instance to avoid migrating ~500 call
    // sites. Each forwarder delegates to `this.lifecycle` (MidiEditorLifecycle
    // sub-component) which now owns the implementation.
    // ========================================================================

    log(level, ...args) { return this.lifecycle && this.lifecycle.log(level, ...args); }
    close() { return this.lifecycle && this.lifecycle.close(); }
    doClose() { return this.lifecycle && this.lifecycle.doClose(); }
    showUnsavedChangesModal() { return this.lifecycle && this.lifecycle.showUnsavedChangesModal(); }
    setupBeforeUnloadHandler() { return this.lifecycle && this.lifecycle.setupBeforeUnloadHandler(); }
    removeBeforeUnloadHandler() { return this.lifecycle && this.lifecycle.removeBeforeUnloadHandler(); }
    showNotification(message, type) { return this.lifecycle && this.lifecycle.showNotification(message, type); }
    showError(message) { return this.lifecycle && this.lifecycle.showError(message); }
    showErrorModal(message, title) { return this.lifecycle && this.lifecycle.showErrorModal(message, title); }

    // ========================================================================
    // I18N SUPPORT
    // ========================================================================

    /**
     * Helper to translate a key
     * @param {string} key - Translation key
     * @param {Object} params - Interpolation parameters
     * @returns {string} - Translated text
     */
    t(key, params = {}) {
        return typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    }

    /**
     * Retrieve the translated name of a GM instrument
     * @param {number} index - Instrument index (0-127)
     * @returns {string} - Translated instrument name
     */
    getInstrumentName(index) {
        const translatedList = this.t('instruments.list');
        if (Array.isArray(translatedList) && translatedList[index]) {
            return translatedList[index];
        }
        return this.gmInstruments[index] || `Instrument ${index}`;
    }

    // ========================================================================
    // DISPLAY THE MODAL
    // ========================================================================

    /**
     * Display the MIDI editor modal
     * @param {string} fileId - File id in the database
     * @param {string} filename - File name (optional, used for display)
     */
    async show(fileId, filename = null) {
        if (this.isOpen) {
            this.log('warn', 'Modal already open');
            return;
        }

        this.currentFile = fileId;
        this.currentFilename = filename || fileId;
        this.isDirty = false;

        // Reset routing/disabled state from the previous file
        this.channelRouting.clear();
        this.channelDisabled.clear();
        this.channelPlayableHighlights.clear();

        try {
            // Load the MIDI file
            await this.loadMidiFile(fileId);

            // Afficher la modale
            this.routingOps.render();

            // Initialiser le piano roll
            await this.routingOps.initPianoRoll();

            // Scan for string instrument configs to reveal TAB buttons
            await this.tablatureOps._refreshStringInstrumentChannels();

            this.isOpen = true;

            // Listen for external routing changes (e.g. from the simple routing modal)
            if (this.eventBus) {
                this._onExternalRoutingChanged = (data) => {
                    if (data.fileId === this.currentFile && !this._isEmittingRouting) {
                        this.tablatureOps._loadSavedRoutings();
                    }
                };
                this.eventBus.on('routing:changed', this._onExternalRoutingChanged);
            }

            // Install the beforeunload handler to prevent closing with unsaved changes
            this.setupBeforeUnloadHandler();

            // Subscribe to locale changes
            if (typeof i18n !== 'undefined') {
                this.localeUnsubscribe = i18n.onLocaleChange(() => {
                    // Note: the piano roll is already rendered, we cannot easily re-translate
                    // but keep the subscription for consistency
                });
            }

            // Emit event
            if (this.eventBus) {
                this.eventBus.emit('midi_editor:opened', { fileId, filename: this.currentFilename });
            }

        } catch (error) {
            this.log('error', 'Failed to open MIDI editor:', error);
            this.showError(this.t('midiEditor.cannotOpen', { error: error.message }));
        }
    }

    /**
     * Load the MIDI file depuis le backend
     */
    async loadMidiFile(fileId) {
        try {
            this.log('info', `Loading MIDI file: ${this.currentFilename || fileId}`);

            // Use BackendAPIClient.readMidiFile
            const response = await this.api.readMidiFile(fileId);

            if (!response || !response.midiData) {
                throw new Error('No MIDI data received from server');
            }

            // Le backend renvoie un objet avec : { id, filename, midi: {...}, size, tracks, duration, tempo }
            // Extract the raw MIDI data
            const fileData = response.midiData;
            this.midiData = fileData.midi || fileData;

            // S'assurer qu'on a bien un objet header et tracks
            if (!this.midiData.header || !this.midiData.tracks) {
                throw new Error('Invalid MIDI data structure');
            }

            // Convertir en sequence pour webaudio-pianoroll
            this.sequenceOps.convertMidiToSequence();

            this.log('info', `MIDI file loaded: ${this.midiData.tracks?.length || 0} tracks, ${this.sequence.length} notes`);

        } catch (error) {
            this.log('error', 'Failed to load MIDI file:', error);

            // Si l'erreur est "Unknown command", proposer une alternative
            if (error.message.includes('Unknown command') || error.message.includes('file_read')) {
                throw new Error(this.t('midiEditor.backendNotSupported'));
            }

            throw error;
        }
    }

    // ========================================================================
    // PLAYBACK FACADE - delegates to MidiEditorPlayback
    // ========================================================================

    async initSynthesizer() { return this._playback ? this._playback.initSynthesizer() : false; }
    loadSequenceForPlayback() { if (this._playback) this._playback.loadSequenceForPlayback(); }
    syncMutedChannels() { if (this._playback) this._playback.syncMutedChannels(); }
    updatePlaybackRange() { if (this._playback) this._playback.updatePlaybackRange(); }
    getSequenceEndTick() { return this._playback ? this._playback.getSequenceEndTick() : 0; }
    async playbackPlay() { if (this._playback) await this._playback.playbackPlay(); }
    playbackPause() { if (this._playback) this._playback.playbackPause(); }
    playbackStop() { if (this._playback) this._playback.playbackStop(); }
    togglePlayback() { if (this._playback) this._playback.togglePlayback(); }
    updatePlaybackCursor(tick) { if (this._playback) this._playback.updatePlaybackCursor(tick); }
    onPlaybackComplete() { if (this._playback) this._playback.onPlaybackComplete(); }
    updatePlaybackButtons() { if (this._playback) this._playback.updatePlaybackButtons(); }
    handleNoteFeedback(prev) { if (this._playback) this._playback.handleNoteFeedback(prev); }
    async playNoteFeedback(n, v, c) { if (this._playback) await this._playback.playNoteFeedback(n, v, c); }
    disposeSynthesizer() { if (this._playback) this._playback.disposeSynthesizer(); }

} // end class MidiEditorModal

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorModal;
}

if (typeof window !== 'undefined') {
    window.MidiEditorModal = MidiEditorModal;

}

// ============================================================================
// Preferences (localStorage via maestro_settings)
// ============================================================================

MidiEditorModal.prototype._getPreference = function(key, defaultValue) {
    try {
        const saved = localStorage.getItem('maestro_settings');
        if (!saved) return defaultValue;
        const value = JSON.parse(saved)[key];
        return value === undefined ? defaultValue : value;
    } catch (e) {
        return defaultValue;
    }
};

MidiEditorModal.prototype._setPreference = function(key, value) {
    try {
        const saved = localStorage.getItem('maestro_settings');
        const settings = saved ? JSON.parse(saved) : {};
        settings[key] = value;
        localStorage.setItem('maestro_settings', JSON.stringify(settings));
    } catch (e) {}
};

MidiEditorModal.prototype._loadTouchModePref = function() {
    return this._getPreference('midiEditorTouchMode', false) === true;
};
MidiEditorModal.prototype._saveTouchModePref = function(value) {
    this._setPreference('midiEditorTouchMode', value);
};

MidiEditorModal.prototype._loadKeyboardPlaybackPref = function() {
    return this._getPreference('midiEditorKeyboardPlayback', true) === true;
};
MidiEditorModal.prototype._saveKeyboardPlaybackPref = function(value) {
    this._setPreference('midiEditorKeyboardPlayback', value);
};

MidiEditorModal.prototype._loadDragPlaybackPref = function() {
    return this._getPreference('midiEditorDragPlayback', true) === true;
};
MidiEditorModal.prototype._saveDragPlaybackPref = function(value) {
    this._setPreference('midiEditorDragPlayback', value);
};

// ============================================================================
// APPLY MIXINS - Methods extracted to separate files for maintainability
// ============================================================================

// Copy static-like properties to the class itself (for MidiEditorModal.CC_NAMES access)
// Sourced from MidiEditorCC class (P2-F.10h — mixin retired).
if (typeof MidiEditorCC !== 'undefined') {
    if (MidiEditorCC.CC_NAMES) MidiEditorModal.CC_NAMES = MidiEditorCC.CC_NAMES;
    if (MidiEditorCC.CC_CATEGORIES) MidiEditorModal.CC_CATEGORIES = MidiEditorCC.CC_CATEGORIES;
}

// ============================================================================
// All 12 MidiEditorModal mixins retired (P2-F.10a → P2-F.10l).
// Each method now lives on its dedicated sub-component class, instantiated
// in the constructor (this.dialogs / this.drawSettings / this.ccPicker /
// this.sequenceOps / this.ccOps / this.fileOps / this.renderer /
// this.routingOps / this.editActions / this.events / this.tablatureOps /
// this.lifecycle). Lifecycle hot methods (log, close, showNotification, …)
// are forwarded as modal instance methods to preserve call sites.
// ============================================================================

