// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorChannelPanel.js
// Description: Channel management for the MIDI Editor
//   - Channel toggle buttons rendering
//   - Channel selector dropdown
//   - Instrument selector dropdown
//   - Connected device selector
//   - toggleChannel(), refreshChannelButtons(), updateChannelButtons()
//   - updateInstrumentSelector(), updateConnectedDeviceSelector()
// ============================================================================

class MidiEditorChannelPanel {
    constructor(modal) {
        this.modal = modal;
    }

    // ========================================================================
    // CHANNEL TOGGLE
    // ========================================================================

    /**
     * Basculer l'affichage d'un canal
     */
    toggleChannel(channel) {
        const m = this.modal;
        const previousActiveChannels = new Set(m.activeChannels);

        if (m.activeChannels.has(channel)) {
            m.activeChannels.delete(channel);
        } else {
            m.activeChannels.add(channel);
        }

        m.log('info', `Toggled channel ${channel}. Active channels: [${Array.from(m.activeChannels).join(', ')}]`);

        m.updateSequenceFromActiveChannels(previousActiveChannels);
        this.updateChannelButtons();
        this.updateInstrumentSelector();
        this.updateTablatureButton();

        // Mettre a jour le canal pour l'edition CC
        if (m.ccPanel) {
            m.ccPanel.updateCCEditorChannel();
        }

        // Synchroniser les canaux mutes avec le synthetiseur
        if (m.playbackManager) {
            m.playbackManager.syncMutedChannels();
        }
    }

    // ========================================================================
    // RENDER CHANNEL BUTTONS
    // ========================================================================

    /**
     * Generer les boutons de canal
     */
    renderChannelButtons() {
        // Delegate to modal's renderChannelButtons
        return this.modal.renderChannelButtons();
    }

    /**
     * Rendre les options du selecteur de canal
     */
    renderChannelOptions() {
        const m = this.modal;
        let options = '';
        for (let i = 0; i < 16; i++) {
            const instrumentName = i === 9 ? m.t('midiEditor.drumKit') : m.getInstrumentName(0);
            options += `<option value="${i}">Canal ${i + 1}${i === 9 ? ' (Drums)' : ''}</option>`;
        }
        return options;
    }

    /**
     * Rendre les options d'instruments MIDI GM
     */
    renderInstrumentOptions() {
        const m = this.modal;
        let options = '';

        const groups = [
            { key: 'piano', start: 0, count: 8 },
            { key: 'chromaticPercussion', start: 8, count: 8 },
            { key: 'organ', start: 16, count: 8 },
            { key: 'guitar', start: 24, count: 8 },
            { key: 'bass', start: 32, count: 8 },
            { key: 'strings', start: 40, count: 8 },
            { key: 'ensemble', start: 48, count: 8 },
            { key: 'brass', start: 56, count: 8 },
            { key: 'reed', start: 64, count: 8 },
            { key: 'pipe', start: 72, count: 8 },
            { key: 'synthLead', start: 80, count: 8 },
            { key: 'synthPad', start: 88, count: 8 },
            { key: 'synthEffects', start: 96, count: 8 },
            { key: 'ethnic', start: 104, count: 8 },
            { key: 'percussive', start: 112, count: 8 },
            { key: 'soundEffects', start: 120, count: 8 }
        ];

        groups.forEach(group => {
            const categoryName = m.t(`instruments.categories.${group.key}`);
            options += `<optgroup label="${categoryName}">`;
            for (let i = 0; i < group.count; i++) {
                const program = group.start + i;
                const instrument = m.getInstrumentName(program);
                options += `<option value="${program}">${program}: ${instrument}</option>`;
            }
            options += `</optgroup>`;
        });

        return options;
    }

    // ========================================================================
    // UPDATE BUTTONS
    // ========================================================================

    /**
     * Mettre a jour l'etat visuel des boutons de canal
     */
    updateChannelButtons() {
        const m = this.modal;
        const chips = m.container?.querySelectorAll('.channel-chip');
        if (!chips) return;

        chips.forEach(chip => {
            const channel = parseInt(chip.dataset.channel);
            const color = chip.dataset.color;
            const isActive = m.activeChannels.has(channel);

            if (isActive) {
                chip.classList.add('active');
            } else {
                chip.classList.remove('active');
            }
            chip.style.cssText = `--chip-color: ${color};`;

            // Update playable notes indicator
            const isPlayableHighlighted = m.channelPlayableHighlights?.has(channel);
            chip.classList.toggle('playable-active', !!isPlayableHighlighted);
        });

        m.updateStats();
    }

