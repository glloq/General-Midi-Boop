/**
 * SettingsModal - Modal for application settings
 *
 * Features:
 * - Theme change (colored by default, dark as an option)
 * - Keyboard key-count adjustment
 * - Note display duration change
 * - Virtual instrument management
 * - Language selection (FR, EN, ES)
 *
 * Dependency: i18n must be loaded before this script (js/i18n/I18n.js)
 *
 * Mixins:
 *  - SettingsTemplates (renderContent, getLocaleFlag, updateModalTexts)
 *  - SettingsTheme (addToggleStyles, selectTheme, applyTheme)
 *  - SettingsUpdate (triggerSystemUpdate, checkForUpdates, _showUpdateSuccess)
 *  - SettingsSerial (scanSerialPorts)
 */

class SettingsModal {
    constructor(eventBus, logger) {
        this.eventBus = eventBus;
        this.logger = logger;

        // Default settings
        this.settings = this.loadSettings();

        // Initialization
        this.init();
    }

    init() {
        this.createModal();
        this.setupEventListeners();
        this.applySettings();

        // Listen for language changes to update the modal
        i18n.onLocaleChange(() => this.updateModalTexts());
    }

    /**
     * Load settings from localStorage
     */
    loadSettings() {
        const defaults = {
            theme: 'colored',
            keyboardOctaves: 2, // 2 octaves by default (24 keys)
            keyboardLayout: 'azerty', // azerty | qwerty
            noteDisplayTime: 20, // seconds
            virtualInstrument: false,
            showPianoRoll: false,
            showLyrics: false,
            showDebugButton: true,
            showCalibrationButton: false,
            showLightingButton: false,
            showPlaylistButton: true,
            showKeyboardButton: true,
            showInstrumentsButton: true,
            showLoopCreatorButton: true,
            midiClockEnabled: false,
            serialMidiEnabled: false,
            showLoadingAnimation: true,
            soundBank: (window.MidiSynthesizerConstants && window.MidiSynthesizerConstants.DEFAULT_BANK_ID) || 'sf2:default',
            startupUpdateCheck: true,
            startupBetaNotif: false,
            // Phase C (audit §1.1 piano roll bascule) — opt-in for the
            // Canvas-2D V2 renderer. Default false until the V2 has been
            // exercised in production by power users.
            usePianoRollV2: false
        };

        try {
            const saved = localStorage.getItem('gmboop_settings');
            if (saved) {
                const parsed = JSON.parse(saved);

                // Migration: convert keyboardKeys → keyboardOctaves if needed
                if (parsed.keyboardKeys !== undefined && parsed.keyboardOctaves === undefined) {
                    const oldKeys = parsed.keyboardKeys;
                    parsed.keyboardOctaves = Math.ceil(oldKeys / 12);
                    delete parsed.keyboardKeys;
                    this.logger?.info(`Migrated keyboardKeys (${oldKeys}) to keyboardOctaves (${parsed.keyboardOctaves})`);
                }

                // Migration: light theme removed → colored
                if (parsed.theme === 'light') {
                    parsed.theme = 'colored';
                    this.logger?.info('Migrated theme light → colored');
                }

                return { ...defaults, ...parsed };
            }
        } catch (error) {
            this.logger?.error('Failed to load settings:', error);
        }

        return defaults;
    }

    /**
     * Save settings to localStorage
     */
    saveSettings() {
        try {
            localStorage.setItem('gmboop_settings', JSON.stringify(this.settings));
            this.logger?.info('Settings saved');
        } catch (error) {
            this.logger?.error('Failed to save settings:', error);
        }
    }

