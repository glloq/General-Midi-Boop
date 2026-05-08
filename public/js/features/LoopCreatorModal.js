/**
 * LoopCreatorModal — Loop Creator (∞)
 * Zone 1: Piano roll editor (webaudio-pianoroll)
 * Zone 2: Mini piano keyboard + recording transport
 * Zone 3: Loop library (saved loops)
 */
class LoopCreatorModal extends BaseModal {
    constructor(api, eventBus) {
        super({
            id: 'loop-creator-modal',
            size: 'full',
            title: 'loopCreator.title',
            closeOnOverlay: false,
            customClass: 'loop-creator-modal'
        });
        this.api = api;
        this.eventBus = eventBus || window.eventBus || null;

        // Piano roll element
        this.pianoRoll = null;
        // Current note sequence [{t, n, v, g}]
        this.sequence = [];

        // Loop metadata
        this.currentLoopId = null;
        this.loopName = this.t('loopCreator.untitled');
        this.tempo = 120;
        this.timeSigNum = 4;
        this.timeSigDen = 4;
        this.bars = 2;
        this.ppq = 480;
        this.instrumentProgram = 0;

        // Recording state
        this.isRecording = false;
        this.recordStartTime = 0;
        this.recordedNotes = [];    // in-flight note-ons (not yet closed)
        this._recordingTick = 0;    // tick offset at recording start
        this._metronomeInterval = null;
        this._metronomeStep = 0;

        // Playback state
        this.isPlaying = false;
        this._playbackTimer = null;
        this._synth = null;
        this._gainNode = null;
        this._audioCtx = null;

        // Active notes on mini keyboard (for sustained highlight)
        this._activeKeys = new Set();
        this._mouseDownNote = null;

        // Library
        this.library = [];

        // Bound handlers for cleanup
        this._boundDocMouseUp = this._onDocMouseUp.bind(this);
    }

    // =========================================================
    // RENDERING
    // =========================================================

