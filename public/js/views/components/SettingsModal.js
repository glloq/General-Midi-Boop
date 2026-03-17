/**
 * SettingsModal - Modal pour les réglages de l'application
 *
 * Fonctionnalités :
 * - Modification du thème (dark, light, colored)
 * - Ajustement du nombre de touches du clavier
 * - Modification du temps d'affichage des notes
 * - Gestion de l'instrument virtuel
 * - Sélection de la langue (FR, EN, ES)
 *
 * Dépendance: i18n doit être chargé avant ce script (js/i18n/I18n.js)
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
            theme: 'light',
            keyboardOctaves: 2, // 2 octaves par défaut (24 touches)
            noteDisplayTime: 20, // secondes
            virtualInstrument: false,
            showPianoRoll: false, // Afficher le piano roll des notes à venir
            showDebugButton: true, // Afficher le bouton de debug
            showCalibrationButton: false, // Afficher le bouton de calibration micro
            serialMidiEnabled: false // Ports série MIDI GPIO (désactivé par défaut)
        };

        try {
            const saved = localStorage.getItem('maestro_settings');
            if (saved) {
                const parsed = JSON.parse(saved);

                // Migration: convertir keyboardKeys → keyboardOctaves si nécessaire
                if (parsed.keyboardKeys !== undefined && parsed.keyboardOctaves === undefined) {
                    parsed.keyboardOctaves = Math.ceil(parsed.keyboardKeys / 12);
                    delete parsed.keyboardKeys;
                    this.logger?.info(`Migrated keyboardKeys (${parsed.keyboardKeys}) to keyboardOctaves (${parsed.keyboardOctaves})`);
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
     * Générer le contenu HTML du modal
     */
    renderContent() {
        const currentLocale = i18n.getLocale();
        const locales = i18n.getSupportedLocales();

        return `
            <!-- Langue -->
            <div class="settings-section">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🌐 ${i18n.t('settings.language.title')}</h3>
                <div class="language-selector-container" style="position: relative;">
                    <select id="languageSelect" class="language-select" style="
                        width: 100%;
                        padding: 12px 16px;
                        padding-right: 40px;
                        border: 2px solid #e5e7eb;
                        border-radius: 8px;
                        background: white;
                        cursor: pointer;
                        font-size: 15px;
                        color: #333;
                        appearance: none;
                        -webkit-appearance: none;
                        -moz-appearance: none;
                        transition: all 0.2s;
                    ">
                        ${locales.map(locale => `
                            <option value="${locale.code}" ${locale.code === currentLocale ? 'selected' : ''}>
                                ${this.getLocaleFlag(locale.code)} ${locale.name}
                            </option>
                        `).join('')}
                    </select>
                    <span style="
                        position: absolute;
                        right: 16px;
                        top: 50%;
                        transform: translateY(-50%);
                        pointer-events: none;
                        color: #666;
                        font-size: 12px;
                    ">▼</span>
                </div>
            </div>

            <!-- Thème -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🎨 ${i18n.t('settings.theme.title')}</h3>
                <div class="theme-options" style="display: flex; gap: 12px;">
                    <button class="theme-btn" data-theme="light" style="
                        flex: 1;
                        padding: 16px;
                        border: 2px solid #e5e7eb;
                        border-radius: 8px;
                        background: white;
                        cursor: pointer;
                        transition: all 0.2s;
                        font-size: 14px;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 8px;
                    ">
                        <span style="font-size: 24px;">☀️</span>
                        <span>${i18n.t('settings.theme.light')}</span>
                    </button>
                    <button class="theme-btn" data-theme="dark" style="
                        flex: 1;
                        padding: 16px;
                        border: 2px solid #e5e7eb;
                        border-radius: 8px;
                        background: white;
                        cursor: pointer;
                        transition: all 0.2s;
                        font-size: 14px;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 8px;
                    ">
                        <span style="font-size: 24px;">🌙</span>
                        <span>${i18n.t('settings.theme.dark')}</span>
                    </button>
                    <button class="theme-btn" data-theme="colored" style="
                        flex: 1;
                        padding: 16px;
                        border: 2px solid #e5e7eb;
                        border-radius: 8px;
                        background: white;
                        cursor: pointer;
                        transition: all 0.2s;
                        font-size: 14px;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 8px;
                    ">
                        <span style="font-size: 24px;">🎨</span>
                        <span>${i18n.t('settings.theme.colored')}</span>
                    </button>
                </div>
            </div>

            <!-- Clavier -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🎹 ${i18n.t('settings.keyboard.title')}</h3>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <label style="font-size: 14px; color: #666;">
                        ${i18n.t('settings.keyboard.octaveCount')} : <strong id="keyboardOctavesValue">${this.settings.keyboardOctaves}</strong>
                        <span style="color: #999; font-weight: normal;">(<span id="keyboardTouchesCount">${this.settings.keyboardOctaves * 12}</span> ${i18n.t('common.keys')})</span>
                    </label>
                    <input type="range" id="keyboardOctavesRange" min="1" max="4" step="1"
                           value="${this.settings.keyboardOctaves}"
                           style="width: 100%;">
                    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #999;">
                        <span>1 ${i18n.t('common.octave')}</span>
                        <span>4 ${i18n.t('common.octaves')}</span>
                    </div>
                </div>
            </div>

            <!-- Temps d'affichage -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">⏱️ ${i18n.t('settings.noteDisplay.title')}</h3>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <label style="font-size: 14px; color: #666;">
                        ${i18n.t('settings.noteDisplay.visibleDuration')} : <strong id="noteDisplayTimeValue">${this.settings.noteDisplayTime}s</strong>
                    </label>
                    <input type="range" id="noteDisplayTimeRange" min="5" max="60" step="5"
                           value="${this.settings.noteDisplayTime}"
                           style="width: 100%;">
                    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #999;">
                        <span>${i18n.t('settings.noteDisplay.minSeconds')}</span>
                        <span>${i18n.t('settings.noteDisplay.maxSeconds')}</span>
                    </div>
                </div>
            </div>

            <!-- Instrument virtuel -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🎵 ${i18n.t('settings.virtualInstrument.title')}</h3>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                    <div style="flex: 1;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">${i18n.t('settings.virtualInstrument.enable')}</p>
                        <p style="margin: 0; font-size: 12px; color: #666;">${i18n.t('settings.virtualInstrument.description')}</p>
                    </div>
                    <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                        <input type="checkbox" id="virtualInstrumentToggle" ${this.settings.virtualInstrument ? 'checked' : ''}
                               style="opacity: 0; width: 0; height: 0;">
                        <span class="toggle-slider" style="
                            position: absolute;
                            cursor: pointer;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-color: #ccc;
                            transition: 0.4s;
                            border-radius: 30px;
                        "></span>
                    </label>
                </div>
            </div>

            <!-- Piano Roll -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🎹 ${i18n.t('settings.pianoRoll.title')}</h3>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                    <div style="flex: 1;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">${i18n.t('settings.pianoRoll.enable')}</p>
                        <p style="margin: 0; font-size: 12px; color: #666;">${i18n.t('settings.pianoRoll.description')}</p>
                    </div>
                    <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                        <input type="checkbox" id="showPianoRollToggle" ${this.settings.showPianoRoll ? 'checked' : ''}
                               style="opacity: 0; width: 0; height: 0;">
                        <span class="toggle-slider" style="
                            position: absolute;
                            cursor: pointer;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-color: #ccc;
                            transition: 0.4s;
                            border-radius: 30px;
                        "></span>
                    </label>
                </div>
            </div>

            <!-- Bouton Debug -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🐞 ${i18n.t('settings.debugButton.title')}</h3>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                    <div style="flex: 1;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">${i18n.t('settings.debugButton.enable')}</p>
                        <p style="margin: 0; font-size: 12px; color: #666;">${i18n.t('settings.debugButton.description')}</p>
                    </div>
                    <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                        <input type="checkbox" id="showDebugButtonToggle" ${this.settings.showDebugButton ? 'checked' : ''}
                               style="opacity: 0; width: 0; height: 0;">
                        <span class="toggle-slider" style="
                            position: absolute;
                            cursor: pointer;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-color: #ccc;
                            transition: 0.4s;
                            border-radius: 30px;
                        "></span>
                    </label>
                </div>
            </div>

            <!-- Bouton Calibration Micro -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🎤 ${i18n.t('settings.calibrationButton.title') || 'Bouton Calibration Micro'}</h3>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                    <div style="flex: 1;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">${i18n.t('settings.calibrationButton.enable') || 'Afficher le bouton de calibration'}</p>
                        <p style="margin: 0; font-size: 12px; color: #666;">${i18n.t('settings.calibrationButton.description') || 'Affiche le bouton microphone pour calibrer les délais audio des instruments'}</p>
                    </div>
                    <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                        <input type="checkbox" id="showCalibrationButtonToggle" ${this.settings.showCalibrationButton ? 'checked' : ''}
                               style="opacity: 0; width: 0; height: 0;">
                        <span class="toggle-slider" style="
                            position: absolute;
                            cursor: pointer;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-color: #ccc;
                            transition: 0.4s;
                            border-radius: 30px;
                        "></span>
                    </label>
                </div>
            </div>

            <!-- Serial MIDI GPIO -->
            <div class="settings-section" style="margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">${i18n.t('settings.serialMidi.title')}</h3>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                    <div style="flex: 1;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">${i18n.t('settings.serialMidi.enable')}</p>
                        <p style="margin: 0; font-size: 12px; color: #666;">${i18n.t('settings.serialMidi.description')}</p>
                    </div>
                    <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                        <input type="checkbox" id="serialMidiToggle" ${this.settings.serialMidiEnabled ? 'checked' : ''}
                               style="opacity: 0; width: 0; height: 0;">
                        <span class="toggle-slider" style="
                            position: absolute;
                            cursor: pointer;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-color: #ccc;
                            transition: 0.4s;
                            border-radius: 30px;
                        "></span>
                    </label>
                </div>

                <!-- Serial MIDI port management (shown when enabled) -->
                <div id="serialMidiPortsSection" style="margin-top: 16px; display: ${this.settings.serialMidiEnabled ? 'block' : 'none'};">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <span style="font-size: 14px; color: #333; font-weight: 500;">${i18n.t('settings.serialMidi.ports')}</span>
                        <button id="serialScanBtn" style="
                            padding: 6px 14px;
                            border: 1px solid #667eea;
                            border-radius: 6px;
                            background: white;
                            color: #667eea;
                            cursor: pointer;
                            font-size: 13px;
                            transition: all 0.2s;
                        ">${i18n.t('settings.serialMidi.scan')}</button>
                    </div>
                    <div id="serialPortsList" style="
                        border: 1px solid #e5e7eb;
                        border-radius: 8px;
                        overflow: hidden;
                        min-height: 60px;
                    ">
                        <div style="padding: 16px; text-align: center; color: #999; font-size: 13px;">
                            ${i18n.t('settings.serialMidi.clickScan')}
                        </div>
                    </div>
                </div>
            </div>

            <!-- Mise à jour -->
            <div class="settings-section" style="margin-top: 32px; padding-top: 24px; border-top: 2px solid #e5e7eb;">
                <h3 style="margin: 0 0 16px 0; font-size: 16px; color: #333;">🔄 ${i18n.t('settings.update.title') || 'Mise à jour'}</h3>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                    <div style="flex: 1;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">${i18n.t('settings.update.description') || 'Mettre à jour le projet depuis le dépôt distant'}</p>
                        <p style="margin: 0; font-size: 12px; color: #666;">${i18n.t('settings.update.warning') || 'Le serveur redémarrera automatiquement après la mise à jour'}</p>
                    </div>
                    <button id="systemUpdateBtn" style="
                        padding: 12px 24px;
                        border: none;
                        border-radius: 8px;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 600;
                        transition: all 0.2s;
                        white-space: nowrap;
                        box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
                    ">${i18n.t('settings.update.button') || 'Mettre à jour'}</button>
                </div>
                <div id="updateStatus" style="display: none; margin-top: 12px; padding: 12px 16px; border-radius: 8px; font-size: 13px;"></div>
            </div>
        `;
    }

    /**
     * Obtenir le drapeau emoji pour une locale
     */
    getLocaleFlag(locale) {
        const flags = {
            'id': '🇮🇩',
            'cs': '🇨🇿',
            'da': '🇩🇰',
            'de': '🇩🇪',
            'en': '🇬🇧',
            'eo': '🌍',
            'es': '🇪🇸',
            'tl': '🇵🇭',
            'fr': '🇫🇷',
            'it': '🇮🇹',
            'hu': '🇭🇺',
            'nl': '🇳🇱',
            'no': '🇳🇴',
            'pl': '🇵🇱',
            'pt': '🇧🇷',
            'fi': '🇫🇮',
            'sv': '🇸🇪',
            'vi': '🇻🇳',
            'tr': '🇹🇷',
            'el': '🇬🇷',
            'ru': '🇷🇺',
            'uk': '🇺🇦',
            'bn': '🇧🇩',
            'hi': '🇮🇳',
            'th': '🇹🇭',
            'ko': '🇰🇷',
            'ja': '🇯🇵',
            'zh-CN': '🇨🇳'
        };
        return flags[locale] || '🌐';
    }

    /**
     * Mettre à jour les textes du modal lors du changement de langue
     */
    updateModalTexts() {
        if (!this.modal) return;

        // Mettre à jour le titre
        const title = this.modal.querySelector('.settings-title');
        if (title) {
            title.innerHTML = `⚙️ ${i18n.t('settings.title')}`;
        }

        // Mettre à jour le contenu
        const content = this.modal.querySelector('.settings-modal-content');
        if (content) {
            content.innerHTML = this.renderContent();
            // Réattacher les événements pour les nouveaux éléments
            this.attachContentEventListeners();
            // Restaurer les valeurs
            this.selectTheme(this.settings.theme);
        }

        // Mettre à jour les boutons du footer
        const cancelBtn = this.modal.querySelector('.settings-cancel-btn');
        const saveBtn = this.modal.querySelector('.settings-save-btn');
        if (cancelBtn) cancelBtn.textContent = i18n.t('common.cancel');
        if (saveBtn) saveBtn.textContent = i18n.t('common.save');
    }

    /**
     * Ajouter les styles CSS pour le toggle switch
     */
    addToggleStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .toggle-switch input:checked + .toggle-slider {
                background-color: #667eea !important;
            }

            .toggle-slider:before {
                position: absolute;
                content: "";
                height: 22px;
                width: 22px;
                left: 4px;
                bottom: 4px;
                background-color: white;
                transition: 0.4s;
                border-radius: 50%;
            }

            .toggle-switch input:checked + .toggle-slider:before {
                transform: translateX(30px);
            }

            .theme-btn.active {
                border-color: #667eea !important;
                background: #f0f4ff !important;
            }

            .theme-btn:hover {
                border-color: #667eea !important;
                transform: translateY(-2px);
                box-shadow: 0 4px 8px rgba(102, 126, 234, 0.2);
            }

            .language-select:hover,
            .language-select:focus {
                border-color: #667eea !important;
                outline: none;
                box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
            }

            .settings-close-btn:hover {
                background: #f3f4f6 !important;
                color: #667eea !important;
            }

            .btn-secondary:hover {
                background: #f3f4f6 !important;
            }

            .btn-primary:hover {
                background: #5568d3 !important;
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Configurer les écouteurs d'événements
     */
    setupEventListeners() {
        // Bouton fermer
        this.modal.querySelector('.settings-close-btn').addEventListener('click', () => {
            this.close();
        });

        // Bouton annuler
        this.modal.querySelector('.settings-cancel-btn').addEventListener('click', () => {
            this.close();
        });

        // Bouton enregistrer
        this.modal.querySelector('.settings-save-btn').addEventListener('click', () => {
            this.save();
        });

        // Clic en dehors du modal
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close();
            }
        });

        // Touche Escape pour fermer
        this._escHandler = (e) => {
            if (e.key === 'Escape' && this.overlay.style.display === 'flex') {
                this.close();
            }
        };
        document.addEventListener('keydown', this._escHandler);

        // Attacher les événements du contenu
        this.attachContentEventListeners();
    }

    /**
     * Attacher les événements du contenu (appelé après mise à jour du contenu)
     */
    attachContentEventListeners() {
        // Sélecteur de langue (liste déroulante)
        const languageSelect = this.modal.querySelector('#languageSelect');
        if (languageSelect) {
            languageSelect.addEventListener('change', async (e) => {
                const locale = e.target.value;
                await i18n.setLocale(locale);
            });
        }

        // Boutons de thème
        this.modal.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectTheme(btn.dataset.theme);
            });
        });

        // Range keyboard octaves
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

        // Range note display time
        const timeRange = this.modal.querySelector('#noteDisplayTimeRange');
        const timeValue = this.modal.querySelector('#noteDisplayTimeValue');
        if (timeRange) {
            timeRange.addEventListener('input', (e) => {
                timeValue.textContent = e.target.value + 's';
            });
        }

        // Serial MIDI toggle
        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');
        const serialPortsSection = this.modal.querySelector('#serialMidiPortsSection');
        if (serialMidiToggle && serialPortsSection) {
            serialMidiToggle.addEventListener('change', (e) => {
                serialPortsSection.style.display = e.target.checked ? 'block' : 'none';
            });
        }

        // Serial MIDI scan button
        const serialScanBtn = this.modal.querySelector('#serialScanBtn');
        if (serialScanBtn) {
            serialScanBtn.addEventListener('click', () => {
                this.scanSerialPorts();
            });
        }

        // System update button
        const updateBtn = this.modal.querySelector('#systemUpdateBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => {
                this.triggerSystemUpdate();
            });
        }
    }

    /**
     * Trigger system update via backend
     */
    async triggerSystemUpdate() {
        const btn = this.modal.querySelector('#systemUpdateBtn');
        const statusEl = this.modal.querySelector('#updateStatus');
        if (!btn || !statusEl) return;

        // Confirm
        if (!confirm(i18n.t('settings.update.confirm') || 'Lancer la mise à jour ? Le serveur va redémarrer.')) {
            return;
        }

        // Show progress
        btn.disabled = true;
        btn.textContent = i18n.t('settings.update.inProgress') || 'Mise à jour en cours...';
        btn.style.opacity = '0.7';
        statusEl.style.display = 'block';
        statusEl.style.background = '#eef2ff';
        statusEl.style.color = '#667eea';
        statusEl.textContent = i18n.t('settings.update.running') || 'Mise à jour en cours, veuillez patienter...';

        try {
            const api = window.api || window.apiClient;
            if (!api || !api.sendCommand) {
                throw new Error('API not available');
            }
            const result = await api.sendCommand('system_update', {}, 300000);
            statusEl.style.background = '#f0fdf4';
            statusEl.style.color = '#16a34a';
            statusEl.textContent = i18n.t('settings.update.success') || 'Mise à jour terminée ! Le serveur redémarre...';
        } catch (error) {
            statusEl.style.background = '#fef2f2';
            statusEl.style.color = '#dc2626';
            statusEl.textContent = (i18n.t('settings.update.failed') || 'Échec de la mise à jour') + ': ' + error.message;
            btn.disabled = false;
            btn.textContent = i18n.t('settings.update.button') || 'Mettre à jour';
            btn.style.opacity = '1';
        }
    }

    /**
     * Scan serial ports and display results
     */
    async scanSerialPorts() {
        const listEl = this.modal.querySelector('#serialPortsList');
        const scanBtn = this.modal.querySelector('#serialScanBtn');
        if (!listEl) return;

        // Show loading
        listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #667eea; font-size: 13px;">
            ${i18n.t('settings.serialMidi.scanning')}
        </div>`;
        if (scanBtn) scanBtn.disabled = true;

        try {
            this.eventBus?.emit('serial:scan_requested');

            // Wait for response via event
            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Scan timeout')), 10000);
                const handler = (data) => {
                    clearTimeout(timeout);
                    this.eventBus?.off('serial:scan_result', handler);
                    resolve(data);
                };
                this.eventBus?.on('serial:scan_result', handler);
            });

            if (!result.available) {
                listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #e53e3e; font-size: 13px;">
                    ${i18n.t('settings.serialMidi.notAvailable')}
                </div>`;
                return;
            }

            if (!result.ports || result.ports.length === 0) {
                listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #999; font-size: 13px;">
                    ${i18n.t('settings.serialMidi.noPorts')}
                </div>`;
                return;
            }

            // Render ports list
            listEl.innerHTML = result.ports.map(port => `
                <div style="
                    padding: 12px 16px;
                    border-bottom: 1px solid #f0f0f0;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                ">
                    <div>
                        <div style="font-size: 14px; font-weight: 500; color: #333;">
                            <span style="
                                display: inline-block;
                                width: 8px;
                                height: 8px;
                                border-radius: 50%;
                                background: ${port.isOpen ? '#38a169' : '#a0aec0'};
                                margin-right: 8px;
                            "></span>
                            ${port.name}
                        </div>
                        <div style="font-size: 12px; color: #999; margin-top: 2px;">${port.path}</div>
                    </div>
                    <button class="serial-port-toggle-btn" data-path="${port.path}" data-name="${port.name}" data-open="${port.isOpen}" style="
                        padding: 6px 14px;
                        border: 1px solid ${port.isOpen ? '#e53e3e' : '#38a169'};
                        border-radius: 6px;
                        background: white;
                        color: ${port.isOpen ? '#e53e3e' : '#38a169'};
                        cursor: pointer;
                        font-size: 12px;
                        transition: all 0.2s;
                    ">${port.isOpen ? i18n.t('common.disconnect') : i18n.t('common.connect')}</button>
                </div>
            `).join('');

            // Attach toggle buttons
            listEl.querySelectorAll('.serial-port-toggle-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const portPath = btn.dataset.path;
                    const portName = btn.dataset.name;
                    const isOpen = btn.dataset.open === 'true';

                    // Disable button during action
                    btn.disabled = true;
                    btn.textContent = '...';

                    try {
                        if (isOpen) {
                            this.eventBus?.emit('serial:close_requested', { path: portPath });
                        } else {
                            this.eventBus?.emit('serial:open_requested', { path: portPath, name: portName, direction: 'both' });
                        }

                        // Wait then rescan to show updated state
                        await new Promise(r => setTimeout(r, 500));
                        await this.scanSerialPorts();
                    } catch (error) {
                        btn.textContent = i18n.t('common.error');
                        btn.style.color = '#e53e3e';
                        btn.style.borderColor = '#e53e3e';
                        this.logger?.error(`Serial port ${isOpen ? 'close' : 'open'} error: ${error.message}`);
                        // Rescan after error to show current state
                        setTimeout(() => this.scanSerialPorts(), 1000);
                    }
                });
            });

        } catch (error) {
            listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #e53e3e; font-size: 13px;">
                ${error.message}
            </div>`;
        } finally {
            if (scanBtn) scanBtn.disabled = false;
        }
    }

    /**
     * Sélectionner un thème
     */
    selectTheme(theme) {
        this.modal.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const selectedBtn = this.modal.querySelector(`[data-theme="${theme}"]`);
        if (selectedBtn) {
            selectedBtn.classList.add('active');
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
        this.selectTheme(this.settings.theme);

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

        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');
        if (serialMidiToggle) serialMidiToggle.checked = this.settings.serialMidiEnabled;
        const serialPortsSection = this.modal.querySelector('#serialMidiPortsSection');
        if (serialPortsSection) serialPortsSection.style.display = this.settings.serialMidiEnabled ? 'block' : 'none';

        this.logger?.info('Settings modal opened');
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
        // Récupérer les nouvelles valeurs
        const activeThemeBtn = this.modal.querySelector('.theme-btn.active');
        const keyboardRange = this.modal.querySelector('#keyboardOctavesRange');
        const timeRange = this.modal.querySelector('#noteDisplayTimeRange');
        const virtualToggle = this.modal.querySelector('#virtualInstrumentToggle');
        const pianoRollToggle = this.modal.querySelector('#showPianoRollToggle');
        const debugButtonToggle = this.modal.querySelector('#showDebugButtonToggle');
        const calibrationButtonToggle = this.modal.querySelector('#showCalibrationButtonToggle');

        const serialMidiToggle = this.modal.querySelector('#serialMidiToggle');

        const newSettings = {
            theme: activeThemeBtn ? activeThemeBtn.dataset.theme : this.settings.theme,
            keyboardOctaves: keyboardRange ? parseInt(keyboardRange.value) : this.settings.keyboardOctaves,
            noteDisplayTime: timeRange ? parseInt(timeRange.value) : this.settings.noteDisplayTime,
            virtualInstrument: virtualToggle ? virtualToggle.checked : this.settings.virtualInstrument,
            showPianoRoll: pianoRollToggle ? pianoRollToggle.checked : this.settings.showPianoRoll,
            showDebugButton: debugButtonToggle ? debugButtonToggle.checked : this.settings.showDebugButton,
            showCalibrationButton: calibrationButtonToggle ? calibrationButtonToggle.checked : this.settings.showCalibrationButton,
            serialMidiEnabled: serialMidiToggle ? serialMidiToggle.checked : this.settings.serialMidiEnabled
        };

        // Vérifier les changements
        const themeChanged = newSettings.theme !== this.settings.theme;
        const keyboardChanged = newSettings.keyboardOctaves !== this.settings.keyboardOctaves;
        const timeChanged = newSettings.noteDisplayTime !== this.settings.noteDisplayTime;
        const virtualInstrumentChanged = newSettings.virtualInstrument !== this.settings.virtualInstrument;
        const pianoRollChanged = newSettings.showPianoRoll !== this.settings.showPianoRoll;
        const debugButtonChanged = newSettings.showDebugButton !== this.settings.showDebugButton;
        const calibrationButtonChanged = newSettings.showCalibrationButton !== this.settings.showCalibrationButton;
        const serialMidiChanged = newSettings.serialMidiEnabled !== this.settings.serialMidiEnabled;

        // Mettre à jour les paramètres
        this.settings = newSettings;
        this.saveSettings();
        this.applySettings();

        // Émettre les événements de changement
        if (themeChanged) {
            this.eventBus?.emit('settings:theme_changed', { theme: newSettings.theme });
        }
        if (keyboardChanged) {
            this.eventBus?.emit('settings:keyboard_changed', { octaves: newSettings.keyboardOctaves });
        }
        if (timeChanged) {
            this.eventBus?.emit('settings:display_time_changed', { time: newSettings.noteDisplayTime });
        }
        if (virtualInstrumentChanged) {
            this.eventBus?.emit('settings:virtual_instrument_changed', { enabled: newSettings.virtualInstrument });

            if (newSettings.virtualInstrument) {
                this.logger?.info(`🎵 ${i18n.t('settings.virtualInstrument.enabled')}`);
            } else {
                this.logger?.info(`🎵 ${i18n.t('settings.virtualInstrument.disabled')}`);
            }
        }
        if (pianoRollChanged) {
            this.eventBus?.emit('settings:piano_roll_changed', { enabled: newSettings.showPianoRoll });

            if (newSettings.showPianoRoll) {
                this.logger?.info(`🎹 ${i18n.t('settings.pianoRoll.enabled')}`);
            } else {
                this.logger?.info(`🎹 ${i18n.t('settings.pianoRoll.disabled')}`);
            }
        }
        if (debugButtonChanged) {
            this.eventBus?.emit('settings:debug_button_changed', { enabled: newSettings.showDebugButton });
            this.applyDebugButton(newSettings.showDebugButton);
        }
        if (calibrationButtonChanged) {
            this.eventBus?.emit('settings:calibration_button_changed', { enabled: newSettings.showCalibrationButton });
            this.applyCalibrationButton(newSettings.showCalibrationButton);
        }
        if (serialMidiChanged) {
            this.eventBus?.emit('settings:serial_midi_changed', { enabled: newSettings.serialMidiEnabled });
        }

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

        // Les autres paramètres seront appliqués par les composants concernés
        // via les événements de l'EventBus
    }

    /**
     * Appliquer la visibilité du bouton debug
     */
    applyDebugButton(show) {
        const debugToggle = document.getElementById('debugToggle');
        const settingsToggle = document.getElementById('settingsToggle');

        if (debugToggle) {
            debugToggle.style.display = show ? '' : 'none';
        }

        // Déplacer le bouton réglages à droite quand debug est caché
        if (settingsToggle) {
            settingsToggle.style.right = show ? '75px' : '20px';
        }
    }

    /**
     * Appliquer la visibilité du bouton calibration micro
     */
    applyCalibrationButton(show) {
        const calibrationBtn = document.getElementById('calibrationBtn');
        if (calibrationBtn) {
            calibrationBtn.style.display = show ? 'flex' : 'none';
        }
    }

    /**
     * Appliquer un thème
     */
    applyTheme(theme) {
        const root = document.documentElement;

        // Supprimer les classes de thème précédentes
        document.body.classList.remove('theme-light', 'theme-dark', 'theme-colored', 'dark-mode');

        // Ajouter la nouvelle classe
        document.body.classList.add(`theme-${theme}`);
        // Also add dark-mode class for CSS compatibility (used by themes.css, variables.css, etc.)
        if (theme === 'dark') {
            document.body.classList.add('dark-mode');
        }

        // Appliquer les variables CSS selon le thème
        switch (theme) {
            case 'dark':
                root.style.setProperty('--bg-primary', '#1a1a1a');
                root.style.setProperty('--bg-secondary', '#2d2d2d');
                root.style.setProperty('--text-primary', '#ffffff');
                root.style.setProperty('--text-secondary', '#cccccc');
                root.style.setProperty('--border-color', '#404040');
                root.style.setProperty('--card-bg', '#2d2d2d');
                root.style.setProperty('--header-bg', '#2d2d2d');
                break;

            case 'colored':
                root.style.setProperty('--bg-primary', 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)');
                root.style.setProperty('--bg-secondary', '#ffffff');
                root.style.setProperty('--text-primary', '#333333');
                root.style.setProperty('--text-secondary', '#666666');
                root.style.setProperty('--border-color', '#e5e7eb');
                root.style.setProperty('--card-bg', '#ffffff');
                root.style.setProperty('--header-bg', 'rgba(255, 255, 255, 0.95)');
                break;

            case 'light':
            default:
                root.style.setProperty('--bg-primary', '#f9fafb');
                root.style.setProperty('--bg-secondary', '#ffffff');
                root.style.setProperty('--text-primary', '#333333');
                root.style.setProperty('--text-secondary', '#666666');
                root.style.setProperty('--border-color', '#e5e7eb');
                root.style.setProperty('--card-bg', '#ffffff');
                root.style.setProperty('--header-bg', '#ffffff');
                break;
        }

        this.logger?.info(`Theme applied: ${theme}`);
    }

    /**
     * Obtenir les paramètres actuels
     */
    getSettings() {
        return { ...this.settings };
    }
}

// Export global
if (typeof window !== 'undefined') {
    window.SettingsModal = SettingsModal;
}
