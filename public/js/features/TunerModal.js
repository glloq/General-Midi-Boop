// ============================================================================
// File: js/features/TunerModal.js
// Version: v1.0.0
// Description:
//   Modal providing a chromatic instrument tuner using the browser Web Audio
//   API (getUserMedia + AnalyserNode + autocorrelation). Displays the detected
//   note, its frequency and the deviation in cents with a needle indicator.
//   Supports instrument presets (guitar, bass, violin, viola, cello, ukulele)
//   that highlight the target strings.
//
// Dependencies: BaseModal.js, i18n
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
        constructor(onCloseCb) {
            super({
                id: 'tuner-modal',
                size: 'md',
                title: 'tuner.title',
                customClass: 'tuner-modal'
            });

            this.onCloseCb = typeof onCloseCb === 'function' ? onCloseCb : null;
            this.logger = window.logger || console;

            // Audio pipeline
            this.audioCtx = null;
            this.analyser = null;
            this.mediaStream = null;
            this.sourceNode = null;
            this.rafId = null;
            this.buffer = new Float32Array(2048);

            // UI state
            this.state = {
                isListening: false,
                a4: parseFloat(localStorage.getItem('tuner_a4')) || 440,
                preset: localStorage.getItem('tuner_preset') || 'chromatic',
                smoothedFreq: 0,
                permissionDenied: false
            };

            this.logger.info('TunerModal', 'Modal initialized v1.0.0');
        }

        // ========================================================================
        // RENDER
        // ========================================================================

        renderBody() {
            const presetOptions = Object.keys(TUNER_PRESETS).map(key =>
                `<option value="${key}" ${this.state.preset === key ? 'selected' : ''}>${this.escape(this.t(TUNER_PRESETS[key].labelKey))}</option>`
            ).join('');

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
            // Attempt to start listening automatically; user can stop via button.
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
        // AUDIO CAPTURE
        // ========================================================================

        async _startListening() {
            if (this.state.isListening) return;
            this._clearError();

            try {
                this.mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    }
                });
            } catch (err) {
                this.logger.warn('TunerModal', 'getUserMedia failed:', err);
                this.state.permissionDenied = true;
                this._showError(this.t('tuner.permissionDenied'));
                return;
            }

            try {
                const Ctor = window.AudioContext || window.webkitAudioContext;
                this.audioCtx = new Ctor();
                this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
                this.analyser = this.audioCtx.createAnalyser();
                this.analyser.fftSize = 2048;
                this.analyser.smoothingTimeConstant = 0;
                this.sourceNode.connect(this.analyser);
            } catch (err) {
                this.logger.warn('TunerModal', 'AudioContext setup failed:', err);
                this._showError(this.t('tuner.permissionDenied'));
                this._teardownAudio();
                return;
            }

            this.state.isListening = true;
            this._updateToggleButton();
            this._tick();
        }

        _stopListening() {
            this.state.isListening = false;
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
            this._teardownAudio();
            this._updateToggleButton();
            this._resetDisplay();
        }

        _teardownAudio() {
            try {
                if (this.sourceNode) this.sourceNode.disconnect();
            } catch (_) {}
            this.sourceNode = null;
            this.analyser = null;

            if (this.audioCtx) {
                try { this.audioCtx.close(); } catch (_) {}
                this.audioCtx = null;
            }

            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
                this.mediaStream = null;
            }
        }

        _tick() {
            if (!this.state.isListening || !this.analyser || !this.audioCtx) return;

            this.analyser.getFloatTimeDomainData(this.buffer);
            const result = this._detectPitch(this.buffer, this.audioCtx.sampleRate);

            if (result.freq > 0 && result.confidence > 0.5) {
                // Exponential moving average to smooth the needle
                const alpha = 0.2;
                this.state.smoothedFreq = this.state.smoothedFreq > 0
                    ? this.state.smoothedFreq * (1 - alpha) + result.freq * alpha
                    : result.freq;
                this._updateDisplay(this.state.smoothedFreq);
            } else {
                this.state.smoothedFreq = 0;
                this._fadeDisplay();
            }

            this.rafId = requestAnimationFrame(() => this._tick());
        }

        // ========================================================================
        // PITCH DETECTION (normalized autocorrelation)
        // ========================================================================

        _detectPitch(buf, sampleRate) {
            const SIZE = buf.length;

            // 1) RMS gate: ignore silence / noise floor
            let rms = 0;
            for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
            rms = Math.sqrt(rms / SIZE);
            if (rms < 0.01) return { freq: 0, confidence: 0 };

            // 2) Trim leading/trailing samples below a low threshold
            const thr = 0.2;
            let r1 = 0, r2 = SIZE - 1;
            for (let i = 0; i < SIZE / 2; i++) {
                if (Math.abs(buf[i]) >= thr) { r1 = i; break; }
            }
            for (let i = 1; i < SIZE / 2; i++) {
                if (Math.abs(buf[SIZE - i]) >= thr) { r2 = SIZE - i; break; }
            }
            if (r2 - r1 < 32) return { freq: 0, confidence: 0 };
            const N = r2 - r1;

            // 3) Normalized autocorrelation, searching for the first strong peak
            // Restrict lag range to sensible musical frequencies: 60 Hz .. 2000 Hz
            const minLag = Math.max(2, Math.floor(sampleRate / 2000));
            const maxLag = Math.min(Math.floor(N / 2), Math.floor(sampleRate / 60));

            const c = new Float32Array(maxLag + 2);
            let bestLag = -1;
            let bestCorr = 0;
            let foundPeak = false;

            for (let lag = minLag; lag <= maxLag; lag++) {
                let sum = 0;
                for (let i = 0; i < N - lag; i++) {
                    sum += buf[r1 + i] * buf[r1 + i + lag];
                }
                const corr = sum / (N - lag);
                c[lag] = corr;

                if (corr > bestCorr) {
                    bestCorr = corr;
                    bestLag = lag;
                } else if (bestLag > 0 && corr < bestCorr * 0.8) {
                    // First strong peak has passed; stop scanning
                    foundPeak = true;
                    break;
                }
            }

            if (bestLag <= 0 || bestCorr <= 0) return { freq: 0, confidence: 0 };

            // 4) Parabolic interpolation around bestLag for sub-sample precision
            const y1 = c[bestLag - 1] || 0;
            const y2 = c[bestLag];
            const y3 = c[bestLag + 1] || 0;
            const denom = 2 * (2 * y2 - y1 - y3);
            const shift = denom !== 0 ? (y3 - y1) / denom : 0;
            const refinedLag = bestLag + shift;

            const freq = sampleRate / refinedLag;
            // Normalize confidence against signal energy at lag 0
            const energy = c[minLag] > 0 ? c[minLag] : bestCorr;
            const confidence = Math.min(1, bestCorr / (energy || 1));

            return { freq, confidence: foundPeak ? confidence : confidence * 0.6 };
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

            // Pick the target note with the smallest MIDI distance to the detected one.
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
        }

        _clearError() {
            const el = this.$('#tunerError');
            if (el) {
                el.textContent = '';
                el.style.display = 'none';
            }
            this.state.permissionDenied = false;
        }
    }

    if (typeof window !== 'undefined') {
        window.TunerModal = TunerModal;
    }
})();
