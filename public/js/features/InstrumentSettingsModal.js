/**
 * InstrumentSettingsModal
 * Modal XL avec sidebar pour gérer les réglages d'un instrument MIDI.
 *
 * Mixins:
 *  - ISMSections (_renderAllSections, _renderIdentitySection, _renderNotesSection,
 *                 _renderStringsSection, _renderDrumsSection, _renderAdvancedSection)
 *  - ISMNavigation (_switchSection, _switchTab, _refreshContent, _addTab, _deleteTab)
 *  - ISMSave (_save, _loadChannelData)
 *  - ISMListeners (_attachListeners, _refreshDrumUI, _updateDrumCategoryBadge,
 *                  _updateDrumSummary, _attachStringsSectionListeners, _initNeckDiagram)
 */
class InstrumentSettingsModal extends BaseModal {

    static CHANNEL_COLORS = [
        '#3b82f6','#ef4444','#10b981','#f59e0b',
        '#8b5cf6','#ec4899','#06b6d4','#84cc16',
        '#f97316','#6366f1','#14b8a6','#e11d48',
        '#a855f7','#0ea5e9','#22c55e','#eab308'
    ];

    static DRUM_CATEGORIES = {
        kicks:      { notes: [35, 36], icon: '🥁', name: 'Kicks' },
        snares:     { notes: [37, 38, 40], icon: '🪘', name: 'Snares' },
        hiHats:     { notes: [42, 44, 46], icon: '🎩', name: 'Hi-Hats' },
        toms:       { notes: [41, 43, 45, 47, 48, 50], icon: '🥁', name: 'Toms' },
        crashes:    { notes: [49, 52, 55, 57], icon: '💥', name: 'Crashes' },
        rides:      { notes: [51, 53, 59], icon: '🔔', name: 'Rides' },
        latin:      { notes: [60, 61, 62, 63, 64, 65, 66, 67, 68], icon: '🪇', name: 'Latin' },
        shakers:    { notes: [39, 54, 58, 69, 70], icon: '🫧', name: 'Shakers' },
        woodsMetal: { notes: [56, 75, 76, 77], icon: '🪵', name: 'Bois & Métal' },
        pitched:    { notes: [71, 72, 73, 74], icon: '🎶', name: 'Effets mélodiques' },
        cuicas:     { notes: [78, 79], icon: '🪘', name: 'Cuicas' },
        triangles:  { notes: [80, 81], icon: '🔺', name: 'Triangles' }
    };

    static DRUM_NOTE_NAMES = {
        35:'Ac. Bass Drum',36:'Bass Drum 1',37:'Side Stick',38:'Ac. Snare',39:'Hand Clap',
        40:'Electric Snare',41:'Low Floor Tom',42:'Closed Hi-Hat',43:'High Floor Tom',
        44:'Pedal Hi-Hat',45:'Low Tom',46:'Open Hi-Hat',47:'Low-Mid Tom',48:'Hi-Mid Tom',
        49:'Crash Cymbal 1',50:'High Tom',51:'Ride Cymbal 1',52:'Chinese Cymbal',
        53:'Ride Bell',54:'Tambourine',55:'Splash Cymbal',56:'Cowbell',57:'Crash Cymbal 2',
        58:'Vibraslap',59:'Ride Cymbal 2',60:'Hi Bongo',61:'Low Bongo',62:'Mute Hi Conga',
        63:'Open Hi Conga',64:'Low Conga',65:'High Timbale',66:'Low Timbale',67:'High Agogô',
        68:'Low Agogô',69:'Cabasa',70:'Maracas',71:'Short Whistle',72:'Long Whistle',
        73:'Short Güiro',74:'Long Güiro',75:'Claves',76:'Hi Wood Block',77:'Low Wood Block',
        78:'Mute Cuíca',79:'Open Cuíca',80:'Mute Triangle',81:'Open Triangle'
    };

    static DRUM_PRIORITIES = {
        36:100,35:100,38:100,40:100,42:90,49:70,46:60,
        41:50,43:50,45:50,47:50,48:50,50:50,51:40,53:40,59:40
    };

    static DRUM_PRESETS = {
        gm_standard:  { name: 'GM Standard', notes: Array.from({length:47}, (_,i) => i+35) },
        gm_reduced:   { name: 'Kit Essentiel', notes: [35,36,38,40,42,44,46,41,43,45,47,48,49,50,51] },
        rock:         { name: 'Rock', notes: [35,36,38,40,42,46,41,43,45,48,49,51,55,57] },
        jazz:         { name: 'Jazz', notes: [35,38,42,44,46,41,43,45,49,51,53,59,55] },
        electronic:   { name: 'Électronique', notes: [36,38,40,42,46,41,45,48,49,51,39,54,56] },
        latin:        { name: 'Latin', notes: [35,38,42,46,60,61,62,63,64,65,66,67,68,75,76] }
    };

