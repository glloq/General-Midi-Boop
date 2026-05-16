// ============================================================================
// File: public/js/audio/MidiSynthesizer.js
// Version: v2.0.0 - MIDI Synthesizer with WebAudioFont (real samples)
// Description: Browser-based MIDI player with high-quality sounds
// ============================================================================

// Constants extracted to MidiSynthesizerConstants.js (P2-F.8).
// Loaded earlier in index.html so window.MidiSynthesizerConstants is available.
const { SOUND_BANKS, DEFAULT_BANK_ID, DEFAULT_BANK_SUFFIX, getAvailableBanks } = window.MidiSynthesizerConstants;

// GMBP binary preset decoder. Mirrors src/files/SF2PresetCodec.js — kept
// inline because MidiSynthesizer.js is loaded as a classic <script>, not
// an ES module. Header: 4-byte 'GMBP' magic, uint32 LE version (1),
// uint32 LE metaLen, metaLen UTF-8 JSON bytes, then concatenated Float32
// LE sample data. Endianness: host (LE on every supported target).
function _decodeGmbpPreset(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 12 ||
        bytes[0] !== 0x47 || bytes[1] !== 0x4d || bytes[2] !== 0x42 || bytes[3] !== 0x50) {
        throw new Error('Not a GMBP preset buffer');
    }
    const view = new DataView(arrayBuffer);
    const version = view.getUint32(4, true);
    if (version !== 2) throw new Error(`Unsupported GMBP version ${version}`);
    const metaLen = view.getUint32(8, true);
    if (metaLen < 0 || 12 + metaLen > bytes.length) {
        throw new Error(`GMBP invalid metaLen ${metaLen} (buf=${bytes.length})`);
    }
    const metaBytes = new Uint8Array(arrayBuffer, 12, metaLen);
    const meta = JSON.parse(new TextDecoder('utf-8').decode(metaBytes));
    if (!meta || !Array.isArray(meta.zones)) {
        throw new Error('GMBP metadata missing zones array');
    }
    const sampleBase = 12 + metaLen;
    const sampleBytesAvailable = bytes.length - sampleBase;
    const zones = meta.zones.map((z, i) => {
        const sampleOffset = z.sampleOffset | 0;
        const sampleLength = z.sampleLength | 0;
        if (sampleLength < 0 || sampleOffset < 0 ||
            (sampleOffset + sampleLength) * 4 > sampleBytesAvailable) {
            throw new Error(`GMBP zone ${i} sample range out of bounds`);
        }
        return {
            // Float32Array view requires 4-byte aligned offsets. `sampleBase`
            // is 12 + metaLen — metaLen is JSON length so unaligned in the
            // general case. We slice into a fresh buffer to get alignment.
            sample: new Float32Array(arrayBuffer.slice(
                sampleBase + sampleOffset * 4,
                sampleBase + (sampleOffset + sampleLength) * 4,
            )),
            sampleRate:   z.sampleRate,
            loopStart:    z.loopStart,
            loopEnd:      z.loopEnd,
            keyRangeLow:  z.keyRangeLow,
            keyRangeHigh: z.keyRangeHigh,
            velRangeLow:  z.velRangeLow,
            velRangeHigh: z.velRangeHigh,
            midi:         z.midi,
            coarseTune:   z.coarseTune,
            fineTune:     z.fineTune,
        };
    });
    return { zones };
}

/**
 * MidiSynthesizer - MIDI synthesizer using WebAudioFont
 * Uses real samples for professional-quality rendering
 */
class MidiSynthesizer {
    // Live instances (used by broadcastBankEffects to keep every
    // synth — MIDI editor, AudioPreview, etc. — in sync when the
    // user moves an effects slider in the Settings modal).
    static _instances = new Set();

    // SF2 preset fetch latency threshold (ms) before the loading toast
    // becomes visible. Sized to clear the L1/L2 hit envelope (< 100 ms)
    // and avoid flicker for warm reloads, while still appearing quickly
    // on a true cold parse + convert (~2-5 s on a Pi 3B+).
    static LOADING_TOAST_DELAY_MS = 600;

    // Per-GM-family gain compensation applied in playNote(). The default
    // SF2 bank (GeneralUser GS) is less hot than the legacy WAF banks,
    // and low-frequency families (bass, brass) lose perceived loudness
    // on small speakers. Drums (channel 9) are handled separately by
    // the velocity curve + cymbal boost above and do not use this table.
    // Indexed by `(program >>> 3) & 0x0f` (16 GM families).
    static GM_FAMILY_GAIN = [
        1.00, // 0-7   Piano
        1.05, // 8-15  Chromatic Percussion
        1.05, // 16-23 Organ
        1.10, // 24-31 Guitar
        1.50, // 32-39 Bass            ← compensates "très faible"
        1.25, // 40-47 Strings         ← compensates short-loop perception on violin/viola
        1.20, // 48-55 Ensemble
        1.15, // 56-63 Brass
        1.10, // 64-71 Reed
        1.10, // 72-79 Pipe
        1.05, // 80-87 Synth Lead
        1.15, // 88-95 Synth Pad
        1.05, // 96-103 Synth FX
        1.05, // 104-111 Ethnic
        1.00, // 112-119 Percussive
        1.00  // 120-127 SFX
    ];

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

