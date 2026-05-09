/**
 * LoopUtils — Shared utilities for the Loop feature (Manager + Editor + Minimap).
 *
 * Exposes a single global `LoopUtils` namespace with:
 *   - LoopUtils.parseSequence(midi_data)           safe JSON parsing
 *   - LoopUtils.handleError(err, ctx, opts)        structured error logging
 *   - LoopUtils.toast(msg, type)                   transient ephemeral toast
 *   - LoopUtils.createSynth()                      mutualised MidiSynthesizer init
 *   - LoopUtils.scheduleSequence(opts)             shared MIDI scheduler (pad/live/arranger/editor)
 *   - LoopUtils.loopDurationMs(loop)               canonical loop duration
 *   - LoopUtils.validateTempo(v) / validateBars(v) UI bounds clamping
 *   - LoopUtils.PadStorage.load() / save() / export() / import()
 *   - LoopUtils.GM_FAMILIES / familyForProgram(p)  family lookup + colours
 */
(function () {
    'use strict';

    const PAD_STORAGE_KEY = 'gmboop_pad_layout_v1';

    // ── GM family palette (used for colour-coding loops by instrument) ──
    const GM_FAMILIES = [
        { name: 'Piano',          icon: '🎹', start: 0,   color: '#5B8DEF' },
        { name: 'Chromatic Perc', icon: '🔔', start: 8,   color: '#F0B429' },
        { name: 'Organ',          icon: '🎹', start: 16,  color: '#9B59B6' },
        { name: 'Guitar',         icon: '🎸', start: 24,  color: '#E67E22' },
        { name: 'Bass',           icon: '🎸', start: 32,  color: '#7F4F2A' },
        { name: 'Strings',        icon: '🎻', start: 40,  color: '#27AE60' },
        { name: 'Ensemble',       icon: '🎻', start: 48,  color: '#16A085' },
        { name: 'Brass',          icon: '🎺', start: 56,  color: '#D4AC0D' },
        { name: 'Reed',           icon: '🎷', start: 64,  color: '#CA6F1E' },
        { name: 'Pipe',           icon: '🪗', start: 72,  color: '#48C9B0' },
        { name: 'Synth Lead',     icon: '🎹', start: 80,  color: '#E74C3C' },
        { name: 'Synth Pad',      icon: '🎹', start: 88,  color: '#A569BD' },
        { name: 'Synth FX',       icon: '✨', start: 96,  color: '#5DADE2' },
        { name: 'Ethnic',         icon: '🥁', start: 104, color: '#A04000' },
        { name: 'Percussive',     icon: '🥁', start: 112, color: '#7B241C' },
        { name: 'Sound FX',       icon: '🔊', start: 120, color: '#566573' }
    ];

    function familyForProgram(prog = 0) {
        for (let i = GM_FAMILIES.length - 1; i >= 0; i--) {
            if (prog >= GM_FAMILIES[i].start) return GM_FAMILIES[i];
        }
        return GM_FAMILIES[0];
    }

    // ── Safe sequence parsing ──────────────────────────────────────────
    function parseSequence(midi_data) {
        if (!midi_data) return [];
        if (Array.isArray(midi_data)) return midi_data;
        if (typeof midi_data !== 'string') return [];
        try {
            const parsed = JSON.parse(midi_data);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            console.warn('[LoopUtils] Corrupted midi_data, returning empty sequence', err);
            return [];
        }
    }

    // ── Structured error handler ───────────────────────────────────────
    /**
     * Logs a structured warning and, when `opts.toast` is truthy, surfaces a
     * transient toast to the user.
     *
     *   handleError(err, 'pad.trigger', { toast: 'Could not trigger pad' })
     */
    function handleError(err, context = 'loop', opts = {}) {
        const message = err?.message || String(err);
        console.warn(`[Loop:${context}]`, message, err || '');
        if (opts.toast) toast(opts.toast, opts.type || 'error');
    }

    // ── Toast (lightweight, no dependency) ─────────────────────────────
    let _toastContainer = null;
    function _ensureToastContainer() {
        if (_toastContainer && document.body.contains(_toastContainer)) return _toastContainer;
        _toastContainer = document.createElement('div');
        _toastContainer.className = 'lc-toast-container';
        _toastContainer.setAttribute('role', 'status');
        _toastContainer.setAttribute('aria-live', 'polite');
        document.body.appendChild(_toastContainer);
        return _toastContainer;
    }

    function toast(message, type = 'info', timeoutMs = 3200) {
        if (!message) return;
        const c = _ensureToastContainer();
        const el = document.createElement('div');
        el.className = `lc-toast lc-toast--${type}`;
        const icon = type === 'error' ? '✗' : type === 'success' ? '✓' : 'ℹ';
        el.innerHTML = `<span class="lc-toast-icon">${icon}</span><span class="lc-toast-msg"></span>`;
        el.querySelector('.lc-toast-msg').textContent = String(message);
        c.appendChild(el);
        // animate in
        requestAnimationFrame(() => el.classList.add('lc-toast--shown'));
        setTimeout(() => {
            el.classList.remove('lc-toast--shown');
            setTimeout(() => el.remove(), 250);
        }, timeoutMs);
    }

    // ── MidiSynthesizer factory ────────────────────────────────────────
    async function createSynth({ initialProgram = null } = {}) {
        if (typeof MidiSynthesizer === 'undefined') return null;
        try {
            const synth = new MidiSynthesizer();
            await synth.initialize();
            if (initialProgram != null) {
                try { synth.setChannelInstrument(0, initialProgram); } catch (err) { handleError(err, 'synth.setChannelInstrument'); }
                await synth.loadInstrument(initialProgram).catch(err => handleError(err, 'synth.loadInstrument'));
            }
            return synth;
        } catch (err) {
            handleError(err, 'synth.init');
            return null;
        }
    }

    // ── Loop duration helpers ──────────────────────────────────────────
    function loopDurationMs({ tempo = 120, bars = 2, time_sig_num = 4 } = {}) {
        return time_sig_num * bars * 60000 / tempo;
    }

    // ── Shared sequence scheduler ──────────────────────────────────────
    /**
     * Schedule a MIDI sequence on a synth.
     *
     *  opts.synth        MidiSynthesizer instance (required)
     *  opts.sequence     [{ t, n, v?, g?, l? }]  PPQ ticks
     *  opts.tempo        BPM
     *  opts.ppq          ticks per quarter
     *  opts.channel      MIDI channel (0-15)
     *  opts.startDelayMs delay before sequence start (ms)
     *  opts.isAlive      () => boolean   guard called inside each timer
     *  opts.onCycleEnd   () => void      called once the cycle finishes
     *  opts.cycleMs      length of one loop cycle (ms) — required for onCycleEnd
     *
     *  Returns an array of timer ids. Caller is responsible for clearing them
     *  on stop (`timers.forEach(clearTimeout)`).
     */
    function scheduleSequence(opts) {
        const {
            synth, sequence = [], tempo = 120, ppq = 480, channel = 0,
            startDelayMs = 0, isAlive = () => true, onCycleEnd = null, cycleMs = null
        } = opts || {};
        if (!synth || !sequence.length) return [];

        const spt = 60 / (tempo * ppq);  // seconds per tick
        const timers = [];
        for (const note of sequence) {
            const onMs   = startDelayMs + note.t * spt * 1000;
            const durSec = (note.g || note.l || 120) * spt;
            timers.push(setTimeout(() => {
                if (!isAlive()) return;
                try { synth.playNote?.(note.n, note.v || 80, channel, durSec); }
                catch (err) { handleError(err, 'schedule.playNote'); }
            }, onMs));
        }
        if (onCycleEnd && cycleMs != null) {
            timers.push(setTimeout(() => { if (isAlive()) onCycleEnd(); }, startDelayMs + cycleMs));
        }
        return timers;
    }

    // ── UI validation helpers ──────────────────────────────────────────
    function clampInt(v, min, max, fallback) {
        const n = parseInt(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    const validate = {
        tempo:    (v, fallback = 120) => clampInt(v, 20,  300, fallback),
        editorBars: (v, fallback = 2)   => clampInt(v, 1,   32,  fallback),
        arrBars:  (v, fallback = 16)  => clampInt(v, 4,   256, fallback),
        loopBars: (v, fallback = 2)   => clampInt(v, 1,   32,  fallback)
    };

    // ── Pad layout persistence (localStorage + JSON import/export) ──────
    const PadStorage = {
        load() {
            try {
                const raw = localStorage.getItem(PAD_STORAGE_KEY);
                if (!raw) return null;
                const data = JSON.parse(raw);
                if (!data || !Array.isArray(data.slots)) return null;
                return data.slots;
            } catch (err) {
                handleError(err, 'pad.storage.load');
                return null;
            }
        },
        save(slots) {
            try {
                localStorage.setItem(PAD_STORAGE_KEY, JSON.stringify({
                    version: 1, savedAt: Date.now(), slots
                }));
                return true;
            } catch (err) {
                handleError(err, 'pad.storage.save');
                return false;
            }
        },
        clear() {
            try { localStorage.removeItem(PAD_STORAGE_KEY); } catch (_) {}
        },
        export(slots) {
            return JSON.stringify({ version: 1, type: 'gmboop_pad_layout', slots }, null, 2);
        },
        import(json) {
            try {
                const data = JSON.parse(json);
                if (!data || data.type !== 'gmboop_pad_layout' || !Array.isArray(data.slots)) {
                    throw new Error('Invalid pad layout file');
                }
                return data.slots;
            } catch (err) {
                handleError(err, 'pad.storage.import');
                return null;
            }
        }
    };

    // ── Public namespace ───────────────────────────────────────────────
    const LoopUtils = {
        GM_FAMILIES,
        familyForProgram,
        parseSequence,
        handleError,
        toast,
        createSynth,
        loopDurationMs,
        scheduleSequence,
        validate,
        PadStorage
    };

    if (typeof window !== 'undefined') window.LoopUtils = LoopUtils;
    if (typeof module !== 'undefined' && module.exports) module.exports = LoopUtils;
})();