    static SECTIONS = [
        { id: 'identity', icon: '🎵', labelKey: 'instrumentSettings.sectionIdentity', fallback: 'Identité' },
        { id: 'notes',    icon: '🎹', labelKey: 'instrumentSettings.sectionNotes',    fallback: 'Notes & Capacités' },
        { id: 'advanced', icon: '⚙️', labelKey: 'instrumentSettings.sectionAdvanced', fallback: 'Avancé' }
    ];

    static CC_GROUPS = {
        performance: {
            label: 'Performance', icon: '🎹',
            ccs: {
                1:  { name: 'Modulation Wheel', desc: 'Vibrato, trémolo ou effet modulant', range: '0-127' },
                2:  { name: 'Breath Controller', desc: 'Contrôle par souffle (instruments à vent)', range: '0-127' },
                4:  { name: 'Foot Controller', desc: 'Pédale d\'expression au pied', range: '0-127' },
                5:  { name: 'Portamento Time', desc: 'Vitesse du glissando entre notes', range: '0-127' },
                11: { name: 'Expression', desc: 'Volume expressif (sous-volume du CC7)', range: '0-127' },
                64: { name: 'Sustain Pedal', desc: 'Pédale de maintien (on/off)', range: '0=off, 64+=on' },
                65: { name: 'Portamento On/Off', desc: 'Active le glissando entre notes', range: '0=off, 64+=on' },
                66: { name: 'Sostenuto', desc: 'Maintient les notes déjà enfoncées', range: '0=off, 64+=on' },
                67: { name: 'Soft Pedal', desc: 'Pédale douce (réduit le volume/timbre)', range: '0=off, 64+=on' },
                68: { name: 'Legato Footswitch', desc: 'Mode legato entre notes successives', range: '0=off, 64+=on' },
                69: { name: 'Hold 2', desc: 'Prolonge la résonance des notes', range: '0=off, 64+=on' },
                84: { name: 'Portamento Control', desc: 'Note source du portamento', range: '0-127 (note)' }
            }
        },
        volume: {
            label: 'Volume & Pan', icon: '🔊',
            ccs: {
                7:  { name: 'Volume', desc: 'Volume principal du canal', range: '0-127' },
                8:  { name: 'Balance', desc: 'Balance stéréo gauche/droite', range: '0=L, 64=C, 127=R' },
                10: { name: 'Pan', desc: 'Panoramique stéréo', range: '0=L, 64=C, 127=R' }
            }
        },
        sound: {
            label: 'Son / Timbre', icon: '🎛️',
            ccs: {
                70: { name: 'Sound Variation', desc: 'Variation timbrale du son', range: '0-127' },
                71: { name: 'Resonance', desc: 'Résonance du filtre (Q)', range: '0-127' },
                72: { name: 'Release Time', desc: 'Temps de relâchement de l\'enveloppe', range: '0-127' },
                73: { name: 'Attack Time', desc: 'Temps d\'attaque de l\'enveloppe', range: '0-127' },
                74: { name: 'Brightness (Cutoff)', desc: 'Fréquence de coupure du filtre', range: '0-127' },
                75: { name: 'Decay Time', desc: 'Temps de déclin de l\'enveloppe', range: '0-127' },
                76: { name: 'Vibrato Rate', desc: 'Vitesse du vibrato', range: '0-127' },
                77: { name: 'Vibrato Depth', desc: 'Profondeur du vibrato', range: '0-127' },
                78: { name: 'Vibrato Delay', desc: 'Délai avant début du vibrato', range: '0-127' },
                79: { name: 'Sound Controller 10', desc: 'Contrôle de son générique', range: '0-127' }
            }
        },
        effects: {
            label: 'Effets', icon: '✨',
            ccs: {
                12: { name: 'Effect Control 1', desc: 'Contrôle de l\'effet 1 (paramètre)', range: '0-127' },
                13: { name: 'Effect Control 2', desc: 'Contrôle de l\'effet 2 (paramètre)', range: '0-127' },
                91: { name: 'Reverb Depth', desc: 'Profondeur de réverbération', range: '0-127' },
                92: { name: 'Tremolo Depth', desc: 'Profondeur du trémolo', range: '0-127' },
                93: { name: 'Chorus Depth', desc: 'Profondeur du chorus', range: '0-127' },
                94: { name: 'Detune Depth', desc: 'Profondeur du détunage', range: '0-127' },
                95: { name: 'Phaser Depth', desc: 'Profondeur du phaser', range: '0-127' }
            }
        },
        dataBank: {
            label: 'Data / Bank', icon: '💾',
            ccs: {
                0:  { name: 'Bank Select MSB', desc: 'Sélection de banque (octet haut)', range: '0-127' },
                6:  { name: 'Data Entry MSB', desc: 'Valeur de donnée RPN/NRPN (haut)', range: '0-127' },
                32: { name: 'Bank Select LSB', desc: 'Sélection de banque (octet bas)', range: '0-127' },
                38: { name: 'Data Entry LSB', desc: 'Valeur de donnée RPN/NRPN (bas)', range: '0-127' },
                96: { name: 'Data Increment', desc: 'Incrémente la valeur RPN/NRPN', range: 'N/A' },
                97: { name: 'Data Decrement', desc: 'Décrémente la valeur RPN/NRPN', range: 'N/A' },
                98: { name: 'NRPN LSB', desc: 'Paramètre non-enregistré (octet bas)', range: '0-127' },
                99: { name: 'NRPN MSB', desc: 'Paramètre non-enregistré (octet haut)', range: '0-127' },
                100: { name: 'RPN LSB', desc: 'Paramètre enregistré (octet bas)', range: '0-127' },
                101: { name: 'RPN MSB', desc: 'Paramètre enregistré (octet haut)', range: '0-127' }
            }
        },
        robotics: {
            label: 'Robotique (libres)', icon: '🤖',
            ccs: {
                3:  { name: 'CC 3', desc: 'Non défini — usage libre', range: '0-127' },
                9:  { name: 'CC 9', desc: 'Non défini — usage libre', range: '0-127' },
                14: { name: 'CC 14', desc: 'Non défini — usage libre', range: '0-127' },
                15: { name: 'CC 15', desc: 'Non défini — usage libre', range: '0-127' },
                16: { name: 'General Purpose 1', desc: 'Usage libre (GP1)', range: '0-127' },
                17: { name: 'General Purpose 2', desc: 'Usage libre (GP2)', range: '0-127' },
                18: { name: 'General Purpose 3', desc: 'Usage libre (GP3)', range: '0-127' },
                19: { name: 'General Purpose 4', desc: 'Usage libre (GP4)', range: '0-127' },
                20: { name: 'CC 20 (String Select)', desc: 'Sélection de corde (robotique)', range: '0-127' },
                21: { name: 'CC 21 (Fret Select)', desc: 'Sélection de frette (robotique)', range: '0-127' },
                22: { name: 'CC 22', desc: 'Non défini — usage libre', range: '0-127' },
                23: { name: 'CC 23', desc: 'Non défini — usage libre', range: '0-127' },
                24: { name: 'CC 24', desc: 'Non défini — usage libre', range: '0-127' },
                25: { name: 'CC 25', desc: 'Non défini — usage libre', range: '0-127' },
                26: { name: 'CC 26', desc: 'Non défini — usage libre', range: '0-127' },
                27: { name: 'CC 27', desc: 'Non défini — usage libre', range: '0-127' },
                28: { name: 'CC 28', desc: 'Non défini — usage libre', range: '0-127' },
                29: { name: 'CC 29', desc: 'Non défini — usage libre', range: '0-127' },
                30: { name: 'CC 30', desc: 'Non défini — usage libre', range: '0-127' },
                31: { name: 'CC 31', desc: 'Non défini — usage libre', range: '0-127' },
                80: { name: 'General Purpose 5', desc: 'Usage libre (GP5, on/off)', range: '0=off, 64+=on' },
                81: { name: 'General Purpose 6', desc: 'Usage libre (GP6, on/off)', range: '0=off, 64+=on' },
                82: { name: 'General Purpose 7', desc: 'Usage libre (GP7, on/off)', range: '0=off, 64+=on' },
                83: { name: 'General Purpose 8', desc: 'Usage libre (GP8, on/off)', range: '0=off, 64+=on' },
                85: { name: 'CC 85', desc: 'Non défini — usage libre', range: '0-127' },
                86: { name: 'CC 86', desc: 'Non défini — usage libre', range: '0-127' },
                87: { name: 'CC 87', desc: 'Non défini — usage libre', range: '0-127' },
                88: { name: 'CC 88', desc: 'Non défini — usage libre', range: '0-127' },
                89: { name: 'CC 89', desc: 'Non défini — usage libre', range: '0-127' },
                90: { name: 'CC 90', desc: 'Non défini — usage libre', range: '0-127' },
                102: { name: 'CC 102', desc: 'Non défini — usage libre', range: '0-127' },
                103: { name: 'CC 103', desc: 'Non défini — usage libre', range: '0-127' },
                104: { name: 'CC 104', desc: 'Non défini — usage libre', range: '0-127' },
                105: { name: 'CC 105', desc: 'Non défini — usage libre', range: '0-127' },
                106: { name: 'CC 106', desc: 'Non défini — usage libre', range: '0-127' },
                107: { name: 'CC 107', desc: 'Non défini — usage libre', range: '0-127' },
                108: { name: 'CC 108', desc: 'Non défini — usage libre', range: '0-127' },
                109: { name: 'CC 109', desc: 'Non défini — usage libre', range: '0-127' },
                110: { name: 'CC 110', desc: 'Non défini — usage libre', range: '0-127' },
                111: { name: 'CC 111', desc: 'Non défini — usage libre', range: '0-127' },
                112: { name: 'CC 112', desc: 'Non défini — usage libre', range: '0-127' },
                113: { name: 'CC 113', desc: 'Non défini — usage libre', range: '0-127' },
                114: { name: 'CC 114', desc: 'Non défini — usage libre', range: '0-127' },
                115: { name: 'CC 115', desc: 'Non défini — usage libre', range: '0-127' },
                116: { name: 'CC 116', desc: 'Non défini — usage libre', range: '0-127' },
                117: { name: 'CC 117', desc: 'Non défini — usage libre', range: '0-127' },
                118: { name: 'CC 118', desc: 'Non défini — usage libre', range: '0-127' },
                119: { name: 'CC 119', desc: 'Non défini — usage libre', range: '0-127' }
            }
        },
        channelMode: {
            label: 'Channel Mode', icon: '📡',
            ccs: {
                120: { name: 'All Sound Off', desc: 'Coupe immédiatement tous les sons', range: '0 (fixe)' },
                121: { name: 'Reset All Controllers', desc: 'Réinitialise tous les CC à leur défaut', range: '0 (fixe)' },
                122: { name: 'Local Control', desc: 'Active/désactive le clavier local', range: '0=off, 127=on' },
                123: { name: 'All Notes Off', desc: 'Envoie un Note Off sur toutes les notes', range: '0 (fixe)' },
                124: { name: 'Omni Mode Off', desc: 'Désactive la réception omni-canal', range: '0 (fixe)' },
                125: { name: 'Omni Mode On', desc: 'Active la réception omni-canal', range: '0 (fixe)' },
                126: { name: 'Mono Mode On', desc: 'Mode monophonique (N canaux)', range: '0-16 (nb canaux)' },
                127: { name: 'Poly Mode On', desc: 'Mode polyphonique standard', range: '0 (fixe)' }
            }
        }
    };

