// ============================================================================
// File: public/js/audio/MidiSynthesizer.js
// Version: v2.0.0 - MIDI Synthesizer with WebAudioFont (real samples)
// Description: Browser-based MIDI player with high-quality sounds
// ============================================================================

// Constants extracted to MidiSynthesizerConstants.js (P2-F.8).
// Loaded earlier in index.html so window.MidiSynthesizerConstants is available.
const { SOUND_BANKS, DEFAULT_BANK_ID, DEFAULT_BANK_SUFFIX } = window.MidiSynthesizerConstants;

/**
 * MidiSynthesizer - MIDI synthesizer using WebAudioFont
 * Uses real samples for professional-quality rendering
 */
class MidiSynthesizer {
    // Live instances (used by broadcastBankEffects to keep every
    // synth — MIDI editor, AudioPreview, etc. — in sync when the
    // user moves an effects slider in the Settings modal).
    static _instances = new Set();

    /**
     * Apply a set of bank-effect values to every live MidiSynthesizer.
     * @param {Object|null} effects - `{reverb_mix, reverb_decay_s,
     *   echo_mix, echo_time_ms, echo_feedback}` or null for defaults.
     */
    static broadcastBankEffects(effects) {
        for (const inst of MidiSynthesizer._instances) {
            try { inst.applyBankEffects(effects); } catch (e) { /* ignore */ }
        }
    }

