// ============================================================================
// Fichier: public/js/views/components/MidiEditorModal.js
// Version: v2.1.0 - Utilise webaudio-pianoroll (g200kg) + i18n support
// Description: Modale d'édition MIDI avec piano roll webaudio-pianoroll
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

        // État
        this.currentFile = null;  // fileId
        this.currentFilename = null;  // nom du fichier pour affichage
        this.midiData = null;
        this.isDirty = false;

        // Sequence de notes pour webaudio-pianoroll
        this.sequence = [];
        this.fullSequence = []; // Toutes les notes (tous canaux)
        this.activeChannels = new Set(); // Canaux actifs à afficher
        this.channels = []; // Informations sur les canaux disponibles

        // Clipboard pour copy/paste
        this.clipboard = [];

        // Mode d'édition actuel
        this.editMode = 'drag-view'; // 'select', 'drag-notes', 'drag-view', 'edit' - drag-view par défaut pour navigation

        // Mode tactile : affiche les boutons séparés (déplacer, ajouter, agrandir) au lieu du bouton crayon unifié
        this.touchMode = this._loadTouchModePref();

        // Playback feedback preferences
        this.keyboardPlaybackEnabled = this._loadKeyboardPlaybackPref();
        this.dragPlaybackEnabled = this._loadDragPlaybackPref();

        // Instrument sélectionné pour les nouveaux canaux (program MIDI GM)
        this.selectedInstrument = 0; // Piano par défaut

        // CC/Pitchbend/Velocity/Tempo Editor
        this.ccEditor = null;
        this.velocityEditor = null;
        this.tempoEditor = null;
        this.currentCCType = 'cc1'; // 'cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc76', 'cc77', 'cc78', 'cc91', 'pitchbend', 'velocity', 'tempo'
        this.ccEvents = []; // Événements CC et pitchbend
        this.tempoEvents = []; // Événements de tempo
        this.ccSectionExpanded = false; // État du collapse de la section CC

        // Instrument connecté pour le routage
        this.connectedDevices = []; // Liste des appareils MIDI connectés

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

        // Tablature editor (for string instruments)
        this.tablatureEditor = null;

        // Drum pattern editor (for percussion channels)
        this.drumPatternEditor = null;

        // Wind instrument editor (for brass/reed/pipe channels)
        this.windInstrumentEditor = null;

        // Playback (synthétiseur intégré)
        this.synthesizer = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.playbackStartTick = 0;
        this.playbackEndTick = 0

        // Playback manager (delegate)
        this._playback = typeof MidiEditorPlayback !== 'undefined' ? new MidiEditorPlayback(this) : null;

        // Constantes partagees depuis MidiEditorConstants
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
    // I18N SUPPORT
    // ========================================================================

    /**
     * Helper pour traduire une clé
     * @param {string} key - Clé de traduction
     * @param {Object} params - Paramètres d'interpolation
     * @returns {string} - Texte traduit
     */
    t(key, params = {}) {
        return typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    }

    /**
     * Récupère le nom d'un instrument GM traduit
     * @param {number} index - Index de l'instrument (0-127)
     * @returns {string} - Nom de l'instrument traduit
     */
    getInstrumentName(index) {
        const translatedList = this.t('instruments.list');
        if (Array.isArray(translatedList) && translatedList[index]) {
            return translatedList[index];
        }
        return this.gmInstruments[index] || `Instrument ${index}`;
    }

    // ========================================================================
    // AFFICHAGE DE LA MODALE
    // ========================================================================

    /**
     * Afficher la modale d'édition MIDI
     * @param {string} fileId - ID du fichier dans la base de données
     * @param {string} filename - Nom du fichier (optionnel, pour l'affichage)
     */
    async show(fileId, filename = null) {
        if (this.isOpen) {
            this.log('warn', 'Modal already open');
            return;
        }

        this.currentFile = fileId;
        this.currentFilename = filename || fileId;
        this.isDirty = false;

        // Réinitialiser l'état de routage/désactivation du fichier précédent
        this.channelRouting.clear();
        this.channelDisabled.clear();
        this.channelPlayableHighlights.clear();

        try {
            // Charger le fichier MIDI
            await this.loadMidiFile(fileId);

            // Afficher la modale
            this.render();

            // Initialiser le piano roll
            await this.initPianoRoll();

            // Scan for string instrument configs to reveal TAB buttons
            await this._refreshStringInstrumentChannels();

            this.isOpen = true;

            // Listen for external routing changes (e.g. from the simple routing modal)
            if (this.eventBus) {
                this._onExternalRoutingChanged = (data) => {
                    if (data.fileId === this.currentFile && !this._isEmittingRouting) {
                        this._loadSavedRoutings();
                    }
                };
                this.eventBus.on('routing:changed', this._onExternalRoutingChanged);
            }

            // Installer le gestionnaire beforeunload pour empêcher la fermeture avec des modifications non sauvegardées
            this.setupBeforeUnloadHandler();

            // Subscribe to locale changes
            if (typeof i18n !== 'undefined') {
                this.localeUnsubscribe = i18n.onLocaleChange(() => {
                    // Note: le piano roll est déjà rendu, on ne peut pas facilement re-traduire
                    // mais on garde la souscription pour cohérence
                });
            }

            // Émettre événement
            if (this.eventBus) {
                this.eventBus.emit('midi_editor:opened', { fileId, filename: this.currentFilename });
            }

        } catch (error) {
            this.log('error', 'Failed to open MIDI editor:', error);
            this.showError(this.t('midiEditor.cannotOpen', { error: error.message }));
        }
    }

    /**
     * Charger le fichier MIDI depuis le backend
     */
    async loadMidiFile(fileId) {
        try {
            this.log('info', `Loading MIDI file: ${this.currentFilename || fileId}`);

            // Utiliser la nouvelle méthode readMidiFile du BackendAPIClient
            const response = await this.api.readMidiFile(fileId);

            if (!response || !response.midiData) {
                throw new Error('No MIDI data received from server');
            }

            // Le backend renvoie un objet avec : { id, filename, midi: {...}, size, tracks, duration, tempo }
            // Extraire les données MIDI proprement dites
            const fileData = response.midiData;
            this.midiData = fileData.midi || fileData;

            // S'assurer qu'on a bien un objet header et tracks
            if (!this.midiData.header || !this.midiData.tracks) {
                throw new Error('Invalid MIDI data structure');
            }

            // Convertir en sequence pour webaudio-pianoroll
            this.convertMidiToSequence();

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
if (typeof MidiEditorCCMixin !== 'undefined') {
    if (MidiEditorCCMixin.CC_NAMES) MidiEditorModal.CC_NAMES = MidiEditorCCMixin.CC_NAMES;
    if (MidiEditorCCMixin.CC_CATEGORIES) MidiEditorModal.CC_CATEGORIES = MidiEditorCCMixin.CC_CATEGORIES;
}

const _mixins = [
    typeof MidiEditorSequenceMixin !== 'undefined' ? MidiEditorSequenceMixin : null,
    typeof MidiEditorCCMixin !== 'undefined' ? MidiEditorCCMixin : null,
    typeof MidiEditorDrawSettingsMixin !== 'undefined' ? MidiEditorDrawSettingsMixin : null,
    typeof MidiEditorCCPickerMixin !== 'undefined' ? MidiEditorCCPickerMixin : null,
    typeof MidiEditorFileOpsMixin !== 'undefined' ? MidiEditorFileOpsMixin : null,
    typeof MidiEditorRendererMixin !== 'undefined' ? MidiEditorRendererMixin : null,
    typeof MidiEditorRoutingMixin !== 'undefined' ? MidiEditorRoutingMixin : null,
    typeof MidiEditorEditActionsMixin !== 'undefined' ? MidiEditorEditActionsMixin : null,
    typeof MidiEditorDialogsMixin !== 'undefined' ? MidiEditorDialogsMixin : null,
    typeof MidiEditorEventsMixin !== 'undefined' ? MidiEditorEventsMixin : null,
    typeof MidiEditorTablatureMixin !== 'undefined' ? MidiEditorTablatureMixin : null,
    typeof MidiEditorLifecycleMixin !== 'undefined' ? MidiEditorLifecycleMixin : null,
];

_mixins.forEach(mixin => {
    if (mixin) {
        Object.keys(mixin).forEach(key => {
            MidiEditorModal.prototype[key] = mixin[key];
        });
    }
});

