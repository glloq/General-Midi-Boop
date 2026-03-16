// ============================================================================
// Fichier: public/js/views/components/MidiEditorModal.js
// Version: v2.1.0 - Utilise webaudio-pianoroll (g200kg) + i18n support
// Description: Modale d'édition MIDI avec piano roll webaudio-pianoroll
// ============================================================================

class MidiEditorModal {
    constructor(eventBus, apiClient) {
        this.eventBus = eventBus;
        this.api = apiClient;
        this.logger = window.logger || console;

        this.container = null;
        this.isOpen = false;
        this.pianoRoll = null;

        // i18n support
        this.localeUnsubscribe = null;

        // État
        this.currentFile = null;  // fileId
        this.currentFilename = null;  // nom du fichier pour affichage
        this.midiData = null;
        this.isDirty = false;

        // Sequence de notes pour webaudio-pianoroll
        this.sequence = [];
        this.fullSequence = []; // Toutes les notes (tous canaux)
        this.activeChannels = new Set(); // Canaux actifs à afficher
        this.channels = []; // Informations sur les canaux disponibles

        // Clipboard pour copy/paste
        this.clipboard = [];

        // Mode d'édition actuel
        this.editMode = 'drag-view'; // 'select', 'drag-notes', 'drag-view' - drag-view par défaut pour navigation

        // Instrument sélectionné pour les nouveaux canaux (program MIDI GM)
        this.selectedInstrument = 0; // Piano par défaut

        // CC/Pitchbend/Velocity/Tempo Editor
        this.ccEditor = null;
        this.velocityEditor = null;
        this.tempoEditor = null;
        this.currentCCType = 'cc1'; // 'cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc76', 'cc77', 'cc78', 'cc91', 'pitchbend', 'velocity', 'tempo'
        this.ccEvents = []; // Événements CC et pitchbend
        this.tempoEvents = []; // Événements de tempo
        this.ccSectionExpanded = false; // État du collapse de la section CC

        // Instrument connecté sélectionné pour visualiser les notes jouables
        this.connectedDevices = []; // Liste des appareils MIDI connectés
        this.selectedConnectedDevice = null; // Appareil sélectionné (deviceId)
        this.selectedDeviceCapabilities = null; // Capacités de l'appareil sélectionné
        this.playableNotes = null; // Set des notes jouables (0-127) ou null si pas de filtre

        // Playback (synthétiseur intégré)
        this.synthesizer = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.playbackStartTick = 0;
        this.playbackEndTick = 0

        // Grille de snap pour l'édition (contrainte de positionnement)
        // Valeurs en ticks (basé sur 480 ticks par noire)
        // Progression optimisée : précision maximale pour 1/16, valeurs raisonnables pour subdivisions larges
        this.snapValues = [
            { ticks: 120, label: '1/1' },  // Ronde (snap à 120 = 1/16, évite sauts énormes)
            { ticks: 60,  label: '1/2' },  // Blanche (snap à 60 = 1/32)
            { ticks: 30,  label: '1/4' },  // Noire (snap à 30 = 1/64)
            { ticks: 15,  label: '1/8' },  // Croche (snap à 15 = 1/128)
            { ticks: 1,   label: '1/16' }  // Double croche (snap à 1 tick = PRÉCISION MAXIMALE)
        ];
        this.currentSnapIndex = 3; // Par défaut 1/8 (15 ticks, très fin)

        // Couleurs éclatantes pour les 16 canaux MIDI
        this.channelColors = [
            '#FF0066', // 1 - Rose/Magenta vif
            '#00FFFF', // 2 - Cyan éclatant
            '#FF00FF', // 3 - Magenta pur
            '#FFFF00', // 4 - Jaune vif
            '#00FF00', // 5 - Vert pur
            '#FF6600', // 6 - Orange éclatant
            '#9D00FF', // 7 - Violet vif
            '#00FF99', // 8 - Vert menthe éclatant
            '#FF0000', // 9 - Rouge pur
            '#00BFFF', // 10 - Bleu ciel éclatant (Drums)
            '#FFD700', // 11 - Or éclatant
            '#FF1493', // 12 - Rose profond
            '#00FFAA', // 13 - Turquoise éclatant
            '#FF4500', // 14 - Orange-rouge vif
            '#7FFF00', // 15 - Vert chartreuse
            '#FF69B4'  // 16 - Rose chaud
        ];

        // Table des instruments General MIDI
        this.gmInstruments = [
            // Piano (0-7)
            'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
            'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
            // Chromatic Percussion (8-15)
            'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
            // Organ (16-23)
            'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
            // Guitar (24-31)
            'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
            'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar harmonics',
            // Bass (32-39)
            'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
            'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
            // Strings (40-47)
            'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
            // Ensemble (48-55)
            'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
            'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
            // Brass (56-63)
            'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
            // Reed (64-71)
            'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
            // Pipe (72-79)
            'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
            // Synth Lead (80-87)
            'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
            'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
            // Synth Pad (88-95)
            'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
            'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
            // Synth Effects (96-103)
            'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
            'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
            // Ethnic (104-111)
            'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
            // Percussive (112-119)
            'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
            // Sound Effects (120-127)
            'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'
        ];
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
     * Récupère le nom d'un instrument GM traduit
     * @param {number} index - Index de l'instrument (0-127)
     * @returns {string} - Nom de l'instrument traduit
     */
    getInstrumentName(index) {
        const translatedList = this.t('instruments.list');
        if (Array.isArray(translatedList) && translatedList[index]) {
            return translatedList[index];
        }
        return this.gmInstruments[index] || `Instrument ${index}`;
    }

    // ========================================================================
    // AFFICHAGE DE LA MODALE
    // ========================================================================

    /**
     * Afficher la modale d'édition MIDI
     * @param {string} fileId - ID du fichier dans la base de données
     * @param {string} filename - Nom du fichier (optionnel, pour l'affichage)
     */
    async show(fileId, filename = null) {
        if (this.isOpen) {
            this.log('warn', 'Modal already open');
            return;
        }

        this.currentFile = fileId;
        this.currentFilename = filename || fileId;
        this.isDirty = false;

        // Réinitialiser la sélection d'instrument connecté (pas de filtre par défaut)
        this.selectedConnectedDevice = null;
        this.selectedDeviceCapabilities = null;
        this.playableNotes = null;

        // CommandHistory n'est plus utilisé - le piano roll gère undo/redo nativement

        try {
            // Charger le fichier MIDI
            await this.loadMidiFile(fileId);

            // Afficher la modale
            this.render();

            // Initialiser le piano roll
            await this.initPianoRoll();

            this.isOpen = true;

            // Installer le gestionnaire beforeunload pour empêcher la fermeture avec des modifications non sauvegardées
            this.setupBeforeUnloadHandler();

            // Subscribe to locale changes
            if (typeof i18n !== 'undefined') {
                this.localeUnsubscribe = i18n.onLocaleChange(() => {
                    // Note: le piano roll est déjà rendu, on ne peut pas facilement re-traduire
                    // mais on garde la souscription pour cohérence
                });
            }

            // Émettre événement
            if (this.eventBus) {
                this.eventBus.emit('midi_editor:opened', { fileId, filename: this.currentFilename });
            }

        } catch (error) {
            this.log('error', 'Failed to open MIDI editor:', error);
            this.showError(this.t('midiEditor.cannotOpen', { error: error.message }));
        }
    }

    /**
     * Charger le fichier MIDI depuis le backend
     */
    async loadMidiFile(fileId) {
        try {
            this.log('info', `Loading MIDI file: ${this.currentFilename || fileId}`);

            // Utiliser la nouvelle méthode readMidiFile du BackendAPIClient
            const response = await this.api.readMidiFile(fileId);

            if (!response || !response.midiData) {
                throw new Error('No MIDI data received from server');
            }

            // Le backend renvoie un objet avec : { id, filename, midi: {...}, size, tracks, duration, tempo }
            // Extraire les données MIDI proprement dites
            const fileData = response.midiData;
            this.midiData = fileData.midi || fileData;

            // S'assurer qu'on a bien un objet header et tracks
            if (!this.midiData.header || !this.midiData.tracks) {
                throw new Error('Invalid MIDI data structure');
            }

            // Convertir en sequence pour webaudio-pianoroll
            this.convertMidiToSequence();

            this.log('info', `MIDI file loaded: ${this.midiData.tracks?.length || 0} tracks, ${this.sequence.length} notes`);

        } catch (error) {
            this.log('error', 'Failed to load MIDI file:', error);

            // Si l'erreur est "Unknown command", proposer une alternative
            if (error.message.includes('Unknown command') || error.message.includes('file_read')) {
                throw new Error(this.t('midiEditor.backendNotSupported'));
            }

            throw error;
        }
    }

    /**
     * Convertir les données MIDI en format sequence pour webaudio-pianoroll
     * Format: {t: tick, g: gate, n: note, c: channel}
     */
    convertMidiToSequence() {
        this.fullSequence = [];
        this.channels = [];

        if (!this.midiData || !this.midiData.tracks) {
            this.log('warn', 'No MIDI tracks to convert');
            return;
        }

        const ticksPerBeat = this.midiData.header?.ticksPerBeat || 480;
        this.ticksPerBeat = ticksPerBeat; // Sauvegarder pour utilisation ultérieure

        // Extraire le tempo et la tempo map du fichier MIDI
        let tempo = 120; // Tempo par défaut
        this.tempoEvents = []; // Reset tempo events
        if (this.midiData.tracks && this.midiData.tracks.length > 0) {
            for (const track of this.midiData.tracks) {
                if (!track.events) continue;
                let currentTick = 0;
                for (const event of track.events) {
                    currentTick += event.deltaTime || 0;
                    if (event.type === 'setTempo' && event.microsecondsPerBeat) {
                        const bpm = Math.round(60000000 / event.microsecondsPerBeat);
                        if (this.tempoEvents.length === 0) {
                            tempo = bpm; // Premier tempo = tempo global
                        }
                        this.tempoEvents.push({
                            ticks: currentTick,
                            tempo: bpm,
                            id: Date.now() + Math.random() + this.tempoEvents.length
                        });
                    }
                }
            }
            if (this.tempoEvents.length > 0) {
                this.log('info', `Extracted ${this.tempoEvents.length} tempo events (first: ${tempo} BPM)`);
            }
        }
        this.tempo = tempo; // Sauvegarder pour utilisation ultérieure

        this.log('info', `Converting MIDI: ${this.midiData.tracks.length} tracks, ${ticksPerBeat} ticks/beat, ${tempo} BPM`);

        // Informations sur les instruments par canal
        const channelInstruments = new Map(); // canal -> program number
        const channelNoteCount = new Map();   // canal -> nombre de notes

        // Extraire toutes les notes de toutes les pistes
        const allNotes = [];

        this.midiData.tracks.forEach((track, trackIndex) => {
            if (!track.events) {
                this.log('debug', `Track ${trackIndex}: no events`);
                return;
            }

            this.log('debug', `Track ${trackIndex} (${track.name || 'unnamed'}): ${track.events.length} events`);

            // Tracker les notes actives pour calculer la durée
            const activeNotes = new Map();
            let currentTick = 0;
            let noteOnCount = 0;
            let noteOffCount = 0;

            track.events.forEach((event, eventIndex) => {
                currentTick += event.deltaTime || 0;

                // Program Change (instrument)
                if (event.type === 'programChange') {
                    const channel = event.channel || 0;
                    channelInstruments.set(channel, event.programNumber);
                    this.log('debug', `Channel ${channel}: program ${event.programNumber} (${this.getInstrumentName(event.programNumber)})`);
                }

                // Note On
                if (event.type === 'noteOn' && event.velocity > 0) {
                    noteOnCount++;
                    const channel = event.channel || 0;
                    const key = `${channel}_${event.noteNumber}`;
                    activeNotes.set(key, {
                        tick: currentTick,
                        note: event.noteNumber,
                        velocity: event.velocity,
                        channel: channel
                    });

                    // Log first note on event for debugging
                    if (noteOnCount === 1) {
                        this.log('debug', `First noteOn in track ${trackIndex}:`, {
                            tick: currentTick,
                            note: event.noteNumber,
                            velocity: event.velocity,
                            channel: channel
                        });
                    }
                }
                // Note Off
                else if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
                    noteOffCount++;
                    const channel = event.channel || 0;
                    const key = `${channel}_${event.noteNumber}`;
                    const noteOn = activeNotes.get(key);

                    if (noteOn) {
                        const gate = currentTick - noteOn.tick;
                        allNotes.push({
                            tick: noteOn.tick,
                            note: noteOn.note,
                            gate: gate,
                            velocity: noteOn.velocity,
                            channel: channel
                        });

                        // Compter les notes par canal
                        channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

                        activeNotes.delete(key);
                    }
                }
            });

            this.log('debug', `Track ${trackIndex} summary: ${noteOnCount} note-ons, ${noteOffCount} note-offs, ${allNotes.length} complete notes`);
        });

        // Convertir en format webaudio-pianoroll: {t: tick, g: gate, n: note, c: channel, v: velocity}
        this.fullSequence = allNotes.map(note => ({
            t: note.tick,    // tick (position de départ)
            g: note.gate,    // gate (durée)
            n: note.note,    // note (numéro MIDI)
            c: note.channel, // canal MIDI (0-15)
            v: note.velocity || 100  // vélocité (1-127, défaut: 100)
        }));

        // Trier par tick
        this.fullSequence.sort((a, b) => a.t - b.t);

        // Construire la liste des canaux disponibles
        channelNoteCount.forEach((count, channel) => {
            const programNumber = channelInstruments.get(channel) || 0;
            const instrumentName = channel === 9 ? this.t('midiEditor.drumKit') : this.getInstrumentName(programNumber);

            this.channels.push({
                channel: channel,
                program: programNumber,
                instrument: instrumentName,
                noteCount: count
            });
        });

        // Trier les canaux par numéro
        this.channels.sort((a, b) => a.channel - b.channel);

        this.log('info', `Converted ${this.fullSequence.length} notes to sequence`);
        this.log('info', `Found ${this.channels.length} channels:`, this.channels);

        // Extraire les événements CC et pitchbend
        this.extractCCAndPitchbend();

        // Ajouter des boutons dynamiques pour les CC détectés dans le fichier
        this.updateDynamicCCButtons();

        // Afficher TOUS les canaux par défaut et construire la séquence
        this.activeChannels.clear();
        if (this.channels.length > 0) {
            this.channels.forEach(ch => this.activeChannels.add(ch.channel));

            // Construire la séquence filtrée MAINTENANT (avant la création du piano roll)
            this.sequence = this.fullSequence.filter(note => this.activeChannels.has(note.c));

            this.log('info', `All ${this.channels.length} channels activated by default`);
            this.log('info', `Initial sequence: ${this.sequence.length} notes visible`);
        } else {
            this.log('warn', 'No notes found! Check MIDI data structure.');
            this.sequence = [];
        }
    }

    /**
     * Obtenir l'ensemble de TOUS les canaux ayant des événements CC/Pitchbend
     * (tous types confondus)
     */
    getAllCCChannels() {
        const channels = new Set();
        this.ccEvents.forEach(event => {
            if (event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    /**
     * Obtenir l'ensemble des canaux utilisés par le type CC/Pitchbend actuel
     */
    getCCChannelsUsed() {
        const channels = new Set();
        this.ccEvents.forEach(event => {
            // Filtrer uniquement les événements du type CC actuellement sélectionné
            if (event.type === this.currentCCType && event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    /**
     * Mettre à jour le sélecteur de canal pour afficher uniquement les canaux présents dans le fichier
     */
    updateEditorChannelSelector() {
        const channelSelector = document.getElementById('editor-channel-selector');
        if (!channelSelector) return;

        // Le tempo n'utilise pas de canaux - masquer le sélecteur
        if (this.currentCCType === 'tempo') {
            channelSelector.innerHTML = '';
            return;
        }

        let channelsToShow = [];
        let activeChannel = 0;

        if (this.currentCCType === 'velocity') {
            // Pour la vélocité, afficher tous les canaux ayant des notes
            channelsToShow = this.channels.map(ch => ch.channel).sort((a, b) => a - b);
            activeChannel = this.velocityEditor ? this.velocityEditor.currentChannel : 0;
        } else {
            // Pour CC/Pitchbend, afficher les canaux utilisés pour ce type
            const usedChannels = this.getCCChannelsUsed();
            channelsToShow = usedChannels.length > 0 ? usedChannels : this.getAllCCChannels();
            activeChannel = this.ccEditor ? this.ccEditor.currentChannel : 0;
        }

        // Si aucun canal, afficher un message
        if (channelsToShow.length === 0) {
            const message = this.currentCCType === 'velocity' ? this.t('midiEditor.noNotesInFile') : this.t('midiEditor.noCCInFile');
            channelSelector.innerHTML = `<div class="cc-no-channels">${message}</div>`;
            this.log('info', message);
            return;
        }

        // Générer les boutons uniquement pour les canaux présents
        channelSelector.innerHTML = channelsToShow.map(channel => `
            <button class="cc-channel-btn ${channel === activeChannel ? 'active' : ''}" data-channel="${channel}" title="${this.t('midiEditor.channelTip', { channel: channel + 1 })}">
                ${channel + 1}
            </button>
        `).join('');

        // Réattacher les event listeners
        this.attachEditorChannelListeners();

        this.log('info', `Sélecteur de canal mis à jour - Type ${this.currentCCType}: ${channelsToShow.length} canaux`);
    }

    /**
     * DEPRECATED: Use updateEditorChannelSelector() instead
     */
    updateCCChannelSelector() {
        this.updateEditorChannelSelector();
    }

    /**
     * Attacher les event listeners aux boutons de canal pour CC ou Velocity
     */
    attachEditorChannelListeners() {
        if (!this.container) return;

        const channelButtons = this.container.querySelectorAll('.cc-channel-btn');
        channelButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const channel = parseInt(btn.dataset.channel);

                if (!isNaN(channel)) {
                    // Mettre à jour l'UI
                    channelButtons.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    // Mettre à jour l'éditeur approprié
                    if (this.currentCCType === 'velocity' && this.velocityEditor) {
                        this.velocityEditor.setChannel(channel);
                        this.log('info', `Canal vélocité sélectionné: ${channel + 1}`);
                    } else if (this.ccEditor) {
                        this.ccEditor.setChannel(channel);
                        this.log('info', `Canal CC sélectionné: ${channel + 1}`);
                    }
                }
            });
        });
    }

    /**
     * DEPRECATED: Use attachEditorChannelListeners() instead
     */
    attachCCChannelListeners() {
        this.attachEditorChannelListeners();
    }

    /**
     * Extraire les événements CC et pitchbend de toutes les pistes
     * Format de sortie attendu par CCPitchbendEditor:
     * { type: 'cc1'|'cc7'|'cc10'|'cc11'|'pitchbend', ticks: number, value: number, channel: number }
     */
    extractCCAndPitchbend() {
        this.ccEvents = [];

        if (!this.midiData || !this.midiData.tracks) {
            this.log('warn', 'No MIDI tracks to extract CC/pitchbend');
            return;
        }

        this.midiData.tracks.forEach((track, trackIndex) => {
            if (!track.events) {
                return;
            }

            let currentTick = 0;

            track.events.forEach((event) => {
                currentTick += event.deltaTime || 0;

                // Control Change events — capturer TOUS les CC (0-127)
                if (event.type === 'controller') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    const controller = event.controllerType;

                    if (controller !== undefined && controller >= 0 && controller <= 127) {
                        this.ccEvents.push({
                            type: `cc${controller}`,
                            ticks: currentTick,
                            channel: channel,
                            value: event.value,
                            id: Date.now() + Math.random() + this.ccEvents.length
                        });
                    }
                }

                // Pitch Bend events
                if (event.type === 'pitchBend') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    this.ccEvents.push({
                        type: 'pitchbend',
                        ticks: currentTick,
                        channel: channel,
                        value: event.value,
                        id: Date.now() + Math.random() + this.ccEvents.length
                    });
                }
            });
        });

        // Trier par tick
        this.ccEvents.sort((a, b) => a.ticks - b.ticks);

        this.log('info', `Extracted ${this.ccEvents.length} CC/pitchbend events`);

        // Log summary by type (compter dynamiquement)
        const typeCounts = {};
        this.ccEvents.forEach(e => {
            typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
        });
        const summary = Object.entries(typeCounts)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');
        if (summary) {
            this.log('info', `  - ${summary}`);
        }

        // Log des canaux utilisés
        const usedChannels = this.getCCChannelsUsed();
        if (usedChannels.length > 0) {
            this.log('info', `  - Canaux utilisés: ${usedChannels.map(c => c + 1).join(', ')}`);
        }
    }

    /**
     * Noms standards des CC MIDI (pour l'affichage des CC dynamiques)
     */
    static CC_NAMES = {
        0: 'Bank Select', 1: 'Modulation', 2: 'Breath', 3: 'Ctrl 3', 4: 'Foot',
        5: 'Portamento', 6: 'Data Entry', 7: 'Volume', 8: 'Balance', 9: 'Ctrl 9',
        10: 'Pan', 11: 'Expression', 12: 'FX Ctrl 1', 13: 'FX Ctrl 2',
        64: 'Sustain', 65: 'Portamento On', 66: 'Sostenuto', 67: 'Soft Pedal',
        68: 'Legato', 69: 'Hold 2', 70: 'Variation', 71: 'Resonance',
        72: 'Release', 73: 'Attack', 74: 'Brightness', 75: 'Decay',
        76: 'Vib Rate', 77: 'Vib Depth', 78: 'Vib Delay',
        84: 'Porta Ctrl', 91: 'Reverb', 92: 'Tremolo', 93: 'Chorus',
        94: 'Detune', 95: 'Phaser', 120: 'All Sound Off', 121: 'Reset All',
        123: 'All Notes Off'
    };

    /**
     * Mettre à jour les boutons CC dynamiques selon les CC présents dans le fichier
     * Ajoute des boutons pour les CC non couverts par les boutons statiques
     */
    updateDynamicCCButtons() {
        const dynamicContainer = this.container?.querySelector('#cc-dynamic-buttons');
        const dynamicGroup = this.container?.querySelector('.cc-dynamic-group');
        if (!dynamicContainer || !dynamicGroup) return;

        // CC couverts par les boutons statiques
        const staticCCs = new Set(['cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc76', 'cc77', 'cc78', 'cc91', 'pitchbend']);

        // Trouver les CC présents dans le fichier mais pas en statique
        const detectedCCs = new Set();
        this.ccEvents.forEach(e => {
            if (!staticCCs.has(e.type) && e.type.startsWith('cc')) {
                detectedCCs.add(e.type);
            }
        });

        // Vider les anciens boutons dynamiques
        dynamicContainer.innerHTML = '';

        if (detectedCCs.size === 0) {
            dynamicGroup.style.display = 'none';
            return;
        }

        // Afficher le groupe dynamique
        dynamicGroup.style.display = '';

        // Trier les CC détectés numériquement
        const sortedCCs = Array.from(detectedCCs).sort((a, b) => {
            return parseInt(a.replace('cc', '')) - parseInt(b.replace('cc', ''));
        });

        sortedCCs.forEach(ccType => {
            const ccNum = parseInt(ccType.replace('cc', ''));
            const ccName = MidiEditorModal.CC_NAMES[ccNum] || `Ctrl ${ccNum}`;
            const count = this.ccEvents.filter(e => e.type === ccType).length;

            const btn = document.createElement('button');
            btn.className = 'cc-type-btn dynamic';
            btn.dataset.ccType = ccType;
            btn.title = `${ccName} (${count} events)`;
            btn.textContent = `CC${ccNum}`;

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.selectCCType(ccType);
            });

            dynamicContainer.appendChild(btn);
        });

        this.log('info', `Added ${sortedCCs.length} dynamic CC buttons: ${sortedCCs.join(', ')}`);
    }

