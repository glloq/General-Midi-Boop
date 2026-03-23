// ============================================================================
// Fichier: public/js/audio/MidiSynthesizer.js
// Version: v2.0.0 - Synthétiseur MIDI avec WebAudioFont (samples réels)
// Description: Lecteur MIDI intégré au navigateur avec sons de qualité
// ============================================================================

/**
 * MidiSynthesizer - Synthétiseur MIDI utilisant WebAudioFont
 * Utilise des samples réels pour un rendu de qualité professionnelle
 */
class MidiSynthesizer {
    constructor() {
        this.audioContext = null;
        this.player = null;
        this.isInitialized = false;
        this.isPlaying = false;
        this.isPaused = false;

        // État de lecture
        this.currentTick = 0;
        this.startTick = 0;
        this.endTick = 0;
        this.startTime = 0;

        // Tempo et timing
        this.tempo = 120; // BPM
        this.ticksPerBeat = 480; // PPQ standard

        // Canaux et instruments
        this.channelInstruments = new Array(16).fill(0);
        this.channelVolumes = new Array(16).fill(100);
        this.mutedChannels = new Set(); // Canaux mutés

        // Instruments chargés (cache)
        this.loadedInstruments = new Map(); // program -> instrument data
        this.loadingInstruments = new Map(); // program -> Promise

        // Scheduler
        this.schedulerInterval = null;
        this.animationFrame = null;
        this.scheduleAheadTime = 0.2; // 200ms de lookahead
        this.lastScheduledTick = 0;

        // Notes actives pour pouvoir les arrêter
        this.activeEnvelopes = [];

        // Callbacks
        this.onTickUpdate = null;
        this.onPlaybackEnd = null;

        // Séquence
        this.sequence = [];

        // Logger
        this.logger = window.logger || console;

        // Mapping General MIDI vers WebAudioFont
        // Format: [fichier, variable] pour chaque programme GM (0-127)
        this.gmInstrumentMap = this.createGMInstrumentMap();

        // Drums (canal 9) — per-note presets from JCLive (better cymbals)
        // Fallback to SBLive for notes not in JCLive
        this.drumKit = null; // Legacy single-kit (unused, kept for compat)
        this.drumPresets = new Map(); // note → loaded preset
        this.drumPresetMap = this._createDrumPresetMap();

        // Drum audio processing
        this.drumReverbNode = null;     // ConvolverNode for cymbal reverb
        this.drumReverbGain = null;     // Wet gain for reverb
        this.drumDryGain = null;        // Dry gain for drums
        this.drumActiveNotes = new Map(); // note -> envelope (for hi-hat choke)

        // Minimum durations for drum categories (in seconds)
        this.drumMinDurations = {
            // Cymbals need to ring out
            49: 2.0, 57: 2.0, 55: 1.5, 52: 2.0,   // Crashes, Splash, China
            51: 1.0, 59: 1.0, 53: 0.8,               // Rides, Ride Bell
            46: 0.8,                                    // Open Hi-Hat
            // Toms benefit from slight sustain
            41: 0.4, 43: 0.4, 45: 0.35, 47: 0.3, 48: 0.3, 50: 0.25,
        };

        // Notes that use the reverb bus (cymbals)
        this.cymbalNotes = new Set([49, 51, 52, 53, 55, 57, 59, 46]);

        // Hi-hat choke groups: playing closed (42/44) cancels open (46)
        this.hihatCloseNotes = new Set([42, 44]);
        this.hihatOpenNote = 46;
    }

    /**
     * Create per-note drum preset map
     * Uses JCLive (bank 12) for most notes — superior cymbal samples
     * Falls back to SBLive (bank 0) where JCLive is unavailable
     */
    _createDrumPresetMap() {
        const base = 'https://surikov.github.io/webaudiofontdata/sound/';

        // GM percussion notes we need (35-81)
        // Format: note -> { file: '128XX_bank_soundfont.js', variable: '_drum_XX_bank_soundfont' }
        const map = {};

        // JCLive bank 12 — best quality for cymbals and general percussion
        const jcLiveNotes = [
            35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
            49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62,
            63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76,
            77, 78, 79, 80, 81
        ];

        for (const note of jcLiveNotes) {
            const key = `${note}_12_JCLive_sf2_file`;
            map[note] = {
                url: `${base}128${key}.js`,
                variable: `_drum_${key}`
            };
        }

        return map;
    }

