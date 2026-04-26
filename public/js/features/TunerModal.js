// ============================================================================
// File: js/features/TunerModal.js
// Version: v1.3.0
// Description:
//   Modal providing a chromatic instrument tuner. Audio is captured on the
//   backend (arecord on the Raspberry Pi) and pitch detection runs server-
//   side (MPM algorithm). The frontend subscribes to `tuner:pitch` events.
//
//   Three operating modes:
//     - 'auto'       : no target, shows the note closest to the detected freq
//     - 'note'       : user picks a target note from a chromatic horizontal
//                      strip (E1..C6); display shows up/down guidance against
//                      the chosen target
//     - 'instrument' : user picks a connected MIDI instrument (via the
//                      `tuner_list_instruments` backend command) or a generic
//                      preset. For stringed instruments with a configured
//                      tuning the picker exposes the open-string notes; for
//                      melodic instruments it falls back to the chromatic row.
//
// Dependencies: BaseModal.js, BackendAPIClient, i18n
// ============================================================================

(function() {
    'use strict';

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const NOTE_NAMES_FR = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
    const BLACK_KEY_SEMITONES = new Set([1, 3, 6, 8, 10]);

    // Concert pitch reference. Modern standard is 440 Hz; exposed as a
    // module constant rather than a user setting because any reasonable
    // value lives between 440 and 443 and practically never changes.
    const A4_HZ = 440;

    const DISPLAY_FORMATS = ['us', 'fr', 'midi'];

    // Instrument presets for the 'instrument' mode. `notes` lists open strings
    // in standard tuning, using scientific pitch notation (A4 = MIDI 69).
    const TUNER_PRESETS = {
        guitar:  { labelKey: 'tuner.preset.guitar',  notes: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
        bass:    { labelKey: 'tuner.preset.bass',    notes: ['E1', 'A1', 'D2', 'G2'] },
        violin:  { labelKey: 'tuner.preset.violin',  notes: ['G3', 'D4', 'A4', 'E5'] },
        viola:   { labelKey: 'tuner.preset.viola',   notes: ['C3', 'G3', 'D4', 'A4'] },
        cello:   { labelKey: 'tuner.preset.cello',   notes: ['C2', 'G2', 'D3', 'A3'] },
        ukulele: { labelKey: 'tuner.preset.ukulele', notes: ['G4', 'C4', 'E4', 'A4'] }
    };

    // Chromatic picker range in 'note' mode.
    const PICKER_MIN_MIDI = 28; // E1
    const PICKER_MAX_MIDI = 84; // C6

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

    function midiToNoteNameFormatted(midi, format) {
        const rounded = Math.round(midi);
        if (format === 'midi') return String(rounded);
        const table = format === 'fr' ? NOTE_NAMES_FR : NOTE_NAMES;
        return table[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
    }

    function midiToFreq(midi, a4) {
        return a4 * Math.pow(2, (midi - 69) / 12);
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
                size: 'lg',
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
            this._freqRing = [];
            this._confRing = [];
            this._ringSize = 6;
            this._changeStreak = 0;

            const savedMode = localStorage.getItem('tuner_mode');
            const savedTarget = parseInt(localStorage.getItem('tuner_targetMidi'), 10);
            const savedPreset = localStorage.getItem('tuner_preset');
            const savedFormat = localStorage.getItem('tuner_displayFormat');
            const savedSource = localStorage.getItem('tuner_instrumentSource');

            // UI state
            this.state = {
                isListening: false,
                mode: ['auto', 'note', 'instrument'].includes(savedMode) ? savedMode : 'auto',
                preset: (savedPreset && TUNER_PRESETS[savedPreset]) ? savedPreset : 'guitar',
                targetMidi: Number.isFinite(savedTarget) ? savedTarget : 64, // E4 default
                displayFormat: DISPLAY_FORMATS.includes(savedFormat) ? savedFormat : 'us',
                // For 'instrument' mode: whether we're looking at a connected
                // instrument or a generic preset. Value is either
                //   "connected:<deviceId>:<channel>" or "preset:<key>".
                instrumentSource: savedSource || null,
                smoothedFreq: 0,
                error: null
            };

            // Populated on first switch into 'instrument' mode.
            this._connectedInstruments = [];
            this._connectedLoaded = false;

            this._onPitchEvent = null;

            this.logger.info('TunerModal', 'Modal initialized v1.3.0');
        }

        _getApi() {
            return this.api || window.api || window.apiClient;
        }

        // ========================================================================
        // RENDER
        // ========================================================================

        renderBody() {
            const device = this.alsaDevice ? ` (${this.escape(this.alsaDevice)})` : '';
            const mode = this.state.mode;
            const fmt = this.state.displayFormat;

            return `
                <div class="tuner-top-bar">
                    <div class="tuner-mode-selector" role="tablist">
                        <button type="button" role="tab" class="tuner-mode-btn ${mode === 'auto' ? 'active' : ''}"
                                data-mode="auto">${this.t('tuner.mode.auto')}</button>
                        <button type="button" role="tab" class="tuner-mode-btn ${mode === 'note' ? 'active' : ''}"
                                data-mode="note">${this.t('tuner.mode.note')}</button>
                        <button type="button" role="tab" class="tuner-mode-btn ${mode === 'instrument' ? 'active' : ''}"
                                data-mode="instrument">${this.t('tuner.mode.instrument')}</button>
                    </div>
                    <div class="tuner-format-selector" role="tablist" aria-label="${this.t('tuner.displayFormat')}">
                        <button type="button" role="tab" class="tuner-format-btn ${fmt === 'us' ? 'active' : ''}"
                                data-format="us" title="${this.escape(this.t('tuner.format.lettersTitle'))}">${this.escape(this.t('tuner.format.letters'))}</button>
                        <button type="button" role="tab" class="tuner-format-btn ${fmt === 'fr' ? 'active' : ''}"
                                data-format="fr" title="${this.escape(this.t('tuner.format.solfegeTitle'))}">${this.escape(this.t('tuner.format.solfege'))}</button>
                        <button type="button" role="tab" class="tuner-format-btn ${fmt === 'midi' ? 'active' : ''}"
                                data-format="midi" title="${this.escape(this.t('tuner.format.midiTitle'))}">${this.escape(this.t('tuner.format.midi'))}</button>
                    </div>
                </div>

                <div class="tuner-picker-row" id="tunerPickerRow">
                    ${this._renderPickerRow()}
                </div>

                <div class="tuner-display" id="tunerDisplay">
                    <div class="tuner-arrow tuner-arrow-down" id="tunerArrowDown" aria-hidden="true">▼</div>
                    <div class="tuner-note-large" id="tunerNote">—</div>
                    <div class="tuner-arrow tuner-arrow-up" id="tunerArrowUp" aria-hidden="true">▲</div>
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

                <div class="tuner-device-info">🎤 ${this.t('tuner.listeningVia')}${device}</div>

                <div class="tuner-error" id="tunerError" style="display:none;"></div>
            `;
        }

        /**
         * Build the content that goes inside the picker row. The row itself
         * is always in the DOM (simplifies layout) but content varies by mode.
         */
        _renderPickerRow() {
            const mode = this.state.mode;
            if (mode === 'auto') {
                return `<div class="tuner-picker-hint">${this.t('tuner.hintAuto')}</div>`;
            }
            if (mode === 'instrument') {
                return this._renderInstrumentRow();
            }
            // mode === 'note' : full chromatic picker
            return `<div class="tuner-picker tuner-picker-chromatic">${this._chromaticPillsHtml()}</div>`;
        }

        /**
         * Build the full chromatic picker HTML (E1..C6, piano-key styling).
         * Reused by mode 'note' and by mode 'instrument' when the selected
         * connected instrument is melodic / has no string tuning.
         */
        _chromaticPillsHtml() {
            const pills = [];
            for (let m = PICKER_MIN_MIDI; m <= PICKER_MAX_MIDI; m++) {
                const isBlack = BLACK_KEY_SEMITONES.has(((m % 12) + 12) % 12);
                const active = m === this.state.targetMidi;
                pills.push(`<button type="button"
                        class="tuner-pick-pill ${isBlack ? 'black' : ''} ${active ? 'active' : ''}"
                        data-midi="${m}">${this.escape(this._formatNote(m))}</button>`);
            }
            return pills.join('');
        }

        /**
         * Build the open-string picker for an array of MIDI notes.
         */
        _stringPillsHtml(midiArr) {
            return midiArr.map(midi => {
                const active = midi === this.state.targetMidi;
                return `<button type="button" class="tuner-pick-pill ${active ? 'active' : ''}"
                        data-midi="${midi}">${this.escape(this._formatNote(midi))}</button>`;
            }).join('');
        }

        /**
         * Render the 'instrument' mode : a grouped <select> of connected
         * instruments + generic presets, followed by a picker row whose
         * content depends on what's selected.
         */
        _renderInstrumentRow() {
            // Default selection when nothing's been chosen yet: first connected
            // instrument that has a configured tuning, else first generic preset.
            let sourceKey = this.state.instrumentSource;
            if (!sourceKey) {
                const configured = this._connectedInstruments.find(x => x.tuning);
                if (configured) sourceKey = `connected:${configured.deviceId}:${configured.channel}`;
                else sourceKey = `preset:${this.state.preset}`;
            }

            // Build grouped options.
            const connectedOpts = this._connectedInstruments.map(inst => {
                const key = `connected:${inst.deviceId}:${inst.channel}`;
                const selected = key === sourceKey ? 'selected' : '';
                const badge = inst.source === 'db' ? ` ${this.t('tuner.sourceConfigured')}` : '';
                return `<option value="${this.escape(key)}" ${selected}>${this.escape(inst.displayName)}${badge}</option>`;
            }).join('');

            const presetOpts = Object.keys(TUNER_PRESETS).map(presetKey => {
                const key = `preset:${presetKey}`;
                const selected = key === sourceKey ? 'selected' : '';
                return `<option value="${this.escape(key)}" ${selected}>${this.escape(this.t(TUNER_PRESETS[presetKey].labelKey))}</option>`;
            }).join('');

            const groups = [];
            if (connectedOpts) {
                groups.push(`<optgroup label="${this.escape(this.t('tuner.connectedInstruments'))}">${connectedOpts}</optgroup>`);
            }
            groups.push(`<optgroup label="${this.escape(this.t('tuner.genericPresets'))}">${presetOpts}</optgroup>`);

            // Build the picker content for the current selection.
            const pickerHtml = this._renderInstrumentPicker(sourceKey);

            const loadedAndEmpty = this._connectedLoaded && this._connectedInstruments.length === 0;
            const emptyHint = loadedAndEmpty
                ? `<div class="tuner-picker-hint tuner-picker-hint-empty">${this.t('tuner.noInstrumentsConnected')}</div>`
                : '';

            return `
                <div class="tuner-instrument-row">
                    <label for="tunerInstrumentSelect">${this.t('tuner.preset.label')}:</label>
                    <select id="tunerInstrumentSelect" class="tuner-select">${groups.join('')}</select>
                </div>
                ${emptyHint}
                ${pickerHtml}
            `;
        }

        _renderInstrumentPicker(sourceKey) {
            if (!sourceKey) return '';
            if (sourceKey.startsWith('preset:')) {
                const presetKey = sourceKey.slice('preset:'.length);
                const preset = TUNER_PRESETS[presetKey];
                if (!preset) return '';
                const midis = preset.notes.map(noteNameToMidi).filter(m => Number.isFinite(m));
                return `<div class="tuner-picker tuner-picker-strings">${this._stringPillsHtml(midis)}</div>`;
            }
            if (sourceKey.startsWith('connected:')) {
                const rest = sourceKey.slice('connected:'.length);
                const lastColon = rest.lastIndexOf(':');
                const deviceId = rest.slice(0, lastColon);
                const channel = parseInt(rest.slice(lastColon + 1), 10);
                const inst = this._connectedInstruments.find(x =>
                    x.deviceId === deviceId && x.channel === channel);

                if (!inst) {
                    return `<div class="tuner-picker-hint tuner-picker-hint-empty">${this.t('tuner.noInstrumentsConnected')}</div>`;
                }
                // 1. Configured stringed → show open strings
                if (Array.isArray(inst.tuning) && inst.tuning.length > 0) {
                    return `<div class="tuner-picker tuner-picker-strings">${this._stringPillsHtml(inst.tuning)}</div>`;
                }
                // 2. Stringed but not configured → ask the user to configure
                if (inst.looksStringed) {
                    return `<div class="tuner-picker-hint tuner-picker-hint-empty">${this.t('tuner.noConfigForInstrument')}</div>`;
                }
                // 3. Melodic → full chromatic row
                return `<div class="tuner-picker tuner-picker-chromatic">${this._chromaticPillsHtml()}</div>`;
            }
            return '';
        }

        _formatNote(midi) {
            return midiToNoteNameFormatted(midi, this.state.displayFormat);
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
            this._scrollPickerToTarget();
            this._startListening();
            // If the modal opens directly into 'instrument' mode, fetch the
            // connected-instruments list and re-render once it arrives.
            if (this.state.mode === 'instrument') {
                this._loadConnectedInstruments().then(() => this._rerenderPicker());
            }
        }

        onClose() {
            this._stopListening();
            if (this.onCloseCb) {
                try { this.onCloseCb(); } catch (e) { this.logger.warn('TunerModal', 'onCloseCb threw:', e); }
            }
        }

        onUpdate() {
            this._updateToggleButton();
        }

        // ========================================================================
        // EVENT HANDLERS
        // ========================================================================

        _attachHandlers() {
            this.$('#tunerCloseBtn')?.addEventListener('click', () => this.close());
            this.$('#tunerToggleBtn')?.addEventListener('click', () => this._toggleListening());

            // Mode selector buttons
            this.$$('.tuner-mode-btn').forEach(btn => {
                btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
            });

            // Note-format selector (US / FR / MIDI)
            this.$$('.tuner-format-btn').forEach(btn => {
                btn.addEventListener('click', () => this._setDisplayFormat(btn.dataset.format));
            });

            this._attachPickerHandlers();
        }

        _setDisplayFormat(format) {
            if (!DISPLAY_FORMATS.includes(format)) return;
            if (format === this.state.displayFormat) return;
            this.state.displayFormat = format;
            localStorage.setItem('tuner_displayFormat', format);
            this.$$('.tuner-format-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.format === format);
            });
            // Re-render picker pills (they show note names) and the current
            // target note in the big display.
            this._rerenderPicker();
            this._resetDisplay();
        }

        _attachPickerHandlers() {
            // Instrument select (mode === 'instrument'): choose between a
            // connected instrument or a generic preset.
            this.$('#tunerInstrumentSelect')?.addEventListener('change', (e) => {
                this._applyInstrumentSource(e.target.value);
            });

            // Pick a target note
            this.$$('.tuner-pick-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    const midi = parseInt(pill.dataset.midi, 10);
                    if (!Number.isFinite(midi)) return;
                    this.state.targetMidi = midi;
                    localStorage.setItem('tuner_targetMidi', String(midi));
                    this.$$('.tuner-pick-pill').forEach(p => p.classList.toggle('active', p === pill));
                    this._scrollPickerToTarget();
                });
            });
        }

        _applyInstrumentSource(sourceKey) {
            if (!sourceKey) return;
            this.state.instrumentSource = sourceKey;
            localStorage.setItem('tuner_instrumentSource', sourceKey);

            // Default the target to the first note of the new selection,
            // so the display has something to compare against right away.
            let firstMidi = null;
            if (sourceKey.startsWith('preset:')) {
                const key = sourceKey.slice('preset:'.length);
                this.state.preset = key;
                localStorage.setItem('tuner_preset', key);
                const noteName = TUNER_PRESETS[key]?.notes[0];
                firstMidi = noteName ? noteNameToMidi(noteName) : null;
            } else if (sourceKey.startsWith('connected:')) {
                const rest = sourceKey.slice('connected:'.length);
                const lastColon = rest.lastIndexOf(':');
                const deviceId = rest.slice(0, lastColon);
                const channel = parseInt(rest.slice(lastColon + 1), 10);
                const inst = this._connectedInstruments.find(x =>
                    x.deviceId === deviceId && x.channel === channel);
                if (inst && Array.isArray(inst.tuning) && inst.tuning.length > 0) {
                    firstMidi = inst.tuning[0];
                }
                // Melodic / unconfigured instruments keep the existing targetMidi.
            }

            if (firstMidi != null) {
                this.state.targetMidi = firstMidi;
                localStorage.setItem('tuner_targetMidi', String(firstMidi));
            }

            this._rerenderPicker();
        }

        /**
         * Fetch the list of connected instruments once, the first time the
         * user switches to 'instrument' mode in a given modal session.
         */
        async _loadConnectedInstruments() {
            if (this._connectedLoaded) return;
            const api = this._getApi();
            if (!api || !api.sendCommand) {
                this._connectedInstruments = [];
                this._connectedLoaded = true;
                return;
            }
            try {
                const res = await api.sendCommand('tuner_list_instruments', {});
                this._connectedInstruments = (res && Array.isArray(res.instruments)) ? res.instruments : [];
            } catch (err) {
                this.logger.warn('TunerModal', 'tuner_list_instruments failed:', err);
                this._connectedInstruments = [];
            }
            this._connectedLoaded = true;
        }

        _setMode(newMode) {
            if (!['auto', 'note', 'instrument'].includes(newMode)) return;
            if (newMode === this.state.mode) return;
            this.state.mode = newMode;
            localStorage.setItem('tuner_mode', newMode);
            this.$$('.tuner-mode-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.mode === newMode);
            });
            this._rerenderPicker();
            this._resetDisplay();

            // First time we enter 'instrument' mode, fetch the connected list
            // and re-render once it's here so the dropdown actually has items.
            if (newMode === 'instrument' && !this._connectedLoaded) {
                this._loadConnectedInstruments().then(() => this._rerenderPicker());
            }
        }

        _rerenderPicker() {
            const row = this.$('#tunerPickerRow');
            if (!row) return;
            row.innerHTML = this._renderPickerRow();
            this._attachPickerHandlers();
            this._scrollPickerToTarget();
        }

        _scrollPickerToTarget() {
            // Keep the active pill centered in view (chromatic picker scrolls).
            const active = this.$('.tuner-pick-pill.active');
            if (active && typeof active.scrollIntoView === 'function') {
                active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
            }
        }

        _toggleListening() {
            if (this.state.isListening) this._stopListening();
            else this._startListening();
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
            if (api && this._onPitchEvent && api.off) api.off('tuner:pitch', this._onPitchEvent);
            this._onPitchEvent = null;

            if (api && api.sendCommand) {
                try { await api.sendCommand('tuner_monitor_stop', {}); }
                catch (err) { this.logger.warn('TunerModal', 'tuner_monitor_stop failed:', err); }
            }

            this._resetDisplay();
        }

        _handlePitchEvent(payload) {
            if (!this.isOpen || !this.state.isListening) return;
            const freq = payload && typeof payload.freq === 'number' ? payload.freq : 0;
            const confidence = payload && typeof payload.confidence === 'number' ? payload.confidence : 0;
            if (freq <= 0 || confidence < 0.5) return;

            let corrected = freq;
            const ring = this._freqRing;

            if (ring.length >= 2) {
                const recent = ring.slice(-Math.min(3, ring.length));
                const sorted = recent.slice().sort((a, b) => a - b);
                const anchor = sorted[Math.floor(sorted.length / 2)];
                const ratio = freq / anchor;
                if (ratio > 1.8 && ratio < 2.2)        corrected = freq / 2;
                else if (ratio > 0.45 && ratio < 0.55) corrected = freq * 2;
                else if (ratio > 2.8 && ratio < 3.2)   corrected = freq / 3;
                else if (ratio > 0.30 && ratio < 0.36) corrected = freq * 3;
            }

            if (ring.length >= 3) {
                const sorted = ring.slice().sort((a, b) => a - b);
                const median = sorted[Math.floor(sorted.length / 2)];
                const cents = 1200 * Math.log2(corrected / median);
                if (Math.abs(cents) > 100) {
                    this._changeStreak++;
                    if (this._changeStreak >= 2) {
                        this._freqRing = []; this._confRing = [];
                        this.state.smoothedFreq = 0; this._changeStreak = 0;
                    }
                } else {
                    this._changeStreak = 0;
                }
            }

            this._freqRing.push(corrected);
            this._confRing.push(confidence);
            if (this._freqRing.length > this._ringSize) {
                this._freqRing.shift(); this._confRing.shift();
            }

            const pairs = this._freqRing.map((f, i) => ({ f, w: this._confRing[i] }));
            pairs.sort((a, b) => a.f - b.f);
            const totalW = pairs.reduce((s, p) => s + p.w, 0);
            let acc = 0;
            let weightedMedian = pairs[Math.floor(pairs.length / 2)].f;
            for (const p of pairs) {
                acc += p.w;
                if (acc >= totalW / 2) { weightedMedian = p.f; break; }
            }

            const alpha = this.state.smoothedFreq > 0 ? 0.25 : 1;
            this.state.smoothedFreq = this.state.smoothedFreq * (1 - alpha) + weightedMedian * alpha;

            this._lastUpdateTs = Date.now();
            this._updateDisplay(this.state.smoothedFreq);
        }

        _scheduleNoSignalWatchdog() {
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
            const mode = this.state.mode;

            // MIDI number (float) of the detected frequency.
            const detectedMidiFloat = 69 + 12 * Math.log2(freq / A4_HZ);

            // Targeted mode (note or instrument): compare to the chosen MIDI.
            // Auto mode: target is the nearest integer MIDI number (current behavior).
            const targetMidi = (mode === 'auto')
                ? Math.round(detectedMidiFloat)
                : this.state.targetMidi;

            const cents = (detectedMidiFloat - targetMidi) * 100;
            const targetName = this._formatNote(targetMidi);

            const noteEl = this.$('#tunerNote');
            const freqEl = this.$('#tunerFreq');
            const needle = this.$('#tunerNeedle');
            const statusEl = this.$('#tunerStatus');
            const displayEl = this.$('#tunerDisplay');
            const arrowUp = this.$('#tunerArrowUp');
            const arrowDown = this.$('#tunerArrowDown');

            if (noteEl) noteEl.textContent = targetName;
            if (freqEl) freqEl.textContent = `${freq.toFixed(1)} Hz`;

            if (needle) {
                const clamped = Math.max(-50, Math.min(50, cents));
                needle.style.left = `${50 + clamped}%`;
            }

            const inTune = Math.abs(cents) <= 5;
            const farOff = Math.abs(cents) > 50;
            if (displayEl) {
                displayEl.classList.toggle('in-tune', inTune);
                displayEl.classList.toggle('too-low', cents < -5);
                displayEl.classList.toggle('too-high', cents > 5);
                displayEl.classList.toggle('far-off', farOff);
            }

            // Up/Down arrows visible only when we're off by > 5¢.
            // "too low" = detected pitch below target → must go UP.
            if (arrowUp)   arrowUp.classList.toggle('visible', cents < -5);
            if (arrowDown) arrowDown.classList.toggle('visible', cents > 5);

            if (statusEl) {
                if (inTune) {
                    statusEl.textContent = this.t('tuner.inTune');
                } else if (farOff && mode !== 'auto') {
                    const detectedName = this._formatNote(Math.round(detectedMidiFloat));
                    statusEl.textContent = `${cents < 0 ? '↑' : '↓'} ${this.t('tuner.heardNote', { note: detectedName })}`;
                } else if (cents < 0) {
                    statusEl.textContent = `${this.t('tuner.tooLow')} (${cents.toFixed(1)}¢)`;
                } else {
                    statusEl.textContent = `${this.t('tuner.tooHigh')} (+${cents.toFixed(1)}¢)`;
                }
            }

            this._highlightPickerPill(targetMidi);
        }

        _fadeDisplay() {
            const statusEl = this.$('#tunerStatus');
            const displayEl = this.$('#tunerDisplay');
            if (statusEl) statusEl.textContent = '—';
            if (displayEl) {
                displayEl.classList.remove('in-tune', 'too-low', 'too-high', 'far-off');
            }
            this.$('#tunerArrowUp')?.classList.remove('visible');
            this.$('#tunerArrowDown')?.classList.remove('visible');
        }

        _resetDisplay() {
            const noteEl = this.$('#tunerNote');
            const freqEl = this.$('#tunerFreq');
            const needle = this.$('#tunerNeedle');
            if (noteEl) {
                noteEl.textContent = this.state.mode === 'auto' ? '—' : this._formatNote(this.state.targetMidi);
            }
            if (freqEl) freqEl.textContent = '— Hz';
            if (needle) needle.style.left = '50%';
            this._fadeDisplay();
        }

        _highlightPickerPill(midi) {
            // Only meaningful in auto mode (to hint the closest string/note).
            // In note/instrument modes the user's selection stays highlighted
            // regardless, so do nothing there.
            if (this.state.mode !== 'auto') return;
            // Auto mode doesn't show a picker anyway.
        }

        _showError(msg) {
            const el = this.$('#tunerError');
            if (el) { el.textContent = msg; el.style.display = 'block'; }
            this.state.error = msg;
        }

        _clearError() {
            const el = this.$('#tunerError');
            if (el) { el.textContent = ''; el.style.display = 'none'; }
            this.state.error = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.TunerModal = TunerModal;
    }
})();