    /**
     * Create the modal's HTML structure
     */
    createModal() {
        // Modal overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'settings-modal-overlay';
        this.overlay.style.display = 'none';

        // Modal container
        this.modal = document.createElement('div');
        this.modal.className = 'settings-modal';

        // Header
        const header = document.createElement('div');
        header.className = 'settings-modal-header';
        header.innerHTML = `
            <h2 class="settings-title" data-i18n="settings.title">⚙️ ${i18n.t('settings.title')}</h2>
            <div id="stableUpdateHeaderBanner" style="display:none; align-items:center; gap:10px; background: linear-gradient(135deg, #dcfce7, #bbf7d0); border: 1.5px solid #16a34a; border-radius: 20px; padding: 6px 12px 6px 14px; font-size: 13px; color: #15803d; font-weight: 600; animation: pulse-green 2s ease-in-out infinite;">
                <span id="stableUpdateHeaderLabel">🆕 ${i18n.t('settings.update.newVersion') || 'Nouvelle version'}</span>
                <button id="stableUpdateHeaderBtn" style="padding: 4px 12px; border: none; border-radius: 12px; background: #16a34a; color: white; cursor: pointer; font-size: 12px; font-weight: 600; white-space: nowrap; transition: background 0.2s;">📦 ${i18n.t('settings.update.stableButton') || 'Installer stable'}</button>
            </div>
            <button class="settings-close-btn">×</button>
        `;

        // Content
        const content = document.createElement('div');
        content.className = 'settings-modal-content';
        content.innerHTML = this.renderContent();

        // Footer
        const footer = document.createElement('div');
        footer.className = 'settings-modal-footer';
        footer.innerHTML = `
            <button class="btn settings-cancel-btn">${i18n.t('common.cancel')}</button>
            <button class="btn settings-save-btn">${i18n.t('common.save')}</button>
        `;

        // Assemble the modal
        this.modal.appendChild(header);
        this.modal.appendChild(content);
        this.modal.appendChild(footer);
        this.overlay.appendChild(this.modal);
        document.body.appendChild(this.overlay);

        // Add styles for the toggle
        this.addToggleStyles();
    }

    /**
     * Configure event listeners
     */
    setupEventListeners() {
        this.modal.querySelector('.settings-close-btn').addEventListener('click', () => this.close());
        this.modal.querySelector('.settings-cancel-btn').addEventListener('click', () => this.close());
        this.modal.querySelector('.settings-save-btn').addEventListener('click', () => this.save());

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this._escHandler = (e) => {
            if (e.key === 'Escape' && this.overlay.style.display === 'flex') this.close();
        };
        document.addEventListener('keydown', this._escHandler);

        this.attachContentEventListeners();
    }