    static GM_RECOMMENDED_CCS = {
        piano:       [1, 7, 10, 11, 64, 71, 91, 93],
        chromPerc:   [1, 7, 10, 11, 64, 91, 93],
        organ:       [1, 7, 10, 11, 91, 93],
        guitar:      [1, 7, 10, 11, 64, 71, 74, 91, 93],
        bass:        [1, 7, 10, 11, 64, 71, 74, 91],
        strings:     [1, 7, 10, 11, 64, 71, 74, 91, 93],
        ensemble:    [1, 7, 10, 11, 64, 91, 93],
        brass:       [1, 2, 7, 10, 11, 64, 71, 91],
        reed:        [1, 2, 7, 10, 11, 64, 71, 91],
        pipe:        [1, 2, 7, 10, 11, 64, 91],
        synthLead:   [1, 7, 10, 11, 71, 74, 91, 93],
        synthPad:    [1, 7, 10, 11, 71, 74, 91, 93],
        synthFx:     [1, 7, 10, 11, 71, 74, 91, 93],
        ethnic:      [1, 7, 10, 11, 91],
        percussive:  [7, 10, 91],
        soundFx:     [7, 10, 91],
        drums:       [7, 10, 91]
    };

    // 3 octave modes: how many notes per octave
    static OCTAVE_MODES = {
        chromatic:  { name: '12 notes', label: 'Chromatique',  count: 12, intervals: [0,1,2,3,4,5,6,7,8,9,10,11] },
        diatonic:   { name: '7 notes',  label: 'Diatonique',   count: 7,  intervals: [0,2,4,5,7,9,11] },
        pentatonic: { name: '5 notes',  label: 'Pentatonique', count: 5,  intervals: [0,2,4,7,9] }
    };