    /**
     * Basculer l'affichage d'un canal
     */
    toggleChannel(channel) {
        // Sauvegarder les canaux actuellement actifs AVANT le toggle
        const previousActiveChannels = new Set(this.activeChannels);

        if (this.activeChannels.has(channel)) {
            this.activeChannels.delete(channel);
        } else {
            this.activeChannels.add(channel);
        }

        this.log('info', `Toggled channel ${channel}. Active channels: [${Array.from(this.activeChannels).join(', ')}]`);

        this.updateSequenceFromActiveChannels(previousActiveChannels);
        this.updateChannelButtons();
        this.updateInstrumentSelector();

        // Mettre à jour le canal pour l'édition CC
        this.updateCCEditorChannel();

        // Synchroniser les canaux mutés avec le synthétiseur (pendant la lecture)
        this.syncMutedChannels();
    }

    /**
     * Mettre à jour la séquence depuis les canaux actifs
     * @param {Set} previousActiveChannels - Canaux qui étaient actifs AVANT le changement (optionnel)
     * @param {boolean} skipSync - Si true, ne pas synchroniser fullSequence (déjà fait)
     */
    updateSequenceFromActiveChannels(previousActiveChannels = null, skipSync = false) {
        // D'ABORD: synchroniser fullSequence avec le piano roll actuel
        // pour ne pas perdre les modifications
        // Passer les canaux précédents pour savoir quelles notes sont dans le piano roll
        if (!skipSync) {
            this.syncFullSequenceFromPianoRoll(previousActiveChannels);
        }

        if (this.activeChannels.size === 0) {
            this.sequence = [];
        } else {
            this.sequence = this.fullSequence.filter(note => this.activeChannels.has(note.c));
        }

        this.log('info', `Updated sequence: ${this.sequence.length} notes from ${this.activeChannels.size} active channel(s)`);

        // Mettre à jour le piano roll si il existe
        if (this.pianoRoll) {
            // Vider complètement la séquence du piano roll d'abord
            this.pianoRoll.sequence.length = 0;

            // Puis copier les nouvelles notes
            this.sequence.forEach(note => {
                this.pianoRoll.sequence.push({...note});
            });

            // S'assurer que les couleurs sont toujours définies
            this.pianoRoll.channelColors = this.channelColors;

            // Définir le canal par défaut pour les nouvelles notes (premier canal actif)
            if (this.activeChannels.size > 0) {
                this.pianoRoll.defaultChannel = Array.from(this.activeChannels)[0];
                this.log('debug', `Default channel for new notes: ${this.pianoRoll.defaultChannel}`);
            }

            // Forcer un redraw complet
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
                this.log('debug', `Piano roll redrawn after channel toggle: ${this.pianoRoll.sequence.length} notes visible`);
            }
        }
    }

    /**
     * Synchroniser fullSequence avec les notes actuelles du piano roll
     * pour ne pas perdre les modifications (suppressions, ajouts, etc.)
     * @param {Set} previousActiveChannels - Canaux qui étaient visibles dans le piano roll (optionnel)
     */
    syncFullSequenceFromPianoRoll(previousActiveChannels = null) {
        if (!this.pianoRoll || !this.pianoRoll.sequence) return;

        const currentSequence = this.pianoRoll.sequence;

        // Reconstruire fullSequence en fusionnant:
        // - Les notes des canaux actuellement visibles dans le piano roll (potentiellement modifiées)
        // - Les notes des canaux invisibles dans le piano roll (non modifiées)

        // 1. Utiliser previousActiveChannels (si fourni) ou this.activeChannels pour savoir
        //    quels canaux sont actuellement affichés dans le piano roll
        const visibleChannels = previousActiveChannels || this.activeChannels;

        // 2. Garder les notes des canaux qui ne sont PAS visibles dans le piano roll
        //    (Ces notes n'ont pas été touchées)
        const invisibleNotes = this.fullSequence.filter(note => !visibleChannels.has(note.c));

        // 3. Prendre TOUTES les notes du piano roll
        //    (Elles ont potentiellement des canaux modifiés via changeChannelSelection)
        const visibleNotes = currentSequence.map(note => ({
            t: note.t,
            g: note.g,
            n: note.n,
            c: note.c !== undefined ? note.c : Array.from(visibleChannels)[0] || 0, // Assurer que c existe
            v: note.v || 100 // Préserver velocity
        }));

        // 4. Fusionner
        this.fullSequence = [...invisibleNotes, ...visibleNotes];

        // 5. Trier par tick
        this.fullSequence.sort((a, b) => a.t - b.t);

        this.log('debug', `Synced fullSequence: ${invisibleNotes.length} invisible + ${visibleNotes.length} visible = ${this.fullSequence.length} total (using ${previousActiveChannels ? 'previous' : 'current'} active channels)`);
    }

    // ========================================================================
    // GESTION DU MODE CC/PITCHBEND
    // ========================================================================

    /**
     * Basculer l'état collapsed/expanded de la section CC
     */
    toggleCCSection() {
        this.ccSectionExpanded = !this.ccSectionExpanded;

        const ccSection = document.getElementById('cc-section');
        const ccContent = document.getElementById('cc-section-content');
        const ccHeader = document.getElementById('cc-section-header');
        const resizeBar = document.getElementById('cc-resize-btn');

        if (ccSection && ccContent && ccHeader) {
            if (this.ccSectionExpanded) {
                ccSection.classList.add('expanded');
                ccSection.classList.remove('collapsed');
                ccHeader.classList.add('expanded');
                ccHeader.classList.remove('collapsed');

                // Afficher la barre de resize
                if (resizeBar) {
                    resizeBar.classList.add('visible');
                    this.log('debug', 'Resize bar shown');
                }

                // Écouter la fin de la transition CSS
                const onTransitionEnd = (e) => {
                    // S'assurer que c'est bien la transition de la section CC
                    if (e.target !== ccSection) return;

                    ccSection.removeEventListener('transitionend', onTransitionEnd);

                    this.log('debug', 'CC Section transition ended');

                    // Initialiser l'éditeur CC s'il n'existe pas encore
                    if (!this.ccEditor) {
                        this.initCCEditor();
                    } else {
                        // L'éditeur existe déjà, attendre que le layout soit prêt puis redimensionner
                        this.waitForCCEditorLayout();
                    }
                };

                ccSection.addEventListener('transitionend', onTransitionEnd);

                // Fallback si pas de transition (déjà expanded, etc.)
                setTimeout(() => {
                    if (!this.ccEditor) {
                        this.initCCEditor();
                    }
                }, 400);
            } else {
                ccSection.classList.remove('expanded');
                ccSection.classList.add('collapsed');
                ccHeader.classList.remove('expanded');
                ccHeader.classList.add('collapsed');

                // Nettoyer les styles inline posés par le drag resize
                // pour que les classes CSS (flex, min-height) reprennent le contrôle
                ccSection.style.removeProperty('height');
                ccSection.style.removeProperty('flex');
                ccSection.style.removeProperty('min-height');

                const notesSection = this.container?.querySelector('.notes-section');
                if (notesSection) {
                    notesSection.style.removeProperty('height');
                    notesSection.style.removeProperty('flex');
                    notesSection.style.removeProperty('min-height');
                }

                // Cacher la barre de resize
                if (resizeBar) {
                    resizeBar.classList.remove('visible');
                    this.log('debug', 'Resize bar hidden');
                }

                // Redimensionner le piano roll pour occuper tout l'espace
                requestAnimationFrame(() => {
                    if (this.pianoRoll && typeof this.pianoRoll.redraw === 'function') {
                        this.pianoRoll.redraw();
                    }
                });
            }
        }

        this.log('info', `Section CC ${this.ccSectionExpanded ? 'expanded' : 'collapsed'}`);
    }

    /**
     * Sélectionner le type de CC/Velocity à éditer
     */
    selectCCType(ccType) {
        this.currentCCType = ccType;
        this.log('info', `Type sélectionné: ${ccType}`);

        // Mettre à jour les boutons
        const ccTypeButtons = this.container?.querySelectorAll('.cc-type-btn');
        ccTypeButtons?.forEach(btn => {
            if (btn.dataset.ccType === ccType) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        const ccEditorContainer = document.getElementById('cc-editor-container');
        const velocityEditorContainer = document.getElementById('velocity-editor-container');
        const tempoEditorContainer = document.getElementById('tempo-editor-container');

        if (ccType === 'tempo') {
            // Afficher l'éditeur de tempo
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'flex';

            // Initialiser l'éditeur de tempo s'il n'existe pas
            if (!this.tempoEditor) {
                this.initTempoEditor();
            } else {
                // Synchroniser avec le piano roll actuel
                this.syncTempoEditor();
                // Attendre que le layout soit recalculé avant de resize
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        if (this.tempoEditor && this.tempoEditor.resize) {
                            this.tempoEditor.resize();
                        }
                    });
                });
            }

            // Afficher les boutons de courbes pour tempo
            this.showCurveButtons();
        } else if (ccType === 'velocity') {
            // Afficher l'éditeur de vélocité
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'flex';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            // Initialiser l'éditeur de vélocité s'il n'existe pas
            if (!this.velocityEditor) {
                this.initVelocityEditor();
            } else {
                // Recharger la séquence complète (le filtrage par canal se fait dans l'éditeur)
                this.velocityEditor.setSequence(this.fullSequence);
                this.syncVelocityEditor();
                // Attendre que le layout soit recalculé avant de resize
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        if (this.velocityEditor && this.velocityEditor.resize) {
                            this.velocityEditor.resize();
                        }
                    });
                });
            }

            // Mettre à jour le sélecteur de canal pour la vélocité
            this.updateEditorChannelSelector();
            // Masquer les boutons de courbes
            this.hideCurveButtons();
        } else {
            // Afficher l'éditeur CC
            if (ccEditorContainer) ccEditorContainer.style.display = 'flex';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            // Initialiser l'éditeur CC s'il n'existe pas
            if (!this.ccEditor) {
                this.initCCEditor();
            } else {
                this.ccEditor.setCC(ccType);
                // Attendre que le layout soit recalculé avant de resize
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        if (this.ccEditor && this.ccEditor.resize) {
                            this.ccEditor.resize();
                        }
                    });
                });
                // Mettre à jour le sélecteur de canal car les canaux utilisés peuvent varier selon le type CC
                this.updateEditorChannelSelector();
            }

            // Masquer les boutons de courbes
            this.hideCurveButtons();
        }

        // Mettre à jour l'état du bouton de suppression après le changement de type
        this.updateDeleteButtonState();
    }

    /**
     * Mettre à jour le canal actif pour l'édition CC
     */
    updateCCEditorChannel() {
        if (!this.ccEditor) return;

        // Utiliser le premier canal actif comme canal pour l'édition CC
        const activeChannel = this.activeChannels.size > 0
            ? Array.from(this.activeChannels)[0]
            : 0;

        this.ccEditor.setChannel(activeChannel);
        this.log('info', `Canal CC mis à jour: ${activeChannel}`);
    }

    /**
     * Supprimer les éléments sélectionnés (CC/Velocity)
     */
    deleteSelectedCCVelocity() {
        if (this.currentCCType === 'tempo' && this.tempoEditor) {
            const selectedIds = Array.from(this.tempoEditor.selectedEvents);
            this.tempoEditor.removeEvents(selectedIds);
        } else if (this.currentCCType === 'velocity' && this.velocityEditor) {
            this.velocityEditor.deleteSelected();
        } else if (this.ccEditor) {
            this.ccEditor.deleteSelected();
        }

        // Mettre à jour l'état du bouton de suppression
        this.updateDeleteButtonState();
    }

    /**
     * Mettre à jour l'état du bouton de suppression
     */
    updateDeleteButtonState() {
        const deleteBtn = this.container?.querySelector('#cc-delete-btn');
        if (!deleteBtn) return;

        let hasSelection = false;
        if (this.currentCCType === 'tempo' && this.tempoEditor) {
            hasSelection = this.tempoEditor.selectedEvents.size > 0;
        } else if (this.currentCCType === 'velocity' && this.velocityEditor) {
            hasSelection = this.velocityEditor.selectedNotes.size > 0;
        } else if (this.ccEditor) {
            hasSelection = this.ccEditor.selectedEvents.size > 0;
        }

        deleteBtn.disabled = !hasSelection;
    }

    /**
     * Initialiser l'éditeur CC/Pitchbend
     */
    initCCEditor() {
        const container = document.getElementById('cc-editor-container');
        if (!container) {
            this.log('warn', 'Container cc-editor-container not found');
            return;
        }

        if (this.ccEditor) {
            this.log('info', 'CC Editor already initialized');
            return;
        }

        this.log('info', `Initializing CC Editor with ${this.ccEvents.length} total CC events`);

        // Obtenir les paramètres du piano roll
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            onChange: () => {
                // Marquer comme modifié lors des changements CC/Pitchbend
                this.isDirty = true;
                this.updateSaveButton();
            }
        };

        // Créer l'éditeur
        this.ccEditor = new CCPitchbendEditor(container, options);
        this.ccEditor.setCC(this.currentCCType);

        // Charger les événements existants AVANT de mettre à jour le sélecteur
        if (this.ccEvents.length > 0) {
            this.ccEditor.loadEvents(this.ccEvents);
            this.log('info', `Loaded ${this.ccEvents.length} CC events into editor`);
        }

        // Mettre à jour le sélecteur de canal pour afficher uniquement les canaux utilisés
        this.updateCCChannelSelector();

        // Obtenir le canal actif (premier canal utilisé pour ce type, sinon premier canal avec CC/PB)
        const usedChannels = this.getCCChannelsUsed();
        const allChannels = this.getAllCCChannels();
        const activeChannel = usedChannels.length > 0 ? usedChannels[0] : (allChannels.length > 0 ? allChannels[0] : 0);
        this.ccEditor.setChannel(activeChannel);

        this.log('info', `CC Editor initialized - Type: ${this.currentCCType}, Channel: ${activeChannel + 1}, Type channels: [${usedChannels.map(c => c + 1).join(', ')}], All CC channels: [${allChannels.map(c => c + 1).join(', ')}]`);

        // Ajouter un écouteur pour mettre à jour le bouton de suppression lors des interactions
        container.addEventListener('mouseup', () => {
            // Utiliser setTimeout pour laisser la sélection se mettre à jour d'abord
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

        // Attendre que le layout flex soit complètement calculé avant de resize
        // Utiliser requestAnimationFrame en boucle jusqu'à ce que l'élément ait une hauteur valide
        this.waitForCCEditorLayout();
    }

    /**
     * Attendre que l'éditeur CC ait une hauteur valide avant de le redimensionner
     */
    waitForCCEditorLayout(attempts = 0, maxAttempts = 60) {
        if (!this.ccEditor || !this.ccEditor.element) {
            this.log('warn', 'waitForCCEditorLayout: ccEditor or element not found');
            return;
        }

        const height = this.ccEditor.element.getBoundingClientRect().height;
        this.log('debug', `waitForCCEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
            // Le layout est prêt, on peut resize
            this.ccEditor.resize();
            this.log('info', `CC Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
            // Le layout n'est pas encore prêt, réessayer au prochain frame
            requestAnimationFrame(() => {
                this.waitForCCEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.log('error', `waitForCCEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
     * Synchroniser l'éditeur CC avec le piano roll
     */
    syncCCEditor() {
        if (!this.ccEditor || !this.pianoRoll) return;

        this.ccEditor.syncWith({
            xrange: this.pianoRoll.xrange,
            xoffset: this.pianoRoll.xoffset,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            timebase: this.pianoRoll.timebase
        });
    }

    /**
     * Synchroniser tous les éditeurs (CC et Velocity) avec le piano roll
     */
    syncAllEditors() {
        this.syncCCEditor();
        this.syncVelocityEditor();
    }

    /**
     * Synchroniser les événements depuis l'éditeur CC vers this.ccEvents
     * Appelé avant la sauvegarde pour récupérer les modifications
     */
    syncCCEventsFromEditor() {
        if (!this.ccEditor) {
            // Si l'éditeur CC n'a jamais été ouvert, garder les événements extraits du fichier original
            this.log('info', `syncCCEventsFromEditor: CC editor not initialized, keeping ${this.ccEvents.length} original events`);
            return;
        }

        // Récupérer tous les événements depuis l'éditeur
        const editorEvents = this.ccEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            this.log('info', 'syncCCEventsFromEditor: No CC events in editor');
            this.ccEvents = [];
            return;
        }

        // Les événements de l'éditeur sont déjà au bon format
        // { type: 'cc1'|'cc7'|'cc10'|'cc11'|'pitchbend', ticks: number, value: number, channel: number }
        this.ccEvents = editorEvents.map(e => ({
            type: e.type,
            ticks: e.ticks,
            channel: e.channel,
            value: e.value,
            id: e.id
        }));

        this.log('info', `Synchronized ${this.ccEvents.length} CC/pitchbend events from editor`);

        // Log d'échantillon pour debugging
        if (this.ccEvents.length > 0) {
            const sample = this.ccEvents.slice(0, 3);
            this.log('debug', 'Sample synchronized events:', sample);
        }
    }

    /**
     * Synchroniser les événements de tempo depuis l'éditeur de tempo
     */
    syncTempoEventsFromEditor() {
        if (!this.tempoEditor) {
            this.log('info', `syncTempoEventsFromEditor: Tempo editor not initialized, keeping ${this.tempoEvents.length} original events`);
            return;
        }

        const editorEvents = this.tempoEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            this.log('info', 'syncTempoEventsFromEditor: No tempo events in editor');
            this.tempoEvents = [];
            return;
        }

        this.tempoEvents = editorEvents.map(e => ({
            ticks: e.ticks,
            tempo: e.tempo,
            id: e.id
        }));

        // Mettre à jour le tempo global avec le premier événement
        if (this.tempoEvents.length > 0) {
            this.tempo = this.tempoEvents[0].tempo;
        }

        this.log('info', `Synchronized ${this.tempoEvents.length} tempo events from editor`);
    }

    /**
     * Initialiser l'éditeur de vélocité
     */
    initVelocityEditor() {
        const container = document.getElementById('velocity-editor-container');
        if (!container) {
            this.log('warn', 'Container velocity-editor-container not found');
            return;
        }

        if (this.velocityEditor) {
            this.log('info', 'Velocity Editor already initialized');
            return;
        }

        this.log('info', `Initializing Velocity Editor with ${this.sequence.length} notes`);

        // Obtenir les paramètres du piano roll
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            onChange: (sequence) => {
                // Marquer comme modifié lors des changements de vélocité
                this.isDirty = true;
                this.updateSaveButton();
                // Synchroniser vers fullSequence et sequence
                this.syncSequenceFromVelocityEditor(sequence);
            }
        };

        // Créer l'éditeur
        this.velocityEditor = new VelocityEditor(container, options);

        // Charger la séquence complète (non filtrée) pour la vélocité
        this.velocityEditor.setSequence(this.fullSequence);

        // Définir le premier canal utilisé comme canal actif par défaut
        const firstChannel = this.channels.length > 0 ? this.channels[0].channel : 0;
        this.velocityEditor.setChannel(firstChannel);

        this.log('info', `Velocity Editor initialized with ${this.fullSequence.length} notes, default channel: ${firstChannel + 1}`);

        // Mettre à jour le sélecteur de canal
        this.updateEditorChannelSelector();

        // Ajouter un écouteur pour mettre à jour le bouton de suppression lors des interactions
        container.addEventListener('mouseup', () => {
            // Utiliser setTimeout pour laisser la sélection se mettre à jour d'abord
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

        // Attendre que le layout soit prêt
        this.waitForVelocityEditorLayout();
    }

    /**
     * Attendre que l'éditeur de vélocité ait une hauteur valide
     */
    waitForVelocityEditorLayout(attempts = 0, maxAttempts = 60) {
        if (!this.velocityEditor || !this.velocityEditor.element) {
            this.log('warn', 'waitForVelocityEditorLayout: velocityEditor or element not found');
            return;
        }

        const height = this.velocityEditor.element.getBoundingClientRect().height;
        this.log('debug', `waitForVelocityEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
            // Le layout est prêt, on peut resize
            this.velocityEditor.resize();
            this.log('info', `Velocity Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
            // Le layout n'est pas encore prêt, réessayer au prochain frame
            requestAnimationFrame(() => {
                this.waitForVelocityEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.log('error', `waitForVelocityEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
     * Initialiser l'éditeur de tempo
     */
    initTempoEditor() {
        const container = document.getElementById('tempo-editor-container');
        if (!container) {
            this.log('warn', 'Container tempo-editor-container not found');
            return;
        }

        if (this.tempoEditor) {
            this.log('info', 'Tempo Editor already initialized');
            return;
        }

        this.log('info', 'Initializing Tempo Editor');

        // Obtenir les paramètres du piano roll
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            minTempo: 20,
            maxTempo: 300,
            onChange: () => {
                // Marquer comme modifié lors des changements de tempo
                this.isDirty = true;
                this.updateSaveButton();
            }
        };

        // Créer l'éditeur
        this.tempoEditor = new TempoEditor(container, options);

        // Charger les événements de tempo existants
        this.tempoEditor.setEvents(this.tempoEvents);

        this.log('info', `Tempo Editor initialized with ${this.tempoEvents.length} events`);

        // Attendre que le layout soit prêt
        this.waitForTempoEditorLayout();
    }

    /**
     * Attendre que l'éditeur de tempo ait une hauteur valide
     */
    waitForTempoEditorLayout(attempts = 0, maxAttempts = 60) {
        if (!this.tempoEditor || !this.tempoEditor.element) {
            this.log('warn', 'waitForTempoEditorLayout: tempoEditor or element not found');
            return;
        }

        const height = this.tempoEditor.element.getBoundingClientRect().height;
        this.log('debug', `waitForTempoEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
            // Le layout est prêt, on peut resize
            this.tempoEditor.resize();
            this.log('info', `Tempo Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
            // Le layout n'est pas encore prêt, réessayer au prochain frame
            requestAnimationFrame(() => {
                this.waitForTempoEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.log('error', `waitForTempoEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
     * Synchroniser l'éditeur de tempo avec le piano roll
     */
    syncTempoEditor() {
        if (!this.tempoEditor || !this.pianoRoll) return;

        this.tempoEditor.setXRange(this.pianoRoll.xrange);
        this.tempoEditor.setXOffset(this.pianoRoll.xoffset);
        this.tempoEditor.setGrid(this.snapValues[this.currentSnapIndex].ticks);
    }

    /**
     * Afficher les boutons de courbes
     */
    showCurveButtons() {
        // Créer les boutons s'ils n'existent pas (une seule fois)
        let curveSection = this.container.querySelector('.curve-section');
        if (!curveSection) {
            // Trouver la toolbar
            const toolbar = this.container.querySelector('.cc-type-toolbar');
            if (!toolbar) return;

            // Créer la section de boutons de courbes
            const curveHTML = `
                <div class="cc-toolbar-divider"></div>
                <div class="curve-section">
                    <label class="cc-toolbar-label">${this.t('midiEditor.curveType')}</label>
                    <div class="cc-curve-buttons-horizontal">
                        <button class="cc-curve-btn active" data-curve="linear" title="Linear">━</button>
                        <button class="cc-curve-btn" data-curve="exponential" title="Exponential (Ease-in)">⌃</button>
                        <button class="cc-curve-btn" data-curve="logarithmic" title="Logarithmic (Ease-out)">⌄</button>
                        <button class="cc-curve-btn" data-curve="sine" title="Sine (Ease-in-out)">∿</button>
                    </div>
                </div>
            `;

            // Insérer avant le divider qui précède le bouton de suppression
            const deleteBtn = this.container.querySelector('#cc-delete-btn');
            if (deleteBtn && deleteBtn.previousElementSibling) {
                deleteBtn.previousElementSibling.insertAdjacentHTML('beforebegin', curveHTML);

                // Attacher les événements
                const ccCurveButtons = this.container.querySelectorAll('.cc-curve-btn');
                ccCurveButtons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const curveType = btn.dataset.curve;
                        if (curveType && this.tempoEditor) {
                            // Désactiver tous les boutons
                            ccCurveButtons.forEach(b => b.classList.remove('active'));
                            // Activer le bouton cliqué
                            btn.classList.add('active');
                            // Changer le type de courbe
                            this.tempoEditor.setCurveType(curveType);
                        }
                    });
                });
            }
        } else {
            // Les boutons existent déjà, les afficher
            curveSection.style.display = 'flex';
            curveSection.previousElementSibling.style.display = 'block'; // divider
        }
    }

    /**
     * Masquer les boutons de courbes
     */
    hideCurveButtons() {
        const curveSection = this.container.querySelector('.curve-section');
        if (curveSection) {
            curveSection.style.display = 'none';
            if (curveSection.previousElementSibling && curveSection.previousElementSibling.classList.contains('cc-toolbar-divider')) {
                curveSection.previousElementSibling.style.display = 'none';
            }
        }
    }

    /**
     * Synchroniser l'éditeur de vélocité avec le piano roll
     */
    syncVelocityEditor() {
        if (!this.velocityEditor || !this.pianoRoll) return;

        this.velocityEditor.syncWith({
            xrange: this.pianoRoll.xrange,
            xoffset: this.pianoRoll.xoffset,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            timebase: this.pianoRoll.timebase
        });
    }

    /**
     * Synchroniser la séquence depuis l'éditeur de vélocité
     */
    syncSequenceFromVelocityEditor(velocitySequence) {
        if (!velocitySequence) return;

        // Mettre à jour fullSequence et sequence avec les nouvelles vélocités
        this.fullSequence.forEach(note => {
            const velocityNote = velocitySequence.find(vn =>
                vn.t === note.t && vn.n === note.n && vn.c === note.c
            );
            if (velocityNote) {
                note.v = velocityNote.v || 100;
            }
        });

        // Reconstruire la sequence filtrée
        this.sequence = this.fullSequence.filter(note => this.activeChannels.has(note.c));

        // Mettre à jour le piano roll
        if (this.pianoRoll) {
            this.pianoRoll.sequence = this.sequence;
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
        }

        this.log('debug', 'Synchronized velocities from velocity editor to sequence');
    }

    /**
     * Mettre à jour la liste des canaux basée sur fullSequence
     */
    updateChannelsFromSequence() {
        const channelNoteCount = new Map();
        const channelPrograms = new Map();

        // Compter les notes par canal et préserver les programmes existants
        this.fullSequence.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

            // Trouver le programme pour ce canal (depuis this.channels existants)
            if (!channelPrograms.has(channel)) {
                const existingChannel = this.channels.find(ch => ch.channel === channel);
                if (existingChannel) {
                    channelPrograms.set(channel, existingChannel.program);
                } else {
                    // Nouveau canal : utiliser l'instrument sélectionné
                    channelPrograms.set(channel, this.selectedInstrument || 0);
                }
            }
        });

        // Reconstruire this.channels
        this.channels = [];
        channelNoteCount.forEach((count, channel) => {
            const program = channelPrograms.get(channel) || 0;
            const instrumentName = channel === 9 ? this.t('midiEditor.drumKit') : this.getInstrumentName(program);

            this.channels.push({
                channel: channel,
                program: program,
                instrument: instrumentName,
                noteCount: count
            });
        });

        // Trier par numéro de canal
        this.channels.sort((a, b) => a.channel - b.channel);

        this.log('debug', `Updated channels: ${this.channels.length} channels found`);
    }

    /**
     * Éclaircir/éclairer une couleur hexadécimale pour la rendre plus éclatante
     */
    brightenColor(color, percent) {
        const num = parseInt(color.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.min(255, (num >> 16) + amt);
        const G = Math.min(255, (num >> 8 & 0x00FF) + amt);
        const B = Math.min(255, (num & 0x0000FF) + amt);
        return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
    }

    /**
     * Convertir la sequence en données MIDI pour le backend
     * Format compatible avec la bibliothèque 'midi-file'
     */
    convertSequenceToMidi() {
        // Utiliser fullSequence qui contient toutes les notes à jour
        const fullSequenceToSave = this.fullSequence;

        if (!fullSequenceToSave || fullSequenceToSave.length === 0) {
            this.log('warn', 'No sequence to convert');
            return null;
        }

        const ticksPerBeat = this.midiData?.header?.ticksPerBeat || 480;

        this.log('info', `Converting ${fullSequenceToSave.length} notes to MIDI`);

        // Convertir la sequence en événements MIDI
        const events = [];

        // Ajouter les événements de tempo (tempo map complète ou tempo global)
        if (this.tempoEvents && this.tempoEvents.length > 0) {
            this.tempoEvents.forEach(tempoEvent => {
                const usPerBeat = Math.round(60000000 / tempoEvent.tempo);
                events.push({
                    absoluteTime: tempoEvent.ticks,
                    type: 'setTempo',
                    microsecondsPerBeat: usPerBeat
                });
            });
            this.log('debug', `Added ${this.tempoEvents.length} tempo events from tempo map`);
        } else {
            // Fallback: tempo global unique
            const tempo = this.tempo || 120;
            const microsecondsPerBeat = Math.round(60000000 / tempo);
            events.push({
                absoluteTime: 0,
                type: 'setTempo',
                microsecondsPerBeat: microsecondsPerBeat
            });
            this.log('debug', `Added single tempo event: ${tempo} BPM (${microsecondsPerBeat} μs/beat)`);
        }

        // Déterminer quels canaux sont utilisés et leurs instruments
        const usedChannels = new Map(); // canal -> program
        fullSequenceToSave.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            if (!usedChannels.has(channel)) {
                // Trouver l'instrument pour ce canal
                const channelInfo = this.channels.find(ch => ch.channel === channel);
                const program = channelInfo ? channelInfo.program : this.selectedInstrument || 0;
                usedChannels.set(channel, program);
            }
        });

        // Ajouter les événements programChange au début (tick 0) pour chaque canal
        usedChannels.forEach((program, channel) => {
            if (channel !== 9) { // Canal 10 (index 9) est pour drums, pas de programChange
                events.push({
                    absoluteTime: 0,
                    type: 'programChange',
                    channel: channel,
                    programNumber: program
                });
                this.log('debug', `Added programChange for channel ${channel}: ${this.getInstrumentName(program)}`);
            }
        });

        // Ajouter les événements de note
        fullSequenceToSave.forEach(note => {
            const tick = note.t;
            const noteNumber = note.n;
            const gate = note.g;
            const channel = note.c !== undefined ? note.c : 0;
            const velocity = note.v || 100; // velocity par défaut si non présente

            // Note On
            events.push({
                absoluteTime: tick,
                type: 'noteOn',
                channel: channel,
                noteNumber: noteNumber,
                velocity: velocity
            });

            // Note Off
            events.push({
                absoluteTime: tick + gate,
                type: 'noteOff',
                channel: channel,
                noteNumber: noteNumber,
                velocity: 0
            });
        });

        // Ajouter les événements CC et pitchbend
        if (this.ccEvents && this.ccEvents.length > 0) {
            this.log('info', `Adding ${this.ccEvents.length} CC/pitchbend events to MIDI file`);

            let ccCount = 0, pbCount = 0;
            this.ccEvents.forEach(ccEvent => {
                // Convertir le type de l'éditeur (cc1, cc2, cc5, cc7, cc10, cc11, cc74) en numéro de contrôleur
                if (ccEvent.type.startsWith('cc')) {
                    // Extraire le numéro du type (cc1 -> 1, cc7 -> 7, etc.)
                    const controllerNumber = parseInt(ccEvent.type.replace('cc', ''));
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'controller',
                        channel: ccEvent.channel,
                        controllerType: controllerNumber,
                        value: ccEvent.value
                    });
                    ccCount++;
                } else if (ccEvent.type === 'pitchbend') {
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'pitchBend',
                        channel: ccEvent.channel,
                        value: ccEvent.value
                    });
                    pbCount++;
                }
            });

            this.log('info', `Converted to MIDI: ${ccCount} CC events, ${pbCount} pitchbend events`);
        } else {
            this.log('warn', 'No CC/Pitchbend events to save');
        }

        // Trier par temps absolu
        events.sort((a, b) => a.absoluteTime - b.absoluteTime);

        // Convertir temps absolu en deltaTime
        let lastTime = 0;
        const trackEvents = events.map(event => {
            const deltaTime = event.absoluteTime - lastTime;
            lastTime = event.absoluteTime;

            const trackEvent = {
                deltaTime: deltaTime,
                type: event.type,
                channel: event.channel
            };

            // Ajouter les champs spécifiques selon le type d'événement
            if (event.type === 'programChange') {
                trackEvent.programNumber = event.programNumber;
            } else if (event.type === 'noteOn' || event.type === 'noteOff') {
                trackEvent.noteNumber = event.noteNumber;
                trackEvent.velocity = event.velocity;
            } else if (event.type === 'controller') {
                trackEvent.controllerType = event.controllerType;
                trackEvent.value = event.value;
            } else if (event.type === 'pitchBend') {
                trackEvent.value = event.value;
            } else if (event.type === 'setTempo') {
                trackEvent.microsecondsPerBeat = event.microsecondsPerBeat;
                // Les événements setTempo n'ont pas de channel
                delete trackEvent.channel;
            }

            return trackEvent;
        });

        // Ajouter End of Track
        trackEvents.push({
            deltaTime: 0,
            type: 'endOfTrack'
        });

        // Structure MIDI compatible avec midi-file
        return {
            header: {
                format: this.midiData?.header?.format || 1,
                numTracks: 1,
                ticksPerBeat: ticksPerBeat
            },
            tracks: [trackEvents]
        };
    }

    /**
     * Sauvegarder le fichier MIDI
     */
    async saveMidiFile() {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.log('info', `Saving MIDI file: ${this.currentFile}`);

            // Synchroniser fullSequence avec le piano roll actuel (gère les canaux, ajouts, suppressions, etc.)
            this.syncFullSequenceFromPianoRoll();

            // Synchroniser les événements CC/Pitchbend depuis l'éditeur
            this.syncCCEventsFromEditor();

            // Synchroniser les événements de tempo depuis l'éditeur
            this.syncTempoEventsFromEditor();

            // Mettre à jour la liste des canaux pour refléter la séquence actuelle
            this.updateChannelsFromSequence();

            this.log('info', `Saving ${this.fullSequence.length} notes across ${this.channels.length} channels`);

            // Convertir en format MIDI
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Échec de conversion en format MIDI');
            }

            this.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

            // Envoyer au backend
            const response = await this.api.writeMidiFile(this.currentFile, midiData);

            if (response && response.success) {
                this.isDirty = false;
                this.updateSaveButton();
                this.showNotification(this.t('midiEditor.saveSuccess'), 'success');

                // Émettre événement
                if (this.eventBus) {
                    this.eventBus.emit('midi_editor:saved', {
                        filePath: this.currentFile
                    });
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            this.log('error', 'Failed to save MIDI file:', error);
            this.showError(`${this.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    /**
     * Show Save As dialog to save the file with a new name
     */
    showSaveAsDialog() {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save as: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

        // Extract current name without extension
        const currentName = this.currentFilename || this.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

        // Create the Save As dialog
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>📄 ${this.t('midiEditor.saveAs')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <p>${this.t('midiEditor.saveAsDescription')}</p>
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.t('common.save')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

        // Select name without extension for easy editing
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);

        // Cancel
        cancelBtn.addEventListener('click', () => {
            dialog.remove();
        });

        // Confirm - Save As
        confirmBtn.addEventListener('click', async () => {
            const newBaseName = input.value.trim();
            if (!newBaseName) {
                this.showError(this.t('midiEditor.emptyFilename'));
                return;
            }

            const newFilename = newBaseName + extension;
            dialog.remove();

            // Call saveAsFile with the new filename
            await this.saveAsFile(newFilename);
        });

        // Enter to confirm
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            } else if (e.key === 'Escape') {
                cancelBtn.click();
            }
        });

        // Click outside to cancel
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }

    /**
     * Save the current file with a new name (export)
     */
    async saveAsFile(newFilename) {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save as: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.log('info', `Saving MIDI file as: ${newFilename}`);

            // Synchronize data from piano roll
            this.syncFullSequenceFromPianoRoll();
            this.syncCCEventsFromEditor();
            this.updateChannelsFromSequence();

            this.log('info', `Saving ${this.fullSequence.length} notes across ${this.channels.length} channels`);

            // Convert to MIDI format
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Failed to convert to MIDI format');
            }

            this.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

            // Send to backend with new filename
            const response = await this.api.sendCommand('file_save_as', {
                fileId: this.currentFile,
                newFilename: newFilename,
                midiData: midiData
            });

            if (response && response.success) {
                this.showNotification(
                    this.t('midiEditor.saveAsSuccess', { filename: newFilename }),
                    'success'
                );

                // Emit event
                if (this.eventBus) {
                    this.eventBus.emit('midi_editor:saved_as', {
                        originalFile: this.currentFile,
                        newFile: response.newFileId,
                        newFilename: newFilename
                    });
                }

                // Optionally reload file list in parent
                if (window.loadFiles) {
                    window.loadFiles();
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            this.log('error', 'Failed to save file as:', error);
            this.showError(`${this.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    /**
     * Show auto-assignment modal
     */
    async showAutoAssignModal() {
        // Check if current file is loaded
        if (!this.currentFile) {
            this.showErrorModal(this.t('midiEditor.noFileLoaded'));
            return;
        }

        // If AutoAssignModal not available, try to load it dynamically
        if (!window.AutoAssignModal) {
            this.log('warn', 'AutoAssignModal not found on window, attempting dynamic load...');
            try {
                await this.loadScript('js/views/components/AutoAssignModal.js');
            } catch (e) {
                this.log('error', 'Failed to dynamically load AutoAssignModal:', e);
            }
        }

        if (!window.AutoAssignModal) {
            this.showErrorModal(this.t('autoAssign.componentNotLoaded'));
            return;
        }

        const modal = new window.AutoAssignModal(this.api, this);
        modal.show(this.currentFile);
    }

    /**
     * Dynamically load a script if not already loaded
     * @param {string} src - Script path relative to root
     * @returns {Promise<void>}
     */
    loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                // Script tag exists but maybe failed - remove and reload
                existing.remove();
            }
            const script = document.createElement('script');
            script.src = src + '?v=' + Date.now();
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
     * Afficher la boîte de dialogue pour renommer le fichier
     */
    showRenameDialog() {
        // Extraire le nom sans extension
        const currentName = this.currentFilename || this.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

        // Créer le dialogue de renommage (modal centré)
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>✏️ ${this.t('midiEditor.renameFile')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.t('common.save')}</button>
                </div>
            </div>
        `;

        // Ajouter au body pour être au premier plan de tout
        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

        // Focus et sélection du texte
        input.focus();
        input.select();

        // Fonction de fermeture
        const closeDialog = () => {
            dialog.remove();
        };

        // Fonction de validation
        const confirmRename = async () => {
            const newName = input.value.trim();
            if (!newName) {
                this.showError(this.t('midiEditor.renameEmpty'));
                return;
            }

            const newFilename = newName + extension;

            try {
                // Appeler l'API pour renommer le fichier
                const response = await this.api.sendCommand('file_rename', {
                    fileId: this.currentFile,
                    newFilename: newFilename
                });

                if (response && response.success) {
                    // Mettre à jour le nom affiché
                    this.currentFilename = newFilename;
                    const fileNameSpan = this.container.querySelector('#editor-file-name');
                    if (fileNameSpan) {
                        fileNameSpan.textContent = newFilename;
                    }

                    this.showNotification(this.t('midiEditor.renameSuccess'), 'success');

                    // Émettre événement pour rafraîchir la liste des fichiers
                    if (this.eventBus) {
                        this.eventBus.emit('midi_editor:file_renamed', {
                            fileId: this.currentFile,
                            oldFilename: currentName,
                            newFilename: newFilename
                        });
                    }
                } else {
                    throw new Error(response?.error || 'Rename failed');
                }
            } catch (error) {
                this.log('error', 'Failed to rename file:', error);
                this.showError(`${this.t('midiEditor.renameFailed')}: ${error.message}`);
            }

            closeDialog();
        };

        // Événements
        cancelBtn.addEventListener('click', closeDialog);
        confirmBtn.addEventListener('click', confirmRename);
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) closeDialog();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmRename();
            if (e.key === 'Escape') closeDialog();
        });
    }

    // ========================================================================
    // RENDU
    // ========================================================================

    /**
     * Générer les boutons de canal
     */
    renderChannelButtons() {
        if (!this.channels || this.channels.length === 0) {
            return `<div class="channel-buttons"><span>${this.t('midiEditor.noActiveChannel')}</span></div>`;
        }

        let buttons = '<div class="channel-buttons">';

        // Boutons pour chaque canal
        this.channels.forEach(ch => {
            const isActive = this.activeChannels.has(ch.channel);
            const color = this.channelColors[ch.channel % this.channelColors.length];
            const activeClass = isActive ? 'active' : '';

            // Générer les styles inline directement (sans lueur)
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
                    title="${ch.noteCount} notes - Canal ${ch.channel + 1}"
                >
                    <span class="channel-label">${ch.channel + 1} : ${ch.instrument}</span>
                </button>
            `;
        });

        buttons += '</div>';
        return buttons;
    }

    /**
     * Rendre les options du sélecteur de canal
     */
    renderChannelOptions() {
        let options = '';
        for (let i = 0; i < 16; i++) {
            const instrumentName = i === 9 ? this.t('midiEditor.drumKit') : this.getInstrumentName(0);
            options += `<option value="${i}">Canal ${i + 1}${i === 9 ? ' (Drums)' : ''}</option>`;
        }
        return options;
    }

    /**
     * Rendre les options d'instruments MIDI GM
     */
    renderInstrumentOptions() {
        let options = '';

        // Groupes d'instruments MIDI GM
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
            const categoryName = this.t(`instruments.categories.${group.key}`);
            options += `<optgroup label="${categoryName}">`;
            for (let i = 0; i < group.count; i++) {
                const program = group.start + i;
                const instrument = this.getInstrumentName(program);
                options += `<option value="${program}">${program}: ${instrument}</option>`;
            }
            options += `</optgroup>`;
        });

        return options;
    }

    /**
     * Mettre à jour le sélecteur d'instrument selon les canaux actifs
     */
    updateInstrumentSelector() {
        const instrumentSelector = document.getElementById('instrument-selector');
        const instrumentLabel = document.getElementById('instrument-label');
        const applyBtn = document.getElementById('apply-instrument-btn');

        if (!instrumentSelector) return;

        if (this.activeChannels.size === 0) {
            // Aucun canal actif : afficher "Instrument:" et désactiver
            if (instrumentLabel) instrumentLabel.textContent = this.t('midiEditor.instrument');
            if (applyBtn) applyBtn.disabled = true;
        } else if (this.activeChannels.size === 1) {
            // Un seul canal actif : on peut modifier son instrument
            const activeChannel = Array.from(this.activeChannels)[0];
            const channelInfo = this.channels.find(ch => ch.channel === activeChannel);

            if (channelInfo) {
                // Mettre à jour le label pour indiquer quel canal sera modifié
                if (instrumentLabel) {
                    instrumentLabel.textContent = `${this.t('midiEditor.instrument')} ${this.t('midiEditor.channelTip', { channel: activeChannel + 1 })}`;
                    instrumentLabel.title = '';
                }

                // Mettre à jour le sélecteur pour afficher l'instrument actuel
                instrumentSelector.value = channelInfo.program.toString();

                // Activer le bouton
                if (applyBtn) {
                    applyBtn.disabled = false;
                    applyBtn.title = this.t('midiEditor.applyInstrument');
                }
            }
        } else {
            // Plusieurs canaux actifs : désactiver le bouton et afficher un message clair
            const firstActiveChannel = Array.from(this.activeChannels)[0];
            const channelInfo = this.channels.find(ch => ch.channel === firstActiveChannel);

            if (instrumentLabel) {
                instrumentLabel.textContent = this.t('midiEditor.multipleChannels', { count: this.activeChannels.size });
                instrumentLabel.title = this.t('midiEditor.multipleChannelsTip');
            }

            // Afficher l'instrument du premier canal actif
            if (channelInfo) {
                instrumentSelector.value = channelInfo.program.toString();
            }

            // Désactiver le bouton car plusieurs canaux actifs
            if (applyBtn) {
                applyBtn.disabled = true;
                applyBtn.title = this.t('midiEditor.singleChannelRequired');
            }
        }
    }

    // ========================================================================
    // GESTION DES INSTRUMENTS CONNECTÉS (pour visualiser les notes jouables)
    // ========================================================================

    /**
     * Charger la liste des instruments MIDI connectés
     */
    async loadConnectedDevices() {
        try {
            const result = await this.api.sendCommand('device_list');
            if (result && result.devices) {
                // Filtrer uniquement les appareils qui ont une sortie (output: true)
                this.connectedDevices = result.devices.filter(d => d.output === true);
                this.log('info', `Loaded ${this.connectedDevices.length} connected output devices`);
                this.updateConnectedDeviceSelector();
            }
        } catch (error) {
            this.log('error', 'Failed to load connected devices:', error);
            this.connectedDevices = [];
        }
    }

    /**
     * Mettre à jour le sélecteur d'instruments connectés
     */
    updateConnectedDeviceSelector() {
        const selector = document.getElementById('connected-device-selector');
        if (!selector) return;

        // Générer les options
        let options = `<option value="">${this.t('midiEditor.noDeviceFilter')}</option>`;

        this.connectedDevices.forEach(device => {
            const selected = this.selectedConnectedDevice === device.id ? 'selected' : '';
            // Utiliser displayName (nom personnalisé) s'il existe, sinon le nom par défaut
            const name = device.displayName || device.name || device.id;
            options += `<option value="${device.id}" ${selected}>${name}</option>`;
        });

        selector.innerHTML = options;
    }

    /**
     * Sélectionner un instrument connecté et charger ses capacités
     */
    async selectConnectedDevice(deviceId) {
        this.selectedConnectedDevice = deviceId || null;

        if (!deviceId) {
            // Aucun appareil sélectionné : pas de filtre de notes
            this.selectedDeviceCapabilities = null;
            this.playableNotes = null;
            this.updatePianoRollPlayableNotes();
            this.log('info', 'No device selected - showing all notes as playable');
            return;
        }

        try {
            // Récupérer les capacités de l'instrument
            const response = await this.api.sendCommand('instrument_get_capabilities', {
                deviceId: deviceId
            });

            if (response && response.capabilities) {
                this.selectedDeviceCapabilities = response.capabilities;
                this.calculatePlayableNotes();
                this.updatePianoRollPlayableNotes();
                this.log('info', `Loaded capabilities for device ${deviceId}:`, this.selectedDeviceCapabilities);
            } else {
                // Pas de capacités définies : toutes les notes sont jouables
                this.selectedDeviceCapabilities = null;
                this.playableNotes = null;
                this.updatePianoRollPlayableNotes();
                this.log('info', `No capabilities defined for device ${deviceId}`);
            }
        } catch (error) {
            this.log('error', `Failed to load capabilities for device ${deviceId}:`, error);
            this.selectedDeviceCapabilities = null;
            this.playableNotes = null;
            this.updatePianoRollPlayableNotes();
        }
    }

    /**
     * Calculer l'ensemble des notes jouables à partir des capacités
     */
    calculatePlayableNotes() {
        if (!this.selectedDeviceCapabilities) {
            this.playableNotes = null;
            return;
        }

        const caps = this.selectedDeviceCapabilities;
        const mode = caps.note_selection_mode || 'range';

        if (mode === 'discrete' && caps.selected_notes && Array.isArray(caps.selected_notes)) {
            // Mode discret : notes spécifiques (ex: pads de batterie)
            this.playableNotes = new Set(caps.selected_notes.map(n => parseInt(n)));
            this.log('info', `Discrete mode: ${this.playableNotes.size} playable notes`);
        } else if (mode === 'range') {
            // Mode range : plage de notes (min-max)
            const minNote = caps.note_range_min !== null && caps.note_range_min !== undefined
                ? parseInt(caps.note_range_min) : 0;
            const maxNote = caps.note_range_max !== null && caps.note_range_max !== undefined
                ? parseInt(caps.note_range_max) : 127;

            if (minNote === 0 && maxNote === 127) {
                // Plage complète : pas de filtre
                this.playableNotes = null;
                this.log('info', 'Full range (0-127) - no filter');
            } else {
                this.playableNotes = new Set();
                for (let n = minNote; n <= maxNote; n++) {
                    this.playableNotes.add(n);
                }
                this.log('info', `Range mode: notes ${minNote}-${maxNote} (${this.playableNotes.size} playable)`);
            }
        } else {
            // Mode inconnu ou pas de restriction
            this.playableNotes = null;
        }
    }

    /**
     * Mettre à jour le piano roll avec les notes jouables
     */
    updatePianoRollPlayableNotes() {
        if (!this.pianoRoll) return;

        // Passer les notes jouables au piano roll
        this.pianoRoll.playableNotes = this.playableNotes;

        // Forcer un redessin pour appliquer les couleurs de fond grisées
        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }

        this.log('debug', 'Piano roll updated with playable notes filter');
    }

    /**
     * Mettre à jour l'état visuel des boutons de canal
     */
    updateChannelButtons() {
        const buttons = this.container?.querySelectorAll('.channel-btn');
        if (!buttons) return;

        buttons.forEach(btn => {
            const channel = parseInt(btn.dataset.channel);
            const color = btn.dataset.color; // Récupérer la couleur depuis data-attribute
            const isActive = this.activeChannels.has(channel);

            if (isActive) {
                btn.classList.add('active');
                // Appliquer les styles pour l'état actif (sans lueur)
                btn.style.cssText = `
                    --channel-color: ${color};
                    background: ${color};
                    border-color: ${color};
                `;
            } else {
                btn.classList.remove('active');
                // Appliquer les styles pour l'état inactif (sans lueur)
                btn.style.cssText = `
                    --channel-color: ${color};
                    border-color: ${color};
                `;
            }
        });

        // Mettre à jour le compteur de notes
        this.updateStats();
    }

    render() {
        // Créer le conteneur de la modale
        this.container = document.createElement('div');
        this.container.className = 'modal-overlay midi-editor-modal';
        this.container.innerHTML = `
            <div class="modal-dialog modal-xl">
                <div class="modal-header">
                    <div class="modal-title">
                        <h3>🎹 ${this.t('midiEditor.title')}</h3>
                        <span class="title-separator">—</span>
                        <span class="file-name" id="editor-file-name">${escapeHtml(this.currentFilename || this.currentFile || '')}</span>
                        <button class="btn-rename-file" data-action="rename-file" title="${this.t('midiEditor.renameFile')}">✏️</button>
                        <span class="title-separator">—</span>
                        <div class="tempo-control">
                            <label for="tempo-input">♩ BPM:</label>
                            <input type="number" id="tempo-input" class="tempo-input" min="20" max="300" step="1" value="${this.tempo || 120}" title="${this.t('midiEditor.tempoTip')}">
                        </div>
                    </div>
                    <button class="modal-close" data-action="close">&times;</button>
                </div>
                <div class="modal-body">
                    <!-- Toolbar d'édition -->
                    <div class="editor-toolbar">
                        <!-- Section Playback -->
                        <div class="toolbar-section playback-section">
                            <button class="tool-btn playback-btn" data-action="playback-play" id="play-btn" title="${this.t('midiEditor.play')} (Space)">
                                <span class="icon play-icon">▶</span>
                                <span class="btn-label">${this.t('midiEditor.play')}</span>
                            </button>
                            <button class="tool-btn playback-btn" data-action="playback-pause" id="pause-btn" title="${this.t('midiEditor.pause')}" style="display: none;">
                                <span class="icon pause-icon">⏸</span>
                                <span class="btn-label">${this.t('midiEditor.pause')}</span>
                            </button>
                            <button class="tool-btn playback-btn" data-action="playback-stop" id="stop-btn" title="${this.t('midiEditor.stop')}" disabled>
                                <span class="icon stop-icon">⏹</span>
                                <span class="btn-label">${this.t('midiEditor.stop')}</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Undo/Redo -->
                        <div class="toolbar-section">
                            <button class="tool-btn" data-action="undo" id="undo-btn" title="${this.t('midiEditor.undo')} (Ctrl+Z)" disabled>
                                <span class="icon">↶</span>
                                <span class="btn-label">${this.t('midiEditor.undo')}</span>
                            </button>
                            <button class="tool-btn" data-action="redo" id="redo-btn" title="${this.t('midiEditor.redo')} (Ctrl+Y)" disabled>
                                <span class="icon">↷</span>
                                <span class="btn-label">${this.t('midiEditor.redo')}</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Grille/Snap -->
                        <div class="toolbar-section">
                            <label class="snap-label">${this.t('midiEditor.grid')}</label>
                            <button class="tool-btn-snap" data-action="cycle-snap" id="snap-btn" title="${this.t('midiEditor.gridTip')}">
                                <span class="snap-value" id="snap-value">1/8</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Navigation et Zoom -->
                        <div class="toolbar-section">
                            <button class="tool-btn active" data-action="mode-drag-view" data-mode="drag-view" title="${this.t('midiEditor.viewModeTip')}">
                                <span class="icon">👁️</span>
                                <span class="btn-label">${this.t('midiEditor.viewMode')}</span>
                            </button>
                            <button class="tool-btn-compact" data-action="zoom-h-out" title="${this.t('midiEditor.zoomHOut')}">H−</button>
                            <button class="tool-btn-compact" data-action="zoom-h-in" title="${this.t('midiEditor.zoomHIn')}">H+</button>
                            <button class="tool-btn-compact" data-action="zoom-v-out" title="${this.t('midiEditor.zoomVOut')}">V−</button>
                            <button class="tool-btn-compact" data-action="zoom-v-in" title="${this.t('midiEditor.zoomVIn')}">V+</button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Mode d'édition -->
                        <div class="toolbar-section">
                            <button class="tool-btn" data-action="mode-select" data-mode="select" title="${this.t('midiEditor.selectModeTip')}">
                                <span class="icon">⊕</span>
                                <span class="btn-label">${this.t('midiEditor.selectMode')}</span>
                            </button>
                            <button class="tool-btn" data-action="mode-drag-notes" data-mode="drag-notes" title="${this.t('midiEditor.moveNotesTip')}">
                                <span class="icon">🎵</span>
                                <span class="btn-label">${this.t('midiEditor.moveNotes')}</span>
                            </button>
                            <button class="tool-btn" data-action="mode-add-note" data-mode="add-note" title="${this.t('midiEditor.addNoteTip')}">
                                <span class="icon">➕</span>
                                <span class="btn-label">${this.t('midiEditor.addNote')}</span>
                            </button>
                            <button class="tool-btn" data-action="mode-resize-note" data-mode="resize-note" title="${this.t('midiEditor.durationTip')}">
                                <span class="icon">↔</span>
                                <span class="btn-label">${this.t('midiEditor.duration')}</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Édition -->
                        <div class="toolbar-section">
                            <button class="tool-btn" data-action="copy" id="copy-btn" title="${this.t('midiEditor.copy')} (Ctrl+C)" disabled>
                                <span class="icon">📋</span>
                                <span class="btn-label">${this.t('midiEditor.copy')}</span>
                            </button>
                            <button class="tool-btn" data-action="paste" id="paste-btn" title="${this.t('midiEditor.paste')} (Ctrl+V)" disabled>
                                <span class="icon">📄</span>
                                <span class="btn-label">${this.t('midiEditor.paste')}</span>
                            </button>
                            <button class="tool-btn" data-action="delete" id="delete-btn" title="${this.t('midiEditor.delete')} (Del)">
                                <span class="icon">🗑</span>
                                <span class="btn-label">${this.t('midiEditor.delete')}</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Canal -->
                        <div class="toolbar-section">
                            <label class="snap-label">${this.t('midiEditor.channel')}</label>
                            <select class="snap-select" id="channel-selector" title="${this.t('midiEditor.changeChannelTip')}">
                                ${this.renderChannelOptions()}
                            </select>
                            <button class="tool-btn-compact" data-action="change-channel" id="change-channel-btn" title="${this.t('midiEditor.applyChannel')}" disabled>→</button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Instrument -->
                        <div class="toolbar-section">
                            <label class="snap-label" id="instrument-label">${this.t('midiEditor.instrument')}</label>
                            <select class="snap-select" id="instrument-selector" title="${this.t('midiEditor.selectInstrument')}">
                                ${this.renderInstrumentOptions()}
                            </select>
                            <button class="tool-btn-compact" data-action="apply-instrument" id="apply-instrument-btn" title="${this.t('midiEditor.applyInstrument')}">✓</button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Instrument Connecté (filtre notes jouables) -->
                        <div class="toolbar-section">
                            <label class="snap-label">🎹 ${this.t('midiEditor.connectedDevice')}</label>
                            <select class="snap-select connected-device-select" id="connected-device-selector" title="${this.t('midiEditor.connectedDeviceTip')}">
                                <option value="">${this.t('midiEditor.noDeviceFilter')}</option>
                            </select>
                        </div>
                    </div>

                    <!-- Toolbar des canaux -->
                    <div class="channels-toolbar">
                        ${this.renderChannelButtons()}
                    </div>

                    <!-- Conteneur pour Notes et CC/Pitchbend -->
                    <div class="midi-editor-container">
                        <!-- Section Notes -->
                        <div class="midi-editor-section notes-section">
                            <div class="piano-roll-wrapper">
                                <div class="piano-roll-container" id="piano-roll-container">
                                    <!-- webaudio-pianoroll sera inséré ici -->
                                </div>
                                <!-- Slider vertical avec boutons -->
                                <div class="scroll-controls scroll-controls-vertical">
                                    <button class="scroll-btn scroll-btn-up" data-action="scroll-up">▲</button>
                                    <input type="range" class="scroll-slider scroll-vertical" id="scroll-v-slider" min="0" max="100" value="0" step="1" orient="vertical">
                                    <button class="scroll-btn scroll-btn-down" data-action="scroll-down">▼</button>
                                </div>
                            </div>
                            <!-- Slider horizontal avec boutons (toujours visible) -->
                            <div class="scroll-controls scroll-controls-horizontal">
                                <button class="scroll-btn scroll-btn-left" data-action="scroll-left">◄</button>
                                <input type="range" class="scroll-slider scroll-horizontal" id="scroll-h-slider" min="0" max="100" value="0" step="1">
                                <button class="scroll-btn scroll-btn-right" data-action="scroll-right">►</button>
                            </div>
                        </div>

                        <!-- Barre de resize entre notes et CC -->
                        <div class="cc-resize-bar" id="cc-resize-btn" title="${this.t('midiEditor.dragToResize')}">
                            <span class="resize-grip">⋮⋮⋮</span>
                        </div>

                        <!-- Section CC/Pitchbend/Velocity (collapsible) -->
                        <div class="midi-editor-section cc-section collapsed" id="cc-section">
                            <!-- Header collapsible -->
                            <div class="cc-section-header collapsed" id="cc-section-header">
                                <div class="cc-section-title">
                                    <span class="cc-collapse-icon">▼</span>
                                    <span>${this.t('midiEditor.ccSection')}</span>
                                </div>
                            </div>

                            <!-- Contenu de l'éditeur CC/Velocity -->
                            <div class="cc-section-content" id="cc-section-content">
                                <!-- Toolbar horizontal pour sélection du type (CC/PB/VEL) -->
                                <div class="cc-type-toolbar">
                                    <label class="cc-toolbar-label">${this.t('midiEditor.type')}</label>
                                    <div class="cc-type-buttons-horizontal">
                                        <!-- Groupe Performance -->
                                        <div class="cc-btn-group" data-group="perf">
                                            <span class="cc-group-label">${this.t('midiEditor.groupPerf')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn active" data-cc-type="cc1" title="Modulation Wheel">CC1</button>
                                                <button class="cc-type-btn" data-cc-type="cc2" title="Breath Controller">CC2</button>
                                                <button class="cc-type-btn" data-cc-type="cc11" title="Expression Controller">CC11</button>
                                                <button class="cc-type-btn" data-cc-type="pitchbend" title="Pitch Wheel">PB</button>
                                            </div>
                                        </div>
                                        <!-- Groupe Vibrato -->
                                        <div class="cc-btn-group" data-group="vib">
                                            <span class="cc-group-label">${this.t('midiEditor.groupVib')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn" data-cc-type="cc76" title="Vibrato Rate">CC76</button>
                                                <button class="cc-type-btn" data-cc-type="cc77" title="Vibrato Depth">CC77</button>
                                                <button class="cc-type-btn" data-cc-type="cc78" title="Vibrato Delay">CC78</button>
                                            </div>
                                        </div>
                                        <!-- Groupe Mix -->
                                        <div class="cc-btn-group" data-group="mix">
                                            <span class="cc-group-label">${this.t('midiEditor.groupMix')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn" data-cc-type="cc7" title="Channel Volume">CC7</button>
                                                <button class="cc-type-btn" data-cc-type="cc10" title="Pan Position">CC10</button>
                                                <button class="cc-type-btn" data-cc-type="cc91" title="Reverb Send">CC91</button>
                                            </div>
                                        </div>
                                        <!-- Groupe Tone -->
                                        <div class="cc-btn-group" data-group="tone">
                                            <span class="cc-group-label">${this.t('midiEditor.groupTone')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn" data-cc-type="cc74" title="Brightness / Cutoff">CC74</button>
                                                <button class="cc-type-btn" data-cc-type="cc5" title="Portamento Time">CC5</button>
                                            </div>
                                        </div>
                                        <!-- Groupe Note/Global -->
                                        <div class="cc-btn-group" data-group="note">
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn" data-cc-type="velocity" title="Note Velocity">VEL</button>
                                                <button class="cc-type-btn" data-cc-type="tempo" title="Tempo Automation">♩</button>
                                            </div>
                                        </div>
                                        <!-- Groupe dynamique (CC détectés non-statiques) -->
                                        <div class="cc-btn-group cc-dynamic-group" data-group="other" style="display:none;">
                                            <span class="cc-group-label">+</span>
                                            <div class="cc-btn-group-buttons" id="cc-dynamic-buttons"></div>
                                        </div>
                                    </div>

                                    <div class="cc-toolbar-divider"></div>

                                    <label class="cc-toolbar-label">${this.t('midiEditor.tools')}</label>
                                    <div class="cc-tool-buttons-horizontal">
                                        <button class="cc-tool-btn active" data-tool="select" title="${this.t('midiEditor.selectTool')}">⬚</button>
                                        <button class="cc-tool-btn" data-tool="move" title="${this.t('midiEditor.moveTool')}">✥</button>
                                        <button class="cc-tool-btn" data-tool="line" title="${this.t('midiEditor.lineTool')}">╱</button>
                                        <button class="cc-tool-btn" data-tool="draw" title="${this.t('midiEditor.drawTool')}">✎</button>
                                    </div>

                                    <div class="cc-toolbar-divider"></div>

                                    <button class="cc-delete-btn" id="cc-delete-btn" title="${this.t('midiEditor.deleteSelection')}" disabled>
                                        🗑️ <span class="btn-label">${this.t('midiEditor.delete')}</span>
                                    </button>

                                    <div class="cc-toolbar-divider"></div>

                                    <label class="cc-toolbar-label">${this.t('midiEditor.channel')}</label>
                                    <div class="cc-channel-selector-horizontal" id="editor-channel-selector">
                                        <!-- Les canaux seront ajoutés dynamiquement -->
                                    </div>
                                </div>

                                <!-- Layout de l'éditeur (pleine hauteur sans sidebar) -->
                                <div class="cc-editor-layout">
                                    <!-- Conteneur pour les éditeurs (CC, Velocity ou Tempo) -->
                                    <div id="cc-editor-container" class="cc-editor-main"></div>
                                    <div id="velocity-editor-container" class="cc-editor-main" style="display: none;"></div>
                                    <div id="tempo-editor-container" class="cc-editor-main" style="display: none;"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Boutons flottants en overlay -->
                    <div class="modal-floating-buttons">
                        <button class="btn btn-secondary" data-action="close">${this.t('common.close')}</button>
                        <button class="btn btn-info" data-action="auto-assign" id="auto-assign-btn" title="${this.t('autoAssign.title')}">
                            🎯 ${this.t('midiEditor.autoAssign')}
                        </button>
                        <button class="btn btn-primary" data-action="save" id="save-btn">
                            💾 ${this.t('midiEditor.save')}
                        </button>
                        <button class="btn btn-secondary" data-action="save-as" id="save-as-btn" title="${this.t('midiEditor.saveAs')}">
                            📄 ${this.t('midiEditor.saveAs')}
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.container);

        // Attacher les événements
        this.attachEvents();

        // Fermer avec Escape
        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);

        // Raccourcis clavier
        this.setupKeyboardShortcuts();
    }

    /**
     * Initialiser le piano roll avec webaudio-pianoroll
     */
    async initPianoRoll() {
        const container = document.getElementById('piano-roll-container');
        if (!container) {
            this.log('error', 'Piano roll container not found');
            return;
        }

        // Vérifier que webaudio-pianoroll est chargé
        if (typeof customElements.get('webaudio-pianoroll') === 'undefined') {
            this.showError(this.t('midiEditor.libraryNotLoaded'));
            return;
        }

        // Créer l'élément webaudio-pianoroll
        this.pianoRoll = document.createElement('webaudio-pianoroll');

        // Configuration
        const width = container.clientWidth || 1000;
        const height = container.clientHeight || 400;

        // Calculer la plage de ticks depuis la séquence
        let maxTick = 0;
        let minNote = 127;
        let maxNote = 0;

        if (this.sequence && this.sequence.length > 0) {
            this.sequence.forEach(note => {
                const endTick = note.t + note.g;
                if (endTick > maxTick) maxTick = endTick;
                if (note.n < minNote) minNote = note.n;
                if (note.n > maxNote) maxNote = note.n;
            });

            this.log('info', `Sequence range: ticks 0-${maxTick}, notes ${minNote}-${maxNote}`);
        }

        // Stocker maxTick pour les sliders
        if (!this.midiData) this.midiData = {};
        this.midiData.maxTick = maxTick;

        // Zoom par défaut pour afficher ~20 secondes
        // Avec 480 ticks/beat et 120 BPM standard: 20s = 9600 ticks
        const ticksPerBeat = this.midiData.header?.ticksPerBeat || 480;
        const twentySeconds = ticksPerBeat * 40; // ~20 secondes à 120 BPM
        const xrange = Math.max(twentySeconds, Math.min(maxTick, twentySeconds)); // Vue sur 20 premières secondes

        // Vue centrée verticalement pour voir toutes les notes des canaux visibles
        const noteRange = Math.max(24, maxNote - minNote + 4); // +4 notes de marge au lieu de +24
        const centerNote = Math.floor((minNote + maxNote) / 2);
        const yoffset = Math.max(0, centerNote - Math.floor(noteRange / 2)); // Centrer verticalement

        this.pianoRoll.setAttribute('width', width);
        this.pianoRoll.setAttribute('height', height);
        this.pianoRoll.setAttribute('editmode', 'dragpoly');
        this.pianoRoll.setAttribute('xrange', xrange.toString());
        this.pianoRoll.setAttribute('yrange', noteRange.toString());
        this.pianoRoll.setAttribute('yoffset', yoffset.toString()); // Centrer verticalement
        this.pianoRoll.setAttribute('wheelzoom', '1');
        this.pianoRoll.setAttribute('xscroll', '1');
        this.pianoRoll.setAttribute('yscroll', '1');
        // Marqueurs de lecture (triangles verts) - début et fin de la séquence
        this.pianoRoll.setAttribute('markstart', '0');
        this.pianoRoll.setAttribute('markend', maxTick.toString());
        // Curseur de lecture (triangle orange) - au début
        this.pianoRoll.setAttribute('cursor', '0');

        this.log('info', `Piano roll configured: xrange=${xrange}, yrange=${noteRange}, yoffset=${yoffset} (centered), tempo=${this.tempo || 120} BPM, timebase=${this.ticksPerBeat || 480} ticks/beat`);

        // Ajouter au conteneur AVANT de charger la sequence
        container.appendChild(this.pianoRoll);

        // Assigner APRÈS avoir ajouté au DOM pour que les propriétés soient bien initialisées
        // Tempo et timebase du fichier MIDI (importants pour l'affichage du temps en secondes)
        this.pianoRoll.tempo = this.tempo || 120;
        this.pianoRoll.timebase = this.ticksPerBeat || 480;

        // Grille visuelle fixe pour voir les subdivisions (1/16 note = 120 ticks)
        this.pianoRoll.grid = 120;

        // Snap to grid pour contraindre le positionnement des notes
        const currentSnap = this.snapValues[this.currentSnapIndex];
        this.pianoRoll.snap = currentSnap.ticks;

        this.log('info', `Piano roll grid/snap: grid=${this.pianoRoll.grid} ticks, snap=${this.pianoRoll.snap} ticks (${currentSnap.label})`);

        // Forcer updateTimer() et redraw pour afficher les secondes
        if (typeof this.pianoRoll.updateTimer === 'function') {
            this.pianoRoll.updateTimer();
        }
        if (typeof this.pianoRoll.redrawXRuler === 'function') {
            this.pianoRoll.redrawXRuler();
        }

        // Attendre que le composant soit monté
        await new Promise(resolve => setTimeout(resolve, 100));

        // Définir les couleurs des canaux MIDI sur le piano roll AVANT de charger la séquence
        this.pianoRoll.channelColors = this.channelColors;

        // Définir le canal par défaut pour les nouvelles notes (premier canal actif)
        if (this.activeChannels.size > 0) {
            this.pianoRoll.defaultChannel = Array.from(this.activeChannels)[0];
        }

        // Initialiser les sliders de navigation
        this.initializeScrollSliders(maxTick, minNote, maxNote, xrange, noteRange, yoffset);

        // Synchroniser les sliders avec la navigation native du piano roll
        this.setupScrollSynchronization();

        // Charger la sequence SI elle existe et n'est pas vide
        if (this.sequence && this.sequence.length > 0) {
            this.log('info', `Loading ${this.sequence.length} notes into piano roll`);

            // DEBUG: Afficher les premières notes
            this.log('debug', 'First 3 notes:', JSON.stringify(this.sequence.slice(0, 3)));

            // Assigner la sequence au piano roll
            this.pianoRoll.sequence = this.sequence;

            // Attendre un peu avant le redraw
            await new Promise(resolve => setTimeout(resolve, 50));

            // Forcer un redraw pour appliquer les couleurs
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
                this.log('info', 'Piano roll redrawn with channel colors');
            }

            // Vérifier que la sequence a bien été assignée
            this.log('debug', `Piano roll sequence length: ${this.pianoRoll.sequence?.length || 0}`);
        } else {
            this.log('warn', 'No notes to display in piano roll - adding test notes');

            // Ajouter quelques notes de test pour vérifier que le piano roll fonctionne
            this.pianoRoll.sequence = [
                { t: 0, g: 480, n: 60 },   // C4
                { t: 480, g: 480, n: 64 }, // E4
                { t: 960, g: 480, n: 67 }  // G4
            ];

            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
        }

        // Stocker une copie de la séquence pour détecter les changements
        let previousSequence = [];

        // Optimisation : utiliser un debounce pour éviter les appels multiples
        let changeTimeout = null;
        const handleChange = () => {
            // Feedback audio instantané avant le debounce
            this.handleNoteFeedback(previousSequence);

            if (changeTimeout) clearTimeout(changeTimeout);
            changeTimeout = setTimeout(() => {
                this.isDirty = true;
                this.updateSaveButton();
                this.syncFullSequenceFromPianoRoll();
                this.updateUndoRedoButtonsState(); // Mettre à jour undo/redo quand la séquence change

                // Mettre à jour la copie de la séquence après la synchronisation
                previousSequence = this.copySequence(this.pianoRoll.sequence);
            }, 100); // Debounce de 100ms
        };

        // Initialiser la copie de la séquence
        previousSequence = this.copySequence(this.pianoRoll.sequence);

        // Écouter les changements avec debounce
        this.pianoRoll.addEventListener('change', handleChange);

        // Observer les mutations du sequence pour détecter les changements de sélection uniquement
        let lastSelectionCount = 0;

        this.selectionCheckInterval = setInterval(() => {
            // Vérifier UNIQUEMENT le changement de sélection (très léger)
            const currentSelectionCount = this.getSelectionCount();
            if (currentSelectionCount !== lastSelectionCount) {
                this.updateEditButtons();
                lastSelectionCount = currentSelectionCount;
            }
        }, 2000); // Réduit à 2 secondes pour minimiser la charge

        this.updateStats();
        this.updateEditButtons(); // État initial
        this.updateUndoRedoButtonsState(); // État initial undo/redo
        this.updateInstrumentSelector(); // État initial sélecteur d'instrument

        // Définir le mode par défaut (drag-view pour navigation)
        if (this.pianoRoll && typeof this.pianoRoll.setUIMode === 'function') {
            this.pianoRoll.setUIMode(this.editMode); // 'drag-view' par défaut
            this.log('info', `Piano roll UI mode set to: ${this.editMode}`);
        }

        // L'éditeur CC/Pitchbend sera initialisé lors de l'ouverture de la section
        // via toggleCCSection()

        // Charger la liste des instruments connectés pour le filtrage des notes jouables
        this.loadConnectedDevices();
    }

    /**
     * Mettre à jour les statistiques affichées
     * Note: Fonction simplifiée - l'élément note-count a été retiré pour plus d'espace
     */
    updateStats() {
        // Anciennement affichait le nombre de notes, retiré pour optimiser l'espace
        // L'information est toujours visible dans le tooltip des boutons de canal
    }

    /**
     * Mettre à jour le bouton de sauvegarde
     */
    updateSaveButton() {
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
            if (this.isDirty) {
                saveBtn.classList.add('btn-warning');
                saveBtn.innerHTML = `💾 ${this.t('midiEditor.saveModified')}`;
            } else {
                saveBtn.classList.remove('btn-warning');
                saveBtn.innerHTML = `💾 ${this.t('midiEditor.save')}`;
            }
        }
    }

    // ========================================================================
    // ACTIONS D'ÉDITION
    // ========================================================================

    /**
     * Annuler la dernière action
     */
    undo() {
        if (!this.pianoRoll || typeof this.pianoRoll.undo !== 'function') {
            this.log('warn', 'Undo not available');
            return;
        }

        if (this.pianoRoll.undo()) {
            this.log('info', 'Undo successful');
            this.isDirty = true;
            this.updateSaveButton();
            this.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    /**
     * Refaire la dernière action annulée
     */
    redo() {
        if (!this.pianoRoll || typeof this.pianoRoll.redo !== 'function') {
            this.log('warn', 'Redo not available');
            return;
        }

        if (this.pianoRoll.redo()) {
            this.log('info', 'Redo successful');
            this.isDirty = true;
            this.updateSaveButton();
            this.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    /**
     * Mettre à jour l'état des boutons undo/redo
     */
    updateUndoRedoButtonsState() {
        if (!this.pianoRoll) return;

        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');

        if (undoBtn) {
            undoBtn.disabled = !this.pianoRoll.canUndo();
        }
        if (redoBtn) {
            redoBtn.disabled = !this.pianoRoll.canRedo();
        }
    }

    /**
     * Obtenir les notes sélectionnées du piano roll
     */
    getSelectedNotes() {
        if (!this.pianoRoll) {
            return [];
        }

        // Utiliser la méthode publique du piano roll si disponible
        if (typeof this.pianoRoll.getSelectedNotes === 'function') {
            return this.pianoRoll.getSelectedNotes();
        }

        // Fallback: filtrer directement la séquence
        const sequence = this.pianoRoll.sequence || [];
        return sequence.filter(note => note.f === 1); // f=1 indique une note sélectionnée
    }

    /**
     * Obtenir le nombre de notes sélectionnées
     */
    getSelectionCount() {
        if (!this.pianoRoll || typeof this.pianoRoll.getSelectionCount !== 'function') {
            return 0;
        }
        return this.pianoRoll.getSelectionCount();
    }

    /**
     * Copier les notes sélectionnées
     */
    copy() {
        if (!this.pianoRoll || typeof this.pianoRoll.copySelection !== 'function') {
            this.showNotification(this.t('midiEditor.copyNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.showNotification(this.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        // Utiliser la méthode du piano roll
        this.clipboard = this.pianoRoll.copySelection();

        this.log('info', `Copied ${this.clipboard.length} notes`);
        this.showNotification(this.t('midiEditor.notesCopied', { count: this.clipboard.length }), 'success');

        // Activer le bouton Paste
        const pasteBtn = document.getElementById('paste-btn');
        if (pasteBtn) {
            pasteBtn.disabled = false;
        }

        this.updateEditButtons();
    }

    /**
     * Coller les notes du clipboard
     */
    paste() {
        if (!this.clipboard || this.clipboard.length === 0) {
            this.showNotification(this.t('midiEditor.clipboardEmpty'), 'info');
            return;
        }

        if (!this.pianoRoll || typeof this.pianoRoll.pasteNotes !== 'function') {
            this.showNotification(this.t('midiEditor.pasteNotAvailable'), 'error');
            return;
        }

        // Obtenir la position actuelle du curseur
        const currentTime = this.pianoRoll.xoffset || 0;

        // Utiliser la méthode du piano roll
        this.pianoRoll.pasteNotes(this.clipboard, currentTime);

        this.log('info', `Pasted ${this.clipboard.length} notes`);
        this.showNotification(this.t('midiEditor.notesPasted', { count: this.clipboard.length }), 'success');

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();
        this.updateEditButtons();
    }

    /**
     * Supprimer les notes sélectionnées
     */
    deleteSelectedNotes() {
        if (!this.pianoRoll || typeof this.pianoRoll.deleteSelection !== 'function') {
            this.showNotification(this.t('midiEditor.deleteNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.showNotification(this.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        // Récupérer les notes sélectionnées avant suppression
        const selectedNotes = this.getSelectedNotes();

        // Utiliser la méthode du piano roll
        this.pianoRoll.deleteSelection();

        // Supprimer les CC/vélocité associés aux notes supprimées
        this.deleteAssociatedCCAndVelocity(selectedNotes);

        this.log('info', `Deleted ${count} notes`);
        this.showNotification(this.t('midiEditor.notesDeleted', { count }), 'success');

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();
        this.updateEditButtons();
    }

    /**
     * Supprimer les événements CC et vélocité associés aux notes supprimées
     */
    deleteAssociatedCCAndVelocity(deletedNotes) {
        if (!deletedNotes || deletedNotes.length === 0) return;

        // Créer un Set des (tick, channel) des notes supprimées pour recherche rapide
        const deletedPositions = new Set();
        deletedNotes.forEach(note => {
            // Créer une clé unique pour chaque position (tick + canal)
            const key = `${note.t}_${note.c}`;
            deletedPositions.add(key);
        });

        // Supprimer les événements CC/pitchbend aux mêmes positions
        if (this.ccEditor && this.ccEditor.events) {
            const initialCCCount = this.ccEditor.events.length;
            this.ccEditor.events = this.ccEditor.events.filter(event => {
                const key = `${event.ticks}_${event.channel}`;
                return !deletedPositions.has(key);
            });
            const deletedCCCount = initialCCCount - this.ccEditor.events.length;
            if (deletedCCCount > 0) {
                this.log('info', `Deleted ${deletedCCCount} CC/pitchbend events associated with deleted notes`);
                this.ccEditor.renderThrottled();
            }
        }

        // Supprimer les vélocités des notes supprimées
        // (La vélocité est déjà supprimée avec la note, mais on peut mettre à jour l'éditeur)
        if (this.velocityEditor) {
            this.velocityEditor.setSequence(this.pianoRoll.sequence);
            this.velocityEditor.renderThrottled();
        }
    }

    /**
     * Sélectionner toutes les notes affichées (canaux actifs)
     */
    selectAllNotes() {
        if (!this.pianoRoll || typeof this.pianoRoll.selectAll !== 'function') {
            this.log('warn', 'selectAll not available on piano roll');
            return;
        }

        // Sélectionner toutes les notes
        this.pianoRoll.selectAll();

        // Mettre à jour les boutons d'édition
        this.updateEditButtons();

        const count = this.getSelectionCount();
        this.log('info', `Selected all notes: ${count}`);
    }

    /**
     * Changer le canal des notes sélectionnées
     */
    async changeChannel() {
        if (!this.pianoRoll || typeof this.pianoRoll.changeChannelSelection !== 'function') {
            this.showNotification(this.t('midiEditor.changeChannelNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.showNotification(this.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        const channelSelector = document.getElementById('channel-selector');
        if (!channelSelector) return;

        const newChannel = parseInt(channelSelector.value);
        const instrumentSelector = document.getElementById('instrument-selector');

        // Déterminer le canal actuel des notes sélectionnées
        const selectedNotes = this.getSelectedNotes();
        const currentChannels = new Set(selectedNotes.map(n => n.c));
        const currentChannel = currentChannels.size === 1 ? Array.from(currentChannels)[0] : -1;

        // Vérifier si on essaie de déplacer vers le même canal
        if (currentChannel === newChannel) {
            this.showNotification(this.t('midiEditor.sameChannel'), 'info');
            return;
        }

        // Afficher le modal de confirmation
        const confirmed = await this.showChangeChannelModal(count, currentChannel, newChannel);
        if (!confirmed) {
            this.log('info', 'Channel change cancelled by user');
            return;
        }

        // Mémoriser les canaux source avant le déplacement
        const sourceChannels = new Set(selectedNotes.map(n => n.c));

        // Vérifier si le canal cible existe déjà
        const targetChannelInfo = this.channels.find(ch => ch.channel === newChannel);

        // Si c'est un nouveau canal, utiliser l'instrument sélectionné dans le sélecteur
        if (!targetChannelInfo && instrumentSelector) {
            this.selectedInstrument = parseInt(instrumentSelector.value);
            this.log('info', `New channel ${newChannel} will use instrument: ${this.getInstrumentName(this.selectedInstrument)}`);
        }

        // Utiliser la méthode du piano roll pour déplacer les notes
        this.pianoRoll.changeChannelSelection(newChannel);

        this.log('info', `Changed channel of ${count} notes to ${newChannel}`);
        this.showNotification(this.t('midiEditor.channelChanged', { count }), 'success');

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();

        // Mettre à jour la liste des canaux (supprime les canaux vides automatiquement)
        this.updateChannelsFromSequence();

        // Nettoyer activeChannels : retirer les canaux qui n'existent plus
        const existingChannelNumbers = new Set(this.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.activeChannels.delete(ch);
            this.log('info', `Removed empty channel ${ch} from active channels`);
        });

        // Activer automatiquement le nouveau canal s'il n'était pas actif
        if (!this.activeChannels.has(newChannel)) {
            this.activeChannels.add(newChannel);
        }

        // Mettre à jour la séquence affichée (skipSync=true car déjà synchronisé)
        this.updateSequenceFromActiveChannels(null, true);

        // Rafraîchir l'affichage des boutons de canal
        this.refreshChannelButtons();

        // Mettre à jour le sélecteur d'instrument pour refléter le nouveau canal
        this.updateInstrumentSelector();

        this.updateEditButtons();
    }

    /**
     * Rafraîchir les boutons de canal
     */
    refreshChannelButtons() {
        const channelsToolbar = this.container?.querySelector('.channels-toolbar');
        if (channelsToolbar) {
            channelsToolbar.innerHTML = this.renderChannelButtons();

            // Réattacher les événements sur les nouveaux boutons
            const channelButtons = this.container.querySelectorAll('.channel-btn');
            channelButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const channel = parseInt(btn.dataset.channel);
                    this.toggleChannel(channel);
                });
            });
        }
    }

    /**
     * Appliquer l'instrument sélectionné au canal ciblé ou aux notes sélectionnées
     */
    async applyInstrument() {
        if (this.activeChannels.size === 0) {
            this.showNotification(this.t('midiEditor.noActiveChannel'), 'info');
            return;
        }

        // Si plusieurs canaux sont actifs, demander de n'en garder qu'un seul
        if (this.activeChannels.size > 1) {
            this.showNotification(
                this.t('midiEditor.multipleChannelsWarning', { count: this.activeChannels.size }),
                'warning'
            );
            return;
        }

        const instrumentSelector = document.getElementById('instrument-selector');
        if (!instrumentSelector) return;

        const selectedProgram = parseInt(instrumentSelector.value);
        const instrumentName = this.getInstrumentName(selectedProgram);

        // Un seul canal actif : c'est celui-ci qu'on modifie
        const targetChannel = Array.from(this.activeChannels)[0];
        const channelInfo = this.channels.find(ch => ch.channel === targetChannel);

        if (!channelInfo) {
            this.log('error', `Channel ${targetChannel} not found in this.channels`);
            return;
        }

        // Vérifier si l'instrument change
        if (channelInfo.program === selectedProgram) {
            this.showNotification(this.t('midiEditor.sameInstrument'), 'info');
            return;
        }

        // Vérifier s'il y a des notes sélectionnées
        const selectionCount = this.getSelectionCount();
        const hasSelection = selectionCount > 0;

        // Afficher le modal de confirmation
        const result = await this.showChangeInstrumentModal({
            noteCount: selectionCount,
            channelNoteCount: channelInfo.noteCount,
            channel: targetChannel,
            currentInstrument: channelInfo.instrument,
            newInstrument: instrumentName,
            hasSelection
        });

        if (result === false) {
            this.log('info', 'Instrument change cancelled by user');
            return;
        }

        if (result === true && hasSelection) {
            // Changer uniquement les notes sélectionnées
            // On doit les déplacer vers un nouveau canal avec le nouvel instrument
            await this.applyInstrumentToSelection(selectedProgram, instrumentName);
        } else {
            // Changer tout le canal (result === 'channel' ou pas de sélection)
            this.applyInstrumentToChannel(targetChannel, selectedProgram, instrumentName, channelInfo);
        }
    }

    /**
     * Appliquer l'instrument uniquement aux notes sélectionnées
     * Crée un nouveau canal si nécessaire
     */
    async applyInstrumentToSelection(program, instrumentName) {
        const selectedNotes = this.getSelectedNotes();
        if (selectedNotes.length === 0) return;

        // Trouver un canal libre pour les notes avec le nouvel instrument
        let newChannel = this.findAvailableChannel(program);

        if (newChannel === -1) {
            this.showNotification(this.t('midiEditor.noChannelAvailable'), 'error');
            return;
        }

        // Ajouter le nouveau canal à la liste s'il n'existe pas
        let channelInfo = this.channels.find(ch => ch.channel === newChannel);
        if (!channelInfo) {
            channelInfo = {
                channel: newChannel,
                program: program,
                instrument: newChannel === 9 ? 'Drums' : instrumentName,
                noteCount: 0
            };
            this.channels.push(channelInfo);
        } else {
            // Mettre à jour l'instrument du canal
            channelInfo.program = program;
            channelInfo.instrument = newChannel === 9 ? 'Drums' : instrumentName;
        }

        // Déplacer les notes sélectionnées vers le nouveau canal
        if (this.pianoRoll && typeof this.pianoRoll.changeChannelSelection === 'function') {
            this.pianoRoll.changeChannelSelection(newChannel);
        }

        this.log('info', `Applied instrument ${instrumentName} to ${selectedNotes.length} selected notes (moved to channel ${newChannel + 1})`);
        this.showNotification(
            this.t('midiEditor.instrumentAppliedToSelection', { count: selectedNotes.length, instrument: instrumentName }),
            'success'
        );

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();
        this.updateChannelsFromSequence();

        // Nettoyer activeChannels : retirer les canaux qui n'existent plus
        const existingChannelNumbers = new Set(this.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.activeChannels.delete(ch);
            this.log('info', `Removed empty channel ${ch} from active channels`);
        });

        // Activer le nouveau canal
        if (!this.activeChannels.has(newChannel)) {
            this.activeChannels.add(newChannel);
        }

        // Mettre à jour la séquence affichée (skipSync=true car déjà synchronisé)
        this.updateSequenceFromActiveChannels(null, true);

        this.refreshChannelButtons();
        this.updateInstrumentSelector();
        this.updateEditButtons();
    }

    /**
     * Appliquer l'instrument à tout un canal
     */
    applyInstrumentToChannel(channel, program, instrumentName, channelInfo) {
        channelInfo.program = program;
        channelInfo.instrument = channel === 9 ? 'Drums' : instrumentName;

        this.log('info', `Applied instrument ${instrumentName} to channel ${channel + 1}`);
        this.showNotification(this.t('midiEditor.instrumentApplied', { channel: channel + 1, instrument: instrumentName }), 'success');

        this.refreshChannelButtons();
        this.isDirty = true;
        this.updateSaveButton();
    }

    /**
     * Trouver un canal disponible pour un instrument
     * Priorité : canal existant avec le même instrument, sinon nouveau canal libre
     */
    findAvailableChannel(program) {
        // Chercher d'abord un canal existant avec le même instrument
        const existingChannel = this.channels.find(ch => ch.program === program && ch.channel !== 9);
        if (existingChannel) {
            return existingChannel.channel;
        }

        // Sinon, trouver un canal libre (0-15, sauf 9 pour drums)
        const usedChannels = new Set(this.channels.map(ch => ch.channel));

        for (let i = 0; i < 16; i++) {
            if (i === 9) continue; // Skip drum channel
            if (!usedChannels.has(i)) {
                return i;
            }
        }

        // Si tous les canaux sont utilisés, utiliser le premier disponible qui n'est pas le canal actuel
        for (let i = 0; i < 16; i++) {
            if (i === 9) continue;
            const channelInfo = this.channels.find(ch => ch.channel === i);
            if (channelInfo && channelInfo.noteCount === 0) {
                return i;
            }
        }

        return -1; // Aucun canal disponible
    }

    /**
     * Cycler entre les différentes valeurs de grille/snap
     */
    cycleSnap() {
        // Passer à la valeur suivante (cycle)
        this.currentSnapIndex = (this.currentSnapIndex + 1) % this.snapValues.length;

        const currentSnap = this.snapValues[this.currentSnapIndex];

        // Mettre à jour l'affichage du bouton
        const snapValueElement = document.getElementById('snap-value');
        if (snapValueElement) {
            snapValueElement.textContent = currentSnap.label;
        }

        // Appliquer le snap au piano roll (grille visuelle reste fixe à 120)
        // Utiliser la propriété JavaScript pour s'assurer que le changement est bien appliqué
        if (this.pianoRoll) {
            this.pianoRoll.snap = currentSnap.ticks;
            this.log('info', `Snap to grid changed to ${currentSnap.label} (${currentSnap.ticks} ticks) - snap property set to ${this.pianoRoll.snap}`);
        }

        // Synchroniser tous les éditeurs
        this.syncAllEditors();

        this.showNotification(this.t('midiEditor.snapChanged', { snap: currentSnap.label }), 'info');
    }

    /**
     * Changer le tempo BPM
     */
    setTempo(newTempo) {
        if (!newTempo || isNaN(newTempo) || newTempo < 20 || newTempo > 300) {
            this.log('warn', `Invalid tempo value: ${newTempo}`);
            return;
        }

        this.tempo = newTempo;
        this.isDirty = true;
        this.updateSaveButton();

        // Mettre à jour le piano roll
        if (this.pianoRoll) {
            this.pianoRoll.tempo = newTempo;
        }

        // Mettre à jour le synthétiseur si existant
        if (this.synthesizer) {
            this.synthesizer.tempo = newTempo;
        }

        this.log('info', `Tempo changed to ${newTempo} BPM`);
        this.showNotification(`Tempo: ${newTempo} BPM`, 'info');
    }

    /**
     * Changer le mode d'édition
     */
    setEditMode(mode) {
        this.editMode = mode;

        // Utiliser la méthode setUIMode du piano roll
        if (this.pianoRoll && typeof this.pianoRoll.setUIMode === 'function') {
            this.pianoRoll.setUIMode(mode);
        }

        // Mettre à jour l'UI
        this.updateModeButtons();

        this.log('info', `Edit mode changed to: ${mode}`);
    }

    /**
     * Mettre à jour les boutons de mode
     */
    updateModeButtons() {
        const modeButtons = this.container?.querySelectorAll('[data-mode]');
        if (!modeButtons) return;

        modeButtons.forEach(btn => {
            const btnMode = btn.dataset.mode;
            if (btnMode === this.editMode) {
                btn.classList.add('active');
                btn.disabled = true; // Griser le bouton du mode actif
            } else {
                btn.classList.remove('active');
                btn.disabled = false;
            }
        });
    }

    /**
     * Mettre à jour les boutons d'édition (copy, paste, delete, change channel)
     */
    updateEditButtons() {
        const selectionCount = this.getSelectionCount();
        const hasSelection = selectionCount > 0;

        const copyBtn = document.getElementById('copy-btn');
        const deleteBtn = document.getElementById('delete-btn');
        const changeChannelBtn = document.getElementById('change-channel-btn');

        if (copyBtn) copyBtn.disabled = !hasSelection;
        if (deleteBtn) deleteBtn.disabled = !hasSelection;
        if (changeChannelBtn) changeChannelBtn.disabled = !hasSelection;

        this.log('debug', `Selection: ${selectionCount} notes`);
    }

    /**
     * Configurer les raccourcis clavier
     */
    setupKeyboardShortcuts() {
        this.keyboardHandler = (e) => {
            // Ignorer si on est dans un input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Ctrl/Cmd + Z = Undo
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            }

            // Ctrl/Cmd + Y = Redo (ou Ctrl/Cmd + Shift + Z)
            else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                this.redo();
            }

            // Ctrl/Cmd + C = Copy
            else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                this.copy();
            }

            // Ctrl/Cmd + V = Paste
            else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                e.preventDefault();
                this.paste();
            }

            // Ctrl/Cmd + A = Select All
            else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                this.selectAllNotes();
            }

            // Delete ou Backspace = Delete
            else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                // Si la section CC/Velocity est ouverte, supprimer les éléments CC/Velocity sélectionnés
                if (this.ccSectionExpanded) {
                    this.deleteSelectedCCVelocity();
                } else {
                    // Sinon, supprimer les notes sélectionnées
                    this.deleteSelectedNotes();
                }
            }

            // Space = Play/Pause
            else if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault();
                this.togglePlayback();
            }
        };

        document.addEventListener('keydown', this.keyboardHandler);
    }

    // ========================================================================
    // PLAYBACK (Synthétiseur intégré)
    // ========================================================================

    /**
     * Initialiser le synthétiseur
     */
    async initSynthesizer() {
        if (this.synthesizer) {
            return true;
        }

        try {
            // Vérifier que MidiSynthesizer est disponible
            if (typeof MidiSynthesizer === 'undefined') {
                this.log('error', 'MidiSynthesizer class not found. Please include MidiSynthesizer.js');
                return false;
            }

            this.synthesizer = new MidiSynthesizer();
            const initialized = await this.synthesizer.initialize();

            if (initialized) {
                // Configurer les callbacks
                this.synthesizer.onTickUpdate = (tick) => this.updatePlaybackCursor(tick);
                this.synthesizer.onPlaybackEnd = () => this.onPlaybackComplete();

                this.log('info', 'Synthesizer initialized successfully');
                return true;
            } else {
                this.log('error', 'Failed to initialize synthesizer');
                return false;
            }
        } catch (error) {
            this.log('error', 'Error initializing synthesizer:', error);
            return false;
        }
    }

    /**
     * Charger la séquence dans le synthétiseur
     */
    loadSequenceForPlayback() {
        if (!this.synthesizer) return;

        // Utiliser fullSequence pour jouer toutes les notes
        const sequence = this.fullSequence.length > 0 ? this.fullSequence : this.sequence;

        // Obtenir le tempo depuis les métadonnées MIDI
        const tempo = this.tempo || 120;
        const ticksPerBeat = this.ticksPerBeat || 480;

        this.synthesizer.loadSequence(sequence, tempo, ticksPerBeat);

        // Configurer les instruments pour chaque canal
        this.channels.forEach(ch => {
            this.synthesizer.setChannelInstrument(ch.channel, ch.program || 0);
        });

        // Synchroniser les canaux mutés (canaux non actifs = mutés)
        this.syncMutedChannels();

        // Définir la plage de lecture depuis les marqueurs
        this.updatePlaybackRange();
    }

    /**
     * Synchroniser les canaux mutés avec le synthétiseur
     * Les canaux non actifs (cachés) sont mutés
     */
    syncMutedChannels() {
        if (!this.synthesizer) return;

        // Trouver tous les canaux qui ne sont pas actifs
        const mutedChannels = [];
        this.channels.forEach(ch => {
            if (!this.activeChannels.has(ch.channel)) {
                mutedChannels.push(ch.channel);
            }
        });

        this.synthesizer.setMutedChannels(mutedChannels);
        this.log('debug', `Muted channels: ${mutedChannels.map(c => c + 1).join(', ') || 'none'}`);
    }

    /**
     * Mettre à jour la plage de lecture depuis les marqueurs du piano roll
     */
    updatePlaybackRange() {
        if (!this.synthesizer || !this.pianoRoll) return;

        // Obtenir les valeurs des marqueurs (en ticks)
        const markstart = this.pianoRoll.markstart || 0;
        let markend = this.pianoRoll.markend;

        // Si markend n'est pas défini ou est à -1, utiliser la fin de la séquence
        if (markend === undefined || markend < 0) {
            markend = this.midiData?.maxTick || this.getSequenceEndTick();
        }

        this.playbackStartTick = markstart;
        this.playbackEndTick = markend;

        this.synthesizer.setPlaybackRange(this.playbackStartTick, this.playbackEndTick);

        this.log('debug', `Playback range: ${this.playbackStartTick} - ${this.playbackEndTick} ticks`);
    }

    /**
     * Obtenir le tick de fin de la séquence
     */
    getSequenceEndTick() {
        let maxTick = 0;
        const sequence = this.fullSequence.length > 0 ? this.fullSequence : this.sequence;

        sequence.forEach(note => {
            const endTick = note.t + note.g;
            if (endTick > maxTick) maxTick = endTick;
        });

        return maxTick;
    }

    /**
     * Copier une séquence de notes
     */
    copySequence(sequence) {
        if (!sequence || sequence.length === 0) return [];
        return sequence.map(note => ({
            t: note.t,
            g: note.g,
            n: note.n,
            c: note.c,
            v: note.v
        }));
    }

    /**
     * Gérer le feedback audio lors de changements de notes
     */
    handleNoteFeedback(previousSequence) {
        if (!this.pianoRoll || !this.pianoRoll.sequence) return;

        const currentSequence = this.pianoRoll.sequence;

        // Créer des maps pour comparaison rapide
        const previousMap = new Map();
        previousSequence.forEach((note, index) => {
            const key = `${note.t}_${note.c}_${index}`;
            previousMap.set(key, note);
        });

        const currentMap = new Map();
        currentSequence.forEach((note, index) => {
            const key = `${note.t}_${note.c}_${index}`;
            currentMap.set(key, note);
        });

        // Détecter les notes ajoutées ou modifiées
        const notesToPlay = [];
        currentSequence.forEach((note, index) => {
            const key = `${note.t}_${note.c}_${index}`;
            const prevNote = previousMap.get(key);

            // Note ajoutée ou pitch changé (déplacement vertical)
            if (!prevNote || prevNote.n !== note.n) {
                notesToPlay.push(note);
            }
        });

        // Jouer les notes modifiées/ajoutées (limiter à 5 pour éviter la surcharge)
        if (notesToPlay.length > 0 && notesToPlay.length <= 5) {
            notesToPlay.forEach(note => {
                this.playNoteFeedback(note.n, note.v || 100, note.c || 0);
            });
        }
    }

    /**
     * Jouer une note courte comme feedback audio
     */
    async playNoteFeedback(noteNumber, velocity = 100, channel = 0) {
        // Initialiser le synthétiseur si nécessaire
        if (!this.synthesizer) {
            await this.initSynthesizer();
        }

        if (!this.synthesizer || !this.synthesizer.isInitialized) {
            return;
        }

        // Jouer la note avec une durée courte (100ms)
        const duration = 0.1; // 100ms
        this.synthesizer.playNote(noteNumber, velocity, channel, duration);
    }

    /**
     * Démarrer ou reprendre la lecture
     */
    async playbackPlay() {
        // Initialiser le synthétiseur si nécessaire
        if (!this.synthesizer) {
            const initialized = await this.initSynthesizer();
            if (!initialized) {
                this.showNotification(this.t('midiEditor.synthInitError'), 'error');
                return;
            }
        }

        // Charger/recharger la séquence si nécessaire (seulement si pas en pause)
        if (!this.isPlaying && !this.isPaused) {
            this.loadSequenceForPlayback();

            // Si le curseur a été déplacé manuellement, démarrer depuis cette position
            if (this.pianoRoll && this.pianoRoll.cursor > 0) {
                this.synthesizer.seek(this.pianoRoll.cursor);
            }
        } else if (this.isPaused) {
            // En pause : reprendre depuis la position actuelle du curseur (qui peut avoir été déplacé)
            if (this.pianoRoll) {
                this.synthesizer.seek(this.pianoRoll.cursor);
            }
        }

        // Démarrer la lecture
        await this.synthesizer.play();

        this.isPlaying = true;
        this.isPaused = false;

        // Mettre à jour l'UI
        this.updatePlaybackButtons();

        this.log('info', 'Playback started');
    }

    /**
     * Mettre en pause la lecture
     */
    playbackPause() {
        if (!this.synthesizer || !this.isPlaying) return;

        this.synthesizer.pause();

        this.isPlaying = false;
        this.isPaused = true;

        this.updatePlaybackButtons();

        this.log('info', 'Playback paused');
    }

    /**
     * Arrêter la lecture
     */
    playbackStop() {
        if (!this.synthesizer) return;

        this.synthesizer.stop();

        this.isPlaying = false;
        this.isPaused = false;

        // Remettre le curseur au début
        if (this.pianoRoll) {
            this.pianoRoll.cursor = this.playbackStartTick;
        }

        this.updatePlaybackButtons();

        this.log('info', 'Playback stopped');
    }

    /**
     * Basculer entre play et pause
     */
    togglePlayback() {
        if (this.isPlaying) {
            this.playbackPause();
        } else {
            this.playbackPlay();
        }
    }

    /**
     * Mettre à jour le curseur pendant la lecture
     * @param {number} tick - Position actuelle en ticks
     */
    updatePlaybackCursor(tick) {
        if (!this.pianoRoll) return;

        // Mettre à jour la position du curseur
        this.pianoRoll.cursor = tick;

        // Faire défiler automatiquement si le curseur sort de la vue
        const xoffset = this.pianoRoll.xoffset || 0;
        const xrange = this.pianoRoll.xrange || 1920;

        // Si le curseur est proche du bord droit (90% de la vue), faire défiler
        if (tick > xoffset + xrange * 0.9) {
            this.pianoRoll.xoffset = tick - xrange * 0.2;
        }
        // Si le curseur est avant le début de la vue, remettre au début
        else if (tick < xoffset) {
            this.pianoRoll.xoffset = Math.max(0, tick - xrange * 0.1);
        }
    }

    /**
     * Callback quand la lecture est terminée
     */
    onPlaybackComplete() {
        this.isPlaying = false;
        this.isPaused = false;

        // Remettre le curseur au début de la plage
        if (this.pianoRoll) {
            this.pianoRoll.cursor = this.playbackStartTick;
        }

        this.updatePlaybackButtons();

        this.log('info', 'Playback complete');
    }

    /**
     * Mettre à jour les boutons de playback
     */
    updatePlaybackButtons() {
        const playBtn = document.getElementById('play-btn');
        const pauseBtn = document.getElementById('pause-btn');
        const stopBtn = document.getElementById('stop-btn');

        if (this.isPlaying) {
            // En lecture : montrer Pause, cacher Play
            if (playBtn) playBtn.style.display = 'none';
            if (pauseBtn) pauseBtn.style.display = '';
            if (stopBtn) stopBtn.disabled = false;
        } else if (this.isPaused) {
            // En pause : montrer Play, cacher Pause
            if (playBtn) playBtn.style.display = '';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (stopBtn) stopBtn.disabled = false;
        } else {
            // Arrêté : montrer Play, cacher Pause, désactiver Stop
            if (playBtn) playBtn.style.display = '';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (stopBtn) stopBtn.disabled = true;
        }
    }

    /**
     * Nettoyer le synthétiseur
     */
    disposeSynthesizer() {
        if (this.synthesizer) {
            this.synthesizer.dispose();
            this.synthesizer = null;
        }
        this.isPlaying = false;
        this.isPaused = false;
    }

    // ========================================================================
    // MODAL DE CONFIRMATION MODERNE
    // ========================================================================

    /**
     * Afficher un modal de confirmation moderne
     * @param {Object} options - Options du modal
     * @param {string} options.title - Titre du modal
     * @param {string} options.message - Message principal
     * @param {string} options.details - Détails supplémentaires (optionnel)
     * @param {string} options.icon - Icône emoji (optionnel, défaut: ⚠️)
     * @param {string} options.confirmText - Texte du bouton de confirmation
     * @param {string} options.cancelText - Texte du bouton d'annulation
     * @param {string} options.confirmClass - Classe CSS pour le bouton de confirmation (primary, danger, success)
     * @param {Array} options.extraButtons - Boutons supplémentaires [{text, class, value}]
     * @returns {Promise<string|boolean>} - Résultat de la confirmation
     */
    showConfirmModal(options) {
        return new Promise((resolve) => {
            const {
                title = this.t('common.confirm'),
                message = '',
                details = '',
                icon = '⚠️',
                confirmText = this.t('common.confirm'),
                cancelText = this.t('common.cancel'),
                confirmClass = 'primary',
                extraButtons = []
            } = options;

            // Créer le modal
            const modal = document.createElement('div');
            modal.className = 'confirm-modal-overlay';
            modal.innerHTML = `
                <div class="confirm-modal">
                    <div class="confirm-modal-header">
                        <span class="confirm-modal-icon">${icon}</span>
                        <h3 class="confirm-modal-title">${title}</h3>
                    </div>
                    <div class="confirm-modal-body">
                        <p class="confirm-modal-message">${message}</p>
                        ${details ? `<div class="confirm-modal-details">${details}</div>` : ''}
                    </div>
                    <div class="confirm-modal-footer">
                        ${cancelText ? `<button class="confirm-modal-btn cancel" data-action="cancel">${cancelText}</button>` : ''}
                        ${extraButtons.map(btn => `
                            <button class="confirm-modal-btn ${btn.class || 'secondary'}" data-action="extra" data-value="${btn.value}">${btn.text}</button>
                        `).join('')}
                        <button class="confirm-modal-btn ${confirmClass}" data-action="confirm">${confirmText}</button>
                    </div>
                </div>
            `;

            // Ajouter au DOM
            document.body.appendChild(modal);

            // Fonction de fermeture centralisée
            const closeModal = (result) => {
                // Supprimer les listeners AVANT de fermer
                modal.removeEventListener('click', handleClick);
                document.removeEventListener('keydown', handleKeydown);

                // Animation de sortie
                modal.classList.remove('visible');
                setTimeout(() => {
                    if (modal.parentNode) {
                        modal.remove();
                    }
                    resolve(result);
                }, 200);
            };

            // Animation d'entrée
            requestAnimationFrame(() => {
                modal.classList.add('visible');
            });

            // Gestionnaire de clic
            const handleClick = (e) => {
                // Clic sur l'overlay (fond) = annuler
                if (e.target === modal) {
                    closeModal(false);
                    return;
                }

                const btn = e.target.closest('.confirm-modal-btn');
                if (!btn) return;

                const action = btn.dataset.action;
                let result;

                if (action === 'confirm') {
                    result = true;
                } else if (action === 'cancel') {
                    result = false;
                } else if (action === 'extra') {
                    result = btn.dataset.value;
                }

                closeModal(result);
            };

            modal.addEventListener('click', handleClick);

            // Fermer avec Escape
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    closeModal(false);
                }
            };
            document.addEventListener('keydown', handleKeydown);

            // Focus sur le bouton de confirmation
            setTimeout(() => {
                const confirmBtn = modal.querySelector('.confirm-modal-btn.primary, .confirm-modal-btn.success, .confirm-modal-btn.danger');
                if (confirmBtn) confirmBtn.focus();
            }, 50);
        });
    }

    /**
     * Modal de changement de canal avec options
     * @param {number} noteCount - Nombre de notes sélectionnées
     * @param {number} currentChannel - Canal actuel (ou -1 si mixte)
     * @param {number} newChannel - Nouveau canal
     * @returns {Promise<boolean>}
     */
    async showChangeChannelModal(noteCount, currentChannel, newChannel) {
        const currentChannelText = currentChannel >= 0
            ? `Canal ${currentChannel + 1}`
            : 'Canaux mixtes';

        const channelInfo = this.channels.find(ch => ch.channel === newChannel);
        const newChannelInstrument = channelInfo
            ? channelInfo.instrument
            : this.getInstrumentName(this.selectedInstrument);

        return this.showConfirmModal({
            title: this.t('midiEditor.changeChannelTitle'),
            icon: '🎹',
            message: `Déplacer <strong>${noteCount}</strong> note(s) vers le <strong>Canal ${newChannel + 1}</strong> ?`,
            details: `
                <div class="confirm-detail-row">
                    <span class="confirm-detail-label">Depuis :</span>
                    <span class="confirm-detail-value">${currentChannelText}</span>
                </div>
                <div class="confirm-detail-row">
                    <span class="confirm-detail-label">Vers :</span>
                    <span class="confirm-detail-value">Canal ${newChannel + 1} (${newChannelInstrument})</span>
                </div>
            `,
            confirmText: this.t('midiEditor.apply'),
            confirmClass: 'primary'
        });
    }

    /**
     * Modal de changement d'instrument avec choix
     * @param {Object} options
     * @returns {Promise<string|boolean>} - 'selection', 'channel', ou false
     */
    async showChangeInstrumentModal(options) {
        const {
            noteCount = 0,
            channelNoteCount = 0,
            channel,
            currentInstrument,
            newInstrument,
            hasSelection
        } = options;

        if (hasSelection && noteCount > 0) {
            // Proposer le choix : sélection ou tout le canal
            return this.showConfirmModal({
                title: this.t('midiEditor.changeInstrumentTitle'),
                icon: '🎵',
                message: `Changer l'instrument vers <strong>${newInstrument}</strong> ?`,
                details: `
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Instrument actuel :</span>
                        <span class="confirm-detail-value">${currentInstrument}</span>
                    </div>
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Nouvel instrument :</span>
                        <span class="confirm-detail-value">${newInstrument}</span>
                    </div>
                    <div class="confirm-choice-info">
                        <p>📌 <strong>${noteCount}</strong> note(s) sélectionnée(s)</p>
                        <p>📋 Canal ${channel + 1} contient <strong>${channelNoteCount}</strong> note(s) au total</p>
                    </div>
                `,
                confirmText: `Sélection (${noteCount})`,
                confirmClass: 'success',
                extraButtons: [
                    { text: `Tout le canal (${channelNoteCount})`, class: 'primary', value: 'channel' }
                ]
            });
        } else {
            // Pas de sélection, changer tout le canal
            return this.showConfirmModal({
                title: this.t('midiEditor.changeInstrumentTitle'),
                icon: '🎵',
                message: `Changer l'instrument du <strong>Canal ${channel + 1}</strong> ?`,
                details: `
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Instrument actuel :</span>
                        <span class="confirm-detail-value">${currentInstrument}</span>
                    </div>
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Nouvel instrument :</span>
                        <span class="confirm-detail-value">${newInstrument}</span>
                    </div>
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Notes affectées :</span>
                        <span class="confirm-detail-value">${channelNoteCount} note(s)</span>
                    </div>
                `,
                confirmText: this.t('midiEditor.apply'),
                confirmClass: 'primary'
            });
        }
    }

    // ========================================================================
    // ÉVÉNEMENTS
    // ========================================================================

    attachEvents() {
        if (!this.container) return;

        // Clic sur fond pour fermer
        this.container.addEventListener('click', (e) => {
            if (e.target === this.container) {
                this.close();
            }
        });

        // Boutons d'action
        this.container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;

            switch (action) {
                case 'close':
                    this.close();
                    break;
                case 'save':
                    this.saveMidiFile();
                    break;
                case 'save-as':
                    this.showSaveAsDialog();
                    break;
                case 'auto-assign':
                    this.showAutoAssignModal();
                    break;
                case 'zoom-h-in':
                    this.zoomHorizontal(0.8);
                    break;
                case 'zoom-h-out':
                    this.zoomHorizontal(1.25);
                    break;
                case 'zoom-v-in':
                    this.zoomVertical(0.8);
                    break;
                case 'zoom-v-out':
                    this.zoomVertical(1.25);
                    break;

                // Boutons de navigation des sliders
                case 'scroll-left':
                    this.scrollByHalf('left');
                    break;
                case 'scroll-right':
                    this.scrollByHalf('right');
                    break;
                case 'scroll-up':
                    this.scrollByHalf('up');
                    break;
                case 'scroll-down':
                    this.scrollByHalf('down');
                    break;

                // Nouveaux boutons d'édition
                case 'undo':
                    this.undo();
                    break;
                case 'redo':
                    this.redo();
                    break;
                case 'copy':
                    this.copy();
                    break;
                case 'paste':
                    this.paste();
                    break;
                case 'delete':
                    this.deleteSelectedNotes();
                    break;
                case 'change-channel':
                    this.changeChannel();
                    break;
                case 'apply-instrument':
                    this.applyInstrument();
                    break;
                case 'cycle-snap':
                    this.cycleSnap();
                    break;
                case 'rename-file':
                    this.showRenameDialog();
                    break;

                // Playback controls
                case 'playback-play':
                    this.playbackPlay();
                    break;
                case 'playback-pause':
                    this.playbackPause();
                    break;
                case 'playback-stop':
                    this.playbackStop();
                    break;

                // Modes d'édition
                case 'mode-select':
                case 'mode-drag-notes':
                case 'mode-drag-view':
                case 'mode-add-note':
                case 'mode-resize-note':
                    const mode = btn.dataset.mode;
                    if (mode) {
                        this.setEditMode(mode);
                    }
                    break;
            }
        });

        // Boutons de canal
        const channelButtons = this.container.querySelectorAll('.channel-btn');
        channelButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const channel = parseInt(btn.dataset.channel);
                if (!isNaN(channel)) {
                    this.toggleChannel(channel);
                }
            });
        });

        // Sélecteur d'instrument connecté (pour filtrer les notes jouables)
        const connectedDeviceSelector = document.getElementById('connected-device-selector');
        if (connectedDeviceSelector) {
            connectedDeviceSelector.addEventListener('change', async (e) => {
                const deviceId = e.target.value;
                await this.selectConnectedDevice(deviceId);
            });
        }

        // Input de tempo
        const tempoInput = document.getElementById('tempo-input');
        if (tempoInput) {
            tempoInput.addEventListener('change', (e) => {
                const newTempo = parseInt(e.target.value);
                if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
                    this.setTempo(newTempo);
                } else {
                    // Restaurer la valeur précédente si invalide
                    e.target.value = this.tempo || 120;
                }
            });
            // Aussi gérer le changement pendant la saisie (input event)
            tempoInput.addEventListener('input', (e) => {
                const newTempo = parseInt(e.target.value);
                if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
                    // Mise à jour en temps réel (optionnel, peut être retiré si trop de mises à jour)
                    this.setTempo(newTempo);
                }
            });
        }

        // Header de la section CC (collapse/expand)
        const ccSectionHeader = document.getElementById('cc-section-header');
        if (ccSectionHeader) {
            ccSectionHeader.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleCCSection();
            });
        }

        // Boutons de type CC (horizontaux)
        const ccTypeButtons = this.container.querySelectorAll('.cc-type-btn');
        ccTypeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const ccType = btn.dataset.ccType;
                if (ccType) {
                    this.selectCCType(ccType);
                }
            });
        });

        // Boutons d'outils (partagés entre CC et Velocity)
        const ccToolButtons = this.container.querySelectorAll('.cc-tool-btn');
        ccToolButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const tool = btn.dataset.tool;
                if (tool) {
                    // Désactiver tous les boutons
                    ccToolButtons.forEach(b => b.classList.remove('active'));
                    // Activer le bouton cliqué
                    btn.classList.add('active');

                    // Changer l'outil sur l'éditeur approprié
                    if (this.currentCCType === 'tempo' && this.tempoEditor) {
                        this.tempoEditor.setTool(tool);
                    } else if (this.currentCCType === 'velocity' && this.velocityEditor) {
                        this.velocityEditor.setTool(tool);
                    } else if (this.ccEditor) {
                        this.ccEditor.setTool(tool);
                    }
                }
            });
        });

        // Bouton de suppression pour CC/Velocity
        const ccDeleteBtn = this.container.querySelector('#cc-delete-btn');
        if (ccDeleteBtn) {
            ccDeleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.deleteSelectedCCVelocity();
            });
        }

        // Les event listeners pour les boutons de canal sont attachés
        // dans attachEditorChannelListeners() appelé depuis updateEditorChannelSelector()
        // pour éviter les conflits lors de la mise à jour dynamique des canaux

        // Sliders de navigation (scroll) avec throttle à 15fps
        const scrollHSlider = document.getElementById('scroll-h-slider');
        const scrollVSlider = document.getElementById('scroll-v-slider');

        let lastScrollUpdateH = 0;
        let lastScrollUpdateV = 0;
        const throttleDelay = 66; // ~15fps (1000ms / 15 = 66.67ms)

        if (scrollHSlider) {
            scrollHSlider.addEventListener('input', (e) => {
                const now = Date.now();
                if (now - lastScrollUpdateH < throttleDelay) return;
                lastScrollUpdateH = now;

                const value = parseInt(e.target.value);
                this.scrollHorizontal(value);
            });
        }

        if (scrollVSlider) {
            scrollVSlider.addEventListener('input', (e) => {
                const now = Date.now();
                if (now - lastScrollUpdateV < throttleDelay) return;
                lastScrollUpdateV = now;

                const value = parseInt(e.target.value);
                this.scrollVertical(value);
            });
        }

        // Sélecteur d'instrument pour nouveaux canaux
        const instrumentSelector = document.getElementById('instrument-selector');
        if (instrumentSelector) {
            instrumentSelector.addEventListener('change', (e) => {
                this.selectedInstrument = parseInt(e.target.value);
                this.log('info', `Selected instrument changed to: ${this.getInstrumentName(this.selectedInstrument)} (${this.selectedInstrument})`);
            });
        }

        // Barre de drag pour redimensionner la section CC/Velocity
        const resizeBar = document.getElementById('cc-resize-btn');
        const notesSection = this.container.querySelector('.notes-section');
        const ccSection = document.getElementById('cc-section');

        if (resizeBar && notesSection && ccSection) {
            this.log('info', 'Resize bar found, attaching drag events');

            // Log quand on survole la barre pour vérifier qu'elle est accessible
            resizeBar.addEventListener('mouseenter', () => {
                this.log('debug', 'Mouse entered resize bar');
            });

            let isResizing = false;
            let startY = 0;
            let startNotesHeight = 0;
            let availableHeight = 0;  // Espace disponible réel pour le resize
            let startNotesFlex = 3;
            let startCCFlex = 2;

            const startResize = (e) => {
                e.preventDefault();

                this.log('info', '=== RESIZE MOUSEDOWN DETECTED ===');

                // Ne permettre le resize que si la section CC est expanded
                if (!this.ccSectionExpanded || !ccSection.classList.contains('expanded')) {
                    this.log('warn', 'Resize blocked: CC section not expanded');
                    return;
                }

                isResizing = true;
                startY = e.clientY;
                startNotesHeight = notesSection.clientHeight;

                // Capturer l'espace disponible RÉEL depuis modal-dialog (hauteur fixe 95vh)
                const modalDialog = this.container.querySelector('.modal-dialog');  // ENFANT, pas parent !
                const modalBody = this.container.querySelector('.modal-body');
                const modalHeader = this.container.querySelector('.modal-header');
                const toolbarHeight = this.container.querySelector('.editor-toolbar')?.clientHeight || 0;
                const channelsToolbarHeight = this.container.querySelector('.channels-toolbar')?.clientHeight || 0;

                const modalDialogHeight = modalDialog?.clientHeight || 0;
                const modalHeaderHeight = modalHeader?.clientHeight || 0;

                // Espace disponible = hauteur totale du dialog - header - toolbars
                availableHeight = modalDialogHeight - modalHeaderHeight - toolbarHeight - channelsToolbarHeight;

                this.log('info', `Resize: modalDialog=${modalDialogHeight}px, modalHeader=${modalHeaderHeight}px, toolbars=${toolbarHeight + channelsToolbarHeight}px, available=${availableHeight}px`);

                // Obtenir les flex-grow actuels
                const notesStyle = window.getComputedStyle(notesSection);
                const ccStyle = window.getComputedStyle(ccSection);
                startNotesFlex = parseFloat(notesStyle.flexGrow) || 3;
                startCCFlex = parseFloat(ccStyle.flexGrow) || 2;

                this.log('info', `Initial flex: notes=${startNotesFlex}, cc=${startCCFlex}`);

                // Désactiver les transitions pendant le resize pour éviter les animations
                notesSection.style.transition = 'none';
                ccSection.style.transition = 'none';

                // Désactiver les min-height CSS qui bloquent le resize à ~50%
                notesSection.style.setProperty('min-height', '0px', 'important');
                ccSection.style.setProperty('min-height', '0px', 'important');

                // Empêcher le slider horizontal de déborder au-dessus de la section CC
                notesSection.style.setProperty('overflow', 'hidden', 'important');

                // Positionner le slider horizontal en sticky pour qu'il reste visible au-dessus de CC
                const horizontalSlider = notesSection.querySelector('.scroll-controls-horizontal');
                if (horizontalSlider) {
                    horizontalSlider.style.position = 'sticky';
                    horizontalSlider.style.bottom = '0';
                    horizontalSlider.style.zIndex = '100';
                }

                document.body.style.cursor = 'ns-resize';
                resizeBar.classList.add('dragging');
            };

            const doResize = (e) => {
                if (!isResizing) return;

                const deltaY = e.clientY - startY;
                const resizeBarHeight = 12; // Hauteur de la barre

                // Utiliser l'espace disponible RÉEL capturé au début
                const totalFlexHeight = availableHeight - resizeBarHeight;

                // Contraintes très assouplies: notes min 20px (permet à CC d'atteindre ~98%), cc min 100px
                const minNotesHeight = 20;
                const minCCHeight = 100;
                const newNotesHeight = Math.max(minNotesHeight, Math.min(totalFlexHeight - minCCHeight, startNotesHeight + deltaY));
                const newCCHeight = totalFlexHeight - newNotesHeight;

                this.log('debug', `Resize: deltaY=${deltaY}, availableH=${availableHeight}px, notesH=${newNotesHeight}px, ccH=${newCCHeight}px`);

                // Appliquer les hauteurs directement en pixels
                // Désactiver les min-height CSS qui bloquent le resize
                notesSection.style.setProperty('min-height', '0px', 'important');
                notesSection.style.setProperty('height', `${newNotesHeight}px`, 'important');
                notesSection.style.setProperty('flex', 'none', 'important');

                ccSection.style.setProperty('min-height', '0px', 'important');
                ccSection.style.setProperty('height', `${newCCHeight}px`, 'important');
                ccSection.style.setProperty('flex', 'none', 'important');

                // Vérifier si les styles sont réellement appliqués
                const actualNotesHeight = notesSection.clientHeight;
                const actualCCHeight = ccSection.clientHeight;
                this.log('debug', `Applied styles - Expected: notes=${newNotesHeight}px cc=${newCCHeight}px, Actual: notes=${actualNotesHeight}px cc=${actualCCHeight}px`);

                // Redimensionner les éditeurs pendant le drag pour que la grille soit visible
                requestAnimationFrame(() => {
                    // SOLUTION 2.2: Forcer recalcul de TOUTE la cascade flex (5 niveaux)
                    void ccSection.offsetHeight;
                    const ccContent = ccSection.querySelector('.cc-section-content');
                    const ccLayout = ccSection.querySelector('.cc-editor-layout');
                    const ccMain = ccSection.querySelector('.cc-editor-main');
                    void ccContent?.offsetHeight;
                    void ccLayout?.offsetHeight;
                    void ccMain?.offsetHeight;

                    if (this.pianoRoll && typeof this.pianoRoll.redraw === 'function') {
                        this.pianoRoll.redraw();
                        this.log('debug', 'Piano roll redraw called');
                    }

                    if (this.ccEditor && typeof this.ccEditor.resize === 'function') {
                        // SOLUTION 2.1: Corriger le bug du sélecteur (.cc-pitchbend-editor, pas -container)
                        const ccContainer = ccSection.querySelector('.cc-pitchbend-editor');
                        const ccHeight = ccContainer?.clientHeight || 0;
                        this.log('debug', `CC editor resize called - container height: ${ccHeight}px`);

                        // Premier appel resize
                        this.ccEditor.resize();

                        // SOLUTION 2.3: Double appel après 2 frames pour stabilisation layout
                        setTimeout(() => {
                            if (this.ccEditor && typeof this.ccEditor.resize === 'function') {
                                this.ccEditor.resize();
                                this.log('debug', 'CC editor re-resize after layout stabilization');
                            }
                        }, 32);
                    }

                    if (this.velocityEditor && typeof this.velocityEditor.resize === 'function') {
                        this.velocityEditor.resize();
                        this.log('debug', 'Velocity editor resize called');

                        // Double appel pour velocity editor aussi
                        setTimeout(() => {
                            if (this.velocityEditor && typeof this.velocityEditor.resize === 'function') {
                                this.velocityEditor.resize();
                            }
                        }, 32);
                    }
                });

                e.preventDefault();
            };

            const stopResize = () => {
                if (isResizing) {
                    isResizing = false;
                    document.body.style.cursor = '';
                    resizeBar.classList.remove('dragging');

                    // Réactiver les transitions
                    notesSection.style.transition = '';
                    ccSection.style.transition = '';

                    // GARDER overflow: hidden pour que le slider reste au-dessus
                    // Ne pas réinitialiser: notesSection.style.overflow = '';

                    // Redimensionner les éditeurs après le resize
                    requestAnimationFrame(() => {
                        if (this.pianoRoll && typeof this.pianoRoll.redraw === 'function') {
                            this.pianoRoll.redraw();
                        }

                        if (this.ccEditor && typeof this.ccEditor.resize === 'function') {
                            this.ccEditor.resize();
                        }

                        if (this.velocityEditor && typeof this.velocityEditor.resize === 'function') {
                            this.velocityEditor.resize();
                        }
                    });
                }
            };

            resizeBar.addEventListener('mousedown', startResize);
            // Stocker les refs pour cleanup dans doClose()
            this._resizeDoResize = doResize;
            this._resizeStopResize = stopResize;
            document.addEventListener('mousemove', doResize);
            document.addEventListener('mouseup', stopResize);
        }
    }

    /**
     * Recharger le piano roll avec la séquence actuelle
     */
    reloadPianoRoll() {
        if (!this.pianoRoll) {
            this.log('warn', 'Cannot reload piano roll: not initialized');
            return;
        }

        this.log('info', `Reloading piano roll with ${this.sequence.length} notes`);

        // Calculer la plage de ticks depuis la séquence
        let maxTick = 0;
        let minNote = 127;
        let maxNote = 0;

        if (this.sequence && this.sequence.length > 0) {
            this.sequence.forEach(note => {
                const endTick = note.t + note.g;
                if (endTick > maxTick) maxTick = endTick;
                if (note.n < minNote) minNote = note.n;
                if (note.n > maxNote) maxNote = note.n;
            });
        }

        // Mettre à jour les attributs du piano roll
        const xrange = Math.max(128, Math.ceil(maxTick / 128) * 128);
        const noteRange = Math.max(36, maxNote - minNote + 12);

        this.pianoRoll.setAttribute('xrange', xrange.toString());
        this.pianoRoll.setAttribute('yrange', noteRange.toString());

        // Recharger la séquence
        this.pianoRoll.sequence = this.sequence;

        // S'assurer que les couleurs sont toujours définies
        this.pianoRoll.channelColors = this.channelColors;

        // Forcer le redraw
        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }

        // Mettre à jour les stats
        this.updateStats();

        this.log('info', `Piano roll reloaded: ${this.sequence.length} notes, xrange=${xrange}, yrange=${noteRange}`);
    }

    /**
     * Ajuster la grille en fonction du niveau de zoom horizontal
     * Plus on dézoome, moins on affiche de lignes de grille
     */
    updateGridResolution(xrange) {
        if (!this.pianoRoll) return;

        let gridValue;

        // Cacher le quadrillage si zoom supérieur à 2000
        if (xrange > 2000) {
            gridValue = 100000; // Valeur très grande = grille invisible
        }
        // Adapter la résolution de la grille selon le zoom
        // grid = pas en ticks entre les lignes (petit = beaucoup de lignes, grand = peu de lignes)
        // Donc: plus on est zoomé (petit xrange), plus grid doit être PETIT
        else if (xrange < 500) {
            gridValue = 1;  // Ultra zoomé : ligne tous les 1 tick (maximum de détails)
        } else if (xrange < 1000) {
            gridValue = 2;  // Très zoomé : ligne tous les 2 ticks
        } else if (xrange < 1500) {
            gridValue = 4;  // Zoomé : ligne tous les 4 ticks (quarter notes)
        } else {
            gridValue = 8;  // Normal : ligne tous les 8 ticks
        }

        // Mettre à jour les deux : attribut ET propriété
        this.pianoRoll.setAttribute('grid', gridValue.toString());
        if (this.pianoRoll.grid !== undefined) {
            this.pianoRoll.grid = gridValue;
        }

        this.log('info', `Grid resolution updated: ${gridValue} (xrange=${xrange})`);
    }

    /**
     * Zoom horizontal
     */
    zoomHorizontal(factor) {
        if (!this.pianoRoll) {
            this.log('warn', 'Cannot zoom: piano roll not initialized');
            return;
        }

        // Essayer d'accéder à la propriété directement
        const currentRange = this.pianoRoll.xrange || parseInt(this.pianoRoll.getAttribute('xrange')) || 128;
        const newRange = Math.max(16, Math.min(100000, Math.round(currentRange * factor)));

        // Essayer les deux méthodes
        this.pianoRoll.setAttribute('xrange', newRange.toString());
        if (this.pianoRoll.xrange !== undefined) {
            this.pianoRoll.xrange = newRange;
        }

        // Ajuster la grille en fonction du nouveau zoom
        this.updateGridResolution(newRange);

        // Forcer le redraw avec un court délai
        setTimeout(() => {
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
        }, 50);

        // Synchroniser tous les éditeurs
        this.syncAllEditors();

        this.log('info', `Horizontal zoom: ${currentRange} -> ${newRange}`);
    }

    /**
     * Zoom vertical
     */
    zoomVertical(factor) {
        if (!this.pianoRoll) {
            this.log('warn', 'Cannot zoom: piano roll not initialized');
            return;
        }

        // Essayer d'accéder à la propriété directement
        const currentRange = this.pianoRoll.yrange || parseInt(this.pianoRoll.getAttribute('yrange')) || 36;
        const newRange = Math.max(12, Math.min(88, Math.round(currentRange * factor)));

        // Essayer les deux méthodes
        this.pianoRoll.setAttribute('yrange', newRange.toString());
        if (this.pianoRoll.yrange !== undefined) {
            this.pianoRoll.yrange = newRange;
        }

        // Forcer le redraw avec un court délai
        setTimeout(() => {
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
        }, 50);

        this.log('info', `Vertical zoom: ${currentRange} -> ${newRange}`);
    }

    /**
     * Initialiser les sliders de navigation avec les bonnes valeurs
     */
    initializeScrollSliders(maxTick, minNote, maxNote, xrange, noteRange, yoffset) {
        const scrollHSlider = document.getElementById('scroll-h-slider');
        const scrollVSlider = document.getElementById('scroll-v-slider');

        if (scrollHSlider) {
            // Position initiale horizontale: 0 (début du fichier)
            scrollHSlider.value = 0;
            this.log('info', `Horizontal slider initialized: maxTick=${maxTick}, xrange=${xrange}`);
        }

        if (scrollVSlider) {
            // Position initiale verticale: centrée
            const totalMidiRange = 128;
            const maxVOffset = Math.max(0, totalMidiRange - noteRange);
            const initialVPercentage = maxVOffset > 0 ? (yoffset / maxVOffset) * 100 : 0;
            scrollVSlider.value = initialVPercentage;
            this.log('info', `Vertical slider initialized: yoffset=${yoffset}, percentage=${initialVPercentage.toFixed(1)}%`);
        }
    }

    /**
     * Synchroniser les sliders avec la navigation native du piano roll
     * (clic sur timeline/clavier)
     */
    setupScrollSynchronization() {
        if (!this.pianoRoll) return;

        // OPTIMISATION: Polling réduit à 50ms (20fps) au lieu de 16ms (60fps)
        // Car webaudio-pianoroll ne déclenche pas toujours d'événements pour xoffset/yoffset
        let lastXOffset = this.pianoRoll.xoffset || 0;
        let lastYOffset = this.pianoRoll.yoffset || 0;
        let syncScheduled = false;

        this.syncInterval = setInterval(() => {
            if (!this.pianoRoll) {
                clearInterval(this.syncInterval);
                return;
            }

            const currentXOffset = this.pianoRoll.xoffset || 0;
            const currentYOffset = this.pianoRoll.yoffset || 0;

            // OPTIMISATION: Vérifier que le changement est significatif (> 1 tick)
            // pour éviter les updates inutiles dus à l'arrondi
            const xOffsetChanged = Math.abs(currentXOffset - lastXOffset) > 0.5;
            const yOffsetChanged = Math.abs(currentYOffset - lastYOffset) > 0.01;

            // Si xoffset a changé de manière significative, mettre à jour
            if (xOffsetChanged) {
                this.updateHorizontalSlider(currentXOffset);

                // OPTIMISATION: Throttler syncAllEditors avec requestAnimationFrame
                if (!syncScheduled) {
                    syncScheduled = true;
                    requestAnimationFrame(() => {
                        this.syncAllEditors();
                        syncScheduled = false;
                    });
                }

                lastXOffset = currentXOffset;
            }

            // Si yoffset a changé de manière significative, mettre à jour le slider vertical
            if (yOffsetChanged) {
                this.updateVerticalSlider(currentYOffset);
                lastYOffset = currentYOffset;
            }
        }, 50); // OPTIMISATION: 50ms (20fps) au lieu de 16ms (60fps)
    }

    /**
     * Mettre à jour le slider horizontal selon xoffset actuel
     */
    updateHorizontalSlider(xoffset) {
        const scrollHSlider = document.getElementById('scroll-h-slider');
        if (!scrollHSlider) return;

        const maxTick = this.midiData?.maxTick || 0;
        const xrange = this.pianoRoll.xrange || parseInt(this.pianoRoll.getAttribute('xrange')) || 128;
        const maxOffset = Math.max(0, maxTick - xrange);

        if (maxOffset > 0) {
            const percentage = (xoffset / maxOffset) * 100;
            scrollHSlider.value = percentage;
        }
    }

    /**
     * Mettre à jour le slider vertical selon yoffset actuel
     */
    updateVerticalSlider(yoffset) {
        const scrollVSlider = document.getElementById('scroll-v-slider');
        if (!scrollVSlider) return;

        const yrange = this.pianoRoll.yrange || parseInt(this.pianoRoll.getAttribute('yrange')) || 36;
        const totalMidiRange = 128;
        const maxOffset = Math.max(0, totalMidiRange - yrange);

        if (maxOffset > 0) {
            const percentage = (yoffset / maxOffset) * 100;
            scrollVSlider.value = percentage;
        }
    }

    /**
     * Défilement horizontal (0-100%)
     */
    scrollHorizontal(percentage) {
        if (!this.pianoRoll) return;

        // Calculer l'offset en fonction de la plage totale du fichier MIDI
        const maxTick = this.midiData?.maxTick || 0;
        const xrange = this.pianoRoll.xrange || parseInt(this.pianoRoll.getAttribute('xrange')) || 128;

        // L'offset maximum = maxTick - xrange (pour permettre de voir la fin)
        const maxOffset = Math.max(0, maxTick - xrange);
        const newOffset = Math.round((percentage / 100) * maxOffset);

        this.pianoRoll.xoffset = newOffset;
        this.pianoRoll.setAttribute('xoffset', newOffset.toString());

        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }

        // Synchroniser l'éditeur CC
        this.syncCCEditor();
    }

    /**
     * Défilement vertical (0-100%)
     */
    scrollVertical(percentage) {
        if (!this.pianoRoll) return;

        const yrange = this.pianoRoll.yrange || parseInt(this.pianoRoll.getAttribute('yrange')) || 36;

        // Plage complète MIDI: 0-127 notes
        const totalMidiRange = 128;
        const maxOffset = Math.max(0, totalMidiRange - yrange);
        const newOffset = Math.round((percentage / 100) * maxOffset);

        this.pianoRoll.yoffset = newOffset;
        this.pianoRoll.setAttribute('yoffset', newOffset.toString());

        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
    }

    /**
     * Déplacer la vue de moitié dans une direction
     * @param {string} direction - 'left', 'right', 'up', 'down'
     */
    scrollByHalf(direction) {
        if (!this.pianoRoll) return;

        if (direction === 'left' || direction === 'right') {
            // Déplacement horizontal
            const currentXOffset = this.pianoRoll.xoffset || 0;
            const xrange = this.pianoRoll.xrange || parseInt(this.pianoRoll.getAttribute('xrange')) || 128;
            const maxTick = this.midiData?.maxTick || 0;
            const maxOffset = Math.max(0, maxTick - xrange);

            // Déplacer de la moitié de xrange
            const halfRange = xrange / 2;
            let newOffset;

            if (direction === 'left') {
                newOffset = Math.max(0, currentXOffset - halfRange);
            } else { // right
                newOffset = Math.min(maxOffset, currentXOffset + halfRange);
            }

            // Convertir en pourcentage et utiliser scrollHorizontal
            const percentage = maxOffset > 0 ? (newOffset / maxOffset) * 100 : 0;
            this.scrollHorizontal(percentage);

            // Mettre à jour le slider
            this.updateHorizontalSlider(newOffset);

        } else if (direction === 'up' || direction === 'down') {
            // Déplacement vertical
            const currentYOffset = this.pianoRoll.yoffset || 0;
            const yrange = this.pianoRoll.yrange || parseInt(this.pianoRoll.getAttribute('yrange')) || 36;
            const totalMidiRange = 128;
            const maxOffset = Math.max(0, totalMidiRange - yrange);

            // Déplacer de la moitié de yrange
            const halfRange = yrange / 2;
            let newOffset;

            if (direction === 'up') {
                newOffset = Math.min(maxOffset, currentYOffset + halfRange);
            } else { // down
                newOffset = Math.max(0, currentYOffset - halfRange);
            }

            // Convertir en pourcentage et utiliser scrollVertical
            const percentage = maxOffset > 0 ? (newOffset / maxOffset) * 100 : 0;
            this.scrollVertical(percentage);

            // Mettre à jour le slider
            this.updateVerticalSlider(newOffset);
        }
    }

    // ========================================================================
    // FERMETURE
    // ========================================================================

    /**
     * Fermer la modale
     */
    close() {
        console.log('[MidiEditor] close() called, isDirty:', this.isDirty);

        // Vérifier les modifications non sauvegardées
        if (this.isDirty) {
            console.log('[MidiEditor] Has unsaved changes, showing modal');
            this.showUnsavedChangesModal();
            return;
        }

        console.log('[MidiEditor] No unsaved changes, closing directly');
        this.doClose();
    }

    /**
     * Afficher la modal de confirmation pour modifications non sauvegardées
     */
    showUnsavedChangesModal() {
        console.log('[MidiEditor] Showing unsaved changes modal');

        // Créer la modal de confirmation
        const confirmModal = document.createElement('div');
        confirmModal.className = 'modal-overlay unsaved-changes-modal';
        confirmModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10003 !important;
        `;

        confirmModal.innerHTML = `
            <div class="modal-dialog" style="
                background: #2a2a2a;
                border: 2px solid #ff6b6b;
                border-radius: 8px;
                padding: 24px;
                max-width: 500px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            ">
                <div style="display: flex; align-items: center; margin-bottom: 16px;">
                    <span style="font-size: 32px; margin-right: 12px;">⚠️</span>
                    <h2 style="margin: 0; color: #ff6b6b; font-size: 20px; font-family: sans-serif;">
                        ${this.t('midiEditor.unsavedChanges.title')}
                    </h2>
                </div>

                <div style="margin-bottom: 24px; color: #ddd; line-height: 1.6; font-family: sans-serif;">
                    <p style="margin: 0 0 12px 0;">
                        ${this.t('midiEditor.unsavedChanges.message')}
                    </p>
                    <p style="margin: 0; font-weight: bold; color: #ff6b6b;">
                        ${this.t('midiEditor.unsavedChanges.warning')}
                    </p>
                </div>

                <div style="display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;">
                    <button id="unsaved-cancel-btn" style="
                        padding: 10px 20px;
                        border: 1px solid #666;
                        border-radius: 4px;
                        background: #444;
                        color: #fff;
                        cursor: pointer;
                        font-size: 14px;
                        font-family: sans-serif;
                    ">
                        ↩️ ${this.t('midiEditor.unsavedChanges.cancel')}
                    </button>
                    <button id="unsaved-save-btn" style="
                        padding: 10px 20px;
                        border: 1px solid #4CAF50;
                        border-radius: 4px;
                        background: #4CAF50;
                        color: #fff;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: bold;
                        font-family: sans-serif;
                    ">
                        💾 ${this.t('midiEditor.unsavedChanges.saveAndClose')}
                    </button>
                    <button id="unsaved-discard-btn" style="
                        padding: 10px 20px;
                        border: 1px solid #f44336;
                        border-radius: 4px;
                        background: #f44336;
                        color: #fff;
                        cursor: pointer;
                        font-size: 14px;
                        font-family: sans-serif;
                    ">
                        🗑️ ${this.t('midiEditor.unsavedChanges.closeWithoutSave')}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(confirmModal);
        console.log('[MidiEditor] Modal appended to body');

        // Bouton Annuler
        const cancelBtn = confirmModal.querySelector('#unsaved-cancel-btn');
        cancelBtn.addEventListener('click', () => {
            console.log('[MidiEditor] Cancel clicked');
            confirmModal.remove();
        });

        // Bouton Sauvegarder et fermer
        const saveBtn = confirmModal.querySelector('#unsaved-save-btn');
        saveBtn.addEventListener('click', async () => {
            console.log('[MidiEditor] Save and close clicked');
            confirmModal.remove();
            await this.saveMidiFile();
            // Fermer après la sauvegarde
            this.doClose();
        });

        // Bouton Fermer sans sauvegarder
        const discardBtn = confirmModal.querySelector('#unsaved-discard-btn');
        discardBtn.addEventListener('click', () => {
            console.log('[MidiEditor] Discard and close clicked');
            confirmModal.remove();
            this.doClose();
        });

        // Fermer avec Escape
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                console.log('[MidiEditor] Escape pressed in modal');
                confirmModal.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Effectuer la fermeture réelle de l'éditeur
     */
    doClose() {
        // Unsubscribe from locale changes
        if (this.localeUnsubscribe) {
            this.localeUnsubscribe();
            this.localeUnsubscribe = null;
        }

        // Arrêter la synchronisation des sliders
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }

        // Arrêter la vérification de sélection
        if (this.selectionCheckInterval) {
            clearInterval(this.selectionCheckInterval);
            this.selectionCheckInterval = null;
        }

        // Nettoyer le piano roll
        if (this.pianoRoll) {
            this.pianoRoll.remove();
            this.pianoRoll = null;
        }

        // Nettoyer l'éditeur CC/Pitchbend
        if (this.ccEditor) {
            this.ccEditor.destroy();
            this.ccEditor = null;
        }
        this.ccEvents = [];
        this.ccSectionExpanded = false;
        this.currentCCType = 'cc1';

        // Nettoyer l'éditeur de vélocité
        if (this.velocityEditor) {
            this.velocityEditor.destroy();
            this.velocityEditor = null;
        }

        // Nettoyer l'éditeur de tempo
        if (this.tempoEditor) {
            this.tempoEditor.destroy();
            this.tempoEditor = null;
        }
        this.tempoEvents = [];

        // Nettoyer le synthétiseur
        this.disposeSynthesizer();

        // Retirer les listeners de resize drag
        if (this._resizeDoResize) {
            document.removeEventListener('mousemove', this._resizeDoResize);
            document.removeEventListener('mouseup', this._resizeStopResize);
            this._resizeDoResize = null;
            this._resizeStopResize = null;
        }

        // Retirer l'événement escape
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }

        // Retirer les raccourcis clavier
        if (this.keyboardHandler) {
            document.removeEventListener('keydown', this.keyboardHandler);
            this.keyboardHandler = null;
        }

        // Retirer le gestionnaire beforeunload
        this.removeBeforeUnloadHandler();

        // Nettoyer l'historique du piano roll
        if (this.pianoRoll && typeof this.pianoRoll.clearHistory === 'function') {
            this.pianoRoll.clearHistory();
        }

        // Retirer le conteneur
        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.isOpen = false;
        this.currentFile = null;
        this.currentFilename = null;
        this.midiData = null;
        this.isDirty = false;
        this.sequence = [];
        this.fullSequence = [];
        this.activeChannels.clear();
        this.channels = [];
        this.clipboard = [];

        // Émettre événement
        if (this.eventBus) {
            this.eventBus.emit('midi_editor:closed', {});
        }
    }

    /**
     * Installer le gestionnaire beforeunload pour avertir l'utilisateur
     * s'il tente de fermer la page/onglet avec des modifications non sauvegardées
     */
    setupBeforeUnloadHandler() {
        this.beforeUnloadHandler = (e) => {
            if (this.isDirty) {
                // Message standard du navigateur
                e.preventDefault();
                e.returnValue = ''; // Requis pour Chrome
                return ''; // Pour les navigateurs plus anciens
            }
        };
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }

    /**
     * Retirer le gestionnaire beforeunload
     */
    removeBeforeUnloadHandler() {
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
            this.beforeUnloadHandler = null;
        }
    }

    // ========================================================================
    // UTILITAIRES
    // ========================================================================

    showNotification(message, type = 'info') {
        if (window.app?.notifications) {
            window.app.notifications.show('Éditeur MIDI', message, type, 3000);
        } else {
            this.log('info', message);
        }
    }

    showError(message) {
        this.showErrorModal(message);
    }

    showErrorModal(message, title = null) {
        title = title || this.t('common.error');
        this.log('error', message);
        this.showConfirmModal({
            title: title,
            message: message,
            icon: '❌',
            confirmText: 'OK',
            confirmClass: 'primary',
            cancelText: ''
        }).catch(() => {});
    }

    log(level, ...args) {
        const prefix = '[MidiEditorModal]';
        if (typeof this.logger[level] === 'function') {
            this.logger[level](prefix, ...args);
        } else {
            console[level](prefix, ...args);
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorModal;
}

if (typeof window !== 'undefined') {
    window.MidiEditorModal = MidiEditorModal;
}
