/**
 * SettingsModal - Modal pour les réglages de l'application
 *
 * Fonctionnalités :
 * - Modification du thème (colored par défaut, dark en option)
 * - Ajustement du nombre de touches du clavier
 * - Modification du temps d'affichage des notes
 * - Gestion de l'instrument virtuel
 * - Sélection de la langue (FR, EN, ES)
 *
 * Dépendance: i18n doit être chargé avant ce script (js/i18n/I18n.js)
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

        // Paramètres par défaut
        this.settings = this.loadSettings();

        // Initialisation
        this.init();
    }

    init() {
        this.createModal();
        this.setupEventListeners();
        this.applySettings();

        // Écouter les changements de langue pour mettre à jour le modal
        i18n.onLocaleChange(() => this.updateModalTexts());
    }

    /**
     * Charger les paramètres depuis localStorage
     */
    loadSettings() {
        const defaults = {
            theme: 'colored',
            keyboardOctaves: 2, // 2 octaves par défaut (24 touches)
            noteDisplayTime: 20, // secondes
            virtualInstrument: false,
            showPianoRoll: false,
            showDebugButton: true,
            showCalibrationButton: false,
            showLightingButton: false,
            serialMidiEnabled: false
        };

        try {
            const saved = localStorage.getItem('maestro_settings');
            if (saved) {
                const parsed = JSON.parse(saved);

                // Migration: convertir keyboardKeys → keyboardOctaves si nécessaire
                if (parsed.keyboardKeys !== undefined && parsed.keyboardOctaves === undefined) {
                    const oldKeys = parsed.keyboardKeys;
                    parsed.keyboardOctaves = Math.ceil(oldKeys / 12);
                    delete parsed.keyboardKeys;
                    this.logger?.info(`Migrated keyboardKeys (${oldKeys}) to keyboardOctaves (${parsed.keyboardOctaves})`);
                }

                // Migration: thème light supprimé → colored
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
     * Sauvegarder les paramètres dans localStorage
     */
    saveSettings() {
        try {
            localStorage.setItem('maestro_settings', JSON.stringify(this.settings));
            this.logger?.info('Settings saved');
        } catch (error) {
            this.logger?.error('Failed to save settings:', error);
        }
    }

    /**
     * Créer la structure HTML du modal
     */
    createModal() {
        // Modal overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'settings-modal-overlay';
        this.overlay.style.cssText = `
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            z-index: 9998;
            align-items: center;
            justify-content: center;
        `;

        // Modal container
        this.modal = document.createElement('div');
        this.modal.className = 'settings-modal';
        this.modal.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 0;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        `;

        // Header
        const header = document.createElement('div');
        header.className = 'settings-modal-header';
        header.style.cssText = `
            padding: 24px;
            border-bottom: 1px solid #e5e7eb;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `
            <h2 class="settings-title" style="margin: 0; color: #667eea; font-size: 20px;" data-i18n="settings.title">⚙️ ${i18n.t('settings.title')}</h2>
            <button class="settings-close-btn" style="
                background: transparent;
                border: none;
                font-size: 24px;
                cursor: pointer;
                color: #999;
                line-height: 1;
                padding: 0;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                transition: all 0.2s;
            ">×</button>
        `;

        // Content
        const content = document.createElement('div');
        content.className = 'settings-modal-content';
        content.style.cssText = `
            padding: 24px;
            overflow-y: auto;
            flex: 1;
        `;
        content.innerHTML = this.renderContent();

        // Footer
        const footer = document.createElement('div');
        footer.className = 'settings-modal-footer';
        footer.style.cssText = `
            padding: 16px 24px;
            border-top: 1px solid #e5e7eb;
            display: flex;
            justify-content: flex-end;
            gap: 12px;
        `;
        footer.innerHTML = `
            <button class="btn btn-secondary settings-cancel-btn" style="
                padding: 10px 20px;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                background: white;
                color: #666;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
            ">${i18n.t('common.cancel')}</button>
            <button class="btn btn-primary settings-save-btn" style="
                padding: 10px 20px;
                border: none;
                border-radius: 6px;
                background: #667eea;
                color: white;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
            ">${i18n.t('common.save')}</button>
        `;

        // Assembler le modal
        this.modal.appendChild(header);
        this.modal.appendChild(content);
        this.modal.appendChild(footer);
        this.overlay.appendChild(this.modal);
        document.body.appendChild(this.overlay);

        // Ajouter les styles pour le toggle
        this.addToggleStyles();
    }

    /**
     * Configurer les écouteurs d'événements
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
     * Attacher les événements du contenu (appelé après mise à jour du contenu)
     */
    attachContentEventListeners() {
        const languageSelect = this.modal.querySelector('#languageSelect');
        if (languageSelect) {
            languageSelect.addEventListener('change', async (e) => {
                await i18n.setLocale(e.target.value);
            });
        }

        // Dark mode toggle - pas d'action immédiate, appliqué au save

        const keyboardRange = this.modal.querySelector('#keyboardOctavesRange');
        const keyboardValue = this.modal.querySelector('#keyboardOctavesValue');
        const keyboardTouchesCount = this.modal.querySelector('#keyboardTouchesCount');
        if (keyboardRange) {
            keyboardRange.addEventListener('input', (e) => {
                const octaves = parseInt(e.target.value);
                keyboardValue.textContent = octaves;
                keyboardTouchesCount.textContent = octaves * 12;
            });
        }

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

        const updateBtn = this.modal.querySelector('#systemUpdateBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => this.triggerSystemUpdate());
        }
    }

    /**
     * Ouvrir le modal
     */
    open() {
        this.overlay.style.display = 'flex';
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
        }
        document.addEventListener('keydown', this._escHandler);

        // Restaurer les valeurs actuelles
        const darkModeToggle = this.modal.querySelector('#darkModeToggle');
        if (darkModeToggle) darkModeToggle.checked = this.settings.theme === 'dark';

        const keyboardRange = this.modal.querySelector('#keyboardOctavesRange');
        const keyboardValue = this.modal.querySelector('#keyboardOctavesValue');
        const keyboardTouchesCount = this.modal.querySelector('#keyboardTouchesCount');
        const timeRange = this.modal.querySelector('#noteDisplayTimeRange');
        const timeValue = this.modal.querySelector('#noteDisplayTimeValue');
        const virtualToggle = this.modal.querySelector('#virtualInstrumentToggle');

        if (keyboardRange) keyboardRange.value = this.settings.keyboardOctaves;
        if (keyboardValue) keyboardValue.textContent = this.settings.keyboardOctaves;
        if (keyboardTouchesCount) keyboardTouchesCount.textContent = this.settings.keyboardOctaves * 12;
        if (timeRange) timeRange.value = this.settings.noteDisplayTime;
        if (timeValue) timeValue.textContent = this.settings.noteDisplayTime + 's';
        if (virtualToggle) virtualToggle.checked = this.settings.virtualInstrument;

        const pianoRollToggle = this.modal.querySelector('#showPianoRollToggle');
        if (pianoRollToggle) pianoRollToggle.checked = this.settings.showPianoRoll;

        const debugButtonToggle = this.modal.querySelector('#showDebugButtonToggle');
        if (debugButtonToggle) debugButtonToggle.checked = this.settings.showDebugButton;

        const calibrationButtonToggle = this.modal.querySelector('#showCalibrationButtonToggle');
        if (calibrationButtonToggle) calibrationButtonToggle.checked = this.settings.showCalibrationButton;

        const lightingButtonToggle = this.modal.querySelector('#showLightingButtonToggle');
        if (lightingButtonToggle) lightingButtonToggle.checked = this.settings.showLightingButton;

        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');
        if (serialMidiToggle) serialMidiToggle.checked = this.settings.serialMidiEnabled;
        const serialPortsSection = this.modal.querySelector('#serialMidiPortsSection');
        if (serialPortsSection) serialPortsSection.style.display = this.settings.serialMidiEnabled ? 'block' : 'none';

        this.logger?.info('Settings modal opened');
        this.checkForUpdates();
    }

    /**
     * Fermer le modal
     */
    close() {
        this.overlay.style.display = 'none';
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
        }
        this.logger?.info('Settings modal closed');
    }

    /**
     * Sauvegarder et appliquer les paramètres
     */
    save() {
        const darkModeToggle = this.modal.querySelector('#darkModeToggle');
        const keyboardRange = this.modal.querySelector('#keyboardOctavesRange');
        const timeRange = this.modal.querySelector('#noteDisplayTimeRange');
        const virtualToggle = this.modal.querySelector('#virtualInstrumentToggle');
        const pianoRollToggle = this.modal.querySelector('#showPianoRollToggle');
        const debugButtonToggle = this.modal.querySelector('#showDebugButtonToggle');
        const calibrationButtonToggle = this.modal.querySelector('#showCalibrationButtonToggle');
        const lightingButtonToggle = this.modal.querySelector('#showLightingButtonToggle');
        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');

        const newSettings = {
            theme: darkModeToggle ? (darkModeToggle.checked ? 'dark' : 'colored') : this.settings.theme,
            keyboardOctaves: keyboardRange ? parseInt(keyboardRange.value) : this.settings.keyboardOctaves,
            noteDisplayTime: timeRange ? parseInt(timeRange.value) : this.settings.noteDisplayTime,
            virtualInstrument: virtualToggle ? virtualToggle.checked : this.settings.virtualInstrument,
            showPianoRoll: pianoRollToggle ? pianoRollToggle.checked : this.settings.showPianoRoll,
            showDebugButton: debugButtonToggle ? debugButtonToggle.checked : this.settings.showDebugButton,
            showCalibrationButton: calibrationButtonToggle ? calibrationButtonToggle.checked : this.settings.showCalibrationButton,
            showLightingButton: lightingButtonToggle ? lightingButtonToggle.checked : this.settings.showLightingButton,
            serialMidiEnabled: serialMidiToggle ? serialMidiToggle.checked : this.settings.serialMidiEnabled
        };

        const themeChanged = newSettings.theme !== this.settings.theme;
        const keyboardChanged = newSettings.keyboardOctaves !== this.settings.keyboardOctaves;
        const timeChanged = newSettings.noteDisplayTime !== this.settings.noteDisplayTime;
        const virtualInstrumentChanged = newSettings.virtualInstrument !== this.settings.virtualInstrument;
        const pianoRollChanged = newSettings.showPianoRoll !== this.settings.showPianoRoll;
        const debugButtonChanged = newSettings.showDebugButton !== this.settings.showDebugButton;
        const calibrationButtonChanged = newSettings.showCalibrationButton !== this.settings.showCalibrationButton;
        const lightingButtonChanged = newSettings.showLightingButton !== this.settings.showLightingButton;
        const serialMidiChanged = newSettings.serialMidiEnabled !== this.settings.serialMidiEnabled;

        this.settings = newSettings;
        this.saveSettings();
        this.applySettings();

        if (themeChanged) this.eventBus?.emit('settings:theme_changed', { theme: newSettings.theme });
        if (keyboardChanged) this.eventBus?.emit('settings:keyboard_changed', { octaves: newSettings.keyboardOctaves });
        if (timeChanged) this.eventBus?.emit('settings:display_time_changed', { time: newSettings.noteDisplayTime });
        if (virtualInstrumentChanged) {
            this.eventBus?.emit('settings:virtual_instrument_changed', { enabled: newSettings.virtualInstrument });
            this.logger?.info(`🎵 ${i18n.t(newSettings.virtualInstrument ? 'settings.virtualInstrument.enabled' : 'settings.virtualInstrument.disabled')}`);
        }
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
        if (serialMidiChanged) this.eventBus?.emit('settings:serial_midi_changed', { enabled: newSettings.serialMidiEnabled });

        this.close();
        this.logger?.info('Settings saved and applied', newSettings);
    }

    /**
     * Appliquer les paramètres actuels
     */
    applySettings() {
        this.applyTheme(this.settings.theme);
        this.applyDebugButton(this.settings.showDebugButton);
        this.applyCalibrationButton(this.settings.showCalibrationButton);
        this.applyLightingButton(this.settings.showLightingButton);
    }

    applyDebugButton(show) {
        const debugToggle = document.getElementById('debugToggle');
        const settingsToggle = document.getElementById('settingsToggle');
        if (debugToggle) debugToggle.style.display = show ? '' : 'none';
        if (settingsToggle) settingsToggle.style.right = show ? '75px' : '20px';
    }

    applyCalibrationButton(show) {
        const calibrationBtn = document.getElementById('calibrationBtn');
        if (calibrationBtn) calibrationBtn.style.display = show ? 'flex' : 'none';
    }

    applyLightingButton(show) {
        const lightingBtn = document.getElementById('lightingBtn');
        if (lightingBtn) lightingBtn.style.display = show ? 'flex' : 'none';
    }

    /**
     * Obtenir les paramètres actuels
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

// Export global
if (typeof window !== 'undefined') {
    window.SettingsModal = SettingsModal;
}
