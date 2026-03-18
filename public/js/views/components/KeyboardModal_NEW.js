// ============================================================================
// Fichier: KeyboardModal_NEW.js - VERSION DIVs (Pas de Canvas!)
// Version: 1.1.0 - Support i18n
// ============================================================================

class KeyboardModalNew {
    constructor(logger = null, eventBus = null) {
        this.backend = window.api;
        this.logger = logger || console;
        this.eventBus = eventBus || window.eventBus || null;
        this.isOpen = false;

        // i18n support
        this.localeUnsubscribe = null;

        // État
        this.devices = [];
        this.selectedDevice = null;
        this.selectedDeviceCapabilities = null; // Capacités de l'instrument sélectionné
        this.activeNotes = new Set();
        this.velocity = 80;
        this.modulation = 64; // CC#1 modulation wheel value (center)
        this._modWheelDragging = false;
        this.octaveOffset = 0;
        this.keyboardLayout = 'azerty';
        this.isMouseDown = false; // Pour le drag sur le clavier

        // Piano config
        this.whiteKeys = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
        this.blackKeyPositions = [1, 2, 4, 5, 6]; // Position des touches noires (après C, D, F, G, A)
        this.octaves = 3; // 3 octaves par défaut = 36 touches (plage: 1-4 octaves / 12-42 touches)
        this.baseOctave = 3; // Commence à C3

        // Keyboard mappings - touches blanches: s d f g h j k l m
        // Note: KeyW = w, KeyX = x, etc.
        this.keyMaps = {
            azerty: {
                // Touches blanches: s d f g h j k l m (C D E F G A B C D)
                'KeyS': 0,  // C
                'KeyD': 2,  // D
                'KeyF': 4,  // E
                'KeyG': 5,  // F
                'KeyH': 7,  // G
                'KeyJ': 9,  // A
                'KeyK': 11, // B
                'KeyL': 12, // C (octave suivante)
                'KeyM': 14, // D (octave suivante)

                // Touches noires (rangée du dessus)
                'KeyZ': 1,  // C#
                'KeyE': 3,  // D#
                // pas de noir entre E et F
                'KeyT': 6,  // F#
                'KeyY': 8,  // G#
                'KeyU': 10, // A#
                // pas de noir entre B et C
                'KeyO': 13, // C# (octave suivante)
                'KeyP': 15  // D# (octave suivante)
            },
            qwerty: {
                // Touches blanches: s d f g h j k l ; (même que azerty mais dernière touche différente)
                'KeyS': 0,  // C
                'KeyD': 2,  // D
                'KeyF': 4,  // E
                'KeyG': 5,  // F
                'KeyH': 7,  // G
                'KeyJ': 9,  // A
                'KeyK': 11, // B
                'KeyL': 12, // C (octave suivante)
                'Semicolon': 14, // D (octave suivante) - ; key

                // Touches noires (rangée du dessus)
                'KeyW': 1,  // C#
                'KeyE': 3,  // D#
                'KeyT': 6,  // F#
                'KeyY': 8,  // G#
                'KeyU': 10, // A#
                'KeyO': 13, // C# (octave suivante)
                'KeyP': 15  // D# (octave suivante)
            }
        };
        this.currentKeyMap = this.keyMaps.azerty;

        // Bind handlers
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleKeyUp = this.handleKeyUp.bind(this);
        this.handleGlobalMouseUp = this.handleGlobalMouseUp.bind(this);

        this.container = null;

        // Setup event listeners
        this.setupEventListeners();
    }

    // ========================================================================
    // I18N SUPPORT
    // ========================================================================

    /**
     * Helper pour traduire une clé
     * @param {string} key - Clé de traduction
     * @param {Object} params - Paramètres d'interpolation
     * @returns {string} - Texte traduit
     */
    t(key, params = {}) {
        return typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    }

    /**
     * Met à jour le contenu traduit de la modale
     */
    updateTranslations() {
        if (!this.container) return;

        // Titre
        const title = this.container.querySelector('.modal-header h2');
        if (title) title.textContent = `🎹 ${this.t('keyboard.title')}`;

        // Vélocité
        const velocityLabel = this.container.querySelector('#velocity-control-panel .velocity-label-vertical');
        if (velocityLabel) velocityLabel.textContent = this.t('keyboard.velocity');

        // Modulation
        const modulationLabel = this.container.querySelector('#modulation-control-panel .velocity-label-vertical');
        if (modulationLabel) modulationLabel.textContent = this.t('keyboard.modulation');

        // Instrument label
        const labels = this.container.querySelectorAll('.keyboard-header-controls .control-group label');
        if (labels[0]) labels[0].textContent = this.t('keyboard.instrument');
        if (labels[1]) labels[1].textContent = this.t('keyboard.layout');

        // Octave display
        const octaveDisplay = document.getElementById('keyboard-octave-display');
        if (octaveDisplay) {
            const display = this.octaveOffset > 0 ? `+${this.octaveOffset}` : this.octaveOffset;
            octaveDisplay.textContent = this.t('keyboard.octave', { offset: display });
        }

        // PC Keys label
        const pcKeysLabel = this.container.querySelector('.keyboard-help-bar .info-label');
        if (pcKeysLabel) pcKeysLabel.textContent = this.t('keyboard.pcKeys');

        // Keyboard help text
        const helpText = document.getElementById('keyboard-help-text');
        if (helpText) {
            helpText.textContent = this.keyboardLayout === 'azerty'
                ? this.t('keyboard.azertyHelp')
                : this.t('keyboard.qwertyHelp');
        }

        // Select par défaut
        const deviceSelect = document.getElementById('keyboard-device-select');
        if (deviceSelect && deviceSelect.options.length > 0) {
            deviceSelect.options[0].textContent = this.t('common.select');
        }
    }