    static computePlayableNotes(min, max, modeKey) {
        const mode = InstrumentSettingsModal.OCTAVE_MODES[modeKey];
        if (!mode || modeKey === 'chromatic') {
            const notes = [];
            for (let n = min; n <= max; n++) notes.push(n);
            return notes;
        }
        const notes = [];
        for (let n = min; n <= max; n++) {
            const semitone = n % 12;
            if (mode.intervals.includes(semitone)) notes.push(n);
        }
        return notes;
    }

    static MICROPROCESSOR_PATTERNS = [
        { pattern: /arduino\s*(mega|uno|nano|due|leo|micro|mini|zero|mkr|33|every)/i, name: 'Arduino', variant: null },
        { pattern: /arduino/i, name: 'Arduino', variant: null },
        { pattern: /teensy\s*(4\.[01]|3\.[0-6]|LC|2\.0|2\+\+)?/i, name: 'Teensy', variant: null },
        { pattern: /esp32[\s-]?(s[23]|c[236]|h2)?/i, name: 'ESP32', variant: null },
        { pattern: /raspberry\s*pi\s*(pico|zero|[0-5])?/i, name: 'Raspberry Pi', variant: null },
        { pattern: /stm32[a-z]?[0-9]*/i, name: 'STM32', variant: null },
        { pattern: /rp2040|pico/i, name: 'RP2040/Pico', variant: null },
        { pattern: /feather/i, name: 'Adafruit Feather', variant: null },
        { pattern: /seeeduino|xiao/i, name: 'Seeeduino', variant: null }
    ];

