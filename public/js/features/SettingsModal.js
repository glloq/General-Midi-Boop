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
            noteDisplayTime: 20, // seconds
            virtualInstrument: false,
            showPianoRoll: false,
            showDebugButton: true,
            showCalibrationButton: false,
            showLightingButton: false,
            showPlaylistButton: true,
            showKeyboardButton: true,
            showInstrumentsButton: true,
            midiClockEnabled: false,
            serialMidiEnabled: false,
            showLoadingAnimation: true,
            soundBank: 'FluidR3_GM'
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

        const updateBtn = this.modal.querySelector('#systemUpdateBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => this.triggerSystemUpdate());
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

        const soundBankSelect = this.modal.querySelector('#soundBankSelect');
        if (soundBankSelect) soundBankSelect.value = this.settings.soundBank;

        // Load per-bank effect slider values for the current bank.
        if (typeof this.hydrateBankEffects === 'function') {
            this.hydrateBankEffects();
        }

        this.logger?.info('Settings modal opened');
        this.checkForUpdates();
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
        const debugButtonToggle = this.modal.querySelector('#showDebugButtonToggle');
        const calibrationButtonToggle = this.modal.querySelector('#showCalibrationButtonToggle');
        const lightingButtonToggle = this.modal.querySelector('#showLightingButtonToggle');
        const playlistButtonToggle = this.modal.querySelector('#showPlaylistButtonToggle');
        const keyboardButtonToggle = this.modal.querySelector('#showKeyboardButtonToggle');
        const instrumentsButtonToggle = this.modal.querySelector('#showInstrumentsButtonToggle');
        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');
        const midiClockToggle = this.modal.querySelector('#midiClockToggle');
        const loadingAnimationToggle = this.modal.querySelector('#showLoadingAnimationToggle');
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
            showDebugButton: debugButtonToggle ? debugButtonToggle.checked : this.settings.showDebugButton,
            showCalibrationButton: calibrationButtonToggle ? calibrationButtonToggle.checked : this.settings.showCalibrationButton,
            showLightingButton: lightingButtonToggle ? lightingButtonToggle.checked : this.settings.showLightingButton,
            showPlaylistButton: playlistButtonToggle ? playlistButtonToggle.checked : this.settings.showPlaylistButton,
            showKeyboardButton: keyboardButtonToggle ? keyboardButtonToggle.checked : this.settings.showKeyboardButton,
            showInstrumentsButton: instrumentsButtonToggle ? instrumentsButtonToggle.checked : this.settings.showInstrumentsButton,
            midiClockEnabled: midiClockToggle ? midiClockToggle.checked : this.settings.midiClockEnabled,
            serialMidiEnabled: serialMidiToggle ? serialMidiToggle.checked : this.settings.serialMidiEnabled,
            showLoadingAnimation: loadingAnimationToggle ? loadingAnimationToggle.checked : this.settings.showLoadingAnimation,
            soundBank: soundBankSelect ? soundBankSelect.value : this.settings.soundBank
        };

        const themeChanged = newSettings.theme !== this.settings.theme;
        const timeChanged = newSettings.noteDisplayTime !== this.settings.noteDisplayTime;
        const pianoRollChanged = newSettings.showPianoRoll !== this.settings.showPianoRoll;
        const debugButtonChanged = newSettings.showDebugButton !== this.settings.showDebugButton;
        const calibrationButtonChanged = newSettings.showCalibrationButton !== this.settings.showCalibrationButton;
        const lightingButtonChanged = newSettings.showLightingButton !== this.settings.showLightingButton;
        const playlistButtonChanged = newSettings.showPlaylistButton !== this.settings.showPlaylistButton;
        const keyboardButtonChanged = newSettings.showKeyboardButton !== this.settings.showKeyboardButton;
        const instrumentsButtonChanged = newSettings.showInstrumentsButton !== this.settings.showInstrumentsButton;
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

// Export global
if (typeof window !== 'undefined') {
    window.SettingsModal = SettingsModal;
}
