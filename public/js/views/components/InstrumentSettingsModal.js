/**
 * InstrumentSettingsModal
 * Modal XL avec sidebar pour gérer les réglages d'un instrument MIDI.
 * Remplace les fonctions showInstrumentSettings / _renderInstrumentFormContent / saveInstrumentSettings de index.html.
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
        { id: 'notes',    icon: '🎹', labelKey: 'instrumentSettings.sectionNotes',    fallback: 'Notes' },
        { id: 'strings',  icon: '🎸', labelKey: 'instrumentSettings.sectionStrings',  fallback: 'Cordes', conditional: true },
        { id: 'drums',    icon: '🥁', labelKey: 'instrumentSettings.sectionDrums',    fallback: 'Percussions', conditional: true },
        { id: 'advanced', icon: '⚙️', labelKey: 'instrumentSettings.sectionAdvanced', fallback: 'Avancé' }
    ];

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
            // Load tuning presets
            this.tuningPresets = {};
            try {
                const resp = await this.api.sendCommand('string_instrument_get_presets', {});
                if (resp && resp.presets) this.tuningPresets = resp.presets;
            } catch (e) { /* no presets */ }

            // Load all instruments on device
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

            // Sync global state for legacy helpers (onSiPresetChanged, onGmProgramChanged, etc.)
            this._syncGlobalState();

            // Update title
            this.options.title = '';
            this.open();

            // Set custom header after open
            const headerEl = this.$('.modal-header h2');
            if (headerEl) {
                headerEl.innerHTML = `⚙️ ${this.t('instrumentSettings.title')} — ${this.escape(device.displayName || device.name)}`;
            }

            // Init piano after DOM is ready
            this._initPianoForActiveTab();

        } catch (error) {
            console.error('Error opening instrument settings:', error);
            if (typeof showAlert === 'function') {
                await showAlert(`${this.t('instrumentSettings.loadError') || 'Impossible de charger les réglages'}: ${error.message}`, { title: this.t('common.error') || 'Erreur', icon: '❌' });
            }
        }
    }

    async showCreate(deviceId) {
        // TODO: Mode création virtuel
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
        // Cleanup global state
        if (window.currentDeviceSettings) {
            window.currentDeviceSettings = null;
        }
        // Cleanup neck diagram
        if (this._neckDiagram) {
            this._neckDiagram.destroy();
            this._neckDiagram = null;
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
        const tab = this._getActiveTab();
        const settings = tab ? tab.settings : {};
        const gmProgram = settings.gm_program;
        const isString = typeof isGmStringInstrument === 'function' && isGmStringInstrument(gmProgram);
        const isDrum = this.activeChannel === 9 || (gmProgram !== null && gmProgram !== undefined && gmProgram >= 128);

        let html = '<nav class="ism-sidebar">';
        for (const sec of InstrumentSettingsModal.SECTIONS) {
            if (sec.id === 'strings' && !isString) continue;
            if (sec.id === 'drums' && !isDrum) continue;
            const active = this.activeSection === sec.id ? 'active' : '';
            html += `<button type="button" class="ism-nav-item ${active}" data-section="${sec.id}">
                <span class="ism-nav-icon">${sec.icon}</span>
                <span class="ism-nav-label">${this.t(sec.labelKey) || sec.fallback}</span>
            </button>`;
        }
        html += '</nav>';
        return html;
    }

    // ========== SECTIONS ==========

    _renderAllSections() {
        return `
            <div class="ism-section ${this.activeSection === 'identity' ? 'active' : ''}" data-section="identity">
                ${this._renderIdentitySection()}
            </div>
            <div class="ism-section ${this.activeSection === 'notes' ? 'active' : ''}" data-section="notes">
                ${this._renderNotesSection()}
            </div>
            <div class="ism-section ${this.activeSection === 'strings' ? 'active' : ''}" data-section="strings">
                ${this._renderStringsSection()}
            </div>
            <div class="ism-section ${this.activeSection === 'drums' ? 'active' : ''}" data-section="drums">
                ${this._renderDrumsSection()}
            </div>
            <div class="ism-section ${this.activeSection === 'advanced' ? 'active' : ''}" data-section="advanced">
                ${this._renderAdvancedSection()}
            </div>
        `;
    }

    _renderIdentitySection() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const channel = tab.channel;

        // GM Program dropdown (reuse global helper)
        const gmOptions = typeof renderGMInstrumentOptions === 'function'
            ? renderGMInstrumentOptions(settings.gm_program, channel) : '';

        // Channel grid (16 buttons)
        const usedChannels = this.instrumentTabs.map(t => t.channel).filter(ch => ch !== channel);
        const colors = InstrumentSettingsModal.CHANNEL_COLORS;
        let channelGrid = '';
        for (let ch = 0; ch < 16; ch++) {
            const isUsed = usedChannels.includes(ch);
            const isCurrent = ch === channel;
            const isDrum = (ch === 9);
            const cls = isCurrent ? 'active' : (isUsed ? '' : '');
            channelGrid += `<button type="button" class="ism-channel-btn ${cls}" data-channel="${ch}" ${isUsed && !isCurrent ? 'disabled' : ''} style="--ch-color: ${colors[ch]}; ${isCurrent ? `background: ${colors[ch]}; color: #fff; border-color: ${colors[ch]};` : `border-color: ${colors[ch]};`}">
                ${ch + 1}${isDrum ? ' DR' : ''}
            </button>`;
        }

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🎵</span> ${this.t('instrumentSettings.sectionIdentity') || 'Identité'}</h3>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.gmInstrument') || 'Type d\'instrument (General MIDI)'}</label>
                <select id="gmProgramSelect">${gmOptions}</select>
                <span class="ism-form-hint">${this.t('instrumentSettings.gmInstrumentHelp') || 'Sélectionnez le type d\'instrument pour le routage MIDI'}</span>
                <div id="drumKitDesc" class="ism-drum-kit-desc" style="display: none;"></div>
                <div id="drumKitNotice" class="ism-drum-notice" style="display: none;">
                    ${this.t('instrumentSettings.drumKitNotice') || 'Les kits de batterie utilisent le canal MIDI 10 et le mode notes individuelles.'}
                </div>
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.customName') || 'Nom personnalisé'}</label>
                <input type="text" id="customName" value="${this.escape(settings.custom_name || '')}" placeholder="${this.t('instrumentSettings.customNamePlaceholder') || 'Ex: Ma guitare'}">
                <span class="ism-form-hint">${this.t('instrumentSettings.customNameHelp') || 'Nom affiché dans l\'interface'}</span>
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.midiChannel') || 'Canal MIDI'}</label>
                <div class="ism-channel-grid" id="channelGrid">${channelGrid}</div>
                <span class="ism-form-hint">${this.t('instrumentSettings.midiChannelHelp') || 'Canal MIDI utilisé par cet instrument'}</span>
                <input type="hidden" id="channelSelect" value="${channel}">
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.deviceName') || 'Appareil'}</label>
                <div class="ism-info-card">
                    <span class="ism-info-label">${this.escape(this.device.name)}</span>
                    ${this.device.usbSerialNumber ? `<span class="ism-info-secondary">SN: ${this.escape(this.device.usbSerialNumber)}</span>` : ''}
                </div>
            </div>
        `;
    }

    _renderNotesSection() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const isString = typeof isGmStringInstrument === 'function' && isGmStringInstrument(settings.gm_program);
        const noteMode = settings.note_selection_mode || 'range';

        // CC grid — common CCs with labels
        const commonCCs = [
            { num: 1, name: 'Mod' }, { num: 2, name: 'Breath' }, { num: 7, name: 'Vol' },
            { num: 10, name: 'Pan' }, { num: 11, name: 'Expr' }, { num: 64, name: 'Sust' },
            { num: 65, name: 'Port' }, { num: 66, name: 'Sosten' }, { num: 71, name: 'Res' },
            { num: 74, name: 'Cutoff' }, { num: 91, name: 'Reverb' }, { num: 93, name: 'Chorus' }
        ];
        const currentCCs = settings.supported_ccs
            ? (Array.isArray(settings.supported_ccs) ? settings.supported_ccs : String(settings.supported_ccs).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)))
            : [];

        let ccGridHtml = '';
        for (const cc of commonCCs) {
            const checked = currentCCs.includes(cc.num) ? 'checked' : '';
            ccGridHtml += `<label class="ism-cc-item ${checked}">
                <input type="checkbox" class="ism-cc-checkbox" value="${cc.num}" ${checked}>
                <span class="ism-cc-num">${cc.num}</span>
                <span>${cc.name}</span>
            </label>`;
        }

        const polyphonyVal = tab.stringInstrumentConfig
            ? tab.stringInstrumentConfig.num_strings
            : (settings.polyphony || '');

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🎹</span> ${this.t('instrumentSettings.sectionNotes') || 'Notes & Capacités'}</h3>

            <div id="noteSelectionSection" style="${isString ? 'display: none;' : ''}">
                <div class="ism-form-group">
                    <label>${this.t('instrumentSettings.noteSelection') || 'Sélection des notes'}</label>
                    <div class="ism-mode-toggle">
                        <button type="button" class="ism-mode-btn ${noteMode !== 'discrete' ? 'active' : ''}" data-mode="range">
                            📏 ${this.t('instrumentSettings.modeRange') || 'Plage continue'}
                        </button>
                        <button type="button" class="ism-mode-btn ${noteMode === 'discrete' ? 'active' : ''}" data-mode="discrete">
                            🥁 ${this.t('instrumentSettings.modeDiscrete') || 'Notes individuelles'}
                        </button>
                    </div>

                    <div class="ism-piano-container">
                        <div class="piano-range-container">
                            <div class="piano-range-info">
                                <span id="pianoModeHelp">${noteMode === 'discrete'
                                    ? (this.t('instrumentSettings.clickToToggle') || 'Cliquez pour sélectionner/désélectionner')
                                    : (this.t('instrumentSettings.clickToSelect') || 'Cliquez sur les touches pour définir la plage')}</span>
                                <span class="range-display" id="pianoRangeDisplay"></span>
                            </div>
                            <div class="piano-nav-wrapper">
                                <button type="button" class="piano-nav-btn" id="pianoNavLeft" onclick="navigatePiano(-1)">◀</button>
                                <div class="piano-viewport">
                                    <div class="piano-keyboard-mini" id="pianoKeyboardMini"></div>
                                </div>
                                <button type="button" class="piano-nav-btn" id="pianoNavRight" onclick="navigatePiano(1)">▶</button>
                            </div>
                            <div class="piano-octave-indicator" id="pianoOctaveIndicator"></div>
                            <div class="piano-range-buttons" id="pianoPresetButtons">
                                <button type="button" class="btn-small" onclick="clearPianoRange()">${this.t('common.clear') || 'Effacer'}</button>
                            </div>
                        </div>
                    </div>

                    <input type="hidden" id="noteSelectionModeInput" value="${noteMode}">
                    <input type="hidden" id="noteRangeMin" value="${settings.note_range_min != null ? settings.note_range_min : ''}">
                    <input type="hidden" id="noteRangeMax" value="${settings.note_range_max != null ? settings.note_range_max : ''}">
                    <input type="hidden" id="selectedNotesInput" value="${settings.selected_notes ? JSON.stringify(settings.selected_notes) : ''}">
                </div>
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.polyphony') || 'Polyphonie'}</label>
                <input type="number" id="polyphonyInput" value="${polyphonyVal}" min="1" max="128" placeholder="16">
                <span class="ism-form-hint">${this.t('instrumentSettings.polyphonyHelp') || 'Nombre maximum de notes simultanées (1-128)'}</span>
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.supportedCCs') || 'CC supportés'}</label>
                <div class="ism-cc-grid">${ccGridHtml}</div>
                <input type="hidden" id="supportedCCs" value="${currentCCs.join(', ')}">
                <span class="ism-form-hint">${this.t('instrumentSettings.supportedCCsHelp') || 'Sélectionnez les Control Changes supportés par cet instrument'}</span>
            </div>
        `;
    }

    _renderStringsSection() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const config = tab.stringInstrumentConfig;
        const gmCategory = typeof getGmStringCategory === 'function' ? getGmStringCategory(settings.gm_program) : null;

        // Reuse global helpers for preset dropdown
        const presetOptions = typeof renderSiPresetOptions === 'function'
            ? renderSiPresetOptions(this.tuningPresets, config, gmCategory) : '';

        const numStrings = config ? config.num_strings : 6;
        const tuning = config?.tuning || [40, 45, 50, 55, 59, 64];
        const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // CC config values
        const ccEnabled = config ? (config.cc_enabled !== false) : true;
        const ccStrNum = config?.cc_string_number ?? 20;
        const ccStrMin = config?.cc_string_min ?? 1;
        const ccStrMax = config?.cc_string_max ?? 12;
        const ccStrOff = config?.cc_string_offset ?? 0;
        const ccFretNum = config?.cc_fret_number ?? 21;
        const ccFretMin = config?.cc_fret_min ?? 0;
        const ccFretMax = config?.cc_fret_max ?? 36;
        const ccFretOff = config?.cc_fret_offset ?? 0;
        const ccCollapsed = ccEnabled ? '' : 'si-collapsed';

        // Per-string fret mode
        const fretsPerString = config?.frets_per_string || null;
        const isFretless = config?.is_fretless || false;
        const numFrets = config?.num_frets ?? 24;

        // Build string rows for the side panel (note + MIDI input per string)
        // Order: highest pitch (last string) at top, lowest at bottom — matches neck diagram
        let stringRows = '';
        for (let i = numStrings - 1; i >= 0; i--) {
            const note = tuning[i] || 40;
            const noteName = NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
            stringRows += `
                <div class="si-neck-string-row">
                    <span class="si-string-num">${i + 1}</span>
                    <span class="si-string-note-badge" id="ismBadge${i}">${noteName}</span>
                    <input type="number" class="si-input si-input-xs si-tuning-val" id="siTuning${i}"
                           data-string="${i}" value="${note}" min="0" max="127"
                           title="MIDI">
                    <input type="hidden" class="si-frets-val" id="siFrets${i}"
                           value="${fretsPerString ? (fretsPerString[i] ?? numFrets) : numFrets}">
                </div>`;
        }

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🎸</span> ${this.t('instrumentSettings.sectionStrings') || 'Instrument à cordes'}</h3>

            <div class="ism-string-section">
                <div class="ism-form-row">
                    <div class="ism-form-group">
                        <label>${this.t('stringInstrument.tuningPreset') || 'Preset d\'accordage'}</label>
                        <select id="siPresetSelect">${presetOptions}</select>
                    </div>
                    <div class="ism-form-group ism-narrow">
                        <label>${this.t('stringInstrument.numStrings') || 'Cordes'}</label>
                        <input type="number" id="siNumStrings" value="${numStrings}" min="1" max="12">
                    </div>
                </div>

                <div class="si-neck-combined">
                    <div class="si-neck-strings-panel">
                        <div class="si-neck-strings-header">
                            <span class="si-neck-col-hdr">#</span>
                            <span class="si-neck-col-hdr">Note</span>
                            <span class="si-neck-col-hdr">MIDI</span>
                        </div>
                        ${stringRows}
                    </div>
                    ${!isFretless ? `
                    <div class="si-neck-canvas-panel">
                        <canvas id="ism-neck-canvas" width="400" height="${Math.max(120, numStrings * 22 + 36)}"></canvas>
                    </div>
                    ` : ''}
                </div>

                <div class="si-cc-toggle-row" style="margin-top:8px">
                    <div class="si-field si-checkbox-field">
                        <input type="checkbox" id="ism-cc-enabled" ${ccEnabled ? 'checked' : ''}>
                        <label for="ism-cc-enabled">${this.t('stringInstrument.ccEnabled') || 'CC String/Fret Control'}</label>
                    </div>
                </div>

                <div class="si-cc-config-section ${ccCollapsed}" id="ism-cc-config-section">
                    <label class="si-section-title">CC Control</label>
                    <div class="si-cc-row">
                        <span class="si-cc-label">String Select</span>
                        <div class="si-cc-params">
                            <div class="si-cc-param">
                                <label>CC#</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-str-num" value="${ccStrNum}" min="0" max="127">
                            </div>
                            <div class="si-cc-param">
                                <label>Min</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-str-min" value="${ccStrMin}" min="0" max="127">
                            </div>
                            <div class="si-cc-param">
                                <label>Max</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-str-max" value="${ccStrMax}" min="0" max="127">
                            </div>
                            <div class="si-cc-param">
                                <label>Offset</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-str-offset" value="${ccStrOff}" min="-127" max="127">
                            </div>
                        </div>
                    </div>
                    <div class="si-cc-row">
                        <span class="si-cc-label">Fret Select</span>
                        <div class="si-cc-params">
                            <div class="si-cc-param">
                                <label>CC#</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-fret-num" value="${ccFretNum}" min="0" max="127">
                            </div>
                            <div class="si-cc-param">
                                <label>Min</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-fret-min" value="${ccFretMin}" min="0" max="127">
                            </div>
                            <div class="si-cc-param">
                                <label>Max</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-fret-max" value="${ccFretMax}" min="0" max="127">
                            </div>
                            <div class="si-cc-param">
                                <label>Offset</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-fret-offset" value="${ccFretOff}" min="-127" max="127">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    _renderDrumsSection() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;

        // Init drum selected notes from settings
        const selectedNotes = new Set(settings.selected_notes || []);
        this._drumSelectedNotes = selectedNotes;

        // Preset select
        const presets = InstrumentSettingsModal.DRUM_PRESETS;
        let presetOpts = '<option value="">-- Preset --</option>';
        for (const [id, preset] of Object.entries(presets)) {
            presetOpts += `<option value="${id}">${this.escape(preset.name)}</option>`;
        }

        // Categories with notes
        const cats = InstrumentSettingsModal.DRUM_CATEGORIES;
        const noteNames = InstrumentSettingsModal.DRUM_NOTE_NAMES;
        const priorities = InstrumentSettingsModal.DRUM_PRIORITIES;

        let catsHtml = '';
        for (const [catId, cat] of Object.entries(cats)) {
            const catNotes = cat.notes;
            const checkedCount = catNotes.filter(n => selectedNotes.has(n)).length;
            const allChecked = checkedCount === catNotes.length;
            const badgeClass = allChecked ? 'all' : '';

            let notesHtml = '';
            for (const note of catNotes) {
                const checked = selectedNotes.has(note) ? 'checked' : '';
                const priority = priorities[note] || 0;
                const star = priority >= 90 ? '★' : (priority >= 50 ? '☆' : '');
                notesHtml += `<label class="ism-drum-note">
                    <input type="checkbox" class="ism-drum-note-cb" data-note="${note}" data-cat="${catId}" ${checked}>
                    <span class="ism-drum-note-num">${note}</span>
                    <span class="ism-drum-note-name">${this.escape(noteNames[note] || `Note ${note}`)}</span>
                    ${star ? `<span class="ism-drum-note-star">${star}</span>` : ''}
                </label>`;
            }

            catsHtml += `<div class="ism-drum-category" data-cat="${catId}">
                <div class="ism-drum-cat-header">
                    <span class="ism-drum-cat-icon">${cat.icon}</span>
                    <span class="ism-drum-cat-name">${this.escape(cat.name)}</span>
                    <span class="ism-drum-cat-badge ${badgeClass}">${checkedCount}/${catNotes.length}</span>
                    <button type="button" class="ism-drum-cat-toggle" data-cat="${catId}" title="${this.t('instrumentSettings.drumToggleAll') || 'Tout cocher/décocher'}">${allChecked ? '☑' : '☐'}</button>
                    <span class="ism-drum-cat-chevron">▸</span>
                </div>
                <div class="ism-drum-cat-body">
                    <div class="ism-drum-notes">${notesHtml}</div>
                </div>
            </div>`;
        }

        const totalSelected = selectedNotes.size;
        const totalAvailable = Object.values(cats).reduce((sum, c) => sum + c.notes.length, 0);

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🥁</span> ${this.t('instrumentSettings.sectionDrums') || 'Percussions'}</h3>

            <div class="ism-drum-toolbar">
                <select class="ism-drum-preset-select">${presetOpts}</select>
                <button type="button" class="btn btn-small ism-drum-apply-preset">${this.t('common.apply') || 'Appliquer'}</button>
            </div>

            <div class="ism-drum-summary" id="drumSummary">
                <span class="ism-drum-stat ${totalSelected > 0 ? 'good' : 'bad'}">${totalSelected} / ${totalAvailable} notes</span>
            </div>

            <div class="ism-drum-categories">${catsHtml}</div>
        `;
    }

    _renderAdvancedSection() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">⚙️</span> ${this.t('instrumentSettings.sectionAdvanced') || 'Avancé'}</h3>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.syncDelay') || 'Délai de synchronisation'}</label>
                <input type="number" id="syncDelay" value="${settings.sync_delay || 0}" min="-5000" max="5000">
                <span class="ism-form-hint">${this.t('instrumentSettings.syncDelayHelp') || 'Ajustement du timing en millisecondes'}</span>
            </div>

            ${tab.isBleDevice ? `
            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.macAddress') || 'Adresse MAC Bluetooth'}</label>
                <input type="text" id="macAddress" value="${this.escape(settings.mac_address || '')}" placeholder="AA:BB:CC:DD:EE:FF">
                <span class="ism-form-hint">${this.t('instrumentSettings.macAddressHelp') || 'Adresse MAC du périphérique Bluetooth'}</span>
            </div>
            ` : '<input type="hidden" id="macAddress" value="">'}

            ${settings.sysex_identity ? `
            <div class="ism-form-group">
                <label>SysEx Identity</label>
                <div class="ism-info-card">
                    <span>${this.escape(JSON.stringify(settings.sysex_identity))}</span>
                </div>
            </div>
            ` : ''}

            ${settings.capabilities_source ? `
            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.capabilitiesSource') || 'Source des capacités'}</label>
                <div class="ism-info-card">
                    <span>${this.escape(settings.capabilities_source)}</span>
                </div>
            </div>
            ` : ''}
        `;
    }

    // ========== NAVIGATION ==========

    _switchSection(sectionId) {
        this.activeSection = sectionId;
        // Update sidebar active state
        this.$$('.ism-nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.section === sectionId);
        });
        // Update content sections
        this.$$('.ism-section').forEach(sec => {
            sec.classList.toggle('active', sec.dataset.section === sectionId);
        });
    }

    async _switchTab(channel) {
        this.activeChannel = channel;
        this.activeSection = 'identity';
        this._syncGlobalState();
        this._refreshContent();
        this._initPianoForActiveTab();
    }

    _refreshContent() {
        const body = this.$('.modal-body');
        if (body) body.innerHTML = this.renderBody();
        const footer = this.$('.modal-footer');
        if (footer) footer.innerHTML = this.renderFooter();
        this._attachListeners();
    }

    async _addTab() {
        const usedChannels = this.instrumentTabs.map(t => t.channel);
        const freeChannels = [];
        for (let ch = 0; ch < 16; ch++) {
            if (!usedChannels.includes(ch)) freeChannels.push(ch);
        }
        if (freeChannels.length === 0) {
            if (typeof showAlert === 'function') {
                await showAlert(this.t('instrumentManagement.allChannelsUsed') || 'Tous les canaux MIDI sont déjà utilisés.', {
                    title: this.t('instrumentManagement.addInstrumentTitle') || 'Ajouter',
                    icon: '⚠️'
                });
            }
            return;
        }

        // Channel selection popup
        const colors = InstrumentSettingsModal.CHANNEL_COLORS;
        let gridHtml = '<div class="add-inst-channel-grid">';
        for (let ch = 0; ch < 16; ch++) {
            const isUsed = usedChannels.includes(ch);
            const isDrum = (ch === 9);
            gridHtml += `<button type="button" class="add-inst-channel-btn ${isUsed ? 'used' : ''}" data-channel="${ch}" ${isUsed ? 'disabled' : ''} style="${!isUsed ? `border-color: ${colors[ch]};` : ''}">
                ${ch + 1}${isDrum ? ' DR' : ''}
            </button>`;
        }
        gridHtml += '</div>';

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.zIndex = '10002';
        overlay.innerHTML = `
            <div class="modal-content" style="max-width: 420px;">
                <div class="modal-header">
                    <h2>${this.t('instrumentManagement.selectChannel') || 'Choisir un canal MIDI'}</h2>
                    <button class="modal-close" data-close-add>×</button>
                </div>
                <p class="ism-form-hint" style="margin: 0 0 16px 0;">
                    ${this.t('instrumentManagement.selectChannelHelp') || 'Sélectionnez un canal libre'}
                </p>
                ${gridHtml}
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('[data-close-add]').addEventListener('click', () => overlay.remove());
        overlay.querySelectorAll('.add-inst-channel-btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ch = parseInt(btn.dataset.channel);
                overlay.remove();
                try {
                    await this.api.sendCommand('instrument_add_to_device', {
                        deviceId: this.device.id,
                        channel: ch,
                        name: `Instrument Ch${ch + 1}`
                    });
                    const newTabData = await this._loadChannelData(this.device.id, ch, this.device.type);
                    this.instrumentTabs.push(newTabData);
                    this.instrumentTabs.sort((a, b) => a.channel - b.channel);
                    await this._switchTab(ch);
                } catch (e) {
                    console.error('Failed to add instrument:', e);
                    if (typeof showAlert === 'function') {
                        await showAlert((this.t('instrumentManagement.addFailed') || 'Erreur') + ': ' + e.message, { title: this.t('common.error') || 'Erreur', icon: '❌' });
                    }
                }
            });
        });
    }

    async _deleteTab() {
        if (this.instrumentTabs.length <= 1) return;

        const confirmed = typeof showConfirm === 'function' && await showConfirm(
            this.t('instrumentManagement.deleteChannelConfirm') || `Supprimer l'instrument du canal ${this.activeChannel + 1} ?`,
            {
                title: this.t('instrumentManagement.deleteTitle') || 'Supprimer',
                icon: '🗑️',
                okText: this.t('common.delete') || 'Supprimer',
                danger: true
            }
        );
        if (!confirmed) return;

        try {
            await this.api.sendCommand('instrument_delete', {
                deviceId: this.device.id,
                channel: this.activeChannel
            });
            this.instrumentTabs = this.instrumentTabs.filter(t => t.channel !== this.activeChannel);
            await this._switchTab(this.instrumentTabs[0].channel);
        } catch (e) {
            console.error('Failed to delete instrument:', e);
        }
    }

    // ========== SAVE ==========

    async _save() {
        try {
            const customName = (this.$('#customName')?.value || '').trim();
            const syncDelay = parseInt(this.$('#syncDelay')?.value) || 0;
            const macAddress = (this.$('#macAddress')?.value || '').trim();

            // GM Program
            const gmSelect = this.$('#gmProgramSelect');
            const gmRaw = gmSelect && gmSelect.value !== '' ? parseInt(gmSelect.value) : null;
            const gmDecoded = gmRaw !== null && typeof selectValueToGmProgram === 'function'
                ? selectValueToGmProgram(gmRaw) : { program: null, isDrumKit: false };
            const gmProgram = gmDecoded.program;

            // Polyphony
            const polyVal = (this.$('#polyphonyInput')?.value || '').trim();
            const polyphony = polyVal !== '' ? parseInt(polyVal) : null;

            // Note selection
            const noteSelectionMode = this.$('#noteSelectionModeInput')?.value || 'range';
            const noteRangeMin = this.$('#noteRangeMin')?.value?.trim();
            const noteRangeMax = this.$('#noteRangeMax')?.value?.trim();
            const parsedMin = noteRangeMin !== '' && noteRangeMin != null ? parseInt(noteRangeMin) : null;
            const parsedMax = noteRangeMax !== '' && noteRangeMax != null ? parseInt(noteRangeMax) : null;

            let selectedNotes = null;
            if (noteSelectionMode === 'discrete') {
                const input = this.$('#selectedNotesInput')?.value?.trim();
                if (input) { try { selectedNotes = JSON.parse(input); } catch(e) {} }
            }

            // For drums section: use drum selected notes if in drum mode
            if (this._drumSelectedNotes && this._drumSelectedNotes.size > 0 && (this.activeChannel === 9 || gmDecoded.isDrumKit)) {
                selectedNotes = [...this._drumSelectedNotes].sort((a, b) => a - b);
            }

            // Supported CCs
            const ccsVal = (this.$('#supportedCCs')?.value || '').trim();
            let supportedCCs = null;
            if (ccsVal) {
                supportedCCs = ccsVal.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 127);
                if (supportedCCs.length === 0) supportedCCs = null;
            }

            // Validate range
            if (noteSelectionMode === 'range') {
                if (parsedMin !== null && (parsedMin < 0 || parsedMin > 127)) throw new Error('Note min: 0-127');
                if (parsedMax !== null && (parsedMax < 0 || parsedMax > 127)) throw new Error('Note max: 0-127');
                if (parsedMin !== null && parsedMax !== null && parsedMin > parsedMax) throw new Error('Min > Max');
            }

            // Channel
            const originalChannel = this.activeChannel;
            const channelInput = this.$('#channelSelect');
            const userChannel = channelInput ? parseInt(channelInput.value) : originalChannel;
            const saveChannel = gmDecoded.isDrumKit ? 9 : userChannel;

            // Handle channel change
            if (saveChannel !== originalChannel) {
                try {
                    await this.api.sendCommand('instrument_delete', { deviceId: this.device.id, channel: originalChannel });
                } catch (e) { console.warn('Could not delete old channel:', e); }
                const tab = this._getActiveTab();
                if (tab) {
                    tab.channel = saveChannel;
                    this.activeChannel = saveChannel;
                }
            }

            // Save base settings
            await this.api.sendCommand('instrument_update_settings', {
                deviceId: this.device.id,
                channel: saveChannel,
                custom_name: customName || null,
                sync_delay: syncDelay,
                mac_address: macAddress || null,
                name: this.device.name,
                gm_program: gmProgram
            });

            // String instrument path
            const isStringInst = typeof isGmStringInstrument === 'function' && isGmStringInstrument(gmProgram);

            if (isStringInst) {
                const numStrings = parseInt(this.$('#siNumStrings')?.value) || 6;
                const tuning = [], perStringFrets = [];
                for (let i = 0; i < numStrings; i++) {
                    tuning.push(parseInt(this.$(`#siTuning${i}`)?.value) || 40);
                    perStringFrets.push(parseInt(this.$(`#siFrets${i}`)?.value) || 24);
                }
                const computedMin = Math.min(...tuning);
                const computedMax = Math.max(...tuning.map((t, i) => t + perStringFrets[i]));

                await this.api.sendCommand('instrument_update_capabilities', {
                    deviceId: this.device.id, channel: saveChannel,
                    note_selection_mode: 'range',
                    note_range_min: Math.max(0, computedMin),
                    note_range_max: Math.min(127, computedMax),
                    selected_notes: null,
                    supported_ccs: supportedCCs,
                    polyphony: polyphony || numStrings,
                    capabilities_source: 'manual'
                });

                const maxFrets = Math.max(...perStringFrets);
                const instrumentName = typeof getGMInstrumentName === 'function'
                    ? (getGMInstrumentName(gmProgram || 0) || 'Guitar') : 'Guitar';

                // CC config from modal inputs
                const ccEnabled = this.$('#ism-cc-enabled')?.checked ?? true;
                const ccStringNumber = parseInt(this.$('#ism-cc-str-num')?.value) || 20;
                const ccStringMin = parseInt(this.$('#ism-cc-str-min')?.value) ?? 1;
                const ccStringMax = parseInt(this.$('#ism-cc-str-max')?.value) ?? 12;
                const ccStringOffset = parseInt(this.$('#ism-cc-str-offset')?.value) || 0;
                const ccFretNumber = parseInt(this.$('#ism-cc-fret-num')?.value) || 21;
                const ccFretMin = parseInt(this.$('#ism-cc-fret-min')?.value) ?? 0;
                const ccFretMax = parseInt(this.$('#ism-cc-fret-max')?.value) ?? 36;
                const ccFretOffset = parseInt(this.$('#ism-cc-fret-offset')?.value) || 0;

                // Per-string frets from neck diagram
                const tab = this._getActiveTab();
                const fretsPerStringData = this._neckDiagram
                    ? this._neckDiagram.getFretsPerString()
                    : (tab?.stringInstrumentConfig?.frets_per_string || null);

                const siData = {
                    device_id: this.device.id, channel: saveChannel,
                    instrument_name: instrumentName, num_strings: numStrings,
                    num_frets: maxFrets, tuning, is_fretless: 0, capo_fret: 0,
                    cc_enabled: ccEnabled,
                    cc_string_number: ccStringNumber,
                    cc_string_min: ccStringMin,
                    cc_string_max: ccStringMax,
                    cc_string_offset: ccStringOffset,
                    cc_fret_number: ccFretNumber,
                    cc_fret_min: ccFretMin,
                    cc_fret_max: ccFretMax,
                    cc_fret_offset: ccFretOffset,
                    frets_per_string: fretsPerStringData
                };

                if (tab?.stringInstrumentConfig?.id) {
                    siData.id = tab.stringInstrumentConfig.id;
                    await this.api.sendCommand('string_instrument_update', siData);
                } else {
                    await this.api.sendCommand('string_instrument_create', siData);
                }
            } else {
                // Standard / drum instrument
                await this.api.sendCommand('instrument_update_capabilities', {
                    deviceId: this.device.id, channel: saveChannel,
                    note_selection_mode: (gmDecoded.isDrumKit || this.activeChannel === 9) ? 'discrete' : noteSelectionMode,
                    note_range_min: noteSelectionMode === 'range' && !gmDecoded.isDrumKit ? parsedMin : null,
                    note_range_max: noteSelectionMode === 'range' && !gmDecoded.isDrumKit ? parsedMax : null,
                    selected_notes: (noteSelectionMode === 'discrete' || gmDecoded.isDrumKit) ? selectedNotes : null,
                    supported_ccs: supportedCCs,
                    polyphony,
                    capabilities_source: 'manual'
                });
            }

            // Close and refresh
            this.close();
            if (typeof loadDevices === 'function') await loadDevices();
            if (window.instrumentManagementPageInstance) window.instrumentManagementPageInstance.refresh();

        } catch (error) {
            console.error('Save error:', error);
            if (typeof showAlert === 'function') {
                await showAlert(`${this.t('common.error') || 'Erreur'}: ${error.message}`, { title: this.t('instrumentSettings.saveErrorTitle') || 'Erreur de sauvegarde', icon: '❌' });
            }
        }
    }

    // ========== DATA LOADING ==========

    async _loadChannelData(deviceId, channel, deviceType) {
        let settings = {};
        try {
            const response = await this.api.sendCommand('instrument_get_settings', { deviceId, channel });
            const rawSettings = response && response.settings ? response.settings : {};
            let capabilities = {};
            try {
                const capResponse = await this.api.sendCommand('instrument_get_capabilities', { deviceId, channel });
                capabilities = capResponse.capabilities || {};
            } catch (e) { /* ignore */ }
            settings = { ...rawSettings, ...capabilities };
        } catch (e) { /* ignore */ }

        const isBleDevice = !!(deviceType && (deviceType.toLowerCase().includes('ble') || deviceType.toLowerCase().includes('bluetooth'))) ||
                            !!(settings.mac_address);

        let stringInstrumentConfig = null;
        try {
            const siResp = await this.api.sendCommand('string_instrument_get', { device_id: deviceId, channel });
            if (siResp && siResp.instrument) stringInstrumentConfig = siResp.instrument;
        } catch (e) { /* no config */ }

        return { channel, settings, stringInstrumentConfig, isBleDevice };
    }

    // ========== DRUM HELPERS ==========

    _refreshDrumUI() {
        this.$$('.ism-drum-note-cb').forEach(cb => {
            cb.checked = this._drumSelectedNotes.has(parseInt(cb.dataset.note));
        });
        for (const catId of Object.keys(InstrumentSettingsModal.DRUM_CATEGORIES)) {
            this._updateDrumCategoryBadge(catId);
        }
        this._updateDrumSummary();
        // Update toggle buttons
        this.$$('.ism-drum-cat-toggle').forEach(btn => {
            const cat = InstrumentSettingsModal.DRUM_CATEGORIES[btn.dataset.cat];
            if (cat) btn.textContent = cat.notes.every(n => this._drumSelectedNotes.has(n)) ? '☑' : '☐';
        });
    }

    _updateDrumCategoryBadge(catId) {
        const cat = InstrumentSettingsModal.DRUM_CATEGORIES[catId];
        if (!cat) return;
        const checked = cat.notes.filter(n => this._drumSelectedNotes.has(n)).length;
        const badge = this.$(`.ism-drum-category[data-cat="${catId}"] .ism-drum-cat-badge`);
        if (badge) {
            badge.textContent = `${checked}/${cat.notes.length}`;
            badge.classList.toggle('all', checked === cat.notes.length);
        }
        const toggle = this.$(`.ism-drum-cat-toggle[data-cat="${catId}"]`);
        if (toggle) toggle.textContent = checked === cat.notes.length ? '☑' : '☐';
    }

    _updateDrumSummary() {
        const summary = this.$('#drumSummary');
        if (!summary) return;
        const total = Object.values(InstrumentSettingsModal.DRUM_CATEGORIES).reduce((s, c) => s + c.notes.length, 0);
        const count = this._drumSelectedNotes.size;
        summary.innerHTML = `<span class="ism-drum-stat ${count > 0 ? 'good' : 'bad'}">${count} / ${total} notes</span>`;
    }

    // ========== GLOBAL STATE SYNC ==========

    /**
     * Sync internal state to the global currentDeviceSettings variable
     * needed by legacy helpers: onSiPresetChanged, onGmProgramChanged, etc.
     */
    _syncGlobalState() {
        const tab = this._getActiveTab();
        if (!tab || !this.device) return;
        // Set global for legacy helpers in index.html
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

    // ========== NECK DIAGRAM ==========

    _attachStringsSectionListeners() {
        // CC toggle
        const ismCcEnabled = this.$('#ism-cc-enabled');
        if (ismCcEnabled) {
            ismCcEnabled.addEventListener('change', (e) => {
                const ccSection = this.dialog?.querySelector('#ism-cc-config-section');
                if (ccSection) ccSection.classList.toggle('si-collapsed', !e.target.checked);
            });
        }

        // Num strings change -> update config then re-render
        const siNumStrings = this.$('#siNumStrings');
        if (siNumStrings) {
            siNumStrings.addEventListener('change', () => {
                const num = parseInt(siNumStrings.value);
                if (isNaN(num) || num < 1 || num > 12) return;

                const tab = this._getActiveTab();
                if (!tab) return;

                // Ensure stringInstrumentConfig exists
                if (!tab.stringInstrumentConfig) {
                    tab.stringInstrumentConfig = {
                        num_strings: 6, num_frets: 24,
                        tuning: [40, 45, 50, 55, 59, 64],
                        is_fretless: false, capo_fret: 0, cc_enabled: true
                    };
                }
                const cfg = tab.stringInstrumentConfig;

                // Collect current tuning from DOM before re-render
                const currentTuning = [];
                for (let i = 0; i < 12; i++) {
                    const el = this.$(`#siTuning${i}`);
                    if (el) currentTuning.push(parseInt(el.value) || 40);
                }
                // Extend tuning if adding strings
                while (currentTuning.length < num) {
                    const last = currentTuning[currentTuning.length - 1] || 40;
                    currentTuning.push(Math.min(127, last + 5));
                }

                // Update config
                cfg.num_strings = num;
                cfg.tuning = currentTuning.slice(0, num);

                // Adjust frets_per_string if set
                if (cfg.frets_per_string) {
                    while (cfg.frets_per_string.length < num) {
                        cfg.frets_per_string.push(cfg.num_frets || 24);
                    }
                    cfg.frets_per_string = cfg.frets_per_string.slice(0, num);
                }

                // Re-render
                const stringsSection = this.$('.ism-section[data-section="strings"]');
                if (stringsSection) {
                    stringsSection.innerHTML = this._renderStringsSection();
                    this._attachStringsSectionListeners();
                }
            });
        }

        // Preset change -> update config then re-render
        const siPreset = this.$('#siPresetSelect');
        if (siPreset) {
            siPreset.addEventListener('change', () => {
                if (!siPreset.value || !this.tuningPresets) return;
                const preset = this.tuningPresets[siPreset.value];
                if (!preset) return;

                const tab = this._getActiveTab();
                if (!tab) return;
                if (!tab.stringInstrumentConfig) {
                    tab.stringInstrumentConfig = {};
                }
                const cfg = tab.stringInstrumentConfig;
                cfg.num_strings = preset.strings;
                cfg.num_frets = preset.frets;
                cfg.tuning = [...preset.tuning];
                cfg.is_fretless = !!preset.fretless;
                cfg.frets_per_string = null;

                // Re-render
                const stringsSection = this.$('.ism-section[data-section="strings"]');
                if (stringsSection) {
                    stringsSection.innerHTML = this._renderStringsSection();
                    this._attachStringsSectionListeners();
                }
            });
        }

        // Init neck diagram (also wires tuning/fret input listeners)
        this._initNeckDiagram();
    }

    _initNeckDiagram() {
        // Destroy old instance
        if (this._neckDiagram) {
            this._neckDiagram.destroy();
            this._neckDiagram = null;
        }

        const canvas = this.dialog?.querySelector('#ism-neck-canvas');
        if (!canvas || typeof NeckDiagramConfig === 'undefined') return;

        const tab = this._getActiveTab();
        const config = tab?.stringInstrumentConfig;
        const numStrings = config?.num_strings || parseInt(this.$('#siNumStrings')?.value) || 6;
        const numFrets = 36; // Always allow full range; per-string values hold actual fret counts
        const tuning = config?.tuning || [];

        requestAnimationFrame(() => {
            const wrapper = canvas.parentElement;
            const w = wrapper?.clientWidth || 400;
            canvas.width = w;
            canvas.height = Math.max(120, numStrings * 22 + 36);

            // If no per-string frets, create uniform array from saved num_frets
            const initFrets = config?.frets_per_string
                || new Array(numStrings).fill(config?.num_frets ?? 24);

            this._neckDiagram = new NeckDiagramConfig(canvas, {
                numStrings,
                numFrets,
                fretsPerString: initFrets,
                tuning,
                isFretless: config?.is_fretless || false,
                onChange: (fretsPerString) => {
                    // Sync fret inputs in the side panel
                    if (fretsPerString) {
                        for (let i = 0; i < fretsPerString.length; i++) {
                            const input = this.$(`#siFrets${i}`);
                            if (input) input.value = fretsPerString[i];
                        }
                    }
                    // Store on the tab config for save
                    if (tab && tab.stringInstrumentConfig) {
                        tab.stringInstrumentConfig.frets_per_string = fretsPerString;
                    }
                }
            });
        });

        // Wire fret inputs -> neck diagram sync
        this.$$('.si-frets-val').forEach(input => {
            input.addEventListener('change', () => {
                if (!this._neckDiagram) return;
                const idx = parseInt(input.id.replace('siFrets', ''));
                if (isNaN(idx)) return;
                const val = parseInt(input.value) || 0;
                this._neckDiagram.fretsPerString[idx] = Math.max(0, Math.min(36, val));
                this._neckDiagram.redraw();
            });
        });

        // Wire tuning inputs -> neck diagram sync + badge update
        this.$$('.si-tuning-val').forEach(input => {
            input.addEventListener('change', () => {
                const idx = parseInt(input.dataset.string);
                if (isNaN(idx)) return;
                const val = parseInt(input.value);
                if (isNaN(val) || val < 0 || val > 127) return;
                // Update badge
                const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
                const badge = this.$(`#ismBadge${idx}`);
                if (badge) badge.textContent = NOTE_NAMES[val % 12] + (Math.floor(val / 12) - 1);
                // Update neck diagram
                if (this._neckDiagram && this._neckDiagram.tuning[idx] !== undefined) {
                    this._neckDiagram.tuning[idx] = val;
                    this._neckDiagram.redraw();
                }
            });
        });
    }

    // ========== EVENT LISTENERS ==========

    _attachListeners() {
        // Sidebar nav
        this.$$('.ism-nav-item').forEach(btn => {
            btn.addEventListener('click', () => this._switchSection(btn.dataset.section));
        });

        // Tabs
        this.$$('.ism-tab[data-channel]').forEach(btn => {
            btn.addEventListener('click', () => this._switchTab(parseInt(btn.dataset.channel)));
        });
        const addBtn = this.$('.ism-tab-add');
        if (addBtn) addBtn.addEventListener('click', () => this._addTab());

        // Footer buttons
        const saveBtn = this.$('.ism-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', () => this._save());
        const cancelBtn = this.$('.ism-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());
        const deleteBtn = this.$('.ism-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => this._deleteTab());

        // Channel grid
        this.$$('.ism-channel-btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', () => {
                const ch = parseInt(btn.dataset.channel);
                const hiddenInput = this.$('#channelSelect');
                if (hiddenInput) hiddenInput.value = ch;
                this.$$('.ism-channel-btn').forEach(b => {
                    const bCh = parseInt(b.dataset.channel);
                    const color = InstrumentSettingsModal.CHANNEL_COLORS[bCh];
                    b.classList.toggle('active', bCh === ch);
                    b.style.background = bCh === ch ? color : '';
                    b.style.color = bCh === ch ? '#fff' : '';
                });
            });
        });

        // Drum category expand/collapse
        this.$$('.ism-drum-cat-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.ism-drum-cat-toggle')) return;
                header.closest('.ism-drum-category').classList.toggle('expanded');
            });
        });

        // Drum category toggle all
        this.$$('.ism-drum-cat-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const catId = btn.dataset.cat;
                const cat = InstrumentSettingsModal.DRUM_CATEGORIES[catId];
                if (!cat) return;
                const allChecked = cat.notes.every(n => this._drumSelectedNotes.has(n));
                cat.notes.forEach(n => allChecked ? this._drumSelectedNotes.delete(n) : this._drumSelectedNotes.add(n));
                this._refreshDrumUI();
            });
        });

        // Drum note checkboxes
        this.$$('.ism-drum-note-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                const note = parseInt(cb.dataset.note);
                cb.checked ? this._drumSelectedNotes.add(note) : this._drumSelectedNotes.delete(note);
                this._updateDrumCategoryBadge(cb.dataset.cat);
                this._updateDrumSummary();
            });
        });

        // Drum preset apply
        const applyPreset = this.$('.ism-drum-apply-preset');
        if (applyPreset) {
            applyPreset.addEventListener('click', () => {
                const sel = this.$('.ism-drum-preset-select');
                if (!sel || !sel.value) return;
                const preset = InstrumentSettingsModal.DRUM_PRESETS[sel.value];
                if (!preset) return;
                this._drumSelectedNotes = new Set(preset.notes);
                this._refreshDrumUI();
            });
        }

        // Note selection mode toggle
        this.$$('.ism-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                this.$$('.ism-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
                if (typeof setNoteSelectionMode === 'function') setNoteSelectionMode(mode);
            });
        });

        // CC grid checkboxes
        this.$$('.ism-cc-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                cb.closest('.ism-cc-item').classList.toggle('checked', cb.checked);
                const selected = [];
                this.$$('.ism-cc-checkbox:checked').forEach(c => selected.push(parseInt(c.value)));
                const hidden = this.$('#supportedCCs');
                if (hidden) hidden.value = selected.join(', ');
            });
        });

        // Init CC toggle, neck diagram, and all string section listeners
        this._attachStringsSectionListeners();

        // GM Program change
        const gmSelect = this.$('#gmProgramSelect');
        if (gmSelect) {
            gmSelect.addEventListener('change', () => {
                // Update global state so legacy helpers see the new program
                const tab = this._getActiveTab();
                if (tab) {
                    const rawVal = parseInt(gmSelect.value);
                    const decoded = typeof selectValueToGmProgram === 'function'
                        ? selectValueToGmProgram(rawVal) : { program: rawVal, isDrumKit: false };
                    tab.settings.gm_program = decoded.program;
                    this._syncGlobalState();
                }
                if (typeof onGmProgramChanged === 'function') onGmProgramChanged(gmSelect);
                // Refresh sidebar to show/hide strings/drums
                const sidebar = this.$('.ism-sidebar');
                if (sidebar) sidebar.outerHTML = this._renderSidebar();
                this.$$('.ism-nav-item').forEach(btn => {
                    btn.addEventListener('click', () => this._switchSection(btn.dataset.section));
                });
                // Refresh strings section content (preset dropdown depends on GM category)
                const stringsSection = this.$('.ism-section[data-section="strings"]');
                if (stringsSection) {
                    stringsSection.innerHTML = this._renderStringsSection();
                    this._attachStringsSectionListeners();
                }
            });
        }
    }
}

// Expose globally
if (typeof window !== 'undefined') {
    window.InstrumentSettingsModal = InstrumentSettingsModal;
}
