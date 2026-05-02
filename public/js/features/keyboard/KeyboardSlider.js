// =============================================================================
// KeyboardSlider.js — Mixin : Mode A "Root Control" + String Slide (pitch bend)
// =============================================================================
(function () {
    'use strict';

    const KeyboardSliderMixin = {};

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

    // ── Piano slider (equal-width keys + pitch bend) ──────────────────────────

    /**
     * Show or hide the piano-slider toggle button.
     * Visible only when in piano family modes and `pitch_bend_enabled` is set.
     */
    KeyboardSliderMixin._updatePianoSliderGroupVisibility = function () {
        const group = document.getElementById('keyboard-piano-slider-group');
        if (!group) return;
        const isPianoFamily = this.viewMode === 'piano' || this.viewMode === 'piano-slider';
        const caps = this.selectedDeviceCapabilities;
        const enabled = !!(caps && caps.pitch_bend_enabled);
        const show = isPianoFamily && enabled;
        group.classList.toggle('hidden', !show);
        // If pitch bend was just disabled while slider mode is active, revert to piano.
        if (!show && this.viewMode === 'piano-slider') {
            this.setViewMode('piano');
        }
    };

    /**
     * Initialize drag handlers on the piano slider strip.
     * Called by generatePianoSlider() after building the DOM.
     * @param {HTMLElement} strip
     */
    KeyboardSliderMixin.initPianoSliderDrag = function (strip) {
        // Tear down any previous handlers
        this._destroyPianoSliderDrag(strip);

        let activeNote = null;

        const getPos = (clientX) => {
            const rect = strip.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1 - 1e-9, (clientX - rect.left) / rect.width));
            const exactOffset = ratio * this.visibleNoteCount;
            const noteOffset = Math.floor(exactOffset);
            const fraction = exactOffset - noteOffset;        // 0..1 within cell
            const note = Math.min(127, Math.max(0, this.startNote + noteOffset));
            // bend: center of cell = 0, right edge = +4096 (≈1 semitone up)
            const bend = Math.round(fraction * 4096);
            const cursorPct = (exactOffset / this.visibleNoteCount) * 100;
            return { note, bend, cursorPct };
        };

        const updateCursor = (pct) => {
            const cursor = document.getElementById('piano-slider-cursor');
            if (cursor) {
                cursor.style.left = pct + '%';
                cursor.style.display = 'block';
            }
        };

        const hideCursor = () => {
            const cursor = document.getElementById('piano-slider-cursor');
            if (cursor) cursor.style.display = 'none';
        };

        const updateActiveKey = (note) => {
            strip.querySelectorAll('.piano-slider-key.active').forEach(k => k.classList.remove('active'));
            const key = strip.querySelector(`.piano-slider-key[data-note="${note}"]`);
            if (key) key.classList.add('active');
        };

        const onDown = (clientX) => {
            const { note, bend, cursorPct } = getPos(clientX);
            activeNote = note;
            this._sendPitchBend(bend);
            this.playNote(note);
            updateActiveKey(note);
            updateCursor(cursorPct);
        };

        const onMove = (clientX) => {
            if (activeNote === null) return;
            const { note, bend, cursorPct } = getPos(clientX);
            this._sendPitchBend(bend);
            if (note !== activeNote) {
                this.stopNote(activeNote);
                activeNote = note;
                this.playNote(note);
                updateActiveKey(note);
            }
            updateCursor(cursorPct);
        };

        const onUp = () => {
            if (activeNote !== null) {
                this._sendPitchBend(0);
                this.stopNote(activeNote);
                activeNote = null;
            }
            strip.querySelectorAll('.piano-slider-key.active').forEach(k => k.classList.remove('active'));
            hideCursor();
        };

        const mouseDown = (e) => {
            e.preventDefault();
            onDown(e.clientX);
            const moveH = (ev) => onMove(ev.clientX);
            const upH = () => {
                onUp();
                document.removeEventListener('mousemove', moveH);
                document.removeEventListener('mouseup', upH);
            };
            document.addEventListener('mousemove', moveH);
            document.addEventListener('mouseup', upH);
        };

        const touchStart = (e) => {
            e.preventDefault();
            onDown(e.touches[0].clientX);
        };
        const touchMove = (e) => {
            e.preventDefault();
            onMove(e.touches[0].clientX);
        };
        const touchEnd = () => onUp();

        strip.addEventListener('mousedown', mouseDown);
        strip.addEventListener('touchstart', touchStart, { passive: false });
        strip.addEventListener('touchmove', touchMove, { passive: false });
        strip.addEventListener('touchend', touchEnd);

        strip._pianoSliderHandlers = { mouseDown, touchStart, touchMove, touchEnd };
    };

    KeyboardSliderMixin._destroyPianoSliderDrag = function (strip) {
        if (!strip || !strip._pianoSliderHandlers) return;
        const { mouseDown, touchStart, touchMove, touchEnd } = strip._pianoSliderHandlers;
        strip.removeEventListener('mousedown', mouseDown);
        strip.removeEventListener('touchstart', touchStart);
        strip.removeEventListener('touchmove', touchMove);
        strip.removeEventListener('touchend', touchEnd);
        strip._pianoSliderHandlers = null;
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