    static GM_CATEGORY_EMOJIS = {
        piano: '🎹', chromPerc: '🔔', organ: '🎹', guitar: '🎸',
        bass: '🎸', strings: '🎻', ensemble: '🎻', brass: '🎺',
        reed: '🎷', pipe: '🪈', synthLead: '🎛️', synthPad: '🎛️',
        synthFx: '🎛️', ethnic: '🪕', percussive: '🥁', soundFx: '🔊',
        drums: '🥁'
    };

    constructor(api) {
        super({
            id: 'instrument-settings-modal',
            size: 'xl',
            title: 'instrumentSettings.title',
            customClass: 'ism-modal'
        });
        this.api = api;
        this.device = null;
        this.instrumentTabs = [];
        this.activeChannel = 0;
        this.tuningPresets = {};
        this.activeSection = 'identity';
        this.isCreationMode = false;
        // Identity picker state: { step: 'family'|'instruments'|'selected', currentFamilySlug }
        // Initialized on each full render by ISMSections._renderIdentitySection.
        this._identityUI = null;
    }

    // ========== PUBLIC API ==========

    async show(device) {
        this.device = device;
        this.isCreationMode = false;
        try {
            this.tuningPresets = {};
            try {
                const resp = await this.api.sendCommand('string_instrument_get_presets', {});
                if (resp && resp.presets) this.tuningPresets = resp.presets;
            } catch (e) { /* no presets */ }

            this.instrumentTabs = [];
            const instrumentChannel = device.channel !== undefined ? device.channel : 0;
            try {
                const listResp = await this.api.sendCommand('instrument_list_by_device', { deviceId: device.id });
                if (listResp && listResp.instruments && listResp.instruments.length > 0) {
                    for (const inst of listResp.instruments) {
                        const tabData = await this._loadChannelData(device.id, inst.channel, device.type);
                        this.instrumentTabs.push(tabData);
                    }
                }
            } catch (e) {
                console.warn('Failed to load device instruments:', e);
            }

            if (this.instrumentTabs.length === 0) {
                const tabData = await this._loadChannelData(device.id, instrumentChannel, device.type);
                this.instrumentTabs.push(tabData);
            }

            this.instrumentTabs.sort((a, b) => a.channel - b.channel);
            const requestedTab = this.instrumentTabs.find(t => t.channel === instrumentChannel);
            this.activeChannel = requestedTab ? instrumentChannel : this.instrumentTabs[0].channel;
            this.activeSection = 'identity';

            this._syncGlobalState();

            this.options.title = '';
            this.open();

            this._updateHeader();

            // Piano will be initialized when user switches to Notes section
            // (viewport needs to be visible for correct size calculation)


        } catch (error) {
            console.error('Error opening instrument settings:', error);
            if (typeof showAlert === 'function') {
                await showAlert(`${this.t('instrumentSettings.loadError') || 'Impossible de charger les réglages'}: ${error.message}`, { title: this.t('common.error') || 'Erreur', icon: '❌' });
            }
        }
    }

    async showCreate(deviceId) {
        this.isCreationMode = true;
        try {
            this.tuningPresets = {};
            try {
                const resp = await this.api.sendCommand('string_instrument_get_presets', {});
                if (resp && resp.presets) this.tuningPresets = resp.presets;
            } catch (e) { /* no presets */ }

            // Start with empty defaults on channel 0
            const defaultSettings = {
                custom_name: '',
                gm_program: null,
                note_selection_mode: 'range',
                note_range_min: 21,
                note_range_max: 108,
                selected_notes: null,
                supported_ccs: [],
                polyphony: 16,
                sync_delay: 0,
                mac_address: null,
                octave_mode: 'chromatic',
                comm_timeout: 5000
            };

            this.device = { id: deviceId, name: deviceId, displayName: deviceId };
            this.instrumentTabs = [{ channel: 0, settings: defaultSettings, stringInstrumentConfig: null, isBleDevice: false, voices: [] }];
            this.activeChannel = 0;
            this.activeSection = 'identity';

            this._syncGlobalState();

            this.options.title = '';
            this.open();

            this._updateHeader();
        } catch (error) {
            console.error('Error opening instrument creation:', error);
            if (typeof showAlert === 'function') {
                await showAlert(`${this.t('instrumentSettings.loadError') || 'Impossible de charger les réglages'}: ${error.message}`, { title: this.t('common.error') || 'Erreur', icon: '❌' });
            }
        }
    }

    // ========== BaseModal OVERRIDES ==========

    renderBody() {
        return `
            ${this._renderTabsBar()}
            <div class="ism-layout">
                ${this._renderSidebar()}
                <div class="ism-content">
                    ${this._renderAllSections()}
                </div>
            </div>
        `;
    }

