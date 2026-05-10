/**
 * LoopEditorModal — Dedicated single-loop editor
 *
 * Extracted from LoopCreatorModal's "Create" tab.
 * Opens on top of LoopManagerModal when creating or editing a loop.
 * Calls back onSaved(loopId) on save so the manager can refresh.
 */
class LoopEditorModal extends BaseModal {
    constructor(api, eventBus, { onSaved } = {}) {
        super({
            id: 'loop-editor-modal',
            size: 'full',
            title: 'loopEditor.title',
            closeOnOverlay: false,
            customClass: 'loop-editor-modal'
        });
        this.api = api;
        this.eventBus = eventBus || window.eventBus || null;
        this.onSaved = onSaved || null;

        // Loop state
        this.currentLoopId = null;
        this.loopName = '';
        this.tempo = 120;
        this.timeSigNum = 4;
        this.timeSigDen = 4;
        this.bars = 2;
        this.ppq = 480;
        this.instrumentProgram = 0;
        this.sequence = [];

        // Recording
        this.isRecording = false;
        this.recordStartTime = 0;
        this.recordedNotes = [];
        this._midiInDevice = null;
        this._monitorActive = false;
        this._midiInHandler = null;

        // Playback
        this.isPlaying = false;
        this._playbackTimers = [];
        this._synth = null;

        // Keyboard
        this._activeKeys = new Set();
        this._keyHandler = null;

        // Live preview envelopes (note → [envelope, ...]) so a key release
        // can cancel the still-ringing voice on the local synth.
        this._liveEnvelopes = new Map();

        // Output
        this.outputMode = 'synth';
        this.outputDeviceId = null;
        this.outputChannel = 0;
        this._outputTarget = 'synth';
        this._clipboard = [];
        this.outputNoteMin = 36;
        this.outputNoteMax = 84;
        this.outputGmProgram = 0;

        // Piano roll
        this.pianoRoll = null;
        this._pianoRollVisible = true;

        // Minimap
        this._minimap = null;
        this._minimapObserver = null;

        // Animation
        this._playheadRAF = null;
        this._playheadStartTime = 0;
        this._recordingRAF = null;

        // Debounced piano-roll refresh (for fast keystrokes on tempo/bars)
        this._refreshTimer = null;
    }

    // =========================================================
    // OPEN OVERRIDE — supports { loopId } arg for editing
    // =========================================================

    open({ loopId } = {}) {
        if (this.isOpen) return;
        if (loopId) {
            this._loadLoopStateById(loopId).then(() => {
                if (!this.isOpen) super.open();
            });
        } else {
            this._resetLoopState();
            super.open();
        }
    }

    async _loadLoopStateById(id) {
        try {
            const r = await this.api.sendCommand('loop_get', { loopId: id });
            const loop = r.loop;
            if (!loop) return;
            this.currentLoopId     = loop.id;
            this.loopName          = loop.name;
            this.tempo             = loop.tempo;
            this.timeSigNum        = loop.time_sig_num;
            this.timeSigDen        = loop.time_sig_den;
            this.bars              = loop.bars;
            this.ppq               = loop.ppq;
            this.instrumentProgram = loop.instrument_program ?? 0;
            this.sequence          = LoopUtils.parseSequence(loop.midi_data);
            const range = this._gmNoteRange(this.instrumentProgram);
            this.outputNoteMin = range.min;
            this.outputNoteMax = range.max;
        } catch (err) {
            LoopUtils.handleError(err, 'editor.load', {
                toast: this.t('loopEditor.errLoad')
            });
        }
    }

    _gmNoteRange(program) {
        if (program >= 120) return { min: 36, max: 84 };   // Sound FX
        if (program >= 112) return { min: 35, max: 81 };   // Percussive
        if (program >= 104) return { min: 36, max: 84 };   // Ethnic
        if (program >=  96) return { min: 36, max: 84 };   // Synth FX
        if (program >=  88) return { min: 36, max: 84 };   // Synth Pad
        if (program >=  80) return { min: 36, max: 96 };   // Synth Lead
        if (program >=  72) return { min: 60, max: 96 };   // Pipe (flutes)
        if (program >=  64) return { min: 41, max: 87 };   // Reed (sax, oboe)
        if (program >=  56) return { min: 40, max: 84 };   // Brass
        if (program >=  48) return { min: 36, max: 96 };   // Ensemble / Choir
        if (program >=  40) return { min: 55, max: 95 };   // Strings
        if (program >=  32) return { min: 28, max: 60 };   // Bass
        if (program >=  24) return { min: 40, max: 84 };   // Guitar
        if (program >=  16) return { min: 36, max: 96 };   // Organ
        if (program >=   8) return { min: 48, max: 84 };   // Chromatic Perc
        return { min: 21, max: 108 };                       // Piano
    }

    _resetLoopState() {
        this.currentLoopId   = null;
        this.loopName        = '';
        this.tempo           = 120;
        this.timeSigNum      = 4;
        this.timeSigDen      = 4;
        this.bars            = 2;
        this.ppq             = 480;
        this.sequence        = [];
        this.instrumentProgram = 0;
        this.outputNoteMin   = 36;
        this.outputNoteMax   = 84;
        this.outputGmProgram = 0;
    }

    // =========================================================
    // RENDERING
    // =========================================================

    _renderHeader() {
        const name = this.loopName || this.t('loopEditor.title');
        return `
        <div class="modal-header le-header">
            <button class="lc-btn lc-btn-sm le-back-btn" data-action="close">← ${this.t('loopEditor.back')}</button>
            <span class="le-header-title">✏️ ${this.escape(name)}</span>
            <div class="le-header-actions">
                <button class="lc-btn lc-btn-primary lc-btn-sm" data-action="save-loop">💾 ${this.t('loopCreator.save')}</button>
                <button class="modal-close" data-action="close" aria-label="${this.t('common.close')}">&times;</button>
            </div>
        </div>`;
    }