    renderBody() {
        const timeSigOptions = [
            ['2/4','2','4'], ['3/4','3','4'], ['4/4','4','4'],
            ['5/4','5','4'], ['6/8','6','8'], ['7/8','7','8']
        ];
        const timeSigHtml = timeSigOptions.map(([label, num, den]) =>
            `<option value="${num}:${den}" ${this.timeSigNum == num && this.timeSigDen == den ? 'selected' : ''}>${label}</option>`
        ).join('');

        return `
        <div class="lc-layout">

            <!-- ── ZONE 1 : EDITOR ── -->
            <div class="lc-editor" id="lc-editor">
                <div class="lc-editor-toolbar">
                    <div class="lc-toolbar-left">
                        <input type="text" class="lc-name-input" id="lc-name-input"
                            value="${this.escape(this.loopName)}"
                            placeholder="${this.t('loopCreator.namePlaceholder')}"
                            aria-label="${this.t('loopCreator.loopName')}" />
                    </div>
                    <div class="lc-toolbar-center">
                        <label class="lc-label">${this.t('loopCreator.tempo')}</label>
                        <div class="lc-spinbox">
                            <button class="lc-spin-btn" data-action="tempo-dec" aria-label="Decrease tempo">‹</button>
                            <input type="number" id="lc-tempo" class="lc-spin-input"
                                value="${this.tempo}" min="20" max="300" step="1"
                                aria-label="Tempo BPM" />
                            <button class="lc-spin-btn" data-action="tempo-inc" aria-label="Increase tempo">›</button>
                        </div>
                        <span class="lc-unit">BPM</span>

                        <label class="lc-label">${this.t('loopCreator.timeSignature')}</label>
                        <select id="lc-timesig" class="lc-select" aria-label="Time signature">
                            ${timeSigHtml}
                        </select>

                        <label class="lc-label">${this.t('loopCreator.bars')}</label>
                        <div class="lc-spinbox">
                            <button class="lc-spin-btn" data-action="bars-dec" aria-label="Decrease bars">‹</button>
                            <input type="number" id="lc-bars" class="lc-spin-input"
                                value="${this.bars}" min="1" max="32" step="1"
                                aria-label="Number of bars" />
                            <button class="lc-spin-btn" data-action="bars-inc" aria-label="Increase bars">›</button>
                        </div>
                        <span class="lc-unit">${this.t('loopCreator.barsUnit')}</span>

                        <label class="lc-label">${this.t('loopCreator.snap')}</label>
                        <select id="lc-snap" class="lc-select" aria-label="Snap">
                            <option value="480">1/1</option>
                            <option value="240">1/2</option>
                            <option value="120" selected>1/4</option>
                            <option value="60">1/8</option>
                            <option value="30">1/16</option>
                            <option value="15">1/32</option>
                        </select>
                    </div>
                    <div class="lc-toolbar-right">
                        <button class="lc-btn lc-btn-icon" data-action="mode-draw" id="lc-mode-draw" title="${this.t('loopCreator.modeDraw')}" aria-pressed="true">✏️</button>
                        <button class="lc-btn lc-btn-icon" data-action="mode-select" id="lc-mode-select" title="${this.t('loopCreator.modeSelect')}" aria-pressed="false">⬚</button>
                        <button class="lc-btn lc-btn-icon" data-action="undo" title="${this.t('loopCreator.undo')}">↩</button>
                        <button class="lc-btn lc-btn-icon" data-action="redo" title="${this.t('loopCreator.redo')}">↪</button>
                        <button class="lc-btn lc-btn-icon" data-action="clear-notes" title="${this.t('loopCreator.clearNotes')}">🗑</button>
                    </div>
                </div>
                <div class="lc-pianoroll-wrap" id="lc-pianoroll-wrap">
                    <!-- webaudio-pianoroll inserted here -->
                </div>
            </div>

            <!-- ── ZONE 2 : KEYBOARD + TRANSPORT ── -->
            <div class="lc-keyboard-zone" id="lc-keyboard-zone">
                <div class="lc-transport" id="lc-transport">
                    <div class="lc-transport-left">
                        <button class="lc-btn lc-btn-record" id="lc-record-btn" data-action="record" title="${this.t('loopCreator.record')}">
                            <span class="lc-rec-dot"></span> ${this.t('loopCreator.record')}
                        </button>
                        <button class="lc-btn" id="lc-preview-btn" data-action="preview" title="${this.t('loopCreator.preview')}">
                            ▶ ${this.t('loopCreator.preview')}
                        </button>
                        <button class="lc-btn" id="lc-stop-btn" data-action="stop-all" title="${this.t('loopCreator.stop')}">
                            ⏹ ${this.t('loopCreator.stop')}
                        </button>
                    </div>
                    <div class="lc-transport-right">
                        <label class="lc-label">${this.t('loopCreator.quantize')}</label>
                        <select id="lc-quantize" class="lc-select" aria-label="Quantize">
                            <option value="0">${this.t('loopCreator.quantizeNone')}</option>
                            <option value="480">1/1</option>
                            <option value="240">1/2</option>
                            <option value="120" selected>1/4</option>
                            <option value="60">1/8</option>
                            <option value="30">1/16</option>
                        </select>
                        <span class="lc-rec-indicator hidden" id="lc-rec-indicator">
                            <span class="lc-rec-dot lc-rec-dot--pulse"></span>
                            ${this.t('loopCreator.recording')}
                        </span>
                    </div>
                </div>
                <div class="lc-keyboard-wrap" id="lc-keyboard-wrap">
                    ${this._renderMiniKeyboard()}
                </div>
            </div>

            <!-- ── ZONE 3 : LIBRARY ── -->
            <div class="lc-library" id="lc-library">
                <div class="lc-library-header">
                    <h3 class="lc-library-title">${this.t('loopCreator.library')}</h3>
                    <button class="lc-btn lc-btn-primary" data-action="new-loop" id="lc-new-loop-btn">
                        + ${this.t('loopCreator.newLoop')}
                    </button>
                </div>
                <div class="lc-library-grid" id="lc-library-grid">
                    <div class="lc-library-empty">${this.t('loopCreator.libraryEmpty')}</div>
                </div>
            </div>
        </div>`;
    }

