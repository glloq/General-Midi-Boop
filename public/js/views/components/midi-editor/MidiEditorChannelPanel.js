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
        const m = this.modal;
        if (!m.channels || m.channels.length === 0) {
            return `<div class="channel-buttons"><span>${m.t('midiEditor.noActiveChannel')}</span></div>`;
        }

        let buttons = '<div class="channel-buttons">';

        m.channels.forEach(ch => {
            const isActive = m.activeChannels.has(ch.channel);
            const color = m.channelColors[ch.channel % m.channelColors.length];
            const activeClass = isActive ? 'active' : '';

            const inlineStyles = isActive
                ? `
                    --channel-color: ${color};
                    background: ${color};
                    border-color: ${color};
                `.trim()
                : `
                    --channel-color: ${color};
                    border-color: ${color};
                `.trim();

            buttons += `
                <button
                    class="channel-btn ${activeClass}"
                    data-channel="${ch.channel}"
                    data-color="${color}"
                    style="${inlineStyles}"
                    title="${m.t('midiEditor.notesChannel', { count: ch.noteCount, channel: ch.channel + 1 })}"
                >
                    <span class="channel-label">${ch.channel + 1} : ${ch.instrument}</span>
                </button>
            `;
        });

        buttons += '</div>';
        return buttons;
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
        const buttons = m.container?.querySelectorAll('.channel-btn');
        if (!buttons) return;

        buttons.forEach(btn => {
            const channel = parseInt(btn.dataset.channel);
            const color = btn.dataset.color;
            const isActive = m.activeChannels.has(channel);

            if (isActive) {
                btn.classList.add('active');
                btn.style.cssText = `
                    --channel-color: ${color};
                    background: ${color};
                    border-color: ${color};
                `;
            } else {
                btn.classList.remove('active');
                btn.style.cssText = `
                    --channel-color: ${color};
                    border-color: ${color};
                `;
            }
        });

        m.updateStats();
    }

    /**
     * Rafraichir les boutons de canal
     */
    refreshChannelButtons() {
        const m = this.modal;
        const channelsToolbar = m.container?.querySelector('.channels-toolbar');
        if (channelsToolbar) {
            channelsToolbar.innerHTML = this.renderChannelButtons();

            const channelButtons = m.container.querySelectorAll('.channel-btn');
            channelButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const channel = parseInt(btn.dataset.channel);
                    this.toggleChannel(channel);
                });
            });
        }
    }

    // ========================================================================
    // INSTRUMENT SELECTOR
    // ========================================================================

    /**
     * Update tablature button visibility based on active channel
     */
    async updateTablatureButton() {
        const m = this.modal;
        const btns = m.container?.querySelectorAll('.tab-toggle-btn');
        if (!btns || btns.length === 0) return;

        const configBtn = m.container?.querySelector('[data-action="configure-string-instrument"]');
        const tabBtn = m.container?.querySelector('[data-action="toggle-tablature"]');

        // Show config button when 1 channel active + device selected
        // Show TAB button only if a string instrument is already configured
        if (m.activeChannels.size === 1 && m.selectedConnectedDevice) {
            if (configBtn) configBtn.style.display = 'inline-flex';
            try {
                const hasTab = await m.hasStringInstrument();
                if (tabBtn) tabBtn.style.display = hasTab ? 'inline-flex' : 'none';
                if (tabBtn && m.tablatureEditor && m.tablatureEditor.isVisible) {
                    tabBtn.classList.add('active');
                } else if (tabBtn) {
                    tabBtn.classList.remove('active');
                }
            } catch {
                if (tabBtn) tabBtn.style.display = 'none';
            }
        } else {
            if (configBtn) configBtn.style.display = 'none';
            if (tabBtn) tabBtn.style.display = 'none';
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
                m.connectedDevices = result.devices.filter(d => d.output === true);
                m.log('info', `Loaded ${m.connectedDevices.length} connected output devices`);
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
            const selected = m.selectedConnectedDevice === device.id ? 'selected' : '';
            const name = device.displayName || device.name || device.id;
            options += `<option value="${device.id}" ${selected}>${name}</option>`;
        });

        selector.innerHTML = options;
    }

    /**
     * Selectionner un instrument connecte et charger ses capacites
     */
    async selectConnectedDevice(deviceId) {
        const m = this.modal;
        m.selectedConnectedDevice = deviceId || null;

        if (!deviceId) {
            m.selectedDeviceCapabilities = null;
            m.playableNotes = null;
            this.updatePianoRollPlayableNotes();
            m.log('info', 'No device selected - showing all notes as playable');
            return;
        }

        try {
            const response = await m.api.sendCommand('instrument_get_capabilities', {
                deviceId: deviceId
            });

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