    /**
     * Rafraichir les boutons de canal
     */
    refreshChannelButtons() {
        // Delegate to modal's refreshChannelButtons
        this.modal.refreshChannelButtons();
    }

    // ========================================================================
    // INSTRUMENT SELECTOR
    // ========================================================================

    // GM program ranges for string instruments
    // 24-31: Guitars, 32-37: Bass (acoustic/electric/slap), 40-43: Orchestral strings
    // Excludes 38-39 (Synth Bass 1/2) — not physical string instruments
    static GM_STRING_INSTRUMENTS = {
        guitar: { start: 24, end: 31, preset: 'guitar_standard' },
        bass:   { start: 32, end: 37, preset: 'bass_4_standard' },
        violin: { start: 40, end: 40, preset: 'violin' },
        viola:  { start: 41, end: 41, preset: 'viola' },
        cello:  { start: 42, end: 42, preset: 'cello' },
        contrabass: { start: 43, end: 43, preset: 'contrabass' },
        tremolo_strings:   { start: 44, end: 44, preset: 'violin' },
        pizzicato_strings: { start: 45, end: 45, preset: 'violin' },
        string_ensemble:   { start: 48, end: 49, preset: 'violin' },
        sitar:  { start: 104, end: 104, preset: 'guitar_standard' },
        banjo:  { start: 105, end: 105, preset: 'banjo_standard' },
        fiddle: { start: 110, end: 110, preset: 'violin' },
    };

    /**
     * Check if a GM program number corresponds to a string instrument
     * @param {number} program - GM program number (0-127)
     * @returns {{ category: string, preset: string } | null}
     */
    static getStringInstrumentCategory(program) {
        for (const [category, range] of Object.entries(MidiEditorChannelPanel.GM_STRING_INSTRUMENTS)) {
            if (program >= range.start && program <= range.end) {
                return { category, preset: range.preset };
            }
        }
        return null;
    }

    // GM program ranges for wind/brass instruments
    static GM_WIND_INSTRUMENTS = {
        brass: { start: 56, end: 63 },
        reed:  { start: 64, end: 71 },
        pipe:  { start: 72, end: 79 },
    };

    /**
     * Check if a GM program number corresponds to a wind instrument
     * @param {number} program - GM program number (0-127)
     * @returns {{ category: string } | null}
     */
    static getWindInstrumentCategory(program) {
        for (const [category, range] of Object.entries(MidiEditorChannelPanel.GM_WIND_INSTRUMENTS)) {
            if (program >= range.start && program <= range.end) {
                return { category };
            }
        }
        return null;
    }

    /**
     * Update per-channel TAB button active states and auto-suggest banner.
     */
    async updateTablatureButton() {
        const m = this.modal;

        // Update per-channel TAB button active states
        if (m._updateChannelTabButtons) {
            m._updateChannelTabButtons();
        }

        // Auto-suggest string instrument config for GM string instruments
        if (m.activeChannels.size === 1) {
            const activeChannel = Array.from(m.activeChannels)[0];
            const channelInfo = m.channels.find(ch => ch.channel === activeChannel);
            const gmMatch = channelInfo ? MidiEditorChannelPanel.getStringInstrumentCategory(channelInfo.program) : null;

            if (gmMatch) {
                try {
                    const existingConfig = m.findStringInstrument
                        ? await m.findStringInstrument(activeChannel)
                        : null;
                    if (!existingConfig) {
                        this._suggestStringInstrumentConfig(activeChannel, gmMatch, channelInfo);
                    }
                } catch { /* ignore */ }
            }
        }
    }