    /**
     * Surface a non-blocking toast when the saved sound bank is no longer
     * available (typical case: stale WAF id from before the offline-first
     * default landed). Uses the existing HandPositionWarningsToast helper
     * so we don't ship a second toast widget. Falls back to console.warn
     * when the toast helper hasn't been loaded yet (very early boot).
     *
     * @param {string} from - The saved id that could not be resolved.
     * @param {string} to   - The id we actually fell back to.
     */
    static _notifyBankFallback(from, to) {
        const msg = `Banque son « ${from} » indisponible (mode hors-ligne). Repli sur « ${to} ».`;
        const toast = window.HandPositionWarningsToast;
        if (toast && typeof toast.show === 'function') {
            try { toast.show(msg); return; } catch (e) { /* fall through */ }
        }
        // The toast module loads lazily; retry once it's there.
        const started = Date.now();
        const iv = setInterval(() => {
            const t = window.HandPositionWarningsToast;
            if (t && typeof t.show === 'function') {
                try { t.show(msg); } catch (e) { /* ignore */ }
                clearInterval(iv);
            } else if (Date.now() - started > 5000) {
                clearInterval(iv);
                (window.logger || console).warn('[MidiSynthesizer]', msg);
            }
        }, 200);
    }

    /**
     * Surface a toast when the backend reports that the built-in default
     * soundfont (assets/sf2/default.sf2) is missing. Called by
     * SettingsSF2.loadCustomBanks after GET /api/sf2.
     */
    /**
     * Threshold-gated loading-toast watcher used by `_loadSF2MelodicPreset`
     * and `_loadSF2DrumPreset`. Each call schedules a ref-count bump after
     * {@link MidiSynthesizer.LOADING_TOAST_DELAY_MS}; if the fetch resolves
     * before that delay, the bump is cancelled and the user sees nothing.
     *
     * Concurrent calls share the same toast (one DOM node, ref-counted)
     * because the predictive preload often kicks off several fetches in
     * parallel and we don't want a stack of toasts on screen.
     *
     * @returns {{done: function(): void}}
     * @private
     */
    static _startLoadingWatcher() {
        const toast = window.InstrumentLoadingToast;
        if (!toast || typeof toast.show !== 'function') {
            // No toast helper available (very early boot, or page that
            // doesn't include InstrumentLoadingToast.js). No-op watcher so
            // callers don't need a null check.
            return { done() {} };
        }
        let shown = false;
        const timer = setTimeout(() => {
            shown = true;
            toast.show();
        }, MidiSynthesizer.LOADING_TOAST_DELAY_MS);
        return {
            done() {
                clearTimeout(timer);
                if (shown) {
                    try { toast.hide(); } catch (e) { /* ignore */ }
                }
            }
        };
    }

    static notifyDefaultSf2Missing() {
        if (MidiSynthesizer._defaultSf2MissingToastShown) return;
        MidiSynthesizer._defaultSf2MissingToastShown = true;
        const msg = 'Banque son par défaut absente sur le serveur. Lance `npm run install-default-sf2` ou place un fichier dans assets/sf2/default.sf2 pour activer le son.';
        const toast = window.HandPositionWarningsToast;
        if (toast && typeof toast.show === 'function') {
            try { toast.show(msg); return; } catch (e) { /* fall through */ }
        }
        (window.logger || console).warn('[MidiSynthesizer]', msg);
    }