    /**
     * Créer le mapping des 128 instruments GM vers les fichiers WebAudioFont
     * Utilise les sons de FluidR3_GM qui sont de bonne qualité
     */
    createGMInstrumentMap() {
        // Base URL pour les instruments
        const base = 'https://surikov.github.io/webaudiofontdata/sound/';

        // Mapping simplifié - utilise FluidR3_GM pour tous les instruments
        // Format: [url_sans_extension, nom_variable]
        const instruments = [
            // Piano (0-7)
            ['0000_FluidR3_GM_sf2_file', '_tone_0000_FluidR3_GM_sf2_file'],
            ['0010_FluidR3_GM_sf2_file', '_tone_0010_FluidR3_GM_sf2_file'],
            ['0020_FluidR3_GM_sf2_file', '_tone_0020_FluidR3_GM_sf2_file'],
            ['0030_FluidR3_GM_sf2_file', '_tone_0030_FluidR3_GM_sf2_file'],
            ['0040_FluidR3_GM_sf2_file', '_tone_0040_FluidR3_GM_sf2_file'],
            ['0050_FluidR3_GM_sf2_file', '_tone_0050_FluidR3_GM_sf2_file'],
            ['0060_FluidR3_GM_sf2_file', '_tone_0060_FluidR3_GM_sf2_file'],
            ['0070_FluidR3_GM_sf2_file', '_tone_0070_FluidR3_GM_sf2_file'],
            // Chromatic Percussion (8-15)
            ['0080_FluidR3_GM_sf2_file', '_tone_0080_FluidR3_GM_sf2_file'],
            ['0090_FluidR3_GM_sf2_file', '_tone_0090_FluidR3_GM_sf2_file'],
            ['0100_FluidR3_GM_sf2_file', '_tone_0100_FluidR3_GM_sf2_file'],
            ['0110_FluidR3_GM_sf2_file', '_tone_0110_FluidR3_GM_sf2_file'],
            ['0120_FluidR3_GM_sf2_file', '_tone_0120_FluidR3_GM_sf2_file'],
            ['0130_FluidR3_GM_sf2_file', '_tone_0130_FluidR3_GM_sf2_file'],
            ['0140_FluidR3_GM_sf2_file', '_tone_0140_FluidR3_GM_sf2_file'],
            ['0150_FluidR3_GM_sf2_file', '_tone_0150_FluidR3_GM_sf2_file'],
            // Organ (16-23)
            ['0160_FluidR3_GM_sf2_file', '_tone_0160_FluidR3_GM_sf2_file'],
            ['0170_FluidR3_GM_sf2_file', '_tone_0170_FluidR3_GM_sf2_file'],
            ['0180_FluidR3_GM_sf2_file', '_tone_0180_FluidR3_GM_sf2_file'],
            ['0190_FluidR3_GM_sf2_file', '_tone_0190_FluidR3_GM_sf2_file'],
            ['0200_FluidR3_GM_sf2_file', '_tone_0200_FluidR3_GM_sf2_file'],
            ['0210_FluidR3_GM_sf2_file', '_tone_0210_FluidR3_GM_sf2_file'],
            ['0220_FluidR3_GM_sf2_file', '_tone_0220_FluidR3_GM_sf2_file'],
            ['0230_FluidR3_GM_sf2_file', '_tone_0230_FluidR3_GM_sf2_file'],
            // Guitar (24-31)
            ['0240_FluidR3_GM_sf2_file', '_tone_0240_FluidR3_GM_sf2_file'],
            ['0250_FluidR3_GM_sf2_file', '_tone_0250_FluidR3_GM_sf2_file'],
            ['0260_FluidR3_GM_sf2_file', '_tone_0260_FluidR3_GM_sf2_file'],
            ['0270_FluidR3_GM_sf2_file', '_tone_0270_FluidR3_GM_sf2_file'],
            ['0280_FluidR3_GM_sf2_file', '_tone_0280_FluidR3_GM_sf2_file'],
            ['0290_FluidR3_GM_sf2_file', '_tone_0290_FluidR3_GM_sf2_file'],
            ['0300_FluidR3_GM_sf2_file', '_tone_0300_FluidR3_GM_sf2_file'],
            ['0310_FluidR3_GM_sf2_file', '_tone_0310_FluidR3_GM_sf2_file'],
            // Bass (32-39)
            ['0320_FluidR3_GM_sf2_file', '_tone_0320_FluidR3_GM_sf2_file'],
            ['0330_FluidR3_GM_sf2_file', '_tone_0330_FluidR3_GM_sf2_file'],
            ['0340_FluidR3_GM_sf2_file', '_tone_0340_FluidR3_GM_sf2_file'],
            ['0350_FluidR3_GM_sf2_file', '_tone_0350_FluidR3_GM_sf2_file'],
            ['0360_FluidR3_GM_sf2_file', '_tone_0360_FluidR3_GM_sf2_file'],
            ['0370_FluidR3_GM_sf2_file', '_tone_0370_FluidR3_GM_sf2_file'],
            ['0380_FluidR3_GM_sf2_file', '_tone_0380_FluidR3_GM_sf2_file'],
            ['0390_FluidR3_GM_sf2_file', '_tone_0390_FluidR3_GM_sf2_file'],
            // Strings (40-47)
            ['0400_FluidR3_GM_sf2_file', '_tone_0400_FluidR3_GM_sf2_file'],
            ['0410_FluidR3_GM_sf2_file', '_tone_0410_FluidR3_GM_sf2_file'],
            ['0420_FluidR3_GM_sf2_file', '_tone_0420_FluidR3_GM_sf2_file'],
            ['0430_FluidR3_GM_sf2_file', '_tone_0430_FluidR3_GM_sf2_file'],
            ['0440_FluidR3_GM_sf2_file', '_tone_0440_FluidR3_GM_sf2_file'],
            ['0450_FluidR3_GM_sf2_file', '_tone_0450_FluidR3_GM_sf2_file'],
            ['0460_FluidR3_GM_sf2_file', '_tone_0460_FluidR3_GM_sf2_file'],
            ['0470_FluidR3_GM_sf2_file', '_tone_0470_FluidR3_GM_sf2_file'],
            // Ensemble (48-55)
            ['0480_FluidR3_GM_sf2_file', '_tone_0480_FluidR3_GM_sf2_file'],
            ['0490_FluidR3_GM_sf2_file', '_tone_0490_FluidR3_GM_sf2_file'],
            ['0500_FluidR3_GM_sf2_file', '_tone_0500_FluidR3_GM_sf2_file'],
            ['0510_FluidR3_GM_sf2_file', '_tone_0510_FluidR3_GM_sf2_file'],
            ['0520_FluidR3_GM_sf2_file', '_tone_0520_FluidR3_GM_sf2_file'],
            ['0530_FluidR3_GM_sf2_file', '_tone_0530_FluidR3_GM_sf2_file'],
            ['0540_FluidR3_GM_sf2_file', '_tone_0540_FluidR3_GM_sf2_file'],
            ['0550_FluidR3_GM_sf2_file', '_tone_0550_FluidR3_GM_sf2_file'],
            // Brass (56-63)
            ['0560_FluidR3_GM_sf2_file', '_tone_0560_FluidR3_GM_sf2_file'],
            ['0570_FluidR3_GM_sf2_file', '_tone_0570_FluidR3_GM_sf2_file'],
            ['0580_FluidR3_GM_sf2_file', '_tone_0580_FluidR3_GM_sf2_file'],
            ['0590_FluidR3_GM_sf2_file', '_tone_0590_FluidR3_GM_sf2_file'],
            ['0600_FluidR3_GM_sf2_file', '_tone_0600_FluidR3_GM_sf2_file'],
            ['0610_FluidR3_GM_sf2_file', '_tone_0610_FluidR3_GM_sf2_file'],
            ['0620_FluidR3_GM_sf2_file', '_tone_0620_FluidR3_GM_sf2_file'],
            ['0630_FluidR3_GM_sf2_file', '_tone_0630_FluidR3_GM_sf2_file'],
            // Reed (64-71)
            ['0640_FluidR3_GM_sf2_file', '_tone_0640_FluidR3_GM_sf2_file'],
            ['0650_FluidR3_GM_sf2_file', '_tone_0650_FluidR3_GM_sf2_file'],
            ['0660_FluidR3_GM_sf2_file', '_tone_0660_FluidR3_GM_sf2_file'],
            ['0670_FluidR3_GM_sf2_file', '_tone_0670_FluidR3_GM_sf2_file'],
            ['0680_FluidR3_GM_sf2_file', '_tone_0680_FluidR3_GM_sf2_file'],
            ['0690_FluidR3_GM_sf2_file', '_tone_0690_FluidR3_GM_sf2_file'],
            ['0700_FluidR3_GM_sf2_file', '_tone_0700_FluidR3_GM_sf2_file'],
            ['0710_FluidR3_GM_sf2_file', '_tone_0710_FluidR3_GM_sf2_file'],
            // Pipe (72-79)
            ['0720_FluidR3_GM_sf2_file', '_tone_0720_FluidR3_GM_sf2_file'],
            ['0730_FluidR3_GM_sf2_file', '_tone_0730_FluidR3_GM_sf2_file'],
            ['0740_FluidR3_GM_sf2_file', '_tone_0740_FluidR3_GM_sf2_file'],
            ['0750_FluidR3_GM_sf2_file', '_tone_0750_FluidR3_GM_sf2_file'],
            ['0760_FluidR3_GM_sf2_file', '_tone_0760_FluidR3_GM_sf2_file'],
            ['0770_FluidR3_GM_sf2_file', '_tone_0770_FluidR3_GM_sf2_file'],
            ['0780_FluidR3_GM_sf2_file', '_tone_0780_FluidR3_GM_sf2_file'],
            ['0790_FluidR3_GM_sf2_file', '_tone_0790_FluidR3_GM_sf2_file'],
            // Synth Lead (80-87)
            ['0800_FluidR3_GM_sf2_file', '_tone_0800_FluidR3_GM_sf2_file'],
            ['0810_FluidR3_GM_sf2_file', '_tone_0810_FluidR3_GM_sf2_file'],
            ['0820_FluidR3_GM_sf2_file', '_tone_0820_FluidR3_GM_sf2_file'],
            ['0830_FluidR3_GM_sf2_file', '_tone_0830_FluidR3_GM_sf2_file'],
            ['0840_FluidR3_GM_sf2_file', '_tone_0840_FluidR3_GM_sf2_file'],
            ['0850_FluidR3_GM_sf2_file', '_tone_0850_FluidR3_GM_sf2_file'],
            ['0860_FluidR3_GM_sf2_file', '_tone_0860_FluidR3_GM_sf2_file'],
            ['0870_FluidR3_GM_sf2_file', '_tone_0870_FluidR3_GM_sf2_file'],
            // Synth Pad (88-95)
            ['0880_FluidR3_GM_sf2_file', '_tone_0880_FluidR3_GM_sf2_file'],
            ['0890_FluidR3_GM_sf2_file', '_tone_0890_FluidR3_GM_sf2_file'],
            ['0900_FluidR3_GM_sf2_file', '_tone_0900_FluidR3_GM_sf2_file'],
            ['0910_FluidR3_GM_sf2_file', '_tone_0910_FluidR3_GM_sf2_file'],
            ['0920_FluidR3_GM_sf2_file', '_tone_0920_FluidR3_GM_sf2_file'],
            ['0930_FluidR3_GM_sf2_file', '_tone_0930_FluidR3_GM_sf2_file'],
            ['0940_FluidR3_GM_sf2_file', '_tone_0940_FluidR3_GM_sf2_file'],
            ['0950_FluidR3_GM_sf2_file', '_tone_0950_FluidR3_GM_sf2_file'],
            // Synth Effects (96-103)
            ['0960_FluidR3_GM_sf2_file', '_tone_0960_FluidR3_GM_sf2_file'],
            ['0970_FluidR3_GM_sf2_file', '_tone_0970_FluidR3_GM_sf2_file'],
            ['0980_FluidR3_GM_sf2_file', '_tone_0980_FluidR3_GM_sf2_file'],
            ['0990_FluidR3_GM_sf2_file', '_tone_0990_FluidR3_GM_sf2_file'],
            ['1000_FluidR3_GM_sf2_file', '_tone_1000_FluidR3_GM_sf2_file'],
            ['1010_FluidR3_GM_sf2_file', '_tone_1010_FluidR3_GM_sf2_file'],
            ['1020_FluidR3_GM_sf2_file', '_tone_1020_FluidR3_GM_sf2_file'],
            ['1030_FluidR3_GM_sf2_file', '_tone_1030_FluidR3_GM_sf2_file'],
            // Ethnic (104-111)
            ['1040_FluidR3_GM_sf2_file', '_tone_1040_FluidR3_GM_sf2_file'],
            ['1050_FluidR3_GM_sf2_file', '_tone_1050_FluidR3_GM_sf2_file'],
            ['1060_FluidR3_GM_sf2_file', '_tone_1060_FluidR3_GM_sf2_file'],
            ['1070_FluidR3_GM_sf2_file', '_tone_1070_FluidR3_GM_sf2_file'],
            ['1080_FluidR3_GM_sf2_file', '_tone_1080_FluidR3_GM_sf2_file'],
            ['1090_FluidR3_GM_sf2_file', '_tone_1090_FluidR3_GM_sf2_file'],
            ['1100_FluidR3_GM_sf2_file', '_tone_1100_FluidR3_GM_sf2_file'],
            ['1110_FluidR3_GM_sf2_file', '_tone_1110_FluidR3_GM_sf2_file'],
            // Percussive (112-119)
            ['1120_FluidR3_GM_sf2_file', '_tone_1120_FluidR3_GM_sf2_file'],
            ['1130_FluidR3_GM_sf2_file', '_tone_1130_FluidR3_GM_sf2_file'],
            ['1140_FluidR3_GM_sf2_file', '_tone_1140_FluidR3_GM_sf2_file'],
            ['1150_FluidR3_GM_sf2_file', '_tone_1150_FluidR3_GM_sf2_file'],
            ['1160_FluidR3_GM_sf2_file', '_tone_1160_FluidR3_GM_sf2_file'],
            ['1170_FluidR3_GM_sf2_file', '_tone_1170_FluidR3_GM_sf2_file'],
            ['1180_FluidR3_GM_sf2_file', '_tone_1180_FluidR3_GM_sf2_file'],
            ['1190_FluidR3_GM_sf2_file', '_tone_1190_FluidR3_GM_sf2_file'],
            // Sound Effects (120-127)
            ['1200_FluidR3_GM_sf2_file', '_tone_1200_FluidR3_GM_sf2_file'],
            ['1210_FluidR3_GM_sf2_file', '_tone_1210_FluidR3_GM_sf2_file'],
            ['1220_FluidR3_GM_sf2_file', '_tone_1220_FluidR3_GM_sf2_file'],
            ['1230_FluidR3_GM_sf2_file', '_tone_1230_FluidR3_GM_sf2_file'],
            ['1240_FluidR3_GM_sf2_file', '_tone_1240_FluidR3_GM_sf2_file'],
            ['1250_FluidR3_GM_sf2_file', '_tone_1250_FluidR3_GM_sf2_file'],
            ['1260_FluidR3_GM_sf2_file', '_tone_1260_FluidR3_GM_sf2_file'],
            ['1270_FluidR3_GM_sf2_file', '_tone_1270_FluidR3_GM_sf2_file'],
        ];

        return instruments.map(([file, varName]) => ({
            url: base + file + '.js',
            variable: varName
        }));
    }