    constructor() {
        this.audioContext = null;
        this.player = null;
        this.isInitialized = false;
        this.isPlaying = false;
        this.isPaused = false;

        // Playback state
        this.currentTick = 0;
        this.startTick = 0;
        this.endTick = 0;
        this.startTime = 0;

        // Tempo and timing
        this.tempo = 120; // BPM
        this.ticksPerBeat = 480; // PPQ standard
        this.tempoMap = []; // [{ticks, tempo, timeSeconds}] - tempo map sorted by ticks
        this._ticksPerSecond = (120 / 60) * 480; // Cached conversion factor
        this._secondsPerTick = 1 / this._ticksPerSecond;

        // Channels and instruments
        this.channelInstruments = new Array(16).fill(0);
        this.channelVolumes = new Array(16).fill(100);
        this.mutedChannels = new Set(); // Muted channels

        // Loaded instruments (cache)
        this.loadedInstruments = new Map(); // program -> instrument data
        this.loadingInstruments = new Map(); // program -> Promise

        // Scheduler
        this.schedulerInterval = null;
        this.animationFrame = null;
        this.scheduleAheadTime = 0.2; // 200ms of lookahead
        this.lastScheduledTick = 0;
        this.schedulePointer = 0; // Index into sorted sequence for O(1) scheduling

        // Active notes so we can stop them
        this.activeEnvelopes = [];

        // Callbacks
        this.onTickUpdate = null;
        this.onPlaybackEnd = null;

        // Sequence
        this.sequence = [];

        // Logger
        this.logger = window.logger || console;

        // Current sound bank (read from localStorage)
        const savedBank = MidiSynthesizer.getSavedBank();
        const bankInfo = SOUND_BANKS.find(b => b.id === savedBank);
        this.currentBankId = bankInfo ? bankInfo.id : DEFAULT_BANK_ID;
        this.currentBankSuffix = bankInfo ? bankInfo.suffix : DEFAULT_BANK_SUFFIX;
        this._pendingBankSwitch = null;

        // General MIDI to WebAudioFont mapping
        // Format: [file, variable] for each GM program (0-127)
        this.gmInstrumentMap = this.createGMInstrumentMap(this.currentBankSuffix);

        // Drums (channel 9) — per-note presets from JCLive (better cymbals)
        // Fallback to SBLive for notes not in JCLive
        this.drumKit = null; // Legacy single-kit (unused, kept for compat)
        this.drumPresets = new Map(); // note → loaded preset
        this.drumPresetMap = this._createDrumPresetMap();

        // Drum audio processing
        this.drumReverbNode = null;     // ConvolverNode for cymbal reverb
        this.drumReverbGain = null;     // Wet gain for reverb
        this.drumDryGain = null;        // Dry gain for drums
        this.drumActiveNotes = new Map(); // note -> envelope (for hi-hat choke)

        // Echo / delay bus (shared by melody + drums)
        this.echoDelayNode = null;
        this.echoFeedbackGain = null;
        this.echoWetGain = null;

        // Last-applied effect values. `reverb_mix = null` means "use the
        // current bank's built-in reverbMix". Populated when applyBankEffects()
        // is called by SettingsModal after hydrating from the server.
        this.bankEffects = {
            reverb_mix: null,
            reverb_decay_s: 1.2,
            echo_mix: 0.0,
            echo_time_ms: 250,
            echo_feedback: 0.3
        };

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

        MidiSynthesizer._instances.add(this);
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
     * Create the mapping of the 128 GM instruments to WebAudioFont files
     * @param {string} bankSuffix - Sound bank suffix (e.g. 'FluidR3_GM_sf2_file')
     */
    createGMInstrumentMap(bankSuffix = DEFAULT_BANK_SUFFIX) {
        const base = 'https://surikov.github.io/webaudiofontdata/sound/';
        const instruments = [];
        for (let program = 0; program < 128; program++) {
            const num = String(program * 10).padStart(4, '0');
            const file = `${num}_${bankSuffix}`;
            instruments.push({
                url: `${base}${file}.js`,
                variable: `_tone_${file}`
            });
        }
        return instruments;
    }

    /**
     * Change the sound bank
     * @param {string} bankId - Bank identifier (e.g. 'FluidR3_GM', 'Aspirin')
     * @returns {boolean} true if the change is accepted
     */
    setSoundBank(bankId) {
        const bank = SOUND_BANKS.find(b => b.id === bankId);
        if (!bank) {
            this.log('warn', `Unknown sound bank: ${bankId}`);
            return false;
        }
        if (bank.id === this.currentBankId) return true;

        if (this.isPlaying) {
            this._pendingBankSwitch = bank;
            this.log('info', `Bank switch to ${bank.id} deferred until playback stops`);
            return true;
        }

        this._applyBankSwitch(bank);
        return true;
    }

    /**
     * Apply the sound bank change (internal)
     */
    _applyBankSwitch(bank) {
        this.log('info', `Switching sound bank to ${bank.id}`);
        this._clearInstrumentCache();
        this.currentBankId = bank.id;
        this.currentBankSuffix = bank.suffix;
        this.gmInstrumentMap = this.createGMInstrumentMap(bank.suffix);

        // Reset the saved reverb_mix so applyBankEffects(null) would fall
        // back to the new bank's built-in default. External listeners
        // (SettingsModal) will fetch the DB overrides for the new bank
        // via the bank_changed hook and call applyBankEffects() with the
        // persisted row (if any).
        this.bankEffects.reverb_mix = null;
        const reverbMix = bank.reverbMix ?? 0.12;
        if (this.melodyReverbGain) {
            this.melodyReverbGain.gain.value = reverbMix;
        }

        this.log('info', `Sound bank switched to ${bank.id} (reverbMix=${reverbMix})`);

        if (typeof this.onBankChanged === 'function') {
            try { this.onBankChanged(bank.id); } catch (e) { /* ignore */ }
        }
    }

    /**
     * Clear the cache of loaded melodic instruments
     */
    _clearInstrumentCache() {
        this.loadedInstruments.clear();
        this.loadingInstruments.clear();
        // Remove old melodic <script> elements to free memory
        const scripts = document.querySelectorAll('script[src*="surikov.github.io/webaudiofontdata/sound/"]');
        scripts.forEach(s => {
            // Only remove melodic scripts (not drums which start with /128)
            if (!s.src.includes('/128')) {
                s.remove();
            }
        });
    }

    /**
     * Read the sound bank saved in localStorage
     * @returns {string} The saved bank identifier
     */
    static getSavedBank() {
        try {
            const saved = localStorage.getItem('gmboop_settings');
            if (saved) {
                const parsed = JSON.parse(saved);
                return parsed.soundBank || DEFAULT_BANK_ID;
            }
        } catch (e) { /* ignore */ }
        return DEFAULT_BANK_ID;
    }

    /**
     * Get the list of available sound banks
     * @returns {Array} List of banks {id, label, suffix}
     */
    static getAvailableBanks() {
        return SOUND_BANKS;
    }

    /**
     * Initialize the synthesizer
     */
    async initialize() {
        if (this.isInitialized) return true;

        try {
            // Check that WebAudioFont is loaded
            if (typeof WebAudioFontPlayer === 'undefined') {
                throw new Error('WebAudioFontPlayer not loaded');
            }

            // Create the audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // Create the WebAudioFont player
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
     * Load an instrument
     * @param {number} program - GM program number (0-127)
     */
    async loadInstrument(program) {
        if (program < 0 || program >= 128) {
            program = 0;
        }

        // Already loaded?
        if (this.loadedInstruments.has(program)) {
            return this.loadedInstruments.get(program);
        }

        // Currently loading?
        if (this.loadingInstruments.has(program)) {
            return this.loadingInstruments.get(program);
        }

        const instrumentInfo = this.gmInstrumentMap[program];

        const loadPromise = new Promise((resolve, reject) => {
            // Load the instrument script
            const script = document.createElement('script');
            script.src = instrumentInfo.url;
            script.onload = () => {
                const instrument = window[instrumentInfo.variable];
                if (instrument) {
                    // Adjust the instrument zones
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
                // Fallback to FluidR3_GM if the current bank doesn't have this instrument
                if (this.currentBankId !== DEFAULT_BANK_ID) {
                    this.log('warn', `Bank ${this.currentBankId} missing program ${program}, falling back to ${DEFAULT_BANK_ID}`);
                    const num = String(program * 10).padStart(4, '0');
                    const fallbackFile = `${num}_${DEFAULT_BANK_SUFFIX}`;
                    const fallbackScript = document.createElement('script');
                    fallbackScript.src = `https://surikov.github.io/webaudiofontdata/sound/${fallbackFile}.js`;
                    fallbackScript.onload = () => {
                        const fallbackInstrument = window[`_tone_${fallbackFile}`];
                        if (fallbackInstrument) {
                            this.player.adjustPreset(this.audioContext, fallbackInstrument);
                            this.loadedInstruments.set(program, fallbackInstrument);
                            resolve(fallbackInstrument);
                        } else {
                            reject(new Error(`Fallback instrument variable _tone_${fallbackFile} not found`));
                        }
                    };
                    fallbackScript.onerror = () => reject(new Error(`Failed to load fallback for program ${program}`));
                    document.head.appendChild(fallbackScript);
                } else {
                    reject(new Error(`Failed to load ${instrumentInfo.url}`));
                }
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

        return new Promise((resolve, _reject) => {
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
     * Load the drum kit — loads per-note presets for all notes used in sequence
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
     * Preload the instruments used in the sequence
     */
    async preloadInstruments() {
        const usedPrograms = new Set();
        let hasDrums = false;

        // Collect used instruments
        this.sequence.forEach(note => {
            if (note.c === 9) {
                hasDrums = true;
            } else {
                const program = this.channelInstruments[note.c] || 0;
                usedPrograms.add(program);
            }
        });

        // Also check configured channels
        this.channelInstruments.forEach((program, channel) => {
            if (channel !== 9 && program !== undefined) {
                usedPrograms.add(program);
            }
        });

        // If no instrument, load the default piano
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
     * Non-blocking preload: kick off loads for missing instruments but don't await.
     * Returns true if all instruments are already cached (instant start).
     */
    _preloadNonBlocking() {
        const usedPrograms = new Set();
        let hasDrums = false;
        for (const note of this.sequence) {
            if (note.c === 9) hasDrums = true;
            else usedPrograms.add(this.channelInstruments[note.c] || 0);
        }
        if (usedPrograms.size === 0) usedPrograms.add(0);

        let allLoaded = true;
        for (const program of usedPrograms) {
            if (!this.loadedInstruments.has(program)) {
                allLoaded = false;
                this.loadInstrument(program).catch(e =>
                    this.log('warn', `Background load failed for ${program}:`, e.message)
                );
            }
        }
        if (hasDrums && this.drumPresets.size === 0) {
            allLoaded = false;
            this.loadDrumKit().catch(e =>
                this.log('warn', 'Background drum load failed:', e.message)
            );
        }
        return allLoaded;
    }

    /**
     * Set the instrument for a channel
     */
    setChannelInstrument(channel, program) {
        if (channel >= 0 && channel < 16) {
            this.channelInstruments[channel] = program;
        }
    }

    /**
     * Set the volume of a channel
     */
    setChannelVolume(channel, volume) {
        if (channel >= 0 && channel < 16) {
            this.channelVolumes[channel] = Math.max(0, Math.min(127, volume));
        }
    }

    /**
     * Convert ticks to seconds (with tempo map support)
     */
    ticksToSeconds(ticks) {
        return window.MidiSynthesizerTempoMap.ticksToSeconds({
            ticks,
            tempoMap: this.tempoMap,
            ticksPerBeat: this.ticksPerBeat,
            secondsPerTick: this._secondsPerTick
        });
    }

    /**
     * Convert seconds to ticks (with tempo map support)
     */
    secondsToTicks(seconds) {
        return window.MidiSynthesizerTempoMap.secondsToTicks({
            seconds,
            tempoMap: this.tempoMap,
            ticksPerBeat: this.ticksPerBeat,
            ticksPerSecond: this._ticksPerSecond
        });
    }

    /**
     * Load a sequence
     */
    loadSequence(sequence, tempo = 120, ticksPerBeat = 480, tempoEvents = null) {
        // Normalize defaults in-place (callers pass disposable arrays)
        for (let i = 0; i < sequence.length; i++) {
            const note = sequence[i];
            if (!note.c) note.c = 0;
            if (!note.v) note.v = 100;
        }
        this.sequence = sequence;

        this.tempo = tempo;
        this.ticksPerBeat = ticksPerBeat;

        // Cache conversion factors for the fast path (no tempo map)
        this._ticksPerSecond = (tempo / 60) * ticksPerBeat;
        this._secondsPerTick = 1 / this._ticksPerSecond;

        // Build the tempo map from tempo events
        if (tempoEvents && tempoEvents.length > 0) {
            this.tempoMap = tempoEvents
                .map(e => ({ ticks: e.ticks, tempo: e.tempo }))
                .sort((a, b) => a.ticks - b.ticks);
        } else {
            this.tempoMap = [];
        }

        this.sequence.sort((a, b) => a.t - b.t);

        let maxEndTick = 0;
        this.sequence.forEach(note => {
            const endTick = note.t + note.g;
            if (endTick > maxEndTick) maxEndTick = endTick;
        });

        this.endTick = maxEndTick;
        this.startTick = 0;
        this.currentTick = 0;
        this.schedulePointer = 0;

        this.log('info', `Sequence loaded: ${this.sequence.length} notes, ${this.ticksToSeconds(maxEndTick).toFixed(2)}s at ${tempo} BPM${this.tempoMap.length > 0 ? `, ${this.tempoMap.length} tempo changes` : ''}`);
    }

    /**
     * Set the playback range
     */
    setPlaybackRange(startTick, endTick) {
        this.startTick = Math.max(0, startTick);
        this.endTick = endTick;
        this.currentTick = this.startTick;
    }

    /**
     * Generate an exponential-decay white-noise impulse response.
     * Decay length drives the reverb tail duration.
     */
    _generateImpulseBuffer(decaySeconds) {
        const ctx = this.audioContext;
        if (!ctx) return null;
        try {
            const sampleRate = ctx.sampleRate;
            const length = Math.max(1, Math.floor(sampleRate * decaySeconds));
            const buffer = ctx.createBuffer(2, length, sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < length; i++) {
                    const decay = Math.exp(-3.5 * i / length);
                    data[i] = (Math.random() * 2 - 1) * decay;
                }
            }
            return buffer;
        } catch (error) {
            this.log('warn', 'Failed to generate reverb impulse:', error.message);
            return null;
        }
    }

    /**
     * Rebuild the convolver impulse response when reverb decay changes.
     * Both the drum and melody convolvers share the same buffer.
     */
    _regenerateReverbIR(decaySeconds) {
        const buffer = this._generateImpulseBuffer(decaySeconds);
        if (!buffer) return;
        if (this.drumReverbNode) {
            try { this.drumReverbNode.buffer = buffer; } catch (e) { /* ignore */ }
        }
        if (this.melodyReverbNode) {
            try { this.melodyReverbNode.buffer = buffer; } catch (e) { /* ignore */ }
        }
        this.bankEffects.reverb_decay_s = decaySeconds;
    }

    /**
     * Setup audio buses with reverb for drums and melodic instruments.
     * Drums: dedicated convolver for cymbals (fixed gain).
     * Melody: separate convolver with per-bank reverbMix to normalize
     * perceived reverb across sound banks (some have reverb baked in samples).
     */
    _setupDrumBus() {
        const ctx = this.audioContext;

        // Use the currently configured decay (bankEffects may have been
        // hydrated from the server before initialize() runs; otherwise
        // the constructor default of 1.2s applies).
        const decay = this.bankEffects.reverb_decay_s ?? 1.2;
        const impulseBuffer = this._generateImpulseBuffer(decay);

        // --- Drum bus (unchanged behavior) ---
        this.drumDryGain = ctx.createGain();
        this.drumDryGain.gain.value = 1.0;
        this.drumDryGain.connect(ctx.destination);

        this.drumReverbGain = ctx.createGain();
        this.drumReverbGain.gain.value = 0.18;

        if (impulseBuffer) {
            try {
                this.drumReverbNode = ctx.createConvolver();
                this.drumReverbNode.buffer = impulseBuffer;
                this.drumReverbNode.connect(this.drumReverbGain);
                this.drumReverbGain.connect(ctx.destination);
            } catch (error) {
                this.log('warn', 'Failed to create drum reverb:', error.message);
                this.drumReverbNode = null;
            }
        }

        // --- Melody bus (per-bank reverb normalization) ---
        const bankInfo = SOUND_BANKS.find(b => b.id === this.currentBankId);
        const reverbMix = this.bankEffects.reverb_mix ?? bankInfo?.reverbMix ?? 0.12;

        this.melodyDryGain = ctx.createGain();
        this.melodyDryGain.gain.value = 1.0;
        this.melodyDryGain.connect(ctx.destination);

        this.melodyReverbGain = ctx.createGain();
        this.melodyReverbGain.gain.value = reverbMix;
        this.melodyReverbNode = null;

        if (impulseBuffer) {
            try {
                this.melodyReverbNode = ctx.createConvolver();
                this.melodyReverbNode.buffer = impulseBuffer;
                this.melodyReverbNode.connect(this.melodyReverbGain);
                this.melodyReverbGain.connect(ctx.destination);
            } catch (error) {
                this.log('warn', 'Failed to create melody reverb:', error.message);
                this.melodyReverbNode = null;
            }
        }

        // --- Echo / delay bus (shared by melody + drums) ---
        this._setupEchoBus();

        this.log('info', `Audio bus initialized (melody reverbMix=${reverbMix} for bank ${this.currentBankId})`);
    }

    /**
     * Setup a simple feedback-delay bus. Routing is opt-in per note:
     * playNote() only sends the signal to echoDelayNode when the wet
     * gain is above zero (set via applyBankEffects).
     */
    _setupEchoBus() {
        const ctx = this.audioContext;
        try {
            this.echoDelayNode = ctx.createDelay(2.0); // 2s hard cap
            const timeMs = this.bankEffects.echo_time_ms ?? 250;
            this.echoDelayNode.delayTime.value = timeMs / 1000;

            this.echoFeedbackGain = ctx.createGain();
            this.echoFeedbackGain.gain.value = this.bankEffects.echo_feedback ?? 0.3;

            this.echoWetGain = ctx.createGain();
            this.echoWetGain.gain.value = this.bankEffects.echo_mix ?? 0.0;

            // Feedback loop: delay -> feedback gain -> delay
            this.echoDelayNode.connect(this.echoFeedbackGain);
            this.echoFeedbackGain.connect(this.echoDelayNode);

            // Wet output: delay -> wet gain -> destination
            this.echoDelayNode.connect(this.echoWetGain);
            this.echoWetGain.connect(ctx.destination);
        } catch (error) {
            this.log('warn', 'Failed to create echo bus:', error.message);
            this.echoDelayNode = null;
            this.echoFeedbackGain = null;
            this.echoWetGain = null;
        }
    }

    /**
     * Apply a set of effect parameters (reverb + echo) to the live
     * audio graph. Called on startup, on bank switch, and whenever the
     * user moves a slider in the settings modal.
     *
     * Any field missing from `effects` falls back to the current bank's
     * built-in default (for reverb_mix) or to a safe default (others).
     *
     * @param {Object|null} effects - Server row from `bank_effects`,
     *   or null to reset to bank defaults.
     */
    applyBankEffects(effects) {
        const bank = SOUND_BANKS.find(b => b.id === this.currentBankId);
        const defaultReverbMix = bank?.reverbMix ?? 0.12;

        const src = effects || {};
        const reverbMix = src.reverb_mix !== undefined && src.reverb_mix !== null
            ? Number(src.reverb_mix) : defaultReverbMix;
        const reverbDecay = src.reverb_decay_s !== undefined && src.reverb_decay_s !== null
            ? Number(src.reverb_decay_s) : 1.2;
        const echoMix = src.echo_mix !== undefined && src.echo_mix !== null
            ? Number(src.echo_mix) : 0.0;
        const echoTimeMs = src.echo_time_ms !== undefined && src.echo_time_ms !== null
            ? Number(src.echo_time_ms) : 250;
        const echoFeedback = src.echo_feedback !== undefined && src.echo_feedback !== null
            ? Number(src.echo_feedback) : 0.3;

        if (this.melodyReverbGain) {
            this.melodyReverbGain.gain.value = reverbMix;
        }

        // Only regenerate the IR when the change is perceptible — recreating
        // a convolver buffer mid-playback is cheap but not free.
        if (Math.abs(reverbDecay - (this.bankEffects.reverb_decay_s ?? 1.2)) > 0.05) {
            this._regenerateReverbIR(reverbDecay);
        }

        if (this.echoDelayNode) {
            this.echoDelayNode.delayTime.value = echoTimeMs / 1000;
        }
        if (this.echoFeedbackGain) {
            this.echoFeedbackGain.gain.value = echoFeedback;
        }
        if (this.echoWetGain) {
            this.echoWetGain.gain.value = echoMix;
        }

        this.bankEffects = {
            reverb_mix: reverbMix,
            reverb_decay_s: reverbDecay,
            echo_mix: echoMix,
            echo_time_ms: echoTimeMs,
            echo_feedback: echoFeedback
        };
    }

    /**
     * Play a note
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
            } else {
                // Melodic instruments: route through melody bus (dry + per-bank reverb)
                outputNode = this.melodyDryGain || this.audioContext.destination;

                // Send to melody reverb (wet signal, per-bank level)
                if (this.melodyReverbNode) {
                    const reverbEnvelope = this.player.queueWaveTable(
                        this.audioContext,
                        this.melodyReverbNode,
                        instrument,
                        startTime,
                        note,
                        effectiveDuration,
                        volume // Reverb level controlled by melodyReverbGain node
                    );
                    if (reverbEnvelope) {
                        this.activeEnvelopes.push(reverbEnvelope);
                    }
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

            // Echo send (shared across channels). Only tap the delay line
            // when the wet gain is audible; otherwise we save a voice.
            if (this.echoDelayNode && this.echoWetGain
                && this.echoWetGain.gain.value > 0.001) {
                const echoEnvelope = this.player.queueWaveTable(
                    this.audioContext,
                    this.echoDelayNode,
                    instrument,
                    startTime,
                    note,
                    effectiveDuration,
                    volume
                );
                if (echoEnvelope) {
                    this.activeEnvelopes.push(echoEnvelope);
                }
            }
        } catch (error) {
            // Silently ignore errors
        }
    }

    /**
     * Start playback
     */
    async play() {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) return;
        }

        // Resume the context if suspended
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        // Preload instruments: start immediately if cached, load missing ones in background.
        // Cold start (nothing cached at all): must wait for at least the initial instruments.
        if (this.loadedInstruments.size === 0 && this.drumPresets.size === 0) {
            await this.preloadInstruments();
        } else {
            this._preloadNonBlocking();
        }

        if (this.isPaused) {
            this.isPaused = false;
            this.startTime = this.audioContext.currentTime - this.ticksToSeconds(this.currentTick - this.startTick);
        } else {
            this.currentTick = this.startTick;
            this.startTime = this.audioContext.currentTime;
            this.lastScheduledTick = this.startTick;
            this.schedulePointer = 0;
        }

        this.isPlaying = true;
        this.startScheduler();

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
        this.schedulePointer = 0;

        // Apply a pending bank switch
        if (this._pendingBankSwitch) {
            this._applyBankSwitch(this._pendingBankSwitch);
            this._pendingBankSwitch = null;
        }

        if (this.onTickUpdate) {
            this.onTickUpdate(this.currentTick);
        }

        this.log('info', 'Playback stopped');
    }

    /**
     * Mute a channel
     * @param {number} channel - Channel number (0-15)
     */
    muteChannel(channel) {
        this.mutedChannels.add(channel);
        this.log('debug', `Channel ${channel} muted`);
    }

    /**
     * Unmute a channel
     * @param {number} channel - Channel number (0-15)
     */
    unmuteChannel(channel) {
        this.mutedChannels.delete(channel);
        this.log('debug', `Channel ${channel} unmuted`);
    }

    /**
     * Set the muted channels
     * @param {Set|Array} channels - Channels to mute
     */
    setMutedChannels(channels) {
        this.mutedChannels = new Set(channels);
        this.log('debug', `Muted channels set to: ${Array.from(this.mutedChannels).join(', ')}`);
    }

    /**
     * Check whether a channel is muted
     * @param {number} channel - Channel number
     * @returns {boolean}
     */
    isChannelMuted(channel) {
        return this.mutedChannels.has(channel);
    }

    /**
     * Cancel all ongoing notes
     */
    cancelAllNotes() {
        this.activeEnvelopes.forEach(envelope => {
            try {
                if (envelope && typeof envelope.cancel === 'function') {
                    envelope.cancel();
                }
            } catch (e) {
                // Ignore
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
        this.schedulePointer = this._findNoteIndex(this.currentTick);

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
     * Start the scheduler
     */
    startScheduler() {
        if (this.schedulerInterval) clearInterval(this.schedulerInterval);
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);

        this.schedulerInterval = setInterval(() => this.scheduleNotes(), 50);

        const updateCursor = () => {
            if (!this.isPlaying) return; // Stop RAF chain when not playing
            const currentTime = this.audioContext.currentTime;
            const elapsedTime = currentTime - this.startTime;
            this.currentTick = this.startTick + this.secondsToTicks(elapsedTime);

            if (this.onTickUpdate) {
                this.onTickUpdate(this.currentTick);
            }

            this.animationFrame = requestAnimationFrame(updateCursor);
        };
        if (this.isPlaying) {
            this.animationFrame = requestAnimationFrame(updateCursor);
        }
    }

    /**
     * Stop the scheduler
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
     * Binary search: find the index of the first note with t > tick.
     */
    _findNoteIndex(tick) {
        return window.MidiSynthesizerTempoMap.findNoteIndex(this.sequence, tick);
    }

    /**
     * Schedule notes
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

        // Pointer-based scheduling: only scan notes from schedulePointer forward (O(k) per tick)
        const seq = this.sequence;
        const len = seq.length;
        let i = this.schedulePointer;
        while (i < len) {
            const note = seq[i];
            if (note.t > scheduleEndTick) break;
            if (note.t > this.endTick) break;
            i++;
            if (this.mutedChannels.has(note.c)) continue;
            const noteStartTime = this.startTime + this.ticksToSeconds(note.t - this.startTick);
            const noteDuration = this.ticksToSeconds(note.g);
            this.playNote(note.n, note.v, note.c, noteDuration, noteStartTime);
        }
        this.schedulePointer = i;

        // In-place cleanup: remove finished envelopes without allocating a new array
        if (this.activeEnvelopes.length > 100) {
            const now = this.audioContext.currentTime;
            const envelopes = this.activeEnvelopes;
            let writeIdx = 0;
            for (let j = 0; j < envelopes.length; j++) {
                const env = envelopes[j];
                if (env.when !== undefined && (env.when + (env.duration || 0)) > now) {
                    envelopes[writeIdx++] = env;
                }
            }
            envelopes.length = writeIdx;
        }
    }

    /**
     * Release resources
     */
    dispose() {
        this.stop();
        this.cancelAllNotes();

        // Disconnect audio bus nodes
        if (this.drumDryGain) { try { this.drumDryGain.disconnect(); } catch(e) {} }
        if (this.drumReverbGain) { try { this.drumReverbGain.disconnect(); } catch(e) {} }
        if (this.drumReverbNode) { try { this.drumReverbNode.disconnect(); } catch(e) {} }
        if (this.melodyDryGain) { try { this.melodyDryGain.disconnect(); } catch(e) {} }
        if (this.melodyReverbGain) { try { this.melodyReverbGain.disconnect(); } catch(e) {} }
        if (this.melodyReverbNode) { try { this.melodyReverbNode.disconnect(); } catch(e) {} }
        if (this.echoDelayNode) { try { this.echoDelayNode.disconnect(); } catch(e) {} }
        if (this.echoFeedbackGain) { try { this.echoFeedbackGain.disconnect(); } catch(e) {} }
        if (this.echoWetGain) { try { this.echoWetGain.disconnect(); } catch(e) {} }
        this.drumDryGain = null;
        this.drumReverbGain = null;
        this.drumReverbNode = null;
        this.melodyDryGain = null;
        this.melodyReverbGain = null;
        this.melodyReverbNode = null;
        this.echoDelayNode = null;
        this.echoFeedbackGain = null;
        this.echoWetGain = null;
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

        MidiSynthesizer._instances.delete(this);

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
