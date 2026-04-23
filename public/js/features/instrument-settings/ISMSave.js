(function() {
    'use strict';
    const ISMSave = {};

    ISMSave._save = async function() {
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

            // New fields
            const octaveMode = (this.$('#octaveModeInput')?.value || '').trim() || 'chromatic';
            const commTimeout = parseInt(this.$('#commTimeout')?.value) || null;

            // Timing fields
            const minNoteIntervalVal = this.$('#minNoteInterval')?.value?.trim();
            const minNoteInterval = minNoteIntervalVal !== '' && minNoteIntervalVal != null ? parseInt(minNoteIntervalVal) : null;
            const minNoteDurationVal = this.$('#minNoteDuration')?.value?.trim();
            const minNoteDuration = minNoteDurationVal !== '' && minNoteDurationVal != null ? parseInt(minNoteDurationVal) : null;

            // Save base settings
            await this.api.sendCommand('instrument_update_settings', {
                deviceId: this.device.id,
                channel: saveChannel,
                custom_name: customName || null,
                sync_delay: syncDelay,
                mac_address: macAddress || null,
                name: this.device.name,
                gm_program: gmProgram,
                octave_mode: octaveMode,
                comm_timeout: commTimeout,
                min_note_interval: minNoteInterval,
                min_note_duration: minNoteDuration
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
                const _int = (v, def) => { const n = parseInt(v); return isNaN(n) ? def : n; };
                const ccEnabled = this.$('#ism-cc-enabled')?.checked ?? true;
                const ccStringNumber = _int(this.$('#ism-cc-str-num')?.value, 20);
                const ccStringMin = _int(this.$('#ism-cc-str-min')?.value, 1);
                const ccStringMax = _int(this.$('#ism-cc-str-max')?.value, 12);
                const ccStringOffset = _int(this.$('#ism-cc-str-offset')?.value, 0);
                const ccFretNumber = _int(this.$('#ism-cc-fret-num')?.value, 21);
                const ccFretMin = _int(this.$('#ism-cc-fret-min')?.value, 0);
                const ccFretMax = _int(this.$('#ism-cc-fret-max')?.value, 36);
                const ccFretOffset = _int(this.$('#ism-cc-fret-offset')?.value, 0);

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

            // Persist secondary GM voices (multi-GM alternatives)
            const tabForSave = this._getActiveTab();
            const voicesToSave = (tabForSave && Array.isArray(tabForSave.voices)) ? tabForSave.voices : [];
            try {
                await this.api.sendCommand('instrument_voice_replace', {
                    deviceId: this.device.id,
                    channel: saveChannel,
                    voices: voicesToSave.map(function(v) {
                        return {
                            gm_program: v.gm_program,
                            min_note_interval: v.min_note_interval,
                            min_note_duration: v.min_note_duration,
                            supported_ccs: v.supported_ccs
                        };
                    })
                });
            } catch (e) {
                console.warn('Failed to save secondary voices:', e);
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
                        supported_ccs: Array.isArray(v.supported_ccs) ? v.supported_ccs : null
                    };
                });
            }
        } catch (e) { /* no voices yet or backend not ready */ }

        return { channel, settings, stringInstrumentConfig, isBleDevice, voices };
    };

    if (typeof window !== 'undefined') window.ISMSave = ISMSave;
})();
