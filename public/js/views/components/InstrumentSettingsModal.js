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
                await showAlert(`Impossible de charger les réglages: ${error.message}`, { title: 'Erreur', icon: '❌' });
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
        // Cleanup
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
                <div id="drumKitDesc" style="display: none; margin-top: 8px; padding: 10px 14px; background: #f0f4ff; border-left: 4px solid #667eea; border-radius: 0 6px 6px 0; font-size: 13px;"></div>
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
                    ${this.device.usbSerialNumber ? `<span style="color: #9ca3af; font-size: 12px;">SN: ${this.escape(this.device.usbSerialNumber)}</span>` : ''}
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
        // Placeholder — sera rempli à l'étape 4
        return '<p>Section Cordes (à implémenter)</p>';
    }

    _renderDrumsSection() {
        // Placeholder — sera rempli à l'étape 5
        return '<p>Section Drums (à implémenter)</p>';
    }

    _renderAdvancedSection() {
        // Placeholder — sera rempli à l'étape 6
        return '<p>Section Avancé (à implémenter)</p>';
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
                <p style="margin: 0 0 16px 0; font-size: 13px; color: #6b7280;">
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
                        await showAlert((this.t('instrumentManagement.addFailed') || 'Erreur') + ': ' + e.message, { title: 'Erreur', icon: '❌' });
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
        // Placeholder — sera rempli à l'étape 6
        console.log('Save not yet implemented');
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

        // GM Program change
        const gmSelect = this.$('#gmProgramSelect');
        if (gmSelect) {
            gmSelect.addEventListener('change', () => {
                if (typeof onGmProgramChanged === 'function') onGmProgramChanged(gmSelect);
                // Refresh sidebar to show/hide strings/drums
                const sidebar = this.$('.ism-sidebar');
                if (sidebar) sidebar.outerHTML = this._renderSidebar();
                this.$$('.ism-nav-item').forEach(btn => {
                    btn.addEventListener('click', () => this._switchSection(btn.dataset.section));
                });
            });
        }
    }
}

// Expose globally
if (typeof window !== 'undefined') {
    window.InstrumentSettingsModal = InstrumentSettingsModal;
}