    renderBody() {
        const timeSigOptions = [
            ['2/4','2','4'], ['3/4','3','4'], ['4/4','4','4'],
            ['5/4','5','4'], ['6/8','6','8'], ['7/8','7','8']
        ];
        const timeSigHtml = timeSigOptions.map(([label, num, den]) =>
            `<option value="${num}:${den}" ${this.timeSigNum == num && this.timeSigDen == den ? 'selected' : ''}>${label}</option>`
        ).join('');

        return `
        <div class="le-layout">
            <!-- ── Toolbar (2 rows, grouped sections) ── -->
            <div class="lc-ctrl-bar">

                <!-- Row 1: Loop metadata + Transport -->
                <div class="lc-ctrl-row">
                    <!-- Metadata group -->
                    <div class="le-group le-group-meta">
                        <span class="le-group-label">${this.t('loopEditor.groupLoop')}</span>
                        <input type="text" class="lc-name-input le-name-input" id="lc-name-input"
                            value="${this.escape(this.loopName || this.t('loopCreator.untitled'))}"
                            placeholder="${this.t('loopCreator.namePlaceholder')}" />
                        <div class="lc-spinbox" title="${this.t('loopCreator.tempo')}">
                            <button class="lc-spin-btn" data-action="tempo-dec">‹</button>
                            <input type="number" id="lc-tempo" class="lc-spin-input lc-spin-input--sm" value="${this.tempo}" min="20" max="300" step="1" />
                            <button class="lc-spin-btn" data-action="tempo-inc">›</button>
                        </div>
                        <span class="lc-unit">BPM</span>
                        <select id="lc-timesig" class="lc-select lc-select-xs" title="${this.t('loopCreator.timeSignature')}">${timeSigHtml}</select>
                        <div class="lc-spinbox" title="${this.t('loopCreator.bars')}">
                            <button class="lc-spin-btn" data-action="bars-dec">‹</button>
                            <input type="number" id="lc-bars" class="lc-spin-input lc-spin-input--sm" value="${this.bars}" min="1" max="32" step="1" />
                            <button class="lc-spin-btn" data-action="bars-inc">›</button>
                        </div>
                        <span class="lc-unit" title="${this.t('loopCreator.bars')}">M</span>
                    </div>

                    <span class="lc-ctrl-spacer"></span>

                    <!-- Transport group -->
                    <div class="le-group le-group-transport">
                        <span class="le-group-label">${this.t('loopEditor.groupTransport')}</span>
                        <div class="lc-btn-group">
                            <button class="lc-btn lc-btn-icon lc-btn-record" id="lc-record-btn" data-action="record" title="${this.t('loopCreator.record')} (R)">
                                <span class="lc-rec-dot"></span>
                            </button>
                            <button class="lc-btn lc-btn-icon" data-action="preview" title="${this.t('loopCreator.preview')} (Space)">▶</button>
                            <button class="lc-btn lc-btn-icon" data-action="stop-all" title="${this.t('loopCreator.stop')} (Esc)">⏹</button>
                        </div>
                        <button class="lc-btn lc-btn-icon lc-btn-output" id="lc-output-toggle"
                            data-action="toggle-output" title="${this.t('loopCreator.outputSynth')}">🔊</button>
                        <span class="lc-rec-indicator hidden" id="lc-rec-indicator">
                            <span class="lc-rec-dot lc-rec-dot--pulse"></span>
                            <span class="lc-rec-time" id="lc-rec-time">0:00</span>
                        </span>
                    </div>
                </div>

                <!-- Row 2: Editing tools, organised by purpose -->
                <div class="lc-ctrl-row">
                    <!-- Mode group -->
                    <div class="le-group le-group-mode">
                        <span class="le-group-label">${this.t('loopEditor.groupMode')}</span>
                        <div class="lc-btn-group">
                            <button class="lc-btn lc-btn-icon" data-action="mode-view"   id="lc-mode-view"   title="${this.t('loopCreator.modeView')} (V)"   aria-pressed="false">👁</button>
                            <button class="lc-btn lc-btn-icon" data-action="mode-select" id="lc-mode-select" title="${this.t('loopCreator.modeSelect')} (S)" aria-pressed="false">◻</button>
                            <button class="lc-btn lc-btn-icon" data-action="mode-draw"   id="lc-mode-draw"   title="${this.t('loopCreator.modeDraw')} (D)"   aria-pressed="true">✏️</button>
                        </div>
                    </div>

                    <!-- History group -->
                    <div class="le-group le-group-history">
                        <span class="le-group-label">${this.t('loopEditor.groupHistory')}</span>
                        <div class="lc-btn-group">
                            <button class="lc-btn lc-btn-icon" data-action="undo" title="${this.t('loopCreator.undo')} (⌘Z)">↶</button>
                            <button class="lc-btn lc-btn-icon" data-action="redo" title="${this.t('loopCreator.redo')} (⌘⇧Z)">↷</button>
                        </div>
                    </div>

                    <!-- Edit group: clipboard + delete -->
                    <div class="le-group le-group-edit">
                        <span class="le-group-label">${this.t('loopEditor.groupEdit')}</span>
                        <div class="lc-btn-group">
                            <button class="lc-btn lc-btn-icon" data-action="select-all"      title="${this.t('loopCreator.selectAll')} (⌘A)">▣</button>
                            <button class="lc-btn lc-btn-icon" data-action="copy-notes"      id="lc-copy-btn"  title="${this.t('loopCreator.copy')} (⌘C)">📋</button>
                            <button class="lc-btn lc-btn-icon" data-action="paste-notes"     id="lc-paste-btn" title="${this.t('loopCreator.paste')} (⌘V)">📄</button>
                            <button class="lc-btn lc-btn-icon" data-action="delete-selected" title="${this.t('loopCreator.deleteSelected')} (⌫)">🗑</button>
                            <button class="lc-btn lc-btn-icon" data-action="clear-notes"     title="${this.t('loopCreator.clearNotes')}">⊠</button>
                        </div>
                    </div>

                    <!-- Grid group: snap + quantize -->
                    <div class="le-group le-group-grid">
                        <span class="le-group-label">${this.t('loopEditor.groupGrid')}</span>
                        <select id="lc-snap" class="lc-select lc-select-xs" title="${this.t('loopCreator.snap')}">
                            <option value="480">1/1</option><option value="240">1/2</option>
                            <option value="120" selected>1/4</option><option value="60">1/8</option>
                            <option value="30">1/16</option>
                        </select>
                        <select id="lc-quantize" class="lc-select lc-select-xs" title="${this.t('loopCreator.quantize')}">
                            <option value="0">Q —</option>
                            <option value="480">Q 1/1</option><option value="240">Q 1/2</option>
                            <option value="120" selected>Q 1/4</option><option value="60">Q 1/8</option>
                            <option value="30">Q 1/16</option>
                        </select>
                        <button class="lc-btn lc-btn-icon" data-action="quantize-selection" title="${this.t('loopEditor.quantizeSelection')}">⊞</button>
                    </div>

                    <!-- MIDI In group -->
                    <div class="le-group le-group-input">
                        <span class="le-group-label">${this.t('loopEditor.groupInput')}</span>
                        <select id="lc-midi-in-device" class="lc-select lc-select-midi" title="${this.t('loopCreator.midiIn')}">
                            <option value="">—</option>
                        </select>
                    </div>

                    <span class="lc-ctrl-spacer"></span>

                    <!-- View group: zoom + piano-roll toggle -->
                    <div class="le-group le-group-view">
                        <span class="le-group-label">${this.t('loopEditor.groupView')}</span>
                        <div class="lc-btn-group">
                            <button class="lc-btn lc-btn-icon" data-action="zoom-h-out" title="${this.t('loopEditor.zoomHOut')}">−H</button>
                            <button class="lc-btn lc-btn-icon" data-action="zoom-h-in"  title="${this.t('loopEditor.zoomHIn')}">+H</button>
                            <button class="lc-btn lc-btn-icon" data-action="zoom-v-out" title="${this.t('loopEditor.zoomVOut')}">−V</button>
                            <button class="lc-btn lc-btn-icon" data-action="zoom-v-in"  title="${this.t('loopEditor.zoomVIn')}">+V</button>
                        </div>
                        <button class="lc-btn lc-btn-icon" data-action="toggle-piano-roll" id="lc-toggle-roll"
                            title="${this.t('loopCreator.showPianoRoll')}" aria-pressed="false">🎹</button>
                    </div>
                </div>

                <!-- Persistent status line -->
                <div class="le-status-bar">
                    <span class="lc-status" id="lc-status"></span>
                </div>
            </div>

            <!-- ── Piano roll (collapsible) ── -->
            <div class="lc-pianoroll-area" id="lc-pianoroll-area">
                <div class="lc-pianoroll-wrap" id="lc-pianoroll-wrap"></div>
            </div>

            <!-- ── Minimap (always visible) ── -->
            <canvas class="lc-minimap" id="lc-minimap"
                    role="slider" tabindex="0"
                    aria-label="${this.t('loopEditor.minimapAria')}"></canvas>

            <!-- ── Keyboard panel (KeyboardModal embedded) ── -->
            <div class="lc-kb-panel" id="lc-kb-panel"></div>
        </div>`;
    }

