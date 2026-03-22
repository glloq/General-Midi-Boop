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
        this.mouseActiveNotes = new Set(); // Notes déclenchées par la souris (pour cleanup au mouseup global)
        this.velocity = 80;
        this.modulation = 64; // CC#1 modulation wheel value (center)
        this._modWheelDragging = false;
        this.keyboardLayout = 'azerty';
        this.isMouseDown = false; // Pour le drag sur le clavier

        // Piano config
        this.octaves = 3; // 3 octaves par défaut (plage: 1-4 octaves)
        this.startNote = 48; // Première note MIDI affichée (C3 par défaut)
        this.defaultStartNote = 48; // Valeur par défaut pour reset
        // Notes blanches: semitones relatives dans une octave
        this.whiteNoteOffsets = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
        // Semitones qui ont une touche noire (dièse)
        this.blackNoteSemitones = new Set([1, 3, 6, 8, 10]); // C# D# F# G# A#
        // Tables de correspondance pour les touches PC (générées dynamiquement)
        this.visibleWhiteNotes = [];
        this.visibleBlackNotes = [];

        // Le mapping clavier PC est dynamique (voir _resolveKeyToNote)

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

        // Note range display
        this._updateOctaveDisplay();

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
        this.mouseActiveNotes.clear();
        this.selectedDevice = null;

        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.isOpen = false;
        this.logger.info('[KeyboardModal] Closed');
    }

    createModal() {
        const endNote = this.startNote + this.octaves * 12 - 1;
        const display = `${this.getNoteNameFromNumber(this.startNote)} - ${this.getNoteNameFromNumber(endNote)}`;

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
                                <span class="octave-display" id="keyboard-octave-display">${display}</span>
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

        const totalNotes = this.octaves * 12;
        const endNote = this.startNote + totalNotes;
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // Collecter les touches blanches et noires
        this.visibleWhiteNotes = [];
        this.visibleBlackNotes = [];

        for (let midi = this.startNote; midi < endNote; midi++) {
            const semitone = midi % 12;
            if (!this.blackNoteSemitones.has(semitone)) {
                this.visibleWhiteNotes.push(midi);
            } else {
                this.visibleBlackNotes.push(midi);
            }
        }

        const totalWhiteKeys = this.visibleWhiteNotes.length;

        // Générer les touches blanches
        for (let i = 0; i < totalWhiteKeys; i++) {
            const noteNumber = this.visibleWhiteNotes[i];
            const octave = Math.floor(noteNumber / 12) - 1;
            const noteName = noteNames[noteNumber % 12];

            const whiteKey = document.createElement('div');
            whiteKey.className = 'piano-key white-key';
            whiteKey.dataset.note = noteNumber;
            whiteKey.dataset.noteName = noteName + octave;

            if (!this.isNotePlayable(noteNumber)) {
                whiteKey.classList.add('disabled');
            }

            const label = document.createElement('span');
            label.className = 'key-label';
            label.textContent = noteName + octave;
            whiteKey.appendChild(label);

            pianoContainer.appendChild(whiteKey);
        }

        // Générer les touches noires positionnées sur les blanches
        for (const blackNote of this.visibleBlackNotes) {
            const octave = Math.floor(blackNote / 12) - 1;
            const noteName = noteNames[blackNote % 12];

            // Trouver la touche blanche juste avant cette noire
            const whiteBelow = blackNote - 1; // la blanche en dessous
            const whiteIndex = this.visibleWhiteNotes.indexOf(whiteBelow);
            if (whiteIndex < 0) continue; // bord du clavier

            const blackKey = document.createElement('div');
            blackKey.className = 'piano-key black-key';
            blackKey.dataset.note = blackNote;
            blackKey.dataset.noteName = noteName + octave;

            if (!this.isNotePlayable(blackNote)) {
                blackKey.classList.add('disabled');
            }

            // Positionner entre la blanche courante et la suivante
            blackKey.style.left = `calc(${whiteIndex * (100 / totalWhiteKeys)}% + ${(100 / totalWhiteKeys) * 0.7}%)`;

            pianoContainer.appendChild(blackKey);
        }
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
     * @param {number} [channel] - Canal MIDI (pour les devices multi-instruments)
     */
    async loadDeviceCapabilities(deviceId, channel) {
        if (!deviceId) {
            this.selectedDeviceCapabilities = null;
            return;
        }

        try {
            const params = { deviceId };
            if (channel !== undefined) {
                params.channel = channel;
            }
            const response = await this.backend.sendCommand('instrument_get_capabilities', params);
            this.selectedDeviceCapabilities = response.capabilities || null;
            this.logger.info(`[KeyboardModal] Capacités chargées pour ${deviceId} ch${channel}:`, this.selectedDeviceCapabilities);
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
            if (key) {
                e.preventDefault(); // Empêcher le drag/sélection du navigateur
                this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} });
            }
        };
        this._pianoMouseUp = (e) => {
            const key = getKey(e);
            if (key) { this.handlePianoKeyUp({ currentTarget: key }); }
        };
        this._pianoMouseLeave = (e) => {
            if (e.target.classList?.contains('piano-key')) {
                const note = parseInt(e.target.dataset.note);
                this.mouseActiveNotes.delete(note);
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
            const totalNotes = this.octaves * 12;
            this.startNote = Math.min(127 - totalNotes, this.startNote + 12);
            this._updateOctaveDisplay();
            this.regeneratePianoKeys();
        });

        document.getElementById('keyboard-octave-down')?.addEventListener('click', () => {
            this.startNote = Math.max(0, this.startNote - 12);
            this._updateOctaveDisplay();
            this.regeneratePianoKeys();
        });

        // Device select
        document.getElementById('keyboard-device-select')?.addEventListener('change', async (e) => {
            const rawValue = e.target.value;
            let deviceId = rawValue;
            let selectedChannel = undefined;

            // Parser le format "deviceId::channel" pour les devices multi-instruments
            if (rawValue.includes('::')) {
                const parts = rawValue.split('::');
                deviceId = parts[0];
                selectedChannel = parseInt(parts[1]);
            }

            this.selectedDevice = this.devices.find(d => {
                if (d._multiInstrument && selectedChannel !== undefined) {
                    return (d.device_id === deviceId || d.id === deviceId) && d.channel === selectedChannel;
                }
                return d.device_id === deviceId || d.id === deviceId;
            }) || null;

            // Charger les capacités de l'instrument sélectionné
            await this.loadDeviceCapabilities(deviceId, selectedChannel);

            // Envoyer Program Change si l'instrument a un programme GM défini
            if (this.selectedDevice && !this.selectedDevice.isVirtual && this.backend) {
                await this.sendProgramChange(deviceId);
            }

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

        // Stopper toutes les notes déclenchées par la souris
        // (évite les notes "coincées" si le mouseup se produit hors d'une touche)
        if (this.mouseActiveNotes.size > 0) {
            for (const note of this.mouseActiveNotes) {
                this.stopNote(note);
            }
            this.mouseActiveNotes.clear();
        }
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
            this.mouseActiveNotes.add(note);
            this.playNote(note);
        }
    }

    handlePianoKeyUp(e) {
        const key = e.currentTarget;
        const note = parseInt(key.dataset.note);

        this.mouseActiveNotes.delete(note);

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
            this.mouseActiveNotes.add(note);
            this.playNote(note);
        }
    }

    /**
     * Résoudre une touche PC en note MIDI via les touches visibles
     * Les touches blanches (S D F G H J K L M) mappent aux 9 premières touches blanches
     * Les touches noires (Z E T Y U O P) mappent aux noires adjacentes
     */
    _resolveKeyToNote(code) {
        // Mapping des touches PC vers les indices des touches blanches visibles
        const whiteKeyIndices = this.keyboardLayout === 'qwerty'
            ? { 'KeyS': 0, 'KeyD': 1, 'KeyF': 2, 'KeyG': 3, 'KeyH': 4, 'KeyJ': 5, 'KeyK': 6, 'KeyL': 7, 'Semicolon': 8 }
            : { 'KeyS': 0, 'KeyD': 1, 'KeyF': 2, 'KeyG': 3, 'KeyH': 4, 'KeyJ': 5, 'KeyK': 6, 'KeyL': 7, 'KeyM': 8 };

        // Touches noires : entre quelles touches blanches (index de la blanche à gauche)
        const blackKeyIndices = this.keyboardLayout === 'qwerty'
            ? { 'KeyW': 0, 'KeyE': 1, 'KeyT': 3, 'KeyY': 4, 'KeyU': 5, 'KeyO': 7, 'KeyP': 8 }
            : { 'KeyZ': 0, 'KeyE': 1, 'KeyT': 3, 'KeyY': 4, 'KeyU': 5, 'KeyO': 7, 'KeyP': 8 };

        // Touche blanche ?
        if (whiteKeyIndices[code] !== undefined) {
            const idx = whiteKeyIndices[code];
            return idx < this.visibleWhiteNotes.length ? this.visibleWhiteNotes[idx] : null;
        }

        // Touche noire ? Trouver la noire juste au-dessus de la blanche correspondante
        if (blackKeyIndices[code] !== undefined) {
            const whiteIdx = blackKeyIndices[code];
            if (whiteIdx >= this.visibleWhiteNotes.length) return null;
            const whiteNote = this.visibleWhiteNotes[whiteIdx];
            // La noire est 1 demi-ton au-dessus si elle existe dans les visibles
            const blackNote = whiteNote + 1;
            return this.visibleBlackNotes.includes(blackNote) ? blackNote : null;
        }

        return null;
    }

    handleKeyDown(e) {
        if (!this.isOpen) return;

        const note = this._resolveKeyToNote(e.code);
        if (note === null) return;

        e.preventDefault();

        if (!this.activeNotes.has(note)) {
            this.playNote(note);
        }
    }

    handleKeyUp(e) {
        if (!this.isOpen) return;

        const note = this._resolveKeyToNote(e.code);
        if (note === null) return;

        e.preventDefault();

        this.stopNote(note);
    }

    // ========================================================================
    // MIDI
    // ========================================================================

    /**
     * Retourne le canal MIDI de l'instrument sélectionné (depuis les capacités ou le device)
     * @returns {number} Canal MIDI (0-15)
     */
    getSelectedChannel() {
        if (this.selectedDeviceCapabilities && this.selectedDeviceCapabilities.channel !== undefined) {
            return this.selectedDeviceCapabilities.channel;
        }
        if (this.selectedDevice && this.selectedDevice.channel !== undefined) {
            return this.selectedDevice.channel;
        }
        return 0;
    }

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

            const channel = this.getSelectedChannel();
            this.backend.sendNoteOn(deviceId, note, this.velocity, channel)
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

            const channel = this.getSelectedChannel();
            this.backend.sendNoteOff(deviceId, note, channel)
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

        const channel = this.getSelectedChannel();
        this.backend.sendCommand('midi_send_cc', {
            deviceId: deviceId,
            channel: channel,
            controller: 1, // CC#1 = Modulation Wheel
            value: value
        }).catch(err => {
            this.logger.error('[KeyboardModal] Modulation CC send failed:', err);
        });
    }

    /**
     * Envoyer un Program Change à l'instrument sélectionné
     * pour activer le bon son GM sur le bon canal
     */
    async sendProgramChange(deviceId) {
        const caps = this.selectedDeviceCapabilities;
        const device = this.selectedDevice;

        // Chercher gm_program dans les capabilities, puis dans le device
        let gmProgram = null;
        if (caps && caps.gm_program !== undefined && caps.gm_program !== null) {
            gmProgram = caps.gm_program;
        } else if (device && device.gm_program !== undefined && device.gm_program !== null) {
            gmProgram = device.gm_program;
        }

        if (gmProgram === null) return;

        const channel = this.getSelectedChannel();
        try {
            await this.backend.sendCommand('midi_send_program', {
                deviceId: deviceId,
                channel: channel,
                program: gmProgram
            });
            this.logger.info(`[KeyboardModal] Program Change: ${gmProgram} on channel ${channel}`);
        } catch (err) {
            this.logger.error('[KeyboardModal] Program Change failed:', err);
        }
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
     * Calcule startNote avec une précision à la note (pas à l'octave)
     */
    autoCenterKeyboard() {
        const caps = this.selectedDeviceCapabilities;
        if (!caps) {
            this.startNote = this.defaultStartNote;
            this._updateOctaveDisplay();
            this.logger.info('[KeyboardModal] Auto-center: no capabilities, reset to default');
            return;
        }

        // Déterminer la plage effective selon le mode
        let effectiveMin, effectiveMax;

        if (caps.note_selection_mode === 'discrete' && caps.selected_notes) {
            // Mode percussion : calculer min/max depuis les notes discrètes
            try {
                const notes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                if (Array.isArray(notes) && notes.length > 0) {
                    effectiveMin = Math.min(...notes);
                    effectiveMax = Math.max(...notes);
                }
            } catch (e) { /* ignore */ }
        }

        // Fallback sur note_range_min/max
        if (effectiveMin === undefined || effectiveMax === undefined) {
            const minNote = Number(caps.note_range_min);
            const maxNote = Number(caps.note_range_max);
            if (!isFinite(minNote) && !isFinite(maxNote)) {
                this.startNote = this.defaultStartNote;
                this._updateOctaveDisplay();
                this.logger.info('[KeyboardModal] Auto-center: no note range, reset to default');
                return;
            }
            effectiveMin = isFinite(minNote) ? minNote : 21;
            effectiveMax = isFinite(maxNote) ? maxNote : 108;
        }

        // Centre de la plage jouable
        const rangeCenter = (effectiveMin + effectiveMax) / 2;
        const totalNotes = this.octaves * 12;

        // startNote idéal pour centrer la vue sur la plage jouable
        const idealStart = Math.round(rangeCenter - totalNotes / 2);

        // Clamper dans les limites MIDI (0-127)
        this.startNote = Math.max(0, Math.min(127 - totalNotes, idealStart));

        this._updateOctaveDisplay();
        this.logger.info(`[KeyboardModal] Auto-center: range ${effectiveMin}-${effectiveMax}, center ${rangeCenter}, startNote ${this.startNote} (${this.getNoteNameFromNumber(this.startNote)})`);
    }

    /**
     * Met à jour l'affichage de la plage de notes dans le header
     */
    _updateOctaveDisplay() {
        const octaveDisplayEl = document.getElementById('keyboard-octave-display');
        if (octaveDisplayEl) {
            const endNote = this.startNote + this.octaves * 12 - 1;
            const startName = this.getNoteNameFromNumber(this.startNote);
            const endName = this.getNoteNameFromNumber(endNote);
            octaveDisplayEl.textContent = `${startName} - ${endName}`;
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

            // Éclater les devices multi-instruments en entrées individuelles
            const expandedDevices = [];
            for (const device of uniqueDevices) {
                if (device.instruments && device.instruments.length > 0) {
                    for (const inst of device.instruments) {
                        expandedDevices.push({
                            ...device,
                            channel: inst.channel !== undefined ? inst.channel : 0,
                            displayName: inst.custom_name || inst.name || device.name,
                            gm_program: inst.gm_program,
                            _instrumentId: inst.id,
                            _multiInstrument: true
                        });
                    }
                } else {
                    expandedDevices.push(device);
                }
            }
            this.devices = expandedDevices;
            this.logger.info(`[KeyboardModal] Loaded ${activeDevices.length} → ${uniqueDevices.length} unique devices → ${expandedDevices.length} instruments`);

            // Charger les instruments virtuels de la DB (créés via Gestion des instruments)
            // Respecter le réglage "virtualInstrument" de SettingsModal
            let virtualEnabled = false;
            try {
                const savedSettings = localStorage.getItem('maestro_settings');
                if (savedSettings) {
                    const parsed = JSON.parse(savedSettings);
                    virtualEnabled = !!parsed.virtualInstrument;
                }
            } catch (e) { /* ignore */ }

            if (virtualEnabled) {
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
            } else {
                this.logger.info('[KeyboardModal] Virtual instruments disabled in settings, skipping');
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

                // Les devices multi-instruments ont déjà leur displayName depuis l'éclatement
                if (device._multiInstrument) {
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
            // Pour les devices multi-instruments, inclure le canal dans la valeur
            if (device._multiInstrument) {
                option.value = `${device.device_id}::${device.channel}`;
                const chLabel = `Ch${(device.channel || 0) + 1}`;
                option.textContent = `${device.displayName || device.name} [${chLabel}]`;
            } else {
                option.value = device.device_id;
                option.textContent = device.displayName || device.name;
            }
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