    /**
     * Attach the content events (called after the content is updated)
     */
    attachContentEventListeners() {
        const languageSelect = this.modal.querySelector('#languageSelect');
        if (languageSelect) {
            languageSelect.addEventListener('change', async (e) => {
                await i18n.setLocale(e.target.value);
            });
        }

        // Dark mode toggle - no immediate action, applied on save

        const timeRange = this.modal.querySelector('#noteDisplayTimeRange');
        const timeValue = this.modal.querySelector('#noteDisplayTimeValue');
        if (timeRange) {
            timeRange.addEventListener('input', (e) => {
                timeValue.textContent = e.target.value + 's';
            });
        }

        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');
        const serialPortsSection = this.modal.querySelector('#serialMidiPortsSection');
        if (serialMidiToggle && serialPortsSection) {
            serialMidiToggle.addEventListener('change', (e) => {
                serialPortsSection.style.display = e.target.checked ? 'block' : 'none';
            });
        }

        const serialScanBtn = this.modal.querySelector('#serialScanBtn');
        if (serialScanBtn) {
            serialScanBtn.addEventListener('click', () => this.scanSerialPorts());
        }

        const soundBankSelect = this.modal.querySelector('#soundBankSelect');
        const soundBankDesc = this.modal.querySelector('#soundBankDescription');
        if (soundBankSelect && soundBankDesc) {
            soundBankSelect.addEventListener('change', (e) => {
                const banks = typeof MidiSynthesizer !== 'undefined' && MidiSynthesizer.getAvailableBanks
                    ? MidiSynthesizer.getAvailableBanks() : [];
                const selected = banks.find(b => b.id === e.target.value);
                if (selected && selected.descKey) {
                    soundBankDesc.textContent = i18n.t(selected.descKey) || i18n.t('settings.soundBank.description') || '';
                } else {
                    soundBankDesc.textContent = i18n.t('settings.soundBank.description') || '';
                }
                // Reload the per-bank effect sliders for the newly
                // selected bank (may have its own stored overrides).
                if (typeof this.hydrateBankEffects === 'function') {
                    this.hydrateBankEffects();
                }
            });
        }

        if (typeof this.attachBankEffectsListeners === 'function') {
            this.attachBankEffectsListeners();
        }

        const stableUpdateBtn = this.modal.querySelector('#stableUpdateBtn');
        if (stableUpdateBtn) {
            stableUpdateBtn.addEventListener('click', () => this.triggerSystemUpdate('stable'));
        }
        const stableUpdateHeaderBtn = this.modal.querySelector('#stableUpdateHeaderBtn');
        if (stableUpdateHeaderBtn) {
            stableUpdateHeaderBtn.addEventListener('click', () => this.triggerSystemUpdate('stable'));
        }
        const betaUpdateBtn = this.modal.querySelector('#betaUpdateBtn');
        if (betaUpdateBtn) {
            betaUpdateBtn.addEventListener('click', () => this.triggerSystemUpdate('beta'));
        }

        if (typeof this.attachHotspotListeners === 'function') {
            this.attachHotspotListeners();
        }

        if (typeof this.attachSF2Listeners === 'function') {
            this.attachSF2Listeners();
        }

        const startupUpdateCheckToggle = this.modal.querySelector('#startupUpdateCheckToggle');
        const startupBetaNotifToggle = this.modal.querySelector('#startupBetaNotifToggle');
        if (startupUpdateCheckToggle && startupBetaNotifToggle) {
            startupUpdateCheckToggle.addEventListener('change', () => {
                startupBetaNotifToggle.disabled = !startupUpdateCheckToggle.checked;
            });
        }
    }

    /**
     * Open the modal
     */
    open() {
        this.overlay.style.display = 'flex';
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
        }
        document.addEventListener('keydown', this._escHandler);

        // Reset cancellation flag so update polling can resume if needed
        this._updateCancelled = false;

        // Restore current values
        const darkModeToggle = this.modal.querySelector('#darkModeToggle');
        if (darkModeToggle) darkModeToggle.checked = this.settings.theme === 'dark';

        const timeRange = this.modal.querySelector('#noteDisplayTimeRange');
        const timeValue = this.modal.querySelector('#noteDisplayTimeValue');

        if (timeRange) timeRange.value = this.settings.noteDisplayTime;
        if (timeValue) timeValue.textContent = this.settings.noteDisplayTime + 's';

        const pianoRollToggle = this.modal.querySelector('#showPianoRollToggle');
        if (pianoRollToggle) pianoRollToggle.checked = this.settings.showPianoRoll;

        const lyricsToggle = this.modal.querySelector('#showLyricsToggle');
        if (lyricsToggle) lyricsToggle.checked = this.settings.showLyrics;

        const debugButtonToggle = this.modal.querySelector('#showDebugButtonToggle');
        if (debugButtonToggle) debugButtonToggle.checked = this.settings.showDebugButton;

        const calibrationButtonToggle = this.modal.querySelector('#showCalibrationButtonToggle');
        if (calibrationButtonToggle) calibrationButtonToggle.checked = this.settings.showCalibrationButton;

        const lightingButtonToggle = this.modal.querySelector('#showLightingButtonToggle');
        if (lightingButtonToggle) lightingButtonToggle.checked = this.settings.showLightingButton;

        const playlistButtonToggle = this.modal.querySelector('#showPlaylistButtonToggle');
        if (playlistButtonToggle) playlistButtonToggle.checked = this.settings.showPlaylistButton;

