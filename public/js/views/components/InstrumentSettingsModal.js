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
        kicks:   { notes: [35, 36], icon: '🥁', name: 'Kicks' },
        snares:  { notes: [37, 38, 40], icon: '🪘', name: 'Snares' },
        hiHats:  { notes: [42, 44, 46], icon: '🎩', name: 'Hi-Hats' },
        toms:    { notes: [41, 43, 45, 47, 48, 50], icon: '🥁', name: 'Toms' },
        crashes: { notes: [49, 55, 57], icon: '💥', name: 'Crashes' },
        rides:   { notes: [51, 53, 59], icon: '🔔', name: 'Rides' },
        latin:   { notes: [60,61,62,63,64,65,66,67,68], icon: '🪇', name: 'Latin' },
        misc:    { notes: [39,52,54,56,58,69,70,71,72,73,74,75,76,77,78,79,80,81], icon: '🎵', name: 'Divers' }
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
        performance: { label: 'Performance', ccs: [1, 2, 4, 11, 64, 65, 66, 67, 68, 84] },
        volume:      { label: 'Volume & Pan', ccs: [7, 8, 10] },
        sound:       { label: 'Son / Timbre', ccs: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79] },
        effects:     { label: 'Effets', ccs: [91, 92, 93, 94, 95] },
        dataBank:    { label: 'Data / Bank', ccs: [0, 6, 32, 38, 96, 97, 98, 99, 100, 101] },
        robotics:    { label: 'Robotique (libres)', ccs: [14, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 85, 86, 87, 88, 89, 90, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119] },
        channelMode: { label: 'Channel Mode', ccs: [120, 121, 122, 123, 124, 125, 126, 127] }
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

    static SCALE_TYPES = {
        chromatic:      { name: 'Chromatique',          intervals: [0,1,2,3,4,5,6,7,8,9,10,11] },
        major:          { name: 'Majeure',              intervals: [0,2,4,5,7,9,11] },
        minor:          { name: 'Mineure naturelle',    intervals: [0,2,3,5,7,8,10] },
        pentatonic:     { name: 'Pentatonique majeure', intervals: [0,2,4,7,9] },
        pentatonicMin:  { name: 'Pentatonique mineure', intervals: [0,3,5,7,10] },
        blues:          { name: 'Blues',                 intervals: [0,3,5,6,7,10] },
        harmonicMin:    { name: 'Mineure harmonique',   intervals: [0,2,3,5,7,8,11] },
        dorian:         { name: 'Dorien',               intervals: [0,2,3,5,7,9,10] },
        mixolydian:     { name: 'Mixolydien',           intervals: [0,2,4,5,7,9,10] },
        majorChord:     { name: 'Accord majeur',        intervals: [0,4,7] },
        minorChord:     { name: 'Accord mineur',        intervals: [0,3,7] },
        seventh:        { name: 'Septième',             intervals: [0,4,7,10] },
        diminished:     { name: 'Diminué',              intervals: [0,3,6,9] },
        augmented:      { name: 'Augmenté',             intervals: [0,4,8] },
        sus2:           { name: 'Sus2',                 intervals: [0,2,7] },
        sus4:           { name: 'Sus4',                 intervals: [0,5,7] }
    };

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

    static COMM_PROTOCOLS = {
        midi_din:  { label: 'MIDI DIN (5-pin)', icon: '🎵' },
        midi_usb:  { label: 'MIDI USB', icon: '🔌' },
        midi_ble:  { label: 'MIDI BLE (Bluetooth)', icon: '📶' },
        midi_wifi: { label: 'MIDI WiFi (RTP/rtpMIDI)', icon: '📡' },
        serial_raw: { label: 'Serial brut (raw)', icon: '⚡' },
        osc:       { label: 'OSC (Open Sound Control)', icon: '🌐' }
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

            const headerEl = this.$('.modal-header h2');
            if (headerEl) {
                headerEl.innerHTML = `⚙️ ${this.t('instrumentSettings.title')} — ${this.escape(device.displayName || device.name)}`;
            }

            this._initPianoForActiveTab();

            // Wire SysEx identity event listener
            this._sysexHandler = (data) => this.handleSysExIdentity(data);
            if (this.api && typeof this.api.on === 'function') {
                this.api.on('device_identity', this._sysexHandler);
            }

        } catch (error) {
            console.error('Error opening instrument settings:', error);
            if (typeof showAlert === 'function') {
                await showAlert(`${this.t('instrumentSettings.loadError') || 'Impossible de charger les réglages'}: ${error.message}`, { title: this.t('common.error') || 'Erreur', icon: '❌' });
            }
        }
    }

    async showCreate(deviceId) {
        this.isCreationMode = true;
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
        if (this._sysexHandler && this.api && typeof this.api.off === 'function') {
            this.api.off('device_identity', this._sysexHandler);
            this._sysexHandler = null;
        }
    }

    // ========== TABS BAR ==========

    _renderTabsBar() {
        let html = '<div class="ism-tabs-bar">';
        for (const tab of this.instrumentTabs) {
            const ch = tab.channel;
            const isActive = ch === this.activeChannel;
            const color = InstrumentSettingsModal.CHANNEL_COLORS[ch % 16];
            const name = tab.settings.custom_name || tab.settings.name || `Ch ${ch + 1}`;
            const isDrum = (ch === 9);
            html += `<button type="button" class="ism-tab ${isActive ? 'active' : ''}" data-channel="${ch}" style="${isActive ? `border-bottom-color: ${color}; color: ${color};` : ''}">
                <span class="ism-tab-ch" style="background: ${color};">Ch ${ch + 1}${isDrum ? ' DR' : ''}</span>
                <span class="ism-tab-name">${this.escape(name)}</span>
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

    _initPianoForActiveTab() {
        const tab = this._getActiveTab();
        if (!tab) return;
        const s = tab.settings;
        if (typeof initPianoKeyboard === 'function') {
            setTimeout(() => {
                initPianoKeyboard(
                    s.note_range_min, s.note_range_max,
                    s.note_selection_mode || 'range',
                    s.selected_notes || []
                );
                if (typeof onGmProgramChanged === 'function') {
                    const gmSelect = document.getElementById('gmProgramSelect');
                    if (gmSelect) onGmProgramChanged(gmSelect);
                }
            }, 50);
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
