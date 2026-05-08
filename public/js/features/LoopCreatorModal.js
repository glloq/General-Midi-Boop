/**
 * LoopCreatorModal — Loop Creator (∞)
 *
 * Three tabs:
 *   Tab 1 "Créer"     — Piano roll editor + mini keyboard + MIDI In recording
 *   Tab 2 "Boucles"   — Loop library (cards)
 *   Tab 3 "Arranger"  — Multi-track timeline with loop blocks
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

        // Active tab
        this.activeTab = 'create';

        // ── Creator state ──
        this.pianoRoll = null;
        this.sequence = [];
        this.currentLoopId = null;
        this.loopName = '';
        this.tempo = 120;
        this.timeSigNum = 4;
        this.timeSigDen = 4;
        this.bars = 2;
        this.ppq = 480;
        this.instrumentProgram = 0;

        // Recording
        this.isRecording = false;
        this.recordStartTime = 0;
        this.recordedNotes = [];
        this._recordingTick = 0;
        this._midiInDevice = null;     // selected device ID for MIDI in
        this._monitorActive = false;
        this._midiInHandler = null;    // bound api event handler

        // Playback
        this.isPlaying = false;
        this._playbackTimers = [];
        this._synth = null;

        // Keyboard
        this._activeKeys = new Set();
        this._mouseDownNote = null;
        this._activeKeyEnvelopes = new Map();

        // Output mode: 'synth' | 'device'
        // outputChannel uses MIDI base-0 (0..15) to match backend; UI displays as 1..16
        this.outputMode = 'synth';
        this.outputDeviceId = null;
        this.outputChannel = 0;
        this.outputNoteMin = 36;   // keyboard range (adapted per instrument)
        this.outputNoteMax = 84;
        this.outputGmProgram = 0;

        // Library
        this.library = [];
        this.devices = [];

        // ── Arranger state ──
        this.currentArrangementId = null;
        this.arrangementName = '';
        this.arrangementTempo = 120;
        this.arrangementBars = 16;
        this.tracks = [];           // [{id, track_index, label}]
        this.blocks = [];           // [{id, track_id, loop_id, position_bar, repetitions, loop_name, loop_bars}]
        this.isArrangerPlaying = false;
        this._arrangerTimers = [];
        this._dragInfo = null;
        this._dropPreview = null;

        // Cache (must be in constructor, not class field)
        this._fetchLoopDataCache = new Map();

        // Bound handlers
        this._boundDocMouseUp = this._onDocMouseUp.bind(this);
        this._boundDocMouseMove = this._onDocMouseMove.bind(this);
        this._playheadRAF = null;
        this._playheadStartTime = 0;

        // Minimap
        this._minimapCanvas = null;
        this._minimapObserver = null;
        this._minimapDragging = false;
    }

    // =========================================================
    // RENDERING — SHELL
    // =========================================================

    _renderHeader() {
        const saveLabel = this.activeTab === 'arranger'
            ? `💾 ${this.t('loopCreator.saveArrangement')}`
            : `💾 ${this.t('loopCreator.save')}`;
        const saveAction = this.activeTab === 'arranger' ? 'save-arrangement' : 'save-loop';
        const saveDisplay = this.activeTab === 'library' ? ' style="display:none"' : '';
        return `
        <div class="modal-header lc-header">
            <div class="lc-header-left">
                <span class="lc-header-title">∞</span>
            </div>
            <div class="lc-header-tabs" role="tablist">
                <button class="lc-tab${this.activeTab === 'create'   ? ' lc-tab--active' : ''}" data-tab="create"   role="tab" aria-selected="${this.activeTab === 'create'}">✏️ ${this.t('loopCreator.tabCreate')}</button>
                <button class="lc-tab${this.activeTab === 'library'  ? ' lc-tab--active' : ''}" data-tab="library"  role="tab" aria-selected="${this.activeTab === 'library'}">🗂 ${this.t('loopCreator.tabLibrary')}</button>
                <button class="lc-tab${this.activeTab === 'arranger' ? ' lc-tab--active' : ''}" data-tab="arranger" role="tab" aria-selected="${this.activeTab === 'arranger'}">∞ ${this.t('loopCreator.tabArranger')}</button>
            </div>
            <div class="lc-header-actions">
                <button class="lc-btn lc-btn-primary lc-btn-sm" id="lc-header-save" data-action="${saveAction}"${saveDisplay}>${saveLabel}</button>
                <button class="modal-close" data-action="close" aria-label="${this.t('common.close')}">&times;</button>
            </div>
        </div>`;
    }

    renderBody() {
        return `
        <div class="lc-layout">
            <div class="lc-tab-content" id="lc-tab-content">
                ${this._renderCreateTab()}
                ${this._renderLibraryTab()}
                ${this._renderArrangerTab()}
            </div>
        </div>`;
    }

    renderFooter() { return ''; }  // footer hidden via CSS; status lives in ctrl-bar

    // =========================================================
    // RENDERING — TAB 1: CREATE
    // =========================================================

    _renderCreateTab() {
        const timeSigOptions = [
            ['2/4','2','4'], ['3/4','3','4'], ['4/4','4','4'],
            ['5/4','5','4'], ['6/8','6','8'], ['7/8','7','8']
        ];
        const timeSigHtml = timeSigOptions.map(([label, num, den]) =>
            `<option value="${num}:${den}" ${this.timeSigNum == num && this.timeSigDen == den ? 'selected' : ''}>${label}</option>`
        ).join('');

        return `
        <div class="lc-pane" id="lc-pane-create">

            <!-- ── Single control bar ── -->
            <div class="lc-ctrl-bar">

                <!-- Instrument picker (compact inline) -->
                <div class="lc-instr-picker" id="lc-instr-picker">
                    <button class="lc-instr-trigger" id="lc-instr-trigger" data-action="instr-picker-toggle" type="button">
                        <span class="lc-instr-icon">
                            <img class="lc-instr-svg" id="lc-instr-svg" src="" style="display:none" alt="">
                            <span class="lc-instr-emoji" id="lc-instr-emoji">🎹</span>
                        </span>
                        <span class="lc-instr-name" id="lc-instr-name">${this.t('loopCreator.synthVirtual')}</span>
                        <span class="lc-instr-chevron">▾</span>
                    </button>
                    <div class="lc-instr-dropdown" id="lc-instr-dropdown"></div>
                </div>
                <span class="lc-instr-info" id="lc-instr-info"></span>

                <div class="lc-ctrl-sep"></div>

                <!-- Loop name -->
                <input type="text" class="lc-name-input" id="lc-name-input"
                    value="${this.escape(this.loopName || this.t('loopCreator.untitled'))}"
                    placeholder="${this.t('loopCreator.namePlaceholder')}" />

                <div class="lc-ctrl-sep"></div>

                <!-- Tempo -->
                <div class="lc-spinbox">
                    <button class="lc-spin-btn" data-action="tempo-dec">‹</button>
                    <input type="number" id="lc-tempo" class="lc-spin-input lc-spin-input--sm" value="${this.tempo}" min="20" max="300" step="1" />
                    <button class="lc-spin-btn" data-action="tempo-inc">›</button>
                </div>
                <span class="lc-unit">BPM</span>

                <!-- Time signature -->
                <select id="lc-timesig" class="lc-select lc-select-xs" title="${this.t('loopCreator.timeSignature')}">${timeSigHtml}</select>

                <!-- Bars -->
                <div class="lc-spinbox">
                    <button class="lc-spin-btn" data-action="bars-dec">‹</button>
                    <input type="number" id="lc-bars" class="lc-spin-input lc-spin-input--sm" value="${this.bars}" min="1" max="32" step="1" />
                    <button class="lc-spin-btn" data-action="bars-inc">›</button>
                </div>
                <span class="lc-unit" title="${this.t('loopCreator.bars')}">M</span>

                <!-- Snap -->
                <select id="lc-snap" class="lc-select lc-select-xs" title="${this.t('loopCreator.snap')}">
                    <option value="480">1/1</option><option value="240">1/2</option>
                    <option value="120" selected>1/4</option><option value="60">1/8</option>
                    <option value="30">1/16</option>
                </select>

                <div class="lc-ctrl-sep"></div>

                <!-- Playback controls -->
                <button class="lc-btn lc-btn-icon lc-btn-record" id="lc-record-btn" data-action="record" title="${this.t('loopCreator.record')}">
                    <span class="lc-rec-dot"></span>
                </button>
                <button class="lc-btn lc-btn-icon" data-action="preview" title="${this.t('loopCreator.preview')}">▶</button>
                <button class="lc-btn lc-btn-icon" data-action="stop-all" title="${this.t('loopCreator.stop')}">⏹</button>
                <span class="lc-rec-indicator hidden" id="lc-rec-indicator">
                    <span class="lc-rec-dot lc-rec-dot--pulse"></span>
                </span>

                <!-- Quantize -->
                <select id="lc-quantize" class="lc-select lc-select-xs" title="${this.t('loopCreator.quantize')}">
                    <option value="0">Q:—</option>
                    <option value="480">Q:1/1</option><option value="240">Q:1/2</option>
                    <option value="120" selected>Q:1/4</option><option value="60">Q:1/8</option>
                    <option value="30">Q:1/16</option>
                </select>

                <!-- MIDI In -->
                <select id="lc-midi-in-device" class="lc-select lc-select-midi" title="${this.t('loopCreator.midiIn')}">
                    <option value="">IN:—</option>
                </select>

                <div class="lc-ctrl-sep"></div>

                <!-- Edit tools -->
                <button class="lc-btn lc-btn-icon" data-action="mode-draw" id="lc-mode-draw" title="${this.t('loopCreator.modeDraw')}" aria-pressed="true">✏️</button>
                <button class="lc-btn lc-btn-icon" data-action="mode-select" id="lc-mode-select" title="${this.t('loopCreator.modeSelect')}" aria-pressed="false">⬚</button>
                <button class="lc-btn lc-btn-icon" data-action="select-all" title="${this.t('loopCreator.selectAll')}">⊞</button>
                <button class="lc-btn lc-btn-icon" data-action="delete-selected" title="${this.t('loopCreator.deleteSelected')}">✂</button>
                <button class="lc-btn lc-btn-icon" data-action="undo" title="${this.t('loopCreator.undo')}">↩</button>
                <button class="lc-btn lc-btn-icon" data-action="redo" title="${this.t('loopCreator.redo')}">↪</button>
                <button class="lc-btn lc-btn-icon" data-action="clear-notes" title="${this.t('loopCreator.clearNotes')}">🗑</button>

                <!-- Status (pushed right) -->
                <span class="lc-ctrl-spacer"></span>
                <span class="lc-status" id="lc-status"></span>
            </div>

            <!-- ── Piano roll + minimap ── -->
            <div class="lc-pianoroll-area">
                <div class="lc-pianoroll-wrap" id="lc-pianoroll-wrap"></div>
                <canvas class="lc-minimap" id="lc-minimap"></canvas>
            </div>

            <!-- ── Keyboard ── -->
            <div class="lc-keyboard-wrap">
                <div class="lc-keyboard" id="lc-keyboard">${this._buildKeyboardHtml(36, 84)}</div>
            </div>
        </div>`;
    }

    // =========================================================
    // RENDERING — TAB 2: LIBRARY
    // =========================================================

    _renderLibraryTab() {
        return `
        <div class="lc-pane lc-pane--hidden" id="lc-pane-library">
            <div class="lc-ctrl-bar lc-ctrl-bar--lib">
                <span class="lc-section-title">${this.t('loopCreator.library')}</span>
                <span class="lc-ctrl-spacer"></span>
                <button class="lc-btn lc-btn-primary lc-btn-sm" data-action="new-loop">+ ${this.t('loopCreator.newLoop')}</button>
            </div>
            <div class="lc-library-grid" id="lc-library-grid">
                <div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>
            </div>
        </div>`;
    }

    // =========================================================
    // RENDERING — TAB 3: ARRANGER
    // =========================================================

    _renderArrangerTab() {
        return `
        <div class="lc-pane lc-pane--hidden" id="lc-pane-arranger">
            <!-- ── Arranger toolbar ── -->
            <div class="lc-ctrl-bar lc-ctrl-bar--arr">
                <input type="text" class="lc-name-input" id="la-name-input"
                    value="${this.escape(this.arrangementName || this.t('loopCreator.untitledArrangement'))}"
                    placeholder="${this.t('loopCreator.arrangementName')}" />
                <div class="lc-ctrl-sep"></div>
                <div class="lc-spinbox">
                    <button class="lc-spin-btn" data-action="arr-tempo-dec">‹</button>
                    <input type="number" id="la-tempo" class="lc-spin-input lc-spin-input--sm" value="${this.arrangementTempo}" min="20" max="300" />
                    <button class="lc-spin-btn" data-action="arr-tempo-inc">›</button>
                </div>
                <span class="lc-unit">BPM</span>
                <div class="lc-spinbox">
                    <button class="lc-spin-btn" data-action="arr-bars-dec">‹</button>
                    <input type="number" id="la-bars" class="lc-spin-input lc-spin-input--sm" value="${this.arrangementBars}" min="4" max="256" step="4" />
                    <button class="lc-spin-btn" data-action="arr-bars-inc">›</button>
                </div>
                <span class="lc-unit" title="${this.t('loopCreator.totalBars')}">M</span>
                <div class="lc-ctrl-sep"></div>
                <button class="lc-btn lc-btn-icon" data-action="arr-play" id="la-play-btn" title="${this.t('loopCreator.play')}">▶</button>
                <button class="lc-btn lc-btn-icon" data-action="arr-stop" title="${this.t('loopCreator.stop')}">⏹</button>
                <button class="lc-btn lc-btn-icon" data-action="arr-add-track" title="${this.t('loopCreator.addTrack')}">＋</button>
                <button class="lc-btn" data-action="arr-new" title="${this.t('loopCreator.newArrangement')}">🆕</button>
            </div>

            <!-- ── Main area: sidebar + timeline ── -->
            <div class="la-area" id="la-area">
                <!-- Loop palette (drag source) -->
                <div class="la-palette" id="la-palette">
                    <div class="la-palette-title">${this.t('loopCreator.palette')}</div>
                    <div class="la-palette-grid" id="la-palette-grid">
                        <div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>
                    </div>
                </div>

                <!-- Timeline -->
                <div class="la-timeline-wrap" id="la-timeline-wrap">
                    <div class="la-ruler" id="la-ruler"></div>
                    <div class="la-tracks" id="la-tracks">
                        <!-- tracks inserted here -->
                    </div>
                </div>
            </div>

            <!-- Arrangement library -->
            <div class="la-arr-list-wrap">
                <div class="la-arr-list-title">${this.t('loopCreator.arrangements')}</div>
                <div class="la-arr-list" id="la-arr-list"></div>
            </div>
        </div>`;
    }

    // =========================================================
    // KEYBOARD HTML BUILDER
    // =========================================================

    _buildKeyboardHtml(startNote, endNote) {
        const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
        const whites = [], blacks = [];
        let wIdx = 0;
        for (let n = startNote; n <= endNote; n++) {
            const semi = n % 12;
            if (WHITE_SEMIS.includes(semi)) { whites.push({ n, wi: wIdx++ }); }
        }
        let wi2 = 0;
        for (let n = startNote; n <= endNote; n++) {
            const semi = n % 12;
            if (WHITE_SEMIS.includes(semi)) wi2++;
            else blacks.push({ n, li: wi2 - 1 });
        }
        const ww = 100 / whites.length;
        const wKeys = whites.map(({ n, wi }) =>
            `<div class="lc-key lc-key-white" data-note="${n}" style="left:${wi*ww}%;width:${ww}%"></div>`
        ).join('');
        const bKeys = blacks.map(({ n, li }) => {
            const bw = ww * 0.58;
            return `<div class="lc-key lc-key-black" data-note="${n}" style="left:${li*ww+ww*0.71}%;width:${bw}%"></div>`;
        }).join('');
        return wKeys + bKeys;
    }

    // =========================================================
    // LIFECYCLE
    // =========================================================

    onOpen() {
        this._initSynth();
        this._attachEvents();
        this._initPianoRoll();
        this._loadDevices();
        this._loadLibrary();
        document.addEventListener('mouseup', this._boundDocMouseUp);
        document.addEventListener('mousemove', this._boundDocMouseMove);
    }

    onClose() {
        this._stopAll();
        this._stopArrangerPlay();
        this._stopMidiInMonitor();
        document.removeEventListener('mouseup', this._boundDocMouseUp);
        document.removeEventListener('mousemove', this._boundDocMouseMove);
        if (this._minimapObserver) {
            this._minimapObserver.disconnect();
            this._minimapObserver = null;
        }
        this._minimapCanvas = null;
    }

    // =========================================================
    // TAB SWITCHING
    // =========================================================

    _switchTab(tab) {
        this.activeTab = tab;
        this.$$('.lc-tab').forEach(btn => {
            const active = btn.dataset.tab === tab;
            btn.classList.toggle('lc-tab--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        this.$$('.lc-pane').forEach(pane => {
            pane.classList.toggle('lc-pane--hidden', !pane.id.endsWith(tab));
        });
        // Update header save button
        const saveBtn = this.$('#lc-header-save');
        if (saveBtn) {
            if (tab === 'create') {
                saveBtn.dataset.action = 'save-loop';
                saveBtn.textContent = '';
                saveBtn.innerHTML = `💾 ${this.t('loopCreator.save')}`;
                saveBtn.style.display = '';
            } else if (tab === 'arranger') {
                saveBtn.dataset.action = 'save-arrangement';
                saveBtn.innerHTML = `💾 ${this.t('loopCreator.saveArrangement')}`;
                saveBtn.style.display = '';
            } else {
                saveBtn.style.display = 'none';
            }
        }
        if (tab === 'library')  this._renderLibrary();
        if (tab === 'arranger') this._initArrangerTab();
    }

    // =========================================================
    // EVENTS
    // =========================================================

    _attachEvents() {
        this.dialog.addEventListener('click', (e) => this._onClick(e));
        this.dialog.addEventListener('change', (e) => this._onChange(e));
        this.dialog.addEventListener('input',  (e) => this._onInput(e));

        const kb = this.$('#lc-keyboard');
        if (kb) {
            kb.addEventListener('mousedown', (e) => this._onKeyMouseDown(e));
            kb.addEventListener('mouseover', (e) => this._onKeyMouseOver(e));
            kb.addEventListener('touchstart', (e) => { e.preventDefault(); this._onKeyTouchStart(e); }, { passive: false });
            kb.addEventListener('touchmove',  (e) => { e.preventDefault(); this._onKeyTouchMove(e);  }, { passive: false });
            kb.addEventListener('touchend',   (e) => this._onKeyTouchEnd(e));
        }
    }

    _onClick(e) {
        // Close instrument picker on click outside it
        if (!e.target.closest('#lc-instr-picker')) this._closeInstrPicker();

        // Tab switching — .lc-tab buttons carry data-tab, not data-action
        const tabBtn = e.target.closest('.lc-tab[data-tab]');
        if (tabBtn) { this._switchTab(tabBtn.dataset.tab); return; }

        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const a = btn.dataset.action;
        switch (a) {
            // Creator
            case 'instr-picker-toggle': this._toggleInstrPicker(); break;
            case 'tempo-dec':    this._adjustTempo(-1);    break;
            case 'tempo-inc':    this._adjustTempo(+1);    break;
            case 'bars-dec':     this._adjustBars(-1);     break;
            case 'bars-inc':     this._adjustBars(+1);     break;
            case 'mode-draw':       this._setEditMode('dragpoly'); break;
            case 'mode-select':     this._setEditMode('select');   break;
            case 'select-all':      this._selectAll();             break;
            case 'delete-selected': this._deleteSelected();        break;
            case 'undo':            this.pianoRoll?.undo?.();  break;
            case 'redo':            this.pianoRoll?.redo?.();  break;
            case 'clear-notes':     this._clearNotes();        break;
            case 'record':       this._toggleRecording();  break;
            case 'preview':      this._previewLoop();       break;
            case 'stop-all':     this._stopAll();           break;
            case 'save-loop':    this._saveLoop();          break;
            case 'new-loop':     this._newLoop();           break;
            // Arranger
            case 'arr-tempo-dec':  this._adjustArrTempo(-1); break;
            case 'arr-tempo-inc':  this._adjustArrTempo(+1); break;
            case 'arr-bars-dec':   this._adjustArrBars(-4);  break;
            case 'arr-bars-inc':   this._adjustArrBars(+4);  break;
            case 'arr-add-track':  this._addTrack();          break;
            case 'arr-play':       this._playArrangement();   break;
            case 'arr-stop':       this._stopArrangerPlay();  break;
            case 'arr-new':        this._newArrangement();    break;
            case 'save-arrangement': this._saveArrangement(); break;
            case 'close': this.close(); break;
        }
    }

    _onChange(e) {
        const id = e.target.id;
        if (id === 'lc-timesig') {
            const [num, den] = e.target.value.split(':').map(Number);
            this.timeSigNum = num; this.timeSigDen = den;
            this._refreshPianoRollRange();
        } else if (id === 'lc-snap') {
            if (this.pianoRoll) { this.pianoRoll.snap = parseInt(e.target.value); }
        } else if (id === 'lc-midi-in-device') {
            this._midiInDevice = e.target.value || null;
        }
    }

    _onInput(e) {
        const id = e.target.id;
        if (id === 'lc-tempo')    { const v = parseInt(e.target.value); if (v>=20&&v<=300) { this.tempo=v; this._refreshPianoRollRange(); } }
        if (id === 'lc-bars')     { const v = parseInt(e.target.value); if (v>=1&&v<=32)   { this.bars=v;  this._refreshPianoRollRange(); } }
        if (id === 'lc-name-input') this.loopName = e.target.value;
        if (id === 'la-name-input') this.arrangementName = e.target.value;
        if (id === 'la-tempo')    { const v = parseInt(e.target.value); if (v>=20&&v<=300) this.arrangementTempo=v; }
        if (id === 'la-bars')     { const v = parseInt(e.target.value); if (v>=4&&v<=256)  { this.arrangementBars=v; this._renderTimeline(); } }
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
        this.pianoRoll.setAttribute('xrange',   total.toString());
        this.pianoRoll.setAttribute('yrange',   yrange0.toString());
        this.pianoRoll.setAttribute('yoffset',  this.outputNoteMin.toString());
        this.pianoRoll.setAttribute('wheelzoom','1');
        this.pianoRoll.setAttribute('xscroll',  '1');
        this.pianoRoll.setAttribute('yscroll',  '1');
        this.pianoRoll.setAttribute('xruler',   '1');
        this.pianoRoll.setAttribute('cursor',   '0');
        this.pianoRoll.setAttribute('markstart','0');
        this.pianoRoll.setAttribute('markend',  total.toString());
        this.pianoRoll.setAttribute('snap',     '120');
        this.pianoRoll.setAttribute('timebase', this.ppq.toString());
        this.pianoRoll.setAttribute('tempo',    this.tempo.toString());
        this.pianoRoll.setAttribute('colcursor', '#e74c3c');
        this._applyPianoRollTheme();
        container.appendChild(this.pianoRoll);
        this.pianoRoll.sequence = this.sequence;
        this.pianoRoll.redraw?.();
        this._initMinimap();
    }

    _applyPianoRollTheme() {
        if (!this.pianoRoll) return;
        const dark = document.body.classList.contains('theme-dark');
        this.pianoRoll.setAttribute('colnote',    dark ? '#5b9bd5' : '#4a90d9');
        this.pianoRoll.setAttribute('colnotesel', dark ? '#f5a623' : '#e8931a');
        this.pianoRoll.setAttribute('colbg',      dark ? '#1a1a2e' : '#f8f9fa');
        this.pianoRoll.setAttribute('colline',    dark ? '#333355' : '#dde0e6');
        this.pianoRoll.setAttribute('colrulerbg', dark ? '#12122a' : '#eef0f4');
        this.pianoRoll.setAttribute('colrulerfg', dark ? '#8888aa' : '#666677');
        this.pianoRoll.setAttribute('colkeybg',   dark ? '#1e1e38' : '#f0f0f4');
        this.pianoRoll.setAttribute('colkeyfg',   dark ? '#ccccee' : '#333344');
        this.pianoRoll.setAttribute('colkeyblack',dark ? '#0d0d1a' : '#303040');
    }

    _totalTicks()  { return this.ppq * this.timeSigNum * this.bars; }

    _refreshPianoRollRange() {
        if (!this.pianoRoll) return;
        const total = this._totalTicks();
        this.pianoRoll.setAttribute('xrange',   total.toString());
        this.pianoRoll.setAttribute('markend',  total.toString());
        this.pianoRoll.setAttribute('timebase', this.ppq.toString());
        this.pianoRoll.setAttribute('tempo',    this.tempo.toString());
        // Adapt Y axis to instrument note range
        const noteSpan = this.outputNoteMax - this.outputNoteMin;
        const yrange = Math.min(noteSpan + 1, 36);  // show at most 3 octaves at once
        this.pianoRoll.setAttribute('yrange',   yrange.toString());
        this.pianoRoll.setAttribute('yoffset',  this.outputNoteMin.toString());
        this.pianoRoll.redraw?.();
        this._drawMinimap();
    }

    _adjustTempo(d) {
        this.tempo = Math.max(20, Math.min(300, this.tempo + d));
        const el = this.$('#lc-tempo'); if (el) el.value = this.tempo;
        this._refreshPianoRollRange();
    }

    _adjustBars(d) {
        this.bars = Math.max(1, Math.min(32, this.bars + d));
        const el = this.$('#lc-bars'); if (el) el.value = this.bars;
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
        if (this.pianoRoll) { this.pianoRoll.sequence = []; this.pianoRoll.redraw?.(); }
        this._drawMinimap();
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
        const seq = (this.pianoRoll.sequence || []).filter(note => !note.f);
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
        this._drawMinimap();
    }

    _startPlayheadAnimation() {
        if (this._playheadRAF) return;
        this._playheadStartTime = performance.now();
        const animate = () => {
            if (!this.isPlaying) {
                this._playheadRAF = null;
                return;
            }
            if (this.pianoRoll) {
                const elapsed = (performance.now() - this._playheadStartTime) / 1000;
                const tick = Math.round(elapsed * (this.tempo / 60) * this.ppq);
                this.pianoRoll.cursor = Math.min(tick, this._totalTicks());
                this.pianoRoll.redrawMarker?.();
            }
            this._drawMinimap();
            this._playheadRAF = requestAnimationFrame(animate);
        };
        this._playheadRAF = requestAnimationFrame(animate);
    }

    _stopPlayheadAnimation() {
        if (this._playheadRAF) {
            cancelAnimationFrame(this._playheadRAF);
            this._playheadRAF = null;
        }
        if (this.pianoRoll) {
            this.pianoRoll.cursor = 0;
            this.pianoRoll.redrawMarker?.();
        }
        this._drawMinimap();
    }

    // =========================================================
    // MINIMAP
    // =========================================================

    _initMinimap() {
        const canvas = this.$('#lc-minimap');
        if (!canvas) return;
        this._minimapCanvas = canvas;

        const resize = () => {
            canvas.width  = canvas.offsetWidth  || 900;
            canvas.height = canvas.offsetHeight || 44;
            this._drawMinimap();
        };
        resize();

        // Observe piano roll attribute changes to sync viewport rect
        if (this.pianoRoll) {
            this._minimapObserver = new MutationObserver(() => this._drawMinimap());
            this._minimapObserver.observe(this.pianoRoll, {
                attributes: true, attributeFilter: ['xoffset', 'yoffset']
            });
        }

        // Redraw minimap when user scrolls the piano roll
        const wrap = this.$('#lc-pianoroll-wrap');
        if (wrap) {
            wrap.addEventListener('wheel', () => requestAnimationFrame(() => this._drawMinimap()), { passive: true });
        }

        // Click / drag to seek
        const onSeek = (e) => {
            if (!this._minimapDragging) return;
            this._minimapSeek(e);
        };
        canvas.addEventListener('mousedown', (e) => { this._minimapDragging = true; this._minimapSeek(e); });
        canvas.addEventListener('mousemove', onSeek);
        canvas.addEventListener('mouseup',   () => { this._minimapDragging = false; });
        canvas.addEventListener('mouseleave',() => { this._minimapDragging = false; });

        // Touch support
        canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._minimapDragging = true;
            this._minimapSeek(e.touches[0]);
        }, { passive: false });
        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (this._minimapDragging) this._minimapSeek(e.touches[0]);
        }, { passive: false });
        canvas.addEventListener('touchend', () => { this._minimapDragging = false; });
    }

    _minimapSeek(e) {
        if (!this._minimapCanvas || !this.pianoRoll) return;
        const rect = this._minimapCanvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const totalTicks = this._totalTicks();
        const xrange = parseFloat(this.pianoRoll.getAttribute('xrange') || totalTicks) || totalTicks;
        const half = xrange / 2;
        const newOffset = Math.max(0, Math.min(totalTicks - xrange, Math.round(ratio * totalTicks - half)));
        this.pianoRoll.setAttribute('xoffset', newOffset.toString());
        this.pianoRoll.redraw?.();
        this._drawMinimap();
    }

    _drawMinimap() {
        const canvas = this._minimapCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        const totalTicks = this._totalTicks();
        const dark = document.body.classList.contains('theme-dark');

        // Background
        ctx.fillStyle = dark ? '#0f0f22' : '#eef0f4';
        ctx.fillRect(0, 0, W, H);

        // Beat lines (subtle)
        const ticksPerBeat = this.ppq;
        const ticksPerBar  = ticksPerBeat * this.timeSigNum;
        ctx.lineWidth = 1;
        for (let t = 0; t < totalTicks; t += ticksPerBeat) {
            const x = (t / totalTicks) * W;
            const isBar = (t % ticksPerBar) === 0;
            ctx.strokeStyle = isBar
                ? (dark ? 'rgba(150,150,220,0.35)' : 'rgba(100,110,140,0.3)')
                : (dark ? 'rgba(100,100,180,0.12)' : 'rgba(160,170,200,0.15)');
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }

        // Bar number labels
        ctx.fillStyle = dark ? 'rgba(180,180,220,0.5)' : 'rgba(100,110,140,0.55)';
        ctx.font = `${Math.min(10, H * 0.27)}px sans-serif`;
        ctx.textBaseline = 'top';
        for (let b = 0; b < this.bars; b++) {
            const x = (b * ticksPerBar / totalTicks) * W;
            ctx.fillText(b + 1, x + 2, 2);
        }

        // Notes
        const seq = this.pianoRoll?.sequence ?? [];
        const noteMin = this.outputNoteMin;
        const noteMax = this.outputNoteMax;
        const noteSpan = Math.max(noteMax - noteMin, 1);
        const noteH = Math.max(2, H * 0.08);
        const noteArea = H * 0.78; // use 78% of height for notes, top reserved for labels

        ctx.fillStyle = dark ? '#5b9bd5' : '#4a90d9';
        for (const note of seq) {
            const x = (note.t / totalTicks) * W;
            const w = Math.max(2, ((note.g || note.l || 120) / totalTicks) * W);
            const ny = H * 0.18 + noteArea - ((note.n - noteMin) / noteSpan) * noteArea;
            ctx.fillRect(x, ny - noteH, w, noteH);
        }

        // Viewport rect (which portion of the loop is visible in the piano roll)
        if (this.pianoRoll) {
            const xoff   = parseFloat(this.pianoRoll.getAttribute('xoffset') || 0);
            const xrange = parseFloat(this.pianoRoll.getAttribute('xrange')  || totalTicks);
            const vx = (xoff / totalTicks) * W;
            const vw = Math.min(W, (xrange / totalTicks) * W);
            ctx.fillStyle = 'rgba(74,144,217,0.12)';
            ctx.fillRect(vx, 0, vw, H);
            ctx.strokeStyle = 'rgba(74,144,217,0.7)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(vx + 0.5, 0.5, Math.max(2, vw - 1), H - 1);
        }

        // Playhead
        const cursor = this.pianoRoll?.cursor ?? 0;
        if (cursor > 0 || this.isPlaying) {
            const px = (cursor / totalTicks) * W;
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
        }
    }

    // =========================================================
    // KEYBOARD (mini piano)
    // =========================================================

    _noteFromEl(el) { const k = el?.closest?.('.lc-key'); return k ? parseInt(k.dataset.note) : null; }

    _onKeyMouseDown(e) {
        const n = this._noteFromEl(e.target);
        if (n == null) return;
        e.preventDefault(); this._mouseDownNote = n; this._playNote(n);
    }
    _onKeyMouseOver(e) {
        if (this._mouseDownNote == null) return;
        const n = this._noteFromEl(e.target);
        if (n == null || n === this._mouseDownNote) return;
        this._stopNote(this._mouseDownNote); this._mouseDownNote = n; this._playNote(n);
    }
    _onDocMouseUp() {
        if (this._mouseDownNote != null) { this._stopNote(this._mouseDownNote); this._mouseDownNote = null; }
    }
    _onKeyTouchStart(e) {
        for (const t of e.changedTouches) {
            const n = this._noteFromEl(document.elementFromPoint(t.clientX, t.clientY));
            if (n != null) this._playNote(n);
        }
    }
    _onKeyTouchMove(e) {
        for (const t of e.changedTouches) {
            const n = this._noteFromEl(document.elementFromPoint(t.clientX, t.clientY));
            if (n != null && !this._activeKeys.has(n)) this._playNote(n);
        }
    }
    _onKeyTouchEnd(e) {
        for (const t of e.changedTouches) {
            const n = this._noteFromEl(document.elementFromPoint(t.clientX, t.clientY));
            if (n != null) this._stopNote(n);
        }
    }

    _playNote(note) {
        if (this._activeKeys.has(note)) return;
        this._activeKeys.add(note);
        this._highlightKey(note, true);
        if (this.outputMode === 'device' && this.outputDeviceId) {
            this.api.sendCommand('midi_send_note', {
                deviceId: this.outputDeviceId, channel: this.outputChannel, note, velocity: 80
            }).catch(() => {});
        } else if (this._synth) {
            try {
                const env = this._synth.playNote(note, 80, 0, 60);
                if (env) this._activeKeyEnvelopes.set(note, env);
            } catch (_) {}
        }
        if (this.isRecording) {
            const elapsed = (performance.now() - this.recordStartTime) / 1000;
            const tick = Math.round(elapsed * (this.tempo / 60) * this.ppq);
            this.recordedNotes.push({ note, tick, startMs: performance.now() });
        }
    }

    _stopNote(note) {
        this._activeKeys.delete(note);
        this._highlightKey(note, false);
        if (this.outputMode === 'device' && this.outputDeviceId) {
            this.api.sendCommand('midi_send_note', {
                deviceId: this.outputDeviceId, channel: this.outputChannel, note, velocity: 0
            }).catch(() => {});
        } else {
            const env = this._activeKeyEnvelopes.get(note);
            if (env) {
                try { env.forEach(e => e.cancel()); } catch (_) {}
                this._activeKeyEnvelopes.delete(note);
            }
        }
        if (this.isRecording) this._finalizeNoteOff(note);
    }

    _highlightKey(note, on) {
        this.dialog?.querySelector(`.lc-key[data-note="${note}"]`)?.classList.toggle('lc-key--active', on);
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
        this._addNoteToRoll({ t, n: note, v: 80, g });
    }

    _addNoteToRoll(noteObj) {
        if (!this.pianoRoll) return;
        const seq = Array.isArray(this.pianoRoll.sequence) ? [...this.pianoRoll.sequence] : [];
        seq.push(noteObj);
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
        this._drawMinimap();
    }

    // =========================================================
    // RECORDING + MIDI IN (P3)
    // =========================================================

    _toggleRecording() {
        this.isRecording ? this._stopRecording() : this._startRecording();
    }

    _startRecording() {
        this.isRecording = true;
        this.recordedNotes = [];
        this.recordStartTime = performance.now();

        this.$('#lc-record-btn')?.classList.add('lc-btn-record--active');
        this.$('#lc-rec-indicator')?.classList.remove('hidden');

        // Enable MIDI In monitor if a device is selected
        if (this._midiInDevice) this._startMidiInMonitor();
        this._setStatus(this.t('loopCreator.statusRecording'));
    }

    _stopRecording() {
        this.isRecording = false;
        // Close still-open notes
        for (const rec of [...this.recordedNotes]) this._finalizeNoteOff(rec.note);
        this.recordedNotes = [];

        this.$('#lc-record-btn')?.classList.remove('lc-btn-record--active');
        this.$('#lc-rec-indicator')?.classList.add('hidden');

        this._stopMidiInMonitor();
        this._setStatus(this.t('loopCreator.statusRecordingDone'));
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
                if (type === 'noteon' && vel > 0) {
                    this._playNote(note);
                } else if (type === 'noteoff' || (type === 'noteon' && vel === 0)) {
                    this._stopNote(note);
                }
            };
            this.api.on('monitor_event', this._midiInHandler);
        } catch (_) {}
    }

    async _stopMidiInMonitor() {
        if (!this._monitorActive) return;
        this._monitorActive = false;
        if (this._midiInHandler) {
            this.api.off?.('monitor_event', this._midiInHandler);
            this._midiInHandler = null;
        }
        if (this._midiInDevice) {
            try { await this.api.sendCommand('monitor_stop', { deviceId: this._midiInDevice }); } catch (_) {}
        }
    }

    async _loadDevices() {
        // Step 1 — raw device list + capabilities in parallel
        let rawDevices = [];
        let capsResp   = null;
        try {
            const result = await this.api.sendCommand('device_list');
            rawDevices = result.devices || [];
        } catch (err) {
            console.error('[LoopCreator] device_list failed:', err);
        }
        try {
            capsResp = await this.api.sendCommand('instrument_list_capabilities');
        } catch (_) {}

        console.log('[LoopCreator] raw devices:', rawDevices.length, rawDevices.map(d => `${d.name}(status=${d.status},connected=${d.connected})`));

        // Step 2 — active devices: status===2 OR connected flag (CalibrationModal pattern)
        const activeDevices = rawDevices.filter(d => d.status === 2 || d.connected === true);
        console.log('[LoopCreator] active devices:', activeDevices.length);

        // Step 3 — deduplicate by ID
        const uniqueDevices = [];
        const seenIds = new Set();
        for (const d of activeDevices) {
            const key = d.id || d.device_id || d.name;
            if (!seenIds.has(key)) { seenIds.add(key); uniqueDevices.push(d); }
        }

        // Step 4 — expand multi-instrument devices (one entry per instrument/channel)
        const expanded = [];
        for (const d of uniqueDevices) {
            if (Array.isArray(d.instruments) && d.instruments.length > 0) {
                for (const inst of d.instruments) {
                    expanded.push({
                        ...d,
                        channel: inst.channel ?? 0,
                        displayName: inst.custom_name || inst.name || d.displayName || d.name,
                        gm_program: inst.gm_program ?? d.gm_program,
                        _multiInstrument: true
                    });
                }
            } else {
                expanded.push(d);
            }
        }

        // Step 5 — virtual instruments from DB (if enabled in settings)
        let virtualEnabled = false;
        try {
            const s = localStorage.getItem('gmboop_settings');
            if (s) virtualEnabled = !!JSON.parse(s).virtualInstrument;
        } catch (_) {}
        if (virtualEnabled && capsResp?.instruments) {
            const existingIds = new Set(expanded.map(d => d.id || d.device_id));
            for (const inst of capsResp.instruments) {
                const devId = inst.device_id || inst.id;
                if (devId && devId.startsWith('virtual_') && !existingIds.has(devId)) {
                    expanded.push({
                        id: devId, device_id: devId,
                        name: `🖥️ ${inst.custom_name || inst.name || 'Virtual'}`,
                        displayName: `🖥️ ${inst.custom_name || inst.name || 'Virtual'}`,
                        status: 2, connected: true, isVirtual: true,
                        channel: inst.channel || 0,
                        gm_program: inst.gm_program
                    });
                }
            }
        }

        // Step 6 — enrich custom names + normalize id/device_id
        const customNameMap = {};
        if (capsResp?.instruments) {
            for (const inst of capsResp.instruments) {
                const id = inst.device_id || inst.id;
                if (id && inst.custom_name && !customNameMap[id]) customNameMap[id] = inst.custom_name;
            }
        }
        this.devices = expanded.map(d => {
            const did = d.id || d.device_id;
            if (d.isVirtual || d._multiInstrument) return { ...d, id: did, device_id: did };
            return { ...d, id: did, device_id: did, displayName: customNameMap[did] || d.displayName || d.name };
        });

        console.log('[LoopCreator] final instruments:', this.devices.length, this.devices.map(d => d.displayName || d.name));

        // Update MIDI In selector
        const midiInSel = this.$('#lc-midi-in-device');
        if (midiInSel) {
            const prev = midiInSel.value;
            midiInSel.innerHTML = `<option value="">IN:—</option>` +
                this.devices.map(d => {
                    const did = d.device_id || d.id;
                    return `<option value="${this.escape(did)}">IN: ${this.escape(d.displayName || d.name || did)}</option>`;
                }).join('');
            if (prev) midiInSel.value = prev;
        }

        // Refresh instrument picker
        this._populateInstrumentSelector();
    }

    _populateInstrumentSelector() {
        this._buildInstrDropdown();
        this._updateInstrTrigger();
    }

    _buildInstrDropdown() {
        const dropdown = this.$('#lc-instr-dropdown');
        console.log('[LoopCreator] _buildInstrDropdown: dropdown found=', !!dropdown, '| devices=', this.devices.length);
        if (!dropdown) return;
        dropdown.innerHTML = '';

        // Synth option
        const synthBtn = document.createElement('button');
        synthBtn.type = 'button';
        synthBtn.className = 'lc-instr-option' + (this.outputMode === 'synth' ? ' selected' : '');
        synthBtn.innerHTML = `<div class="lc-instr-opt-icon"><span class="lc-instr-opt-emoji">🎹</span></div>
            <span class="lc-instr-opt-name">${this.t('loopCreator.synthVirtual')}</span>`;
        synthBtn.addEventListener('click', () => { this._onInstrumentSelect('synth'); });
        dropdown.appendChild(synthBtn);

        // MIDI device options — devices are already expanded (1 entry per instrument)
        for (const device of this.devices) {
            const did = device.device_id || device.id;
            const name = device.displayName || device.name || String(did);
            const ch = device.channel ?? 0;
            const value = `device::${did}::${ch}`;
            const isSelected = this.outputMode === 'device' && this.outputDeviceId === did && this.outputChannel === ch;
            const chLabel = device._multiInstrument ? `Ch${ch + 1}` : '';
            console.log('[LoopCreator]   → adding option:', name, '| did:', did, '| value:', value);
            try {
                const btn = this._buildInstrOption(value, name, chLabel, isSelected, device.gm_program, ch);
                dropdown.appendChild(btn);
            } catch (err) {
                console.error('[LoopCreator]   ✗ error building option for', name, err);
            }
        }
        console.log('[LoopCreator] dropdown.children.length =', dropdown.children.length);
    }

    _buildInstrOption(value, name, chLabel, isSelected, gmProgram, channel) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lc-instr-option' + (isSelected ? ' selected' : '');
        const icon = window.InstrumentFamilies?.resolveInstrumentIcon?.({ gmProgram, channel }) || { svgUrl: null, emoji: '🎵' };
        const imgHtml = icon.svgUrl
            ? `<img src="${icon.svgUrl}" alt="" class="lc-instr-opt-svg" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span class="lc-instr-opt-emoji" style="display:none">${icon.emoji}</span>`
            : `<span class="lc-instr-opt-emoji">${icon.emoji}</span>`;
        btn.innerHTML = `<div class="lc-instr-opt-icon">${imgHtml}</div>
            <span class="lc-instr-opt-name">${this.escape(name)}</span>
            <span class="lc-instr-opt-ch">${chLabel}</span>`;
        btn.addEventListener('click', () => { this._onInstrumentSelect(value); });
        return btn;
    }

    _updateInstrTrigger() {
        const emoji = this.$('#lc-instr-emoji');
        const svg   = this.$('#lc-instr-svg');
        const nameEl = this.$('#lc-instr-name');
        if (!nameEl) return;

        if (this.outputMode !== 'device' || !this.outputDeviceId) {
            if (svg)   { svg.style.display = 'none'; }
            if (emoji) { emoji.textContent = '🎹'; emoji.style.display = ''; }
            nameEl.textContent = this.t('loopCreator.synthVirtual');
            return;
        }

        const device = this.devices.find(d => (d.device_id || d.id) === this.outputDeviceId);
        const icon = window.InstrumentFamilies?.resolveInstrumentIcon?.({ gmProgram: device?.gm_program, channel: this.outputChannel })
            || { svgUrl: null, emoji: '🎵' };

        if (icon.svgUrl && svg) {
            svg.src = icon.svgUrl;
            svg.style.display = '';
            svg.onerror = () => {
                svg.style.display = 'none';
                if (emoji) { emoji.textContent = icon.emoji; emoji.style.display = ''; }
            };
            if (emoji) emoji.style.display = 'none';
        } else {
            if (svg)   svg.style.display = 'none';
            if (emoji) { emoji.textContent = icon.emoji; emoji.style.display = ''; }
        }
        nameEl.textContent = (device?.displayName || device?.name || device?.device_id || this.outputDeviceId) + ` — Ch${this.outputChannel + 1}`;
    }

    _toggleInstrPicker() {
        const picker = this.$('#lc-instr-picker');
        if (!picker) return;
        const opening = !picker.classList.contains('open');
        if (opening) {
            this._buildInstrDropdown();
            picker.classList.add('open');
        } else {
            picker.classList.remove('open');
        }
    }

    _closeInstrPicker() {
        this.$('#lc-instr-picker')?.classList.remove('open');
    }

    async _onInstrumentSelect(value) {
        this._stopAll();
        this._closeInstrPicker();
        if (value === 'synth' || !value) {
            this.outputMode = 'synth';
            this.outputDeviceId = null;
            this.outputChannel = 0;
            this.outputNoteMin = 36;
            this.outputNoteMax = 84;
            this.outputGmProgram = 0;
            this._updateInstrTrigger();
            this._setInstrumentInfo('');
            this._rebuildKeyboard();
            return;
        }
        // value = "device::deviceId::channel"
        const parts = value.split('::');
        const deviceId = parts[1];
        const channel = parseInt(parts[2] ?? 0);
        this.outputMode = 'device';
        this.outputDeviceId = deviceId;
        this.outputChannel = channel;

        // Use note range from device_list if available, else fetch capabilities
        const device = this.devices.find(d => (d.device_id || d.id) === deviceId);
        let noteMin = device?.note_range_min ?? null;
        let noteMax = device?.note_range_max ?? null;
        let gmProgram = device?.gm_program ?? 0;

        if (noteMin == null || noteMax == null) {
            try {
                const r = await this.api.sendCommand('instrument_get_capabilities', { deviceId, channel });
                const caps = r.capabilities || {};
                noteMin = caps.note_range_min ?? 21;
                noteMax = caps.note_range_max ?? 108;
                gmProgram = caps.gm_program ?? gmProgram;
            } catch (_) {
                noteMin = 21;
                noteMax = 108;
            }
        }

        this.outputNoteMin = noteMin;
        this.outputNoteMax = noteMax;
        this.outputGmProgram = gmProgram;

        const infoText = `${this._midiNoteToName(noteMin)} – ${this._midiNoteToName(noteMax)}`;
        this._updateInstrTrigger();
        this._setInstrumentInfo(infoText);
        this._rebuildKeyboard();
        this._refreshPianoRollRange();
    }

    _rebuildKeyboard() {
        const kb = this.$('#lc-keyboard');
        if (!kb) return;
        kb.innerHTML = this._buildKeyboardHtml(this.outputNoteMin, this.outputNoteMax);
    }

    _setInstrumentInfo(text) {
        const el = this.$('#lc-instr-info');
        if (el) el.textContent = text;
    }

    _midiNoteToName(midi) {
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        return names[midi % 12] + (Math.floor(midi / 12) - 1);
    }

    // =========================================================
    // PREVIEW PLAYBACK
    // =========================================================

    _initSynth() {
        if (typeof MidiSynthesizer !== 'undefined') {
            try {
                this._synth = new MidiSynthesizer();
                this._synth.setChannelInstrument(0, this.instrumentProgram);
            } catch (_) {}
        }
    }

    _previewLoop() {
        this._stopAll();
        const seq = this.pianoRoll?.sequence ?? [];
        if (!seq.length) { this._setStatus(this.t('loopCreator.statusNoNotes')); return; }
        if (this.outputMode === 'device' && this.outputDeviceId) {
            this._previewViaDevice(seq); return;
        }
        if (!this._synth) { this._setStatus(this.t('loopCreator.statusNoSynth')); return; }
        this.isPlaying = true;
        this._setStatus(this.t('loopCreator.statusPlaying'));
        this._startPlayheadAnimation();
        this._synth.loadSequence(seq, this.tempo, this.ppq);
        this._synth.play().then(() => {
            if (this.isPlaying) { this.isPlaying = false; this._stopPlayheadAnimation(); this._setStatus(''); }
        }).catch(() => { this.isPlaying = false; this._stopPlayheadAnimation(); this._setStatus(''); });
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
                }).catch(() => {});
            }, onMs));
            this._playbackTimers.push(setTimeout(() => {
                if (!this.isPlaying) return;
                this.api.sendCommand('midi_send_note', {
                    deviceId: this.outputDeviceId, channel: this.outputChannel,
                    note: note.n, velocity: 0
                }).catch(() => {});
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
        try { this._synth?.stop?.(); } catch (_) {}
        try { this._synth?.cancelAllNotes?.(); } catch (_) {}
        this._activeKeyEnvelopes.clear();
        if (this.outputMode === 'device' && this.outputDeviceId) {
            for (const n of this._activeKeys) {
                this.api.sendCommand('midi_send_note', {
                    deviceId: this.outputDeviceId, channel: this.outputChannel, note: n, velocity: 0
                }).catch(() => {});
            }
        }
        this.$$('.lc-key--active').forEach(k => k.classList.remove('lc-key--active'));
        this._activeKeys.clear();
        this._setStatus('');
    }

    // =========================================================
    // SAVE / LOAD — LOOPS
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
            this._setStatus(this.t('loopCreator.statusSaved'));
            await this._loadLibrary();
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _loadLibrary() {
        try {
            const r = await this.api.sendCommand('loop_list');
            this.library = r.loops || [];
            if (this.activeTab === 'library') this._renderLibrary();
            this._renderPalette();
        } catch (_) {}
    }

    _renderLibrary() {
        const grid = this.$('#lc-library-grid');
        if (!grid) return;
        if (!this.library.length) {
            grid.innerHTML = `<div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>`;
            return;
        }
        grid.innerHTML = this.library.map(loop => this._loopCardHtml(loop, true)).join('');
        if (!grid.dataset.lcWired) {
            grid.dataset.lcWired = '1';
            grid.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-loop-action]');
                if (!btn) return;
                const id = parseInt(btn.dataset.loopId);
                if (btn.dataset.loopAction === 'load')   { this._loadLoopById(id); this._switchTab('create'); }
                if (btn.dataset.loopAction === 'delete') this._deleteLoopById(id);
            });
        }
    }

    _loopCardHtml(loop, showActions = false) {
        const active = loop.id === this.currentLoopId ? ' lc-card--active' : '';
        const ts = `${loop.time_sig_num}/${loop.time_sig_den}`;
        const actions = showActions ? `
            <div class="lc-card-actions">
                <button class="lc-card-btn" data-loop-action="load" data-loop-id="${loop.id}" title="${this.t('loopCreator.loadLoop')}">✏️</button>
                <button class="lc-card-btn lc-card-btn--danger" data-loop-action="delete" data-loop-id="${loop.id}" title="${this.t('loopCreator.deleteLoop')}">🗑</button>
            </div>` : '';
        return `<div class="lc-card${active}" data-loop-id="${loop.id}">
            <div class="lc-card-name">${this.escape(loop.name)}</div>
            <div class="lc-card-meta">${loop.tempo} BPM · ${ts} · ${loop.bars} ${this.t('loopCreator.barsUnit')}</div>
            ${actions}
        </div>`;
    }

    async _loadLoopById(id) {
        try {
            const r = await this.api.sendCommand('loop_get', { loopId: id });
            const loop = r.loop; if (!loop) return;
            this.currentLoopId   = loop.id;
            this.loopName        = loop.name;
            this.tempo           = loop.tempo;
            this.timeSigNum      = loop.time_sig_num;
            this.timeSigDen      = loop.time_sig_den;
            this.bars            = loop.bars;
            this.ppq             = loop.ppq;
            this.instrumentProgram = loop.instrument_program ?? 0;
            const seq = typeof loop.midi_data === 'string' ? JSON.parse(loop.midi_data) : (loop.midi_data || []);
            this.sequence = seq;
            const f = (id, v) => { const el = this.$(id); if (el) el.value = v; };
            f('#lc-name-input', loop.name); f('#lc-tempo', loop.tempo); f('#lc-bars', loop.bars);
            const ts = this.$('#lc-timesig'); if (ts) ts.value = `${loop.time_sig_num}:${loop.time_sig_den}`;
            if (this.pianoRoll) { this._refreshPianoRollRange(); this.pianoRoll.sequence = seq; this.pianoRoll.redraw?.(); this._drawMinimap(); }
            this._setStatus(this.t('loopCreator.statusLoaded'));
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _deleteLoopById(id) {
        try {
            await this.api.sendCommand('loop_delete', { loopId: id });
            if (this.currentLoopId === id) this._newLoop();
            this._fetchLoopDataCache.delete(id);
            await this._loadLibrary();
            // Backend cascades blocks; refresh local arranger view to drop orphan blocks
            if (this.currentArrangementId && this.blocks.some(b => b.loop_id === id)) {
                await this._loadArrangementById(this.currentArrangementId);
            }
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    _newLoop() {
        this.currentLoopId = null; this.loopName = ''; this.tempo = 120;
        this.timeSigNum = 4; this.timeSigDen = 4; this.bars = 2; this.ppq = 480; this.sequence = [];
        const f = (id, v) => { const el = this.$(id); if (el) el.value = v; };
        f('#lc-name-input', ''); f('#lc-tempo', 120); f('#lc-bars', 2);
        const ts = this.$('#lc-timesig'); if (ts) ts.value = '4:4';
        this._clearNotes(); this._refreshPianoRollRange();
    }

    // =========================================================
    // ARRANGER — INIT
    // =========================================================

    async _initArrangerTab() {
        await this._loadLibrary();
        await this._loadArrangements();
        if (!this.currentArrangementId) await this._newArrangement();
        else await this._loadArrangementById(this.currentArrangementId);
    }

    async _loadArrangements() {
        try {
            const r = await this.api.sendCommand('arrangement_list');
            this._renderArrList(r.arrangements || []);
        } catch (_) {}
    }

    _renderArrList(arrs) {
        const el = this.$('#la-arr-list');
        if (!el) return;
        if (!arrs.length) { el.innerHTML = `<div class="lc-empty">${this.t('loopCreator.arrangementsEmpty')}</div>`; return; }
        el.innerHTML = arrs.map(a => `
            <div class="la-arr-item${a.id === this.currentArrangementId ? ' la-arr-item--active' : ''}"
                data-arr-id="${a.id}" role="button" tabindex="0">
                <span class="la-arr-name">${this.escape(a.name)}</span>
                <span class="la-arr-meta">${a.global_tempo} BPM · ${a.total_bars} ${this.t('loopCreator.barsUnit')}</span>
                <button class="lc-card-btn lc-card-btn--danger" data-arr-action="delete" data-arr-id="${a.id}">🗑</button>
            </div>`).join('');
        if (!el.dataset.lcWired) {
            el.dataset.lcWired = '1';
            el.addEventListener('click', (e) => {
                const del = e.target.closest('[data-arr-action="delete"]');
                if (del) { this._deleteArrangement(parseInt(del.dataset.arrId)); return; }
                const item = e.target.closest('[data-arr-id]');
                if (item) this._loadArrangementById(parseInt(item.dataset.arrId));
            });
        }
    }

    async _newArrangement() {
        try {
            const r = await this.api.sendCommand('arrangement_create', {
                name: this.t('loopCreator.untitledArrangement'),
                global_tempo: this.arrangementTempo,
                total_bars: this.arrangementBars
            });
            this.currentArrangementId = r.arrangementId;
            await this._loadArrangementById(r.arrangementId);
            await this._loadArrangements();
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _loadArrangementById(id) {
        try {
            const r = await this.api.sendCommand('arrangement_get', { arrangementId: id });
            const { arrangement, tracks, blocks } = r;
            this.currentArrangementId = arrangement.id;
            this.arrangementName  = arrangement.name;
            this.arrangementTempo = arrangement.global_tempo;
            this.arrangementBars  = arrangement.total_bars;
            this.tracks = tracks;
            this.blocks = blocks;
            const f = (id, v) => { const el = this.$(id); if (el) el.value = v; };
            f('#la-name-input', arrangement.name);
            f('#la-tempo', arrangement.global_tempo);
            f('#la-bars', arrangement.total_bars);
            this._renderTimeline();
            this._renderArrList([arrangement]);
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    // =========================================================
    // ARRANGER — PALETTE
    // =========================================================

    _renderPalette() {
        const grid = this.$('#la-palette-grid');
        if (!grid) return;
        if (!this.library.length) { grid.innerHTML = `<div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>`; return; }
        grid.innerHTML = this.library.map(loop =>
            `<div class="la-palette-chip" draggable="true" data-loop-id="${loop.id}"
                data-loop-bars="${loop.bars}" data-loop-name="${this.escape(loop.name)}">
                <div class="la-chip-name">${this.escape(loop.name)}</div>
                <div class="la-chip-meta">${loop.bars}${this.t('loopCreator.barsUnit')}</div>
            </div>`
        ).join('');

        grid.querySelectorAll('.la-palette-chip').forEach(chip => {
            chip.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    loopId: parseInt(chip.dataset.loopId),
                    loopBars: parseInt(chip.dataset.loopBars),
                    loopName: chip.dataset.loopName
                }));
            });
        });
    }

    // =========================================================
    // ARRANGER — TIMELINE
    // =========================================================

    _renderTimeline() {
        this._renderRuler();
        this._renderTracks();
        this._renderPalette();
    }

    _renderRuler() {
        const ruler = this.$('#la-ruler');
        if (!ruler) return;
        const BAR_W = this._barWidth();
        let html = '';
        for (let b = 0; b < this.arrangementBars; b++) {
            const marker = (b % 4 === 0) ? `<span class="la-ruler-label">${b + 1}</span>` : '';
            html += `<div class="la-ruler-cell" style="width:${BAR_W}px">${marker}</div>`;
        }
        ruler.style.width = (BAR_W * this.arrangementBars) + 'px';
        ruler.innerHTML = html;
    }

    _renderTracks() {
        const container = this.$('#la-tracks');
        if (!container) return;
        container.innerHTML = '';

        for (const track of this.tracks) {
            const trackEl = this._buildTrackEl(track);
            container.appendChild(trackEl);
        }
    }

    _buildTrackEl(track) {
        const BAR_W = this._barWidth();
        const totalW = BAR_W * this.arrangementBars;

        const trackEl = document.createElement('div');
        trackEl.className = 'la-track';
        trackEl.dataset.trackId = track.id;
        trackEl.innerHTML = `
            <div class="la-track-label">
                <input type="text" class="la-track-name-input lc-name-input" value="${this.escape(track.label)}"
                    data-track-id="${track.id}" />
                <button class="lc-card-btn lc-card-btn--danger" data-track-action="delete" data-track-id="${track.id}" title="${this.t('loopCreator.deleteTrack')}">✕</button>
            </div>
            <div class="la-track-cells" data-track-id="${track.id}" style="width:${totalW}px">
                ${this._buildCells(track.id, BAR_W)}
            </div>`;

        // Drop zone
        const cells = trackEl.querySelector('.la-track-cells');
        cells.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            const bar = this._barFromX(e.offsetX, BAR_W);
            this._showDropPreview(cells, bar, BAR_W);
        });
        cells.addEventListener('dragleave', () => this._hideDropPreview());
        cells.addEventListener('drop', (e) => {
            e.preventDefault();
            this._hideDropPreview();
            const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
            if (!data.loopId) return;
            const bar = this._barFromX(e.offsetX, BAR_W);
            this._addBlock(track.id, data.loopId, bar, data.loopBars || 2);
        });

        // Track label change
        const nameInput = trackEl.querySelector('.la-track-name-input');
        nameInput?.addEventListener('change', async () => {
            try { await this.api.sendCommand('arrangement_update_track', { trackId: track.id, label: nameInput.value }); } catch (_) {}
        });

        // Delete track
        trackEl.querySelector('[data-track-action="delete"]')?.addEventListener('click', () => this._deleteTrack(track.id));

        return trackEl;
    }

    _buildCells(trackId, BAR_W) {
        const trackBlocks = this.blocks.filter(b => b.track_id === trackId);
        const BLOCK_COLORS = ['#4a90d9','#e8931a','#27ae60','#9b59b6','#e74c3c','#1abc9c','#f39c12','#2980b9'];
        let html = '';
        trackBlocks.forEach((block, i) => {
            const color = BLOCK_COLORS[i % BLOCK_COLORS.length];
            const blockW = block.loop_bars * block.repetitions * BAR_W;
            const blockL = block.position_bar * BAR_W;
            html += `<div class="la-block" data-block-id="${block.id}"
                style="left:${blockL}px;width:${blockW}px;background:${color}">
                <div class="la-block-label">${this.escape(block.loop_name)} ×${block.repetitions}</div>
                <div class="la-block-actions">
                    <button class="la-block-btn" data-block-action="reps-dec" data-block-id="${block.id}" title="-1 rep">−</button>
                    <span class="la-block-reps">${block.repetitions}</span>
                    <button class="la-block-btn" data-block-action="reps-inc" data-block-id="${block.id}" title="+1 rep">+</button>
                    <button class="la-block-btn la-block-btn--del" data-block-action="delete" data-block-id="${block.id}" title="${this.t('loopCreator.deleteBlock')}">✕</button>
                </div>
            </div>`;
        });
        // Attach block action handlers after injection
        setTimeout(() => {
            this.$$(`[data-track-id="${trackId}"] .la-block`).forEach(blockEl => {
                blockEl.querySelectorAll('[data-block-action]').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const bid = parseInt(btn.dataset.blockId);
                        if (btn.dataset.blockAction === 'reps-inc')   this._changeReps(bid, +1);
                        if (btn.dataset.blockAction === 'reps-dec')   this._changeReps(bid, -1);
                        if (btn.dataset.blockAction === 'delete')     this._deleteBlock(bid);
                    });
                });
            });
        }, 0);
        return html;
    }

    _barWidth() {
        const wrap = this.$('#la-timeline-wrap');
        const available = (wrap?.clientWidth || 800) - 140; // minus palette
        return Math.max(24, Math.min(60, Math.floor(available / this.arrangementBars)));
    }

    _barFromX(offsetX, barW) {
        return Math.max(0, Math.min(this.arrangementBars - 1, Math.floor(offsetX / barW)));
    }

    _showDropPreview(cells, bar, barW) {
        this._hideDropPreview();
        const preview = document.createElement('div');
        preview.className = 'la-drop-preview';
        preview.style.left = (bar * barW) + 'px';
        preview.style.width = barW + 'px';
        cells.appendChild(preview);
        this._dropPreview = preview;
    }

    _hideDropPreview() {
        this._dropPreview?.remove();
        this._dropPreview = null;
    }

    // =========================================================
    // ARRANGER — CRUD
    // =========================================================

    async _addTrack() {
        if (!this.currentArrangementId) return;
        try {
            await this.api.sendCommand('arrangement_add_track', {
                arrangementId: this.currentArrangementId,
                label: `Track ${this.tracks.length + 1}`
            });
            await this._loadArrangementById(this.currentArrangementId);
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _deleteTrack(trackId) {
        try {
            await this.api.sendCommand('arrangement_delete_track', { trackId });
            this.tracks = this.tracks.filter(t => t.id !== trackId);
            this.blocks = this.blocks.filter(b => b.track_id !== trackId);
            this._renderTimeline();
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _addBlock(trackId, loopId, positionBar, loopBars) {
        try {
            const r = await this.api.sendCommand('arrangement_add_block', {
                trackId, loopId, position_bar: positionBar, repetitions: 1
            });
            // Fetch the loop name from library
            const loop = this.library.find(l => l.id === loopId);
            this.blocks.push({
                id: r.blockId, track_id: trackId, loop_id: loopId,
                position_bar: positionBar, repetitions: 1,
                loop_name: loop?.name || '?', loop_bars: loop?.bars || loopBars
            });
            this._renderTimeline();
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _changeReps(blockId, delta) {
        const block = this.blocks.find(b => b.id === blockId);
        if (!block) return;
        const newReps = Math.max(1, block.repetitions + delta);
        try {
            await this.api.sendCommand('arrangement_update_block', { blockId, repetitions: newReps });
            block.repetitions = newReps;
            this._renderTimeline();
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _deleteBlock(blockId) {
        try {
            await this.api.sendCommand('arrangement_delete_block', { blockId });
            this.blocks = this.blocks.filter(b => b.id !== blockId);
            this._renderTimeline();
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _saveArrangement() {
        this.arrangementName = this.$('#la-name-input')?.value?.trim() || this.t('loopCreator.untitledArrangement');
        const tempo = parseInt(this.$('#la-tempo')?.value) || this.arrangementTempo;
        const bars  = parseInt(this.$('#la-bars')?.value)  || this.arrangementBars;
        try {
            if (this.currentArrangementId) {
                await this.api.sendCommand('arrangement_update', {
                    arrangementId: this.currentArrangementId,
                    name: this.arrangementName, global_tempo: tempo, total_bars: bars
                });
                this._setStatus(this.t('loopCreator.statusSaved'));
                await this._loadArrangements();
            }
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    async _deleteArrangement(id) {
        try {
            await this.api.sendCommand('arrangement_delete', { arrangementId: id });
            if (this.currentArrangementId === id) await this._newArrangement();
            await this._loadArrangements();
        } catch (err) { this._setStatus(`${this.t('loopCreator.statusError')}: ${err.message}`); }
    }

    _adjustArrTempo(d) {
        this.arrangementTempo = Math.max(20, Math.min(300, this.arrangementTempo + d));
        const el = this.$('#la-tempo'); if (el) el.value = this.arrangementTempo;
    }

    _adjustArrBars(d) {
        this.arrangementBars = Math.max(4, Math.min(256, this.arrangementBars + d));
        const el = this.$('#la-bars'); if (el) el.value = this.arrangementBars;
        this._renderTimeline();
    }

    // =========================================================
    // ARRANGER — PLAYBACK
    // =========================================================

    async _playArrangement() {
        this._stopArrangerPlay();
        if (!this.blocks.length) {
            this._setStatus(this.t('loopCreator.statusNoNotes')); return;
        }
        const useDevice = this.outputMode === 'device' && this.outputDeviceId;
        if (!useDevice && !this._synth) {
            this._setStatus(this.t('loopCreator.statusNoSynth')); return;
        }
        this.isArrangerPlaying = true;
        this.$('#la-play-btn')?.classList.add('lc-btn-record--active');

        // FIX: arrangements are always 4/4; was incorrectly using this.timeSigNum
        const secPerBar = (60 / this.arrangementTempo) * 4;

        const events = [];
        for (const block of this.blocks) {
            const loopData = await this._fetchLoopData(block.loop_id);
            if (!loopData) continue;
            const seq = typeof loopData.midi_data === 'string'
                ? JSON.parse(loopData.midi_data) : (loopData.midi_data || []);
            const loopPPQ   = loopData.ppq || 480;
            const loopTempo = loopData.tempo || 120;
            const secPerTick = 60 / (loopTempo * loopPPQ);
            const loopDurSec = loopData.bars * (60 / loopTempo) * 4;

            for (let rep = 0; rep < block.repetitions; rep++) {
                const offsetSec = block.position_bar * secPerBar + rep * loopDurSec;
                for (const note of seq) {
                    const durSec = (note.g || note.l || 120) * secPerTick;
                    events.push({
                        ms: (offsetSec + note.t * secPerTick) * 1000,
                        note: note.n, vel: note.v || 80, durSec
                    });
                }
            }
        }

        for (const ev of events) {
            this._arrangerTimers.push(setTimeout(() => {
                if (!this.isArrangerPlaying) return;
                if (useDevice) {
                    this.api.sendCommand('midi_send_note', {
                        deviceId: this.outputDeviceId, channel: this.outputChannel,
                        note: ev.note, velocity: ev.vel
                    }).catch(() => {});
                    // Schedule noteOff for device mode
                    const offTimer = setTimeout(() => {
                        if (!this.isArrangerPlaying) return;
                        this.api.sendCommand('midi_send_note', {
                            deviceId: this.outputDeviceId, channel: this.outputChannel,
                            note: ev.note, velocity: 0
                        }).catch(() => {});
                    }, ev.durSec * 1000);
                    this._arrangerTimers.push(offTimer);
                } else {
                    try { this._synth.playNote(ev.note, ev.vel, 0, ev.durSec); } catch (_) {}
                }
            }, ev.ms));
        }

        const totalMs = this.arrangementBars * secPerBar * 1000;
        this._arrangerTimers.push(setTimeout(() => this._stopArrangerPlay(), totalMs));
        this._setStatus(this.t('loopCreator.statusPlaying'));
    }

    _stopArrangerPlay() {
        this._arrangerTimers.forEach(t => clearTimeout(t));
        this._arrangerTimers = [];
        this.isArrangerPlaying = false;
        this.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
        try { this._synth?.stop?.(); } catch (_) {}
        try { this._synth?.cancelAllNotes?.(); } catch (_) {}
        this._setStatus('');
    }

    async _fetchLoopData(loopId) {
        if (this._fetchLoopDataCache.has(loopId)) return this._fetchLoopDataCache.get(loopId);
        try {
            const r = await this.api.sendCommand('loop_get', { loopId });
            this._fetchLoopDataCache.set(loopId, r.loop);
            return r.loop;
        } catch (_) { return null; }
    }

    // =========================================================
    // DRAG (doc-level for block moves — future)
    // =========================================================

    _onDocMouseMove() {}

    // =========================================================
    // STATUS + HELPERS
    // =========================================================

    _setStatus(msg) { const el = this.$('#lc-status'); if (el) el.textContent = msg; }
}

if (typeof window !== 'undefined') window.LoopCreatorModal = LoopCreatorModal;
