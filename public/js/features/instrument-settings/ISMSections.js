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
     * Whether this instrument family is eligible for hand-position control.
     * Keyboard-family instruments use the semitone mode (two hands, pitch
     * split); plucked and bowed strings use the frets mode (single fretting
     * hand). Drum kits are excluded.
     */
    ISMSections._handsTabEligible = function(tab) {
        if (!tab) return false;
        const gmProgram = tab.settings?.gm_program;
        const channel = tab.channel;
        if (channel === 9) return false; // drum kit
        if (gmProgram == null) return false;
        const fam = window.InstrumentFamilies?.getFamilyForProgram(gmProgram, channel);
        if (!fam) return false;
        return fam.slug === 'keyboards'
            || fam.slug === 'chromatic_percussion'
            || fam.slug === 'organs'
            || fam.slug === 'plucked_strings'
            || fam.slug === 'bowed_strings';
    };

    /**
     * The Mains sidebar tab is shown only when the family is eligible AND
     * the user opted in via the "Gestion du déplacement des mains" toggle
     * in the Notes section (hands_config.enabled === true).
     */
    ISMSections._shouldShowHandsSection = function(tab) {
        if (!ISMSections._handsTabEligible(tab)) return false;
        return tab.settings?.hands_config?.enabled === true;
    };

    /**
     * Which hand-position mode does this instrument use?
     * Strings → 'frets' (single fretting hand). Everything else → 'semitones'.
     */
    ISMSections._handsModeForTab = function(tab) {
        const gmProgram = tab?.settings?.gm_program;
        const channel = tab?.channel;
        const fam = window.InstrumentFamilies?.getFamilyForProgram(gmProgram, channel);
        if (fam && (fam.slug === 'plucked_strings' || fam.slug === 'bowed_strings')) {
            return 'frets';
        }
        return 'semitones';
    };

    ISMSections._renderIdentitySection = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const settings = tab.settings;
        const channel = tab.channel;

        // GM category emoji (fallback when no SVG is available)
        const gmProgram = settings.gm_program;
        const catKey = this._getGmCategoryKey(gmProgram);
        const gmEmoji = catKey ? (InstrumentSettingsModal.GM_CATEGORY_EMOJIS[catKey] || '🎵') : '🎵';

        // Section-title icon: SVG of the main voice when available.
        const isIdDrumChannel = channel === 9;
        const idOffset = (typeof GM_DRUM_KIT_OFFSET !== 'undefined') ? GM_DRUM_KIT_OFFSET : 128;
        const idResolverProgram = (isIdDrumChannel && gmProgram != null && gmProgram < idOffset)
            ? (gmProgram + idOffset) : gmProgram;
        const idIcon = (window.InstrumentFamilies && window.InstrumentFamilies.resolveInstrumentIcon)
            ? window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: idResolverProgram, channel })
            : null;
        const idIconHtml = (idIcon && idIcon.slug)
            ? `<span class="ism-section-title-icon ism-section-title-icon-img">
                   <img class="ism-section-title-svg" src="${idIcon.svgUrl}" alt=""
                        onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                   <span style="display:none">${(idIcon && idIcon.emoji) || gmEmoji}</span>
               </span>`
            : `<span class="ism-section-title-icon">${(idIcon && idIcon.emoji) || gmEmoji}</span>`;

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
            <h3 class="ism-section-title">${idIconHtml} ${this.t('instrumentSettings.sectionIdentity') || 'Identité'}</h3>

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

        // CC data — the Notes tab hosts a grouped picker (accordion + active-CC
        // tags + "apply recommended" button). The hidden #supportedCCs stays in
        // sync with the checkbox state for the save path.
        const currentCCs = settings.supported_ccs
            ? (Array.isArray(settings.supported_ccs) ? settings.supported_ccs : String(settings.supported_ccs).split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return !isNaN(n); }))
            : [];
        const gmProgramForCC = settings.gm_program;
        const catKeyForCC = this._getGmCategoryKey(gmProgramForCC);
        const recommendedCCs = catKeyForCC ? (InstrumentSettingsModal.GM_RECOMMENDED_CCS[catKeyForCC] || []) : [];
        const ccAccordionHtml = this._renderCCAccordion(currentCCs, recommendedCCs);

        // Polyphony for string instruments is always pinned to the
        // number of strings (one voice per string), never user-editable
        // — the field is hidden in the Notes tab and we surface the
        // value only as a hidden input. For other families the user
        // sets it manually.
        let polyphonyVal;
        if (isString) {
            const cfgStrings = tab.stringInstrumentConfig?.num_strings;
            polyphonyVal = Number.isFinite(cfgStrings) && cfgStrings > 0 ? cfgStrings : 6;
        } else {
            polyphonyVal = settings.polyphony || '';
        }

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

        // Resolve the SVG of the main voice for the section title icon.
        const isDrumChannel = tab.channel === 9;
        const offset = (typeof GM_DRUM_KIT_OFFSET !== 'undefined') ? GM_DRUM_KIT_OFFSET : 128;
        const titleResolverProgram = (isDrumChannel && gmProgram != null && gmProgram < offset)
            ? (gmProgram + offset) : gmProgram;
        const titleIcon = (window.InstrumentFamilies && window.InstrumentFamilies.resolveInstrumentIcon)
            ? window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: titleResolverProgram, channel: tab.channel })
            : null;
        const titleIconHtml = (titleIcon && titleIcon.slug)
            ? `<span class="ism-section-title-icon ism-section-title-icon-img">
                   <img class="ism-section-title-svg" src="${titleIcon.svgUrl}" alt=""
                        onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                   <span style="display:none">${titleIcon.emoji}</span>
               </span>`
            : `<span class="ism-section-title-icon">${(titleIcon && titleIcon.emoji) || '🎹'}</span>`;

        return `
            <h3 class="ism-section-title">${titleIconHtml} ${this.t('instrumentSettings.sectionNotes') || 'Notes & Capacités'}</h3>

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
                                <button type="button"
                                        id="pianoNotationToggle"
                                        class="piano-notation-toggle"
                                        title="${this.t('instrumentSettings.toggleNotationHelp') || 'Basculer entre la notation US (C, D, E…) et la notation latine (Do, Ré, Mi…)'}">
                                    <span id="pianoNotationLabel">C / Do</span>
                                </button>
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

            ${isString ? `
            <input type="hidden" id="polyphonyInput" value="${polyphonyVal}">
            ` : `
            <div class="ism-form-group">
                <label>${this.t('instrumentSettings.polyphony') || 'Polyphonie'}</label>
                <input type="number" id="polyphonyInput" value="${polyphonyVal}" min="1" max="128" placeholder="16">
                <span class="ism-form-hint">${this.t('instrumentSettings.polyphonyHelp') || 'Nombre maximum de notes simultanées (1-128)'}</span>
            </div>
            `}

            ${(isString && !isDrum) ? `<div class="ism-subsection" id="stringsSubsection">
                <h4 class="ism-subsection-title">🎸 ${this.t('instrumentSettings.sectionStrings') || 'Instrument à cordes'}</h4>
                ${this._renderStringsContent()}
            </div>` : ''}

            ${isDrum ? `<div class="ism-subsection" id="drumsSubsection">
                <h4 class="ism-subsection-title">🥁 ${this.t('instrumentSettings.sectionDrums') || 'Percussions'}</h4>
                ${this._renderDrumsContent()}
            </div>` : ''}

            ${ISMSections._handsTabEligible(tab) ? `
            <div class="ism-subsection ism-hands-movement-card" id="handsMovementSubsection">
                <label class="ism-hands-movement-toggle" for="handsMovementEnabled">
                    <div class="ism-hands-movement-info">
                        <h4 class="ism-subsection-title" style="margin:0 0 6px 0;">🫱 ${this.t('instrumentSettings.handsMovementTitle') || 'Gestion du déplacement des mains'}</h4>
                        <p class="ism-hands-movement-desc">${this.t('instrumentSettings.handsMovementEnable') || 'Activer le déplacement des mains'}</p>
                        <p class="ism-form-hint" style="margin:4px 0 0 0;">${this.t('instrumentSettings.handsMovementHint') || 'Active l\'onglet "Mains" pour configurer la position et l\'écart maximal de chaque main. L\'affectation se fait automatiquement à la lecture.'}</p>
                    </div>
                    <span class="ism-toggle-switch">
                        <input type="checkbox" id="handsMovementEnabled" ${settings.hands_config?.enabled === true ? 'checked' : ''}>
                        <span class="ism-toggle-slider" aria-hidden="true"></span>
                    </span>
                </label>
            </div>` : ''}

            <div class="ism-subsection ism-hands-movement-card" id="pitchBendSubsection">
                <label class="ism-hands-movement-toggle" for="pitchBendEnabled">
                    <div class="ism-hands-movement-info">
                        <h4 class="ism-subsection-title" style="margin:0 0 6px 0;">🎵 ${this.t('instrumentSettings.pitchBendTitle') || 'Pitch Bend'}</h4>
                        <p class="ism-form-hint" style="margin:4px 0 0 0;">${this.t('instrumentSettings.pitchBendHint') || 'Active la roue de pitch bend et le mode slider (touches égales) dans le clavier virtuel.'}</p>
                    </div>
                    <span class="ism-toggle-switch">
                        <input type="checkbox" id="pitchBendEnabled" ${settings.pitch_bend_enabled === true ? 'checked' : ''}>
                        <span class="ism-toggle-slider" aria-hidden="true"></span>
                    </span>
                </label>
            </div>

            <div class="ism-subsection" id="timingsSubsection">
                <h4 class="ism-subsection-title">⏱️ ${this.t('instrumentSettings.sectionTimingsPerGm') || 'Temporisations par instrument GM'}</h4>
                <p class="ism-subsection-hint">${this.t('instrumentSettings.timingsPerGmHint') || 'Chaque voix GM peut avoir ses propres contraintes de timing (utile quand les instruments ont des temps de réponse différents).'}</p>
                <div id="timingsPrimaryBlock">${this._renderTimingsPrimaryBlock()}</div>
                <div id="timingsVoicesList">${this._renderVoicesSubsection()}</div>
            </div>

            <div class="ism-subsection" id="sharedCcsSubsection">
                <h4 class="ism-subsection-title">🎛️ ${this.t('instrumentSettings.supportedCcsTitle') || 'CC supportés'}</h4>
                <p class="ism-subsection-hint">${this.t('instrumentSettings.supportedCcsHint') || 'Liste partagée par toutes les voix GM de cet instrument. Les CC non gérés par un instrument sont simplement ignorés côté matériel.'}</p>
                <div class="ism-active-ccs-summary" id="activeCCsSummary">
                    ${this._renderActiveCCsSummary(currentCCs)}
                </div>
                ${recommendedCCs.length > 0 ? `<button type="button" class="btn btn-small ism-apply-recommended-ccs" id="applyRecommendedCCs">✨ ${this.t('instrumentSettings.applyRecommendedCCs') || 'Appliquer les CC recommandés'}</button>` : ''}
                ${ccAccordionHtml}
                <input type="hidden" id="supportedCCs" value="${currentCCs.join(', ')}">
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

        // Build horizontal header rows (string numbers, note badges,
        // MIDI tuning inputs). Per-string fret / position values ride
        // along in hidden inputs — the interactive editor is the neck
        // canvas below, which renders for both fretted and fretless.
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
            const fretVal = fretsPerString ? (fretsPerString[i] ?? numFrets) : numFrets;
            hiddenFretInputs += `<input type="hidden" class="si-frets-val" id="siFrets${i}"
                           data-string="${i}" value="${fretVal}">`;
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
                    <div class="si-neck-canvas-panel">
                        <canvas id="ism-neck-canvas" width="400" height="350"></canvas>
                    </div>
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
     * Hand-position section: edit the `hands_config` JSON payload. Two
     * layouts, selected by the instrument family:
     *   - Keyboards/organs/chromatic percussion → semitones mode (two
     *     hands, assignment block, span in semitones).
     *   - Plucked/bowed strings → frets mode (single fretting hand, no
     *     assignment, span in frets). Reachable range is derived at play
     *     time from the attached string_instrument's `frets_per_string`.
     */
    ISMSections._renderHandsSection = function() {
        const tab = this._getActiveTab();
        if (!tab) return '';
        const mode = ISMSections._handsModeForTab(tab);
        const settings = tab.settings;
        const cfg = settings.hands_config || ISMSections._defaultHandsConfig(mode, tab);

        // If the stored config's mode doesn't match the instrument family
        // (user changed the GM program), fall back to a fresh default for
        // the new family so the rendered form is coherent.
        const effectiveCfg = (cfg.mode === mode
            || (cfg.mode == null && mode === 'semitones'))
            ? cfg
            : ISMSections._defaultHandsConfig(mode, tab);

        if (mode === 'frets') {
            return ISMSections._renderHandsSectionFrets.call(this, effectiveCfg, tab);
        }
        return ISMSections._renderHandsSectionSemitones.call(this, effectiveCfg);
    };

    /**
     * Keyboard-family mechanism cards. Two choices, mirroring the
     * strings UI:
     *   - `aligned_fingers` (V1, default): one actuator per playable
     *     key inside the hand window. The mechanical hand slides as a
     *     block; per-finger control is implicit.
     *   - `independent_fingers_5` (V2, greyed): a 5-finger humanoid
     *     hand with independent finger reach. Reserved for V2.
     */
    const KEYBOARD_MECHANISM_SVG = {
        aligned_fingers: `
            <svg viewBox="0 0 120 80" class="ism-mech-svg" aria-hidden="true">
                <rect x="5" y="8" width="110" height="42" fill="#fafafa" stroke="#9ca3af" stroke-width="1"/>
                <line x1="20" y1="8" x2="20" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="35" y1="8" x2="35" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="50" y1="8" x2="50" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="65" y1="8" x2="65" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="80" y1="8" x2="80" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="95" y1="8" x2="95" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <rect x="22" y="8" width="11" height="24" fill="#1f2937"/>
                <rect x="52" y="8" width="11" height="24" fill="#1f2937"/>
                <rect x="67" y="8" width="11" height="24" fill="#1f2937"/>
                <rect x="82" y="8" width="11" height="24" fill="#1f2937"/>
                <line x1="22" y1="38" x2="22" y2="58" stroke="#15803d" stroke-width="3" stroke-linecap="round"/>
                <line x1="42" y1="38" x2="42" y2="58" stroke="#15803d" stroke-width="3" stroke-linecap="round"/>
                <line x1="58" y1="38" x2="58" y2="58" stroke="#15803d" stroke-width="3" stroke-linecap="round"/>
                <line x1="78" y1="38" x2="78" y2="58" stroke="#15803d" stroke-width="3" stroke-linecap="round"/>
                <line x1="98" y1="38" x2="98" y2="58" stroke="#15803d" stroke-width="3" stroke-linecap="round"/>
                <rect x="14" y="58" width="92" height="10" fill="#22c55e" fill-opacity="0.28" stroke="#16a34a" stroke-width="1.5" rx="2"/>
            </svg>
        `,
        independent_fingers_5: `
            <svg viewBox="0 0 120 80" class="ism-mech-svg" aria-hidden="true">
                <rect x="5" y="8" width="110" height="42" fill="#fafafa" stroke="#9ca3af" stroke-width="1"/>
                <line x1="20" y1="8" x2="20" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="35" y1="8" x2="35" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="50" y1="8" x2="50" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="65" y1="8" x2="65" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="80" y1="8" x2="80" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <line x1="95" y1="8" x2="95" y2="50" stroke="#9ca3af" stroke-width="0.7"/>
                <rect x="22" y="8" width="11" height="24" fill="#1f2937"/>
                <rect x="52" y="8" width="11" height="24" fill="#1f2937"/>
                <rect x="67" y="8" width="11" height="24" fill="#1f2937"/>
                <line x1="60" y1="74" x2="22" y2="40" stroke="#16a34a" stroke-width="4" stroke-linecap="round"/>
                <line x1="60" y1="74" x2="42" y2="36" stroke="#16a34a" stroke-width="4" stroke-linecap="round"/>
                <line x1="60" y1="74" x2="60" y2="34" stroke="#16a34a" stroke-width="4" stroke-linecap="round"/>
                <line x1="60" y1="74" x2="78" y2="36" stroke="#16a34a" stroke-width="4" stroke-linecap="round"/>
                <line x1="60" y1="74" x2="98" y2="40" stroke="#16a34a" stroke-width="4" stroke-linecap="round"/>
                <circle cx="22" cy="40" r="3" fill="#15803d"/>
                <circle cx="42" cy="36" r="3" fill="#15803d"/>
                <circle cx="60" cy="34" r="3" fill="#15803d"/>
                <circle cx="78" cy="36" r="3" fill="#15803d"/>
                <circle cx="98" cy="40" r="3" fill="#15803d"/>
                <circle cx="60" cy="74" r="3.5" fill="#15803d"/>
            </svg>
        `
    };

    /**
     * Build a translator that resolves keys through the modal's `this.t`
     * when available, or directly through `window.i18n` otherwise, and
     * falls back to a caller-supplied default string when neither hits.
     * Critically, when both lookups miss it returns the fallback (or an
     * empty string), NEVER the raw dot-path — that would surface in the
     * UI as `instrumentSettings.handsLeft` which we saw in production.
     *
     * Usage: `const t = ISMSections._tHelper(this); t('key', 'fallback')`.
     * @private
     */
    ISMSections._tHelper = function(ctx) {
        return function(key, fallback) {
            // 1) Modal's bound t() (preferred — also handles params).
            if (ctx && typeof ctx.t === 'function') {
                const v = ctx.t(key);
                if (typeof v === 'string' && v !== key) return v;
            }
            // 2) Direct window.i18n lookup (covers cases where the section
            //    is rendered with a non-modal `this`).
            if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
                const v = window.i18n.t(key);
                if (typeof v === 'string' && v !== key) return v;
            }
            // 3) Fallback string from the caller, or empty when none.
            return fallback != null ? fallback : '';
        };
    };

    ISMSections._getKeyboardMechanisms = function(ctx) {
        const t = ISMSections._tHelper(ctx);
        return [
            {
                id: 'aligned_fingers',
                label: t('instrumentSettings.handsKeyboardMechAlignedLabel', 'Doigts alignés sur les touches'),
                description: t('instrumentSettings.handsKeyboardMechAlignedDesc',
                    "Un actionneur par touche dans la fenêtre de la main. La main glisse en bloc, l'écart configuré ci-dessous fixe le nombre de touches couvertes."),
                svg: KEYBOARD_MECHANISM_SVG.aligned_fingers,
                v2: false
            },
            {
                id: 'independent_fingers_5',
                label: t('instrumentSettings.handsKeyboardMech5FingersLabel', '5 doigts robotiques indépendants'),
                description: t('instrumentSettings.handsKeyboardMech5FingersDesc',
                    "Main humanoïde avec 5 doigts à course indépendante (accords arbitraires, doigts non adjacents). Mécanisme prévu pour la V2."),
                svg: KEYBOARD_MECHANISM_SVG.independent_fingers_5,
                v2: true
            }
        ];
    };

    /**
     * Render the keyboard mechanism cards (V1 aligned, V2 grayed).
     * Mirrors `_renderMechanismCards` for strings; the listener at
     * ISMListeners._attachMechanismCardListeners drives the click
     * behaviour via `[data-mechanism]` attributes.
     */
    ISMSections._renderKeyboardMechanismCards = function(selectedId) {
        const mechanisms = ISMSections._getKeyboardMechanisms(this);
        const t = ISMSections._tHelper(this);
        const cardHtml = (m) => {
            const isSelected = m.id === selectedId;
            const disabled = !!m.v2;
            const stateClass = disabled ? 'ism-mech-card-disabled' : (isSelected ? 'ism-mech-card-active' : '');
            const dataAttr = disabled
                ? 'data-mechanism-disabled="1"'
                : `data-mechanism="${m.id}"`;
            const badge = disabled
                ? `<span class="ism-mech-card-badge">V2</span>`
                : '';
            return `
                <button type="button" class="ism-mech-card ${stateClass}" ${dataAttr}
                        ${disabled ? 'disabled aria-disabled="true"' : ''}>
                    ${badge}
                    <span class="ism-mech-card-illu">${m.svg || ''}</span>
                    <span class="ism-mech-card-title">${m.label}</span>
                    <span class="ism-mech-card-desc">${m.description}</span>
                </button>
            `;
        };
        return `
            <div class="ism-form-group">
                <h4 class="ism-subsection-title" style="margin-top:0">🛠️ ${t('instrumentSettings.handsMechanismTitle') || 'Type de mécanisme'}</h4>
                <p class="ism-form-hint" style="margin-bottom:8px">
                    ${t('instrumentSettings.handsKeyboardMechanismHint') || 'Choisissez la mécanique des mains du clavier — détermine les paramètres de doigts affichés ci-dessous.'}
                </p>
                <div class="ism-mech-cards" role="radiogroup" aria-label="${t('instrumentSettings.handsMechanismTitle') || 'Type de mécanisme'}">
                    ${mechanisms.map(cardHtml).join('')}
                </div>
            </div>
        `;
    };

    /**
     * Resolve the active mechanism for a semitones-mode hands_config.
     * Defaults to `aligned_fingers` when missing or set to a V2 value
     * so the rendered form always corresponds to a runnable mechanism.
     * @private
     */
    ISMSections._resolveKeyboardMechanism = function(cfg) {
        const VALID = new Set(['aligned_fingers']);
        if (cfg && VALID.has(cfg.mechanism)) return cfg.mechanism;
        return 'aligned_fingers';
    };

    ISMSections._renderHandsSectionSemitones = function(cfg) {
        const t = ISMSections._tHelper(this);
        // Resolve the active hand count from the persisted config; default
        // to 2 (legacy two-hand keyboards). New configs may carry 1, 3 or 4
        // hands; we cap at 4 so a malformed payload can never blow up the
        // form into an unbounded list.
        const rawHands = Array.isArray(cfg.hands) ? cfg.hands : [];
        const count = Math.max(1, Math.min(4, rawHands.length || 2));
        const hands = ISMSections._resizeSemitonesHands(rawHands, count);
        const commonSpeed = Number.isFinite(cfg.hand_move_semitones_per_sec)
            ? cfg.hand_move_semitones_per_sec
            : 60;
        const mechanism = ISMSections._resolveKeyboardMechanism(cfg);

        // Keyboard layout type. `chromatic` means every semitone is a
        // playable key (xylophone-like): a finger maps to one note, so
        // span = num_fingers − 1 and we hide the span input. `piano`
        // means white + black keys, so a 5-finger hand on C..G already
        // stretches across 7 semitones — the operator picks the span
        // explicitly because it doesn't have a closed-form expression
        // for arbitrary finger placements.
        const keyboardType = cfg.keyboard_type === 'piano' ? 'piano' : 'chromatic';

        const handRow = (h, index) => {
            const idLabel = ISMSections._handLabel(index, count, t);
            // V1 'aligned_fingers': span is always derived automatically
            // from num_fingers at save time (chromatic: span = f−1;
            // piano: span ≈ f×2). The span input is hidden for all
            // aligned-finger instruments — only 'Number of fingers' is shown.
            // V2 'independent_fingers_5' (not yet released) always
            // exposes both fields because the fingers can stretch
            // within a wider window even on chromatic instruments.
            const isAligned = mechanism === 'aligned_fingers';
            const hideSpanField = isAligned;
            const numFingers = Number.isFinite(h.num_fingers)
                ? h.num_fingers
                : (Number.isFinite(h.hand_span_semitones) ? h.hand_span_semitones + 1 : 5);
            const span = Number.isFinite(h.hand_span_semitones)
                ? h.hand_span_semitones
                : Math.max(0, numFingers - 1);
            const fingersField = `
                <div>
                    <label>${t('instrumentSettings.handsNumFingers') || 'Nombre de doigts'}</label>
                    <input type="number" class="ism-hand-fingers" data-hand="${h.id}" data-field="num_fingers"
                           value="${numFingers}" min="1" max="16">
                    <span class="ism-form-hint">${
                        hideSpanField
                            ? (t('instrumentSettings.handsNumFingersAlignedHint')
                               || 'Doigts alignés sur des notes consécutives — détermine aussi la plage jouable sans bouger.')
                            : (t('instrumentSettings.handsNumFingersHint')
                               || 'Nombre de touches simultanément actionnables par cette main (limite la polyphonie côté main).')
                    }</span>
                </div>`;
            const spanField = hideSpanField ? '' : `
                <div>
                    <label>${t('instrumentSettings.handsSpanSemitones') || 'Écart max sans bouger (demi-tons)'}</label>
                    <input type="number" class="ism-hand-span" data-hand="${h.id}" data-field="hand_span_semitones"
                           value="${span}" min="1" max="48">
                    <span class="ism-form-hint">${t('instrumentSettings.handsSpanSemitonesHint') || 'Intervalle de notes jouables sans déplacer la main.'}</span>
                </div>`;
            return `
            <div class="ism-hand-row" data-hand="${h.id}" data-hand-index="${index}">
                <h4 class="ism-hand-title">${idLabel}</h4>
                <div class="ism-form-group ism-form-grid-2">
                    <div>
                        <label>${t('instrumentSettings.handsCcPosition') || 'CC position'}</label>
                        <input type="number" class="ism-hand-cc" data-hand="${h.id}" data-field="cc_position_number"
                               value="${h.cc_position_number}" min="0" max="127">
                        <span class="ism-form-hint">${t('instrumentSettings.handsCcPositionHint') || "Numéro de CC envoyé pour la position de main (valeur = note MIDI la plus grave)."}</span>
                    </div>
                    ${fingersField}
                </div>
                ${spanField ? `<div class="ism-form-group ism-form-grid-2">${spanField}<div></div></div>` : ''}
            </div>`;
        };

        const countOptions = [1, 2, 3, 4]
            .map(n => `<option value="${n}" ${n === count ? 'selected' : ''}>${n}</option>`)
            .join('');

        // Note range for the preview keyboard. Read from the tab when the
        // modal instance is available (this = modal); fall back to a 3-octave
        // default so the preview is still useful before the user sets a range.
        const _previewTab = typeof this?._getActiveTab === 'function' ? this._getActiveTab() : null;
        const previewRangeMin = Number.isFinite(_previewTab?.settings?.note_range_min)
            ? _previewTab.settings.note_range_min : 36;
        const previewRangeMax = Number.isFinite(_previewTab?.settings?.note_range_max)
            ? _previewTab.settings.note_range_max : 84;

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🫱</span> ${t('instrumentSettings.sectionHands') || 'Mains'}</h3>
            <input type="hidden" id="handsMode" value="semitones">
            <input type="hidden" id="handsEnabled" value="1">
            <input type="hidden" id="handsMechanismInput" value="${mechanism}">
            <p class="ism-form-hint" style="margin: 0 0 16px 0;">
                ${t('instrumentSettings.handsSemitonesIntro') || 'Le lecteur envoie un CC avec la note la plus grave de la fenêtre courante de chaque main, dès que la main doit se déplacer.'}
            </p>

            ${ISMSections._renderKeyboardMechanismCards.call(this, mechanism)}

            <div class="ism-form-group">
                <label>${t('instrumentSettings.keyboardType') || 'Type de clavier'}</label>
                <select id="handsKeyboardType">
                    <option value="chromatic" ${keyboardType === 'chromatic' ? 'selected' : ''}>${
                        t('instrumentSettings.keyboardTypeChromatic') || 'Chromatique (notes contiguës)'}</option>
                    <option value="piano" ${keyboardType === 'piano' ? 'selected' : ''}>${
                        t('instrumentSettings.keyboardTypePiano') || 'Piano (touches blanches + noires)'}</option>
                </select>
                <span class="ism-form-hint">${t('instrumentSettings.keyboardTypeHint') || 'Chromatique : un doigt = une note (xylophone). Piano : la main couvre plus de demi-tons que de doigts (les noires entre les blanches).'}</span>
            </div>

            <div class="ism-form-group">
                <label>${t('instrumentSettings.handsCount') || 'Nombre de mains'}</label>
                <select id="handsCount">${countOptions}</select>
                <span class="ism-form-hint">${t('instrumentSettings.handsCountHint') || "1 à 4 mains. Par défaut 2 (piano à 4 mains : choisir 4 pour deux pianistes)."}</span>
            </div>

            <div class="ism-form-group">
                <label>${t('instrumentSettings.handsMoveSpeedSemitones') || 'Vitesse de déplacement (demi-tons/s)'}</label>
                <input type="number" id="handsMoveSpeed" value="${commonSpeed}" min="1" max="500">
                <span class="ism-form-hint">${t('instrumentSettings.handsMoveSpeedHint') || 'Vitesse commune à toutes les mains, utilisée pour signaler les déplacements trop rapides.'}</span>
            </div>

            <div class="ism-hands-preview-block">
                <span class="ism-preview-label">${t('instrumentSettings.handsPreviewLabel') || 'Aperçu de la position des doigts'}</span>
                <div class="ism-hands-kb-host"
                     data-range-min="${previewRangeMin}"
                     data-range-max="${previewRangeMax}"
                     data-keyboard-type="${keyboardType}">
                    <canvas id="ismHandsKbCanvas" class="ism-hands-kb-canvas"></canvas>
                    <canvas id="ismHandsFingersCanvas" class="ism-hands-fingers-canvas"></canvas>
                </div>
            </div>

            <div class="ism-hands-list">
                ${hands.map((h, i) => handRow(h, i)).join('')}
            </div>

            <p class="ism-form-hint" style="margin-top: 12px; padding: 10px 12px; background: rgba(99,102,241,0.06); border-left: 3px solid #6366f1; border-radius: 4px;">
                ℹ️ ${t('instrumentSettings.handsAutoAssignmentInfo') || "L'affectation des notes aux mains se fait automatiquement en fonction des pistes et de l'écart maximal — la note de split et l'hystérésis sont calculées au moment de la lecture. Vous pourrez ajuster manuellement chaque note via l'éditeur."}
            </p>
        `;
    };

    /**
     * Approximate the number of frets a hand of `handSpanMm` covers when
     * anchored at fret `p`, on a scale of `L` mm. Uses equal-temperament
     * geometry: distance(a, b) = L · (2^(−a/12) − 2^(−b/12)). Returns
     * Infinity when the hand reaches past the bridge from `p`.
     */
    ISMSections._approxFretsAt = function(L, handSpanMm, p) {
        if (!Number.isFinite(L) || !Number.isFinite(handSpanMm) || L <= 0 || handSpanMm <= 0) return null;
        const term = Math.pow(2, -p / 12) - handSpanMm / L;
        if (term <= 0) return Infinity;
        return -12 * Math.log2(term) - p;
    };

    /**
     * Map an approximate-fret-coverage value to a CSS color. Red means
     * tight coverage (≤ ~2 frets, common at the nut), green means
     * comfortable (> ~5 frets, far up the neck). Tuned for an 80 mm
     * hand on a 650 mm scale; the gradient still reads correctly on
     * shorter or longer scales because the scale only changes the
     * absolute number of frets, not their relative comfort.
     */
    ISMSections._coverageColor = function(approxFrets) {
        if (!Number.isFinite(approxFrets)) return '#6b7280'; // gray when unknown
        // Soft gradient: ≤2 → red, 3 → orange, 4 → amber, ≥5 → green.
        if (approxFrets >= 6) return '#16a34a';
        if (approxFrets >= 5) return '#65a30d';
        if (approxFrets >= 4) return '#ca8a04';
        if (approxFrets >= 3) return '#ea580c';
        return '#dc2626';
    };

    /**
     * Paint a fret-coverage heat-map onto a `<canvas>` already in the
     * DOM. Each column corresponds to a fret position; its colour
     * encodes how many frets the configured hand can reach when
     * anchored there. Re-callable: clears the canvas first so an
     * input change just yields a fresh paint.
     *
     * @param {HTMLCanvasElement} canvas
     * @param {number} scaleLengthMm
     * @param {number} handSpanMm
     * @param {number} [maxFrets=22]
     */
    ISMSections._drawCoverageHeatmap = function(canvas, scaleLengthMm, handSpanMm, maxFrets) {
        if (!canvas || typeof canvas.getContext !== 'function') return;
        if (!Number.isFinite(scaleLengthMm) || !Number.isFinite(handSpanMm)) return;
        if (scaleLengthMm <= 0 || handSpanMm <= 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const cssWidth = canvas.clientWidth || canvas.width;
        const cssHeight = canvas.clientHeight || canvas.height;
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
            canvas.width = Math.round(cssWidth * dpr);
            canvas.height = Math.round(cssHeight * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const N = Math.max(1, maxFrets || 22);
        const w = cssWidth;
        const h = cssHeight;
        const cellW = w / N;

        // Background.
        ctx.fillStyle = '#f3f4f6';
        ctx.fillRect(0, 0, w, h);

        // One column per anchor fret (1..N). Fret 0 (open) doesn't
        // anchor a hand window so we skip it visually but keep the
        // x-axis aligned with fret-number labels.
        for (let p = 1; p <= N; p++) {
            const reach = ISMSections._approxFretsAt(scaleLengthMm, handSpanMm, p);
            ctx.fillStyle = ISMSections._coverageColor(reach);
            ctx.fillRect((p - 1) * cellW, 4, cellW - 1, h - 18);
        }

        // Fret-number labels every 5 frets.
        ctx.fillStyle = '#374151';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        for (let p = 0; p <= N; p++) {
            if (p % 5 !== 0) continue;
            const x = p * cellW;
            ctx.fillText(String(p), x, h - 2);
        }
    };

    /**
     * Build the live coverage hint shown alongside the mm input. Three
     * positions (1, 7, 14) give a feel for how the same physical hand
     * width covers more frets up the neck — this is the property that
     * motivated the physical model in the first place.
     *
     * Kept as a helper for downstream consumers that still want the
     * raw text (e.g. tooltips), even though the Main tab no longer
     * displays the line — it was deemed not easily understandable.
     */
    ISMSections._fretCoverageHint = function(L, handSpanMm) {
        const fmt = (n) => Number.isFinite(n) ? n.toFixed(1) : '∞';
        return [1, 7, 14]
            .map(p => `fr.${p}: ~${fmt(ISMSections._approxFretsAt(L, handSpanMm, p))}`)
            .join(' · ');
    };

    /**
     * Render the 3 mechanism cards at the top of the Main tab.
     *   - `string_sliding_fingers` (V1, default)
     *   - `fret_sliding_fingers`   (V1)
     *   - `independent_fingers`    (V2, greyed, not clickable)
     *
     * `selectedId` is the currently active mechanism. The user must
     * pick a mechanism before any per-mechanism form is rendered, so
     * it must always be defined when the section is mounted.
     *
     * @private
     */
    /**
     * Build the strings-family mechanism list with translated label
     * + description. The raw MECHANISMS array in StringInstrumentPresets
     * carries French copy by historical accident; this layer overrides
     * label/description through i18n so every locale gets the right
     * text without touching the data file.
     * @private
     */
    ISMSections._getStringMechanisms = function(ctx) {
        const mechanisms = (window.StringInstrumentPresets && window.StringInstrumentPresets.MECHANISMS) || [];
        const t = ISMSections._tHelper(ctx);
        const overrides = {
            string_sliding_fingers: {
                labelKey: 'instrumentSettings.handsStringMechStringSlidingLabel',
                descKey: 'instrumentSettings.handsStringMechStringSlidingDesc'
            },
            fret_sliding_fingers: {
                labelKey: 'instrumentSettings.handsStringMechFretSlidingLabel',
                descKey: 'instrumentSettings.handsStringMechFretSlidingDesc'
            },
            independent_fingers: {
                labelKey: 'instrumentSettings.handsStringMechIndependentLabel',
                descKey: 'instrumentSettings.handsStringMechIndependentDesc'
            }
        };
        return mechanisms.map(m => {
            const ov = overrides[m.id];
            if (!ov) return m;
            return {
                ...m,
                label: t(ov.labelKey, m.label),
                description: t(ov.descKey, m.description)
            };
        });
    };

    ISMSections._renderMechanismCards = function(selectedId) {
        const mechanisms = ISMSections._getStringMechanisms(this);
        if (mechanisms.length === 0) return '';
        const t = ISMSections._tHelper(this);

        const cardHtml = (m) => {
            const isSelected = m.id === selectedId;
            const disabled = !!m.v2;
            const stateClass = disabled ? 'ism-mech-card-disabled' : (isSelected ? 'ism-mech-card-active' : '');
            const dataAttr = disabled
                ? 'data-mechanism-disabled="1"'
                : `data-mechanism="${m.id}"`;
            const badge = disabled
                ? `<span class="ism-mech-card-badge">V2</span>`
                : '';
            const svg = m.svg || '';
            return `
                <button type="button" class="ism-mech-card ${stateClass}" ${dataAttr}
                        ${disabled ? 'disabled aria-disabled="true"' : ''}>
                    ${badge}
                    <span class="ism-mech-card-illu">${svg}</span>
                    <span class="ism-mech-card-title">${m.label}</span>
                    <span class="ism-mech-card-desc">${m.description}</span>
                </button>
            `;
        };

        const title = t('instrumentSettings.handsMechanismTitle', 'Type de mécanisme');
        const hint = t('instrumentSettings.handsStringMechanismHint',
            'À choisir en premier — détermine la logique de sélection des frettes et les paramètres affichés ci-dessous.');
        return `
            <div class="ism-form-group">
                <h4 class="ism-subsection-title" style="margin-top:0">🛠️ ${title}</h4>
                <p class="ism-form-hint" style="margin-bottom:8px">${hint}</p>
                <div class="ism-mech-cards" role="radiogroup" aria-label="${title}">
                    ${mechanisms.map(cardHtml).join('')}
                </div>
            </div>
        `;
    };

    /**
     * Geometry block: preset picker (filtered by the instrument's
     * family) plus the three editable fields scale_length_mm,
     * num_strings, num_frets. These mirror tab.stringInstrumentConfig
     * (which is the source of truth in the DB) so the user can refine
     * the preset for non-standard instruments.
     *
     * @private
     */
    ISMSections._renderGeometrySection = function(tab) {
        const cfg = tab?.stringInstrumentConfig || {};
        const scaleLengthMm = Number.isFinite(cfg.scale_length_mm) ? cfg.scale_length_mm : '';
        const numStrings = Number.isFinite(cfg.num_strings) ? cfg.num_strings : '';
        const numFrets = Number.isFinite(cfg.num_frets) ? cfg.num_frets : '';

        const gmProgram = tab?.settings?.gm_program;
        const channel = tab?.channel;
        const family = window.InstrumentFamilies?.getFamilyForProgram?.(gmProgram, channel);
        const familySlug = family?.slug || null;

        let presets = [];
        const SIP = window.StringInstrumentPresets;
        if (SIP) {
            // Prefer the GM-program-specific presets (most accurate);
            // fall back to family-wide so the dropdown is never empty.
            const byProgram = SIP.filterPresetsByGmProgram(gmProgram);
            presets = byProgram.length > 0 ? byProgram : SIP.filterPresetsByFamily(familySlug);
        }

        const t = ISMSections._tHelper(this);
        const customLabel = t('instrumentSettings.handsGeometryPresetCustom', '— Personnalisé —');
        const presetOptions = [`<option value="">${customLabel}</option>`]
            .concat(presets.map(p =>
                `<option value="${p.id}"
                         data-num-strings="${p.num_strings}"
                         data-scale-length-mm="${p.scale_length_mm}"
                         data-num-frets="${p.num_frets}"
                         data-default-mechanism="${p.default_mechanism}">${p.label}</option>`
            ))
            .join('');

        return `
            <div class="ism-form-group">
                <h4 class="ism-subsection-title" style="margin-top:0">📏 ${t('instrumentSettings.handsGeometryTitle', "Géométrie de l'instrument")}</h4>
                <p class="ism-form-hint" style="margin-bottom:8px">
                    ${t('instrumentSettings.handsGeometryHint', 'Sélectionnez un preset proche de votre instrument pour pré-remplir la géométrie. Tous les champs restent éditables.')}
                </p>
                <div class="ism-form-group">
                    <label for="handsGeometryPreset">${t('instrumentSettings.handsGeometryPresetLabel', 'Preset')}</label>
                    <select id="handsGeometryPreset">${presetOptions}</select>
                </div>
                <div class="ism-form-group ism-form-grid-3">
                    <div>
                        <label for="handsGeometryScaleLength">${t('instrumentSettings.handsGeometryScaleLengthLabel', 'Longueur de corde (mm)')}</label>
                        <input type="number" id="handsGeometryScaleLength"
                               value="${scaleLengthMm}" min="100" max="2000">
                    </div>
                    <div>
                        <label for="handsGeometryNumStrings">${t('instrumentSettings.handsGeometryNumStringsLabel', 'Nombre de cordes')}</label>
                        <input type="number" id="handsGeometryNumStrings"
                               value="${numStrings}" min="1" max="64">
                    </div>
                    <div>
                        <label for="handsGeometryNumFrets">${t('instrumentSettings.handsGeometryNumFretsLabel', 'Nombre de frettes')}</label>
                        <input type="number" id="handsGeometryNumFrets"
                               value="${numFrets}" min="0" max="36">
                        <span class="ism-form-hint">${t('instrumentSettings.handsGeometryNumFretsHint', '0 pour les instruments sans frettes (violon, alto, …).')}</span>
                    </div>
                </div>
            </div>
        `;
    };

    /**
     * Per-mechanism form. The shape of the inputs depends on the
     * selected mechanism — string_sliding_fingers exposes the existing
     * mm-based reach + max_fingers; fret_sliding_fingers replaces
     * max_fingers with num_fingers + variable_height_fingers_count.
     *
     * Legacy fret-fallback fields (hand_span_frets, hand_move_frets_per_sec)
     * are written as hidden inputs so the round-trip still preserves
     * any pre-migration value — the new UI never lets the user edit
     * them, per the "no fallbacks, force the user or pre-fill" UX rule.
     *
     * @private
     */
    ISMSections._renderMechanismForm = function(mechanism, cfg, tab) {
        const defaults = ISMSections._defaultHandsConfig('frets', tab);
        const hand = (Array.isArray(cfg.hands) && cfg.hands[0])
            ? cfg.hands[0]
            : defaults.hands[0];

        const numStrings = tab?.stringInstrumentConfig?.num_strings ?? null;
        const handSpanMm = Number.isFinite(hand.hand_span_mm) ? hand.hand_span_mm : 80;
        const moveMmPerSec = Number.isFinite(cfg.hand_move_mm_per_sec) ? cfg.hand_move_mm_per_sec : 250;
        const fingerMoveMmPerSec = Number.isFinite(cfg.finger_move_mm_per_sec) ? cfg.finger_move_mm_per_sec : 800;

        const maxFingersDefault = Number.isFinite(numStrings) ? numStrings : 6;
        const maxFingers = Number.isFinite(hand.max_fingers) ? hand.max_fingers : maxFingersDefault;
        const maxFingersUpper = Number.isFinite(numStrings) ? numStrings : 12;

        const numFingers = Number.isFinite(hand.num_fingers) ? hand.num_fingers : 4;
        const variableHeightFingers = Number.isFinite(hand.variable_height_fingers_count)
            ? hand.variable_height_fingers_count
            : 0;

        // Legacy fret-fallback values preserved as hidden inputs only.
        const handSpanFrets = Number.isFinite(hand.hand_span_frets) ? hand.hand_span_frets : 4;
        const moveFretsPerSec = Number.isFinite(cfg.hand_move_frets_per_sec) ? cfg.hand_move_frets_per_sec : 12;

        const t = ISMSections._tHelper(this);

        const ccRow = `
            <div class="ism-form-group ism-form-grid-2">
                <div>
                    <label>${t('instrumentSettings.handsCcPosition', 'CC position')}</label>
                    <input type="number" class="ism-hand-cc" data-hand="fretting" data-field="cc_position_number"
                           value="${hand.cc_position_number}" min="0" max="127">
                    <span class="ism-form-hint">${t('instrumentSettings.handsFretsCcPositionHint', 'CC envoyé. Valeur = frette absolue la plus basse (capo inclus).')}</span>
                </div>
                <div></div>
            </div>
            <input type="hidden" id="handsMoveMmPerSec" value="${moveMmPerSec}">
            <input type="hidden" id="handsFingerMoveMmPerSec" value="${fingerMoveMmPerSec}">
        `;

        let mechanismFields = '';
        if (mechanism === 'string_sliding_fingers') {
            mechanismFields = `
                <div class="ism-form-group ism-form-grid-2">
                    <div>
                        <label>${t('instrumentSettings.handsMaxFingers', 'Nombre de doigts / frettes contrôlables')}</label>
                        <input type="number" class="ism-hand-fingers" data-hand="fretting" data-field="max_fingers"
                               value="${maxFingers}" min="1" max="${maxFingersUpper}">
                        <span class="ism-form-hint">${t('instrumentSettings.handsMaxFingersHint', 'Nombre maximal de cordes pouvant être pressées simultanément.')}</span>
                    </div>
                    <div></div>
                </div>
                <div class="ism-form-group ism-form-grid-2">
                    <div>
                        <label>${t('instrumentSettings.handsSpanMm', 'Largeur de la main (mm)')}</label>
                        <input type="number" data-hand="fretting" data-field="hand_span_mm"
                               value="${handSpanMm}" min="30" max="200">
                        <span class="ism-form-hint">${t('instrumentSettings.handsSpanMmHint', 'Portée physique de la main le long des cordes. Détermine combien de frettes sont accessibles sans déplacer la main.')}</span>
                    </div>
                    <div></div>
                </div>
            `;
        } else if (mechanism === 'fret_sliding_fingers') {
            mechanismFields = `
                <div class="ism-form-group ism-form-grid-2">
                    <div>
                        <label>${t('instrumentSettings.handsFretSlidingNumFingers', 'Nombre de doigts / frettes contrôlables')}</label>
                        <input type="number" data-hand="fretting" data-field="num_fingers"
                               value="${numFingers}" min="1" max="8">
                        <span class="ism-form-hint">${t('instrumentSettings.handsFretSlidingNumFingersHint', 'Chaque doigt est positionné à un offset de frette fixe et glisse entre les cordes.')}</span>
                    </div>
                    <div></div>
                </div>
                <input type="hidden" data-hand="fretting" data-field="variable_height_fingers_count"
                       value="${variableHeightFingers}">
                <input type="hidden" data-hand="fretting" data-field="hand_span_mm" value="${handSpanMm}">
            `;
        }

        return `
            <div class="ism-hands-list">
                <div class="ism-hand-row" data-hand="fretting">
                    <h4 class="ism-hand-title">🎸 ${t('instrumentSettings.handsFrettingHandTitle', 'Main de jeu')}</h4>
                    ${ccRow}
                    ${mechanismFields}
                    <input type="hidden" data-hand="fretting" data-field="hand_span_frets" value="${handSpanFrets}">
                    <input type="hidden" id="handsMoveSpeed" value="${moveFretsPerSec}">
                </div>
            </div>
        `;
    };

    /**
     * Resolve the active mechanism for a frets-mode hands_config.
     * Defaults to `string_sliding_fingers` when missing so legacy rows
     * keep their pre-migration behaviour exactly.
     * @private
     */
    ISMSections._resolveMechanism = function(cfg) {
        const VALID = new Set(['string_sliding_fingers', 'fret_sliding_fingers']);
        if (cfg && VALID.has(cfg.mechanism)) return cfg.mechanism;
        return 'string_sliding_fingers';
    };

    ISMSections._renderHandsSectionFrets = function(cfg, tab) {
        const enabled = cfg.enabled !== false;
        const mechanism = ISMSections._resolveMechanism(cfg);
        const t = ISMSections._tHelper(this);

        const scaleLengthMm = tab?.stringInstrumentConfig?.scale_length_mm ?? null;
        const physicalAvailable = Number.isFinite(scaleLengthMm) && scaleLengthMm > 0;

        const physicalBanner = physicalAvailable ? '' : `
            <div class="ism-form-group">
                <span class="ism-form-hint" style="background:#fff8e1;padding:8px;border-radius:4px;display:block">
                    ⚠ ${t('instrumentSettings.handsFretsNoScaleWarning', 'Aucune longueur de corde renseignée. Choisissez un preset ci-dessous ou saisissez la longueur manuellement pour activer le modèle physique (mm).')}
                </span>
            </div>
        `;

        return `
            <h3 class="ism-section-title"><span class="ism-section-title-icon">🎸</span> ${t('instrumentSettings.handsFrettingHandTitle', 'Main de jeu')}</h3>
            <input type="hidden" id="handsMode" value="frets">
            <input type="hidden" id="handsMechanismInput" value="${mechanism}">
            <input type="hidden" id="handsPhysicalAvailable" value="${physicalAvailable ? '1' : '0'}">
            <div class="ism-form-group">
                <label>
                    <input type="checkbox" id="handsEnabled" ${enabled ? 'checked' : ''}>
                    ${t('instrumentSettings.handsFretsEnableLabel', 'Activer le contrôle de position de la main')}
                </label>
                <span class="ism-form-hint">
                    ${t('instrumentSettings.handsFretsEnableHint', 'Si activé, le lecteur envoie un CC avec la frette absolue la plus basse de la fenêtre dès que la main doit se déplacer.')}
                </span>
            </div>

            ${ISMSections._renderMechanismCards.call(this, mechanism)}

            ${ISMSections._renderGeometrySection.call(this, tab)}

            ${physicalBanner}

            ${ISMSections._renderMechanismForm.call(this, mechanism, cfg, tab)}
        `;
    };

    /**
     * Build the canonical hand id for a given index in the new scheme:
     * `h1`, `h2`, `h3`, `h4`. Legacy configs may still carry `left`/`right`
     * — readers tolerate them but new payloads use the numbered scheme so
     * 1‑hand and 3‑/4‑hand configs have a coherent id space.
     */
    ISMSections._handIdAt = function(index) {
        return `h${index + 1}`;
    };

    /**
     * Compute a default semitones hand entry. CC numbers are spread starting
     * at 23 so a 4‑hand piano consumes 23/24/25/26 by default — operators
     * can override per-hand in the form.
     */
    ISMSections._defaultSemitonesHand = function(index) {
        // V1 default mechanism is `aligned_fingers`: 5 fingers on 5
        // consecutive semitones, so span = num_fingers − 1 = 4. The
        // V2 form (independent_fingers_5) overrides span via its own
        // input, so this default is harmless when the user picks V2.
        return {
            id: ISMSections._handIdAt(index),
            cc_position_number: 23 + index,
            num_fingers: 5,
            hand_span_semitones: 4
        };
    };

    /**
     * Default `hands_config` payload. `count` is honoured only in semitones
     * mode (1–4); frets mode always returns a single fretting hand.
     */
    ISMSections._defaultHandsConfig = function(mode, tab, count) {
        if (mode === 'frets') {
            const numStrings = tab?.stringInstrumentConfig?.num_strings;
            const scaleLengthMm = tab?.stringInstrumentConfig?.scale_length_mm;
            const out = {
                enabled: true,
                mode: 'frets',
                mechanism: 'string_sliding_fingers',
                hand_move_frets_per_sec: 12,
                hand_move_mm_per_sec: 250,
                finger_move_mm_per_sec: 800,
                hands: [{
                    id: 'fretting',
                    cc_position_number: 22,
                    hand_span_mm: 80,
                    hand_span_frets: 4,
                    max_fingers: Number.isFinite(numStrings) ? numStrings : 6
                }]
            };
            // When scale_length_mm isn't known yet, the mm fields are
            // still populated with sensible defaults so the validator
            // accepts the payload without forcing the user to fill them
            // before saving — picking a preset later refines them.
            if (Number.isFinite(scaleLengthMm) && scaleLengthMm > 0) {
                // Already mm-mode by default; nothing extra to seed.
            }
            return out;
        }
        const N = Math.max(1, Math.min(4, Number.isFinite(count) ? count : 2));
        const hands = [];
        for (let i = 0; i < N; i++) hands.push(ISMSections._defaultSemitonesHand(i));
        return {
            enabled: true,
            mode: 'semitones',
            mechanism: 'aligned_fingers',
            hand_move_semitones_per_sec: 60,
            assignment: { mode: 'auto' },
            hands
        };
    };

    /**
     * Resize an existing semitones hands array to the requested count,
     * preserving overlap between the two arrays so the operator's tweaks
     * survive a count change. Legacy ids `left`/`right` are renamed to
     * `h1`/`h2` on the first resize so the persisted payload converges to
     * the canonical scheme.
     */
    ISMSections._resizeSemitonesHands = function(hands, count) {
        const N = Math.max(1, Math.min(4, count | 0));
        const out = [];
        for (let i = 0; i < N; i++) {
            const existing = Array.isArray(hands) ? hands[i] : null;
            if (existing && typeof existing === 'object') {
                out.push({
                    ...existing,
                    id: ISMSections._handIdAt(i)
                });
            } else {
                out.push(ISMSections._defaultSemitonesHand(i));
            }
        }
        return out;
    };

    /**
     * Localised label for a hand at `index` given the total `count`.
     *   1 → « Main »
     *   2 → « Gauche / Droite » (preserves the historical UI for pianos)
     *   3‑4 → « Main 1 … Main N »
     */
    ISMSections._handLabel = function(index, count, t) {
        if (count === 1) {
            return '🫱 ' + (t('instrumentSettings.handsSingle') || 'Main');
        }
        if (count === 2) {
            return index === 0
                ? '🫲 ' + (t('instrumentSettings.handsLeft') || 'Gauche')
                : '🫱 ' + (t('instrumentSettings.handsRight') || 'Droite');
        }
        return '🫱 ' + (t('instrumentSettings.handsNumbered', { n: index + 1 })
            || `Main ${index + 1}`);
    };

    /**
     * Read the hands-section DOM back into a hands_config object ready
     * to persist. Returns `undefined` when the section is not rendered
     * (instrument family without hand-position support) so the caller
     * leaves the existing value untouched. The shape depends on the
     * hidden `#handsMode` field set by the renderer.
     */
    ISMSections._collectHandsConfig = function(rootEl) {
        const section = rootEl?.querySelector('.ism-section[data-section="hands"]');
        if (!section) return undefined; // no-op: section not rendered

        const mode = rootEl.querySelector('#handsMode')?.value === 'frets'
            ? 'frets'
            : 'semitones';
        // The Mains section is only rendered when the Notes-section "Gestion
        // du déplacement des mains" toggle is on, so reaching the collector
        // implies enabled = true. The off path is handled in ISMSave by
        // sending the stored config with enabled=false.
        const enabled = true;
        const moveSpeed = parseInt(rootEl.querySelector('#handsMoveSpeed')?.value, 10);

        if (mode === 'frets') {
            const row = section.querySelector('.ism-hand-row[data-hand="fretting"]');
            const readInt = (field, dflt) => {
                const v = parseInt(row?.querySelector(`[data-field="${field}"]`)?.value, 10);
                return Number.isFinite(v) ? v : dflt;
            };
            const readOptInt = (field) => {
                const v = parseInt(row?.querySelector(`[data-field="${field}"]`)?.value, 10);
                return Number.isFinite(v) ? v : null;
            };
            const moveMmPerSecRaw = parseInt(rootEl.querySelector('#handsMoveMmPerSec')?.value, 10);
            const fingerMoveMmPerSecRaw = parseInt(rootEl.querySelector('#handsFingerMoveMmPerSec')?.value, 10);
            const handSpanMmOpt = readOptInt('hand_span_mm');
            const maxFingersOpt = readOptInt('max_fingers');
            const numFingersOpt = readOptInt('num_fingers');
            const variableHeightFingersOpt = readOptInt('variable_height_fingers_count');

            // Mechanism: read from the hidden input set by card clicks.
            // Defaults to string_sliding_fingers so legacy DOM (without
            // the cards mounted) still produces a valid payload.
            const VALID_MECHANISMS = new Set(['string_sliding_fingers', 'fret_sliding_fingers']);
            const rawMechanism = rootEl.querySelector('#handsMechanismInput')?.value;
            const mechanism = VALID_MECHANISMS.has(rawMechanism)
                ? rawMechanism
                : 'string_sliding_fingers';

            const hand = {
                id: 'fretting',
                cc_position_number: readInt('cc_position_number', 22),
                hand_span_frets: readInt('hand_span_frets', 4)
            };
            if (handSpanMmOpt != null) hand.hand_span_mm = handSpanMmOpt;

            // Per-mechanism extras. string_sliding_fingers accepts
            // max_fingers; fret_sliding_fingers accepts num_fingers and
            // the optional variable_height_fingers_count.
            if (mechanism === 'string_sliding_fingers') {
                if (maxFingersOpt != null) hand.max_fingers = maxFingersOpt;
            } else if (mechanism === 'fret_sliding_fingers') {
                if (numFingersOpt != null) hand.num_fingers = numFingersOpt;
                if (variableHeightFingersOpt != null) {
                    hand.variable_height_fingers_count = variableHeightFingersOpt;
                }
            }

            const out = {
                enabled,
                mode: 'frets',
                mechanism,
                hand_move_frets_per_sec: Number.isFinite(moveSpeed) ? moveSpeed : 12,
                hands: [hand]
            };
            if (Number.isFinite(moveMmPerSecRaw) && moveMmPerSecRaw > 0) {
                out.hand_move_mm_per_sec = moveMmPerSecRaw;
            }
            if (Number.isFinite(fingerMoveMmPerSecRaw) && fingerMoveMmPerSecRaw > 0) {
                out.finger_move_mm_per_sec = fingerMoveMmPerSecRaw;
            }
            return out;
        }

        // Mechanism: V1 keyboard mechanism is `aligned_fingers`. The
        // V2 (`independent_fingers_5`) card is non-clickable, so the
        // hidden field can never carry a V2 value coming from the UI;
        // we still defensively fall back so a stale config never
        // produces a save that the validator would reject.
        const VALID_KB_MECHANISMS = new Set(['aligned_fingers']);
        const rawKbMechanism = rootEl.querySelector('#handsMechanismInput')?.value;
        const kbMechanism = VALID_KB_MECHANISMS.has(rawKbMechanism)
            ? rawKbMechanism
            : 'aligned_fingers';

        // Read each hand row in DOM order. The renderer guarantees rows are
        // emitted with sequential `data-hand-index` attributes (0..N‑1) and
        // a canonical `data-hand` id (`h1..h4`). Legacy DOM that still uses
        // `left`/`right` is also picked up and renamed to `h1`/`h2` here so
        // the persisted payload converges to the new id scheme.
        // Read the keyboard layout selector. Defaults to chromatic so a
        // legacy DOM without the dropdown still produces a coherent
        // payload (chromatic + aligned_fingers is what every existing
        // row was implicitly using).
        const VALID_KB_TYPES = new Set(['chromatic', 'piano']);
        const rawKbType = rootEl.querySelector('#handsKeyboardType')?.value;
        const keyboardType = VALID_KB_TYPES.has(rawKbType) ? rawKbType : 'chromatic';

        const rows = Array.from(section.querySelectorAll('.ism-hand-row'));
        // Span is derived from finger count only when the layout is
        // chromatic (one note per finger). On piano-style layouts the
        // hand stretches across more semitones than fingers — the
        // operator types the span explicitly.
        const isAligned = kbMechanism === 'aligned_fingers';
        const deriveSpanFromFingers = isAligned;
        const hands = rows.map((row, idx) => {
            const id = ISMSections._handIdAt(idx);
            const readInt = (field, dflt) => {
                const v = parseInt(row.querySelector(`[data-field="${field}"]`)?.value, 10);
                return Number.isFinite(v) ? v : dflt;
            };
            const readOptInt = (field) => {
                const v = parseInt(row.querySelector(`[data-field="${field}"]`)?.value, 10);
                return Number.isFinite(v) ? v : null;
            };
            const numFingersOpt = readOptInt('num_fingers');
            // span = num_fingers − 1 only on chromatic + aligned_fingers
            // all aligned instruments now derive span automatically.
            let span;
            if (deriveSpanFromFingers) {
                const f = numFingersOpt != null ? numFingersOpt : 5;
                // Chromatic: one note per finger → span = f − 1.
                // Piano: alternating W–G pattern; each white key pair spans
                // ≈2 semitones on average → use f * 2 as a generous estimate
                // that keeps the off-screen check correct for all octaves.
                span = keyboardType === 'piano' ? f * 2 : Math.max(1, f - 1);
            } else {
                span = readInt('hand_span_semitones', 14);
            }
            const out = {
                id,
                cc_position_number: readInt('cc_position_number', 23 + idx),
                hand_span_semitones: span
            };
            if (numFingersOpt != null) out.num_fingers = numFingersOpt;
            return out;
        });

        // Assignment is always automatic now — the planner derives the split
        // note and hysteresis from the live stream at playback time.
        return {
            enabled,
            mode: 'semitones',
            mechanism: kbMechanism,
            keyboard_type: keyboardType,
            hand_move_semitones_per_sec: Number.isFinite(moveSpeed) ? moveSpeed : 60,
            assignment: { mode: 'auto' },
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

    /**
     * Render the grouped CC picker (accordion + checkboxes). Each group's
     * header shows a running "n/total" badge so the user can scan at a
     * glance which categories are active. Recommended CCs for the current
     * GM category get a ★ marker.
     */
    ISMSections._renderCCAccordion = function(currentCCs, recommendedCCs) {
        const groups = InstrumentSettingsModal.CC_GROUPS;
        let html = '<div class="ism-cc-accordion">';
        for (const groupId of Object.keys(groups)) {
            const group = groups[groupId];
            const ccsObj = group.ccs;
            const ccNums = Object.keys(ccsObj).map(Number);
            const checkedCount = ccNums.filter(function(cc) { return currentCCs.includes(cc); }).length;

            let ccsHtml = '';
            for (const ccNum of ccNums) {
                const info = ccsObj[ccNum];
                const checked = currentCCs.includes(ccNum) ? 'checked' : '';
                const isRecommended = recommendedCCs.includes(ccNum);
                ccsHtml += `<label class="ism-cc-item ${checked ? 'checked' : ''}" title="${this.escape(info.desc + ' | ' + info.range)}">
                    <input type="checkbox" class="ism-cc-checkbox" value="${ccNum}" ${checked}>
                    <span class="ism-cc-num">${ccNum}</span>
                    <span class="ism-cc-name">${this.escape(info.name)}</span>
                    <span class="ism-cc-range">${this.escape(info.range)}</span>
                    ${isRecommended ? '<span class="ism-cc-recommended" title="Recommandé pour cet instrument">★</span>' : ''}
                </label>`;
            }

            html += `<div class="ism-cc-group" data-group="${groupId}">
                <div class="ism-cc-group-header">
                    <span class="ism-cc-group-icon">${group.icon || ''}</span>
                    <span class="ism-cc-group-name">${group.label}</span>
                    <span class="ism-cc-group-badge">${checkedCount}/${ccNums.length}</span>
                    <span class="ism-cc-group-chevron">▸</span>
                </div>
                <div class="ism-cc-group-body">
                    <div class="ism-cc-grid">${ccsHtml}</div>
                </div>
            </div>`;
        }
        html += '</div>';
        return html;
    };

    /**
     * Return the CC numbers claimed by the string-instrument subsection
     * (string-select + fret-select). They're merged into the summary so the
     * user sees every CC flowing to the device — even the ones configured
     * from another subsection.
     */
    ISMSections._getStringCCNumbers = function() {
        const tab = this._getActiveTab();
        const config = tab?.stringInstrumentConfig;
        if (!config || config.cc_enabled === false) return [];
        return [config.cc_string_number ?? 20, config.cc_fret_number ?? 21];
    };

    /**
     * Render the compact tag strip at the top of the picker. String-instrument
     * CCs get a distinct style and no close button (owned by another subsection).
     */
    ISMSections._renderActiveCCsSummary = function(activeCCs) {
        const stringCCs = this._getStringCCNumbers();
        const allCCs = [...(activeCCs || [])];
        for (const scc of stringCCs) {
            if (!allCCs.includes(scc)) allCCs.push(scc);
        }
        if (allCCs.length === 0) {
            return `<span class="ism-active-ccs-empty">${this.t('instrumentSettings.noActiveCcs') || 'Aucun CC actif'}</span>`;
        }
        const groups = InstrumentSettingsModal.CC_GROUPS;
        const ccNames = {};
        for (const groupId of Object.keys(groups)) {
            const ccsObj = groups[groupId].ccs;
            for (const ccNum of Object.keys(ccsObj)) {
                ccNames[Number(ccNum)] = ccsObj[ccNum].name;
            }
        }
        const stringCCSet = new Set(stringCCs);
        const self = this;
        const sorted = [...allCCs].sort(function(a, b) { return a - b; });
        return sorted.map(function(cc) {
            const isStringCC = stringCCSet.has(cc);
            const name = isStringCC
                ? (cc === (self._getActiveTab()?.stringInstrumentConfig?.cc_string_number ?? 20) ? 'String Select' : 'Fret Select')
                : (ccNames[cc] || ('CC ' + cc));
            if (isStringCC) {
                return `<span class="ism-active-cc-tag ism-cc-tag-string" title="${self.escape(name)} (Cordes)"><span class="ism-active-cc-num">${cc}</span> ${self.escape(name)}</span>`;
            }
            return `<span class="ism-active-cc-tag" title="${self.escape(name)}"><span class="ism-active-cc-num">${cc}</span> ${self.escape(name)}<button type="button" class="ism-cc-tag-remove" data-cc="${cc}" aria-label="Supprimer CC ${cc}">×</button></span>`;
        }).join('');
    };

    if (typeof window !== 'undefined') window.ISMSections = ISMSections;
})();
