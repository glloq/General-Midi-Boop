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
    }

    // =========================================================
    // RENDERING — SHELL
    // =========================================================

    renderBody() {
        return `
        <div class="lc-layout">
            <div class="lc-tabs" role="tablist">
                <button class="lc-tab lc-tab--active" data-tab="create" role="tab" aria-selected="true">
                    ✏️ ${this.t('loopCreator.tabCreate')}
                </button>
                <button class="lc-tab" data-tab="library" role="tab" aria-selected="false">
                    🗂 ${this.t('loopCreator.tabLibrary')}
                </button>
                <button class="lc-tab" data-tab="arranger" role="tab" aria-selected="false">
                    ∞ ${this.t('loopCreator.tabArranger')}
                </button>
            </div>
            <div class="lc-tab-content" id="lc-tab-content">
                ${this._renderCreateTab()}
                ${this._renderLibraryTab()}
                ${this._renderArrangerTab()}
            </div>
        </div>`;
    }

    renderFooter() {
        return `
            <div class="lc-footer-left">
                <span class="lc-status" id="lc-status"></span>
            </div>
            <div class="lc-footer-right" id="lc-footer-right">
                ${this._renderFooterForTab(this.activeTab)}
            </div>`;
    }

    _renderFooterForTab(tab) {
        if (tab === 'create') {
            return `<button class="lc-btn" data-action="close">${this.t('common.cancel')}</button>
                    <button class="lc-btn lc-btn-primary" data-action="save-loop">💾 ${this.t('loopCreator.save')}</button>`;
        }
        if (tab === 'arranger') {
            return `<button class="lc-btn" data-action="close">${this.t('common.cancel')}</button>
                    <button class="lc-btn lc-btn-primary" data-action="save-arrangement">💾 ${this.t('loopCreator.saveArrangement')}</button>`;
        }
        return `<button class="lc-btn" data-action="close">${this.t('common.close')}</button>`;
    }

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
            <!-- ── Editor toolbar ── -->
            <div class="lc-editor-toolbar">
                <div class="lc-toolbar-left">
                    <input type="text" class="lc-name-input" id="lc-name-input"
                        value="${this.escape(this.loopName || this.t('loopCreator.untitled'))}"
                        placeholder="${this.t('loopCreator.namePlaceholder')}"
                        aria-label="${this.t('loopCreator.loopName')}" />
                </div>
                <div class="lc-toolbar-center">
                    <label class="lc-label">${this.t('loopCreator.tempo')}</label>
                    <div class="lc-spinbox">
                        <button class="lc-spin-btn" data-action="tempo-dec">‹</button>
                        <input type="number" id="lc-tempo" class="lc-spin-input" value="${this.tempo}" min="20" max="300" step="1" />
                        <button class="lc-spin-btn" data-action="tempo-inc">›</button>
                    </div>
                    <span class="lc-unit">BPM</span>

                    <label class="lc-label">${this.t('loopCreator.timeSignature')}</label>
                    <select id="lc-timesig" class="lc-select">${timeSigHtml}</select>

                    <label class="lc-label">${this.t('loopCreator.bars')}</label>
                    <div class="lc-spinbox">
                        <button class="lc-spin-btn" data-action="bars-dec">‹</button>
                        <input type="number" id="lc-bars" class="lc-spin-input" value="${this.bars}" min="1" max="32" step="1" />
                        <button class="lc-spin-btn" data-action="bars-inc">›</button>
                    </div>
                    <span class="lc-unit">${this.t('loopCreator.barsUnit')}</span>

                    <label class="lc-label">${this.t('loopCreator.snap')}</label>
                    <select id="lc-snap" class="lc-select">
                        <option value="480">1/1</option><option value="240">1/2</option>
                        <option value="120" selected>1/4</option><option value="60">1/8</option>
                        <option value="30">1/16</option>
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

            <!-- ── Piano roll ── -->
            <div class="lc-pianoroll-wrap" id="lc-pianoroll-wrap"></div>

            <!-- ── Transport ── -->
            <div class="lc-transport">
                <div class="lc-transport-left">
                    <button class="lc-btn lc-btn-record" id="lc-record-btn" data-action="record">
                        <span class="lc-rec-dot"></span> ${this.t('loopCreator.record')}
                    </button>
                    <button class="lc-btn" data-action="preview">▶ ${this.t('loopCreator.preview')}</button>
                    <button class="lc-btn" data-action="stop-all">⏹ ${this.t('loopCreator.stop')}</button>
                    <span class="lc-rec-indicator hidden" id="lc-rec-indicator">
                        <span class="lc-rec-dot lc-rec-dot--pulse"></span> ${this.t('loopCreator.recording')}
                    </span>
                    <div class="lc-output-mode" role="group" aria-label="${this.t('loopCreator.outputMode')}">
                        <button class="lc-btn lc-output-btn lc-output-btn--active" id="lc-out-synth"
                            data-action="out-synth" title="${this.t('loopCreator.outSynthTitle')}">
                            🎹 ${this.t('loopCreator.outSynth')}
                        </button>
                        <button class="lc-btn lc-output-btn" id="lc-out-device"
                            data-action="out-device" title="${this.t('loopCreator.outDeviceTitle')}">
                            🎛 ${this.t('loopCreator.outDevice')}
                        </button>
                    </div>
                    <div class="lc-device-picker" id="lc-device-picker" style="display:none">
                        <select id="lc-out-device-sel" class="lc-select"
                            aria-label="${this.t('loopCreator.outputDevice')}">
                            <option value="">${this.t('loopCreator.midiInNone')}</option>
                        </select>
                        <select id="lc-out-channel" class="lc-select"
                            aria-label="${this.t('loopCreator.outputChannel')}">
                            ${[...Array(16)].map((_,i) => `<option value="${i}"${i===0?' selected':''}>Ch ${i+1}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="lc-transport-right">
                    <label class="lc-label">${this.t('loopCreator.quantize')}</label>
                    <select id="lc-quantize" class="lc-select">
                        <option value="0">${this.t('loopCreator.quantizeNone')}</option>
                        <option value="480">1/1</option><option value="240">1/2</option>
                        <option value="120" selected>1/4</option><option value="60">1/8</option>
                        <option value="30">1/16</option>
                    </select>
                    <label class="lc-label">${this.t('loopCreator.midiIn')}</label>
                    <select id="lc-midi-in-device" class="lc-select">
                        <option value="">${this.t('loopCreator.midiInNone')}</option>
                    </select>
                </div>
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
            <div class="lc-library-toolbar">
                <h3 class="lc-section-title">${this.t('loopCreator.library')}</h3>
                <button class="lc-btn lc-btn-primary" data-action="new-loop">+ ${this.t('loopCreator.newLoop')}</button>
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
            <div class="lc-arranger-toolbar">
                <div class="lc-toolbar-left">
                    <input type="text" class="lc-name-input" id="la-name-input"
                        value="${this.escape(this.arrangementName || this.t('loopCreator.untitledArrangement'))}"
                        placeholder="${this.t('loopCreator.arrangementName')}" />
                </div>
                <div class="lc-toolbar-center">
                    <label class="lc-label">${this.t('loopCreator.tempo')}</label>
                    <div class="lc-spinbox">
                        <button class="lc-spin-btn" data-action="arr-tempo-dec">‹</button>
                        <input type="number" id="la-tempo" class="lc-spin-input" value="${this.arrangementTempo}" min="20" max="300" />
                        <button class="lc-spin-btn" data-action="arr-tempo-inc">›</button>
                    </div>
                    <span class="lc-unit">BPM</span>

                    <label class="lc-label">${this.t('loopCreator.totalBars')}</label>
                    <div class="lc-spinbox">
                        <button class="lc-spin-btn" data-action="arr-bars-dec">‹</button>
                        <input type="number" id="la-bars" class="lc-spin-input" value="${this.arrangementBars}" min="4" max="256" step="4" />
                        <button class="lc-spin-btn" data-action="arr-bars-inc">›</button>
                    </div>
                    <span class="lc-unit">${this.t('loopCreator.barsUnit')}</span>
                </div>
                <div class="lc-toolbar-right">
                    <button class="lc-btn lc-btn-icon" data-action="arr-add-track" title="${this.t('loopCreator.addTrack')}">＋ Track</button>
                    <button class="lc-btn" data-action="arr-play" id="la-play-btn">▶ ${this.t('loopCreator.play')}</button>
                    <button class="lc-btn" data-action="arr-stop">⏹ ${this.t('loopCreator.stop')}</button>
                    <button class="lc-btn" data-action="arr-new">🆕 ${this.t('loopCreator.newArrangement')}</button>
                </div>
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
        const footer = this.$('#lc-footer-right');
        if (footer) footer.innerHTML = this._renderFooterForTab(tab);

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
        // Tab switching — .lc-tab buttons carry data-tab, not data-action
        const tabBtn = e.target.closest('.lc-tab[data-tab]');
        if (tabBtn) { this._switchTab(tabBtn.dataset.tab); return; }

        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const a = btn.dataset.action;
        switch (a) {
            // Creator
            case 'tempo-dec':    this._adjustTempo(-1);    break;
            case 'tempo-inc':    this._adjustTempo(+1);    break;
            case 'bars-dec':     this._adjustBars(-1);     break;
            case 'bars-inc':     this._adjustBars(+1);     break;
            case 'mode-draw':    this._setEditMode('dragpoly'); break;
            case 'mode-select':  this._setEditMode('select');   break;
            case 'undo':         this.pianoRoll?.undo?.();  break;
            case 'redo':         this.pianoRoll?.redo?.();  break;
            case 'clear-notes':  this._clearNotes();        break;
            case 'record':       this._toggleRecording();  break;
            case 'preview':      this._previewLoop();       break;
            case 'stop-all':     this._stopAll();           break;
            case 'out-synth':    this._setOutputMode('synth');  break;
            case 'out-device':   this._setOutputMode('device'); break;
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
        } else if (id === 'lc-out-device-sel') {
            this.outputDeviceId = e.target.value || null;
        } else if (id === 'lc-out-channel') {
            const v = parseInt(e.target.value);
            this.outputChannel = (Number.isInteger(v) && v >= 0 && v <= 15) ? v : 0;
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
        this.pianoRoll.setAttribute('xrange',   total.toString());
        this.pianoRoll.setAttribute('yrange',   '36');
        this.pianoRoll.setAttribute('yoffset',  '48');
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
        this._applyPianoRollTheme();
        container.appendChild(this.pianoRoll);
        this.pianoRoll.sequence = this.sequence;
        this.pianoRoll.redraw?.();
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
        this.pianoRoll.redraw?.();
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
        try {
            const result = await this.api.sendCommand('device_list');
            this.devices = result.devices || [];
            const deviceOptions = this.devices.map(d =>
                `<option value="${this.escape(d.id)}">${this.escape(d.name || d.id)}</option>`
            ).join('');
            const midiInSel = this.$('#lc-midi-in-device');
            if (midiInSel) {
                const prev = midiInSel.value;
                midiInSel.innerHTML = `<option value="">${this.t('loopCreator.midiInNone')}</option>` + deviceOptions;
                if (prev) midiInSel.value = prev;
            }
            this._populateOutDevicePicker();
        } catch (_) {}
    }

    _setOutputMode(mode) {
        if (mode === this.outputMode) return;
        // Stop everything cleanly before switching to avoid stuck notes on the previous output
        this._stopAll();
        this.outputMode = mode;
        this.$('#lc-out-synth')?.classList.toggle('lc-output-btn--active', mode === 'synth');
        this.$('#lc-out-device')?.classList.toggle('lc-output-btn--active', mode === 'device');
        const picker = this.$('#lc-device-picker');
        if (picker) picker.style.display = mode === 'device' ? 'flex' : 'none';
        if (mode === 'device') this._populateOutDevicePicker();
    }

    _populateOutDevicePicker() {
        const sel = this.$('#lc-out-device-sel');
        if (!sel) return;
        const prev = sel.value || this.outputDeviceId || '';
        sel.innerHTML = `<option value="">${this.t('loopCreator.midiInNone')}</option>` +
            this.devices.map(d =>
                `<option value="${this.escape(d.id)}">${this.escape(d.name || d.id)}</option>`
            ).join('');
        if (prev) sel.value = prev;
        this.outputDeviceId = sel.value || null;
        const chSel = this.$('#lc-out-channel');
        if (chSel) chSel.value = String(this.outputChannel);
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
        this._synth.loadSequence(seq, this.tempo, this.ppq);
        this._synth.play().then(() => {
            if (this.isPlaying) { this.isPlaying = false; this._setStatus(''); }
        }).catch(() => { this.isPlaying = false; this._setStatus(''); });
    }

    _previewViaDevice(seq) {
        const spt = 60 / (this.tempo * this.ppq);
        this.isPlaying = true;
        this._setStatus(this.t('loopCreator.statusPlaying'));
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
            if (this.pianoRoll) { this._refreshPianoRollRange(); this.pianoRoll.sequence = seq; this.pianoRoll.redraw?.(); }
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
