// ============================================================================
// File: public/js/features/MidiEditorModal.js
// Built on the vendored webaudio-pianoroll (g200kg) element with project i18n
// Description: MIDI editor modal built on webaudio-pianoroll
// ============================================================================

class MidiEditorModal {
    /**
     * @param {*} eventBus
     * @param {*} apiClient
     * @param {Object} [opts]
     * @param {boolean} [opts.loopMode=false]  Slim layout for the loop editor :
     *   no file/save header, no instrument/channel/GM selectors, no gear popover,
     *   mono-channel CC section, inline touch-mode toggle. The host (e.g.
     *   LoopEditorModal) drives transport/save/instrument from its own shell.
     * @param {HTMLElement} [opts.host]  When provided, render() injects the
     *   editor body into this element instead of appending a modal-overlay
     *   to document.body. Required for panel embedding (mountAsPanel).
     */
    constructor(eventBus, apiClient, opts = {}) {
        this.eventBus = eventBus;
        this.api = apiClient;
        this.logger = window.logger || console;

        // Panel/loop integration flags
        this.loopMode = opts.loopMode === true;
        this.panelHost = opts.host || null;

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
        // Cache of routed instrument per-instrument custom SF2 id per channel:
        // Map<channel, number> (absent/null = use the global sound bank).
        this._routedSf2Ids = new Map();
        // Preview source: 'gm' (original MIDI file instruments) or 'routed' (routed instrument gm_program)
        this.previewSource = 'gm';
        // Per-channel playable note sets for routed preview: Map<channel, Set<noteNumber>|null>
        this._routedPlayableNotes = new Map();
        // Global toggle: auto-show playable notes for all routed channels
        this.showPlayableNotes = false;

        // Channel panel (manages tablature buttons, device selector, instrument selector)
        this.channelPanel = typeof MidiEditorChannelPanel !== 'undefined' ? new MidiEditorChannelPanel(this) : null;

        // Channel state read facade (audit §4.2). State stays on `this.X`
        // for now; consumers can read via `this.channelState.X(...)` and
        // we'll route writes through it incrementally.
        this.channelState = typeof MidiEditorChannelState !== 'undefined' ? new MidiEditorChannelState(this) : null;

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
        this.infoModal    = typeof MidiEditorInfoModal       !== 'undefined' ? new MidiEditorInfoModal(this)       : null;

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

            // Show the modal
            this.routingOps.render();

            // Initialize the piano roll
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
     * Open the editor as a panel inside a host element, with an in-memory
     * loop sequence instead of a file fetched from the backend. The caller
     * (LoopEditorModal) owns persistence, transport, and the instrument
     * selector ; we render the slim "loop mode" UI and notify on changes.
     *
     * @param {HTMLElement} host                Container to render the panel into.
     * @param {Object}      opts
     * @param {Array}       [opts.sequence]            Initial notes {t,g,n,c,v}.
     * @param {Array}       [opts.ccEvents]            Initial CC/PB/AT events.
     * @param {number}      [opts.tempo=120]           Initial tempo BPM.
     * @param {number}      [opts.ppq=480]             Ticks per beat.
     * @param {number}      [opts.bars=2]              Loop length in bars (informational).
     * @param {number}      [opts.timeSigNum=4]
     * @param {number}      [opts.timeSigDen=4]
     * @param {number}      [opts.channel=0]           MIDI channel (9 for drum kit).
     * @param {number}      [opts.instrumentProgram=0] GM program for that channel.
     * @param {Function}    [opts.onChange]            Notified after each edit
     *                                                 ({ sequence, ccEvents, isDirty }).
     */
    async showAsPanel(host, opts = {}) {
        if (this.isOpen) {
            this.log('warn', 'Editor panel already open');
            return;
        }
        this.loopMode = true;
        this.panelHost = host;

        const tempo = Number.isFinite(opts.tempo) ? opts.tempo : 120;
        const ppq   = Number.isFinite(opts.ppq)   ? opts.ppq   : 480;
        const ch    = Number.isFinite(opts.channel) ? opts.channel : 0;
        const prog  = Number.isFinite(opts.instrumentProgram) ? opts.instrumentProgram : 0;
        const program = prog >= 128 ? prog - 128 : prog; // drum kit offset

        // Synthesize the minimal midiData shape the rest of the editor reads.
        // No tracks — the sequence is injected directly into fullSequence below.
        this.currentFile = null;
        this.currentFilename = opts.name || '';
        this.tempo = tempo;
        this.ticksPerBeat = ppq;
        this.loopBars = Number.isFinite(opts.bars) ? opts.bars : 2;
        this.midiData = {
            header: { ticksPerBeat: ppq, timeSignature: [opts.timeSigNum || 4, opts.timeSigDen || 4] },
            tracks: [],
            maxTick: ppq * (opts.timeSigNum || 4) * (opts.bars || 2)
        };

        // Sequence injected as-is (already in webaudio-pianoroll format).
        this.fullSequence = Array.isArray(opts.sequence) ? opts.sequence.map(n => ({ ...n, c: ch })) : [];
        this.sequence = [...this.fullSequence];
        this.channels = [{
            channel: ch,
            program: program,
            instrument: ch === 9 ? this.t('midiEditor.drumKit') : this.getInstrumentName(program),
            noteCount: this.fullSequence.length,
            hasExplicitProgram: true
        }];
        this.activeChannels.clear();
        this.activeChannels.add(ch);
        this.channelDisabled.clear();
        this.channelPlayableHighlights.clear();

        // CC + tempo events from caller (optional).
        this.ccEvents = Array.isArray(opts.ccEvents) ? [...opts.ccEvents] : [];
        this.tempoEvents = [];

        this._panelOnChange = typeof opts.onChange === 'function' ? opts.onChange : null;
        this.isDirty = false;

        try {
            // Render the slim loop-mode UI into the host.
            this.routingOps.render();
            await this.routingOps.initPianoRoll();
            this.isOpen = true;

            // Rebuild dynamic CC buttons from the injected events.
            this.ccOps?.updateDynamicCCButtons?.();

            // Render the specialized-mode toolbar buttons (DRUM / TAB /
            // WIND) for the initial instrument. Async because the TAB
            // check queries the backend for a string-instrument config.
            this.routingOps._updateLoopSpecializedModeButtons?.();

            // Hook the change pipeline so saves can read back the latest state.
            if (this._panelOnChange) {
                const notify = () => {
                    try {
                        this._panelOnChange({
                            sequence: this.fullSequence,
                            ccEvents: this.ccEvents,
                            isDirty: this.isDirty
                        });
                    } catch (err) { this.log('error', 'panel onChange threw:', err); }
                };
                this._panelChangeListener = notify;
                this.pianoRoll?.addEventListener('change', notify);
            }
        } catch (error) {
            this.log('error', 'Failed to open MIDI editor as panel:', error);
            this.showError(this.t('midiEditor.cannotOpen', { error: error.message }));
        }
    }

    /**
     * Update the current loop sequence from the outside (e.g. when the
     * LoopEditorModal records new notes through its keyboard or changes
     * tempo/bars). Triggers a piano-roll redraw.
     */
    setPanelLoopState({ sequence, tempo, ppq, bars, timeSigNum, timeSigDen, instrumentProgram, channel } = {}) {
        if (!this.loopMode) return;
        if (Number.isFinite(tempo) && this.pianoRoll) {
            this.tempo = tempo;
            this.pianoRoll.tempo = tempo;
        }
        if (Number.isFinite(ppq) && this.pianoRoll) {
            this.ticksPerBeat = ppq;
            this.pianoRoll.timebase = ppq;
        }
        if (this.midiData) {
            if (Number.isFinite(timeSigNum) || Number.isFinite(timeSigDen)) {
                this.midiData.header.timeSignature = [
                    Number.isFinite(timeSigNum) ? timeSigNum : (this.midiData.header.timeSignature?.[0] || 4),
                    Number.isFinite(timeSigDen) ? timeSigDen : (this.midiData.header.timeSignature?.[1] || 4)
                ];
            }
            if (Number.isFinite(bars) || Number.isFinite(timeSigNum) || Number.isFinite(timeSigDen)) {
                const [num] = this.midiData.header.timeSignature || [4];
                const effBars = Number.isFinite(bars) ? bars : ((this.midiData.maxTick || 0) / ((this.ticksPerBeat || 480) * num)) || 2;
                this.loopBars = effBars;
                this.midiData.maxTick = (this.ticksPerBeat || 480) * num * effBars;
                // CanvasPianoRollRenderer ignores element attributes — push
                // the new loop boundary + view range through its API so the
                // end indicator follows bars / time-signature / tempo edits.
                this.pianoRollRenderer?.setMarkers?.(0, this.midiData.maxTick);
                this.pianoRollRenderer?.setXRange?.(this.midiData.maxTick);
                this.pianoRollRenderer?.setXOffset?.(0);
                if (this.pianoRoll) {
                    this.pianoRoll.setAttribute('markend', String(this.midiData.maxTick));
                    // Keep the horizontal zoom locked to the loop length so
                    // the whole loop stays visible after a tempo / bars /
                    // time-sig change. The user can still wheel-zoom in.
                    this.pianoRoll.setAttribute('xrange',  String(this.midiData.maxTick));
                    this.pianoRoll.setAttribute('xoffset', '0');
                    this.pianoRoll.redraw?.();
                }
            }
        }
        if (Number.isFinite(channel) && this.channels[0]) {
            this.channels[0].channel = channel;
            this.activeChannels.clear();
            this.activeChannels.add(channel);
        }
        if (Number.isFinite(instrumentProgram) && this.channels[0]) {
            const prog = instrumentProgram >= 128 ? instrumentProgram - 128 : instrumentProgram;
            this.channels[0].program = prog;
            this.channels[0].instrument = (this.channels[0].channel === 9)
                ? this.t('midiEditor.drumKit') : this.getInstrumentName(prog);
            // Refresh the DRUM / TAB / WIND toolbar — the active mode
            // depends on the GM program range.
            this.routingOps?._updateLoopSpecializedModeButtons?.();
        }
        if (Array.isArray(sequence)) {
            const ch = this.channels[0]?.channel ?? 0;
            this.fullSequence = sequence.map(n => ({ ...n, c: ch }));
            this.sequence = [...this.fullSequence];
            if (this.pianoRoll) {
                this.pianoRoll.sequence = this.sequence;
                this.pianoRoll.redraw?.();
            }
        }
    }

    /**
     * Unmount the editor panel from its host without the unsaved-changes
     * prompt — the host owns persistence and should already have decided
     * whether to discard or save before calling.
     */
    unmountPanel() {
        if (!this.loopMode) {
            this.log('warn', 'unmountPanel called outside loop mode — ignoring');
            return;
        }
        try {
            if (this._panelChangeListener && this.pianoRoll) {
                this.pianoRoll.removeEventListener('change', this._panelChangeListener);
            }
        } catch (_) { /* listener already gone */ }
        this._panelChangeListener = null;
        this._panelOnChange = null;
        // Bypass the dirty prompt by clearing isDirty first.
        this.isDirty = false;
        this.lifecycle?.doClose?.();
        this.panelHost = null;
    }

    /**
     * Read back the current loop state (notes + CC + tempo) so the host
     * modal (LoopEditorModal) can persist it.
     */
    getPanelLoopState() {
        return {
            sequence: this.fullSequence ? this.fullSequence.map(n => ({ ...n })) : [],
            ccEvents: this.ccEvents ? this.ccEvents.map(ev => ({ ...ev })) : [],
            tempo: this.tempo,
            ppq: this.ticksPerBeat
        };
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

            // The backend returns an object with: { id, filename, midi: {...}, size, tracks, duration, tempo }
            // Extract the raw MIDI data
            const fileData = response.midiData;
            this.midiData = fileData.midi || fileData;

            // S'assurer qu'on a bien un objet header et tracks
            if (!this.midiData.header || !this.midiData.tracks) {
                throw new Error('Invalid MIDI data structure');
            }

            // Convert to sequence for webaudio-pianoroll
            this.sequenceOps.convertMidiToSequence();

            this.log('info', `MIDI file loaded: ${this.midiData.tracks?.length || 0} tracks, ${this.sequence.length} notes`);

        } catch (error) {
            this.log('error', 'Failed to load MIDI file:', error);

            // Only surface the "backend not supported" notice when the
            // server actually responded with ERR_NOT_FOUND for this command
            // (see CommandRegistry: NotFoundError → {code:'ERR_NOT_FOUND',
            // command}). The previous substring check on error.message
            // ('file_read' / 'Unknown command') also matched timeouts
            // ('Command timeout: file_read') and transport failures, hiding
            // the real cause behind a misleading i18n message.
            if (error.code === 'ERR_NOT_FOUND' && error.command === 'file_read') {
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
    async playNoteHold(n, v, c) { if (this._playback) await this._playback.playNoteHold(n, v, c); }
    releaseNote(n, c) { if (this._playback) this._playback.releaseNote(n, c); }
    releaseAllNotes() { if (this._playback) this._playback.releaseAllNotes(); }
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
// Preferences (localStorage via gmboop_settings)
// ============================================================================

MidiEditorModal.prototype._getPreference = function(key, defaultValue) {
    try {
        const saved = localStorage.getItem('gmboop_settings');
        if (!saved) return defaultValue;
        const value = JSON.parse(saved)[key];
        return value === undefined ? defaultValue : value;
    } catch (e) {
        return defaultValue;
    }
};

MidiEditorModal.prototype._setPreference = function(key, value) {
    try {
        const saved = localStorage.getItem('gmboop_settings');
        const settings = saved ? JSON.parse(saved) : {};
        settings[key] = value;
        localStorage.setItem('gmboop_settings', JSON.stringify(settings));
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

// Toggle delegates → editActions sub-feature. The settings popover and
// inline toolbar buttons in MidiEditorEvents.attachEvents() wire their
// click handlers as `this.modal.toggleXxx()` — without these delegates,
// the modal exposes no method and the click is a TypeError.
MidiEditorModal.prototype.toggleTouchMode = function() {
    return this.editActions?.toggleTouchMode();
};
MidiEditorModal.prototype.toggleKeyboardPlayback = function() {
    return this.editActions?.toggleKeyboardPlayback();
};
MidiEditorModal.prototype.toggleDragPlayback = function() {
    return this.editActions?.toggleDragPlayback();
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

