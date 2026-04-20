// ============================================================================
// File: js/features/TunerModal.js
// Version: v1.1.0
// Description:
//   Modal providing a chromatic instrument tuner. Audio is captured on the
//   backend (arecord on the Raspberry Pi, same ALSA device as the calibration
//   modal) and pitch detection runs server-side. The frontend subscribes to
//   `tuner:pitch` WebSocket events and renders note name, frequency and cents
//   deviation with a needle indicator. Supports instrument presets (guitar,
//   bass, violin, viola, cello, ukulele) that highlight the target strings.
//
// Dependencies: BaseModal.js, BackendAPIClient, i18n
// ============================================================================

(function() {
    'use strict';

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Presets: `notes` are note names with scientific octave (A4 = MIDI 69).
    const TUNER_PRESETS = {
        chromatic: { labelKey: 'tuner.preset.chromatic', notes: null },
        guitar:    { labelKey: 'tuner.preset.guitar',    notes: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
        bass:      { labelKey: 'tuner.preset.bass',      notes: ['E1', 'A1', 'D2', 'G2'] },
        violin:    { labelKey: 'tuner.preset.violin',    notes: ['G3', 'D4', 'A4', 'E5'] },
        viola:     { labelKey: 'tuner.preset.viola',     notes: ['C3', 'G3', 'D4', 'A4'] },
        cello:     { labelKey: 'tuner.preset.cello',     notes: ['C2', 'G2', 'D3', 'A3'] },
        ukulele:   { labelKey: 'tuner.preset.ukulele',   notes: ['G4', 'C4', 'E4', 'A4'] }
    };

    // Convert a scientific note name (e.g. "A4", "C#3") to its MIDI number.
    // A4 = 69 by convention.
    function noteNameToMidi(name) {
        const match = /^([A-G]#?)(-?\d+)$/.exec(name);
        if (!match) return null;
        const idx = NOTE_NAMES.indexOf(match[1]);
        const octave = parseInt(match[2], 10);
        if (idx < 0) return null;
        return idx + (octave + 1) * 12;
    }

    function midiToNoteName(midi) {
        const rounded = Math.round(midi);
        return NOTE_NAMES[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
    }

    class TunerModal extends BaseModal {
        /**
         * @param {Object} [options]
         * @param {Object} [options.api]       - BackendAPIClient (falls back to window.api)
         * @param {string} [options.alsaDevice] - ALSA device string (e.g. "hw:1,0")
         * @param {Function} [options.onClose] - Invoked after the modal closes
         */
        constructor(options = {}) {
            super({
                id: 'tuner-modal',
                size: 'md',
                title: 'tuner.title',
                customClass: 'tuner-modal'
            });

            this.api = options.api || null;
            this.onCloseCb = typeof options.onClose === 'function' ? options.onClose : null;
            this.alsaDevice = options.alsaDevice || null;
            this.logger = window.logger || console;

            // Smoothing state
            this._lastUpdateTs = 0;
            this._noSignalTimer = null;
            this._freqRing = [];        // recent accepted frequencies
            this._confRing = [];        // parallel confidences for weighting
            this._ringSize = 9;         // ~1.2 s at 128 ms/frame
            this._changeStreak = 0;     // consecutive frames far from current median

            // UI state
            this.state = {
                isListening: false,
                a4: parseFloat(localStorage.getItem('tuner_a4')) || 440,
                preset: localStorage.getItem('tuner_preset') || 'chromatic',
                smoothedFreq: 0,
                error: null
            };

            // WebSocket listener reference (for clean unsubscribe)
            this._onPitchEvent = null;

            this.logger.info('TunerModal', 'Modal initialized v1.1.0');
        }

        _getApi() {
            return this.api || window.api || window.apiClient;
        }

        // ========================================================================
        // RENDER
        // ========================================================================

        renderBody() {
            const presetOptions = Object.keys(TUNER_PRESETS).map(key =>
                `<option value="${key}" ${this.state.preset === key ? 'selected' : ''}>${this.escape(this.t(TUNER_PRESETS[key].labelKey))}</option>`
            ).join('');

            const device = this.alsaDevice ? ` (${this.escape(this.alsaDevice)})` : '';

            return `
                <div class="tuner-controls">
                    <div class="tuner-field">
                        <label for="tunerPreset">${this.t('tuner.preset.label')}:</label>
                        <select id="tunerPreset" class="tuner-select">${presetOptions}</select>
                    </div>
                    <div class="tuner-field">
                        <label for="tunerA4">${this.t('tuner.referenceA4')}:</label>
                        <input type="number" id="tunerA4" class="tuner-input"
                               min="415" max="466" step="0.1" value="${this.state.a4}">
                    </div>
                </div>

                <div class="tuner-device-info">
                    🎤 ${this.t('tuner.listeningVia')}${device}
                </div>

                <div class="tuner-display" id="tunerDisplay">
                    <div class="tuner-note-large" id="tunerNote">—</div>
                    <div class="tuner-freq" id="tunerFreq">— Hz</div>
                    <div class="tuner-bar" aria-hidden="true">
                        <div class="tuner-bar-scale">
                            <span class="tuner-bar-label" style="left:0%">-50¢</span>
                            <span class="tuner-bar-label" style="left:50%">0</span>
                            <span class="tuner-bar-label" style="left:100%">+50¢</span>
                        </div>
                        <div class="tuner-bar-track">
                            <div class="tuner-bar-center"></div>
                            <div class="tuner-bar-needle" id="tunerNeedle" style="left:50%"></div>
                        </div>
                    </div>
                    <div class="tuner-status" id="tunerStatus">—</div>
                </div>

                <div class="tuner-targets" id="tunerTargets"></div>

                <div class="tuner-error" id="tunerError" style="display:none;"></div>
            `;
        }

        renderFooter() {
            return `
                <button class="btn btn-primary tuner-toggle-btn" id="tunerToggleBtn" type="button">
                    ▶ ${this.t('tuner.start')}
                </button>
                <button class="btn btn-secondary" id="tunerCloseBtn" type="button">
                    ${this.t('common.close')}
                </button>
            `;
        }

        // ========================================================================
        // LIFECYCLE
        // ========================================================================

        onOpen() {
            this._attachHandlers();
            this._renderTargets();
            // Auto-start listening; user can stop via button.
            this._startListening();
        }

        onClose() {
            this._stopListening();
            if (this.onCloseCb) {
                try { this.onCloseCb(); } catch (e) { this.logger.warn('TunerModal', 'onCloseCb threw:', e); }
            }
        }

        onUpdate() {
            this._renderTargets();
            this._updateToggleButton();
        }

        // ========================================================================
        // EVENT HANDLERS
        // ========================================================================

        _attachHandlers() {
            const closeBtn = this.$('#tunerCloseBtn');
            if (closeBtn) closeBtn.addEventListener('click', () => this.close());

            const toggleBtn = this.$('#tunerToggleBtn');
            if (toggleBtn) toggleBtn.addEventListener('click', () => this._toggleListening());

            const presetSel = this.$('#tunerPreset');
            if (presetSel) presetSel.addEventListener('change', (e) => {
                this.state.preset = e.target.value;
                localStorage.setItem('tuner_preset', this.state.preset);
                this._renderTargets();
            });

            const a4Input = this.$('#tunerA4');
            if (a4Input) a4Input.addEventListener('change', (e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 415 && val <= 466) {
                    this.state.a4 = val;
                    localStorage.setItem('tuner_a4', String(val));
                }
            });
        }

        _toggleListening() {
            if (this.state.isListening) {
                this._stopListening();
            } else {
                this._startListening();
            }
        }

        _updateToggleButton() {
            const btn = this.$('#tunerToggleBtn');
            if (!btn) return;
            if (this.state.isListening) {
                btn.textContent = `⏸ ${this.t('tuner.stop')}`;
                btn.classList.add('listening');
            } else {
                btn.textContent = `▶ ${this.t('tuner.start')}`;
                btn.classList.remove('listening');
            }
        }

        // ========================================================================
        // BACKEND PITCH MONITORING
        // ========================================================================

        _resetSmoothing() {
            this._freqRing = [];
            this._confRing = [];
            this._changeStreak = 0;
            this.state.smoothedFreq = 0;
            this._lastUpdateTs = 0;
        }

        async _startListening() {
            if (this.state.isListening) return;
            this._clearError();
            this._resetSmoothing();

            const api = this._getApi();
            if (!api || !api.sendCommand || !api.on) {
                this._showError(this.t('tuner.backendUnavailable'));
                return;
            }

            // Subscribe to pitch events first so we don't miss the initial ones.
            this._onPitchEvent = (payload) => this._handlePitchEvent(payload);
            api.on('tuner:pitch', this._onPitchEvent);

            try {
                await api.sendCommand('tuner_monitor_start', {
                    alsaDevice: this.alsaDevice || undefined
                });
            } catch (err) {
                this.logger.warn('TunerModal', 'tuner_monitor_start failed:', err);
                this._showError(`${this.t('tuner.backendError')}: ${err && err.message ? err.message : err}`);
                if (this._onPitchEvent && api.off) api.off('tuner:pitch', this._onPitchEvent);
                this._onPitchEvent = null;
                return;
            }

            this.state.isListening = true;
            this._updateToggleButton();
            this._scheduleNoSignalWatchdog();
        }

        async _stopListening() {
            this.state.isListening = false;
            this._updateToggleButton();

            if (this._noSignalTimer) {
                clearInterval(this._noSignalTimer);
                this._noSignalTimer = null;
            }

            const api = this._getApi();
            if (api && this._onPitchEvent && api.off) {
                api.off('tuner:pitch', this._onPitchEvent);
            }
            this._onPitchEvent = null;

            if (api && api.sendCommand) {
                try {
                    await api.sendCommand('tuner_monitor_stop', {});
                } catch (err) {
                    this.logger.warn('TunerModal', 'tuner_monitor_stop failed:', err);
                }
            }

            this._resetDisplay();
        }

        /**
         * Smooth the raw detector output. Plucked/bowed strings produce
         * noisy readings, octave slips, and attack transients; a plain
         * EMA is not enough. Pipeline:
         *   1. Discard low-confidence frames.
         *   2. Snap obvious octave errors to the neighborhood of the
         *      recent median (1/3, 1/2, 2x, 3x jumps get corrected).
         *   3. Detect a genuine note change (3 consecutive frames > 100¢
         *      away from the current median) and reset the ring.
         *   4. Keep a ring of the last N frames; the displayed frequency
         *      is the confidence-weighted median, then EMA-smoothed for
         *      silky needle motion.
         */
        _handlePitchEvent(payload) {
            if (!this.isOpen || !this.state.isListening) return;
            const freq = payload && typeof payload.freq === 'number' ? payload.freq : 0;
            const confidence = payload && typeof payload.confidence === 'number' ? payload.confidence : 0;

            if (freq <= 0 || confidence < 0.6) return;

            let corrected = freq;
            const ring = this._freqRing;

            if (ring.length >= 2) {
                // Use the median of the 3 most recent accepted values as a
                // stable anchor for octave-error correction.
                const recent = ring.slice(-Math.min(3, ring.length));
                const sorted = recent.slice().sort((a, b) => a - b);
                const anchor = sorted[Math.floor(sorted.length / 2)];
                const ratio = freq / anchor;

                if (ratio > 1.8 && ratio < 2.2)      corrected = freq / 2;
                else if (ratio > 0.45 && ratio < 0.55) corrected = freq * 2;
                else if (ratio > 2.8 && ratio < 3.2)   corrected = freq / 3;
                else if (ratio > 0.30 && ratio < 0.36) corrected = freq * 3;
            }

            // Detect a real note change: consistently far from the ring median.
            if (ring.length >= 3) {
                const sorted = ring.slice().sort((a, b) => a - b);
                const median = sorted[Math.floor(sorted.length / 2)];
                const cents = 1200 * Math.log2(corrected / median);
                if (Math.abs(cents) > 100) {
                    this._changeStreak++;
                    if (this._changeStreak >= 3) {
                        // New note: flush history and reseed.
                        this._freqRing = [];
                        this._confRing = [];
                        this.state.smoothedFreq = 0;
                        this._changeStreak = 0;
                    }
                } else {
                    this._changeStreak = 0;
                }
            }

            this._freqRing.push(corrected);
            this._confRing.push(confidence);
            if (this._freqRing.length > this._ringSize) {
                this._freqRing.shift();
                this._confRing.shift();
            }

            // Confidence-weighted median over the ring.
            const pairs = this._freqRing.map((f, i) => ({ f, w: this._confRing[i] }));
            pairs.sort((a, b) => a.f - b.f);
            const totalW = pairs.reduce((s, p) => s + p.w, 0);
            let acc = 0;
            let weightedMedian = pairs[Math.floor(pairs.length / 2)].f;
            for (const p of pairs) {
                acc += p.w;
                if (acc >= totalW / 2) { weightedMedian = p.f; break; }
            }

            // EMA on top of the median for smooth needle motion.
            const alpha = this.state.smoothedFreq > 0 ? 0.25 : 1;
            this.state.smoothedFreq = this.state.smoothedFreq * (1 - alpha) + weightedMedian * alpha;

            this._lastUpdateTs = Date.now();
            this._updateDisplay(this.state.smoothedFreq);
        }

        _scheduleNoSignalWatchdog() {
            // If no usable pitch has arrived for ~500 ms, fade the display and
            // clear the smoothing history so the next note starts fresh.
            this._noSignalTimer = setInterval(() => {
                if (!this.state.isListening) return;
                if (Date.now() - this._lastUpdateTs > 500) {
                    this._resetSmoothing();
                    this._fadeDisplay();
                }
            }, 250);
        }

        // ========================================================================
        // DISPLAY
        // ========================================================================

        _updateDisplay(freq) {
            const a4 = this.state.a4;
            const midiFloat = 69 + 12 * Math.log2(freq / a4);
            const rounded = Math.round(midiFloat);
            const cents = (midiFloat - rounded) * 100;
            const name = midiToNoteName(rounded);

            const noteEl = this.$('#tunerNote');
            const freqEl = this.$('#tunerFreq');
            const needle = this.$('#tunerNeedle');
            const statusEl = this.$('#tunerStatus');
            const displayEl = this.$('#tunerDisplay');

            if (noteEl) noteEl.textContent = name;
            if (freqEl) freqEl.textContent = `${freq.toFixed(1)} Hz`;

            if (needle) {
                const clamped = Math.max(-50, Math.min(50, cents));
                needle.style.left = `${50 + clamped}%`;
            }

            const inTune = Math.abs(cents) <= 5;
            if (displayEl) {
                displayEl.classList.toggle('in-tune', inTune);
                displayEl.classList.toggle('too-low', cents < -5);
                displayEl.classList.toggle('too-high', cents > 5);
            }

            if (statusEl) {
                if (inTune) statusEl.textContent = this.t('tuner.inTune');
                else if (cents < 0) statusEl.textContent = `${this.t('tuner.tooLow')} (${cents.toFixed(1)}¢)`;
                else statusEl.textContent = `${this.t('tuner.tooHigh')} (+${cents.toFixed(1)}¢)`;
            }

            this._highlightTarget(rounded);
        }

        _fadeDisplay() {
            const statusEl = this.$('#tunerStatus');
            const displayEl = this.$('#tunerDisplay');
            if (statusEl) statusEl.textContent = '—';
            if (displayEl) {
                displayEl.classList.remove('in-tune', 'too-low', 'too-high');
            }
        }

        _resetDisplay() {
            const noteEl = this.$('#tunerNote');
            const freqEl = this.$('#tunerFreq');
            const needle = this.$('#tunerNeedle');
            if (noteEl) noteEl.textContent = '—';
            if (freqEl) freqEl.textContent = '— Hz';
            if (needle) needle.style.left = '50%';
            this._fadeDisplay();
            this.$$('.tuner-target').forEach(el => el.classList.remove('active'));
        }

        _renderTargets() {
            const container = this.$('#tunerTargets');
            if (!container) return;

            const preset = TUNER_PRESETS[this.state.preset];
            if (!preset || !preset.notes) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = preset.notes.map(n =>
                `<div class="tuner-target" data-note="${this.escape(n)}">${this.escape(n)}</div>`
            ).join('');
        }

        _highlightTarget(midi) {
            const preset = TUNER_PRESETS[this.state.preset];
            if (!preset || !preset.notes) return;

            let closestName = null;
            let closestDist = Infinity;
            preset.notes.forEach(n => {
                const m = noteNameToMidi(n);
                if (m == null) return;
                const d = Math.abs(m - midi);
                if (d < closestDist) { closestDist = d; closestName = n; }
            });

            this.$$('.tuner-target').forEach(el => {
                el.classList.toggle('active', el.dataset.note === closestName);
            });
        }

        _showError(msg) {
            const el = this.$('#tunerError');
            if (el) {
                el.textContent = msg;
                el.style.display = 'block';
            }
            this.state.error = msg;
        }

        _clearError() {
            const el = this.$('#tunerError');
            if (el) {
                el.textContent = '';
                el.style.display = 'none';
            }
            this.state.error = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.TunerModal = TunerModal;
    }
})();