        const keyboardButtonToggle = this.modal.querySelector('#showKeyboardButtonToggle');
        if (keyboardButtonToggle) keyboardButtonToggle.checked = this.settings.showKeyboardButton;

        const loopCreatorButtonToggle = this.modal.querySelector('#showLoopCreatorButtonToggle');
        if (loopCreatorButtonToggle) loopCreatorButtonToggle.checked = this.settings.showLoopCreatorButton;

        const keyboardLayoutSelect = this.modal.querySelector('#keyboardLayoutSelect');
        if (keyboardLayoutSelect) keyboardLayoutSelect.value = this.settings.keyboardLayout || 'azerty';

        const instrumentsButtonToggle = this.modal.querySelector('#showInstrumentsButtonToggle');
        if (instrumentsButtonToggle) instrumentsButtonToggle.checked = this.settings.showInstrumentsButton;

        const midiClockToggle = this.modal.querySelector('#midiClockToggle');
        if (midiClockToggle) midiClockToggle.checked = this.settings.midiClockEnabled;

        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');
        if (serialMidiToggle) serialMidiToggle.checked = this.settings.serialMidiEnabled;
        const serialPortsSection = this.modal.querySelector('#serialMidiPortsSection');
        if (serialPortsSection) serialPortsSection.style.display = this.settings.serialMidiEnabled ? 'block' : 'none';

        const loadingAnimationToggle = this.modal.querySelector('#showLoadingAnimationToggle');
        if (loadingAnimationToggle) loadingAnimationToggle.checked = this.settings.showLoadingAnimation;

        const pianoRollV2Toggle = this.modal.querySelector('#usePianoRollV2Toggle');
        if (pianoRollV2Toggle) pianoRollV2Toggle.checked = this.settings.usePianoRollV2;

        const startupUpdateCheckToggle = this.modal.querySelector('#startupUpdateCheckToggle');
        if (startupUpdateCheckToggle) startupUpdateCheckToggle.checked = this.settings.startupUpdateCheck;
        const startupBetaNotifToggle = this.modal.querySelector('#startupBetaNotifToggle');
        if (startupBetaNotifToggle) {
            startupBetaNotifToggle.checked = this.settings.startupBetaNotif;
            startupBetaNotifToggle.disabled = !this.settings.startupUpdateCheck;
        }

        const soundBankSelect = this.modal.querySelector('#soundBankSelect');
        if (soundBankSelect) soundBankSelect.value = this.settings.soundBank;

        // Load per-bank effect slider values for the current bank.
        if (typeof this.hydrateBankEffects === 'function') {
            this.hydrateBankEffects();
        }

        // Load custom SF2 soundfonts and repopulate the bank dropdown.
        if (typeof this.loadCustomBanks === 'function') {
            this.loadCustomBanks();
        }

        this.logger?.info('Settings modal opened');
        this.checkForUpdates();