    // ========================================================================
    // ÉVÉNEMENTS
    // ========================================================================

    setupEventListeners() {
        if (!this.eventBus) {
            this.logger.warn('[KeyboardModal] No eventBus available - device list will not auto-refresh');
            return;
        }

        // Écouter les connexions/déconnexions Bluetooth pour rafraîchir la liste
        this.eventBus.on('bluetooth:connected', async (data) => {
            this.logger.info('[KeyboardModal] Bluetooth device connected, refreshing device list...');
            if (this.isOpen) {
                await this.loadDevices();
                this.populateDeviceSelect();
            }
        });

        this.eventBus.on('bluetooth:disconnected', async (data) => {
            this.logger.info('[KeyboardModal] Bluetooth device disconnected, refreshing device list...');
            if (this.isOpen) {
                await this.loadDevices();
                this.populateDeviceSelect();
            }
        });

        this.eventBus.on('bluetooth:unpaired', async (data) => {
            this.logger.info('[KeyboardModal] Bluetooth device unpaired, refreshing device list...');
            if (this.isOpen) {
                await this.loadDevices();
                this.populateDeviceSelect();
            }
        });

        this.logger.debug('[KeyboardModal] Event listeners configured');
    }

    // ========================================================================
    // OPEN / CLOSE
    // ========================================================================

    async open() {
        if (this.isOpen) return;

        // Charger les paramètres sauvegardés pour appliquer le nombre de touches
        this.loadSettings();

        this.createModal();
        this.isOpen = true;

        // Load devices
        await this.loadDevices();
        this.populateDeviceSelect();

        // Attach events
        this.attachEvents();

        // Initialize slider visibility (hide modulation by default)
        this.updateSlidersVisibility();

        // Subscribe to locale changes
        if (typeof i18n !== 'undefined') {
            this.localeUnsubscribe = i18n.onLocaleChange(() => {
                this.updateTranslations();
                this.populateDeviceSelect();
            });
        }

        this.logger.info('[KeyboardModal] Opened');
    }

    close() {
        if (!this.isOpen) return;

        this.detachEvents();

        // Unsubscribe from locale changes
        if (this.localeUnsubscribe) {
            this.localeUnsubscribe();
            this.localeUnsubscribe = null;
        }

        // Stop toutes les notes actives
        this.activeNotes.forEach(note => this.stopNote(note));

        // Reset state
        this.isMouseDown = false;
        this.selectedDevice = null;

        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.isOpen = false;
        this.logger.info('[KeyboardModal] Closed');
    }

    createModal() {
        const display = this.octaveOffset > 0 ? `+${this.octaveOffset}` : this.octaveOffset;

        this.container = document.createElement('div');
        this.container.className = 'keyboard-modal';
        this.container.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <div class="keyboard-header-row">
                        <h2>🎹 ${this.t('keyboard.title')}</h2>
                        <div class="keyboard-header-controls">
                            <div class="control-group">
                                <label>${this.t('keyboard.instrument')}</label>
                                <select class="device-select" id="keyboard-device-select">
                                    <option value="">${this.t('common.select')}</option>
                                </select>
                            </div>

                            <div class="control-group octave-controls">
                                <button class="btn-octave-down" id="keyboard-octave-down">◄</button>
                                <span class="octave-display" id="keyboard-octave-display">${this.t('keyboard.octave', { offset: display })}</span>
                                <button class="btn-octave-up" id="keyboard-octave-up">►</button>
                            </div>

                            <div class="control-group">
                                <label>${this.t('keyboard.layout')}</label>
                                <select class="layout-select" id="keyboard-layout-select">
                                    <option value="azerty">${this.t('keyboard.layoutAzerty')}</option>
                                    <option value="qwerty">${this.t('keyboard.layoutQwerty')}</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <button class="modal-close" id="keyboard-close-btn">&times;</button>
                </div>

                <div class="modal-body">
                    <div class="keyboard-layout">
                        <!-- Slider vélocité vertical à gauche -->
                        <div class="velocity-control-vertical" id="velocity-control-panel">
                            <div class="velocity-label-vertical">${this.t('keyboard.velocity')}</div>
                            <div class="velocity-slider-wrapper">
                                <input type="range"
                                       id="keyboard-velocity"
                                       class="velocity-slider-vertical"
                                       min="1"
                                       max="127"
                                       value="80"
                                       orient="vertical">
                            </div>
                            <div class="velocity-value-vertical" id="keyboard-velocity-display">80</div>
                        </div>

                        <!-- Mod wheel custom -->
                        <div class="velocity-control-vertical modulation-control-vertical" id="modulation-control-panel">
                            <div class="velocity-label-vertical">${this.t('keyboard.modulation')}</div>
                            <div class="mod-wheel-wrapper">
                                <div class="mod-wheel-track" id="mod-wheel-track">
                                    <div class="mod-wheel-center-line"></div>
                                    <div class="mod-wheel-fill" id="mod-wheel-fill"></div>
                                    <div class="mod-wheel-thumb" id="mod-wheel-thumb"></div>
                                </div>
                            </div>
                            <div class="velocity-value-vertical modulation-value-vertical" id="keyboard-modulation-display">64</div>
                        </div>

                        <!-- Zone principale du clavier -->
                        <div class="keyboard-main">
                            <div class="keyboard-canvas-container">
                                <div id="piano-container" class="piano-container"></div>
                            </div>
                            <div class="keyboard-help-bar">
                                <span class="info-label">${this.t('keyboard.pcKeys')}</span>
                                <span class="info-value" id="keyboard-help-text">${this.t('keyboard.azertyHelp')}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.container);