    renderFooter() {
        const showDelete = this.instrumentTabs.length > 1;
        return `
            <div class="ism-footer-left">
                ${showDelete ? `<button type="button" class="btn btn-danger ism-delete-btn" title="${this.t('instrumentManagement.deleteChannelBtn') || 'Supprimer cet instrument'}">🗑️ Ch ${this.activeChannel + 1}</button>` : ''}
            </div>
            <button type="button" class="btn btn-secondary ism-cancel-btn">${this.t('common.cancel') || 'Annuler'}</button>
            <button type="button" class="btn ism-save-btn">💾 ${this.t('common.save') || 'Sauvegarder'}</button>
        `;
    }

    onOpen() {
        this._attachListeners();
    }

    onClose() {
        if (window.currentDeviceSettings) window.currentDeviceSettings = null;
        if (this._neckDiagram) {
            this._neckDiagram.destroy();
            this._neckDiagram = null;
        }
        this._previewAllNotesOff();
    }

    // ========== PREVIEW KEYBOARD (in header) ==========

    _renderPreviewKeyboard() {
        const slot = this.$('#ismPreviewSlot');
        if (!slot) return;
        const tab = this._getActiveTab();
        const gmProgram = tab ? tab.settings.gm_program : null;
        const channel = tab ? tab.channel : 0;
        const isDrumKit = channel === 9 || (gmProgram != null && gmProgram >= 128);

        if (gmProgram == null && !isDrumKit) {
            slot.innerHTML = `<span class="ism-preview-hint">${this.escape(this.t('instrumentSettings.previewPickInstrument') || '🎵 Choisir un instrument pour activer la preview')}</span>`;
            return;
        }

        slot.innerHTML = isDrumKit ? this._renderPreviewDrums() : this._renderPreviewPiano();
        this._wirePreviewKeyboardListeners();
    }

    _renderPreviewPiano() {
        const whites = [60, 62, 64, 65, 67, 69, 71];
        const blacks = [
            { note: 61, pos: 0 },
            { note: 63, pos: 1 },
            { note: 66, pos: 3 },
            { note: 68, pos: 4 },
            { note: 70, pos: 5 }
        ];
        const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        let html = '<div class="ism-preview-piano" aria-label="preview keyboard">';
        for (const n of whites) {
            html += `<button type="button" class="ism-prv-key ism-prv-white" data-note="${n}"><span class="ism-prv-key-label">${NAMES[n % 12]}</span></button>`;
        }
        html += '<div class="ism-prv-black-overlay">';
        for (const b of blacks) {
            html += `<button type="button" class="ism-prv-key ism-prv-black" data-note="${b.note}" style="--pos:${b.pos}"></button>`;
        }
        html += '</div></div>';
        return html;
    }

    _renderPreviewDrums() {
        const pads = [
            { note: 36, label: 'Kick',  icon: '🥁' },
            { note: 38, label: 'Snare', icon: '🪘' },
            { note: 42, label: 'HH',    icon: '🎩' },
            { note: 46, label: 'OHH',   icon: '🎩' },
            { note: 50, label: 'Tom↑',  icon: '🥁' },
            { note: 45, label: 'Tom↓',  icon: '🥁' },
            { note: 49, label: 'Crash', icon: '💥' },
            { note: 51, label: 'Ride',  icon: '🔔' }
        ];
        let html = '<div class="ism-preview-drums" aria-label="preview drum pads">';
        for (const p of pads) {
            html += `<button type="button" class="ism-prv-pad" data-note="${p.note}" title="${p.label}">
                <span class="ism-prv-pad-icon">${p.icon}</span>
                <span class="ism-prv-pad-label">${p.label}</span>
            </button>`;
        }
        html += '</div>';
        return html;
    }

    _wirePreviewKeyboardListeners() {
        const self = this;
        const keys = this.$$('.ism-prv-key, .ism-prv-pad');
        keys.forEach(function(k) {
            k.addEventListener('mouseenter', function() {
                self._previewNoteOn(parseInt(k.dataset.note), k);
            });
            k.addEventListener('mouseleave', function() {
                self._previewNoteOff(parseInt(k.dataset.note), k);
            });
        });
        const slot = this.$('#ismPreviewSlot');
        if (slot) {
            slot.addEventListener('mouseleave', function() { self._previewAllNotesOff(); });
        }
    }

    _previewNoteOn(note, el) {
        if (!this.device || !this.device.id || isNaN(note)) return;
        if (!this._previewActive) this._previewActive = new Set();
        if (this._previewActive.has(note)) return;
        this._previewActive.add(note);
        if (el) el.classList.add('active');
        const tab = this._getActiveTab();
        const channel = tab ? tab.channel : 0;
        try {
            this.api.sendCommand('midi_send', {
                deviceId: this.device.id,
                channel: channel,
                type: 'noteon',
                note: note,
                velocity: 100
            });
        } catch (e) { /* ignore */ }
    }

