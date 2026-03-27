(function() {
    'use strict';
    const ISMSections = {};

    ISMSections._renderAllSections = function() {
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
    };

    ISMSections._renderIdentitySection = function() {
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
    };

    ISMSections._renderNotesSection = function() {
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
    };

    ISMSections._renderStringsSection = function() {
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
        const NOTE_NAMES = (typeof MidiConstants !== 'undefined') ? MidiConstants.NOTE_NAMES : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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
    };

    ISMSections._renderDrumsSection = function() {
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
    };

    ISMSections._renderAdvancedSection = function() {
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
    };

    if (typeof window !== 'undefined') window.ISMSections = ISMSections;
})();