    renderFooter() {
        return `
            <div class="lc-footer-left">
                <span class="lc-status" id="lc-status"></span>
            </div>
            <div class="lc-footer-right">
                <button class="lc-btn" data-action="close">${this.t('common.cancel')}</button>
                <button class="lc-btn lc-btn-primary" data-action="save" id="lc-save-btn">
                    💾 ${this.t('loopCreator.save')}
                </button>
            </div>`;
    }

    // =========================================================
    // MINI KEYBOARD RENDER
    // =========================================================

    _renderMiniKeyboard() {
        // 4 octaves starting at C3 (MIDI 48)
        const startNote = 36; // C2
        const endNote = 84;   // C6
        const whites = [];
        const blacks = [];
        const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
        const BLACK_SEMIS = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
        let whiteIndex = 0;

        for (let n = startNote; n <= endNote; n++) {
            const semi = n % 12;
            if (WHITE_SEMIS.includes(semi)) {
                whites.push({ n, whiteIndex });
                whiteIndex++;
            }
        }

        let wIdx = 0;
        for (let n = startNote; n <= endNote; n++) {
            const semi = n % 12;
            if (WHITE_SEMIS.includes(semi)) wIdx++;
            if (semi in BLACK_SEMIS) {
                blacks.push({ n, leftWhiteIndex: wIdx - 1 });
            }
        }

        const whiteCount = whites.length;
        const whiteW = 100 / whiteCount;

        const whiteKeys = whites.map(({ n, whiteIndex: wi }) =>
            `<div class="lc-key lc-key-white" data-note="${n}"
                style="left:${wi * whiteW}%; width:${whiteW}%"
                aria-label="Note ${n}"></div>`
        ).join('');

        const blackKeys = blacks.map(({ n, leftWhiteIndex: li }) => {
            const bw = whiteW * 0.58;
            const left = li * whiteW + whiteW * 0.71;
            return `<div class="lc-key lc-key-black" data-note="${n}"
                style="left:${left}%; width:${bw}%"
                aria-label="Note ${n}"></div>`;
        }).join('');

        return `<div class="lc-keyboard" id="lc-keyboard" role="group" aria-label="${this.t('loopCreator.keyboard')}">
            ${whiteKeys}
            ${blackKeys}
        </div>`;
    }

    // =========================================================
    // LIFECYCLE
    // =========================================================

    onOpen() {
        this._initSynth();
        this._attachEvents();
        this._initPianoRoll();
        this._loadLibrary();
        document.addEventListener('mouseup', this._boundDocMouseUp);
    }

    onClose() {
        this._stopAll();
        this._stopMetronome();
        document.removeEventListener('mouseup', this._boundDocMouseUp);
        if (this._gainNode) {
            try { this._gainNode.disconnect(); } catch (_) {}
            this._gainNode = null;
        }
    }

    // =========================================================
    // PIANO ROLL INIT
    // =========================================================