    _previewNoteOff(note, el) {
        if (!this.device || !this.device.id || isNaN(note)) return;
        if (this._previewActive) this._previewActive.delete(note);
        if (el) el.classList.remove('active');
        const tab = this._getActiveTab();
        const channel = tab ? tab.channel : 0;
        try {
            this.api.sendCommand('midi_send', {
                deviceId: this.device.id,
                channel: channel,
                type: 'noteoff',
                note: note,
                velocity: 0
            });
        } catch (e) { /* ignore */ }
    }

    _previewAllNotesOff() {
        if (!this._previewActive || this._previewActive.size === 0) return;
        if (!this.device || !this.device.id) { this._previewActive.clear(); return; }
        const tab = this._getActiveTab();
        const channel = tab ? tab.channel : 0;
        const notes = [...this._previewActive];
        this._previewActive.clear();
        this.$$('.ism-prv-key.active, .ism-prv-pad.active').forEach(function(el) { el.classList.remove('active'); });
        for (const n of notes) {
            try {
                this.api.sendCommand('midi_send', {
                    deviceId: this.device.id,
                    channel: channel,
                    type: 'noteoff',
                    note: n,
                    velocity: 0
                });
            } catch (e) { /* ignore */ }
        }
    }

    _sendPreviewProgramChange(program, channel) {
        if (!this.device || !this.device.id || program == null) return;
        try {
            this.api.sendCommand('midi_send', {
                deviceId: this.device.id,
                channel: channel,
                type: 'program',
                program: program
            });
        } catch (e) { /* ignore */ }
    }

    // ========== HEADER ==========

    _updateHeader() {
        const headerEl = this.$('.modal-header h2');
        if (!headerEl) return;
        const tab = this._getActiveTab();
        const instrumentName = tab
            ? (tab.settings.custom_name || tab.settings.name || (this.device && this.device.displayName) || (this.device && this.device.name) || `Ch ${tab.channel + 1}`)
            : ((this.device && this.device.displayName) || (this.device && this.device.name) || '');
        headerEl.innerHTML = `
            <span class="ism-header-main">
                <span class="ism-header-gear">⚙️</span>
                <span class="ism-header-name">${this.escape(instrumentName)}</span>
            </span>
            <div class="ism-preview-slot" id="ismPreviewSlot"></div>
        `;
        this._renderPreviewKeyboard();
    }

    // ========== TABS BAR ==========

    _renderTabsBar() {
        // Count instruments per channel
        const channelCounts = {};
        for (const tab of this.instrumentTabs) {
            const ch = tab.channel;
            channelCounts[ch] = (channelCounts[ch] || 0) + 1;
        }

        let html = '<div class="ism-tabs-bar">';
        for (const tab of this.instrumentTabs) {
            const ch = tab.channel;
            const isActive = ch === this.activeChannel;
            const color = InstrumentSettingsModal.CHANNEL_COLORS[ch % 16];
            const name = tab.settings.custom_name || tab.settings.name || `Ch ${ch + 1}`;
            const isDrum = (ch === 9);
            const count = channelCounts[ch] || 1;
            html += `<button type="button" class="ism-tab ${isActive ? 'active' : ''}" data-channel="${ch}" style="${isActive ? `border-bottom-color: ${color}; color: ${color}; background: ${color}1a;` : ''}">
                <span class="ism-tab-ch" style="background: ${color};">Ch ${ch + 1}${isDrum ? ' DR' : ''}</span>
                <span class="ism-tab-name">${this.escape(name)}</span>
                ${count > 1 ? `<span class="ism-tab-badge" title="${count} instruments sur ce canal">\u00d7${count}</span>` : ''}
            </button>`;
        }
        html += `<button type="button" class="ism-tab ism-tab-add" title="${this.t('instrumentManagement.addInstrument') || 'Ajouter un instrument'}">
            <span style="font-size: 18px; font-weight: bold;">+</span>
        </button>`;
        html += '</div>';
        return html;
    }

    // ========== SIDEBAR ==========

    _renderSidebar() {
        let html = '<nav class="ism-sidebar">';
        for (const sec of InstrumentSettingsModal.SECTIONS) {
            const active = this.activeSection === sec.id ? 'active' : '';
            html += `<button type="button" class="ism-nav-item ${active}" data-section="${sec.id}">
                <span class="ism-nav-icon">${sec.icon}</span>
                <span class="ism-nav-label">${this.t(sec.labelKey) || sec.fallback}</span>
            </button>`;
        }
        html += '</nav>';
        return html;
    }

    // ========== GLOBAL STATE SYNC ==========

    _syncGlobalState() {
        const tab = this._getActiveTab();
        if (!tab || !this.device) return;
        window.currentDeviceSettings = {
            device: { ...this.device, channel: this.activeChannel },
            settings: tab.settings,
            stringInstrumentConfig: tab.stringInstrumentConfig,
            tuningPresets: this.tuningPresets
        };
    }

    // ========== HELPERS ==========