    constructor() {
        this.audioContext = null;
        this.player = null;
        this.isInitialized = false;
        this.isPlaying = false;
        this.isPaused = false;
        this._isDisposed = false;

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
        const bankInfo = getAvailableBanks().find(b => b.id === savedBank);
        this.currentBankId = bankInfo ? bankInfo.id : DEFAULT_BANK_ID;
        this.currentBankSuffix = bankInfo ? bankInfo.suffix : DEFAULT_BANK_SUFFIX;
        this._pendingBankSwitch = null;

        // One-shot notice when a stale saved bank silently falls back to
        // the default — e.g. a legacy WAF id like 'FluidR3_GM' after the
        // CDN was opted out (see DEFAULT_BANK_ID gating). Skipped for
        // `sf2:*` saved banks: custom SF2 banks load lazily via
        // SettingsSF2.loadCustomBanks and would otherwise produce a false
        // positive on every page load.
        if (savedBank && savedBank !== this.currentBankId
            && !savedBank.startsWith('sf2:')
            && !MidiSynthesizer._fallbackToastShown) {
            MidiSynthesizer._fallbackToastShown = true;
            MidiSynthesizer._notifyBankFallback(savedBank, this.currentBankId);
        }

        // General MIDI to WebAudioFont mapping
        // Format: [file, variable] for each GM program (0-127).
        // For SF2 banks (default + custom) the map is a placeholder — actual
        // samples are fetched via /api/sf2/... in _loadSF2MelodicPreset.
        this.gmInstrumentMap = this.currentBankId.startsWith('sf2:')
            ? Array.from({ length: 128 }, () => ({ url: null, variable: null }))
            : this.createGMInstrumentMap(this.currentBankSuffix);

        // Drums (channel 9) — per-(kit, note) presets from FluidR3_GM, which
        // ships every GM drum kit (Standard, Room, Power, Electronic, TR-808,
        // Jazz, Brush, Orchestra, SFX). Falls back to kit 0 then to JCLive
        // bank 12 when a specific (kit, note) is missing on the CDN.
        this.drumKit = null; // Legacy single-kit (unused, kept for compat)
        this.drumPresets = new Map(); // "kitProgram:note" → loaded preset
        this._drumLoading = new Map(); // "kitProgram:note" → in-flight Promise
        this._drumVariables = new Map(); // "kitProgram:note" → window variable name
        this._injectedScripts = new Set(); // <script> elements injected by this instance

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
     * Build a WAF drum preset entry for a given bank suffix + bank index + note.
     * WAF filename convention: 128{note}_{bankIndex}_{suffix}.js
     *
     * Two variable naming conventions exist on the WAF CDN:
     *   - Legacy:   _drum_{note}_{bankIndex}_{suffix}    (e.g. _drum_36_0_FluidR3_GM_sf2_file)
     *   - Standard: _tone_128{note}_{bankIndex}_{suffix} (e.g. _tone_12836_0_FluidR3_GM_sf2_file)
     * Both are tried; `altVariable` holds the standard WAF form.
     *
     * NOTE: Only reachable when the user has explicitly opted into the
     * external WAF CDN (legacy banks). The default `sf2:default` bank and
     * every custom SF2 bank short-circuit this branch via
     * `_loadSF2DrumPreset` — see `_loadDrumPreset`.
     *
     * @param {string} suffix    - Bank suffix (e.g. 'FluidR3_GM_sf2_file')
     * @param {number} bankIndex - WAF bank index for this kit in the font
     * @param {number} note      - MIDI note number (35-81)
     */
    _buildDrumPresetEntry(suffix, bankIndex, note) {
        const base = '/api/waf/';
        const key = `${note}_${bankIndex}_${suffix}`;
        return {
            url: `${base}128${key}.js`,
            variable: `_drum_${key}`,
            altVariable: `_tone_128${key}`
        };
    }

    /**
     * Look up a drum kit entry in the current bank's drumKits list.
     * Returns {midiProgram, bankIndex, verified} or null if unsupported.
     *
     * @param {number} midiProgram - GM kit program (0=Standard, 8=Room…)
     */
    _getDrumKitEntry(midiProgram) {
        const bank = getAvailableBanks().find(b => b.id === this.currentBankId);
        if (!bank || !bank.drumKits) return null;
        return bank.drumKits.find(k => k.midiProgram === midiProgram) || null;
    }

    /**
     * Legacy per-note JCLive entry — kept as absolute last-resort fallback.
     * JCLive drums sit at bankIndex 12 in the WAF CDN.
     */
    _legacyJCLiveEntry(note) {
        const base = '/api/waf/';
        const key = `${note}_12_JCLive_sf2_file`;
        return {
            url: `${base}128${key}.js`,
            variable: `_drum_${key}`,
            altVariable: `_tone_128${key}`
        };
    }

    /**
     * Decode a stored channel-9 program. Drum kit programs may be stored
     * raw (0–127) or offset-encoded (≥128, see DRUM_KIT_OFFSET in
     * shared/instrument-families.json). Returns the raw GM kit program.
     */
    _decodeKitProgram(stored) {
        const offset = (typeof window !== 'undefined'
            && window.InstrumentFamilies
            && typeof window.InstrumentFamilies.DRUM_KIT_OFFSET === 'number')
            ? window.InstrumentFamilies.DRUM_KIT_OFFSET
            : 128;
        const v = (stored | 0);
        return v >= offset ? v - offset : v;
    }

    /**
     * Create the mapping of the 128 GM instruments to WebAudioFont files
     * @param {string} bankSuffix - Sound bank suffix (e.g. 'FluidR3_GM_sf2_file')
     */
    createGMInstrumentMap(bankSuffix = DEFAULT_BANK_SUFFIX) {
        const base = '/api/waf/';
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
        const bank = getAvailableBanks().find(b => b.id === bankId);
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
        // Drums must also reload so they use the new bank's samples.
        this._clearDrumCache();
        this.currentBankId = bank.id;
        this.currentBankSuffix = bank.suffix;
        if (bank.id.startsWith('sf2:')) {
            // SF2 (built-in default or custom): melodic map is a placeholder
            // — actual loading is done lazily via HTTP in _loadSF2MelodicPreset.
            this.gmInstrumentMap = Array.from({ length: 128 }, () => ({ url: null, variable: null }));
        } else {
            this.gmInstrumentMap = this.createGMInstrumentMap(bank.suffix);
        }

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

        // Pre-warm the new bank's presets for currently-assigned channels.
        // Deferred so the bank-change UI repaint isn't blocked by the
        // download (~20 MB binary for an SF2 preset).
        setTimeout(() => this._preloadCurrentChannelPrograms(), 0);
    }

    /**
     * Clear the cache of loaded melodic instruments
     */
    _clearInstrumentCache() {
        this.loadedInstruments.clear();
        this.loadingInstruments.clear();
        // Remove only the melodic <script> elements injected by this instance
        for (const script of [...this._injectedScripts]) {
            if (script.src && !script.src.includes('/128')) {
                try { script.remove(); } catch (e) {}
                this._injectedScripts.delete(script);
            }
        }
    }

    /**
     * Free drum sample data for this instance during a bank switch.
     * Deletes window globals not referenced by any other live instance,
     * removes the drum <script> tags this instance injected, and clears
     * the three drum Maps.
     */
    _clearDrumCache() {
        const otherInstances = [...MidiSynthesizer._instances].filter(inst => inst !== this);
        for (const cacheKey of this.drumPresets.keys()) {
            if (!otherInstances.some(inst => inst.drumPresets.has(cacheKey))) {
                const varName = this._drumVariables.get(cacheKey);
                if (varName) delete window[varName];
            }
        }
        for (const script of [...this._injectedScripts]) {
            if (script.src && script.src.includes('/128')) {
                try { script.remove(); } catch (e) {}
                this._injectedScripts.delete(script);
            }
        }
        this.drumPresets.clear();
        this._drumLoading.clear();
        this._drumVariables.clear();
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
     * Get the list of available sound banks (WAF built-ins + custom SF2)
     * @returns {Array} List of banks {id, label, suffix}
     */
    static getAvailableBanks() {
        return getAvailableBanks();
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

            // Predictive preload: kick off background fetches for the
            // programs assigned to active channels (just program 0 at
            // boot before any MIDI is loaded). setTimeout(0) yields to
            // the event loop so the caller's await chain finishes first.
            setTimeout(() => this._preloadCurrentChannelPrograms(), 0);

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

        // SF2 bank: load preset via HTTP instead of WAF CDN script injection
        if (this.currentBankId.startsWith('sf2:')) {
            return this._loadSF2MelodicPreset(program);
        }

        const instrumentInfo = this.gmInstrumentMap[program];

        const loadPromise = new Promise((resolve, reject) => {
            // Load the instrument script
            const script = document.createElement('script');
            script.src = instrumentInfo.url;
            this._injectedScripts.add(script);
            script.onload = () => {
                if (this._isDisposed) { resolve(null); return; }
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
                if (this._isDisposed) { resolve(null); return; }
                this.loadingInstruments.delete(program);
                // No WAF-CDN fallback here: the default bank is the local SF2,
                // and `_loadSF2MelodicPreset` is used for everything `sf2:`.
                // We only reach this branch when the user has explicitly
                // opted into the external WAF CDN (legacy banks), in which
                // case the requested file is genuinely missing on the CDN.
                reject(new Error(`Failed to load ${instrumentInfo.url}`));
            };
            document.head.appendChild(script);
        });

        this.loadingInstruments.set(program, loadPromise);
        return loadPromise;
    }

    /**
     * Load a single drum preset for a (kitProgram, note) pair.
     *
     * Candidate order (duplicates skipped via URL dedup):
     *   1. Current bank  + requested kit  (if the bank lists this kit)
     *   2. FluidR3_GM    + requested kit  (only bank with all 9 GM kits)
     *   3. Current bank  + Standard Kit   (bankIndex for midiProgram 0, if kit≠0)
     *   4. FluidR3_GM    + Standard Kit   (if kit≠0)
     *   5. Legacy JCLive bankIndex 12     (absolute last resort)
     */
    _loadDrumPreset(note, kitProgram = 0) {
        if (note < 35 || note > 81) return Promise.resolve(null);
        const kit = kitProgram | 0;
        const cacheKey = `${kit}:${note}`;

        if (this.drumPresets.has(cacheKey)) {
            return Promise.resolve(this.drumPresets.get(cacheKey));
        }
        if (this._drumLoading.has(cacheKey)) {
            return this._drumLoading.get(cacheKey);
        }

        // SF2 bank: load preset via HTTP instead of WAF CDN script injection
        if (this.currentBankId.startsWith('sf2:')) {
            return this._loadSF2DrumPreset(note, kit);
        }

        const FLUID = 'FluidR3_GM_sf2_file';
        const candidates = [];
        const seen = new Set();
        const addCandidate = (entry) => {
            if (!seen.has(entry.url)) { seen.add(entry.url); candidates.push(entry); }
        };

        // 1. Current bank + requested kit
        const currentKitEntry = this._getDrumKitEntry(kit);
        if (currentKitEntry) {
            addCandidate(this._buildDrumPresetEntry(this.currentBankSuffix, currentKitEntry.bankIndex, note));
        }

        // 2. FluidR3_GM + requested kit (covers all 9 GM kits)
        addCandidate(this._buildDrumPresetEntry(FLUID, kit, note));

        // 3 & 4. Standard Kit fallbacks when the requested kit is absent
        if (kit !== 0) {
            const stdEntry = this._getDrumKitEntry(0);
            if (stdEntry) {
                addCandidate(this._buildDrumPresetEntry(this.currentBankSuffix, stdEntry.bankIndex, note));
            }
            addCandidate(this._buildDrumPresetEntry(FLUID, 0, note));
        }

        // 5. Absolute last resort
        addCandidate(this._legacyJCLiveEntry(note));

        const tryLoad = (idx) => new Promise((resolve) => {
            if (idx >= candidates.length) {
                this.log('warn', `No drum preset available for kit ${kit} note ${note}`);
                resolve({ preset: null, variable: null });
                return;
            }
            const info = candidates[idx];
            // If the variable is already on window (a previous load), reuse it.
            // Try both _drum_ (legacy) and _tone_128 (standard WAF) conventions.
            const preLoaded = window[info.variable] || (info.altVariable && window[info.altVariable]);
            if (preLoaded) {
                const resolvedVar = window[info.variable] ? info.variable : info.altVariable;
                const preset = window[resolvedVar];
                this.player.adjustPreset(this.audioContext, preset);
                resolve({ preset, variable: resolvedVar });
                return;
            }
            const script = document.createElement('script');
            script.src = info.url;
            this._injectedScripts.add(script);
            script.onload = () => {
                if (this._isDisposed) { resolve({ preset: null, variable: null }); return; }
                let preset = window[info.variable];
                let resolvedVar = info.variable;
                // Fall back to standard WAF _tone_128 naming if legacy _drum_ not found
                if (!preset && info.altVariable && window[info.altVariable]) {
                    preset = window[info.altVariable];
                    resolvedVar = info.altVariable;
                }
                if (preset) {
                    this.player.adjustPreset(this.audioContext, preset);
                    resolve({ preset, variable: resolvedVar });
                } else {
                    tryLoad(idx + 1).then(resolve);
                }
            };
            script.onerror = () => {
                tryLoad(idx + 1).then(resolve);
            };
            document.head.appendChild(script);
        });

        const loadPromise = tryLoad(0).then(({ preset, variable }) => {
            this._drumLoading.delete(cacheKey);
            if (preset && !this._isDisposed) {
                this.drumPresets.set(cacheKey, preset);
                this._drumVariables.set(cacheKey, variable);
            }
            return preset;
        });
        this._drumLoading.set(cacheKey, loadPromise);
        return loadPromise;
    }

    // ── SF2 custom bank loaders ────────────────────────────────────────────

    /**
     * Translate a freshly-fetched SF2Converter preset into the in-memory
     * shape WebAudioFontPlayer.queueWaveTable expects, then mutate it in
     * place. `adjustPreset` is intentionally NOT used here — it base64-
     * decodes `zone.sample` because WAF's native wavetables ship sample
     * data as base64 strings, but SF2Converter produces Float32 sample
     * data directly, so we build the AudioBuffer ourselves. Field name
     * differences: SF2Converter writes `zone.midi` (MIDI root note 0-127),
     * WAF reads `zone.originalPitch` (same root note expressed in cents,
     * default 6000 = middle C).
     *
     * @param {Object} preset
     * @param {?number} [forcedRootMidi] - When provided, override every
     *   zone's root pitch so the sample plays at playback rate 1.0 for
     *   this exact MIDI note. Used for drum presets: the server returns
     *   only the zones covering the requested percussion note, and GM
     *   drums must play at their recorded pitch (no transposition).
     *   Without this override, drum samples whose SF2 root key differs
     *   from the GM note number (very common — many kits leave the
     *   sample's natural recorded pitch unchanged) get pitch-shifted and
     *   sound like tubular bells.
     */
    _materialiseSF2Preset(preset, forcedRootMidi = null) {
        for (const z of (preset.zones || [])) {
            if (z.buffer) continue; // already materialised (re-entry guard)
            const raw = z.sample instanceof Float32Array ? z.sample : null;
            if (!raw || raw.length === 0) continue;
            const sampleRate = z.sampleRate > 0 ? z.sampleRate : 44100;
            const buffer = this.audioContext.createBuffer(1, raw.length, sampleRate);
            buffer.getChannelData(0).set(raw);
            z.buffer = buffer;
            // Drop the float payload — keeping it doubles the heap footprint
            // of every loaded preset for the rest of the page lifetime.
            z.sample = null;
            // Convert MIDI note → cents for WAF. 6000 = note 60 (middle C).
            if (forcedRootMidi != null) {
                z.originalPitch = forcedRootMidi * 100;
                // Drum/percussion zones must play at the sample's recorded
                // pitch (GM drum kits set scaleTuning = 0). The SF2 converter
                // forwards per-zone coarseTune/fineTune verbatim; combined
                // with the forced root these transpose the percussive sample
                // N semitones and turn the transient into a sustained tonal
                // ring ("cloche"). Forcing rate 1.0 means zeroing them
                // outright, not just when null.
                z.coarseTune = 0;
                z.fineTune   = 0;
            } else if (z.originalPitch == null && z.midi != null) {
                z.originalPitch = z.midi * 100;
            }
            // Defaults `adjustZone` would have applied for missing fields.
            if (z.loopStart == null)  z.loopStart  = 0;
            if (z.loopEnd == null)    z.loopEnd    = 0;
            if (z.coarseTune == null) z.coarseTune = 0;
            if (z.fineTune == null)   z.fineTune   = 0;
        }
    }

    /**
     * Fetch a melodic preset from the server's SF2 converter endpoint and
     * cache it the same way WAF presets are cached.
     */
    _loadSF2MelodicPreset(program) {
        const sf2Id = this.currentBankId.slice(4); // strip 'sf2:'
        const watcher = MidiSynthesizer._startLoadingWatcher();
        const p = fetch(`/api/sf2/${sf2Id}/preset/melodic/${program}`)
            .then(r => {
                if (r.status === 404 && sf2Id === 'default') {
                    MidiSynthesizer._handleDefaultSF2Missing();
                }
                return r.ok ? r.arrayBuffer() : null;
            })
            .then(buf => {
                const preset = buf ? _decodeGmbpPreset(buf) : null;
                if (!preset || this._isDisposed) {
                    this.loadingInstruments.delete(program);
                    // After the global fallback, retry with the new bank so the
                    // caller (loadInstrument) gets a real preset instead of null.
                    if (this.currentBankId !== `sf2:${sf2Id}`) {
                        return this.loadInstrument(program);
                    }
                    return null;
                }
                this._materialiseSF2Preset(preset);
                this.loadedInstruments.set(program, preset);
                this.loadingInstruments.delete(program);
                return preset;
            })
            .catch(() => { this.loadingInstruments.delete(program); return null; })
            .finally(() => watcher.done());
        this.loadingInstruments.set(program, p);
        return p;
    }

    /**
     * Fetch a drum note preset from the server's SF2 converter endpoint and
     * cache it the same way WAF drum presets are cached.
     */
    _loadSF2DrumPreset(note, kit) {
        const cacheKey = `${kit}:${note}`;
        const sf2Id = this.currentBankId.slice(4);
        const watcher = MidiSynthesizer._startLoadingWatcher();
        const p = fetch(`/api/sf2/${sf2Id}/preset/drum/${kit}/${note}`)
            .then(r => {
                if (r.status === 404 && sf2Id === 'default') {
                    MidiSynthesizer._handleDefaultSF2Missing();
                }
                return r.ok ? r.arrayBuffer() : null;
            })
            .then(buf => {
                const preset = buf ? _decodeGmbpPreset(buf) : null;
                this._drumLoading.delete(cacheKey);
                if (!preset || this._isDisposed) {
                    // Self-healing: if the global fallback switched banks
                    // mid-flight, retry the drum lookup on the new bank.
                    if (this.currentBankId !== `sf2:${sf2Id}`) {
                        return this._loadDrumPreset(note, kit);
                    }
                    return null;
                }
                this._materialiseSF2Preset(preset, note);
                this.drumPresets.set(cacheKey, preset);
                return preset;
            })
            .catch(() => { this._drumLoading.delete(cacheKey); return null; })
            .finally(() => watcher.done());
        this._drumLoading.set(cacheKey, p);
        return p;
    }

    /**
     * Self-healing fallback when the server reports that the built-in
     * `assets/sf2/default.sf2` is not present (every preset 404s). Switch
     * every live synth to FluidR3_GM (legacy WAF, online) so the user
     * hears something, persist the choice so subsequently-created synths
     * (loop modal piano, AudioPreview, etc.) pick it up, and surface a
     * single toast to explain why. One-shot per page load.
     */
    static _handleDefaultSF2Missing() {
        if (MidiSynthesizer._defaultSf2FallbackApplied) return;
        MidiSynthesizer._defaultSf2FallbackApplied = true;

        const FALLBACK_ID = 'FluidR3_GM';
        try {
            const raw = localStorage.getItem('gmboop_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            // Only override the persisted choice when it was the (broken)
            // built-in default — never overwrite an explicit user choice.
            if (!parsed.soundBank || parsed.soundBank === DEFAULT_BANK_ID) {
                parsed.soundBank = FALLBACK_ID;
                localStorage.setItem('gmboop_settings', JSON.stringify(parsed));
            }
        } catch (e) { /* localStorage unavailable — keep going */ }

        for (const inst of MidiSynthesizer._instances) {
            if (inst.currentBankId === DEFAULT_BANK_ID) {
                try { inst.setSoundBank(FALLBACK_ID); } catch (e) { /* ignore */ }
            }
        }

        MidiSynthesizer.notifyDefaultSf2Missing();
    }

    /**
     * Load the drum kit — loads per-(kit, note) presets for all drum notes
     * used in the sequence. The kit program comes from
     * `channelInstruments[9]` (decoded if offset-encoded).
     */
    async loadDrumKit() {
        const kit = this._decodeKitProgram(this.channelInstruments[9] ?? 0);

        // Collect which drum notes are actually used in the sequence
        const usedNotes = new Set();
        if (this.sequence) {
            this.sequence.forEach(note => {
                if (note.c === 9) {
                    usedNotes.add(note.n);
                }
            });
        }

        // If no specific notes found (preview live / clavier virtuel sans
        // séquence), charger la gamme GM percussion complète (35-81 — voir
        // _loadDrumPreset:470). Sans ça l'utilisateur n'entendait que 8
        // sons essentiels et les autres touches étaient silencieuses.
        if (usedNotes.size === 0) {
            for (let n = 35; n <= 81; n++) usedNotes.add(n);
        }

        this.log('info', `Loading ${usedNotes.size} drum presets for kit ${kit} (bank: ${this.currentBankId})`);

        const promises = [];
        for (const note of usedNotes) {
            promises.push(this._loadDrumPreset(note, kit));
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
    /**
     * Predictive preload: trigger background fetches for the GM programs
     * currently assigned to non-drum channels. Used at boot and after a
     * bank switch so the first key press finds the preset already in L1
     * (mémoire navigateur) instead of waiting for a multi-MB download.
     * Fire-and-forget — errors are already swallowed by `loadInstrument`.
     * @private
     */
    _preloadCurrentChannelPrograms() {
        if (this._isDisposed) return;
        // loadInstrument touches audioContext/player; bail until initialize()
        // has set them up (can happen because setTimeout(0) fires past
        // setSoundBank/setChannelInstrument calls made before init).
        if (!this.isInitialized || !this.audioContext) return;
        const programs = new Set();
        for (let ch = 0; ch < 16; ch++) {
            if (ch === 9) continue; // drums preloaded by loadDrumKit
            programs.add(this.channelInstruments[ch] || 0);
        }
        for (const program of programs) {
            if (this.loadedInstruments.has(program)) continue;
            if (this.loadingInstruments.has(program)) continue;
            try { this.loadInstrument(program); } catch (e) { /* ignore */ }
        }
    }

    setChannelInstrument(channel, program) {
        if (channel < 0 || channel >= 16) return;
        this.channelInstruments[channel] = program;
        // Fire-and-forget preload so the modal's eventual `play()` /
        // `playNote()` doesn't pay the cold-load cost. Drum channel
        // skipped — drum samples are loaded by loadDrumKit(). The maps
        // dedupe: a program already loading or loaded is silently no-op.
        // We deliberately do NOT skip when `program === previous` since a
        // setChannelInstrument(ch, 0) call right after construction may
        // be the first chance to preload program 0 if the constructor's
        // initialize() preload hasn't drained yet.
        if (channel !== 9
            && this.isInitialized
            && !this.loadedInstruments.has(program)
            && !this.loadingInstruments.has(program)) {
            setTimeout(() => {
                if (this._isDisposed || !this.isInitialized) return;
                if (this.loadedInstruments.has(program)) return;
                if (this.loadingInstruments.has(program)) return;
                this.loadInstrument(program);
            }, 0);
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
        const bankInfo = getAvailableBanks().find(b => b.id === this.currentBankId);
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
        const bank = getAvailableBanks().find(b => b.id === this.currentBankId);
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
     * Play a note.
     *
     * @returns {?Array<Object>} The envelope objects scheduled for this note
     *   (dry + reverb + echo). Callers that need to stop the note early
     *   (e.g. the instrument-settings preview keyboard) can iterate and
     *   call `envelope.cancel()`. Returns `null` if the note could not be
     *   scheduled (synth not initialized, instrument missing, error).
     */
    playNote(note, velocity, channel, duration, time = null) {
        if (!this.isInitialized || !this.player) return null;

        const startTime = time || this.audioContext.currentTime;

        let volume;
        if (channel === 9) {
            // Non-linear velocity curve for drums — cymbals get extra boost
            const velNorm = velocity / 127;
            const velCurve = Math.pow(velNorm, 0.7); // Exponential: louder hits stand out more
            const boost = this.cymbalNotes.has(note) ? 1.25 : 1.0;
            volume = velCurve * (this.channelVolumes[channel] / 127) * boost;
        } else {
            const program = this.channelInstruments[channel] || 0;
            const familyGain = MidiSynthesizer.GM_FAMILY_GAIN[(program >>> 3) & 0x0f];
            volume = familyGain * (velocity / 127) * (this.channelVolumes[channel] / 127);
        }

        let instrument;
        if (channel === 9) {
            const kit = this._decodeKitProgram(this.channelInstruments[9] ?? 0);
            instrument = this.drumPresets.get(`${kit}:${note}`);
            // Race fallback: kit not yet loaded but Standard might be
            if (!instrument && kit !== 0) {
                instrument = this.drumPresets.get(`0:${note}`);
            }
            // Lazy-load : preset percussion pas (encore) chargé pour ce note —
            // déclenche le fetch en background pour que la prochaine frappe
            // sonne. Sans ça, hors des 47 notes preloadées par loadDrumKit
            // (ou si le user joue trop tôt après ouverture), le synth reste
            // silencieux pour toujours.
            if (!instrument && note >= 35 && note <= 81 && typeof this._loadDrumPreset === 'function') {
                this._loadDrumPreset(note, kit).catch(() => {});
            }
        } else {
            const program = this.channelInstruments[channel] || 0;
            instrument = this.loadedInstruments.get(program);
        }

        if (!instrument) {
            return null;
        }

        const scheduled = [];
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
                        scheduled.push(reverbEnvelope);
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
                        scheduled.push(reverbEnvelope);
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
                scheduled.push(envelope);
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
                    scheduled.push(echoEnvelope);
                }
            }
        } catch (error) {
            // Silently ignore errors
        }

        return scheduled.length > 0 ? scheduled : null;
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
        if (this.activeEnvelopes.length > 50) {
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
        if (this._isDisposed) return;
        this._isDisposed = true;

        this.stop();
        this.cancelAllNotes();

        // Free window globals for audio sample data (15–40 MB total).
        // Must happen BEFORE clearing the Maps — collect while Maps still have data.
        // Only delete globals not referenced by another live instance.
        const otherInstances = [...MidiSynthesizer._instances].filter(inst => inst !== this);

        for (const program of this.loadedInstruments.keys()) {
            if (!otherInstances.some(inst => inst.loadedInstruments.has(program))) {
                const variable = this.gmInstrumentMap[program]?.variable;
                if (variable) delete window[variable];
            }
        }

        for (const cacheKey of this.drumPresets.keys()) {
            if (!otherInstances.some(inst => inst.drumPresets.has(cacheKey))) {
                const varName = this._drumVariables.get(cacheKey);
                if (varName) delete window[varName];
            }
        }

        // Remove only the <script> tags injected by this instance
        for (const script of this._injectedScripts) {
            try { script.remove(); } catch (e) {}
        }
        this._injectedScripts.clear();

        // Clear Maps (in-flight promises check _isDisposed before writing back)
        this.loadedInstruments.clear();
        this.loadingInstruments.clear();
        this.drumPresets.clear();
        this._drumLoading.clear();
        this._drumVariables.clear();

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
        this.drumKit = null;
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
