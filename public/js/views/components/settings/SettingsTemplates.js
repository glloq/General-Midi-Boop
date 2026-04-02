(function() {
    'use strict';
    const SettingsTemplates = {};

    /**
     * Generate the HTML content of the settings modal
     */
    SettingsTemplates.renderContent = function() {
        const currentLocale = i18n.getLocale();
        const locales = i18n.getSupportedLocales();

        return `
            <!-- ═══════════════════════════════════════ -->
            <!-- GROUPE A : Apparence                    -->
            <!-- ═══════════════════════════════════════ -->
            <div class="settings-group">
                <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #667eea; border-bottom: 2px solid var(--border-color, #e5e7eb); padding-bottom: 8px;">
                    ${i18n.t('settings.groups.appearance') || 'Apparence'}
                </h2>

                <!-- Langue -->
                <div class="settings-section">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🌐 ${i18n.t('settings.language.title')}</h3>
                    <div class="language-selector-container" style="position: relative;">
                        <select id="languageSelect" class="language-select" style="
                            width: 100%;
                            padding: 12px 16px;
                            padding-right: 40px;
                            border: 2px solid var(--border-color, #e5e7eb);
                            border-radius: 8px;
                            background: var(--bg-secondary, white);
                            cursor: pointer;
                            font-size: 15px;
                            color: var(--text-primary, #333);
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
                            color: var(--text-secondary, #666);
                            font-size: 12px;
                        ">▼</span>
                    </div>
                </div>

                <!-- Thème -->
                <div class="settings-section" style="margin-top: 24px;">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🎨 ${i18n.t('settings.theme.title')}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">🌙 ${i18n.t('settings.theme.dark')}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.theme.darkDescription') || 'Activer le mode sombre'}</p>
                        </div>
                        <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                            <input type="checkbox" id="darkModeToggle" ${this.settings.theme === 'dark' ? 'checked' : ''}
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
            </div>

            <!-- ═══════════════════════════════════════ -->
            <!-- GROUPE B : Lecture & Affichage           -->
            <!-- ═══════════════════════════════════════ -->
            <div class="settings-group" style="margin-top: 28px;">
                <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #667eea; border-bottom: 2px solid var(--border-color, #e5e7eb); padding-bottom: 8px;">
                    ${i18n.t('settings.groups.playback') || 'Lecture & Affichage'}
                </h2>

                <!-- Clavier -->
                <div class="settings-section">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🎹 ${i18n.t('settings.keyboard.title')}</h3>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <label style="font-size: 14px; color: var(--text-secondary, #666);">
                            ${i18n.t('settings.keyboard.octaveCount')} : <strong id="keyboardOctavesValue">${this.settings.keyboardOctaves}</strong>
                            <span style="color: var(--text-muted, #999); font-weight: normal;">(<span id="keyboardTouchesCount">${this.settings.keyboardOctaves * 12}</span> ${i18n.t('common.keys')})</span>
                        </label>
                        <input type="range" id="keyboardOctavesRange" min="1" max="4" step="1"
                               value="${this.settings.keyboardOctaves}"
                               style="width: 100%;">
                        <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted, #999);">
                            <span>1 ${i18n.t('common.octave')}</span>
                            <span>4 ${i18n.t('common.octaves')}</span>
                        </div>
                    </div>
                </div>

                <!-- Temps d'affichage -->
                <div class="settings-section" style="margin-top: 24px;">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">⏱️ ${i18n.t('settings.noteDisplay.title')}</h3>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <label style="font-size: 14px; color: var(--text-secondary, #666);">
                            ${i18n.t('settings.noteDisplay.visibleDuration')} : <strong id="noteDisplayTimeValue">${this.settings.noteDisplayTime}s</strong>
                        </label>
                        <input type="range" id="noteDisplayTimeRange" min="5" max="60" step="5"
                               value="${this.settings.noteDisplayTime}"
                               style="width: 100%;">
                        <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted, #999);">
                            <span>${i18n.t('settings.noteDisplay.minSeconds')}</span>
                            <span>${i18n.t('settings.noteDisplay.maxSeconds')}</span>
                        </div>
                    </div>
                </div>

                <!-- Instrument virtuel -->
                <div class="settings-section" style="margin-top: 24px;">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🎵 ${i18n.t('settings.virtualInstrument.title')}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.virtualInstrument.enable')}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.virtualInstrument.description')}</p>
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
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🎹 ${i18n.t('settings.pianoRoll.title')}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.pianoRoll.enable')}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.pianoRoll.description')}</p>
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
            </div>

            <!-- ═══════════════════════════════════════ -->
            <!-- GROUPE C : Boutons d'interface           -->
            <!-- ═══════════════════════════════════════ -->
            <div class="settings-group" style="margin-top: 28px;">
                <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #667eea; border-bottom: 2px solid var(--border-color, #e5e7eb); padding-bottom: 8px;">
                    ${i18n.t('settings.groups.buttons') || "Boutons d'interface"}
                </h2>

                <!-- Bouton Playlist -->
                <div class="settings-section">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🎶 ${i18n.t('settings.playlistButton.title') || 'Bouton Playlist'}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.playlistButton.enable') || 'Afficher le bouton playlist'}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.playlistButton.description') || 'Affiche le bouton playlist dans la barre de navigation'}</p>
                        </div>
                        <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                            <input type="checkbox" id="showPlaylistButtonToggle" ${this.settings.showPlaylistButton ? 'checked' : ''}
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
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🐞 ${i18n.t('settings.debugButton.title')}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.debugButton.enable')}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.debugButton.description')}</p>
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
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🎤 ${i18n.t('settings.calibrationButton.title') || 'Bouton Calibration Micro'}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.calibrationButton.enable') || 'Afficher le bouton de calibration'}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.calibrationButton.description') || 'Affiche le bouton microphone pour calibrer les délais audio des instruments'}</p>
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

                <!-- Bouton Contrôle Lumière -->
                <div class="settings-section" style="margin-top: 24px;">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">💡 ${i18n.t('settings.lightingButton.title') || 'Bouton Contrôle Lumière'}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.lightingButton.enable') || 'Afficher le bouton de contrôle lumière'}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.lightingButton.description') || 'Affiche le bouton ampoule pour gérer les bandeaux LED et règles lumière'}</p>
                        </div>
                        <label class="toggle-switch" style="position: relative; display: inline-block; width: 60px; height: 30px;">
                            <input type="checkbox" id="showLightingButtonToggle" ${this.settings.showLightingButton ? 'checked' : ''}
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
            </div>

            <!-- ═══════════════════════════════════════ -->
            <!-- GROUPE D : Matériel & Système            -->
            <!-- ═══════════════════════════════════════ -->
            <div class="settings-group" style="margin-top: 28px;">
                <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #667eea; border-bottom: 2px solid var(--border-color, #e5e7eb); padding-bottom: 8px;">
                    ${i18n.t('settings.groups.system') || 'Matériel & Système'}
                </h2>

                <!-- Serial MIDI GPIO -->
                <div class="settings-section">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">${i18n.t('settings.serialMidi.title')}</h3>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.serialMidi.enable')}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.serialMidi.description')}</p>
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
                            <span style="font-size: 14px; color: var(--text-primary, #333); font-weight: 500;">${i18n.t('settings.serialMidi.ports')}</span>
                            <button id="serialScanBtn" style="
                                padding: 6px 14px;
                                border: 1px solid #667eea;
                                border-radius: 6px;
                                background: var(--bg-secondary, white);
                                color: #667eea;
                                cursor: pointer;
                                font-size: 13px;
                                transition: all 0.2s;
                            ">${i18n.t('settings.serialMidi.scan')}</button>
                        </div>
                        <div id="serialPortsList" style="
                            border: 1px solid var(--border-color, #e5e7eb);
                            border-radius: 8px;
                            overflow: hidden;
                            min-height: 60px;
                        ">
                            <div style="padding: 16px; text-align: center; color: var(--text-muted, #999); font-size: 13px;">
                                ${i18n.t('settings.serialMidi.clickScan')}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Mise à jour -->
                <div class="settings-section" style="margin-top: 24px;">
                    <h3 style="margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary, #333);">🔄 ${i18n.t('settings.update.title') || 'Mise à jour du système'}</h3>
                    <div id="versionStatus" style="margin-bottom: 16px; padding: 12px 16px; border-radius: 8px; background: var(--bg-tertiary, #f3f4f6); color: var(--text-secondary, #666); font-size: 13px; display: flex; align-items: center; gap: 10px;">
                        <span style="animation: pulse 1.5s infinite;">⏳</span>
                        <span>${i18n.t('settings.update.checking') || 'Vérification des mises à jour...'}</span>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                        <div style="flex: 1;">
                            <p style="margin: 0 0 4px 0; font-size: 14px; color: var(--text-primary, #333);">${i18n.t('settings.update.description') || 'Télécharger et installer la dernière version'}</p>
                            <p style="margin: 0; font-size: 12px; color: var(--text-secondary, #666);">${i18n.t('settings.update.warning') || 'Récupère les dernières modifications, met à jour les dépendances et redémarre le serveur'}</p>
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
                        ">🔄 ${i18n.t('settings.update.button') || 'Installer la mise à jour'}</button>
                    </div>
                    <div id="updateStatus" style="display: none; margin-top: 12px; padding: 12px 16px; border-radius: 8px; font-size: 13px;"></div>
                </div>
            </div>
        `;
    };

    /**
     * Get the emoji flag for a locale
     */
    SettingsTemplates.getLocaleFlag = function(locale) {
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
    };

    /**
     * Update modal texts when language changes
     */
    SettingsTemplates.updateModalTexts = function() {
        if (!this.modal) return;

        // Update title
        const title = this.modal.querySelector('.settings-title');
        if (title) {
            title.innerHTML = `⚙️ ${i18n.t('settings.title')}`;
        }

        // Update content
        const content = this.modal.querySelector('.settings-modal-content');
        if (content) {
            content.innerHTML = this.renderContent();
            // Reattach events for new elements
            this.attachContentEventListeners();
            // Restore dark mode toggle value
            const darkModeToggle = this.modal.querySelector('#darkModeToggle');
            if (darkModeToggle) darkModeToggle.checked = this.settings.theme === 'dark';
            // Re-check updates (HTML was regenerated)
            this.checkForUpdates();
        }

        // Update footer buttons
        const cancelBtn = this.modal.querySelector('.settings-cancel-btn');
        const saveBtn = this.modal.querySelector('.settings-save-btn');
        if (cancelBtn) cancelBtn.textContent = i18n.t('common.cancel');
        if (saveBtn) saveBtn.textContent = i18n.t('common.save');
    };

    if (typeof window !== 'undefined') window.SettingsTemplates = SettingsTemplates;
})();