    _initPianoRoll() {
        const container = this.$('#lc-pianoroll-wrap');
        if (!container) return;

        if (typeof customElements === 'undefined' ||
            typeof customElements.get === 'undefined' ||
            !customElements.get('webaudio-pianoroll')) {
            container.innerHTML = `<div class="lc-pianoroll-error">${this.t('loopCreator.pianoRollUnavailable')}</div>`;
            return;
        }

        this.pianoRoll = document.createElement('webaudio-pianoroll');
        const totalTicks = this._totalTicks();

        this.pianoRoll.setAttribute('width', container.clientWidth || 900);
        this.pianoRoll.setAttribute('height', container.clientHeight || 200);
        this.pianoRoll.setAttribute('editmode', 'dragpoly');
        this.pianoRoll.setAttribute('xrange', totalTicks.toString());
        this.pianoRoll.setAttribute('yrange', '36');
        this.pianoRoll.setAttribute('yoffset', '48');
        this.pianoRoll.setAttribute('wheelzoom', '1');
        this.pianoRoll.setAttribute('xscroll', '1');
        this.pianoRoll.setAttribute('yscroll', '1');
        this.pianoRoll.setAttribute('xruler', '1');
        this.pianoRoll.setAttribute('cursor', '0');
        this.pianoRoll.setAttribute('markstart', '0');
        this.pianoRoll.setAttribute('markend', totalTicks.toString());
        this.pianoRoll.setAttribute('snap', '120');
        this.pianoRoll.setAttribute('timebase', this.ppq.toString());
        this.pianoRoll.setAttribute('tempo', this.tempo.toString());

        this._applyPianoRollTheme();

        container.appendChild(this.pianoRoll);

        this.pianoRoll.sequence = this.sequence;
        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }
    }

    _applyPianoRollTheme() {
        if (!this.pianoRoll) return;
        const dark = document.body.classList.contains('theme-dark');
        this.pianoRoll.setAttribute('colnote', dark ? '#5b9bd5' : '#4a90d9');
        this.pianoRoll.setAttribute('colnotesel', dark ? '#f5a623' : '#e8931a');
        this.pianoRoll.setAttribute('colbg', dark ? '#1a1a2e' : '#f8f9fa');
        this.pianoRoll.setAttribute('colline', dark ? '#333355' : '#dde0e6');
        this.pianoRoll.setAttribute('colrulerbg', dark ? '#12122a' : '#eef0f4');
        this.pianoRoll.setAttribute('colrulerfg', dark ? '#8888aa' : '#666677');
        this.pianoRoll.setAttribute('colkeybg', dark ? '#1e1e38' : '#f0f0f4');
        this.pianoRoll.setAttribute('colkeyfg', dark ? '#ccccee' : '#333344');
        this.pianoRoll.setAttribute('colkeyblack', dark ? '#0d0d1a' : '#303040');
    }

    _totalTicks() {
        return this.ppq * this.timeSigNum * this.bars;
    }

    _refreshPianoRollRange() {
        if (!this.pianoRoll) return;
        const total = this._totalTicks();
        this.pianoRoll.setAttribute('xrange', total.toString());
        this.pianoRoll.setAttribute('markend', total.toString());
        this.pianoRoll.setAttribute('timebase', this.ppq.toString());
        this.pianoRoll.setAttribute('tempo', this.tempo.toString());
        if (typeof this.pianoRoll.redraw === 'function') this.pianoRoll.redraw();
    }

    // =========================================================
    // EVENTS
    // =========================================================

    _attachEvents() {
        // Toolbar spinners and selects
        this.dialog.addEventListener('click', (e) => this._onToolbarClick(e));
        this.dialog.addEventListener('change', (e) => this._onToolbarChange(e));
        this.dialog.addEventListener('input', (e) => this._onToolbarInput(e));

        // Mini keyboard mouse events
        const kb = this.$('#lc-keyboard');
        if (kb) {
            kb.addEventListener('mousedown', (e) => this._onKeyMouseDown(e));
            kb.addEventListener('mouseover', (e) => this._onKeyMouseOver(e));
            kb.addEventListener('touchstart', (e) => this._onKeyTouchStart(e), { passive: false });
            kb.addEventListener('touchmove', (e) => this._onKeyTouchMove(e), { passive: false });
            kb.addEventListener('touchend', (e) => this._onKeyTouchEnd(e));
        }
    }

    _onToolbarClick(e) {
        const action = e.target.closest('[data-action]')?.dataset?.action;
        if (!action) return;

        switch (action) {
            case 'tempo-dec': this._adjustTempo(-1); break;
            case 'tempo-inc': this._adjustTempo(+1); break;
            case 'bars-dec':  this._adjustBars(-1);  break;
            case 'bars-inc':  this._adjustBars(+1);  break;
            case 'mode-draw': this._setEditMode('dragpoly'); break;
            case 'mode-select': this._setEditMode('select'); break;
            case 'undo':  if (this.pianoRoll?.undo) this.pianoRoll.undo(); break;
            case 'redo':  if (this.pianoRoll?.redo) this.pianoRoll.redo(); break;
            case 'clear-notes': this._clearNotes(); break;
            case 'record': this._toggleRecording(); break;
            case 'preview': this._previewLoop(); break;
            case 'stop-all': this._stopAll(); break;
            case 'new-loop': this._newLoop(); break;
            case 'save': this._saveLoop(); break;
            case 'close': this.close(); break;
        }
    }

    _onToolbarChange(e) {
        const id = e.target.id;
        if (id === 'lc-timesig') {
            const [num, den] = e.target.value.split(':').map(Number);
            this.timeSigNum = num;
            this.timeSigDen = den;
            this._refreshPianoRollRange();
        } else if (id === 'lc-snap') {
            const ticks = parseInt(e.target.value);
            if (this.pianoRoll) {
                this.pianoRoll.snap = ticks;
                this.pianoRoll.setAttribute('snap', ticks.toString());
            }
        }
    }

    _onToolbarInput(e) {
        const id = e.target.id;
        if (id === 'lc-tempo') {
            const v = parseInt(e.target.value);
            if (v >= 20 && v <= 300) { this.tempo = v; this._refreshPianoRollRange(); }
        } else if (id === 'lc-bars') {
            const v = parseInt(e.target.value);
            if (v >= 1 && v <= 32) { this.bars = v; this._refreshPianoRollRange(); }
        } else if (id === 'lc-name-input') {
            this.loopName = e.target.value;
        }
    }

    _adjustTempo(delta) {
        const input = this.$('#lc-tempo');
        this.tempo = Math.max(20, Math.min(300, this.tempo + delta));
        if (input) input.value = this.tempo;
        this._refreshPianoRollRange();
    }

    _adjustBars(delta) {
        const input = this.$('#lc-bars');
        this.bars = Math.max(1, Math.min(32, this.bars + delta));
        if (input) input.value = this.bars;
        this._refreshPianoRollRange();
    }

    _setEditMode(mode) {
        if (!this.pianoRoll) return;
        this.pianoRoll.setAttribute('editmode', mode);
        this.$('#lc-mode-draw')?.setAttribute('aria-pressed', mode === 'dragpoly' ? 'true' : 'false');
        this.$('#lc-mode-select')?.setAttribute('aria-pressed', mode === 'select' ? 'true' : 'false');
    }

    _clearNotes() {
        this.sequence = [];
        if (this.pianoRoll) {
            this.pianoRoll.sequence = [];
            if (typeof this.pianoRoll.redraw === 'function') this.pianoRoll.redraw();
        }
    }

    // =========================================================
    // MINI KEYBOARD
    // =========================================================

    _noteFromEl(el) {
        const key = el.closest('.lc-key');
        return key ? parseInt(key.dataset.note) : null;
    }

    _onKeyMouseDown(e) {
        const note = this._noteFromEl(e.target);
        if (note == null) return;
        e.preventDefault();
        this._mouseDownNote = note;
        this._playNote(note);
    }

    _onKeyMouseOver(e) {
        if (this._mouseDownNote == null) return;
        const note = this._noteFromEl(e.target);
        if (note == null || note === this._mouseDownNote) return;
        this._stopNote(this._mouseDownNote);
        this._mouseDownNote = note;
        this._playNote(note);
    }

    _onDocMouseUp() {
        if (this._mouseDownNote != null) {
            this._stopNote(this._mouseDownNote);
            this._mouseDownNote = null;
        }
    }

    _onKeyTouchStart(e) {
        e.preventDefault();
        for (const touch of e.changedTouches) {
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            const note = this._noteFromEl(el);
            if (note != null) this._playNote(note);
        }
    }

    _onKeyTouchMove(e) {
        e.preventDefault();
        for (const touch of e.changedTouches) {
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            const note = this._noteFromEl(el);
            if (note != null && !this._activeKeys.has(note)) this._playNote(note);
        }
    }

    _onKeyTouchEnd(e) {
        for (const touch of e.changedTouches) {
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            const note = this._noteFromEl(el);
            if (note != null) this._stopNote(note);
        }
    }

    _playNote(note) {
        this._activeKeys.add(note);
        this._highlightKey(note, true);

        if (this._synth) {
            try { this._synth.noteOn(0, note, 80, 0); } catch (_) {}
        }

        if (this.isRecording) {
            const elapsed = (performance.now() - this.recordStartTime) / 1000;
            const tick = Math.round(elapsed * (this.tempo / 60) * this.ppq) + this._recordingTick;
            this.recordedNotes.push({ note, tick, startMs: performance.now() });
        }
    }

    _stopNote(note) {
        this._activeKeys.delete(note);
        this._highlightKey(note, false);

        if (this._synth) {
            try { this._synth.noteOff(0, note, 0); } catch (_) {}
        }

        if (this.isRecording) {
            const idx = this.recordedNotes.findIndex(r => r.note === note);
            if (idx !== -1) {
                const rec = this.recordedNotes.splice(idx, 1)[0];
                const durationMs = performance.now() - rec.startMs;
                const durationTicks = Math.max(30, Math.round(durationMs / 1000 * (this.tempo / 60) * this.ppq));
                const quantize = parseInt(this.$('#lc-quantize')?.value ?? 0);
                const t = quantize > 0 ? Math.round(rec.tick / quantize) * quantize : rec.tick;
                const g = quantize > 0 ? Math.max(quantize, Math.round(durationTicks / quantize) * quantize) : durationTicks;
                this._addNoteToRoll({ t, n: note, v: 80, g });
            }
        }
    }

    _highlightKey(note, on) {
        const key = this.dialog?.querySelector(`.lc-key[data-note="${note}"]`);
        if (key) key.classList.toggle('lc-key--active', on);
    }

    _addNoteToRoll(noteObj) {
        if (!this.pianoRoll) return;
        const seq = Array.isArray(this.pianoRoll.sequence) ? [...this.pianoRoll.sequence] : [];
        seq.push(noteObj);
        this.pianoRoll.sequence = seq;
        if (typeof this.pianoRoll.redraw === 'function') this.pianoRoll.redraw();
    }

    // =========================================================
    // RECORDING
    // =========================================================

    _toggleRecording() {
        if (this.isRecording) {
            this._stopRecording();
        } else {
            this._startRecording();
        }
    }

    _startRecording() {
        this.isRecording = true;
        this.recordedNotes = [];
        this.recordStartTime = performance.now();
        this._recordingTick = 0;

        const btn = this.$('#lc-record-btn');
        const indicator = this.$('#lc-rec-indicator');
        if (btn) btn.classList.add('lc-btn-record--active');
        if (indicator) indicator.classList.remove('hidden');

        this._startMetronome();
        this._setStatus(this.t('loopCreator.statusRecording'));
    }

    _stopRecording() {
        this.isRecording = false;
        // Close any still-open notes
        for (const rec of this.recordedNotes) {
            const durationMs = performance.now() - rec.startMs;
            const durationTicks = Math.max(30, Math.round(durationMs / 1000 * (this.tempo / 60) * this.ppq));
            const quantize = parseInt(this.$('#lc-quantize')?.value ?? 0);
            const t = quantize > 0 ? Math.round(rec.tick / quantize) * quantize : rec.tick;
            const g = quantize > 0 ? Math.max(quantize, Math.round(durationTicks / quantize) * quantize) : durationTicks;
            this._addNoteToRoll({ t, n: rec.note, v: 80, g });
        }
        this.recordedNotes = [];

        const btn = this.$('#lc-record-btn');
        const indicator = this.$('#lc-rec-indicator');
        if (btn) btn.classList.remove('lc-btn-record--active');
        if (indicator) indicator.classList.add('hidden');

        this._stopMetronome();
        this._setStatus(this.t('loopCreator.statusRecordingDone'));
    }

    _startMetronome() {
        this._metronomeStep = 0;
        const stepMs = (60 / this.tempo) * 1000;
        this._metronomeInterval = setInterval(() => {
            this._metronomeStep++;
        }, stepMs);
    }

    _stopMetronome() {
        if (this._metronomeInterval) {
            clearInterval(this._metronomeInterval);
            this._metronomeInterval = null;
        }
    }

    // =========================================================
    // PREVIEW PLAYBACK
    // =========================================================

    _initSynth() {
        if (typeof MidiSynthesizer !== 'undefined') {
            try {
                this._synth = new MidiSynthesizer();
                this._synth.setInstrument(0, this.instrumentProgram);
            } catch (_) {}
        }
    }

    _previewLoop() {
        if (!this.pianoRoll) return;
        this._stopAll();

        const sequence = this.pianoRoll.sequence || [];
        if (!sequence.length) {
            this._setStatus(this.t('loopCreator.statusNoNotes'));
            return;
        }

        if (!this._synth) {
            this._setStatus(this.t('loopCreator.statusNoSynth'));
            return;
        }

        const secPerTick = 60 / (this.tempo * this.ppq);
        const totalTicks = this._totalTicks();
        this.isPlaying = true;
        this._setStatus(this.t('loopCreator.statusPlaying'));

        const timers = [];
        for (const note of sequence) {
            const onMs = note.t * secPerTick * 1000;
            const offMs = (note.t + (note.g || note.l || 120)) * secPerTick * 1000;
            timers.push(setTimeout(() => {
                if (!this.isPlaying) return;
                try { this._synth.noteOn(0, note.n, note.v || 80, 0); } catch (_) {}
            }, onMs));
            timers.push(setTimeout(() => {
                if (!this.isPlaying) return;
                try { this._synth.noteOff(0, note.n, 0); } catch (_) {}
            }, offMs));
        }

        // Stop marker
        timers.push(setTimeout(() => {
            this.isPlaying = false;
            this._setStatus(this.t('loopCreator.statusIdle'));
        }, totalTicks * secPerTick * 1000));

        this._playbackTimer = timers;
    }

    _stopAll() {
        if (this._playbackTimer) {
            (this._playbackTimer instanceof Array ? this._playbackTimer : [this._playbackTimer])
                .forEach(t => clearTimeout(t));
            this._playbackTimer = null;
        }
        if (this.isRecording) this._stopRecording();
        this.isPlaying = false;

        if (this._synth) {
            try { this._synth.allNotesOff(); } catch (_) {}
        }
        // Clear all key highlights
        this.$$('.lc-key--active').forEach(k => k.classList.remove('lc-key--active'));
        this._activeKeys.clear();
        this._setStatus('');
    }

    // =========================================================
    // SAVE / LOAD
    // =========================================================

    async _saveLoop() {
        const name = this.$('#lc-name-input')?.value?.trim() || this.t('loopCreator.untitled');
        this.loopName = name;

        const sequence = this.pianoRoll?.sequence ?? [];

        const payload = {
            name,
            tempo: this.tempo,
            time_sig_num: this.timeSigNum,
            time_sig_den: this.timeSigDen,
            bars: this.bars,
            ppq: this.ppq,
            instrument_program: this.instrumentProgram,
            midi_data: JSON.stringify(sequence)
        };

        try {
            if (this.currentLoopId) {
                await this.api.sendCommand('loop_update', { loopId: this.currentLoopId, ...payload });
                this._setStatus(this.t('loopCreator.statusSaved'));
            } else {
                const result = await this.api.sendCommand('loop_create', payload);
                this.currentLoopId = result.loopId;
                this._setStatus(this.t('loopCreator.statusSaved'));
            }
            await this._loadLibrary();
        } catch (err) {
            this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`);
        }
    }

    async _loadLibrary() {
        try {
            const result = await this.api.sendCommand('loop_list');
            this.library = result.loops || [];
            this._renderLibrary();
        } catch (_) {}
    }

    _renderLibrary() {
        const grid = this.$('#lc-library-grid');
        if (!grid) return;

        if (!this.library.length) {
            grid.innerHTML = `<div class="lc-library-empty">${this.t('loopCreator.libraryEmpty')}</div>`;
            return;
        }

        grid.innerHTML = this.library.map(loop => {
            const active = loop.id === this.currentLoopId ? ' lc-card--active' : '';
            const timeSig = `${loop.time_sig_num}/${loop.time_sig_den}`;
            return `
                <div class="lc-card${active}" data-loop-id="${loop.id}" role="button" tabindex="0"
                    aria-label="${this.escape(loop.name)}" aria-pressed="${active ? 'true' : 'false'}">
                    <div class="lc-card-name">${this.escape(loop.name)}</div>
                    <div class="lc-card-meta">${loop.tempo} BPM · ${timeSig} · ${loop.bars} ${this.t('loopCreator.barsUnit')}</div>
                    <div class="lc-card-actions">
                        <button class="lc-card-btn" data-loop-action="load" data-loop-id="${loop.id}"
                            title="${this.t('loopCreator.loadLoop')}">✏️</button>
                        <button class="lc-card-btn lc-card-btn--danger" data-loop-action="delete" data-loop-id="${loop.id}"
                            title="${this.t('loopCreator.deleteLoop')}">🗑</button>
                    </div>
                </div>`;
        }).join('');

        grid.addEventListener('click', (e) => {
            const action = e.target.closest('[data-loop-action]')?.dataset;
            if (!action) return;
            if (action.loopAction === 'load') this._loadLoopById(parseInt(action.loopId));
            if (action.loopAction === 'delete') this._deleteLoopById(parseInt(action.loopId));
        }, { once: true });
    }

    async _loadLoopById(id) {
        try {
            const result = await this.api.sendCommand('loop_get', { loopId: id });
            const loop = result.loop;
            if (!loop) return;

            this.currentLoopId = loop.id;
            this.loopName = loop.name;
            this.tempo = loop.tempo;
            this.timeSigNum = loop.time_sig_num;
            this.timeSigDen = loop.time_sig_den;
            this.bars = loop.bars;
            this.ppq = loop.ppq;
            this.instrumentProgram = loop.instrument_program ?? 0;

            // Update UI controls
            const nameInput = this.$('#lc-name-input');
            const tempoInput = this.$('#lc-tempo');
            const barsInput = this.$('#lc-bars');
            const timeSigSel = this.$('#lc-timesig');
            if (nameInput) nameInput.value = loop.name;
            if (tempoInput) tempoInput.value = loop.tempo;
            if (barsInput) barsInput.value = loop.bars;
            if (timeSigSel) timeSigSel.value = `${loop.time_sig_num}:${loop.time_sig_den}`;

            const seq = typeof loop.midi_data === 'string' ? JSON.parse(loop.midi_data) : (loop.midi_data || []);
            this.sequence = seq;

            if (this.pianoRoll) {
                this._refreshPianoRollRange();
                this.pianoRoll.sequence = seq;
                if (typeof this.pianoRoll.redraw === 'function') this.pianoRoll.redraw();
            }

            this._renderLibrary();
            this._setStatus(this.t('loopCreator.statusLoaded'));
        } catch (err) {
            this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`);
        }
    }

    async _deleteLoopById(id) {
        try {
            await this.api.sendCommand('loop_delete', { loopId: id });
            if (this.currentLoopId === id) this._newLoop();
            await this._loadLibrary();
        } catch (err) {
            this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`);
        }
    }

    _newLoop() {
        this.currentLoopId = null;
        this.loopName = this.t('loopCreator.untitled');
        this.tempo = 120;
        this.timeSigNum = 4;
        this.timeSigDen = 4;
        this.bars = 2;
        this.ppq = 480;
        this.sequence = [];

        const nameInput = this.$('#lc-name-input');
        const tempoInput = this.$('#lc-tempo');
        const barsInput = this.$('#lc-bars');
        const timeSigSel = this.$('#lc-timesig');
        if (nameInput) nameInput.value = this.loopName;
        if (tempoInput) tempoInput.value = this.tempo;
        if (barsInput) barsInput.value = this.bars;
        if (timeSigSel) timeSigSel.value = '4:4';

        this._clearNotes();
        this._refreshPianoRollRange();
        this._renderLibrary();
    }

    // =========================================================
    // STATUS
    // =========================================================

    _setStatus(msg) {
        const el = this.$('#lc-status');
        if (el) el.textContent = msg;
    }
}

if (typeof window !== 'undefined') {
    window.LoopCreatorModal = LoopCreatorModal;
}