    /**
     * Initialiser le synthétiseur
     */
    async initialize() {
        if (this.isInitialized) return true;

        try {
            // Vérifier que WebAudioFont est chargé
            if (typeof WebAudioFontPlayer === 'undefined') {
                throw new Error('WebAudioFontPlayer not loaded');
            }

            // Créer le contexte audio
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // Créer le player WebAudioFont
            this.player = new WebAudioFontPlayer();

            // Setup drum audio bus with reverb for cymbals
            this._setupDrumBus();

            this.isInitialized = true;
            this.log('info', 'MidiSynthesizer initialized with WebAudioFont');

            return true;
        } catch (error) {
            this.log('error', 'Failed to initialize:', error);
            return false;
        }
    }

    /**
     * Charger un instrument
     * @param {number} program - Numéro de programme GM (0-127)
     */
    async loadInstrument(program) {
        if (program < 0 || program >= 128) {
            program = 0;
        }

        // Déjà chargé ?
        if (this.loadedInstruments.has(program)) {
            return this.loadedInstruments.get(program);
        }

        // En cours de chargement ?
        if (this.loadingInstruments.has(program)) {
            return this.loadingInstruments.get(program);
        }

        const instrumentInfo = this.gmInstrumentMap[program];

        const loadPromise = new Promise((resolve, reject) => {
            // Charger le script de l'instrument
            const script = document.createElement('script');
            script.src = instrumentInfo.url;
            script.onload = () => {
                const instrument = window[instrumentInfo.variable];
                if (instrument) {
                    // Ajuster les zones de l'instrument
                    this.player.adjustPreset(this.audioContext, instrument);
                    this.loadedInstruments.set(program, instrument);
                    this.loadingInstruments.delete(program);
                    this.log('info', `Loaded instrument ${program}: ${instrumentInfo.variable}`);
                    resolve(instrument);
                } else {
                    reject(new Error(`Instrument variable ${instrumentInfo.variable} not found`));
                }
            };
            script.onerror = () => {
                this.loadingInstruments.delete(program);
                reject(new Error(`Failed to load ${instrumentInfo.url}`));
            };
            document.head.appendChild(script);
        });

        this.loadingInstruments.set(program, loadPromise);
        return loadPromise;
    }