        if (typeof this.hydrateHotspot === 'function') {
            this.hydrateHotspot();
        }
    }

    /**
     * Close the modal
     */
    close() {
        this.overlay.style.display = 'none';
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
        }

        // Only cancel update polling if no update is in progress
        // (when an update is running, the confirm modal handles status display)
        if (!this._updateInProgress) {
            if (typeof this._cleanupUpdatePolling === 'function') {
                this._cleanupUpdatePolling();
            }
            this._updateCancelled = true;
        }

        this.logger?.info('Settings modal closed');
    }

    /**
     * Save and apply the settings
     */
    save() {
        const darkModeToggle = this.modal.querySelector('#darkModeToggle');
        const timeRange = this.modal.querySelector('#noteDisplayTimeRange');
        const pianoRollToggle = this.modal.querySelector('#showPianoRollToggle');
        const lyricsToggle = this.modal.querySelector('#showLyricsToggle');
        const debugButtonToggle = this.modal.querySelector('#showDebugButtonToggle');
        const calibrationButtonToggle = this.modal.querySelector('#showCalibrationButtonToggle');
        const lightingButtonToggle = this.modal.querySelector('#showLightingButtonToggle');
        const playlistButtonToggle = this.modal.querySelector('#showPlaylistButtonToggle');
        const keyboardButtonToggle = this.modal.querySelector('#showKeyboardButtonToggle');
        const keyboardLayoutSelect = this.modal.querySelector('#keyboardLayoutSelect');
        const instrumentsButtonToggle = this.modal.querySelector('#showInstrumentsButtonToggle');
        const loopCreatorButtonToggle = this.modal.querySelector('#showLoopCreatorButtonToggle');
        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');
        const midiClockToggle = this.modal.querySelector('#midiClockToggle');
        const loadingAnimationToggle = this.modal.querySelector('#showLoadingAnimationToggle');
        const pianoRollV2Toggle = this.modal.querySelector('#usePianoRollV2Toggle');
        const startupUpdateCheckToggle = this.modal.querySelector('#startupUpdateCheckToggle');
        const startupBetaNotifToggle = this.modal.querySelector('#startupBetaNotifToggle');
        const soundBankSelect = this.modal.querySelector('#soundBankSelect');

        // The virtual-instrument flag is owned by the Gestion des instruments
        // header now — re-read the freshest value from storage so saving the
        // global settings doesn't stomp a recent change made there.
        let currentVirtual = this.settings.virtualInstrument;
        try {
            const saved = localStorage.getItem('gmboop_settings');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (typeof parsed.virtualInstrument === 'boolean') currentVirtual = parsed.virtualInstrument;
            }
        } catch (e) { /* ignore */ }

        const newSettings = {
            theme: darkModeToggle ? (darkModeToggle.checked ? 'dark' : 'colored') : this.settings.theme,
            keyboardOctaves: this.settings.keyboardOctaves,
            noteDisplayTime: timeRange ? parseInt(timeRange.value) : this.settings.noteDisplayTime,
            virtualInstrument: currentVirtual,
            showPianoRoll: pianoRollToggle ? pianoRollToggle.checked : this.settings.showPianoRoll,
            showLyrics: lyricsToggle ? lyricsToggle.checked : this.settings.showLyrics,
            showDebugButton: debugButtonToggle ? debugButtonToggle.checked : this.settings.showDebugButton,
            showCalibrationButton: calibrationButtonToggle ? calibrationButtonToggle.checked : this.settings.showCalibrationButton,
            showLightingButton: lightingButtonToggle ? lightingButtonToggle.checked : this.settings.showLightingButton,
            showPlaylistButton: playlistButtonToggle ? playlistButtonToggle.checked : this.settings.showPlaylistButton,
            showKeyboardButton: keyboardButtonToggle ? keyboardButtonToggle.checked : this.settings.showKeyboardButton,
            keyboardLayout: keyboardLayoutSelect ? keyboardLayoutSelect.value : (this.settings.keyboardLayout || 'azerty'),
            showInstrumentsButton: instrumentsButtonToggle ? instrumentsButtonToggle.checked : this.settings.showInstrumentsButton,
            showLoopCreatorButton: loopCreatorButtonToggle ? loopCreatorButtonToggle.checked : this.settings.showLoopCreatorButton,
            midiClockEnabled: midiClockToggle ? midiClockToggle.checked : this.settings.midiClockEnabled,
            serialMidiEnabled: serialMidiToggle ? serialMidiToggle.checked : this.settings.serialMidiEnabled,
            showLoadingAnimation: loadingAnimationToggle ? loadingAnimationToggle.checked : this.settings.showLoadingAnimation,
            usePianoRollV2: pianoRollV2Toggle ? pianoRollV2Toggle.checked : this.settings.usePianoRollV2,
            soundBank: soundBankSelect ? soundBankSelect.value : this.settings.soundBank,
            startupUpdateCheck: startupUpdateCheckToggle ? startupUpdateCheckToggle.checked : this.settings.startupUpdateCheck,
            startupBetaNotif: startupBetaNotifToggle ? startupBetaNotifToggle.checked : this.settings.startupBetaNotif
        };

        const themeChanged = newSettings.theme !== this.settings.theme;
        const timeChanged = newSettings.noteDisplayTime !== this.settings.noteDisplayTime;
        const pianoRollChanged = newSettings.showPianoRoll !== this.settings.showPianoRoll;
        const lyricsChanged = newSettings.showLyrics !== this.settings.showLyrics;
        const debugButtonChanged = newSettings.showDebugButton !== this.settings.showDebugButton;
        const calibrationButtonChanged = newSettings.showCalibrationButton !== this.settings.showCalibrationButton;
        const lightingButtonChanged = newSettings.showLightingButton !== this.settings.showLightingButton;
        const playlistButtonChanged = newSettings.showPlaylistButton !== this.settings.showPlaylistButton;
        const keyboardButtonChanged = newSettings.showKeyboardButton !== this.settings.showKeyboardButton;
        const instrumentsButtonChanged = newSettings.showInstrumentsButton !== this.settings.showInstrumentsButton;
        const loopCreatorButtonChanged = newSettings.showLoopCreatorButton !== this.settings.showLoopCreatorButton;
        const midiClockChanged = newSettings.midiClockEnabled !== this.settings.midiClockEnabled;
        const serialMidiChanged = newSettings.serialMidiEnabled !== this.settings.serialMidiEnabled;
        const soundBankChanged = newSettings.soundBank !== this.settings.soundBank;

        this.settings = newSettings;
        this.saveSettings();
        this.applySettings();

        if (themeChanged) this.eventBus?.emit('settings:theme_changed', { theme: newSettings.theme });
        if (timeChanged) this.eventBus?.emit('settings:display_time_changed', { time: newSettings.noteDisplayTime });
        if (pianoRollChanged) {
            this.eventBus?.emit('settings:piano_roll_changed', { enabled: newSettings.showPianoRoll });
            this.logger?.info(`🎹 ${i18n.t(newSettings.showPianoRoll ? 'settings.pianoRoll.enabled' : 'settings.pianoRoll.disabled')}`);
        }
        if (lyricsChanged) {
            this.eventBus?.emit('settings:lyrics_changed', { enabled: newSettings.showLyrics });
            this.logger?.info(`🎤 ${i18n.t(newSettings.showLyrics ? 'settings.lyrics.enabled' : 'settings.lyrics.disabled')}`);
        }
        if (debugButtonChanged) {
            this.eventBus?.emit('settings:debug_button_changed', { enabled: newSettings.showDebugButton });
            this.applyDebugButton(newSettings.showDebugButton);
        }
        if (calibrationButtonChanged) {
            this.eventBus?.emit('settings:calibration_button_changed', { enabled: newSettings.showCalibrationButton });
            this.applyCalibrationButton(newSettings.showCalibrationButton);
        }
        if (lightingButtonChanged) {
            this.eventBus?.emit('settings:lighting_button_changed', { enabled: newSettings.showLightingButton });
            this.applyLightingButton(newSettings.showLightingButton);
        }
        if (playlistButtonChanged) {
            this.eventBus?.emit('settings:playlist_button_changed', { enabled: newSettings.showPlaylistButton });
            this.applyPlaylistButton(newSettings.showPlaylistButton);
        }
        if (keyboardButtonChanged) {
            this.eventBus?.emit('settings:keyboard_button_changed', { enabled: newSettings.showKeyboardButton });
            this.applyKeyboardButton(newSettings.showKeyboardButton);
        }
        if (instrumentsButtonChanged) {
            this.eventBus?.emit('settings:instruments_button_changed', { enabled: newSettings.showInstrumentsButton });
            this.applyInstrumentsButton(newSettings.showInstrumentsButton);
        }
        if (loopCreatorButtonChanged) {
            this.eventBus?.emit('settings:loop_creator_button_changed', { enabled: newSettings.showLoopCreatorButton });
            this.applyLoopCreatorButton(newSettings.showLoopCreatorButton);
        }
        if (midiClockChanged) this.eventBus?.emit('settings:midi_clock_changed', { enabled: newSettings.midiClockEnabled });
        if (serialMidiChanged) this.eventBus?.emit('settings:serial_midi_changed', { enabled: newSettings.serialMidiEnabled });
        if (soundBankChanged) {
            this.eventBus?.emit('settings:sound_bank_changed', { bankId: newSettings.soundBank });
            this.logger?.info(`🔊 ${i18n.t('settings.soundBank.changed') || 'Sound bank changed'}: ${newSettings.soundBank}`);
        }

        this.close();
        this.logger?.info('Settings saved and applied', newSettings);
    }

    /**
     * Apply the current settings
     */
    applySettings() {
        this.applyTheme(this.settings.theme);
        this.applyDebugButton(this.settings.showDebugButton);
        this.applyCalibrationButton(this.settings.showCalibrationButton);
        this.applyLightingButton(this.settings.showLightingButton);
        this.applyPlaylistButton(this.settings.showPlaylistButton);
        this.applyKeyboardButton(this.settings.showKeyboardButton);
        this.applyInstrumentsButton(this.settings.showInstrumentsButton);
        this.applyLoopCreatorButton(this.settings.showLoopCreatorButton);
    }

    applyLoopCreatorButton(show) {
        const loopCreatorBtn = document.getElementById('loopCreatorBtn');
        if (loopCreatorBtn) loopCreatorBtn.style.display = show ? 'flex' : 'none';
    }

    applyDebugButton(show) {
        const debugToggle = document.getElementById('debugToggle');
        if (debugToggle) debugToggle.style.display = show ? 'flex' : 'none';
    }

    applyCalibrationButton(show) {
        const calibrationBtn = document.getElementById('calibrationBtn');
        if (calibrationBtn) calibrationBtn.style.display = show ? 'flex' : 'none';
    }

    applyLightingButton(show) {
        const lightingBtn = document.getElementById('lightingBtn');
        if (lightingBtn) lightingBtn.style.display = show ? 'flex' : 'none';
    }

    applyPlaylistButton(show) {
        const playlistBtn = document.getElementById('playlistBtn');
        if (playlistBtn) playlistBtn.style.display = show ? 'flex' : 'none';
    }

    applyKeyboardButton(show) {
        const keyboardBtn = document.getElementById('openKeyboardBtn');
        if (keyboardBtn) keyboardBtn.style.display = show ? 'flex' : 'none';
    }

    applyInstrumentsButton(show) {
        const instrumentsBtn = document.getElementById('instrumentsBtn');
        if (instrumentsBtn) instrumentsBtn.style.display = show ? 'flex' : 'none';
    }

    /**
     * Get the current settings
     */
    getSettings() {
        return { ...this.settings };
    }
}

// Apply mixins
Object.assign(SettingsModal.prototype, SettingsTemplates);
Object.assign(SettingsModal.prototype, SettingsTheme);
Object.assign(SettingsModal.prototype, SettingsUpdate);
Object.assign(SettingsModal.prototype, SettingsSerial);
if (typeof SettingsBankEffects !== 'undefined') {
    Object.assign(SettingsModal.prototype, SettingsBankEffects);
}
if (typeof SettingsHotspot !== 'undefined') {
    Object.assign(SettingsModal.prototype, SettingsHotspot);
}
if (typeof SettingsSF2 !== 'undefined') {
    Object.assign(SettingsModal.prototype, SettingsSF2);
}

// Export global
if (typeof window !== 'undefined') {
    window.SettingsModal = SettingsModal;
}
