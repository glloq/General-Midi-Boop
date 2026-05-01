// =============================================================================
// KeyboardSlider.js — Mixin : Mode A "Root Control" + String Slide (pitch bend)
// =============================================================================
(function () {
    'use strict';

    const KeyboardSliderMixin = {};

    // ── Mode A : Root Control (slider → chordRoot) ────────────────────────────

    KeyboardSliderMixin.initNoteSliderModeA = function () {
        if (typeof NoteEngine === 'undefined' || typeof NoteSlider === 'undefined') {
            this.logger && this.logger.warn('[KeyboardSlider] NoteEngine ou NoteSlider non disponibles');
            return;
        }

        const container = document.getElementById('note-slider-area');
        if (!container) return;

        this.destroyNoteSlider();

        const engine = new NoteEngine();
        engine.setScale(0, 'chromatic');
        engine.setRange(48, 59);

        const cfg        = this.stringInstrumentConfig || {};
        const numStrings = Math.max(1, cfg.num_strings || 6);
        let tuning       = null;
        if (Array.isArray(cfg.tuning) && cfg.tuning.length === numStrings) {
            tuning = cfg.tuning;
        } else if (Array.isArray(cfg.tuning_midi) && cfg.tuning_midi.length === numStrings) {
            tuning = cfg.tuning_midi;
        }
        if (typeof VoicingEngine !== 'undefined') {
            this._voicingEngine = new VoicingEngine(tuning, numStrings);
        }

        const slider = new NoteSlider(container, engine, {
            minNote: 48,
            maxNote: 59,
            mode: 'discrete',
            height: 52,
            labelFormat: this.noteLabelFormat || 'english',
        });

        slider.on('notechange', (note) => {
            const rootClass = note % 12;
            if (typeof this._setChordRootFromSlider === 'function') {
                this._setChordRootFromSlider(rootClass);
            }
        });

        this._noteSlider = slider;
        this._noteEngine = engine;
    };

    KeyboardSliderMixin.destroyNoteSlider = function () {
        if (this._noteSlider) {
            this._noteSlider.destroy();
            this._noteSlider = null;
        }
        this._noteEngine    = null;
        this._voicingEngine = null;
    };

    KeyboardSliderMixin.syncSliderLabelFormat = function () {
        if (this._noteSlider && typeof this._noteSlider.setLabelFormat === 'function') {
            this._noteSlider.setLabelFormat(this.noteLabelFormat || 'english');
        }
    };

    // ── Slide mode visibility ─────────────────────────────────────────────────

    KeyboardSliderMixin._updateSlideModeGroupVisibility = function () {
        const group = document.getElementById('keyboard-slide-mode-group');
        if (!group) return;
        const show = this.viewMode === 'fretboard'
            && !!(this.stringInstrumentConfig && this.stringInstrumentConfig.string_slider_enabled);
        group.classList.toggle('hidden', !show);
        if (!show && this._stringSlideActive) {
            this._disableStringSlideMode();
        }
    };

    // ── String slide mode : toggle / enable / disable ────────────────────────

    KeyboardSliderMixin.initStringSliderMode = function () {
        // Re-apply slide mode if it was active (e.g. after fretboard re-render)
        if (this._stringSlideActive) {
            this._enableStringSlideMode();
        }
    };

    KeyboardSliderMixin._toggleStringSlideMode = function () {
        if (this._stringSlideActive) {
            this._disableStringSlideMode();
        } else {
            this._enableStringSlideMode();
        }
    };

    KeyboardSliderMixin._enableStringSlideMode = function () {
        this._stringSlideActive = true;
        const btn = document.getElementById('keyboard-slide-toggle');
        if (btn) {
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');
        }
        document.querySelectorAll('#fretboard-container .fret-string').forEach(row => {
            row.classList.add('slide-mode');
            this._setupStringRowDrag(row);
        });
    };

    KeyboardSliderMixin._disableStringSlideMode = function () {
        this._stringSlideActive = false;
        const btn = document.getElementById('keyboard-slide-toggle');
        if (btn) {
            btn.classList.remove('active');
            btn.setAttribute('aria-pressed', 'false');
        }
        document.querySelectorAll('#fretboard-container .fret-string').forEach(row => {
            row.classList.remove('slide-mode');
            this._teardownStringRowDrag(row);
        });
    };

    // ── Per-row drag setup ────────────────────────────────────────────────────

    KeyboardSliderMixin._setupStringRowDrag = function (row) {
        // Remove any stale handlers first
        this._teardownStringRowDrag(row);

        const cfg       = this.stringInstrumentConfig || {};
        const tuning    = cfg.tuning || [];
        const numFrets  = cfg.num_frets || 22;
        const stringNum = parseInt(row.dataset.stringNumber, 10) || 1;
        const openMidi  = tuning[stringNum - 1] !== undefined ? tuning[stringNum - 1] : 40;

        let activeNote = null;

        const getPos = (clientX) => {
            const rect = row.getBoundingClientRect();
            // Nut column width — matches the CSS .fret-open / .fret-nut width (~48px)
            const nutWidth    = 48;
            const fretAreaLeft  = rect.left + nutWidth;
            const fretAreaWidth = rect.width - nutWidth;
            const ratio       = Math.max(0, Math.min(1, (clientX - fretAreaLeft) / fretAreaWidth));
            const exactFret   = ratio * numFrets;
            const fret        = Math.floor(exactFret);
            const note        = Math.min(127, Math.max(0, openMidi + fret));
            // 1 semitone = 4096 units in ±2ST standard bend range
            const bend        = Math.round((exactFret - fret) * 4096);
            return { note, bend, ratio };
        };

        const onDown = (clientX) => {
            const { note, bend, ratio } = getPos(clientX);
            activeNote = note;
            this._sendPitchBend(bend);
            this.playNote(note);
            this._updateStringSlideIndicator(row, ratio);
        };

        const onMove = (clientX) => {
            if (activeNote === null) return;
            const { note, bend, ratio } = getPos(clientX);
            this._sendPitchBend(bend);
            if (note !== activeNote) {
                this.stopNote(activeNote);
                activeNote = note;
                this.playNote(note);
            }
            this._updateStringSlideIndicator(row, ratio);
        };

        const onUp = () => {
            if (activeNote !== null) {
                this._sendPitchBend(0);
                this.stopNote(activeNote);
                activeNote = null;
            }
            this._clearStringSlideIndicator(row);
        };

        const mouseDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            onDown(e.clientX);
            const moveH = (ev) => onMove(ev.clientX);
            const upH   = () => {
                onUp();
                document.removeEventListener('mousemove', moveH);
                document.removeEventListener('mouseup', upH);
            };
            document.addEventListener('mousemove', moveH);
            document.addEventListener('mouseup', upH);
        };

        const touchStart = (e) => {
            e.preventDefault();
            e.stopPropagation();
            onDown(e.touches[0].clientX);
        };
        const touchMove = (e) => {
            e.preventDefault();
            onMove(e.touches[0].clientX);
        };
        const touchEnd = () => onUp();

        row.addEventListener('mousedown',  mouseDown,  { capture: true });
        row.addEventListener('touchstart', touchStart, { passive: false, capture: true });
        row.addEventListener('touchmove',  touchMove,  { passive: false });
        row.addEventListener('touchend',   touchEnd);

        row._slideHandlers = { mouseDown, touchStart, touchMove, touchEnd };
    };

    KeyboardSliderMixin._teardownStringRowDrag = function (row) {
        if (!row._slideHandlers) return;
        const { mouseDown, touchStart, touchMove, touchEnd } = row._slideHandlers;
        row.removeEventListener('mousedown',  mouseDown,  { capture: true });
        row.removeEventListener('touchstart', touchStart, { capture: true });
        row.removeEventListener('touchmove',  touchMove);
        row.removeEventListener('touchend',   touchEnd);
        row._slideHandlers = null;
        this._clearStringSlideIndicator(row);
    };

    // ── Pitch bend ────────────────────────────────────────────────────────────

    KeyboardSliderMixin._sendPitchBend = function (value) {
        if (!this.selectedDevice || !this.backend) return;
        if (this.selectedDevice.isVirtual) return;
        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;
        const channel  = this.getSelectedChannel ? this.getSelectedChannel() : 0;
        this.backend.sendCommand('midi_send_pitchbend', { deviceId, channel, value })
            .catch(err => this.logger && this.logger.error('[StringSlider] Pitch bend failed:', err));
    };

    // ── Visual indicator ──────────────────────────────────────────────────────

    KeyboardSliderMixin._updateStringSlideIndicator = function (row, ratio) {
        let indicator = row.querySelector('.string-slide-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'string-slide-indicator';
            row.style.position = 'relative';
            row.appendChild(indicator);
        }
        const cfg      = this.stringInstrumentConfig || {};
        const nutWidth = 48;
        // Position within the fret area
        const fretAreaPct = (row.getBoundingClientRect().width - nutWidth) / row.getBoundingClientRect().width;
        const leftPct = (nutWidth / row.getBoundingClientRect().width + ratio * fretAreaPct) * 100;
        indicator.style.left = leftPct + '%';
        indicator.style.display = 'block';
    };

    KeyboardSliderMixin._clearStringSlideIndicator = function (row) {
        const indicator = row.querySelector('.string-slide-indicator');
        if (indicator) indicator.style.display = 'none';
    };

    // ── Cleanup ───────────────────────────────────────────────────────────────

    KeyboardSliderMixin.destroyStringSliders = function () {
        document.querySelectorAll('#fretboard-container .fret-string').forEach(row => {
            this._teardownStringRowDrag(row);
            row.classList.remove('slide-mode');
        });
        this._stringSlideActive = false;
        const btn = document.getElementById('keyboard-slide-toggle');
        if (btn) {
            btn.classList.remove('active');
            btn.setAttribute('aria-pressed', 'false');
        }
    };

    if (typeof window !== 'undefined') window.KeyboardSliderMixin = KeyboardSliderMixin;
})();
