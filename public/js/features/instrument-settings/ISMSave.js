(function() {
    'use strict';
    const ISMSave = {};

    ISMSave._save = async function() {
        try {
            // Flush the Notes editor (piano + mode toggles) into whichever
            // target it currently edits (primary settings or active voice)
            // so nothing is lost if the user edited a voice tab.
            if (typeof this._commitCurrentNotesEditor === 'function') {
                this._commitCurrentNotesEditor();
            }
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

            // Note selection — source the PRIMARY's values from tab.settings
            // (freshly committed from the editor above). The hidden inputs
            // might currently reflect a voice tab, so reading them would be
            // wrong when voices don't share notes.
            const primaryTab = this._getActiveTab();
            const primarySettings = primaryTab ? primaryTab.settings : {};
            const noteSelectionMode = primarySettings.note_selection_mode || 'range';
            const parsedMin = primarySettings.note_range_min != null ? parseInt(primarySettings.note_range_min, 10) : null;
            const parsedMax = primarySettings.note_range_max != null ? parseInt(primarySettings.note_range_max, 10) : null;

            let selectedNotes = null;
            if (noteSelectionMode === 'discrete' && Array.isArray(primarySettings.selected_notes)) {
                selectedNotes = [...primarySettings.selected_notes];
            }

            // For drums section: use drum selected notes if in drum mode.
            // Only applies when: primary is drum, voices share notes (single
            // editor), and the user is currently editing the primary — not
            // a per-voice tab — so we don't clobber primary's notes with
            // unrelated drum-pad state.
            const sharingOn = primarySettings.voices_share_notes !== 0 && primarySettings.voices_share_notes !== false;
            const primaryIsDrum = (this.activeChannel === 9) || gmDecoded.isDrumKit;
            const editingPrimaryTab = this._activeNotesVoiceIdx == null;
            if (this._drumSelectedNotes && this._drumSelectedNotes.size > 0
                && primaryIsDrum && sharingOn && editingPrimaryTab) {
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
                // Pre-check: if the target channel is already occupied by
                // another tab, abort before any DB write. The grid in the
                // Identity section already disables occupied buttons, but
                // that doesn't cover a drum-kit program auto-switching to
                // channel 9.
                const collision = Array.isArray(this.instrumentTabs) && this.instrumentTabs.some(function(t) {
                    return t.channel === saveChannel && t !== primaryTab;
                });
                if (collision) {
                    if (typeof showAlert === 'function') {
                        await showAlert(
                            this.t('instrumentSettings.channelOccupied') || 'Le canal cible est déjà utilisé par un autre instrument.',
                            { title: this.t('common.error') || 'Erreur', icon: '⚠️' }
                        );
                    }
                    return;
                }
                // Don't swallow delete errors — a silent failure would leave
                // the old row in place AND create/update a new one on save,
                // producing dual rows the user can't see.
                await this.api.sendCommand('instrument_delete', { deviceId: this.device.id, channel: originalChannel });
                const tab = this._getActiveTab();
                if (tab) {
                    tab.channel = saveChannel;
                    this.activeChannel = saveChannel;
                }
            }

            // New fields — primary's octave_mode comes from tab.settings (same
            // reasoning as note_selection_mode: hidden input may be on a voice).
            const octaveMode = primarySettings.octave_mode || 'chromatic';
            const commTimeout = parseInt(this.$('#commTimeout')?.value) || null;

            // Voices-share-notes flag — when the toggle is hidden (no voices,
            // or primary is drum/string), fall back to the stored value so we
            // don't accidentally clear it.
            const shareCb = this.$('#voicesShareNotesCheckbox');
            const voicesShareNotes = shareCb
                ? (shareCb.checked ? 1 : 0)
                : (primarySettings.voices_share_notes === 0 || primarySettings.voices_share_notes === false ? 0 : 1);

            // Timing fields
            const minNoteIntervalVal = this.$('#minNoteInterval')?.value?.trim();
            const minNoteInterval = minNoteIntervalVal !== '' && minNoteIntervalVal != null ? parseInt(minNoteIntervalVal) : null;
            const minNoteDurationVal = this.$('#minNoteDuration')?.value?.trim();
            const minNoteDuration = minNoteDurationVal !== '' && minNoteDurationVal != null ? parseInt(minNoteDurationVal) : null;

            // Omni mode (accept notes on any channel — useful for devices hosting a single instrument)
            const omniModeVal = this.$('#omniModeInput')?.value;
            const omniMode = omniModeVal === '1' || omniModeVal === 'true';

            // String instrument path: compute derived values (auto range,
            // per-string frets) so they ride along in the atomic payload
            // below instead of being saved via a separate command.
            const isStringInst = typeof isGmStringInstrument === 'function' && isGmStringInstrument(gmProgram);
            let stringInstrumentPayload = null;
            let effectivePolyphony = polyphony;
            let stringNoteSelectionMode, stringNoteRangeMin, stringNoteRangeMax, stringSelectedNotes;
            if (isStringInst) {
                const numStrings = parseInt(this.$('#siNumStrings')?.value) || 6;
                const tuning = [], perStringFrets = [];
                for (let i = 0; i < numStrings; i++) {
                    tuning.push(parseInt(this.$(`#siTuning${i}`)?.value) || 40);
                    perStringFrets.push(parseInt(this.$(`#siFrets${i}`)?.value) || 24);
                }
                const computedMin = Math.min(...tuning);
                const computedMax = Math.max(...tuning.map((t, i) => t + perStringFrets[i]));
                stringNoteSelectionMode = 'range';
                stringNoteRangeMin = Math.max(0, computedMin);
                stringNoteRangeMax = Math.min(127, computedMax);
                stringSelectedNotes = null;
                if (!effectivePolyphony) effectivePolyphony = numStrings;

                const maxFrets = Math.max(...perStringFrets);
                const instrumentName = typeof getGMInstrumentName === 'function'
                    ? (getGMInstrumentName(gmProgram || 0) || 'Guitar') : 'Guitar';
                const _int = (v, def) => { const n = parseInt(v); return isNaN(n) ? def : n; };
                const ccEnabled = this.$('#ism-cc-enabled')?.checked ?? true;
                const tab = this._getActiveTab();
                const fretsPerStringData = this._neckDiagram
                    ? this._neckDiagram.getFretsPerString()
                    : (tab?.stringInstrumentConfig?.frets_per_string || null);
                // scale_length_mm is optional. An empty input means "no
                // physical model" — we send null so the backend stores NULL
                // and the planner falls back to constant-fret reach.
                //
                // The user can edit this value in two places: the Notes
                // section (#siScaleLengthMm) and the Hands geometry section
                // (#handsGeometryScaleLength). Both inputs' change listeners
                // sync into tab.stringInstrumentConfig.scale_length_mm, so
                // the in-memory state is the up-to-date source of truth
                // regardless of which input was last edited. Reading the
                // Notes input alone would silently drop edits made from
                // the Hands tab.
                const readScaleFromDom = (selector) => {
                    const raw = this.$(selector)?.value;
                    if (raw === undefined) return undefined;
                    if (raw === '' || raw == null) return null;
                    const n = parseInt(raw, 10);
                    return Number.isFinite(n) ? n : null;
                };
                let scaleLengthMm = null;
                const inMemScale = tab?.stringInstrumentConfig?.scale_length_mm;
                if (Number.isFinite(inMemScale)) {
                    scaleLengthMm = inMemScale;
                } else if (inMemScale === null) {
                    scaleLengthMm = null;
                } else {
                    // Fallback for the rare case where stringInstrumentConfig
                    // wasn't initialised (legacy DB rows). Prefer the Hands
                    // geometry input when it's mounted, otherwise the Notes
                    // input.
                    const handsDom = readScaleFromDom('#handsGeometryScaleLength');
                    const notesDom = readScaleFromDom('#siScaleLengthMm');
                    if (handsDom !== undefined) scaleLengthMm = handsDom;
                    else if (notesDom !== undefined) scaleLengthMm = notesDom;
                }
                stringInstrumentPayload = {
                    instrument_name: instrumentName,
                    num_strings: numStrings,
                    num_frets: maxFrets,
                    tuning,
                    is_fretless: 0,
                    capo_fret: 0,
                    cc_enabled: ccEnabled,
                    cc_string_number: _int(this.$('#ism-cc-str-num')?.value, 20),
                    cc_string_min:    _int(this.$('#ism-cc-str-min')?.value, 1),
                    cc_string_max:    _int(this.$('#ism-cc-str-max')?.value, 12),
                    cc_string_offset: _int(this.$('#ism-cc-str-offset')?.value, 0),
                    cc_fret_number:   _int(this.$('#ism-cc-fret-num')?.value, 21),
                    cc_fret_min:      _int(this.$('#ism-cc-fret-min')?.value, 0),
                    cc_fret_max:      _int(this.$('#ism-cc-fret-max')?.value, 36),
                    cc_fret_offset:   _int(this.$('#ism-cc-fret-offset')?.value, 0),
                    frets_per_string: fretsPerStringData,
                    scale_length_mm: scaleLengthMm
                };
            }

            // Build the secondary-voice list — supported_ccs is shared,
            // per-voice note fields are sent only when sharing is off.
            const tabForSave = this._getActiveTab();
            const voicesRaw = (tabForSave && Array.isArray(tabForSave.voices)) ? tabForSave.voices : [];
            const voicesPayload = voicesRaw.map(function(v) {
                const base = {
                    gm_program: v.gm_program,
                    min_note_interval: v.min_note_interval,
                    min_note_duration: v.min_note_duration,
                    supported_ccs: supportedCCs,
                    note_selection_mode: null,
                    note_range_min: null,
                    note_range_max: null,
                    selected_notes: null,
                    octave_mode: null
                };
                if (voicesShareNotes === 0) {
                    base.note_selection_mode = v.note_selection_mode || null;
                    base.note_range_min = v.note_range_min != null ? v.note_range_min : null;
                    base.note_range_max = v.note_range_max != null ? v.note_range_max : null;
                    base.selected_notes = Array.isArray(v.selected_notes) ? v.selected_notes : null;
                    base.octave_mode = v.octave_mode || null;
                }
                return base;
            });

            // Hands configuration (keyboard-only section, absent for drums
            // and non-keyboard melodic instruments). `undefined` means the
            // section was not rendered → preserve whatever's in the DB.
            let handsConfigPayload = undefined;
            if (window.ISMSections?._collectHandsConfig) {
                const modalEl = this.$('.modal-content') || document;
                handsConfigPayload = window.ISMSections._collectHandsConfig(modalEl);
            }
            // The Mains section is hidden when the "Gestion du déplacement
            // des mains" toggle is off, so the collector returns undefined
            // and the disable would not reach the DB. Detect that case and
            // send the stored config explicitly with enabled=false so the
            // disable persists.
            if (handsConfigPayload === undefined && primaryTab.settings.hands_config
                && primaryTab.settings.hands_config.enabled === false) {
                handsConfigPayload = primaryTab.settings.hands_config;
            }

            // ALL writes go through one atomic backend command. A failure
            // anywhere rolls back the whole save, so the row can never be
            // left in a partial state (settings OK + capabilities missing,
            // or voices dropped silently).
            const saveAllPayload = {
                deviceId: this.device.id,
                channel: saveChannel,
                // settings
                custom_name: customName || null,
                sync_delay: syncDelay,
                mac_address: macAddress || null,
                name: this.device.name,
                gm_program: gmProgram,
                octave_mode: octaveMode,
                comm_timeout: commTimeout,
                min_note_interval: minNoteInterval,
                min_note_duration: minNoteDuration,
                omni_mode: omniMode,
                voices_share_notes: voicesShareNotes,
                // capabilities
                polyphony: effectivePolyphony,
                note_selection_mode: isStringInst
                    ? stringNoteSelectionMode
                    : ((gmDecoded.isDrumKit || this.activeChannel === 9) ? 'discrete' : noteSelectionMode),
                note_range_min: isStringInst
                    ? stringNoteRangeMin
                    : (noteSelectionMode === 'range' && !gmDecoded.isDrumKit ? parsedMin : null),
                note_range_max: isStringInst
                    ? stringNoteRangeMax
                    : (noteSelectionMode === 'range' && !gmDecoded.isDrumKit ? parsedMax : null),
                selected_notes: isStringInst
                    ? stringSelectedNotes
                    : ((noteSelectionMode === 'discrete' || gmDecoded.isDrumKit) ? selectedNotes : null),
                supported_ccs: supportedCCs,
                capabilities_source: 'manual',
                // voices + string (optional)
                voices: voicesPayload,
                string_instrument: stringInstrumentPayload
            };
            // Only send hands_config when the section was actually rendered —
            // matching the `hasOwnProperty` contract the backend uses to
            // distinguish "omitted → preserve existing" from "null → clear".
            if (handsConfigPayload !== undefined) {
                saveAllPayload.hands_config = handsConfigPayload;
            }
            await this.api.sendCommand('instrument_save_all', saveAllPayload);

            // If the user switched away from a string-instrument family, the
            // `string_instruments` row for this (device, channel) is now
            // orphaned. Delete it so the DB stops surfacing stale CC config
            // on reload (and so `_getStringCCNumbers` returns [] after the
            // page refreshes).
            if (!isStringInst && primaryTab?._stringInstrumentDeleted) {
                try {
                    await this.api.sendCommand('string_instrument_delete', {
                        device_id: this.device.id,
                        channel: saveChannel
                    });
                } catch (e) {
                    console.warn('Failed to delete orphaned string_instrument row:', e);
                }
                delete primaryTab._stringInstrumentDeleted;
            }

            // Close and refresh — Save just persisted the changes, so the
            // unsaved-changes guard must not pop up.
            this._forceClose = true;
            this.close();
            if (typeof loadDevices === 'function') await loadDevices();
            if (window.instrumentManagementPageInstance) window.instrumentManagementPageInstance.refresh();

        } catch (error) {
            console.error('Save error:', error);
            if (typeof showAlert === 'function') {
                await showAlert(`${this.t('common.error') || 'Erreur'}: ${error.message}`, { title: this.t('instrumentSettings.saveErrorTitle') || 'Erreur de sauvegarde', icon: '❌' });
            }
        }
    };

    ISMSave._loadChannelData = async function(deviceId, channel, deviceType) {
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

        // Load secondary GM voices (multi-GM alternatives) for this (device, channel)
        let voices = [];
        try {
            const voicesResp = await this.api.sendCommand('instrument_voice_list', { deviceId, channel });
            if (voicesResp && Array.isArray(voicesResp.voices)) {
                voices = voicesResp.voices.map(function(v) {
                    return {
                        id: v.id != null ? v.id : null,
                        gm_program: v.gm_program,
                        min_note_interval: v.min_note_interval,
                        min_note_duration: v.min_note_duration,
                        supported_ccs: Array.isArray(v.supported_ccs) ? v.supported_ccs : null,
                        note_selection_mode: v.note_selection_mode != null ? v.note_selection_mode : null,
                        note_range_min: v.note_range_min != null ? v.note_range_min : null,
                        note_range_max: v.note_range_max != null ? v.note_range_max : null,
                        selected_notes: Array.isArray(v.selected_notes) ? v.selected_notes : null,
                        octave_mode: v.octave_mode != null ? v.octave_mode : null
                    };
                });
            }
        } catch (e) { /* no voices yet or backend not ready */ }

        return { channel, settings, stringInstrumentConfig, isBleDevice, voices };
    };

    if (typeof window !== 'undefined') window.ISMSave = ISMSave;
})();