        // Générer les touches du piano
        this.generatePianoKeys();
    }

    // ========================================================================
    // PIANO KEYS GENERATION (DIVs)
    // ========================================================================

    generatePianoKeys() {
        const pianoContainer = document.getElementById('piano-container');
        if (!pianoContainer) return;

        pianoContainer.innerHTML = ''; // Clear

        const totalWhiteKeys = this.whiteKeys.length * this.octaves;
        let whiteKeyIndex = 0;

        // Calculer l'octave de départ en tenant compte de octaveOffset
        const startOctave = this.baseOctave + this.octaveOffset;

        for (let octave = 0; octave < this.octaves; octave++) {
            const currentOctave = startOctave + octave;

            for (let i = 0; i < this.whiteKeys.length; i++) {
                const noteName = this.whiteKeys[i];
                const noteOffset = this.getNoteOffset(noteName);

                // Calculer le numéro MIDI: C4 = 60
                // Formule: (octave + 1) * 12 + noteOffset
                const noteNumber = (currentOctave + 1) * 12 + noteOffset;

                // Touche blanche
                const whiteKey = document.createElement('div');
                whiteKey.className = 'piano-key white-key';
                whiteKey.dataset.note = noteNumber;
                whiteKey.dataset.baseNote = noteNumber; // Note fixe sans octaveOffset
                whiteKey.dataset.noteName = noteName + currentOctave;

                // Vérifier si la note est jouable par l'instrument sélectionné
                if (!this.isNotePlayable(noteNumber)) {
                    whiteKey.classList.add('disabled');
                }

                // Label avec nom + octave
                const label = document.createElement('span');
                label.className = 'key-label';
                label.textContent = noteName + currentOctave;
                whiteKey.appendChild(label);

                pianoContainer.appendChild(whiteKey);

                // Touche noire (si applicable)
                if (this.blackKeyPositions.includes(i + 1)) {
                    const blackNoteNumber = noteNumber + 1;
                    const blackKey = document.createElement('div');
                    blackKey.className = 'piano-key black-key';
                    blackKey.dataset.note = blackNoteNumber;
                    blackKey.dataset.baseNote = blackNoteNumber;
                    blackKey.dataset.noteName = noteName + '#' + currentOctave;

                    // Vérifier si la note noire est jouable
                    if (!this.isNotePlayable(blackNoteNumber)) {
                        blackKey.classList.add('disabled');
                    }

                    // Positionner la touche noire
                    blackKey.style.left = `calc(${whiteKeyIndex * (100 / totalWhiteKeys)}% + ${(100 / totalWhiteKeys) * 0.7}%)`;

                    pianoContainer.appendChild(blackKey);
                }

                whiteKeyIndex++;
            }
        }
    }

    getNoteOffset(noteName) {
        const offsets = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        return offsets[noteName] || 0;
    }

    updatePianoDisplay() {
        const allKeys = document.querySelectorAll('.piano-key');
        allKeys.forEach(key => {
            const note = parseInt(key.dataset.note);

            // Highlight if active
            if (this.activeNotes.has(note)) {
                key.classList.add('active');
            } else {
                key.classList.remove('active');
            }
        });
    }

    /**
     * Charger les capacités d'un instrument
     * @param {string} deviceId - ID de l'appareil
     */
    async loadDeviceCapabilities(deviceId) {
        if (!deviceId) {
            this.selectedDeviceCapabilities = null;
            return;
        }

        try {
            const response = await this.backend.sendCommand('instrument_get_capabilities', { deviceId });
            this.selectedDeviceCapabilities = response.capabilities || null;
            this.logger.info(`[KeyboardModal] Capacités chargées pour ${deviceId}:`, this.selectedDeviceCapabilities);
        } catch (error) {
            this.logger.warn(`[KeyboardModal] Impossible de charger les capacités pour ${deviceId}:`, error);
            this.selectedDeviceCapabilities = null;
        }
    }

    /**
     * Vérifier si une note est jouable par l'instrument sélectionné
     * @param {number} noteNumber - Numéro MIDI de la note
     * @returns {boolean} - true si la note est jouable
     */
    isNotePlayable(noteNumber) {
        if (!this.selectedDeviceCapabilities) {
            return true; // Pas de restrictions si pas de capacités définies
        }

        const caps = this.selectedDeviceCapabilities;

        // Mode discrete : vérifier si la note est dans la liste
        if (caps.note_selection_mode === 'discrete') {
            // Si pas de notes sélectionnées, autoriser toutes les notes
            if (!caps.selected_notes) {
                return true;
            }
            try {
                const selectedNotes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                // Si la liste est vide, autoriser toutes les notes
                if (!Array.isArray(selectedNotes) || selectedNotes.length === 0) {
                    return true;
                }
                return selectedNotes.includes(noteNumber);
            } catch (e) {
                return true;
            }
        }

        // Mode range : vérifier si la note est dans la plage
        const minNote = caps.note_range_min;
        const maxNote = caps.note_range_max;

        // Si aucune plage définie, autoriser toutes les notes
        if ((minNote === null || minNote === undefined) &&
            (maxNote === null || maxNote === undefined)) {
            return true;
        }

        if (minNote !== null && minNote !== undefined && noteNumber < minNote) {
            return false;
        }
        if (maxNote !== null && maxNote !== undefined && noteNumber > maxNote) {
            return false;
        }

        return true;
    }

    regeneratePianoKeys() {
        // Régénérer tout le clavier avec le nouvel octaveOffset
        this.generatePianoKeys();

        // Délégation d'événements: un seul listener sur le conteneur au lieu de 6 par touche
        this._setupPianoDelegation();

        this.updatePianoDisplay();
    }

    /**
     * Délégation d'événements sur le conteneur piano
     * Remplace les listeners individuels par touche (évite les fuites mémoire)
     */
    _setupPianoDelegation() {
        const container = document.getElementById('piano-container');
        if (!container) return;

        // Retirer les anciens listeners délégués s'ils existent
        if (this._pianoMouseDown) {
            container.removeEventListener('mousedown', this._pianoMouseDown);
            container.removeEventListener('mouseup', this._pianoMouseUp);
            container.removeEventListener('mouseleave', this._pianoMouseLeave, true);
            container.removeEventListener('mouseenter', this._pianoMouseEnter, true);
            container.removeEventListener('touchstart', this._pianoTouchStart);
            container.removeEventListener('touchend', this._pianoTouchEnd);
        }

        const getKey = (e) => e.target.closest('.piano-key');

        this._pianoMouseDown = (e) => {
            const key = getKey(e);
            if (key) { e.currentTarget = key; this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} }); }
        };
        this._pianoMouseUp = (e) => {
            const key = getKey(e);
            if (key) { this.handlePianoKeyUp({ currentTarget: key }); }
        };
        this._pianoMouseLeave = (e) => {
            if (e.target.classList?.contains('piano-key')) {
                this.handlePianoKeyUp({ currentTarget: e.target });
            }
        };
        this._pianoMouseEnter = (e) => {
            if (e.target.classList?.contains('piano-key')) {
                this.handlePianoKeyEnter({ currentTarget: e.target });
            }
        };
        this._pianoTouchStart = (e) => {
            const key = getKey(e);
            if (key) { e.preventDefault(); this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} }); }
        };
        this._pianoTouchEnd = (e) => {
            const key = getKey(e);
            if (key) { e.preventDefault(); this.handlePianoKeyUp({ currentTarget: key }); }
        };

        container.addEventListener('mousedown', this._pianoMouseDown);
        container.addEventListener('mouseup', this._pianoMouseUp);
        container.addEventListener('mouseleave', this._pianoMouseLeave, true);
        container.addEventListener('mouseenter', this._pianoMouseEnter, true);
        container.addEventListener('touchstart', this._pianoTouchStart, { passive: false });
        container.addEventListener('touchend', this._pianoTouchEnd, { passive: false });
    }

    /**
     * Remove delegated piano container listeners
     */
    _removePianoDelegation() {
        const container = document.getElementById('piano-container');
        if (!container || !this._pianoMouseDown) return;

        container.removeEventListener('mousedown', this._pianoMouseDown);
        container.removeEventListener('mouseup', this._pianoMouseUp);
        container.removeEventListener('mouseleave', this._pianoMouseLeave, true);
        container.removeEventListener('mouseenter', this._pianoMouseEnter, true);
        container.removeEventListener('touchstart', this._pianoTouchStart);
        container.removeEventListener('touchend', this._pianoTouchEnd);

        this._pianoMouseDown = null;
        this._pianoMouseUp = null;
        this._pianoMouseLeave = null;
        this._pianoMouseEnter = null;
        this._pianoTouchStart = null;
        this._pianoTouchEnd = null;
    }

    /**
     * Définir le nombre d'octaves du clavier
     * @param {number} octaves - Nombre d'octaves (1-4)
     */
    setOctaves(octaves) {
        // Limiter entre 1 et 4 octaves
        this.octaves = Math.max(1, Math.min(4, octaves));

        this.logger.info(`[KeyboardModal] Nombre d'octaves changé: ${this.octaves} (${this.octaves * 12} touches)`);

        // Régénérer le clavier si le modal est ouvert
        if (this.isOpen) {
            this.regeneratePianoKeys();
        }
    }

    /**
     * Définir le nombre de touches du clavier (OBSOLÈTE - utiliser setOctaves)
     * @param {number} numberOfKeys - Nombre de touches (12-48 touches)
     * @deprecated Utiliser setOctaves() à la place
     */
    setNumberOfKeys(numberOfKeys) {
        // Calculer le nombre d'octaves à afficher
        const octaves = Math.ceil(numberOfKeys / 12);
        this.setOctaves(octaves);
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    attachEvents() {
        // Boutons
        document.getElementById('keyboard-close-btn')?.addEventListener('click', () => this.close());

        document.getElementById('keyboard-octave-up')?.addEventListener('click', () => {
            this.octaveOffset = Math.min(3, this.octaveOffset + 1);
            const display = this.octaveOffset > 0 ? `+${this.octaveOffset}` : this.octaveOffset;
            document.getElementById('keyboard-octave-display').textContent = this.t('keyboard.octave', { offset: display });
            this.regeneratePianoKeys();
        });

        document.getElementById('keyboard-octave-down')?.addEventListener('click', () => {
            this.octaveOffset = Math.max(-3, this.octaveOffset - 1);
            const display = this.octaveOffset > 0 ? `+${this.octaveOffset}` : this.octaveOffset;
            document.getElementById('keyboard-octave-display').textContent = this.t('keyboard.octave', { offset: display });
            this.regeneratePianoKeys();
        });

        // Device select
        document.getElementById('keyboard-device-select')?.addEventListener('change', async (e) => {
            const deviceId = e.target.value;
            this.selectedDevice = this.devices.find(d => d.device_id === deviceId || d.id === deviceId) || null;

            // Charger les capacités de l'instrument sélectionné
            await this.loadDeviceCapabilities(deviceId);

            // Auto-centrer le clavier sur la plage de notes de l'instrument
            this.autoCenterKeyboard();

            // Mettre à jour la visibilité des sliders
            this.updateSlidersVisibility();

            // Reset modulation wheel to center when changing instrument
            this.modulation = 64;
            this._updateModWheelPosition(64);
            const modDisplay = document.getElementById('keyboard-modulation-display');
            if (modDisplay) modDisplay.textContent = '64';

            // Régénérer le clavier pour appliquer les restrictions
            this.regeneratePianoKeys();
        });

        // Velocity
        document.getElementById('keyboard-velocity')?.addEventListener('input', (e) => {
            this.velocity = parseInt(e.target.value);
            document.getElementById('keyboard-velocity-display').textContent = this.velocity;
        });

        // Modulation wheel (custom drag)
        this.initModWheel();

        // Layout
        document.getElementById('keyboard-layout-select')?.addEventListener('change', (e) => {
            this.keyboardLayout = e.target.value;
            this.currentKeyMap = this.keyMaps[this.keyboardLayout];

            // Mettre à jour le texte d'aide
            const helpText = document.getElementById('keyboard-help-text');
            if (helpText) {
                helpText.textContent = this.keyboardLayout === 'azerty'
                    ? this.t('keyboard.azertyHelp')
                    : this.t('keyboard.qwertyHelp');
            }
        });

        // Piano keys - use delegated listeners on the container (not individual per key)
        this._setupPianoDelegation();

        // Gestion globale du mouseup pour le drag
        document.addEventListener('mouseup', this.handleGlobalMouseUp);

        // Clavier PC
        window.addEventListener('keydown', this.handleKeyDown);
        window.addEventListener('keyup', this.handleKeyUp);
    }

    detachEvents() {
        document.removeEventListener('mouseup', this.handleGlobalMouseUp);
        window.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('keyup', this.handleKeyUp);

        // Remove delegated piano container listeners
        this._removePianoDelegation();

        // Cleanup mod wheel listeners
        if (this._modWheelOnMove) {
            const track = document.getElementById('mod-wheel-track');
            if (track) {
                track.removeEventListener('mousedown', this._modWheelOnTrackDown);
                track.removeEventListener('touchstart', this._modWheelOnTouchStart);
            }
            document.removeEventListener('mousemove', this._modWheelOnMove);
            document.removeEventListener('mouseup', this._modWheelOnEnd);
            document.removeEventListener('touchmove', this._modWheelOnTouchMove);
            document.removeEventListener('touchend', this._modWheelOnEnd);
            document.removeEventListener('touchcancel', this._modWheelOnEnd);
        }
    }

    handleGlobalMouseUp() {
        this.isMouseDown = false;
    }

    handlePianoKeyDown(e) {
        this.isMouseDown = true;
        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        // Ne pas jouer si la touche est désactivée
        if (key.classList.contains('disabled')) {
            return;
        }

        if (!this.activeNotes.has(note)) {
            this.playNote(note);
        }
    }

    handlePianoKeyUp(e) {
        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        // Arrêter la note seulement si elle est active
        if (this.activeNotes.has(note)) {
            this.stopNote(note);
        }
    }

    handlePianoKeyEnter(e) {
        // Jouer la note seulement si la souris est enfoncée (drag)
        if (!this.isMouseDown) return;

        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        // Ne pas jouer si la touche est désactivée
        if (key.classList.contains('disabled')) {
            return;
        }

        if (!this.activeNotes.has(note)) {
            this.playNote(note);
        }
    }

    handleKeyDown(e) {
        if (!this.isOpen) return;

        const noteOffset = this.currentKeyMap[e.code];
        if (noteOffset === undefined) return;

        e.preventDefault();

        // Note de base: C du baseOctave avec octaveOffset appliqué
        // Par exemple: baseOctave=3, octaveOffset=0 → C3 = 48
        // C4 = 60, donc C3 = 48
        const baseNoteNumber = (this.baseOctave + this.octaveOffset + 1) * 12;
        const note = baseNoteNumber + noteOffset;

        if (!this.activeNotes.has(note)) {
            this.playNote(note);
        }
    }

    handleKeyUp(e) {
        if (!this.isOpen) return;

        const noteOffset = this.currentKeyMap[e.code];
        if (noteOffset === undefined) return;

        e.preventDefault();

        const baseNoteNumber = (this.baseOctave + this.octaveOffset + 1) * 12;
        const note = baseNoteNumber + noteOffset;

        this.stopNote(note);
    }

    // ========================================================================
    // MIDI
    // ========================================================================

    playNote(note) {
        if (note < 21 || note > 108) return;

        // Ajouter aux notes actives
        this.activeNotes.add(note);
        this.updatePianoDisplay();

        // Envoyer MIDI si device sélectionné
        if (this.selectedDevice && this.backend) {
            const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

            // Si c'est le périphérique virtuel, envoyer aux logs
            if (this.selectedDevice.isVirtual) {
                const noteName = this.getNoteNameFromNumber(note);
                const message = `🎹 ${this.t('keyboard.virtualNoteOn', { note: noteName, number: note, velocity: this.velocity })}`;
                if (this.logger && this.logger.info) {
                    this.logger.info(message);
                } else {
                    console.log(message);
                }
                return;
            }

            this.backend.sendNoteOn(deviceId, note, this.velocity, 0)
                .catch(err => {
                    this.logger.error('[KeyboardModal] Note ON failed:', err);
                });
        }
    }

    stopNote(note) {
        // Retirer des notes actives
        this.activeNotes.delete(note);
        this.updatePianoDisplay();

        // Envoyer MIDI si device sélectionné
        if (this.selectedDevice && this.backend) {
            const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

            // Si c'est le périphérique virtuel, envoyer aux logs
            if (this.selectedDevice.isVirtual) {
                const noteName = this.getNoteNameFromNumber(note);
                const message = `🎹 ${this.t('keyboard.virtualNoteOff', { note: noteName, number: note })}`;
                if (this.logger && this.logger.info) {
                    this.logger.info(message);
                } else {
                    console.log(message);
                }
                return;
            }

            this.backend.sendNoteOff(deviceId, note, 0)
                .catch(err => {
                    this.logger.error('[KeyboardModal] Note OFF failed:', err);
                });
        }
    }

    /**
     * Envoyer un message CC modulation (CC#1) à l'instrument sélectionné
     * @param {number} value - Valeur de modulation (0-127)
     */
    initModWheel() {
        const track = document.getElementById('mod-wheel-track');
        const thumb = document.getElementById('mod-wheel-thumb');
        const fill = document.getElementById('mod-wheel-fill');
        const display = document.getElementById('keyboard-modulation-display');
        if (!track || !thumb) return;

        this._updateModWheelPosition(64);

        const getValueFromY = (clientY) => {
            const rect = track.getBoundingClientRect();
            const relativeY = clientY - rect.top;
            const ratio = 1 - (relativeY / rect.height);
            const clamped = Math.max(0, Math.min(1, ratio));
            return Math.round(clamped * 127);
        };

        const onMove = (clientY) => {
            if (!this._modWheelDragging) return;
            const value = getValueFromY(clientY);
            this.modulation = value;
            this._updateModWheelPosition(value);
            if (display) display.textContent = value;
            this.sendModulation(value);
        };

        const onEnd = () => {
            if (!this._modWheelDragging) return;
            this._modWheelDragging = false;
            thumb.classList.remove('dragging');
            thumb.classList.add('returning');
            fill.classList.add('returning');
            this.modulation = 64;
            this._updateModWheelPosition(64);
            if (display) display.textContent = '64';
            this.sendModulation(64);
            setTimeout(() => {
                thumb.classList.remove('returning');
                fill.classList.remove('returning');
            }, 300);
        };

        // Mouse events
        this._modWheelOnTrackDown = (e) => {
            e.preventDefault();
            this._modWheelDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            fill.classList.remove('returning');
            onMove(e.clientY);
        };
        this._modWheelOnMove = (e) => onMove(e.clientY);
        this._modWheelOnEnd = onEnd;
        this._modWheelOnTouchStart = (e) => {
            e.preventDefault();
            this._modWheelDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            fill.classList.remove('returning');
            onMove(e.touches[0].clientY);
        };
        this._modWheelOnTouchMove = (e) => {
            if (this._modWheelDragging) onMove(e.touches[0].clientY);
        };

        track.addEventListener('mousedown', this._modWheelOnTrackDown);
        document.addEventListener('mousemove', this._modWheelOnMove);
        document.addEventListener('mouseup', this._modWheelOnEnd);
        track.addEventListener('touchstart', this._modWheelOnTouchStart, { passive: false });
        document.addEventListener('touchmove', this._modWheelOnTouchMove, { passive: false });
        document.addEventListener('touchend', this._modWheelOnEnd);
        document.addEventListener('touchcancel', this._modWheelOnEnd);
    }

    _updateModWheelPosition(value) {
        const track = document.getElementById('mod-wheel-track');
        const thumb = document.getElementById('mod-wheel-thumb');
        const fill = document.getElementById('mod-wheel-fill');
        if (!track || !thumb) return;

        const trackHeight = track.clientHeight;
        const ratio = value / 127;
        const topPx = trackHeight * (1 - ratio);

        thumb.style.top = topPx + 'px';

        if (fill) {
            const centerPx = trackHeight * 0.5;
            if (topPx < centerPx) {
                fill.style.top = topPx + 'px';
                fill.style.height = (centerPx - topPx) + 'px';
            } else {
                fill.style.top = centerPx + 'px';
                fill.style.height = (topPx - centerPx) + 'px';
            }
        }
    }

    sendModulation(value) {
        if (!this.selectedDevice || !this.backend) return;

        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

        if (this.selectedDevice.isVirtual) {
            this.logger.info(`🎹 [Virtual] Modulation CC#1 = ${value}`);
            return;
        }

        this.backend.sendCommand('midi_send_cc', {
            deviceId: deviceId,
            channel: 0,
            controller: 1, // CC#1 = Modulation Wheel
            value: value
        }).catch(err => {
            this.logger.error('[KeyboardModal] Modulation CC send failed:', err);
        });
    }

    /**
     * Met à jour la visibilité des sliders vélocité et modulation
     * en fonction des capacités de l'instrument sélectionné
     */
    updateSlidersVisibility() {
        const velocityPanel = document.getElementById('velocity-control-panel');
        const modulationPanel = document.getElementById('modulation-control-panel');

        if (!velocityPanel || !modulationPanel) return;

        const caps = this.selectedDeviceCapabilities;

        if (!caps) {
            // Pas de capacités : afficher vélocité, masquer modulation
            velocityPanel.classList.remove('slider-hidden');
            modulationPanel.classList.add('slider-hidden');
            return;
        }

        // Vélocité : toujours visible si l'instrument supporte des notes
        const hasNotes = (caps.note_range_min !== null && caps.note_range_min !== undefined) ||
                         (caps.note_range_max !== null && caps.note_range_max !== undefined) ||
                         caps.note_selection_mode === 'discrete';
        if (hasNotes) {
            velocityPanel.classList.remove('slider-hidden');
        } else {
            velocityPanel.classList.add('slider-hidden');
        }

        // Modulation : visible si CC#1 est dans supported_ccs
        let supportsCCs = [];
        if (caps.supported_ccs) {
            try {
                supportsCCs = typeof caps.supported_ccs === 'string'
                    ? JSON.parse(caps.supported_ccs)
                    : caps.supported_ccs;
            } catch (e) {
                supportsCCs = [];
            }
        }

        if (Array.isArray(supportsCCs) && supportsCCs.includes(1)) {
            modulationPanel.classList.remove('slider-hidden');
        } else {
            modulationPanel.classList.add('slider-hidden');
        }
    }

    /**
     * Auto-centrer le clavier sur la plage de notes de l'instrument
     * Ajuste octaveOffset pour que la vue soit centrée sur les notes jouables
     * Ne modifie PAS this.octaves pour garder une largeur de touches constante
     */
    autoCenterKeyboard() {
        const caps = this.selectedDeviceCapabilities;

        // Parse note range values (may be strings from DB/JSON)
        const minNote = caps ? Number(caps.note_range_min) : NaN;
        const maxNote = caps ? Number(caps.note_range_max) : NaN;

        const hasMin = isFinite(minNote);
        const hasMax = isFinite(maxNote);

        // Si pas de plage définie, recentrer sur la position par défaut
        if (!hasMin && !hasMax) {
            this.octaveOffset = 0;
            this._updateOctaveDisplay();
            this.logger.info('[KeyboardModal] Auto-center: no note range, reset to default');
            return;
        }

        // Plage effective de notes jouables
        const effectiveMin = hasMin ? minNote : 21;
        const effectiveMax = hasMax ? maxNote : 108;

        // Centre de la plage jouable (précis, en notes MIDI)
        const rangeCenter = (effectiveMin + effectiveMax) / 2;

        // Centre de la vue à offset=0 (en notes MIDI)
        // Première note: (baseOctave + 1) * 12, dernière: première + octaves*12 - 1
        const viewCenterAtZero = (this.baseOctave + 1) * 12 + (this.octaves * 12 - 1) / 2;

        // Offset nécessaire pour aligner les deux centres (arrondi au plus proche)
        const neededOffset = Math.round((rangeCenter - viewCenterAtZero) / 12);

        // Limiter l'offset entre -3 et +3
        this.octaveOffset = Math.max(-3, Math.min(3, neededOffset));

        this._updateOctaveDisplay();
        this.logger.info(`[KeyboardModal] Auto-center: range ${effectiveMin}-${effectiveMax}, center ${rangeCenter}, offset ${this.octaveOffset}`);
    }

    /**
     * Met à jour l'affichage de l'offset d'octave dans le header
     */
    _updateOctaveDisplay() {
        const display = this.octaveOffset > 0 ? `+${this.octaveOffset}` : `${this.octaveOffset}`;
        const octaveDisplayEl = document.getElementById('keyboard-octave-display');
        if (octaveDisplayEl) {
            octaveDisplayEl.textContent = this.t('keyboard.octave', { offset: display });
        }
    }

    /**
     * Obtenir le nom d'une note depuis son numéro MIDI
     * @param {number} noteNumber - Numéro MIDI (0-127)
     * @returns {string} - Nom de la note (ex: "C4", "F#5")
     */
    getNoteNameFromNumber(noteNumber) {
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(noteNumber / 12) - 1;
        const noteName = noteNames[noteNumber % 12];
        return `${noteName}${octave}`;
    }

    // ========================================================================
    // DEVICES
    // ========================================================================

    /**
     * Charger les paramètres depuis localStorage
     */
    loadSettings() {
        try {
            const saved = localStorage.getItem('maestro_settings');
            if (saved) {
                const settings = JSON.parse(saved);

                // Appliquer le nombre d'octaves (nouveau format)
                if (settings.keyboardOctaves !== undefined) {
                    this.setOctaves(settings.keyboardOctaves);
                    this.logger.info(`[KeyboardModal] Settings loaded: ${settings.keyboardOctaves} octaves`);
                }
                // Fallback: ancien format (nombre de touches)
                else if (settings.keyboardKeys !== undefined) {
                    this.setNumberOfKeys(settings.keyboardKeys);
                    this.logger.info(`[KeyboardModal] Settings loaded (legacy): ${settings.keyboardKeys} keys`);
                }
            }
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to load settings:', error);
        }
    }

    async loadDevices() {
        try {
            const devices = await this.backend.listDevices();
            let activeDevices = devices.filter(d => d.status === 2); // Actifs seulement

            // Dédupliquer par nom (au cas où le backend n'aurait pas tout dédupliqué)
            const uniqueDevices = [];
            const seenNames = new Set();

            for (const device of activeDevices) {
                if (!seenNames.has(device.name)) {
                    seenNames.add(device.name);
                    uniqueDevices.push(device);
                    this.logger.debug('[KeyboardModal] ✓ Device kept:', device.name);
                } else {
                    this.logger.debug('[KeyboardModal] ✗ Device skipped (duplicate):', device.name);
                }
            }

            this.devices = uniqueDevices;
            this.logger.info(`[KeyboardModal] Loaded ${activeDevices.length} → ${uniqueDevices.length} unique devices`);

            // Charger les instruments virtuels de la DB (créés via Gestion des instruments)
            try {
                const capsResponse = await this.backend.sendCommand('instrument_list_capabilities');
                if (capsResponse && capsResponse.instruments) {
                    const existingIds = new Set(this.devices.map(d => d.id || d.device_id));
                    for (const dbInst of capsResponse.instruments) {
                        const devId = dbInst.device_id || dbInst.id;
                        if (devId && devId.startsWith('virtual_') && !existingIds.has(devId)) {
                            const vName = dbInst.custom_name || dbInst.name || 'Virtual Instrument';
                            const virtualDbDevice = {
                                id: devId,
                                device_id: devId,
                                name: `🖥️ ${vName}`,
                                displayName: `🖥️ ${vName}`,
                                type: 'Virtual',
                                status: 2,
                                connected: true,
                                isVirtual: true,
                                channel: dbInst.channel || 0,
                                gm_program: dbInst.gm_program,
                                customName: null
                            };
                            this.devices.push(virtualDbDevice);
                        }
                    }
                    this.logger.info('[KeyboardModal] Virtual DB instruments loaded');
                }
            } catch (error) {
                this.logger.warn('[KeyboardModal] Could not load virtual DB instruments:', error);
            }

            // Enrichir avec noms personnalisés
            this.devices = await Promise.all(this.devices.map(async (device) => {
                const deviceId = device.id || device.device_id;
                const normalizedDevice = {
                    ...device,
                    id: deviceId,
                    device_id: deviceId
                };

                // Ne pas appeler l'API pour le périphérique virtuel
                if (device.isVirtual) {
                    return normalizedDevice;
                }

                try {
                    const response = await this.backend.sendCommand('instrument_get_settings', {
                        deviceId: deviceId
                    });
                    const settings = response.settings || {};
                    return {
                        ...normalizedDevice,
                        displayName: settings.custom_name || device.name,
                        customName: settings.custom_name
                    };
                } catch (error) {
                    return {
                        ...normalizedDevice,
                        displayName: device.name,
                        customName: null
                    };
                }
            }));
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to load devices:', error);
            this.devices = [];
        }
    }

    populateDeviceSelect() {
        const select = document.getElementById('keyboard-device-select');
        if (!select) return;

        select.innerHTML = `<option value="">${this.t('common.select')}</option>`;

        this.devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.device_id;
            option.textContent = device.displayName || device.name;
            select.appendChild(option);
        });
    }

    /**
     * Rafraîchir la liste des périphériques si le modal est ouvert
     */
    async refreshDevices() {
        if (!this.isOpen) return;

        this.logger.info('[KeyboardModal] Refreshing devices...');
        await this.loadDevices();
        this.populateDeviceSelect();
    }
}