    _getActiveTab() {
        return this.instrumentTabs.find(t => t.channel === this.activeChannel) || null;
    }

    /**
     * Init piano keyboard — must be called when the Notes section is VISIBLE
     * so that the viewport has a real width for octave calculations.
     */
    _initPianoForActiveTab() {
        const tab = this._getActiveTab();
        if (!tab) return;
        const s = tab.settings;
        if (typeof initPianoKeyboard !== 'function') return;

        // Don't init piano for drum instruments (no piano needed)
        const gmProg = s.gm_program;
        const isDrum = this.activeChannel === 9 || (gmProg != null && gmProg >= 128);
        if (isDrum) return;

        const self = this;
        let attempts = 0;

        function tryInit() {
            attempts++;
            const viewport = document.querySelector('.piano-viewport');

            // Wait until viewport is visible and has width (section must be active)
            if (!viewport || viewport.offsetWidth < 20) {
                if (attempts < 10) {
                    setTimeout(tryInit, 80);
                }
                return;
            }

            // 1) Compute center note
            let centerNote = 60;
            if (s.note_selection_mode === 'discrete' && s.selected_notes && s.selected_notes.length > 0) {
                const sorted = [...s.selected_notes].sort((a, b) => a - b);
                centerNote = sorted[Math.floor(sorted.length / 2)];
            } else if (s.note_range_min != null && s.note_range_max != null) {
                centerNote = Math.round((s.note_range_min + s.note_range_max) / 2);
            }

            // 2) Set start note BEFORE calling initPianoKeyboard
            const OCTAVE_WIDTH = 126;
            const availableWidth = viewport.offsetWidth;
            const visibleOctaves = Math.max(1, Math.floor(availableWidth / OCTAVE_WIDTH));
            const visibleNotes = visibleOctaves * 12;
            const startNote = Math.max(0, centerNote - Math.floor(visibleNotes / 2));
            const maxStart = Math.max(0, 127 - visibleNotes + 1);
            window.currentPianoStartNote = Math.min(maxStart, startNote);

            // 3) Init piano
            initPianoKeyboard(
                s.note_range_min, s.note_range_max,
                s.note_selection_mode || 'range',
                s.selected_notes || []
            );

            // 4) Trigger GM program change handler
            if (typeof onGmProgramChanged === 'function') {
                const gmSelect = document.getElementById('gmProgramSelect');
                if (gmSelect) onGmProgramChanged(gmSelect);
            }

            // 5) Apply octave mode highlighting after piano is rendered
            setTimeout(function() {
                self._applyOctaveModeHighlight();
            }, 20);
        }

        // Start trying after a short delay
        setTimeout(tryInit, 30);
    }

    _applyOctaveModeHighlight() {
        const octaveModeInput = document.getElementById('octaveModeInput');
        const noteRangeMin = document.getElementById('noteRangeMin');
        const noteRangeMax = document.getElementById('noteRangeMax');
        if (!octaveModeInput) return;

        const modeKey = octaveModeInput.value || 'chromatic';
        const rangeMin = noteRangeMin && noteRangeMin.value !== '' ? parseInt(noteRangeMin.value) : 0;
        const rangeMax = noteRangeMax && noteRangeMax.value !== '' ? parseInt(noteRangeMax.value) : 127;
        const playableNotes = InstrumentSettingsModal.computePlayableNotes(rangeMin, rangeMax, modeKey);

        if (typeof this._highlightPlayableNotes === 'function') {
            this._highlightPlayableNotes(playableNotes);
        }
    }

    _detectMicroprocessor(deviceName, sysexName) {
        const patterns = InstrumentSettingsModal.MICROPROCESSOR_PATTERNS;
        const sources = [deviceName, sysexName].filter(Boolean);
        for (const src of sources) {
            for (const entry of patterns) {
                const match = src.match(entry.pattern);
                if (match) {
                    return { name: entry.name, variant: match[1] || null, source: src };
                }
            }
        }
        return null;
    }

    _getGmCategoryKey(gmProgram) {
        if (gmProgram == null) return null;
        if (gmProgram >= 128) return 'drums';
        const categoryKeys = [
            'piano', 'chromPerc', 'organ', 'guitar',
            'bass', 'strings', 'ensemble', 'brass',
            'reed', 'pipe', 'synthLead', 'synthPad',
            'synthFx', 'ethnic', 'percussive', 'soundFx'
        ];
        const index = Math.floor(gmProgram / 8);
        return categoryKeys[index] || null;
    }
}

// Apply mixins
Object.assign(InstrumentSettingsModal.prototype, ISMSections);
Object.assign(InstrumentSettingsModal.prototype, ISMNavigation);
Object.assign(InstrumentSettingsModal.prototype, ISMSave);
Object.assign(InstrumentSettingsModal.prototype, ISMListeners);

// Expose globally
if (typeof window !== 'undefined') {
    window.InstrumentSettingsModal = InstrumentSettingsModal;
}