    renderFooter() { return ''; }

    // =========================================================
    // LIFECYCLE
    // =========================================================

    onOpen() {
        this._initSynth();
        this._attachEvents();
        this._initPianoRoll();
        this._applyPianoRollVisibility();
        this._loadMidiInDevices();
        this._mountKeyboardPanel();
        this._attachKeyboardShortcuts();
    }

    onClose() {
        this._detachKeyboardShortcuts();
        this._unmountKeyboardPanel();
        this._stopAll();
        this._stopRecordingAnimation();
        this._stopMidiInMonitor();
        if (this._minimapObserver) {
            this._minimapObserver.disconnect();
            this._minimapObserver = null;
        }
        this._minimap?.destroy();
        this._minimap = null;
        this.pianoRoll = null;
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    }

    // =========================================================
    // EVENTS
    // =========================================================

    _attachEvents() {
        this.dialog.addEventListener('click',  (e) => this._onClick(e));
        this.dialog.addEventListener('change', (e) => this._onChange(e));
        this.dialog.addEventListener('input',  (e) => this._onInput(e));
    }

    _onClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        switch (btn.dataset.action) {
            case 'tempo-dec':         this._adjustTempo(-1);    break;
            case 'tempo-inc':         this._adjustTempo(+1);    break;
            case 'bars-dec':          this._adjustBars(-1);     break;
            case 'bars-inc':          this._adjustBars(+1);     break;
            case 'mode-view':         this._setEditMode('view');     break;
            case 'mode-draw':         this._setEditMode('dragpoly'); break;
            case 'mode-select':       this._setEditMode('select');   break;
            case 'select-all':        this._selectAll();             break;
            case 'copy-notes':        this._copyNotes();             break;
            case 'paste-notes':       this._pasteNotes();            break;
            case 'delete-selected':   this._deleteSelected();        break;
            case 'undo':              this.pianoRoll?.undo?.();      break;
            case 'redo':              this.pianoRoll?.redo?.();      break;
            case 'clear-notes':       this._clearNotes();            break;
            case 'toggle-output':     this._toggleOutput();          break;
            case 'toggle-piano-roll': this._togglePianoRoll();       break;
            case 'zoom-h-in':         this._zoomH(0.5);              break;
            case 'zoom-h-out':        this._zoomH(2.0);              break;
            case 'zoom-v-in':         this._zoomV(0.75);             break;
            case 'zoom-v-out':        this._zoomV(1.5);              break;
            case 'record':            this._toggleRecording();       break;
            case 'preview':           this._previewLoop();           break;
            case 'stop-all':          this._stopAll();               break;
            case 'save-loop':         this._saveLoop();              break;
            case 'quantize-selection':this._quantizeSelection();     break;
            case 'close':             this.close();                  break;
        }
    }

    _onChange(e) {
        const id = e.target.id;
        if (id === 'lc-timesig') {
            const [num, den] = e.target.value.split(':').map(Number);
            this.timeSigNum = num; this.timeSigDen = den;
            this._refreshPianoRollRange();
        } else if (id === 'lc-snap') {
            if (this.pianoRoll) this.pianoRoll.snap = parseInt(e.target.value);
        } else if (id === 'lc-midi-in-device') {
            this._midiInDevice = e.target.value || null;
        }
    }

    _onInput(e) {
        const id = e.target.id;
        if (id === 'lc-tempo') {
            const v = LoopUtils.validate.tempo(e.target.value, this.tempo);
            if (v !== this.tempo) { this.tempo = v; this._scheduleRefreshRange(); }
        } else if (id === 'lc-bars') {
            const v = LoopUtils.validate.editorBars(e.target.value, this.bars);
            if (v !== this.bars) { this.bars = v; this._scheduleRefreshRange(); }
        } else if (id === 'lc-name-input') {
            this.loopName = e.target.value;
        }
    }

    _scheduleRefreshRange() {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            this._refreshPianoRollRange();
        }, 200);
    }

    // =========================================================
    // KEYBOARD SHORTCUTS
    // =========================================================

    _attachKeyboardShortcuts() {
        if (this._keyHandler) return;
        this._keyHandler = (e) => {
            // Don't intercept while typing in a text/number input
            const t = e.target;
            const tag = (t?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
            if (!this.isOpen) return;

            const mod = e.ctrlKey || e.metaKey;
            // Only act if the editor modal is the front-most loop modal
            const front = document.querySelector('.modal-overlay:not(.hidden) .loop-editor-modal');
            if (!front || !front.contains(this.dialog || front)) {
                // Defensive: if our dialog isn't visible, skip
                if (!this.dialog || !this.dialog.offsetParent) return;
            }

            if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.pianoRoll?.undo?.(); return; }
            if (mod && e.key.toLowerCase() === 'z' &&  e.shiftKey) { e.preventDefault(); this.pianoRoll?.redo?.(); return; }
            if (mod && e.key.toLowerCase() === 'y')                { e.preventDefault(); this.pianoRoll?.redo?.(); return; }
            if (mod && e.key.toLowerCase() === 'a')                { e.preventDefault(); this._selectAll();        return; }
            if (mod && e.key.toLowerCase() === 'c')                { e.preventDefault(); this._copyNotes();        return; }
            if (mod && e.key.toLowerCase() === 'v')                { e.preventDefault(); this._pasteNotes();       return; }
            if (mod && e.key.toLowerCase() === 's')                { e.preventDefault(); this._saveLoop();         return; }
            if (e.key === 'Delete' || e.key === 'Backspace')       { e.preventDefault(); this._deleteSelected();   return; }
            if (e.key === ' ')                                     { e.preventDefault(); this.isPlaying ? this._stopAll() : this._previewLoop(); return; }
            if (e.key === 'Escape')                                { this._stopAll();                              return; }
            if (e.key.toLowerCase() === 'r')                       { this._toggleRecording();                      return; }
            // Mode shortcuts (no modifier): V/S/D
            if (e.key.toLowerCase() === 'v' && !mod)               { this._setEditMode('view');     return; }
            if (e.key.toLowerCase() === 's' && !mod && !e.shiftKey){ this._setEditMode('select');   return; }
            if (e.key.toLowerCase() === 'd' && !mod)               { this._setEditMode('dragpoly'); return; }
        };
        document.addEventListener('keydown', this._keyHandler);
    }

    _detachKeyboardShortcuts() {
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
    }

    // =========================================================
    // PIANO ROLL
    // =========================================================

    _initPianoRoll() {
        const container = this.$('#lc-pianoroll-wrap');
        if (!container) return;
        if (!customElements?.get?.('webaudio-pianoroll')) {
            container.innerHTML = `<div class="lc-pianoroll-error">${this.t('loopCreator.pianoRollUnavailable')}</div>`;
            return;
        }
        this.pianoRoll = document.createElement('webaudio-pianoroll');
        const total = this._totalTicks();
        this.pianoRoll.setAttribute('width',    container.clientWidth  || 900);
        this.pianoRoll.setAttribute('height',   container.clientHeight || 200);
        this.pianoRoll.setAttribute('editmode', 'dragpoly');
        const noteSpan0 = this.outputNoteMax - this.outputNoteMin;
        const yrange0   = Math.min(noteSpan0 + 1, 36);
        const yoffset0  = this._centeredYOffset(this.outputNoteMin, this.outputNoteMax, yrange0);
        this.pianoRoll.setAttribute('xrange',    total.toString());
        this.pianoRoll.setAttribute('yrange',    yrange0.toString());
        this.pianoRoll.setAttribute('yoffset',   yoffset0.toString());
        this.pianoRoll.setAttribute('wheelzoom', '1');
        this.pianoRoll.setAttribute('xscroll',   '1');
        this.pianoRoll.setAttribute('yscroll',   '1');
        this.pianoRoll.setAttribute('xruler',    '1');
        this.pianoRoll.setAttribute('cursor',    '0');
        this.pianoRoll.setAttribute('markstart', '0');
        this.pianoRoll.setAttribute('markend',   total.toString());
        this.pianoRoll.setAttribute('snap',      '120');
        this.pianoRoll.setAttribute('timebase',  this.ppq.toString());
        this.pianoRoll.setAttribute('tempo',     this.tempo.toString());
        this.pianoRoll.setAttribute('colcursor', 'rgba(0,0,0,0)');
        this.pianoRoll.setAttribute('colmark',   'rgba(0,0,0,0)');
        this._applyPianoRollTheme();
        container.appendChild(this.pianoRoll);
        this.pianoRoll.sequence = this.sequence;
        this.pianoRoll.redraw?.();
        this._initMinimap();
    }

    _applyPianoRollTheme() {
        if (!this.pianoRoll) return;
        const dark = document.body.classList.contains('theme-dark');
        this.pianoRoll.setAttribute('colnote',     dark ? '#5b9bd5' : '#4a90d9');
        this.pianoRoll.setAttribute('colnotesel',  dark ? '#f5a623' : '#e8931a');
        this.pianoRoll.setAttribute('colbg',       dark ? '#1a1a2e' : '#f8f9fa');
        this.pianoRoll.setAttribute('colline',     dark ? '#333355' : '#dde0e6');
        this.pianoRoll.setAttribute('colrulerbg',  dark ? '#12122a' : '#eef0f4');
        this.pianoRoll.setAttribute('colrulerfg',  dark ? '#8888aa' : '#666677');
        this.pianoRoll.setAttribute('colkeybg',    dark ? '#1e1e38' : '#f0f0f4');
        this.pianoRoll.setAttribute('colkeyfg',    dark ? '#ccccee' : '#333344');
        this.pianoRoll.setAttribute('colkeyblack', dark ? '#0d0d1a' : '#303040');
    }

    _totalTicks()  { return this.ppq * this.timeSigNum * this.bars; }

    _centeredYOffset(noteMin, noteMax, yrange) {
        const center = (noteMin + noteMax) / 2;
        return Math.max(0, Math.min(127 - yrange, Math.round(center - yrange / 2)));
    }

    _refreshPianoRollRange() {
        if (!this.pianoRoll) return;
        const total = this._totalTicks();
        this.pianoRoll.setAttribute('xrange',   total.toString());
        this.pianoRoll.setAttribute('markend',  total.toString());
        this.pianoRoll.setAttribute('timebase', this.ppq.toString());
        this.pianoRoll.setAttribute('tempo',    this.tempo.toString());
        const noteSpan = this.outputNoteMax - this.outputNoteMin;
        const yrange   = Math.min(noteSpan + 1, 36);
        const yoffset  = this._centeredYOffset(this.outputNoteMin, this.outputNoteMax, yrange);
        this.pianoRoll.setAttribute('yrange',  yrange.toString());
        this.pianoRoll.setAttribute('yoffset', yoffset.toString());
        this.pianoRoll.redraw?.();
        this._syncMinimap();
    }

    _adjustTempo(d) {
        this.tempo = LoopUtils.validate.tempo(this.tempo + d, this.tempo);
        const el = this.$('#lc-tempo'); if (el) el.value = this.tempo;
        this._refreshPianoRollRange();
    }

    _adjustBars(d) {
        this.bars = LoopUtils.validate.editorBars(this.bars + d, this.bars);
        const el = this.$('#lc-bars'); if (el) el.value = this.bars;
        this._refreshPianoRollRange();
    }

    _setEditMode(mode) {
        if (!this.pianoRoll) return;
        const prMode = mode === 'view' ? 'select' : mode;
        this.pianoRoll.setAttribute('editmode', prMode);
        this.$('#lc-mode-view')?.setAttribute('aria-pressed',   mode === 'view'     ? 'true' : 'false');
        this.$('#lc-mode-select')?.setAttribute('aria-pressed', mode === 'select'   ? 'true' : 'false');
        this.$('#lc-mode-draw')?.setAttribute('aria-pressed',   mode === 'dragpoly' ? 'true' : 'false');
    }

    _clearNotes() {
        this.sequence = [];
        if (this.pianoRoll) { this.pianoRoll.sequence = []; this.pianoRoll.redraw?.(); }
        this._syncMinimap();
    }

    _copyNotes() {
        if (!this.pianoRoll) return;
        if (typeof this.pianoRoll.copySelection === 'function') {
            this._clipboard = this.pianoRoll.copySelection() ?? [];
        } else {
            this._clipboard = (this.pianoRoll.sequence || []).filter(n => n.f).map(n => ({...n}));
        }
        this._setStatus(this.t('loopEditor.notesCopied', { count: this._clipboard.length }));
    }

    _pasteNotes() {
        if (!this.pianoRoll || !this._clipboard.length) return;
        const cursor = this.pianoRoll.cursor ?? 0;
        if (typeof this.pianoRoll.pasteNotes === 'function') {
            this.pianoRoll.pasteNotes(this._clipboard, cursor);
        } else {
            const minT = Math.min(...this._clipboard.map(n => n.t));
            const pasted = this._clipboard.map(n => ({ ...n, t: n.t - minT + cursor }));
            this.pianoRoll.sequence = [...(this.pianoRoll.sequence || []), ...pasted];
        }
        this.pianoRoll.redraw?.();
        this._syncMinimap();
    }

    _quantizeSelection() {
        if (!this.pianoRoll) return;
        const q = parseInt(this.$('#lc-quantize')?.value ?? 0);
        if (!q || q <= 0) {
            this._setStatus(this.t('loopEditor.quantizeNoGrid'));
            return;
        }
        const seq = Array.isArray(this.pianoRoll.sequence) ? [...this.pianoRoll.sequence] : [];
        const selected = seq.filter(n => n.f);
        const target = selected.length ? selected : seq;
        let count = 0;
        for (const note of target) {
            const before = note.t;
            note.t = Math.round(note.t / q) * q;
            note.g = Math.max(q, Math.round((note.g || note.l || 120) / q) * q);
            if (note.t !== before) count++;
        }
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
        this._syncMinimap();
        this._setStatus(this.t('loopEditor.quantizedNotes', { count }));
    }

    _toggleOutput() {
        // Flush any held preview notes on the previous target so we don't leave
        // stuck voices on the synth or hanging note-ons on the MIDI device.
        const previouslyLive = this._outputTarget === 'live';
        if (previouslyLive && this.outputDeviceId) {
            for (const n of this._activeKeys) {
                this.api.sendCommand('midi_send_note', {
                    deviceId: this.outputDeviceId, channel: this.outputChannel ?? 0,
                    note: n, velocity: 0
                }).catch(err => LoopUtils.handleError(err, 'editor.live.toggle.noteOff'));
            }
        }
        this._previewStopAll();

        this._outputTarget = previouslyLive ? 'synth' : 'live';
        const btn = this.$('#lc-output-toggle');
        const isLive = this._outputTarget === 'live';
        if (btn) {
            btn.textContent = isLive ? '🔌' : '🔊';
            btn.title = isLive ? this.t('loopCreator.outputLive') : this.t('loopCreator.outputSynth');
            btn.classList.toggle('lc-btn-output--active', isLive);
        }
        this._setStatus(isLive ? this.t('loopCreator.outputLive') : this.t('loopCreator.outputSynth'));
    }

    _selectAll() {
        if (!this.pianoRoll) return;
        const seq = Array.isArray(this.pianoRoll.sequence) ? this.pianoRoll.sequence : [];
        seq.forEach(note => { note.f = 1; });
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
    }

    _deleteSelected() {
        if (!this.pianoRoll) return;
        this.pianoRoll.sequence = (this.pianoRoll.sequence || []).filter(n => !n.f);
        this.pianoRoll.redraw?.();
        this._syncMinimap();
    }

    _applyPianoRollVisibility() {
        const area      = this.$('#lc-pianoroll-area');
        const kbPanel   = this.$('#lc-kb-panel');
        const toggleBtn = this.$('#lc-toggle-roll');
        const vis = this._pianoRollVisible;
        if (area)    area.classList.toggle('lc-pianoroll-area--hidden', !vis);
        if (kbPanel) kbPanel.classList.toggle('lc-kb-panel--expanded',  !vis);
        if (toggleBtn) {
            toggleBtn.setAttribute('aria-pressed', vis ? 'true' : 'false');
            toggleBtn.title = vis ? this.t('loopCreator.hidePianoRoll') : this.t('loopCreator.showPianoRoll');
        }
    }

    _togglePianoRoll() {
        this._pianoRollVisible = !this._pianoRollVisible;
        this._applyPianoRollVisibility();
        if (this._pianoRollVisible && this.pianoRoll) {
            requestAnimationFrame(() => {
                const wrap = this.$('#lc-pianoroll-wrap');
                if (wrap) {
                    this.pianoRoll.setAttribute('width',  (wrap.clientWidth  || 900).toString());
                    this.pianoRoll.setAttribute('height', (wrap.clientHeight || 200).toString());
                    this.pianoRoll.redraw?.();
                    this._syncMinimap();
                }
            });
        }
    }

    _zoomH(factor) {
        if (!this.pianoRoll) return;
        const total = this._totalTicks();
        const cur   = parseFloat(this.pianoRoll.getAttribute('xrange') || total);
        const next  = Math.max(Math.ceil(total / 32), Math.min(total, Math.round(cur * factor)));
        this.pianoRoll.setAttribute('xrange', next.toString());
        this.pianoRoll.redraw?.();
        this._syncMinimap();
    }

    _zoomV(factor) {
        if (!this.pianoRoll) return;
        const cur  = parseFloat(this.pianoRoll.getAttribute('yrange') || 36);
        const next = Math.max(6, Math.min(128, Math.round(cur * factor)));
        this.pianoRoll.setAttribute('yrange', next.toString());
        this.pianoRoll.redraw?.();
    }

    _startPlayheadAnimation() {
        if (this._playheadRAF) return;
        this._playheadStartTime = performance.now();
        const animate = () => {
            if (!this.isPlaying) { this._playheadRAF = null; return; }
            if (this.pianoRoll) {
                const elapsed = (performance.now() - this._playheadStartTime) / 1000;
                this.pianoRoll.cursor = Math.min(
                    Math.round(elapsed * (this.tempo / 60) * this.ppq),
                    this._totalTicks()
                );
                this.pianoRoll.redrawMarker?.();
            }
            this._syncMinimap();
            this._playheadRAF = requestAnimationFrame(animate);
        };
        this._playheadRAF = requestAnimationFrame(animate);
    }

    _stopPlayheadAnimation() {
        if (this._playheadRAF) { cancelAnimationFrame(this._playheadRAF); this._playheadRAF = null; }
        if (this.pianoRoll) { this.pianoRoll.cursor = 0; this.pianoRoll.redrawMarker?.(); }
        this._syncMinimap();
    }

    // =========================================================
    // MINIMAP
    // =========================================================

    _initMinimap() {
        const canvas = this.$('#lc-minimap');
        if (!canvas) return;
        this._minimap = new window.LoopCreatorMinimap(canvas, {
            ppq:        this.ppq,
            timeSigNum: this.timeSigNum,
            bars:       this.bars,
            noteMin:    this.outputNoteMin,
            noteMax:    this.outputNoteMax,
            onSeek: (newOffset) => {
                if (!this.pianoRoll) return;
                this.pianoRoll.setAttribute('xoffset', newOffset.toString());
                this.pianoRoll.redraw?.();
                this._syncMinimap();
            }
        });
        if (this.pianoRoll) {
            this._minimapObserver = new MutationObserver(() => this._syncMinimap());
            this._minimapObserver.observe(this.pianoRoll, {
                attributes: true, attributeFilter: ['xoffset', 'xrange']
            });
        }
        const wrap = this.$('#lc-pianoroll-wrap');
        if (wrap) {
            wrap.addEventListener('wheel', () => requestAnimationFrame(() => this._syncMinimap()), { passive: true });
        }
        this._syncMinimap();
    }

    _syncMinimap() {
        const m = this._minimap;
        if (!m) return;
        const total  = this._totalTicks();
        const xoff   = parseFloat(this.pianoRoll?.getAttribute?.('xoffset') || 0);
        const xrange = parseFloat(this.pianoRoll?.getAttribute?.('xrange')  || total) || total;
        m.setConfig({ ppq: this.ppq, timeSigNum: this.timeSigNum, bars: this.bars, noteMin: this.outputNoteMin, noteMax: this.outputNoteMax });
        m.setNotes(this.pianoRoll?.sequence ?? []);
        m.setViewport(xoff, xrange);
        if (this.isRecording) {
            const recTick = Math.min(total, Math.round(
                (performance.now() - this.recordStartTime) / 1000 * (this.tempo / 60) * this.ppq
            ));
            m.setPlayhead(recTick, true);
        } else {
            m.setPlayhead(this.pianoRoll?.cursor ?? 0, this.isPlaying);
        }
    }

    _startRecordingAnimation() {
        const frame = () => {
            if (!this.isRecording) { this._recordingRAF = null; return; }
            this._syncMinimap();
            this._recordingRAF = requestAnimationFrame(frame);
        };
        this._recordingRAF = requestAnimationFrame(frame);
    }

    _stopRecordingAnimation() {
        if (this._recordingRAF) { cancelAnimationFrame(this._recordingRAF); this._recordingRAF = null; }
        this._syncMinimap();
    }

    // =========================================================
    // NOTE RECORDING
    // =========================================================

    _playNote(note, velocity = 80) {
        if (this._activeKeys.has(note)) return;
        this._activeKeys.add(note);
        if (this.isRecording) {
            const elapsed = (performance.now() - this.recordStartTime) / 1000;
            const tick = Math.round(elapsed * (this.tempo / 60) * this.ppq);
            this.recordedNotes.push({ note, velocity, tick, startMs: performance.now() });
        }
        this._previewNoteOn(note, velocity);
    }

    _stopNote(note) {
        this._activeKeys.delete(note);
        if (this.isRecording) this._finalizeNoteOff(note);
        this._previewNoteOff(note);
    }

    // ── Live preview: route note on/off to the active output target ──
    _previewNoteOn(note, velocity) {
        // Route to a connected MIDI device when output is set to "live"
        if (this._outputTarget === 'live' && this.outputMode === 'device' && this.outputDeviceId) {
            this.api.sendCommand('midi_send_note', {
                deviceId: this.outputDeviceId,
                channel:  this.outputChannel ?? 0,
                note, velocity
            }).catch(err => LoopUtils.handleError(err, 'editor.live.noteOn'));
            return;
        }
        // Otherwise play through the local synth so the user hears their input
        if (!this._synth) return;
        try {
            // Long duration acts as "until cancelled"; we cancel on note-off.
            const envelopes = this._synth.playNote(note, velocity, 0, 9999);
            if (envelopes) this._liveEnvelopes.set(note, envelopes);
        } catch (err) {
            LoopUtils.handleError(err, 'editor.live.synth.playNote');
        }
    }

    _previewNoteOff(note) {
        if (this._outputTarget === 'live' && this.outputMode === 'device' && this.outputDeviceId) {
            this.api.sendCommand('midi_send_note', {
                deviceId: this.outputDeviceId,
                channel:  this.outputChannel ?? 0,
                note, velocity: 0
            }).catch(err => LoopUtils.handleError(err, 'editor.live.noteOff'));
            return;
        }
        const envelopes = this._liveEnvelopes.get(note);
        if (!envelopes) return;
        for (const env of envelopes) {
            try { env?.cancel?.(); }
            catch (err) { LoopUtils.handleError(err, 'editor.live.synth.cancel'); }
        }
        this._liveEnvelopes.delete(note);
    }

    _previewStopAll() {
        if (this._liveEnvelopes.size) {
            for (const envelopes of this._liveEnvelopes.values()) {
                for (const env of envelopes) {
                    try { env?.cancel?.(); } catch (_) { /* best-effort cleanup */ }
                }
            }
            this._liveEnvelopes.clear();
        }
    }

    _finalizeNoteOff(note) {
        const idx = this.recordedNotes.findIndex(r => r.note === note);
        if (idx === -1) return;
        const rec = this.recordedNotes.splice(idx, 1)[0];
        const durMs = performance.now() - rec.startMs;
        const durTicks = Math.max(30, Math.round(durMs / 1000 * (this.tempo / 60) * this.ppq));
        const q = parseInt(this.$('#lc-quantize')?.value ?? 0);
        const t = q > 0 ? Math.round(rec.tick / q) * q : rec.tick;
        const g = q > 0 ? Math.max(q, Math.round(durTicks / q) * q) : durTicks;
        this._addNoteToRoll({ t, n: note, v: rec.velocity, g });
    }

    _addNoteToRoll(noteObj) {
        if (!this.pianoRoll) return;
        const seq = Array.isArray(this.pianoRoll.sequence) ? [...this.pianoRoll.sequence] : [];
        seq.push(noteObj);
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
        this._syncMinimap();
    }

    // =========================================================
    // RECORDING + MIDI IN
    // =========================================================

    _toggleRecording() {
        this.isRecording ? this._stopRecording() : this._startRecording();
    }

    _startRecording() {
        this.isRecording     = true;
        this.recordedNotes   = [];
        this.recordStartTime = performance.now();
        this.$('#lc-record-btn')?.classList.add('lc-btn-record--active');
        this.$('#lc-rec-indicator')?.classList.remove('hidden');
        if (this._midiInDevice) this._startMidiInMonitor();
        this._startRecordingAnimation();
        this._startRecordingTimer();
        this._setStatus(this.t('loopCreator.statusRecording'));
    }

    _stopRecording() {
        this.isRecording = false;
        for (const rec of [...this.recordedNotes]) this._finalizeNoteOff(rec.note);
        this.recordedNotes = [];
        this.$('#lc-record-btn')?.classList.remove('lc-btn-record--active');
        this.$('#lc-rec-indicator')?.classList.add('hidden');
        this._stopMidiInMonitor();
        this._stopRecordingAnimation();
        this._stopRecordingTimer();
        this._setStatus(this.t('loopCreator.statusRecordingDone'));
    }

    _startRecordingTimer() {
        this._stopRecordingTimer();
        const el = this.$('#lc-rec-time');
        if (!el) return;
        const update = () => {
            const elapsed = Math.floor((performance.now() - this.recordStartTime) / 1000);
            const m = Math.floor(elapsed / 60);
            const s = elapsed % 60;
            el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        };
        update();
        this._recTimerId = setInterval(update, 500);
    }

    _stopRecordingTimer() {
        if (this._recTimerId) { clearInterval(this._recTimerId); this._recTimerId = null; }
    }

    async _startMidiInMonitor() {
        if (!this._midiInDevice || this._monitorActive) return;
        try {
            await this.api.sendCommand('monitor_start', { deviceId: this._midiInDevice });
            this._monitorActive = true;
            this._midiInHandler = (data) => {
                if (data.device !== this._midiInDevice) return;
                if (!this.isRecording) return;
                const type = (data.type || '').toLowerCase();
                const note = data.data?.note ?? data.data?.n;
                const vel  = data.data?.velocity ?? data.data?.v ?? 64;
                if (note == null) return;
                if (type === 'noteon' && vel > 0)                              this._playNote(note, vel);
                else if (type === 'noteoff' || (type === 'noteon' && vel === 0)) this._stopNote(note);
            };
            this.api.on('monitor_event', this._midiInHandler);
        } catch (err) {
            LoopUtils.handleError(err, 'editor.midiIn.start', {
                toast: this.t('loopEditor.errMidiIn')
            });
        }
    }

    async _stopMidiInMonitor() {
        if (!this._monitorActive) return;
        this._monitorActive = false;
        if (this._midiInHandler) {
            this.api.off?.('monitor_event', this._midiInHandler);
            this._midiInHandler = null;
        }
        if (this._midiInDevice) {
            try { await this.api.sendCommand('monitor_stop', { deviceId: this._midiInDevice }); }
            catch (err) { LoopUtils.handleError(err, 'editor.midiIn.stop'); }
        }
    }

    async _loadMidiInDevices() {
        const sel = this.$('#lc-midi-in-device');
        if (!sel) return;
        try {
            const allDevices = await this.api.listDevices();
            const devices = allDevices.filter(d => d.status === 2 || d.connected === true);
            const existing = sel.value;
            sel.innerHTML = `<option value="">IN:—</option>`;
            for (const d of devices) {
                const id  = d.device_id || d.id;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = `IN: ${d.name || id}`;
                if (id === existing) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (err) {
            LoopUtils.handleError(err, 'editor.midiIn.list');
        }
    }

    _mountKeyboardPanel() {
        if (!window.keyboardModal) return;
        const container = this.$('#lc-kb-panel');
        if (!container) return;
        window.keyboardModal.mountAsPanel(container, {
            onNoteOn:  (note, vel) => this._playNote(note, vel),
            onNoteOff: (note)      => this._stopNote(note),
            onInstrumentSelected: ({ deviceId, channel, gmProgram }) => {
                // Cancel held preview voices so they don't ring on with the
                // previous instrument / device after the switch.
                this._previewStopAll();

                this.outputMode        = deviceId ? 'device' : 'synth';
                this.outputDeviceId    = deviceId || null;
                this.outputChannel     = channel ?? 0;
                this.outputGmProgram   = gmProgram ?? 0;
                this.instrumentProgram = gmProgram ?? 0;
                try { this._synth?.setChannelInstrument?.(0, this.instrumentProgram); }
                catch (err) { LoopUtils.handleError(err, 'editor.synth.setChannelInstrument'); }
                // Make sure the new program is loaded so the very first key press
                // produces sound (otherwise playNote returns null silently).
                if (this._synth && !this._synth.loadedInstruments?.has(this.instrumentProgram)) {
                    this._synth.loadInstrument(this.instrumentProgram).catch(err =>
                        LoopUtils.handleError(err, 'editor.synth.loadInstrument'));
                }
                const range = this._gmNoteRange(this.instrumentProgram);
                this.outputNoteMin = range.min;
                this.outputNoteMax = range.max;
                this._refreshPianoRollRange();
            }
        });
    }

    _unmountKeyboardPanel() {
        window.keyboardModal?.unmountPanel();
    }

    // =========================================================
    // PREVIEW PLAYBACK
    // =========================================================

    async _initSynth() {
        this._synth = await LoopUtils.createSynth({ initialProgram: this.instrumentProgram });
    }

    _previewLoop() {
        this._stopAll();
        const seq = this.pianoRoll?.sequence ?? [];
        if (!seq.length) { this._setStatus(this.t('loopCreator.statusNoNotes')); return; }
        if (this._outputTarget === 'live' && this.outputMode === 'device' && this.outputDeviceId) {
            this._previewViaDevice(seq); return;
        }
        if (!this._synth) { this._setStatus(this.t('loopCreator.statusNoSynth')); return; }
        const done = () => {
            this.isPlaying = false;
            this._stopPlayheadAnimation();
            this._setStatus('');
        };
        try { this._synth.setChannelInstrument(0, this.instrumentProgram); }
        catch (err) { LoopUtils.handleError(err, 'editor.preview.setChannelInstrument'); }
        this._synth.onPlaybackEnd = done;
        this.isPlaying = true;
        this._setStatus(this.t('loopCreator.statusPlaying'));
        this._startPlayheadAnimation();
        this._synth.loadSequence([...seq], this.tempo, this.ppq);
        this._synth.play().catch(err => {
            LoopUtils.handleError(err, 'editor.preview.play', {
                toast: this.t('loopEditor.errPreview')
            });
            done();
        });
    }

    _previewViaDevice(seq) {
        const spt = 60 / (this.tempo * this.ppq);
        this.isPlaying = true;
        this._setStatus(this.t('loopCreator.statusPlaying'));
        this._startPlayheadAnimation();
        for (const note of seq) {
            const onMs  = note.t * spt * 1000;
            const offMs = (note.t + (note.g || note.l || 120)) * spt * 1000;
            this._playbackTimers.push(setTimeout(() => {
                if (!this.isPlaying) return;
                this.api.sendCommand('midi_send_note', {
                    deviceId: this.outputDeviceId, channel: this.outputChannel,
                    note: note.n, velocity: note.v || 80
                }).catch(err => LoopUtils.handleError(err, 'editor.device.noteOn'));
            }, onMs));
            this._playbackTimers.push(setTimeout(() => {
                if (!this.isPlaying) return;
                this.api.sendCommand('midi_send_note', {
                    deviceId: this.outputDeviceId, channel: this.outputChannel,
                    note: note.n, velocity: 0
                }).catch(err => LoopUtils.handleError(err, 'editor.device.noteOff'));
            }, offMs));
        }
        this._playbackTimers.push(setTimeout(() => {
            this.isPlaying = false; this._setStatus('');
        }, this._totalTicks() * spt * 1000));
    }

    _stopAll() {
        this._playbackTimers.forEach(t => clearTimeout(t));
        this._playbackTimers = [];
        if (this.isRecording) this._stopRecording();
        this.isPlaying = false;
        this._stopPlayheadAnimation();
        if (this._synth) {
            this._synth.onPlaybackEnd = null;
            try { this._synth.stop?.(); }
            catch (err) { LoopUtils.handleError(err, 'editor.synth.stop'); }
            try { this._synth.cancelAllNotes?.(); }
            catch (err) { LoopUtils.handleError(err, 'editor.synth.cancelAllNotes'); }
        }
        // Cancel sustained live-preview voices that were still ringing
        this._previewStopAll();
        this._activeKeys.clear();
        this._setStatus('');
    }

    // =========================================================
    // SAVE / LOAD
    // =========================================================

    async _saveLoop() {
        this.loopName = (this.$('#lc-name-input')?.value?.trim()) || this.t('loopCreator.untitled');
        const seq = this.pianoRoll?.sequence ?? [];
        const payload = {
            name: this.loopName, tempo: this.tempo,
            time_sig_num: this.timeSigNum, time_sig_den: this.timeSigDen,
            bars: this.bars, ppq: this.ppq,
            instrument_program: this.instrumentProgram,
            midi_data: JSON.stringify(seq)
        };
        try {
            if (this.currentLoopId) {
                await this.api.sendCommand('loop_update', { loopId: this.currentLoopId, ...payload });
            } else {
                const r = await this.api.sendCommand('loop_create', payload);
                this.currentLoopId = r.loopId;
            }
            const titleEl = this.dialog?.querySelector('.le-header-title');
            if (titleEl) titleEl.textContent = `✏️ ${this.loopName}`;
            this._setStatus(this.t('loopCreator.statusSaved'));
            LoopUtils.toast(this.t('loopCreator.statusSaved'), 'success');
            this.onSaved?.(this.currentLoopId);
        } catch (err) {
            this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`);
            LoopUtils.handleError(err, 'editor.save', {
                toast: `${this.t('loopCreator.statusError')}: ${err.message}`
            });
        }
    }

    // =========================================================
    // HELPERS
    // =========================================================

    _setStatus(msg) { const el = this.$('#lc-status'); if (el) el.textContent = msg; }
}

if (typeof window !== 'undefined') window.LoopEditorModal = LoopEditorModal;
