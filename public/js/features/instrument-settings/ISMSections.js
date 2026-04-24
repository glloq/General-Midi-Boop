(function() {
    'use strict';
    const ISMSections = {};

    ISMSections._renderAllSections = function() {
        const tab = this._getActiveTab();
        const showHands = ISMSections._shouldShowHandsSection(tab);
        return `
            <div class="ism-section ${this.activeSection === 'identity' ? 'active' : ''}" data-section="identity">
                ${this._renderIdentitySection()}
            </div>
            <div class="ism-section ${this.activeSection === 'notes' ? 'active' : ''}" data-section="notes">
                ${this._renderNotesSection()}
            </div>
            ${showHands ? `
            <div class="ism-section ${this.activeSection === 'hands' ? 'active' : ''}" data-section="hands">
                ${this._renderHandsSection()}
            </div>` : ''}
            <div class="ism-section ${this.activeSection === 'advanced' ? 'active' : ''}" data-section="advanced">
                ${this._renderAdvancedSection()}
            </div>
        `;
    };

    /**
     * Hand-position control is meaningful only for instruments where the
     * pitch comes from a spatial actuator. Phase 1: keyboard-family GM
     * programs. Phase 2 will extend to plucked/bowed strings.
     */
    ISMSections._shouldShowHandsSection = function(tab) {
        if (!tab) return false;
        const gmProgram = tab.settings?.gm_program;
        const channel = tab.channel;
        if (channel === 9) return false; // drum kit
        if (gmProgram == null) return false;
        const fam = window.InstrumentFamilies?.getFamilyForProgram(gmProgram, channel);
        if (!fam) return false;
        return fam.slug === 'keyboards' || fam.slug === 'chromatic_percussion' || fam.slug === 'organs';
    };

    ISMSections._renderIdentitySection = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const channel = tab.channel;

        // GM category emoji (section-title icon)
        const gmProgram = settings.gm_program;
        const catKey = this._getGmCategoryKey(gmProgram);
        const gmEmoji = catKey ? (InstrumentSettingsModal.GM_CATEGORY_EMOJIS[catKey] || '🎵') : '🎵';

        // Identity picker state: always derived from the current tab on a full
        // render. Preservation of 'instruments' step across interactions is
        // handled by the partial re-renders in _rerenderIdentityPicker.
        const hasProgram = gmProgram != null || channel === 9;
        const fam = (window.InstrumentFamilies && hasProgram)
            ? window.InstrumentFamilies.getFamilyForProgram(gmProgram, channel)
            : null;
        this._identityUI = {
            step: hasProgram ? 'selected' : 'family',
            currentFamilySlug: fam ? fam.slug : null
        };
        const pickerHtml = this._renderIdentityPicker();

        // SysEx identity
        const sysexIdentity = settings.sysex_identity || (this._sysexIdentityCache && this._sysexIdentityCache[this.device.id]) || null;
        const sysexName = sysexIdentity ? (sysexIdentity.name || '') : '';
        const sysexFirmware = sysexIdentity ? (sysexIdentity.firmware || sysexIdentity.version || '') : '';
        const sysexFeatures = sysexIdentity ? (sysexIdentity.features || []) : [];

        // Detect microprocessor
        const microprocessor = this._detectMicroprocessor(this.device.name, sysexName);

        // Display name
        const displayName = settings.custom_name || sysexName || '';

        // Channel grid (16 buttons)
        const usedChannels = this.instrumentTabs.map(function(t) { return t.channel; }).filter(function(ch) { return ch !== channel; });
        const colors = InstrumentSettingsModal.CHANNEL_COLORS;
        const omniMode = !!settings.omni_mode;
        let channelGrid = '';
        for (let ch = 0; ch < 16; ch++) {
            const isUsed = usedChannels.includes(ch);
            const isCurrent = ch === channel;
            const isDrum = (ch === 9);
            const cls = isCurrent ? 'active' : '';
            const disabled = (isUsed && !isCurrent) || omniMode;
            channelGrid += `<button type="button" class="ism-channel-btn ${cls}" data-channel="${ch}" ${disabled ? 'disabled' : ''} style="--ch-color: ${colors[ch]}; ${isCurrent ? `background: ${colors[ch]}; color: #fff; border-color: ${colors[ch]};` : `border-color: ${colors[ch]};`}">
                ${ch + 1}${isDrum ? ' DR' : ''}
            </button>`;
        }

        // Device info card
        let deviceInfoHtml = '';
        if (microprocessor) {
            deviceInfoHtml += `<span class="ism-device-chip" title="Microprocesseur détecté">🔧 ${this.escape(microprocessor.name)}${microprocessor.variant ? ' ' + this.escape(microprocessor.variant) : ''}</span>`;
        }
        deviceInfoHtml += `<span class="ism-info-label">${this.escape(this.device.name)}</span>`;
        if (this.device.usbSerialNumber) {
            deviceInfoHtml += `<span class="ism-info-secondary">SN: ${this.escape(this.device.usbSerialNumber)}</span>`;
        }
        if (sysexName) {
            deviceInfoHtml += `<span class="ism-info-secondary">SysEx: ${this.escape(sysexName)}`;
            if (sysexFirmware) deviceInfoHtml += ` v${this.escape(sysexFirmware)}`;
            deviceInfoHtml += `</span>`;
            if (sysexFeatures.length > 0) {
                deviceInfoHtml += `<span class="ism-sysex-features">`;
                for (let i = 0; i < sysexFeatures.length; i++) {
                    deviceInfoHtml += `<span class="ism-feature-badge">${this.escape(sysexFeatures[i])}</span>`;
                }
                deviceInfoHtml += `</span>`;
            }
        }

        // SysEx identity card (hidden by default)
        const hasSysex = !!sysexIdentity;
        const sysexCardHtml = this._renderSysexIdentityCard(sysexIdentity);

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">${gmEmoji}</span> ${this.t('instrumentSettings.sectionIdentity') || 'Identité'}</h3>

            <div class="ism-form-group ism-identity-picker-wrap">
                <div class="ism-identity-header-row">
                    <label>${this.t('instrumentSettings.gmCategory') || 'Instrument'}</label>
                    <div class="ism-preview-slot" id="ismPreviewSlot"></div>
                </div>
                ${pickerHtml}
                <div id="drumKitDesc" class="ism-drum-kit-desc" style="display: none;"></div>
                <div id="drumKitNotice" class="ism-drum-notice" style="display: none;">
                    ${this.t('instrumentSettings.drumKitNotice') || 'Les kits de batterie utilisent le canal MIDI 10 et le mode notes individuelles.'}
                </div>
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.customName') || 'Nom personnalisé'}</label>
                <input type="text" id="customName" value="${this.escape(displayName)}" placeholder="${this.t('instrumentSettings.customNamePlaceholder') || 'Ex: Ma guitare'}">
                <span class="ism-form-hint">${this.t('instrumentSettings.customNameHelp') || 'Nom affiché dans l\'interface'}</span>
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.midiChannel') || 'Canal MIDI'}</label>
                <div class="ism-channel-grid ${omniMode ? 'ism-channel-grid-disabled' : ''}" id="channelGrid">${channelGrid}</div>
                <button type="button"
                        id="omniModeToggle"
                        class="ism-omni-toggle ${omniMode ? 'active' : ''}"
                        aria-pressed="${omniMode ? 'true' : 'false'}"
                        title="${this.escape(this.t('instrumentSettings.omniModeHelp') || 'L\'instrument accepte les notes sur n\'importe quel canal MIDI')}">
                    <span class="ism-omni-dot"></span>
                    <span class="ism-omni-label">${this.escape(this.t('instrumentSettings.omniMode') || 'Omni · accepter tous les canaux')}</span>
                </button>
                <span class="ism-form-hint">${omniMode
                    ? (this.t('instrumentSettings.omniModeActiveHint') || 'Cet instrument reçoit les notes sur n\'importe quel canal — le choix du canal est ignoré.')
                    : (this.t('instrumentSettings.midiChannelHelp') || 'Canal MIDI utilisé par cet instrument')}</span>
                <input type="hidden" id="channelSelect" value="${channel}">
                <input type="hidden" id="omniModeInput" value="${omniMode ? '1' : '0'}">
            </div>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.deviceName') || 'Appareil'}</label>
                <div class="ism-info-card ism-device-info-card">
                    ${deviceInfoHtml}
                </div>
            </div>

            <div class="ism-form-group ism-sysex-identity-section" id="sysexIdentitySection" style="${hasSysex ? '' : 'display: none;'}">
                <label>SysEx Identity</label>
                ${sysexCardHtml}
            </div>

        `;
    };

    // ===== Identity picker (3 états : family | instruments | selected) =====

    ISMSections._renderIdentityPicker = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const channel = tab.channel;
        const gmProgram = settings.gm_program;
        const step = (this._identityUI && this._identityUI.step) || 'family';

        // Hidden input preserved for ISMSave compatibility (reads #gmProgramSelect)
        const encoded = (gmProgram != null && typeof gmProgramToSelectValue === 'function')
            ? gmProgramToSelectValue(gmProgram, channel)
            : '';
        const hiddenInput = `<input type="hidden" id="gmProgramSelect" value="${encoded === '' || encoded == null ? '' : encoded}">`;

        if (step === 'selected') {
            return `<div class="ism-identity-picker" data-step="selected">
                ${this._renderIdentitySelectedBlock()}
                ${hiddenInput}
            </div>`;
        }
        if (step === 'instruments') {
            return `<div class="ism-identity-picker" data-step="instruments">
                ${this._renderIdentityInstrumentGrid()}
                ${hiddenInput}
            </div>`;
        }
        return `<div class="ism-identity-picker" data-step="family">
            ${this._renderIdentityFamilyRow()}
            ${hiddenInput}
        </div>`;
    };

    ISMSections._renderIdentityFamilyRow = function() {
        const families = (window.InstrumentFamilies && window.InstrumentFamilies.getAllFamilies())
            || [];
        const current = this._identityUI ? this._identityUI.currentFamilySlug : null;
        const self = this;
        const btns = families.map(function(fam) {
            const label = self.t(fam.labelKey) || fam.slug;
            const svg = window.InstrumentFamilies.familyIconUrl(fam.slug);
            const isActive = fam.slug === current ? 'active' : '';
            return `<button type="button" class="ism-family-btn ${isActive}" data-family="${fam.slug}" title="${self.escape(label)}">
                <span class="ism-family-icon">
                    <img class="ism-family-svg" src="${svg}" alt=""
                        onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                    <span class="ism-family-emoji" style="display:none">${fam.emoji}</span>
                </span>
                <span class="ism-family-label">${self.escape(label)}</span>
            </button>`;
        }).join('');
        const hint = this.t('instrumentSettings.pickFamily') || 'Choisir une famille d\'instruments';
        return `<div class="ism-family-row">${btns}</div>
            <span class="ism-form-hint">${this.escape(hint)}</span>`;
    };

    ISMSections._renderIdentityInstrumentGrid = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const channel = tab.channel;
        const famSlug = this._identityUI ? this._identityUI.currentFamilySlug : null;
        const fam = (window.InstrumentFamilies && famSlug)
            ? window.InstrumentFamilies.getFamilyBySlug(famSlug) : null;
        if (!fam) return this._renderIdentityFamilyRow();

        const self = this;
        const currentProgram = tab.settings.gm_program;
        const backLabel = this.t('instrumentSettings.backToFamily') || '◀ Familles';
        const backBtn = `<button type="button" class="ism-back-to-family">◀ ${this.escape(backLabel.replace(/^◀\s*/, ''))}</button>`;

        let tiles = '';
        if (fam.isDrumKits) {
            const kits = window.InstrumentFamilies.GM_DRUM_KITS_LIST;
            const offset = (typeof GM_DRUM_KIT_OFFSET !== 'undefined') ? GM_DRUM_KIT_OFFSET : 128;
            tiles = kits.map(function(kit) {
                const encoded = kit.program + offset;
                const isActive = (channel === 9 && currentProgram === kit.program) ? 'active' : '';
                const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: encoded, channel: 9 });
                const kitName = icon.name || kit.name;
                const descKey = 'instruments.drumKitsDesc.' + kit.program;
                const descTrans = (typeof i18n !== 'undefined' && i18n.t) ? i18n.t(descKey) : descKey;
                const desc = descTrans && descTrans !== descKey ? descTrans : '';
                return `<button type="button" class="ism-instrument-btn ${isActive}"
                        data-program="${encoded}" data-drum-kit="true"
                        data-desc="${self.escape(desc)}"
                        title="${self.escape(kitName)}">
                    <span class="ism-inst-icon">
                        ${icon.slug ? `<img class="ism-inst-svg" src="${icon.svgUrl}" alt=""
                            onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                        <span class="ism-inst-emoji" style="display:none">${icon.emoji}</span>`
                        : `<span class="ism-inst-emoji">${icon.emoji}</span>`}
                    </span>
                    <span class="ism-inst-number">${kit.program}</span>
                    <span class="ism-inst-name">${self.escape(kitName)}</span>
                </button>`;
            }).join('');
        } else {
            tiles = fam.programs.map(function(p) {
                const isActive = (p === currentProgram && channel !== 9) ? 'active' : '';
                const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: p, channel: channel });
                const name = (typeof getGMInstrumentName === 'function')
                    ? getGMInstrumentName(p) : ('Program ' + p);
                return `<button type="button" class="ism-instrument-btn ${isActive}"
                        data-program="${p}" data-drum-kit="false"
                        title="${self.escape(name)}">
                    <span class="ism-inst-icon">
                        ${icon.slug ? `<img class="ism-inst-svg" src="${icon.svgUrl}" alt=""
                            onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                        <span class="ism-inst-emoji" style="display:none">${icon.emoji}</span>`
                        : `<span class="ism-inst-emoji">${icon.emoji}</span>`}
                    </span>
                    <span class="ism-inst-number">${p}</span>
                    <span class="ism-inst-name">${self.escape(name)}</span>
                </button>`;
            }).join('');
        }

        const famLabel = this.t(fam.labelKey) || fam.slug;
        const hint = this.t('instrumentSettings.pickInstrument') || 'Choisir un instrument';
        return `<div class="ism-instrument-grid-header">
                ${backBtn}
                <span class="ism-instrument-grid-family">${fam.emoji} ${this.escape(famLabel)}</span>
            </div>
            <div class="ism-instrument-grid">${tiles}</div>
            <span class="ism-form-hint">${this.escape(hint)}</span>`;
    };

    ISMSections._renderIdentitySelectedBlock = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const channel = tab.channel;
        const gmProgram = settings.gm_program;
        const isDrumChannel = channel === 9;

        let displayProgram = gmProgram;
        let icon;
        let name;
        if (isDrumChannel) {
            const offset = (typeof GM_DRUM_KIT_OFFSET !== 'undefined') ? GM_DRUM_KIT_OFFSET : 128;
            icon = window.InstrumentFamilies.resolveInstrumentIcon({
                gmProgram: gmProgram != null ? (gmProgram + offset) : null,
                channel: 9
            });
            name = icon.name || (this.t('instrumentSettings.drumKit') || 'Kit batterie');
        } else {
            icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: gmProgram, channel: channel });
            name = icon.name || (typeof getGMInstrumentName === 'function'
                ? getGMInstrumentName(gmProgram) : ('Program ' + gmProgram));
        }

        const editTitle = this.t('instrumentSettings.editInstrument') || 'Modifier l\'instrument';
        const delTitle = this.t('instrumentSettings.deleteInstrument') || 'Effacer l\'instrument';
        const addLabel = this.t('instrumentSettings.addGmInstrument') || 'Ajouter un instrument GM';
        const previewTitle = this.t('instrumentSettings.previewThisVoice') || 'Cliquez pour prévisualiser cette voix';
        // Which row is currently routed to the preview keyboard?
        // null => primary voice, number => index in tab.voices.
        const activePreviewIdx = (typeof this._previewActiveVoice !== 'undefined') ? this._previewActiveVoice : null;
        const primaryIsActive = activePreviewIdx == null;

        const primaryHtml = `<div class="ism-selected-instrument ism-selected-primary ${primaryIsActive ? 'ism-preview-active' : ''}"
                data-voice-index=""
                role="button"
                tabindex="0"
                aria-pressed="${primaryIsActive ? 'true' : 'false'}"
                title="${this.escape(previewTitle)}">
            <span class="ism-sel-icon">
                ${icon.slug ? `<img class="ism-sel-svg" src="${icon.svgUrl}" alt=""
                    onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                <span class="ism-sel-emoji" style="display:none">${icon.emoji}</span>`
                : `<span class="ism-sel-emoji">${icon.emoji}</span>`}
            </span>
            <span class="ism-sel-program">${displayProgram != null ? displayProgram : ''}</span>
            <span class="ism-sel-name">${this.escape(name)}</span>
            <div class="ism-sel-actions">
                <button type="button" class="ism-icon-btn ism-edit-instrument" title="${this.escape(editTitle)}" aria-label="${this.escape(editTitle)}">✏️</button>
                <button type="button" class="ism-icon-btn ism-delete-instrument" title="${this.escape(delTitle)}" aria-label="${this.escape(delTitle)}">🗑️</button>
            </div>
        </div>`;

        const voices = Array.isArray(tab.voices) ? tab.voices : [];
        const delVoiceTitle = this.t('instrumentSettings.deleteVoice') || 'Supprimer cette voix';
        const self = this;
        const voiceRows = voices.map(function(v, idx) {
            const vProgram = v.gm_program;
            const vIcon = window.InstrumentFamilies
                ? window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: vProgram, channel: channel })
                : { emoji: '🎵', svgUrl: null, slug: null, name: null };
            const vName = vIcon.name
                || (typeof getGMInstrumentName === 'function' && vProgram != null ? getGMInstrumentName(vProgram) : '—');
            const isActive = activePreviewIdx === idx;
            return `<div class="ism-selected-instrument ism-selected-secondary ${isActive ? 'ism-preview-active' : ''}"
                    data-voice-index="${idx}"
                    role="button"
                    tabindex="0"
                    aria-pressed="${isActive ? 'true' : 'false'}"
                    title="${self.escape(previewTitle)}">
                <span class="ism-sel-icon">
                    ${vIcon.slug ? `<img class="ism-sel-svg" src="${vIcon.svgUrl}" alt=""
                        onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                    <span class="ism-sel-emoji" style="display:none">${vIcon.emoji}</span>`
                    : `<span class="ism-sel-emoji">${vIcon.emoji}</span>`}
                </span>
                <span class="ism-sel-program">${vProgram != null ? vProgram : ''}</span>
                <span class="ism-sel-name">${self.escape(vName)}</span>
                <div class="ism-sel-actions">
                    <button type="button" class="ism-icon-btn ism-identity-voice-delete" title="${self.escape(delVoiceTitle)}" aria-label="${self.escape(delVoiceTitle)}">🗑️</button>
                </div>
            </div>`;
        }).join('');

        const addBtnHtml = `<button type="button" class="ism-add-gm-instrument-btn" title="${this.escape(addLabel)}">
            <span class="ism-add-gm-icon">➕</span>
            <span class="ism-add-gm-label">${this.escape(addLabel)}</span>
        </button>`;

        // Primary and secondary voices live in the same stacked list with
        // consistent spacing — no "Voix supplémentaires" header or separator.
        const listHtml = `<div class="ism-selected-list">${primaryHtml}${voiceRows}</div>`;

        return listHtml + addBtnHtml;
    };

    ISMSections._renderSysexIdentityCard = function(identity) {
        if (!identity) {
            return '<div class="ism-sysex-card" id="sysexCard"><span class="ism-info-secondary">Aucune identité SysEx disponible</span></div>';
        }
        const name = identity.name || 'Inconnu';
        const firmware = identity.firmware || identity.version || '-';
        const protocol = identity.protocol || '-';
        return `<div class="ism-sysex-card" id="sysexCard">
            <div class="ism-sysex-grid">
                <div class="ism-sysex-field"><span class="ism-sysex-label">Nom</span><span class="ism-sysex-value">${this.escape(name)}</span></div>
                <div class="ism-sysex-field"><span class="ism-sysex-label">Firmware</span><span class="ism-sysex-value">${this.escape(firmware)}</span></div>
                <div class="ism-sysex-field"><span class="ism-sysex-label">Protocole</span><span class="ism-sysex-value">${this.escape(protocol)}</span></div>
            </div>
        </div>`;
    };

    ISMSections._renderNotesSection = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const gmProgram = settings.gm_program;
        const isString = typeof isGmStringInstrument === 'function' && isGmStringInstrument(gmProgram);
        const isDrum = this.activeChannel === 9 || (gmProgram !== null && gmProgram !== undefined && gmProgram >= 128);

        // Active notes target (primary or one of the voices). Note-range data
        // is read from this object so per-voice tabs can override the primary.
        const activeNotes = (typeof this._getActiveNotesTarget === 'function')
            ? this._getActiveNotesTarget()
            : { kind: 'primary', idx: null, obj: settings };
        const notesSrc = activeNotes && activeNotes.obj ? activeNotes.obj : settings;

        const shareNotes = settings.voices_share_notes === 0 || settings.voices_share_notes === false ? false : true;
        const voices = Array.isArray(tab.voices) ? tab.voices : [];
        const showShareToggle = voices.length > 0 && !isString && !isDrum;
        const showVoiceTabs = showShareToggle && !shareNotes;

        const noteMode = notesSrc.note_selection_mode || 'range';
        const octaveMode = notesSrc.octave_mode || 'chromatic';

        // CC data — preserved as-is in a hidden input; only String/Fret CC config is exposed in the UI (strings subsection)
        const currentCCs = settings.supported_ccs
            ? (Array.isArray(settings.supported_ccs) ? settings.supported_ccs : String(settings.supported_ccs).split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return !isNaN(n); }))
            : [];

        const polyphonyVal = tab.stringInstrumentConfig
            ? tab.stringInstrumentConfig.num_strings
            : (settings.polyphony || '');

        // 3 octave mode toggle buttons
        const octaveModes = InstrumentSettingsModal.OCTAVE_MODES;
        let octaveToggleHtml = '';
        for (const key of Object.keys(octaveModes)) {
            const m = octaveModes[key];
            octaveToggleHtml += `<button type="button" class="ism-octave-btn ${key === octaveMode ? 'active' : ''}" data-octave="${key}">
                <span class="ism-octave-btn-count">${m.count}</span>
                <span class="ism-octave-btn-label">${m.label}</span>
            </button>`;
        }

        // Compute playable notes for display info
        const rangeMin = notesSrc.note_range_min != null ? notesSrc.note_range_min : 21;
        const rangeMax = notesSrc.note_range_max != null ? notesSrc.note_range_max : 108;
        const playableNotes = InstrumentSettingsModal.computePlayableNotes(rangeMin, rangeMax, octaveMode);

        // Voice tabs header (shown only when sharing is OFF). The primary is
        // always the first tab so the user can still edit it from this view.
        let voiceTabsHtml = '';
        if (showVoiceTabs) {
            const activeIdx = this._activeNotesVoiceIdx;
            const self = this;
            const tabBtn = function(idx, gmProg, isPrimary) {
                const icon = window.InstrumentFamilies
                    ? window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: gmProg, channel: tab.channel })
                    : { emoji: '🎵', svgUrl: null, slug: null, name: null };
                const name = icon.name
                    || (typeof getGMInstrumentName === 'function' && gmProg != null ? getGMInstrumentName(gmProg) : '—');
                const isActive = isPrimary ? activeIdx == null : activeIdx === idx;
                return `<button type="button" class="ism-notes-voice-tab ${isActive ? 'active' : ''}"
                        data-voice-idx="${isPrimary ? '' : idx}">
                    <span class="ism-notes-voice-tab-icon">
                        ${icon.slug ? `<img class="ism-notes-voice-tab-svg" src="${icon.svgUrl}" alt=""
                            onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                        <span class="ism-notes-voice-tab-emoji" style="display:none">${icon.emoji}</span>`
                        : `<span class="ism-notes-voice-tab-emoji">${icon.emoji}</span>`}
                    </span>
                    <span class="ism-notes-voice-tab-name">${self.escape(name)}</span>
                </button>`;
            };
            voiceTabsHtml = `<div class="ism-notes-voice-tabs" id="notesVoiceTabs">
                ${tabBtn(null, gmProgram, true)}
                ${voices.map(function(v, i) { return tabBtn(i, v.gm_program, false); }).join('')}
            </div>`;
        }

        // Shared/per-voice toggle — only when there are secondary GM voices on
        // a non-drum, non-string primary (where per-voice note ranges make sense).
        const shareToggleHtml = showShareToggle
            ? `<div class="ism-form-group ism-voices-share-group">
                <label class="ism-voices-share-label">
                    <input type="checkbox" id="voicesShareNotesCheckbox" ${shareNotes ? 'checked' : ''}>
                    <span>${this.escape(this.t('instrumentSettings.voicesShareNotes') || 'Tous les instruments GM jouent les mêmes notes MIDI')}</span>
                </label>
                <span class="ism-form-hint">${this.escape(this.t('instrumentSettings.voicesShareNotesHint') || 'Décochez pour définir des notes jouables différentes par instrument GM.')}</span>
            </div>`
            : '';

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🎹</span> ${this.t('instrumentSettings.sectionNotes') || 'Notes & Capacités'}</h3>

            ${shareToggleHtml}
            ${voiceTabsHtml}

            ${!isDrum ? `
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

                    <div class="ism-octave-selector" style="${noteMode === 'discrete' ? 'display: none;' : ''}" id="octaveModeSelector">
                        <div class="ism-octave-toggle">${octaveToggleHtml}</div>
                        <span class="ism-octave-count" id="octaveInfo">${playableNotes.length} notes jouables</span>
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
                    <input type="hidden" id="noteRangeMin" value="${notesSrc.note_range_min != null ? notesSrc.note_range_min : ''}">
                    <input type="hidden" id="noteRangeMax" value="${notesSrc.note_range_max != null ? notesSrc.note_range_max : ''}">
                    <input type="hidden" id="selectedNotesInput" value="${notesSrc.selected_notes ? JSON.stringify(notesSrc.selected_notes) : ''}">
                    <input type="hidden" id="octaveModeInput" value="${octaveMode}">
                    <input type="hidden" id="playableNotesInput" value="${JSON.stringify(playableNotes)}">
                </div>
            </div>
            ` : `
            <input type="hidden" id="noteSelectionModeInput" value="discrete">
            <input type="hidden" id="noteRangeMin" value="">
            <input type="hidden" id="noteRangeMax" value="">
            <input type="hidden" id="selectedNotesInput" value="${notesSrc.selected_notes ? JSON.stringify(notesSrc.selected_notes) : ''}">
            <input type="hidden" id="octaveModeInput" value="chromatic">
            <input type="hidden" id="playableNotesInput" value="[]">
            `}

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.polyphony') || 'Polyphonie'}</label>
                <input type="number" id="polyphonyInput" value="${polyphonyVal}" min="1" max="128" placeholder="16">
                <span class="ism-form-hint">${this.t('instrumentSettings.polyphonyHelp') || 'Nombre maximum de notes simultanées (1-128)'}</span>
            </div>

            ${(isString && !isDrum) ? `<div class="ism-subsection" id="stringsSubsection">
                <h4 class="ism-subsection-title">🎸 ${this.t('instrumentSettings.sectionStrings') || 'Instrument à cordes'}</h4>
                ${this._renderStringsContent()}
            </div>` : ''}

            ${isDrum ? `<div class="ism-subsection" id="drumsSubsection">
                <h4 class="ism-subsection-title">🥁 ${this.t('instrumentSettings.sectionDrums') || 'Percussions'}</h4>
                ${this._renderDrumsContent()}
            </div>` : ''}

            <div class="ism-subsection" id="timingsSubsection">
                <h4 class="ism-subsection-title">⏱️ ${this.t('instrumentSettings.sectionTimingsPerGm') || 'Temporisations par instrument GM'}</h4>
                <p class="ism-subsection-hint">${this.t('instrumentSettings.timingsPerGmHint') || 'Chaque voix GM peut avoir ses propres contraintes de timing (utile quand les instruments ont des temps de réponse différents).'}</p>
                <div id="timingsPrimaryBlock">${this._renderTimingsPrimaryBlock()}</div>
                <div id="timingsVoicesList">${this._renderVoicesSubsection()}</div>
            </div>

            <div class="ism-subsection" id="sharedCcsSubsection">
                <h4 class="ism-subsection-title">🎛️ ${this.t('instrumentSettings.supportedCcsTitle') || 'CC supportés'}</h4>
                <p class="ism-subsection-hint">${this.t('instrumentSettings.supportedCcsHint') || 'Liste partagée par toutes les voix GM de cet instrument. Les CC non gérés par un instrument sont simplement ignorés côté matériel.'}</p>
                <div class="ism-form-group">
                    <label for="supportedCCs">${this.t('instrumentSettings.supportedCcsLabel') || 'CC supportés (séparés par des virgules)'}</label>
                    <input type="text" id="supportedCCs" value="${currentCCs.join(', ')}" placeholder="1, 7, 11, 64">
                </div>
            </div>
        `;
    };

    /**
     * Render the primary GM instrument's timing block (interval + duration).
     * Kept separate from the voices list so rerenders triggered by voice
     * add/delete do not wipe the user's unsaved primary inputs.
     */
    ISMSections._renderTimingsPrimaryBlock = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const gmProgram = settings.gm_program;
        const channel = tab.channel;
        const isDrumChannel = channel === 9;
        const offset = (typeof GM_DRUM_KIT_OFFSET !== 'undefined') ? GM_DRUM_KIT_OFFSET : 128;
        const resolverProgram = isDrumChannel && gmProgram != null ? (gmProgram + offset) : gmProgram;
        const icon = (window.InstrumentFamilies
            ? window.InstrumentFamilies.resolveInstrumentIcon({
                gmProgram: resolverProgram,
                channel: channel
            })
            : { emoji: '🎵', svgUrl: null, slug: null, name: null });
        const name = icon.name
            || (isDrumChannel
                ? (this.t('instrumentSettings.drumKit') || 'Kit batterie')
                : (typeof getGMInstrumentName === 'function' && gmProgram != null
                    ? getGMInstrumentName(gmProgram)
                    : (this.t('instrumentSettings.primaryVoice') || 'Voix principale')));
        const programBadge = gmProgram != null ? gmProgram : '';
        const primaryBadge = this.t('instrumentSettings.primaryVoiceBadge') || 'Voix principale';

        return `<div class="ism-timings-row ism-timings-primary">
            <div class="ism-timings-head">
                <span class="ism-timings-icon">
                    ${icon.slug ? `<img class="ism-timings-svg" src="${icon.svgUrl}" alt=""
                        onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                    <span class="ism-timings-emoji" style="display:none">${icon.emoji}</span>`
                    : `<span class="ism-timings-emoji">${icon.emoji}</span>`}
                </span>
                <span class="ism-timings-program">${programBadge}</span>
                <span class="ism-timings-name">${this.escape(name)}</span>
                <span class="ism-timings-tag">${this.escape(primaryBadge)}</span>
            </div>
            <div class="ism-timings-params">
                <div class="ism-timings-param">
                    <label for="minNoteInterval">${this.t('instrumentSettings.minNoteInterval') || 'Temps minimum entre 2 notes (ms)'}</label>
                    <input type="number" id="minNoteInterval" value="${settings.min_note_interval != null ? settings.min_note_interval : ''}" min="0" max="5000" step="1" placeholder="0">
                </div>
                <div class="ism-timings-param">
                    <label for="minNoteDuration">${this.t('instrumentSettings.minNoteDuration') || 'Temps note actif minimum (ms)'}</label>
                    <input type="number" id="minNoteDuration" value="${settings.min_note_duration != null ? settings.min_note_duration : ''}" min="0" max="5000" step="1" placeholder="0">
                </div>
            </div>
        </div>`;
    };

    ISMSections._renderStringsContent = function() {
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
        const NOTE_NAMES = MidiConstants.NOTE_NAMES;

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

        // Build horizontal header rows (string numbers, note badges, MIDI inputs)
        let stringNumCells = '';
        let noteBadgeCells = '';
        let midiInputCells = '';
        let hiddenFretInputs = '';
        for (let i = 0; i < numStrings; i++) {
            const note = tuning[i] || 40;
            const noteName = NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
            stringNumCells += `<span class="si-string-num">${numStrings - i}</span>`;
            noteBadgeCells += `<span class="si-string-note-badge" id="ismBadge${i}">${noteName}</span>`;
            midiInputCells += `<input type="number" class="si-input si-input-xs si-tuning-val" id="siTuning${i}"
                           data-string="${i}" value="${note}" min="0" max="127"
                           title="MIDI">`;
            hiddenFretInputs += `<input type="hidden" class="si-frets-val" id="siFrets${i}"
                           value="${fretsPerString ? (fretsPerString[i] ?? numFrets) : numFrets}">`;
        }

        return `
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

                <div class="si-neck-combined si-neck-vertical">
                    <div class="si-neck-header-grid">
                        <div class="si-neck-header-row">
                            <span class="si-neck-row-label">#</span>
                            ${stringNumCells}
                        </div>
                        <div class="si-neck-header-row">
                            <span class="si-neck-row-label">Note</span>
                            ${noteBadgeCells}
                        </div>
                        <div class="si-neck-header-row">
                            <span class="si-neck-row-label">MIDI</span>
                            ${midiInputCells}
                        </div>
                    </div>
                    ${!isFretless ? `
                    <div class="si-neck-canvas-panel">
                        <canvas id="ism-neck-canvas" width="400" height="350"></canvas>
                    </div>
                    ` : ''}
                    <div style="display:none">${hiddenFretInputs}</div>
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
                        </div>
                    </div>
                    <div class="si-cc-row">
                        <span class="si-cc-label">Fret Select</span>
                        <div class="si-cc-params">
                            <div class="si-cc-param">
                                <label>CC#</label>
                                <input type="number" class="si-input si-input-xs" id="ism-cc-fret-num" value="${ccFretNum}" min="0" max="127">
                            </div>
                        </div>
                    </div>
                    <input type="hidden" id="ism-cc-str-min" value="${ccStrMin}">
                    <input type="hidden" id="ism-cc-str-max" value="${ccStrMax}">
                    <input type="hidden" id="ism-cc-str-offset" value="${ccStrOff}">
                    <input type="hidden" id="ism-cc-fret-min" value="${ccFretMin}">
                    <input type="hidden" id="ism-cc-fret-max" value="${ccFretMax}">
                    <input type="hidden" id="ism-cc-fret-offset" value="${ccFretOff}">
                </div>
            </div>
        `;
    };

    // ===== Voices subsection (multi-GM alternatives) =====

    /**
     * Render the per-voice timing rows (interval + duration + CCs) shown under
     * the primary block inside the ⏱️ Timings subsection. Add/delete lives in
     * the Identity tab — this renderer only exposes the timing parameters.
     */
    ISMSections._renderVoicesSubsection = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const voices = Array.isArray(tab.voices) ? tab.voices : [];
        const channel = tab.channel;
        const self = this;

        if (voices.length === 0) {
            return `<div class="ism-voices-empty">${this.escape(this.t('instrumentSettings.voicesEmpty') || 'Aucune voix additionnelle — ajoutez-en depuis l\'onglet Identité.')}</div>`;
        }

        return voices.map(function(v, idx) {
            const gmProgram = v.gm_program;
            const icon = window.InstrumentFamilies
                ? window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: gmProgram, channel: channel })
                : { emoji: '🎵', svgUrl: null, slug: null, name: null };
            const name = icon.name
                || (typeof getGMInstrumentName === 'function' && gmProgram != null ? getGMInstrumentName(gmProgram) : '—');
            return `<div class="ism-timings-row ism-voice-row" data-voice-index="${idx}">
                <div class="ism-timings-head">
                    <span class="ism-timings-icon">
                        ${icon.slug ? `<img class="ism-timings-svg" src="${icon.svgUrl}" alt=""
                            onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                        <span class="ism-timings-emoji" style="display:none">${icon.emoji}</span>`
                        : `<span class="ism-timings-emoji">${icon.emoji}</span>`}
                    </span>
                    <span class="ism-timings-program">${gmProgram != null ? gmProgram : '—'}</span>
                    <span class="ism-timings-name">${self.escape(name)}</span>
                </div>
                <div class="ism-timings-params">
                    <div class="ism-timings-param">
                        <label>${self.escape(self.t('instrumentSettings.minNoteInterval') || 'Temps min entre 2 notes (ms)')}</label>
                        <input type="number" class="ism-voice-interval" value="${v.min_note_interval != null ? v.min_note_interval : ''}" min="0" max="5000" placeholder="0">
                    </div>
                    <div class="ism-timings-param">
                        <label>${self.escape(self.t('instrumentSettings.minNoteDuration') || 'Temps note active min (ms)')}</label>
                        <input type="number" class="ism-voice-duration" value="${v.min_note_duration != null ? v.min_note_duration : ''}" min="0" max="5000" placeholder="0">
                    </div>
                </div>
            </div>`;
        }).join('');
    };

    ISMSections._renderDrumsContent = function() {
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
            const checkedCount = catNotes.filter(function(n) { return selectedNotes.has(n); }).length;
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
                    <span class="ism-drum-note-name">${this.escape(noteNames[note] || ('Note ' + note))}</span>
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
        const totalAvailable = Object.values(cats).reduce(function(sum, c) { return sum + c.notes.length; }, 0);

        return `
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

    /**
     * Hand-position section: edit the `hands_config` JSON payload.
     * Phase 1 keyboards: always two hands (left + right), each with CC
     * number, physical note range, hand span, fingers (polyphony),
     * minimum finger interval, and mechanical travel speed. A small
     * assignment block controls how notes are split across the two
     * hands (auto / track map / pitch split).
     */
    ISMSections._renderHandsSection = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const cfg = settings.hands_config || ISMSections._defaultHandsConfig();

        const enabled = cfg.enabled !== false;
        const assignment = cfg.assignment || { mode: 'auto' };
        const hands = Array.isArray(cfg.hands) && cfg.hands.length >= 2
            ? cfg.hands
            : ISMSections._defaultHandsConfig().hands;

        const handRow = (h) => {
            const idLabel = h.id === 'left' ? '🫲 Gauche' : '🫱 Droite';
            return `
            <div class="ism-hand-row" data-hand="${h.id}">
                <h4 class="ism-hand-title">${idLabel}</h4>
                <div class="ism-form-group ism-form-grid-2">
                    <div>
                        <label>CC position</label>
                        <input type="number" class="ism-hand-cc" data-hand="${h.id}" data-field="cc_position_number"
                               value="${h.cc_position_number}" min="0" max="127">
                        <span class="ism-form-hint">Numéro de CC envoyé pour la position de main (valeur = note MIDI la plus grave).</span>
                    </div>
                    <div>
                        <label>Écart max (demi-tons)</label>
                        <input type="number" class="ism-hand-span" data-hand="${h.id}" data-field="hand_span_semitones"
                               value="${h.hand_span_semitones}" min="1" max="48">
                        <span class="ism-form-hint">Empan maximal atteignable sans déplacer la main.</span>
                    </div>
                </div>
                <div class="ism-form-group ism-form-grid-2">
                    <div>
                        <label>Note la plus grave atteignable</label>
                        <input type="number" data-hand="${h.id}" data-field="note_range_min"
                               value="${h.note_range_min ?? ''}" min="0" max="127">
                    </div>
                    <div>
                        <label>Note la plus aiguë atteignable</label>
                        <input type="number" data-hand="${h.id}" data-field="note_range_max"
                               value="${h.note_range_max ?? ''}" min="0" max="127">
                    </div>
                </div>
                <div class="ism-form-group ism-form-grid-3">
                    <div>
                        <label>Doigts</label>
                        <input type="number" data-hand="${h.id}" data-field="polyphony"
                               value="${h.polyphony ?? 5}" min="1" max="10">
                    </div>
                    <div>
                        <label>Intervalle doigt min (ms)</label>
                        <input type="number" data-hand="${h.id}" data-field="finger_min_interval_ms"
                               value="${h.finger_min_interval_ms ?? 40}" min="0" max="2000">
                    </div>
                    <div>
                        <label>Vitesse main (demi-tons/s)</label>
                        <input type="number" data-hand="${h.id}" data-field="hand_move_semitones_per_sec"
                               value="${h.hand_move_semitones_per_sec ?? 60}" min="1" max="500">
                    </div>
                </div>
            </div>`;
        };

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🫱</span> Mains</h3>
            <div class="ism-form-group">
                <label>
                    <input type="checkbox" id="handsEnabled" ${enabled ? 'checked' : ''}>
                    Activer le contrôle de position des mains
                </label>
                <span class="ism-form-hint">
                    Si activé, le lecteur envoie un CC avec la note la plus grave de la fenêtre courante de chaque main,
                    dès que la main doit se déplacer. Non-bloquant : les violations de faisabilité sont signalées à l'utilisateur.
                </span>
            </div>

            <div class="ism-form-group">
                <label>Affectation des notes aux mains</label>
                <select id="handsAssignmentMode">
                    <option value="auto" ${assignment.mode === 'auto' ? 'selected' : ''}>Auto (tracks si possibles, sinon split par hauteur)</option>
                    <option value="track" ${assignment.mode === 'track' ? 'selected' : ''}>Par piste (track map)</option>
                    <option value="pitch_split" ${assignment.mode === 'pitch_split' ? 'selected' : ''}>Split par hauteur</option>
                </select>
            </div>

            <div class="ism-form-group ism-form-grid-2">
                <div>
                    <label>Note de split (par hauteur)</label>
                    <input type="number" id="handsPitchSplitNote" value="${assignment.pitch_split_note ?? 60}" min="0" max="127">
                </div>
                <div>
                    <label>Hystérésis (demi-tons)</label>
                    <input type="number" id="handsPitchSplitHysteresis" value="${assignment.pitch_split_hysteresis ?? 2}" min="0" max="12">
                </div>
            </div>

            <div class="ism-hands-list">
                ${handRow(hands.find(h => h.id === 'left') || ISMSections._defaultHandsConfig().hands[0])}
                ${handRow(hands.find(h => h.id === 'right') || ISMSections._defaultHandsConfig().hands[1])}
            </div>
        `;
    };

    ISMSections._defaultHandsConfig = function() {
        return {
            enabled: true,
            assignment: { mode: 'auto', pitch_split_note: 60, pitch_split_hysteresis: 2 },
            hands: [
                {
                    id: 'left',  cc_position_number: 23,
                    note_range_min: 21, note_range_max: 72,
                    hand_span_semitones: 14, polyphony: 5,
                    finger_min_interval_ms: 40, hand_move_semitones_per_sec: 60
                },
                {
                    id: 'right', cc_position_number: 24,
                    note_range_min: 48, note_range_max: 108,
                    hand_span_semitones: 14, polyphony: 5,
                    finger_min_interval_ms: 40, hand_move_semitones_per_sec: 60
                }
            ]
        };
    };

    /**
     * Read the hands-section DOM back into a hands_config object ready
     * to persist. Returns `null` when the section is not rendered (the
     * instrument is not keyboard-family) — the caller stores null so the
     * feature stays disabled.
     */
    ISMSections._collectHandsConfig = function(rootEl) {
        const section = rootEl?.querySelector('.ism-section[data-section="hands"]');
        if (!section) return undefined; // no-op: section not rendered

        const enabled = !!rootEl.querySelector('#handsEnabled')?.checked;
        const mode = rootEl.querySelector('#handsAssignmentMode')?.value || 'auto';
        const pitchSplitNote = parseInt(rootEl.querySelector('#handsPitchSplitNote')?.value, 10);
        const hysteresis = parseInt(rootEl.querySelector('#handsPitchSplitHysteresis')?.value, 10);

        const readHand = (id) => {
            const row = section.querySelector(`.ism-hand-row[data-hand="${id}"]`);
            if (!row) return null;
            const readInt = (field, dflt) => {
                const v = parseInt(row.querySelector(`[data-field="${field}"]`)?.value, 10);
                return Number.isFinite(v) ? v : dflt;
            };
            const readIntOrNull = (field) => {
                const raw = row.querySelector(`[data-field="${field}"]`)?.value;
                if (raw == null || raw === '') return null;
                const v = parseInt(raw, 10);
                return Number.isFinite(v) ? v : null;
            };
            return {
                id,
                cc_position_number: readInt('cc_position_number', id === 'left' ? 23 : 24),
                hand_span_semitones: readInt('hand_span_semitones', 14),
                note_range_min: readIntOrNull('note_range_min'),
                note_range_max: readIntOrNull('note_range_max'),
                polyphony: readInt('polyphony', 5),
                finger_min_interval_ms: readInt('finger_min_interval_ms', 40),
                hand_move_semitones_per_sec: readInt('hand_move_semitones_per_sec', 60)
            };
        };

        const hands = [readHand('left'), readHand('right')].filter(Boolean);
        return {
            enabled,
            assignment: {
                mode,
                pitch_split_note: Number.isFinite(pitchSplitNote) ? pitchSplitNote : 60,
                pitch_split_hysteresis: Number.isFinite(hysteresis) ? hysteresis : 2
            },
            hands
        };
    };

    ISMSections._renderAdvancedSection = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;

        // Communication timeout
        const commTimeout = settings.comm_timeout || 5000;

        // Measure-delay button is rendered hidden; shown later if an audio input device is detected.
        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">⚙️</span> ${this.t('instrumentSettings.sectionAdvanced') || 'Avancé'}</h3>

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.syncDelay') || 'Délai de synchronisation'}</label>
                <div class="ism-delay-row">
                    <input type="number" id="syncDelay" value="${settings.sync_delay || 0}" min="-5000" max="5000">
                    <button type="button" class="btn btn-small ism-measure-delay-btn" id="measureDelayBtn" style="display:none">🎤 ${this.t('instrumentSettings.measureDelay') || 'Mesurer'}</button>
                </div>
                <span class="ism-form-hint">${this.t('instrumentSettings.syncDelayHelp') || 'Ajustement du timing en millisecondes'}</span>
            </div>

            ${tab.isBleDevice ? `
            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.macAddress') || 'Adresse MAC Bluetooth'}</label>
                <input type="text" id="macAddress" value="${this.escape(settings.mac_address || '')}" placeholder="AA:BB:CC:DD:EE:FF">
                <span class="ism-form-hint">${this.t('instrumentSettings.macAddressHelp') || 'Adresse MAC du périphérique Bluetooth'}</span>
            </div>
            ` : '<input type="hidden" id="macAddress" value="">'}

            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.commTimeout') || 'Timeout de communication (ms)'}</label>
                <input type="number" id="commTimeout" value="${commTimeout}" min="100" max="30000" step="100">
                <span class="ism-form-hint">${this.t('instrumentSettings.commTimeoutHelp') || 'Délai d\'attente maximal pour une réponse (en ms)'}</span>
            </div>

        `;
    };

    if (typeof window !== 'undefined') window.ISMSections = ISMSections;
})();