    /**
     * Show a suggestion banner to auto-configure a string instrument
     */
    _suggestStringInstrumentConfig(channel, gmMatch, channelInfo) {
        const m = this.modal;

        // Don't re-suggest if banner already shown
        const existing = m.container?.querySelector('.tab-suggest-banner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.className = 'tab-suggest-banner';
        banner.innerHTML = `
            <span>${m.t('tablature.gmDetected', { instrument: channelInfo.instrument })}</span>
            <button class="tab-suggest-btn" data-action="tab-auto-config">${m.t('tablature.autoConfig')}</button>
            <button class="tab-suggest-dismiss">&times;</button>
        `;

        banner.querySelector('.tab-suggest-dismiss').addEventListener('click', () => banner.remove());
        banner.querySelector('[data-action="tab-auto-config"]').addEventListener('click', async () => {
            banner.remove();
            try {
                await m.api.sendCommand('string_instrument_create_from_preset', {
                    device_id: m.getEffectiveDeviceId(),
                    channel: channel,
                    preset: gmMatch.preset
                });
                this.updateTablatureButton();
                m.log('info', `Auto-configured ${gmMatch.category} for channel ${channel + 1}`);
            } catch (error) {
                m.log('error', 'Auto-config failed:', error);
            }
        });

        const toolbar = m.container?.querySelector('.tablature-toolbar') ||
                        m.container?.querySelector('.channels-toolbar');
        if (toolbar) {
            toolbar.parentElement.insertBefore(banner, toolbar.nextSibling);
        }
    }

    /**
     * Mettre a jour le selecteur d'instrument selon les canaux actifs
     */
    updateInstrumentSelector() {
        const m = this.modal;
        const instrumentSelector = document.getElementById('instrument-selector');
        const instrumentLabel = document.getElementById('instrument-label');
        const applyBtn = document.getElementById('apply-instrument-btn');

        if (!instrumentSelector) return;

        if (m.activeChannels.size === 0) {
            if (instrumentLabel) instrumentLabel.textContent = m.t('midiEditor.instrument');
            if (applyBtn) applyBtn.disabled = true;
        } else if (m.activeChannels.size === 1) {
            const activeChannel = Array.from(m.activeChannels)[0];
            const channelInfo = m.channels.find(ch => ch.channel === activeChannel);

            if (channelInfo) {
                if (instrumentLabel) {
                    instrumentLabel.textContent = `${m.t('midiEditor.instrument')} ${m.t('midiEditor.channelTip', { channel: activeChannel + 1 })}`;
                    instrumentLabel.title = '';
                }

                instrumentSelector.value = channelInfo.program.toString();

                if (applyBtn) {
                    applyBtn.disabled = false;
                    applyBtn.title = m.t('midiEditor.applyInstrument');
                }
            }
        } else {
            const firstActiveChannel = Array.from(m.activeChannels)[0];
            const channelInfo = m.channels.find(ch => ch.channel === firstActiveChannel);

            if (instrumentLabel) {
                instrumentLabel.textContent = m.t('midiEditor.multipleChannels', { count: m.activeChannels.size });
                instrumentLabel.title = m.t('midiEditor.multipleChannelsTip');
            }

            if (channelInfo) {
                instrumentSelector.value = channelInfo.program.toString();
            }

            if (applyBtn) {
                applyBtn.disabled = true;
                applyBtn.title = m.t('midiEditor.singleChannelRequired');
            }
        }
    }

    // ========================================================================
    // CONNECTED DEVICE SELECTOR
    // ========================================================================

    /**
     * Charger la liste des instruments MIDI connectes
     */
    async loadConnectedDevices() {
        const m = this.modal;
        try {
            const result = await m.api.sendCommand('device_list');
            if (result && result.devices) {
                const outputDevices = result.devices.filter(d => d.output === true);

                // Éclater les devices multi-instruments en entrées individuelles
                const expandedDevices = [];
                for (const device of outputDevices) {
                    if (device.instruments && device.instruments.length > 1) {
                        for (const inst of device.instruments) {
                            expandedDevices.push({
                                ...device,
                                _channel: inst.channel !== undefined ? inst.channel : 0,
                                _multiInstrument: true,
                                displayName: inst.custom_name || inst.name || device.displayName || device.name
                            });
                        }
                    } else {
                        expandedDevices.push(device);
                    }
                }
                m.connectedDevices = expandedDevices;
                m.log('info', `Loaded ${outputDevices.length} connected output devices (${expandedDevices.length} instruments)`);
                this.updateConnectedDeviceSelector();
            }
        } catch (error) {
            m.log('error', 'Failed to load connected devices:', error);
            m.connectedDevices = [];
        }
    }

    /**
     * Mettre a jour le selecteur d'instruments connectes
     */
    updateConnectedDeviceSelector() {
        const m = this.modal;
        const selector = document.getElementById('connected-device-selector');
        if (!selector) return;

        let options = `<option value="">${m.t('midiEditor.noDeviceFilter')}</option>`;

        m.connectedDevices.forEach(device => {
            let value, name;
            if (device._multiInstrument) {
                value = `${device.id}::${device._channel}`;
                const chLabel = `Ch${(device._channel || 0) + 1}`;
                name = `${device.displayName || device.name} [${chLabel}]`;
            } else {
                value = device.id;
                name = device.displayName || device.name || device.id;
            }
            const selected = m.selectedConnectedDevice === value ? 'selected' : '';
            options += `<option value="${value}" ${selected}>${name}</option>`;
        });

        selector.innerHTML = options;
    }

    /**
     * Selectionner un instrument connecte et charger ses capacites
     */
    async selectConnectedDevice(rawValue) {
        const m = this.modal;
        m.selectedConnectedDevice = rawValue || null;

        // Parser le format "deviceId::channel" pour les devices multi-instruments
        let deviceId = rawValue;
        let channel = undefined;
        if (rawValue && rawValue.includes('::')) {
            const parts = rawValue.split('::');
            deviceId = parts[0];
            channel = parseInt(parts[1]);
        }

        if (!rawValue) {
            m.selectedDeviceCapabilities = null;
            m.playableNotes = null;
            this.updatePianoRollPlayableNotes();
            this.updateTablatureButton();
            m.log('info', 'No device selected - showing all notes as playable');
            return;
        }

        try {
            const params = { deviceId };
            if (channel !== undefined) {
                params.channel = channel;
            }
            const response = await m.api.sendCommand('instrument_get_capabilities', params);

            if (response && response.capabilities) {
                m.selectedDeviceCapabilities = response.capabilities;
                this.calculatePlayableNotes();
                this.updatePianoRollPlayableNotes();
                m.log('info', `Loaded capabilities for device ${deviceId}:`, m.selectedDeviceCapabilities);
                this.updateTablatureButton();
            } else {
                m.selectedDeviceCapabilities = null;
                m.playableNotes = null;
                this.updatePianoRollPlayableNotes();
                m.log('info', `No capabilities defined for device ${deviceId}`);
            }
        } catch (error) {
            m.log('error', `Failed to load capabilities for device ${deviceId}:`, error);
            m.selectedDeviceCapabilities = null;
            m.playableNotes = null;
            this.updatePianoRollPlayableNotes();
        }
    }

    /**
     * Calculer l'ensemble des notes jouables a partir des capacites
     */
    calculatePlayableNotes() {
        const m = this.modal;
        if (!m.selectedDeviceCapabilities) {
            m.playableNotes = null;
            return;
        }

        const caps = m.selectedDeviceCapabilities;
        const mode = caps.note_selection_mode || 'range';

        if (mode === 'discrete' && caps.selected_notes && Array.isArray(caps.selected_notes)) {
            m.playableNotes = new Set(caps.selected_notes.map(n => parseInt(n)));
            m.log('info', `Discrete mode: ${m.playableNotes.size} playable notes`);
        } else if (mode === 'range') {
            const minNote = caps.note_range_min !== null && caps.note_range_min !== undefined
                ? parseInt(caps.note_range_min) : 0;
            const maxNote = caps.note_range_max !== null && caps.note_range_max !== undefined
                ? parseInt(caps.note_range_max) : 127;

            if (minNote === 0 && maxNote === 127) {
                m.playableNotes = null;
                m.log('info', 'Full range (0-127) - no filter');
            } else {
                m.playableNotes = new Set();
                for (let n = minNote; n <= maxNote; n++) {
                    m.playableNotes.add(n);
                }
                m.log('info', `Range mode: notes ${minNote}-${maxNote} (${m.playableNotes.size} playable)`);
            }
        } else {
            m.playableNotes = null;
        }
    }

    /**
     * Mettre a jour le piano roll avec les notes jouables
     */
    updatePianoRollPlayableNotes() {
        const m = this.modal;
        if (!m.pianoRoll) return;

        m.pianoRoll.playableNotes = m.playableNotes;

        if (typeof m.pianoRoll.redraw === 'function') {
            m.pianoRoll.redraw();
        }

        m.log('debug', 'Piano roll updated with playable notes filter');
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorChannelPanel;
}

if (typeof window !== 'undefined') {
    window.MidiEditorChannelPanel = MidiEditorChannelPanel;
}