    /**
     * Load a single drum preset for a specific note
     */
    _loadDrumPreset(note) {
        if (this.drumPresets.has(note)) {
            return Promise.resolve(this.drumPresets.get(note));
        }

        const presetInfo = this.drumPresetMap[note];
        if (!presetInfo) {
            return Promise.resolve(null);
        }

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = presetInfo.url;
            script.onload = () => {
                const preset = window[presetInfo.variable];
                if (preset) {
                    this.player.adjustPreset(this.audioContext, preset);
                    this.drumPresets.set(note, preset);
                    resolve(preset);
                } else {
                    this.log('warn', `Drum preset variable ${presetInfo.variable} not found`);
                    resolve(null);
                }
            };
            script.onerror = () => {
                this.log('warn', `Failed to load drum preset for note ${note}`);
                resolve(null); // Don't reject — graceful degradation
            };
            document.head.appendChild(script);
        });
    }

    /**
     * Charger le kit de drums — loads per-note presets for all notes used in sequence
     */
    async loadDrumKit() {
        // Collect which drum notes are actually used in the sequence
        const usedNotes = new Set();
        if (this.sequence) {
            this.sequence.forEach(note => {
                if (note.c === 9) {
                    usedNotes.add(note.n);
                }
            });
        }

        // If no specific notes found, load the essential GM percussion set
        if (usedNotes.size === 0) {
            [35, 36, 38, 42, 44, 46, 49, 51].forEach(n => usedNotes.add(n));
        }

        this.log('info', `Loading ${usedNotes.size} individual drum presets (JCLive)`);

        const promises = [];
        for (const note of usedNotes) {
            if (this.drumPresetMap[note]) {
                promises.push(this._loadDrumPreset(note));
            }
        }

        await Promise.all(promises);

        // Set legacy drumKit flag for compatibility checks
        this.drumKit = this.drumPresets.size > 0 ? true : null;
        this.log('info', `Drum kit ready: ${this.drumPresets.size} presets loaded`);
    }

    /**
     * Précharger les instruments utilisés dans la séquence
     */
    async preloadInstruments() {
        const usedPrograms = new Set();
        let hasDrums = false;

        // Collecter les instruments utilisés
        this.sequence.forEach(note => {
            if (note.c === 9) {
                hasDrums = true;
            } else {
                const program = this.channelInstruments[note.c] || 0;
                usedPrograms.add(program);
            }
        });

        // Aussi vérifier les canaux configurés
        this.channelInstruments.forEach((program, channel) => {
            if (channel !== 9 && program !== undefined) {
                usedPrograms.add(program);
            }
        });

        // Si aucun instrument, charger le piano par défaut
        if (usedPrograms.size === 0) {
            usedPrograms.add(0);
        }

        this.log('info', `Preloading ${usedPrograms.size} instruments + ${hasDrums ? 'drums' : 'no drums'}`);

        const promises = [];

        usedPrograms.forEach(program => {
            promises.push(this.loadInstrument(program).catch(e => {
                this.log('warn', `Failed to load instrument ${program}:`, e.message);
            }));
        });

        if (hasDrums) {
            promises.push(this.loadDrumKit().catch(e => {
                this.log('warn', 'Failed to load drum kit:', e.message);
            }));
        }

        await Promise.all(promises);
        this.log('info', 'Instruments preloaded');
    }

    /**
     * Définir l'instrument pour un canal
     */
    setChannelInstrument(channel, program) {
        if (channel >= 0 && channel < 16) {
            this.channelInstruments[channel] = program;
        }
    }

    /**
     * Définir le volume d'un canal
     */
    setChannelVolume(channel, volume) {
        if (channel >= 0 && channel < 16) {
            this.channelVolumes[channel] = Math.max(0, Math.min(127, volume));
        }
    }

    /**
     * Convertir ticks en secondes
     */
    ticksToSeconds(ticks) {
        const beatsPerSecond = this.tempo / 60;
        const ticksPerSecond = beatsPerSecond * this.ticksPerBeat;
        return ticks / ticksPerSecond;
    }

    /**
     * Convertir secondes en ticks
     */
    secondsToTicks(seconds) {
        const beatsPerSecond = this.tempo / 60;
        const ticksPerSecond = beatsPerSecond * this.ticksPerBeat;
        return Math.round(seconds * ticksPerSecond);
    }

    /**
     * Charger une séquence
     */
    loadSequence(sequence, tempo = 120, ticksPerBeat = 480) {
        this.sequence = sequence.map(note => ({
            t: note.t,
            g: note.g,
            n: note.n,
            c: note.c || 0,
            v: note.v || 100
        }));

        this.tempo = tempo;
        this.ticksPerBeat = ticksPerBeat;

        this.sequence.sort((a, b) => a.t - b.t);

        let maxEndTick = 0;
        this.sequence.forEach(note => {
            const endTick = note.t + note.g;
            if (endTick > maxEndTick) maxEndTick = endTick;
        });

        this.endTick = maxEndTick;
        this.startTick = 0;
        this.currentTick = 0;

        this.log('info', `Sequence loaded: ${this.sequence.length} notes, ${this.ticksToSeconds(maxEndTick).toFixed(2)}s at ${tempo} BPM`);
    }

    /**
     * Définir la plage de lecture
     */
    setPlaybackRange(startTick, endTick) {
        this.startTick = Math.max(0, startTick);
        this.endTick = endTick;
        this.currentTick = this.startTick;
    }

    /**
     * Setup drum audio bus with lightweight reverb for cymbals
     * Creates: drums → dryGain → destination
     *          drums → reverbNode → wetGain → destination
     */
    _setupDrumBus() {
        const ctx = this.audioContext;

        // Dry path (all drums)
        this.drumDryGain = ctx.createGain();
        this.drumDryGain.gain.value = 1.0;
        this.drumDryGain.connect(ctx.destination);

        // Wet path (cymbals only — lightweight algorithmic reverb)
        this.drumReverbGain = ctx.createGain();
        this.drumReverbGain.gain.value = 0.18; // Subtle reverb

        try {
            // Generate a short impulse response algorithmically (no external file)
            const sampleRate = ctx.sampleRate;
            const length = sampleRate * 1.2; // 1.2s reverb tail
            const impulse = ctx.createBuffer(2, length, sampleRate);

            for (let ch = 0; ch < 2; ch++) {
                const data = impulse.getChannelData(ch);
                for (let i = 0; i < length; i++) {
                    // Exponential decay with random noise
                    const decay = Math.exp(-3.5 * i / length);
                    data[i] = (Math.random() * 2 - 1) * decay;
                }
            }

            this.drumReverbNode = ctx.createConvolver();
            this.drumReverbNode.buffer = impulse;
            this.drumReverbNode.connect(this.drumReverbGain);
            this.drumReverbGain.connect(ctx.destination);

            this.log('info', 'Drum reverb bus initialized');
        } catch (error) {
            this.log('warn', 'Failed to create drum reverb, using dry only:', error.message);
            this.drumReverbNode = null;
        }
    }

    /**
     * Jouer une note
     */
    playNote(note, velocity, channel, duration, time = null) {
        if (!this.isInitialized || !this.player) return;

        const startTime = time || this.audioContext.currentTime;

        let volume;
        if (channel === 9) {
            // Non-linear velocity curve for drums — cymbals get extra boost
            const velNorm = velocity / 127;
            const velCurve = Math.pow(velNorm, 0.7); // Exponential: louder hits stand out more
            const boost = this.cymbalNotes.has(note) ? 1.25 : 1.0;
            volume = velCurve * (this.channelVolumes[channel] / 127) * boost;
        } else {
            volume = (velocity / 127) * (this.channelVolumes[channel] / 127);
        }

        let instrument;
        if (channel === 9) {
            instrument = this.drumPresets.get(note);
        } else {
            const program = this.channelInstruments[channel] || 0;
            instrument = this.loadedInstruments.get(program);
        }

        if (!instrument) {
            return;
        }

        try {
            // For drums: apply minimum durations and hi-hat choke
            let effectiveDuration = duration;
            let outputNode = this.audioContext.destination;

            if (channel === 9) {
                // Minimum duration for cymbals/toms
                const minDur = this.drumMinDurations[note];
                if (minDur && effectiveDuration < minDur) {
                    effectiveDuration = minDur;
                }

                // Hi-hat choke: closed hi-hat cancels open hi-hat
                if (this.hihatCloseNotes.has(note)) {
                    const openEnvelope = this.drumActiveNotes.get(this.hihatOpenNote);
                    if (openEnvelope && typeof openEnvelope.cancel === 'function') {
                        try { openEnvelope.cancel(); } catch (e) { /* ignore */ }
                    }
                    this.drumActiveNotes.delete(this.hihatOpenNote);
                }

                // Route cymbals through reverb bus, others through dry bus
                if (this.cymbalNotes.has(note) && this.drumReverbNode) {
                    outputNode = this.drumDryGain; // Dry signal
                    // Also send to reverb (wet signal)
                    const reverbEnvelope = this.player.queueWaveTable(
                        this.audioContext,
                        this.drumReverbNode,
                        instrument,
                        startTime,
                        note,
                        effectiveDuration,
                        volume * 0.6 // Lower volume for reverb send
                    );
                    if (reverbEnvelope) {
                        this.activeEnvelopes.push(reverbEnvelope);
                    }
                } else if (this.drumDryGain) {
                    outputNode = this.drumDryGain;
                }
            }

            const envelope = this.player.queueWaveTable(
                this.audioContext,
                outputNode,
                instrument,
                startTime,
                note,
                effectiveDuration,
                volume
            );

            if (envelope) {
                this.activeEnvelopes.push(envelope);
                // Track drum envelopes for hi-hat choke
                if (channel === 9) {
                    this.drumActiveNotes.set(note, envelope);
                }
            }
        } catch (error) {
            // Ignorer les erreurs silencieusement
        }
    }

    /**
     * Démarrer la lecture
     */
    async play() {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) return;
        }

        // Reprendre le contexte si suspendu
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        // Précharger les instruments
        await this.preloadInstruments();

        if (this.isPaused) {
            this.isPaused = false;
            this.startTime = this.audioContext.currentTime - this.ticksToSeconds(this.currentTick - this.startTick);
        } else {
            this.currentTick = this.startTick;
            this.startTime = this.audioContext.currentTime;
            this.lastScheduledTick = this.startTick;
        }

        this.isPlaying = true;
        this.startScheduler();

        // DEBUG: Log timing info at start
        console.log(`[Synth DEBUG] Play started: startTime=${this.startTime.toFixed(3)}, audioCtx.currentTime=${this.audioContext.currentTime.toFixed(3)}, tempo=${this.tempo}, ticksPerBeat=${this.ticksPerBeat}`);
        if (this.sequence.length > 0) {
            const firstNote = this.sequence[0];
            const firstNoteTime = this.ticksToSeconds(firstNote.t - this.startTick);
            console.log(`[Synth DEBUG] First note: tick=${firstNote.t}, time=${firstNoteTime.toFixed(3)}s, scheduledAt=${(this.startTime + firstNoteTime).toFixed(3)}`);
        }

        this.log('info', `Playback started at tick ${this.currentTick}`);
    }

    /**
     * Pause
     */
    pause() {
        if (!this.isPlaying) return;

        this.isPlaying = false;
        this.isPaused = true;
        this.stopScheduler();
        this.cancelAllNotes();

        this.log('info', `Playback paused at tick ${this.currentTick}`);
    }

    /**
     * Stop
     */
    stop() {
        this.isPlaying = false;
        this.isPaused = false;
        this.stopScheduler();
        this.cancelAllNotes();
        this.currentTick = this.startTick;
        this.lastScheduledTick = this.startTick;

        if (this.onTickUpdate) {
            this.onTickUpdate(this.currentTick);
        }

        this.log('info', 'Playback stopped');
    }

    /**
     * Muter un canal
     * @param {number} channel - Numéro du canal (0-15)
     */
    muteChannel(channel) {
        this.mutedChannels.add(channel);
        this.log('debug', `Channel ${channel} muted`);
    }

    /**
     * Démuter un canal
     * @param {number} channel - Numéro du canal (0-15)
     */
    unmuteChannel(channel) {
        this.mutedChannels.delete(channel);
        this.log('debug', `Channel ${channel} unmuted`);
    }

    /**
     * Définir les canaux mutés
     * @param {Set|Array} channels - Canaux à muter
     */
    setMutedChannels(channels) {
        this.mutedChannels = new Set(channels);
        this.log('debug', `Muted channels set to: ${Array.from(this.mutedChannels).join(', ')}`);
    }

    /**
     * Vérifier si un canal est muté
     * @param {number} channel - Numéro du canal
     * @returns {boolean}
     */
    isChannelMuted(channel) {
        return this.mutedChannels.has(channel);
    }

    /**
     * Annuler toutes les notes en cours
     */
    cancelAllNotes() {
        this.activeEnvelopes.forEach(envelope => {
            try {
                if (envelope && typeof envelope.cancel === 'function') {
                    envelope.cancel();
                }
            } catch (e) {
                // Ignorer
            }
        });
        this.activeEnvelopes = [];
        this.drumActiveNotes.clear();
    }

    /**
     * Seek
     */
    seek(tick) {
        const wasPlaying = this.isPlaying;
        if (wasPlaying) this.pause();

        this.currentTick = Math.max(this.startTick, Math.min(tick, this.endTick));
        this.lastScheduledTick = this.currentTick;

        if (this.onTickUpdate) {
            this.onTickUpdate(this.currentTick);
        }

        if (wasPlaying) {
            // Keep isPaused=true (set by pause()) so play() takes the resume path
            // and preserves currentTick instead of resetting to startTick
            this.play();
        }
    }

    /**
     * Démarrer le scheduler
     */
    startScheduler() {
        if (this.schedulerInterval) clearInterval(this.schedulerInterval);
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);

        this.schedulerInterval = setInterval(() => this.scheduleNotes(), 50);

        const updateCursor = () => {
            if (this.isPlaying) {
                const currentTime = this.audioContext.currentTime;
                const elapsedTime = currentTime - this.startTime;
                this.currentTick = this.startTick + this.secondsToTicks(elapsedTime);

                if (this.onTickUpdate) {
                    this.onTickUpdate(this.currentTick);
                }

                this.animationFrame = requestAnimationFrame(updateCursor);
            }
        };
        this.animationFrame = requestAnimationFrame(updateCursor);
    }

    /**
     * Arrêter le scheduler
     */
    stopScheduler() {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
        }
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    /**
     * Planifier les notes
     */
    scheduleNotes() {
        if (!this.isPlaying) return;

        const currentTime = this.audioContext.currentTime;
        const elapsedTime = currentTime - this.startTime;
        const currentTick = this.startTick + this.secondsToTicks(elapsedTime);

        if (currentTick >= this.endTick) {
            this.stop();
            if (this.onPlaybackEnd) this.onPlaybackEnd();
            return;
        }

        const scheduleEndTime = currentTime + this.scheduleAheadTime;
        const scheduleEndTick = this.startTick + this.secondsToTicks(scheduleEndTime - this.startTime);

        for (const note of this.sequence) {
            if (note.t < this.startTick) continue;
            if (note.t > this.endTick) break;

            // Ignorer les canaux mutés
            if (this.mutedChannels.has(note.c)) continue;

            if (note.t > this.lastScheduledTick && note.t <= scheduleEndTick) {
                const noteStartTime = this.startTime + this.ticksToSeconds(note.t - this.startTick);
                const noteDuration = this.ticksToSeconds(note.g);
                this.playNote(note.n, note.v, note.c, noteDuration, noteStartTime);
            }
        }

        this.lastScheduledTick = Math.max(this.lastScheduledTick, scheduleEndTick);

        // Periodic cleanup: cap active envelopes to prevent unbounded growth
        // Keep only the most recent 200 envelopes (older ones have likely finished)
        if (this.activeEnvelopes.length > 200) {
            this.activeEnvelopes = this.activeEnvelopes.slice(-200);
        }
    }

    /**
     * Libérer les ressources
     */
    dispose() {
        this.stop();
        this.cancelAllNotes();

        // Disconnect drum bus nodes
        if (this.drumDryGain) { try { this.drumDryGain.disconnect(); } catch(e) {} }
        if (this.drumReverbGain) { try { this.drumReverbGain.disconnect(); } catch(e) {} }
        if (this.drumReverbNode) { try { this.drumReverbNode.disconnect(); } catch(e) {} }
        this.drumDryGain = null;
        this.drumReverbGain = null;
        this.drumReverbNode = null;
        this.drumActiveNotes.clear();

        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }

        this.audioContext = null;
        this.player = null;
        this.loadedInstruments.clear();
        this.drumKit = null;
        this.drumPresets.clear();
        this.isInitialized = false;

        this.log('info', 'MidiSynthesizer disposed');
    }

    /**
     * Logger
     */
    log(level, ...args) {
        if (this.logger && typeof this.logger[level] === 'function') {
            this.logger[level]('[MidiSynthesizer]', ...args);
        } else {
            console[level]('[MidiSynthesizer]', ...args);
        }
    }
}

// Export
window.MidiSynthesizer = MidiSynthesizer;
