/**
 * LoopManagerModal — Loop / Sample Manager (∞)
 *
 * Four tabs:
 *   Tab 1 "Library"  — searchable/sortable loop grid, opens LoopEditorModal
 *   Tab 2 "Pad"      — 4×4 trigger pad grid + MIDI In mapping
 *   Tab 3 "Live"     — loops grouped by GM instrument for quick performance
 *   Tab 4 "Arranger" — multi-track timeline with loop blocks
 *
 * Loop creation/editing is delegated to LoopEditorModal.
 * Shared utilities live in LoopUtils.js.
 */

// ── GM program data ───────────────────────────────────────────
const GM_PROGRAM_NAMES = [
    'Acoustic Grand Piano','Bright Acoustic Piano','Electric Grand Piano','Honky-tonk Piano',
    'Electric Piano 1','Electric Piano 2','Harpsichord','Clavinet',
    'Celesta','Glockenspiel','Music Box','Vibraphone','Marimba','Xylophone','Tubular Bells','Dulcimer',
    'Drawbar Organ','Percussive Organ','Rock Organ','Church Organ','Reed Organ','Accordion','Harmonica','Tango Accordion',
    'Acoustic Guitar (nylon)','Acoustic Guitar (steel)','Electric Guitar (jazz)','Electric Guitar (clean)',
    'Electric Guitar (muted)','Overdriven Guitar','Distortion Guitar','Guitar Harmonics',
    'Acoustic Bass','Electric Bass (finger)','Electric Bass (pick)','Fretless Bass',
    'Slap Bass 1','Slap Bass 2','Synth Bass 1','Synth Bass 2',
    'Violin','Viola','Cello','Contrabass','Tremolo Strings','Pizzicato Strings','Orchestral Harp','Timpani',
    'String Ensemble 1','String Ensemble 2','Synth Strings 1','Synth Strings 2',
    'Choir Aahs','Voice Oohs','Synth Voice','Orchestra Hit',
    'Trumpet','Trombone','Tuba','Muted Trumpet','French Horn','Brass Section','Synth Brass 1','Synth Brass 2',
    'Soprano Sax','Alto Sax','Tenor Sax','Baritone Sax',
    'Oboe','English Horn','Bassoon','Clarinet',
    'Piccolo','Flute','Recorder','Pan Flute','Blown Bottle','Shakuhachi','Whistle','Ocarina',
    'Lead 1 (square)','Lead 2 (sawtooth)','Lead 3 (calliope)','Lead 4 (chiff)',
    'Lead 5 (charang)','Lead 6 (voice)','Lead 7 (fifths)','Lead 8 (bass + lead)',
    'Pad 1 (new age)','Pad 2 (warm)','Pad 3 (polysynth)','Pad 4 (choir)',
    'Pad 5 (bowed)','Pad 6 (metallic)','Pad 7 (halo)','Pad 8 (sweep)',
    'FX 1 (rain)','FX 2 (soundtrack)','FX 3 (crystal)','FX 4 (atmosphere)',
    'FX 5 (brightness)','FX 6 (goblins)','FX 7 (echoes)','FX 8 (sci-fi)',
    'Sitar','Banjo','Shamisen','Koto','Kalimba','Bagpipe','Fiddle','Shanai',
    'Tinkle Bell','Agogo','Steel Drums','Woodblock','Taiko Drum','Melodic Tom','Synth Drum','Reverse Cymbal',
    'Guitar Fret Noise','Breath Noise','Seashore','Bird Tweet','Telephone Ring','Helicopter','Applause','Gunshot'
];

const GM_FAMILIES = (typeof window !== 'undefined' && window.LoopUtils && window.LoopUtils.GM_FAMILIES) || [];

const ARRANGER_HISTORY_LIMIT = 50;

class LoopManagerModal extends BaseModal {
    constructor(api, eventBus) {
        super({
            id: 'loop-manager-modal',
            size: 'full',
            title: 'loopManager.title',
            closeOnOverlay: false,
            customClass: 'loop-creator-modal'
        });
        this.api = api;
        this.eventBus = eventBus || window.eventBus || null;

        this.activeTab = 'library';

        // ── Library state ──
        this.library = [];
        this._libSearch  = '';
        this._libFilter  = '';  // instrument_program string ('') or number
        this._libSort    = 'name';

        // ── Arranger state ──
        this.currentArrangementId = null;
        this.arrangementName      = '';
        this.arrangementTempo     = 120;
        this.arrangementBars      = 16;
        this.tracks  = [];
        this.blocks  = [];
        this._arrangerZoom = 1;   // horizontal zoom factor for the timeline
        this.isArrangerPlaying = false;
        this._arrangerTimers   = [];
        this._arrangerSynth    = null;
        this._dragInfo    = null;
        this._dropPreview = null;

        // Arranger undo/redo (local to current arrangement)
        this._arrHistory     = [];
        this._arrHistoryIdx  = -1;
        this._selectedBlocks = new Set();

        // Shared loop data cache (pad + live + arranger)
        this._fetchLoopDataCache = new Map();

        // ── Pad state ──
        this._padSlots        = Array(16).fill(null); // { loopId, name, tempo, bars, instrument_program }
        this._padPlayingIndex = new Set();
        this._padMidiInDevice = null;
        this._padMidiInHandler = null;
        this._padMonitorActive = false;
        this._padPlaybackTimers = new Map(); // padIndex → [timerIds]
        this._padSynth        = null;
        this._padPickerIndex  = null; // pad index whose assignment picker is open
        this._padPickerHandler = null; // bound click handler so we can detach

        // ── Live state ──
        this._livePlayingLoops = new Map(); // loopId → { timers, ch, startMs, durMs }
        this._liveSynth        = null;
        this._liveSearch       = '';

        // ── Keyboard tab state (live performance alongside loops) ──
        this._kbdSynth          = null;
        this._kbdMounted        = false;
        this._kbdEnvelopes      = new Map(); // note → [envelope, ...]
        this._kbdActiveKeys     = new Set();
        this._kbdOutputTarget   = 'synth';   // 'synth' | 'live'
        this._kbdOutputDevice   = null;
        this._kbdOutputChannel  = 0;
        this._kbdInstrument     = 0;

        // ── Playback timeline bar ──
        this._padPlayTimes      = new Map(); // padIndex → { startMs, durMs }
        this._arrangerStartTime = 0;
        this._playbarRAF        = null;

        // Arranger output (synth by default)
        this.outputMode     = 'synth';
        this.outputDeviceId = null;
        this.outputChannel  = 0;

        // ── Global output selector (header) — drives Pad / Live / Arranger ──
        this._globalOutput = { mode: 'synth', deviceId: null, channel: 0 };
        this._deviceShim   = null;
        this._cachedDevices = [];

        // Bound doc handlers for arranger drag
        this._boundDocMouseUp   = this._onDocMouseUp.bind(this);
        this._boundDocMouseMove = this._onDocMouseMove.bind(this);
        this._boundKeyDown      = this._onKeyDown.bind(this);

        // Loop editor — created once, shared across sessions
        this._loopEditor = new LoopEditorModal(api, eventBus, {
            onSaved: (loopId) => this._onLoopSaved(loopId)
        });
    }

    // =========================================================
    // RENDERING — SHELL
    // =========================================================

    _renderHeader() {
        const showSave = this.activeTab === 'arranger';
        return `
        <div class="modal-header lc-header">
            <div class="lc-header-left">
                <span class="lc-header-title">∞</span>
                <span class="lc-header-subtitle">${this.t('loopManager.title')}</span>
            </div>
            <div class="lc-header-tabs" role="tablist">
                <button class="lc-tab${this.activeTab==='library'  ? ' lc-tab--active':''}" data-tab="library"  role="tab" aria-selected="${this.activeTab==='library'}">🗂 ${this.t('loopManager.tabLibrary')}</button>
                <button class="lc-tab${this.activeTab==='pad'      ? ' lc-tab--active':''}" data-tab="pad"      role="tab" aria-selected="${this.activeTab==='pad'}">🎛 ${this.t('loopManager.tabPad')}</button>
                <button class="lc-tab${this.activeTab==='live'     ? ' lc-tab--active':''}" data-tab="live"     role="tab" aria-selected="${this.activeTab==='live'}">⚡ ${this.t('loopManager.tabLive')}</button>
                <button class="lc-tab${this.activeTab==='keyboard' ? ' lc-tab--active':''}" data-tab="keyboard" role="tab" aria-selected="${this.activeTab==='keyboard'}">🎹 ${this.t('loopManager.tabKeyboard')}</button>
                <button class="lc-tab${this.activeTab==='arranger' ? ' lc-tab--active':''}" data-tab="arranger" role="tab" aria-selected="${this.activeTab==='arranger'}">∞ ${this.t('loopManager.tabArranger')}</button>
            </div>
            <div class="lc-header-actions">
                <div class="lc-header-output" id="lc-header-output-wrap">
                    <span class="lc-header-output-icon" id="lc-header-output-icon" aria-hidden="true">🔊</span>
                    <select id="lc-header-output" class="lc-select lc-select-output"
                        title="${this.t('loopCreator.outputLabel')}">
                        <option value="synth" selected>${this.t('loopManager.outputSynth')}</option>
                    </select>
                    <select id="lc-header-output-ch" class="lc-select lc-select-output-ch"
                        title="${this.t('loopCreator.outputChannel')}"
                        style="display:none"></select>
                </div>
                <button class="lc-btn lc-btn-primary lc-btn-sm" id="lc-header-save"
                    data-action="save-arrangement"
                    style="${showSave ? '' : 'display:none'}">💾 ${this.t('loopCreator.saveArrangement')}</button>
                <button class="lc-btn lc-btn-sm lc-btn-icon" data-action="stop-all-playback" title="${this.t('loopManager.stopAll')}">⏹</button>
                <button class="modal-close" data-action="close" aria-label="${this.t('common.close')}">&times;</button>
            </div>
            <div class="lc-playbar" id="lc-playbar">
                <div class="lc-playbar-fill" id="lc-playbar-fill"></div>
            </div>
        </div>`;
    }

    renderBody() {
        return `
        <div class="lc-layout">
            <div class="lc-tab-content" id="lc-tab-content">
                ${this._renderLibraryTab()}
                ${this._renderPadTab()}
                ${this._renderLiveTab()}
                ${this._renderKeyboardTab()}
                ${this._renderArrangerTab()}
            </div>
        </div>`;
    }

    // =========================================================
    // RENDERING — TAB: KEYBOARD (live performance)
    // =========================================================

    _renderKeyboardTab() {
        return `
        <div class="lc-pane lc-pane--hidden lm-kbd-pane" id="lc-pane-keyboard">
            <div class="lc-ctrl-bar lc-ctrl-bar--kbd">
                <span class="lc-label">${this.t('loopManager.kbdOutput')}:</span>
                <button class="lc-btn lc-btn-icon lc-btn-output" id="lm-kbd-output-btn" data-action="kbd-toggle-output">🔊</button>
                <span class="lc-unit" id="lm-kbd-output-label">${this.t('loopManager.outputSynth')}</span>
                <span class="lc-ctrl-spacer"></span>
                <span class="lc-status lm-kbd-hint">${this.t('loopManager.kbdHint')}</span>
                <span class="lc-ctrl-sep"></span>
                <button class="lc-btn lc-btn-sm" data-action="kbd-stop-all" title="${this.t('loopCreator.stop')}">⏹ ${this.t('loopManager.kbdSilence')}</button>
            </div>
            <div class="lm-kbd-panel" id="lm-kbd-panel"></div>
        </div>`;
    }

    renderFooter() { return ''; }

    // =========================================================
    // RENDERING — TAB 1: LIBRARY
    // =========================================================

    _renderLibraryTab() {
        return `
        <div class="lc-pane${this.activeTab==='library' ? '' : ' lc-pane--hidden'}" id="lc-pane-library">
            <div class="lc-ctrl-bar lc-ctrl-bar--lib">
                <input type="text" id="lm-lib-search" class="lc-name-input lm-lib-search"
                    placeholder="${this.t('loopManager.search')}" value="${this.escape(this._libSearch)}" />
                <select id="lm-lib-filter" class="lc-select lm-lib-filter">
                    <option value="">— ${this.t('loopManager.allInstruments')} —</option>
                </select>
                <select id="lm-lib-sort" class="lc-select lm-lib-sort">
                    <option value="name"       ${this._libSort==='name'       ?'selected':''}>↕ ${this.t('loopManager.sortName')}</option>
                    <option value="tempo"      ${this._libSort==='tempo'      ?'selected':''}>↕ ${this.t('loopManager.sortTempo')}</option>
                    <option value="bars"       ${this._libSort==='bars'       ?'selected':''}>↕ ${this.t('loopManager.sortBars')}</option>
                    <option value="instrument" ${this._libSort==='instrument' ?'selected':''}>↕ ${this.t('loopManager.sortInstrument')}</option>
                </select>
                <span class="lc-ctrl-spacer"></span>
                <button class="lc-btn lc-btn-primary lc-btn-sm" data-action="new-loop">+ ${this.t('loopManager.newLoop')}</button>
            </div>
            <div class="lm-library-grid" id="lm-library-grid">
                <div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>
            </div>
        </div>`;
    }

    // =========================================================
    // RENDERING — TAB 2: PAD
    // =========================================================

    _renderPadTab() {
        return `
        <div class="lc-pane lc-pane--hidden" id="lc-pane-pad">
            <div class="lc-ctrl-bar lc-ctrl-bar--pad">
                <select id="lm-pad-midi-in" class="lc-select lc-select-midi" title="${this.t('loopManager.padMidiIn')}">
                    <option value="">${this.t('loopManager.padMidiInNone')}</option>
                </select>
                <span class="lc-status" id="lm-pad-midi-status"></span>
                <span class="lc-ctrl-spacer"></span>
                <span class="lc-status lc-pad-hint">${this.t('loopManager.padTabHint')}</span>
                <span class="lc-ctrl-spacer"></span>
                <button class="lc-btn lc-btn-sm" data-action="pad-export" title="${this.t('loopManager.exportPadLayout')}">📤</button>
                <button class="lc-btn lc-btn-sm" data-action="pad-import" title="${this.t('loopManager.importPadLayout')}">📥</button>
                <button class="lc-btn lc-btn-sm" data-action="pad-clear-all" title="${this.t('loopManager.clearAllPads')}">🗑</button>
                <button class="lc-btn lc-btn-sm" data-action="pad-stop-all">⏹ ${this.t('loopManager.stopAll')}</button>
            </div>
            <div class="lm-pad-grid" id="lm-pad-grid"></div>
            <div class="lm-pad-picker" id="lm-pad-picker" style="display:none"></div>
        </div>`;
    }

    // =========================================================
    // RENDERING — TAB 3: LIVE
    // =========================================================

    _renderLiveTab() {
        return `
        <div class="lc-pane lc-pane--hidden" id="lc-pane-live">
            <div class="lc-ctrl-bar">
                <input type="text" id="lm-live-search" class="lc-name-input lm-lib-search"
                    placeholder="${this.t('loopManager.search')}" value="${this.escape(this._liveSearch || '')}" autocomplete="off" />
                <span class="lc-ctrl-spacer"></span>
                <button class="lc-btn lc-btn-sm" data-action="live-stop-all">⏹ ${this.t('loopManager.stopAll')}</button>
            </div>
            <div class="lm-live-area" id="lm-live-area">
                <div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>
            </div>
        </div>`;
    }

    // =========================================================
    // RENDERING — TAB 4: ARRANGER
    // =========================================================

    _renderArrangerTab() {
        return `
        <div class="lc-pane lc-pane--hidden" id="lc-pane-arranger">
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
                <button class="lc-btn lc-btn-icon" data-action="arr-undo" id="la-undo-btn" title="${this.t('loopCreator.undo')} (⌘Z)" disabled>↶</button>
                <button class="lc-btn lc-btn-icon" data-action="arr-redo" id="la-redo-btn" title="${this.t('loopCreator.redo')} (⌘⇧Z)" disabled>↷</button>
                <div class="lc-ctrl-sep"></div>
                <button class="lc-btn lc-btn-icon" data-action="arr-play" id="la-play-btn" title="${this.t('loopCreator.play')} (Space)">▶</button>
                <button class="lc-btn lc-btn-icon" data-action="arr-stop" title="${this.t('loopCreator.stop')} (Esc)">⏹</button>
                <div class="lc-ctrl-sep"></div>
                <button class="lc-btn lc-btn-icon" data-action="arr-zoom-out" title="${this.t('loopEditor.zoomHOut')}">−H</button>
                <button class="lc-btn lc-btn-icon" data-action="arr-zoom-reset" title="${this.t('loopManager.zoomReset')}">⌖</button>
                <button class="lc-btn lc-btn-icon" data-action="arr-zoom-in" title="${this.t('loopEditor.zoomHIn')}">+H</button>
                <div class="lc-ctrl-sep"></div>
                <button class="lc-btn lc-btn-icon" data-action="arr-add-track" title="${this.t('loopCreator.addTrack')}">＋</button>
                <button class="lc-btn" data-action="arr-new" title="${this.t('loopCreator.newArrangement')}">🆕</button>
            </div>

            <div class="la-area" id="la-area">
                <div class="la-palette" id="la-palette">
                    <div class="la-palette-title">${this.t('loopCreator.palette')}</div>
                    <div class="la-palette-grid" id="la-palette-grid">
                        <div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>
                    </div>
                </div>
                <div class="la-timeline-wrap" id="la-timeline-wrap">
                    <div class="la-ruler" id="la-ruler"></div>
                    <div class="la-tracks" id="la-tracks"></div>
                    <div class="la-playhead" id="la-playhead" style="display:none"></div>
                </div>
            </div>

            <div class="la-arr-list-wrap">
                <div class="la-arr-list-title">${this.t('loopCreator.arrangements')}</div>
                <div class="la-arr-list" id="la-arr-list"></div>
            </div>
        </div>`;
    }

    // =========================================================
    // LIFECYCLE
    // =========================================================

    onOpen() {
        this._loadPadLayout();
        this._initArrangerSynth();
        this._initPadSynth();
        this._initLiveSynth();
        this._attachEvents();
        this._loadLibrary();
        this._loadHeaderOutputDevices();
        document.addEventListener('mouseup',    this._boundDocMouseUp);
        document.addEventListener('mousemove',  this._boundDocMouseMove);
        document.addEventListener('keydown',    this._boundKeyDown);
    }

    // ── Global output selector (header) ────────────────────────
    async _loadHeaderOutputDevices() {
        const sel = this.$('#lc-header-output');
        if (!sel) return;
        try {
            const allDevices = await this.api.listDevices();
            this._cachedDevices = (allDevices || []).filter(d => d.status === 2 || d.connected === true);
        } catch (err) {
            LoopUtils.handleError(err, 'manager.header.listDevices');
            this._cachedDevices = [];
        }
        // Rebuild options, preserving current selection if still valid
        const current = sel.value;
        sel.innerHTML = `<option value="synth">${this.t('loopManager.outputSynth')}</option>`;
        for (const d of this._cachedDevices) {
            const id  = d.device_id || d.id;
            const opt = document.createElement('option');
            opt.value = `device:${id}`;
            opt.textContent = `🔌 ${d.name || id}`;
            sel.appendChild(opt);
        }
        if (current && [...sel.options].some(o => o.value === current)) {
            sel.value = current;
        } else {
            sel.value = 'synth';
            this._setGlobalOutput({ mode: 'synth', deviceId: null });
        }
        this._refreshHeaderOutputUI();
    }

    _ensureChannelOptions() {
        const sel = this.$('#lc-header-output-ch');
        if (!sel || sel.options.length) return;
        for (let i = 0; i < 16; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = `Ch ${i + 1}`;
            sel.appendChild(opt);
        }
        sel.value = String(this._globalOutput.channel || 0);
    }

    _refreshHeaderOutputUI() {
        const sel    = this.$('#lc-header-output');
        const chSel  = this.$('#lc-header-output-ch');
        const icon   = this.$('#lc-header-output-icon');
        const wrap   = this.$('#lc-header-output-wrap');
        const isDev  = this._globalOutput.mode === 'device';
        if (icon) icon.textContent = isDev ? '🔌' : '🔊';
        if (wrap) wrap.classList.toggle('lc-header-output--device', isDev);
        if (chSel) {
            chSel.style.display = isDev ? '' : 'none';
            this._ensureChannelOptions();
            chSel.value = String(this._globalOutput.channel || 0);
        }
        if (sel) {
            const target = this._globalOutput.mode === 'device' && this._globalOutput.deviceId
                ? `device:${this._globalOutput.deviceId}` : 'synth';
            if (sel.value !== target) sel.value = target;
        }
    }

    _setGlobalOutput(next) {
        const prev = this._globalOutput;
        this._globalOutput = { ...prev, ...next };
        // Switching target: stop everything to avoid stuck notes
        if (prev.mode !== this._globalOutput.mode || prev.deviceId !== this._globalOutput.deviceId) {
            this._stopAllPads();
            this._liveStopAll();
            this._stopArrangerPlay();
            this._panicCurrentDevice(prev);
            this._deviceShim = null; // rebuilt lazily
        }
        this._refreshHeaderOutputUI();
    }

    _panicCurrentDevice(target) {
        if (!target || target.mode !== 'device' || !target.deviceId) return;
        this.api.sendCommand('midi_panic', { deviceId: target.deviceId })
            .catch(err => LoopUtils.handleError(err, 'manager.output.panic'));
    }

    _getOutputTarget(fallbackSynth) {
        if (this._globalOutput.mode === 'device' && this._globalOutput.deviceId) {
            if (!this._deviceShim) this._deviceShim = this._makeDeviceShim();
            return this._deviceShim;
        }
        return fallbackSynth;
    }

    _makeDeviceShim() {
        const api = this.api;
        const getOutput = () => this._globalOutput;
        return {
            loadedInstruments: { has: () => true },
            loadInstrument: async () => {},
            setChannelInstrument: () => {},
            cancelAllNotes: () => {
                const out = getOutput();
                if (!out.deviceId) return;
                api.sendCommand('midi_panic', { deviceId: out.deviceId })
                    .catch(err => LoopUtils.handleError(err, 'manager.shim.panic'));
            },
            playNote: (note, velocity, _ch, durSec) => {
                const out = getOutput();
                if (!out.deviceId) return null;
                api.sendCommand('midi_send_note', {
                    deviceId: out.deviceId,
                    channel:  out.channel ?? 0,
                    note,
                    velocity: velocity || 80,
                    duration: Math.max(20, Math.round((durSec || 0.5) * 1000))
                }).catch(err => LoopUtils.handleError(err, 'manager.shim.playNote'));
                return null;
            }
        };
    }

    onClose() {
        this._stopAllPads();
        this._liveStopAll();
        this._stopArrangerPlay();
        this._stopPadMidiMonitor();
        this._stopPlaybarRAF();
        this._closePadPicker();
        this._kbdStopAllNotes();
        if (this._kbdMounted) this._unmountKbdPanel();
        document.removeEventListener('mouseup',   this._boundDocMouseUp);
        document.removeEventListener('mousemove', this._boundDocMouseMove);
        document.removeEventListener('keydown',   this._boundKeyDown);
    }

    // =========================================================
    // KEYBOARD SHORTCUTS
    // =========================================================

    _onKeyDown(e) {
        const t = e.target;
        const tag = (t?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
        if (this._loopEditor?.isOpen) return; // editor handles its own shortcuts

        const mod = e.ctrlKey || e.metaKey;

        if (this.activeTab === 'arranger') {
            if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this._arrUndo(); return; }
            if (mod && e.key.toLowerCase() === 'z' &&  e.shiftKey) { e.preventDefault(); this._arrRedo(); return; }
            if (mod && e.key.toLowerCase() === 'y')                { e.preventDefault(); this._arrRedo(); return; }
            if (mod && e.key.toLowerCase() === 's')                { e.preventDefault(); this._saveArrangement(); return; }
            if (e.key === ' ') { e.preventDefault(); this.isArrangerPlaying ? this._stopArrangerPlay() : this._playArrangement(); return; }
            if (e.key === 'Escape') { this._stopArrangerPlay(); this._clearBlockSelection(); return; }
            if ((e.key === 'Delete' || e.key === 'Backspace') && this._selectedBlocks.size) {
                e.preventDefault(); this._deleteSelectedBlocks(); return;
            }
            if (mod && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                this._selectedBlocks = new Set(this.blocks.map(b => b.id));
                this._refreshBlockSelectionUI();
                return;
            }
        }

        if (this.activeTab === 'pad') {
            if (e.key === 'Escape') { this._stopAllPads(); return; }
            // Number keys 1-9, 0 trigger pads 0-9; q-y trigger 10-15
            const padMap = { '1':0, '2':1, '3':2, '4':3, 'q':4, 'w':5, 'e':6, 'r':7, 'a':8, 's':9, 'd':10, 'f':11, 'z':12, 'x':13, 'c':14, 'v':15 };
            const idx = padMap[e.key.toLowerCase()];
            if (idx != null) { e.preventDefault(); this._triggerPad(idx); return; }
        }

        if (this.activeTab === 'live') {
            if (e.key === 'Escape') { this._liveStopAll(); return; }
        }
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
        const saveBtn = this.$('#lc-header-save');
        if (saveBtn) saveBtn.style.display = tab === 'arranger' ? '' : 'none';

        // The embedded keyboard panel can only live in one host at a time, so
        // unmount it whenever the user leaves the Keyboard tab.
        if (tab !== 'keyboard' && this._kbdMounted) this._unmountKbdPanel();

        if (tab === 'library')  this._filterAndRenderLibrary();
        if (tab === 'pad')    { this._renderPadGrid(); this._loadPadMidiInDevices(); }
        if (tab === 'live')     this._renderLiveArea();
        if (tab === 'keyboard') this._enterKeyboardTab();
        if (tab === 'arranger') this._initArrangerTab();
    }

    // =========================================================
    // EVENTS
    // =========================================================

    _attachEvents() {
        this.dialog.addEventListener('click',  (e) => this._onClick(e));
        this.dialog.addEventListener('change', (e) => this._onChange(e));
        this.dialog.addEventListener('input',  (e) => this._onInput(e));
        this.dialog.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    }

    _onClick(e) {
        // Close pad picker on outside click
        if (this._padPickerIndex !== null && !e.target.closest('#lm-pad-picker') && !e.target.closest('.lm-pad-cell')) {
            this._closePadPicker();
        }

        const tabBtn = e.target.closest('.lc-tab[data-tab]');
        if (tabBtn) { this._switchTab(tabBtn.dataset.tab); return; }

        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const a = btn.dataset.action;
        switch (a) {
            // Global stop (header button)
            case 'stop-all-playback': this._stopAllPads(); this._liveStopAll(); this._stopArrangerPlay(); break;
            // Library
            case 'new-loop':  this._loopEditor.open(); break;
            // Pad
            case 'pad-stop-all': this._stopAllPads(); break;
            case 'pad-export':   this._exportPadLayout(); break;
            case 'pad-import':   this._importPadLayout(); break;
            case 'pad-clear-all':this._clearAllPads(); break;
            // Keyboard tab
            case 'kbd-toggle-output': this._kbdToggleOutput(); break;
            case 'kbd-stop-all':      this._kbdStopAllNotes(); break;
            // Live
            case 'live-stop-all':      this._liveStopAll(); break;
            case 'live-trigger': {
                const loopId = parseInt(btn.dataset.loopId);
                if (!isNaN(loopId)) this._liveTrigger(loopId);
                break;
            }
            // Arranger
            case 'arr-tempo-dec':    this._adjustArrTempo(-1); break;
            case 'arr-tempo-inc':    this._adjustArrTempo(+1); break;
            case 'arr-bars-dec':     this._adjustArrBars(-4);  break;
            case 'arr-bars-inc':     this._adjustArrBars(+4);  break;
            case 'arr-add-track':    this._addTrack();          break;
            case 'arr-play':         this._playArrangement();   break;
            case 'arr-stop':         this._stopArrangerPlay();  break;
            case 'arr-new':          this._newArrangementConfirm(); break;
            case 'arr-zoom-in':      this._arrZoom(1.5);        break;
            case 'arr-zoom-out':     this._arrZoom(1 / 1.5);    break;
            case 'arr-zoom-reset':   this._arrZoomReset();      break;
            case 'arr-undo':         this._arrUndo();           break;
            case 'arr-redo':         this._arrRedo();           break;
            case 'save-arrangement': this._saveArrangement();   break;
            case 'close':            this.close();              break;
        }
    }

    _onContextMenu(e) {
        const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
        if (!cell) return;
        e.preventDefault();
        this._openPadPicker(parseInt(cell.dataset.padIndex), cell);
    }

    _onChange(e) {
        const id = e.target.id;
        if (id === 'lc-header-output') {
            const v = e.target.value || 'synth';
            if (v === 'synth') {
                this._setGlobalOutput({ mode: 'synth', deviceId: null });
            } else if (v.startsWith('device:')) {
                this._setGlobalOutput({ mode: 'device', deviceId: v.slice(7) });
            }
            return;
        } else if (id === 'lc-header-output-ch') {
            this._setGlobalOutput({ channel: parseInt(e.target.value) || 0 });
            return;
        } else if (id === 'lm-lib-filter') {
            this._libFilter = e.target.value;
            this._filterAndRenderLibrary();
        } else if (id === 'lm-lib-sort') {
            this._libSort = e.target.value;
            this._filterAndRenderLibrary();
        } else if (id === 'lm-pad-midi-in') {
            this._padMidiInDevice = e.target.value || null;
            if (this._padMidiInDevice) this._startPadMidiMonitor();
            else                       this._stopPadMidiMonitor();
        } else if (id === 'la-bars') {
            const v = LoopUtils.validate.arrBars(e.target.value, this.arrangementBars);
            if (v !== this.arrangementBars) {
                this.arrangementBars = v;
                e.target.value = v;
                this._renderTimeline();
            } else {
                // Re-sync UI in case clamp produced same value but input is out-of-range
                e.target.value = v;
            }
        }
    }

    _onInput(e) {
        const id = e.target.id;
        if (id === 'lm-lib-search') {
            this._libSearch = e.target.value;
            this._filterAndRenderLibrary();
        } else if (id === 'lm-live-search') {
            this._liveSearch = e.target.value;
            this._renderLiveArea();
        } else if (id === 'la-name-input') {
            this.arrangementName = e.target.value;
        } else if (id === 'la-tempo') {
            const v = LoopUtils.validate.tempo(e.target.value, this.arrangementTempo);
            if (v !== this.arrangementTempo) this.arrangementTempo = v;
        }
    }

    // =========================================================
    // LIBRARY
    // =========================================================

    async _loadLibrary() {
        try {
            const r = await this.api.sendCommand('loop_list');
            this.library = r.loops || [];
            if (this.activeTab === 'library') this._filterAndRenderLibrary();
            if (this.activeTab === 'live')    this._renderLiveArea();
            this._renderPalette();
        } catch (err) {
            LoopUtils.handleError(err, 'manager.loadLibrary', {
                toast: this.t('loopManager.errLoadLibrary')
            });
        }
    }

    _filterAndRenderLibrary() {
        const grid = this.$('#lm-library-grid');
        if (!grid) return;

        this._populateInstrumentFilter();

        let items = [...this.library];
        if (this._libSearch) {
            const q = this._libSearch.toLowerCase();
            items = items.filter(l => l.name.toLowerCase().includes(q));
        }
        if (this._libFilter !== '') {
            const prog = parseInt(this._libFilter);
            items = items.filter(l => (l.instrument_program ?? 0) === prog);
        }
        items.sort((a, b) => {
            if (this._libSort === 'tempo')      return a.tempo - b.tempo;
            if (this._libSort === 'bars')       return a.bars  - b.bars;
            if (this._libSort === 'instrument') return (a.instrument_program ?? 0) - (b.instrument_program ?? 0);
            return a.name.localeCompare(b.name);
        });

        if (!items.length) {
            grid.innerHTML = `<div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>`;
            return;
        }
        grid.innerHTML = items.map(loop => this._loopCardHtml(loop)).join('');

        if (!grid.dataset.lmWired) {
            grid.dataset.lmWired = '1';
            grid.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-loop-action]');
                if (!btn) return;
                const id = parseInt(btn.dataset.loopId);
                if (btn.dataset.loopAction === 'edit')      this._loopEditor.open({ loopId: id });
                if (btn.dataset.loopAction === 'delete')    this._deleteLoopById(id);
                if (btn.dataset.loopAction === 'duplicate') this._duplicateLoopById(id);
                if (btn.dataset.loopAction === 'pad') {
                    const firstEmpty = this._padSlots.findIndex(s => s === null);
                    if (firstEmpty !== -1) {
                        this._assignPadSlot(firstEmpty, id);
                        LoopUtils.toast(this.t('loopManager.assignedToPad', { index: firstEmpty + 1 }), 'success');
                    } else {
                        LoopUtils.toast(this.t('loopManager.padFull'), 'info');
                    }
                }
            });
            // Cards are draggable → drop on pads, palette chips, etc.
            grid.addEventListener('dragstart', (e) => {
                const card = e.target.closest('.lc-card[data-loop-id]');
                if (!card) return;
                const id = parseInt(card.dataset.loopId);
                const loop = this.library.find(l => l.id === id);
                if (!loop) return;
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    source:   'library-card',
                    loopId:   id,
                    loopBars: loop.bars,
                    loopName: loop.name
                }));
                card.classList.add('lc-card--dragging');
            });
            grid.addEventListener('dragend', (e) => {
                const card = e.target.closest('.lc-card[data-loop-id]');
                if (card) card.classList.remove('lc-card--dragging');
            });
        }
    }

    _populateInstrumentFilter() {
        const sel = this.$('#lm-lib-filter');
        if (!sel) return;
        const programs = [...new Set(this.library.map(l => l.instrument_program ?? 0))].sort((a, b) => a - b);
        const current = sel.value;
        sel.innerHTML = `<option value="">— ${this.t('loopManager.allInstruments')} —</option>`;
        for (const prog of programs) {
            const opt = document.createElement('option');
            opt.value = prog;
            opt.textContent = this._gmProgramName(prog);
            if (String(prog) === (current || String(this._libFilter))) opt.selected = true;
            sel.appendChild(opt);
        }
    }

    _loopCardHtml(loop) {
        const ts     = `${loop.time_sig_num}/${loop.time_sig_den}`;
        const prog   = loop.instrument_program ?? 0;
        const family = LoopUtils.familyForProgram(prog);
        const instrName = this._gmProgramName(prog);
        const densityHtml = loop.note_count != null
            ? `<div class="lc-card-density"><div class="lc-card-density-fill" style="width:${Math.min(100, (loop.note_count / Math.max(1, (loop.bars || 2) * 8)) * 100)}%; background:${family.color}"></div></div>`
            : '';
        const padIndexes = this._padSlots
            .map((s, i) => s?.loopId === loop.id ? (i + 1) : null)
            .filter(x => x != null);
        const padTagHtml = padIndexes.length
            ? `<span class="lc-card-pad-tag" title="${this.t('loopManager.assignedPadsTitle', { pads: padIndexes.join(', ') })}">📌 ${padIndexes.join(',')}</span>`
            : '';
        const playing = this._livePlayingLoops.has(loop.id);
        return `<div class="lc-card" draggable="true" data-loop-id="${loop.id}" style="--family-color:${family.color}"
            <div class="lc-card-name">${this.escape(loop.name)}${padTagHtml}</div>
            <div class="lc-card-meta">${loop.tempo} BPM · ${ts} · ${loop.bars} ${this.t('loopCreator.barsUnit')}</div>
            <div class="lc-card-instr">${this._instrIconHtml(prog, 'instrument', 'lc-instr-icon--sm')} ${this.escape(instrName)}</div>
            <div class="lc-card-actions">
                <button class="lc-card-btn lc-card-btn--play${playing ? ' lc-card-btn--playing' : ''}" data-action="live-trigger" data-loop-id="${loop.id}" title="${this.t('loopCreator.preview')}">${playing ? '⏹' : '▶'}</button>
                <button class="lc-card-btn" data-loop-action="edit"      data-loop-id="${loop.id}" title="${this.t('loopCreator.loadLoop')}">✏️</button>
                <button class="lc-card-btn" data-loop-action="duplicate" data-loop-id="${loop.id}" title="${this.t('loopManager.duplicateLoop')}">⎘</button>
                <button class="lc-card-btn" data-loop-action="pad"       data-loop-id="${loop.id}" title="${this.t('loopManager.addToPad')}">🎛</button>
                <button class="lc-card-btn lc-card-btn--danger" data-loop-action="delete" data-loop-id="${loop.id}" title="${this.t('loopCreator.deleteLoop')}">🗑</button>
            </div>
            ${densityHtml}
        </div>`;
    }

    async _duplicateLoopById(id) {
        try {
            const r = await this.api.sendCommand('loop_get', { loopId: id });
            const src = r.loop;
            if (!src) return;
            const copyName = this.t('loopManager.duplicateNameSuffix', { name: src.name });
            const payload = {
                name: copyName,
                tempo: src.tempo,
                time_sig_num: src.time_sig_num,
                time_sig_den: src.time_sig_den,
                bars: src.bars,
                ppq: src.ppq,
                instrument_program: src.instrument_program ?? 0,
                midi_data: typeof src.midi_data === 'string' ? src.midi_data : JSON.stringify(src.midi_data || [])
            };
            await this.api.sendCommand('loop_create', payload);
            LoopUtils.toast(this.t('loopManager.loopDuplicated'), 'success');
            await this._loadLibrary();
        } catch (err) {
            LoopUtils.handleError(err, 'manager.duplicateLoop', {
                toast: this.t('loopManager.errDuplicateLoop')
            });
        }
    }

    async _deleteLoopById(id) {
        try {
            await this.api.sendCommand('loop_delete', { loopId: id });
            this._fetchLoopDataCache.delete(id);
            // Remove from pad slots if assigned
            let padChanged = false;
            for (let i = 0; i < this._padSlots.length; i++) {
                if (this._padSlots[i]?.loopId === id) {
                    this._stopPad(i);
                    this._padSlots[i] = null;
                    padChanged = true;
                }
            }
            if (padChanged) this._persistPadLayout();
            // Remove from live playing
            this._liveStop(id);
            await this._loadLibrary();
            if (this.currentArrangementId && this.blocks.some(b => b.loop_id === id)) {
                await this._loadArrangementById(this.currentArrangementId);
            }
        } catch (err) {
            LoopUtils.handleError(err, 'manager.deleteLoop', {
                toast: this.t('loopManager.errDeleteLoop')
            });
        }
    }

    _onLoopSaved(loopId) {
        this._fetchLoopDataCache.delete(loopId);
        this._loadLibrary();
    }

    _gmProgramName(prog) {
        return GM_PROGRAM_NAMES[prog] || `Program ${prog}`;
    }

    /**
     * Render an SVG-first icon for a GM program, falling back to the LoopUtils
     * family emoji (and ultimately to a generic glyph). `kind` controls whether
     * we prefer the instrument-specific SVG ('instrument') or the family-level
     * SVG ('family'). `extraClass` is appended to the wrapper for sizing.
     */
    _instrIconHtml(prog, kind = 'instrument', extraClass = '') {
        const family = LoopUtils.familyForProgram(prog);
        const emoji  = family?.icon || '🎵';
        let svgUrl = null;
        const IF = (typeof window !== 'undefined') ? window.InstrumentFamilies : null;
        if (IF) {
            if (kind === 'instrument') {
                const ico = IF.resolveInstrumentIcon({ gmProgram: prog });
                svgUrl = ico?.svgUrl || null;
                if (!svgUrl && ico?.family) svgUrl = IF.familyIconUrl(ico.family.slug);
            } else {
                const fam = IF.getFamilyForProgram(prog);
                if (fam) svgUrl = IF.familyIconUrl(fam.slug);
            }
        }
        const wrap = `lc-instr-icon${extraClass ? ' ' + extraClass : ''}`;
        if (!svgUrl) return `<span class="${wrap}"><span class="lc-instr-emoji">${emoji}</span></span>`;
        return `<span class="${wrap}">`
             + `<img class="lc-instr-svg" src="${svgUrl}" alt="" loading="lazy" decoding="async"`
             + ` onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">`
             + `<span class="lc-instr-emoji" style="display:none">${emoji}</span>`
             + `</span>`;
    }

    // =========================================================
    // PAD TAB
    // =========================================================

    async _initPadSynth() {
        if (!this._padSynth) this._padSynth = await LoopUtils.createSynth();
    }

    _renderPadGrid() {
        const grid = this.$('#lm-pad-grid');
        if (!grid) return;
        const SHORTCUTS = ['1','2','3','4','q','w','e','r','a','s','d','f','z','x','c','v'];
        grid.innerHTML = this._padSlots.map((slot, i) => {
            const playing     = this._padPlayingIndex.has(i);
            const assigned    = slot !== null;
            const octaveGroup = Math.floor(i / 4);
            let iconHtml = '', familyColor = '';
            if (assigned) {
                const family = LoopUtils.familyForProgram(slot.instrument_program ?? 0);
                iconHtml = this._instrIconHtml(slot.instrument_program ?? 0, 'instrument', 'lm-pad-icon');
                familyColor = family.color;
            }
            const styleAttr = familyColor ? `style="--family-color:${familyColor}"` : '';
            const shortcut = SHORTCUTS[i];
            return `<div class="lm-pad-cell${assigned ? ' lm-pad-cell--assigned' : ''}${playing ? ' lm-pad-cell--playing' : ''}"
                data-pad-index="${i}" data-octave-group="${octaveGroup}" ${styleAttr}
                tabindex="0" role="button"
                aria-label="${assigned ? this.escape(slot.name) : this.t('loopManager.emptyPad', { index: i + 1 })}"
                title="${assigned ? this.escape(slot.name) : this.t('loopManager.padHint')}">
                <span class="lm-pad-shortcut" aria-hidden="true">${shortcut.toUpperCase()}</span>
                ${iconHtml}
                <span class="lm-pad-name">${assigned ? this.escape(slot.name) : '+'}</span>
                <span class="lm-pad-meta">${assigned ? `${slot.tempo}♩·${slot.bars}M` : ''}</span>
            </div>`;
        }).join('');

        if (!grid.dataset.lmPadWired) {
            grid.dataset.lmPadWired = '1';
            grid.addEventListener('click', (e) => {
                const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                if (cell) this._triggerPad(parseInt(cell.dataset.padIndex));
            });
            grid.addEventListener('keydown', (e) => {
                const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                if (!cell) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._triggerPad(parseInt(cell.dataset.padIndex)); }
            });
            grid.addEventListener('dragover', (e) => {
                const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                if (!cell) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                cell.classList.add('lm-pad-cell--drop-target');
            });
            grid.addEventListener('dragleave', (e) => {
                const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                if (cell) cell.classList.remove('lm-pad-cell--drop-target');
            });
            grid.addEventListener('drop', (e) => {
                const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                if (!cell) return;
                e.preventDefault();
                cell.classList.remove('lm-pad-cell--drop-target');
                try {
                    const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                    if (data.loopId) this._assignPadSlot(parseInt(cell.dataset.padIndex), data.loopId);
                } catch (err) {
                    LoopUtils.handleError(err, 'pad.drop.parse');
                }
            });
        }
    }

    async _loadPadMidiInDevices() {
        const sel = this.$('#lm-pad-midi-in');
        if (!sel) return;
        try {
            const allDevices = await this.api.listDevices();
            const devices = allDevices.filter(d => d.status === 2 || d.connected === true);
            const existing = sel.value;
            sel.innerHTML = `<option value="">${this.t('loopManager.padMidiInNone')}</option>`;
            for (const d of devices) {
                const id  = d.device_id || d.id;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = d.name || id;
                if (id === existing) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (err) {
            LoopUtils.handleError(err, 'pad.midiIn.list');
        }
    }

    async _triggerPad(index) {
        const slot = this._padSlots[index];
        if (!slot) return;

        if (this._padPlayingIndex.has(index)) {
            this._stopPad(index);
            return;
        }

        const loopData = await this._fetchLoopData(slot.loopId);
        if (!loopData) {
            LoopUtils.toast(this.t('loopManager.errLoopUnavailable'), 'error');
            return;
        }

        // Each pad uses its own MIDI channel (0-15) so multiple instruments can play simultaneously
        const ch = index;
        const target = this._getOutputTarget(this._padSynth);
        if (target) {
            const prog = loopData.instrument_program ?? 0;
            try { target.setChannelInstrument(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'pad.synth.setChannelInstrument'); }
            if (!target.loadedInstruments?.has(prog)) {
                await target.loadInstrument(prog).catch(err =>
                    LoopUtils.handleError(err, 'pad.synth.loadInstrument'));
            }
        }

        this._padPlayingIndex.add(index);
        this._updatePadCell(index);
        this._schedulePad(index, loopData, ch);
    }

    _schedulePad(index, loopData, channel = 0) {
        const seq       = LoopUtils.parseSequence(loopData.midi_data);
        const loopDurMs = LoopUtils.loopDurationMs(loopData);

        this._padPlayTimes.set(index, { startMs: performance.now(), durMs: loopDurMs });
        this._renderPlaybar();

        const isAlive = () => this._padPlayingIndex.has(index);
        const timers = LoopUtils.scheduleSequence({
            synth: this._getOutputTarget(this._padSynth),
            sequence: seq,
            tempo: loopData.tempo || 120,
            ppq:   loopData.ppq   || 480,
            channel,
            isAlive,
            cycleMs: loopDurMs + 50,
            onCycleEnd: () => {
                this._padPlayingIndex.delete(index);
                this._padPlayTimes.delete(index);
                (this._padPlaybackTimers.get(index) || []).forEach(t => clearTimeout(t));
                this._padPlaybackTimers.delete(index);
                this._updatePadCell(index);
                this._renderPlaybar();
            }
        });

        this._padPlaybackTimers.set(index, timers);
    }

    _stopPad(index) {
        (this._padPlaybackTimers.get(index) || []).forEach(t => clearTimeout(t));
        this._padPlaybackTimers.delete(index);
        this._padPlayingIndex.delete(index);
        this._padPlayTimes.delete(index);
        this._updatePadCell(index);
        this._renderPlaybar();
    }

    _stopAllPads() {
        for (let i = 0; i < 16; i++) this._stopPad(i);
        this._padPlayTimes.clear();
        try { this._padSynth?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'pad.synth.cancelAllNotes'); }
        try { this._deviceShim?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'pad.device.cancelAllNotes'); }
    }

    _updatePadCell(index) {
        const cell = this.$(`#lm-pad-grid .lm-pad-cell[data-pad-index="${index}"]`);
        if (!cell) return;
        const slot    = this._padSlots[index];
        const playing = this._padPlayingIndex.has(index);
        cell.classList.toggle('lm-pad-cell--playing', playing);
        cell.classList.toggle('lm-pad-cell--assigned', slot !== null);
    }

    _assignPadSlot(index, loopId) {
        const loop = this.library.find(l => l.id === loopId);
        if (!loop) return;
        this._stopPad(index);
        this._padSlots[index] = {
            loopId: loop.id, name: loop.name,
            tempo: loop.tempo, bars: loop.bars,
            instrument_program: loop.instrument_program ?? 0
        };
        this._renderPadGrid();
        this._closePadPicker();
        this._persistPadLayout();
        if (this.activeTab === 'library') this._filterAndRenderLibrary();
    }

    _openPadPicker(index, anchorEl) {
        // Reset any previous picker handler
        this._detachPadPickerHandler();
        this._padPickerIndex = index;
        const picker = this.$('#lm-pad-picker');
        if (!picker) return;

        picker.innerHTML = `
            <div class="lm-picker-title">${this.t('loopManager.assignPad')}</div>
            <input type="text" class="lm-picker-search" id="lm-picker-search"
                placeholder="${this.t('loopManager.search')}" autocomplete="off" />
            <div class="lm-picker-list">
                ${this.library.map(l => `
                <div class="lm-picker-item" data-assign-loop="${l.id}" data-search-name="${this.escape(l.name.toLowerCase())}">
                    <span class="lm-picker-name">${this.escape(l.name)}</span>
                    <span class="lm-picker-meta">${l.tempo}♩·${l.bars}M</span>
                </div>`).join('')}
                <div class="lm-picker-item lm-picker-item--clear" data-assign-loop="__clear__">
                    ${this.t('loopManager.clearPad')}
                </div>
            </div>`;

        const search = picker.querySelector('#lm-picker-search');
        if (search) {
            search.addEventListener('input', () => {
                const q = search.value.trim().toLowerCase();
                picker.querySelectorAll('.lm-picker-item[data-search-name]').forEach(el => {
                    el.style.display = (!q || el.dataset.searchName.includes(q)) ? '' : 'none';
                });
            });
            requestAnimationFrame(() => search.focus());
        }

        this._padPickerHandler = (e) => {
            const item = e.target.closest('[data-assign-loop]');
            if (!item) return;
            const val = item.dataset.assignLoop;
            if (val === '__clear__') {
                this._stopPad(index);
                this._padSlots[index] = null;
                this._renderPadGrid();
                this._closePadPicker();
                this._persistPadLayout();
            } else {
                this._assignPadSlot(index, parseInt(val));
            }
        };
        picker.addEventListener('click', this._padPickerHandler);

        // Position near anchor (fixed so it escapes any overflow:hidden containers)
        const rect = anchorEl.getBoundingClientRect();
        picker.style.left = rect.left + 'px';
        picker.style.top  = (rect.bottom + 4) + 'px';
        picker.style.display = 'block';
    }

    _detachPadPickerHandler() {
        if (this._padPickerHandler) {
            const picker = this.$('#lm-pad-picker');
            picker?.removeEventListener('click', this._padPickerHandler);
            this._padPickerHandler = null;
        }
    }

    _closePadPicker() {
        this._detachPadPickerHandler();
        this._padPickerIndex = null;
        const picker = this.$('#lm-pad-picker');
        if (picker) picker.style.display = 'none';
    }

    // ── Pad layout persistence (T2.3) ──────────────────────────
    _persistPadLayout() {
        LoopUtils.PadStorage.save(this._padSlots);
    }

    _loadPadLayout() {
        const saved = LoopUtils.PadStorage.load();
        if (Array.isArray(saved) && saved.length === 16) {
            this._padSlots = saved.map(s => s ? {
                loopId: s.loopId, name: s.name,
                tempo: s.tempo, bars: s.bars,
                instrument_program: s.instrument_program ?? 0
            } : null);
        }
    }

    _clearAllPads() {
        if (!confirm(this.t('loopManager.confirmClearAllPads'))) return;
        for (let i = 0; i < 16; i++) {
            this._stopPad(i);
            this._padSlots[i] = null;
        }
        this._renderPadGrid();
        this._persistPadLayout();
        LoopUtils.toast(this.t('loopManager.padsCleared'), 'success');
    }

    _exportPadLayout() {
        const json = LoopUtils.PadStorage.export(this._padSlots);
        try {
            const blob = new Blob([json], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url;
            a.download = `gmboop-pad-layout-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            LoopUtils.toast(this.t('loopManager.padLayoutExported'), 'success');
        } catch (err) {
            LoopUtils.handleError(err, 'pad.export', {
                toast: this.t('loopManager.errExport')
            });
        }
    }

    _importPadLayout() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const slots = LoopUtils.PadStorage.import(String(reader.result || ''));
                if (!slots || !Array.isArray(slots) || slots.length !== 16) {
                    LoopUtils.toast(this.t('loopManager.errImport'), 'error');
                    return;
                }
                this._stopAllPads();
                this._padSlots = slots.map(s => s ? {
                    loopId: s.loopId, name: s.name,
                    tempo: s.tempo, bars: s.bars,
                    instrument_program: s.instrument_program ?? 0
                } : null);
                this._renderPadGrid();
                this._persistPadLayout();
                LoopUtils.toast(this.t('loopManager.padLayoutImported'), 'success');
            };
            reader.onerror = (err) => LoopUtils.handleError(err, 'pad.import.read', {
                toast: this.t('loopManager.errImport')
            });
            reader.readAsText(file);
        });
        input.click();
    }

    // MIDI In for pads
    async _startPadMidiMonitor() {
        if (!this._padMidiInDevice || this._padMonitorActive) return;
        try {
            await this.api.sendCommand('monitor_start', { deviceId: this._padMidiInDevice });
            this._padMonitorActive = true;
            this._padMidiInHandler = (data) => {
                if (data.device !== this._padMidiInDevice) return;
                const type = (data.type || '').toLowerCase();
                const note = data.data?.note ?? data.data?.n;
                const vel  = data.data?.velocity ?? data.data?.v ?? 0;
                if (note == null) return;
                if (type === 'noteon' && vel > 0) {
                    const padIndex = note - 48; // C3 = pad 0
                    if (padIndex >= 0 && padIndex < 16) this._triggerPad(padIndex);
                }
            };
            this.api.on('monitor_event', this._padMidiInHandler);
            const status = this.$('#lm-pad-midi-status');
            if (status) status.textContent = '● MIDI';
        } catch (err) {
            LoopUtils.handleError(err, 'pad.midiIn.start', {
                toast: this.t('loopManager.errMidiIn')
            });
        }
    }

    async _stopPadMidiMonitor() {
        if (!this._padMonitorActive) return;
        this._padMonitorActive = false;
        if (this._padMidiInHandler) {
            this.api.off?.('monitor_event', this._padMidiInHandler);
            this._padMidiInHandler = null;
        }
        if (this._padMidiInDevice) {
            try { await this.api.sendCommand('monitor_stop', { deviceId: this._padMidiInDevice }); }
            catch (err) { LoopUtils.handleError(err, 'pad.midiIn.stop'); }
        }
        const status = this.$('#lm-pad-midi-status');
        if (status) status.textContent = '';
    }

    // =========================================================
    // LIVE TAB
    // =========================================================

    async _initLiveSynth() {
        if (!this._liveSynth) this._liveSynth = await LoopUtils.createSynth();
    }

    _renderLiveArea() {
        const area = this.$('#lm-live-area');
        if (!area) return;
        if (!this.library.length) {
            area.innerHTML = `<div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>`;
            return;
        }

        const q = (this._liveSearch || '').trim().toLowerCase();
        const filtered = q
            ? this.library.filter(l => l.name.toLowerCase().includes(q))
            : this.library;

        if (!filtered.length) {
            area.innerHTML = `<div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>`;
            return;
        }

        // Group loops by GM family
        const groups = new Map(); // familyName → { family, loops[] }
        for (const loop of filtered) {
            const family = LoopUtils.familyForProgram(loop.instrument_program ?? 0);
            if (!groups.has(family.name)) groups.set(family.name, { family, loops: [] });
            groups.get(family.name).loops.push(loop);
        }

        area.innerHTML = [...groups.values()].map(({ family, loops }) => `
        <div class="lm-live-group" style="--family-color:${family.color}">
            <div class="lm-live-group-header">
                ${this._instrIconHtml(family.start, 'family', 'lm-live-group-icon')}
                <span class="lm-live-group-name">${family.name}</span>
            </div>
            <div class="lm-live-loops">
                ${loops.map(l => {
                    const playing    = this._livePlayingLoops.has(l.id);
                    const tempoRange = l.tempo < 90 ? 'slow' : l.tempo < 140 ? 'medium' : 'fast';
                    return `<button class="lm-live-loop-btn${playing ? ' lm-live-loop-btn--playing' : ''}"
                        data-action="live-trigger" data-loop-id="${l.id}"
                        data-tempo-range="${tempoRange}">
                        <span class="lm-live-loop-name">${this.escape(l.name)}</span>
                        <span class="lm-live-loop-meta">${l.tempo}♩·${l.bars}M</span>
                    </button>`;
                }).join('')}
            </div>
        </div>`).join('');
    }

    async _liveTrigger(loopId) {
        if (this._livePlayingLoops.has(loopId)) {
            this._liveStop(loopId);
            return;
        }
        const loopData = await this._fetchLoopData(loopId);
        if (!loopData) {
            LoopUtils.toast(this.t('loopManager.errLoopUnavailable'), 'error');
            return;
        }

        // Allocate a unique channel so multiple instruments can play simultaneously
        const ch = this._allocLiveChannel();
        const target = this._getOutputTarget(this._liveSynth);
        if (target) {
            const prog = loopData.instrument_program ?? 0;
            try { target.setChannelInstrument(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'live.synth.setChannelInstrument'); }
            if (!target.loadedInstruments?.has(prog)) {
                await target.loadInstrument(prog).catch(err =>
                    LoopUtils.handleError(err, 'live.synth.loadInstrument'));
            }
        }

        const loopDurMs = LoopUtils.loopDurationMs(loopData);
        this._livePlayingLoops.set(loopId, { timers: [], ch, startMs: performance.now(), durMs: loopDurMs });
        this._updateLiveButton(loopId, true);
        this._scheduleLiveLoop(loopId, loopData);
        this._renderPlaybar();
    }

    _scheduleLiveLoop(loopId, loopData) {
        if (!this._livePlayingLoops.has(loopId)) return;
        const state = this._livePlayingLoops.get(loopId);
        const ch    = state.ch ?? 0;

        const seq       = LoopUtils.parseSequence(loopData.midi_data);
        const loopDurMs = LoopUtils.loopDurationMs(loopData);

        // Reset cycle start time and clear old timers
        state.timers.forEach(t => clearTimeout(t));
        state.startMs = performance.now();
        state.durMs   = loopDurMs;

        const isAlive = () => this._livePlayingLoops.has(loopId);
        state.timers = LoopUtils.scheduleSequence({
            synth: this._getOutputTarget(this._liveSynth),
            sequence: seq,
            tempo: loopData.tempo || 120,
            ppq:   loopData.ppq   || 480,
            channel: ch,
            isAlive,
            cycleMs: loopDurMs,
            onCycleEnd: () => { if (isAlive()) this._scheduleLiveLoop(loopId, loopData); }
        });
    }

    _liveStop(loopId) {
        const state = this._livePlayingLoops.get(loopId);
        if (!state) return;
        state.timers.forEach(t => clearTimeout(t));
        this._livePlayingLoops.delete(loopId);
        this._updateLiveButton(loopId, false);
        this._renderPlaybar();
    }

    _liveStopAll() {
        for (const loopId of [...this._livePlayingLoops.keys()]) this._liveStop(loopId);
        try { this._liveSynth?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'live.synth.cancelAllNotes'); }
        try { this._deviceShim?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'live.device.cancelAllNotes'); }
    }

    _updateLiveButton(loopId, playing) {
        const buttons = this.$$(`[data-action="live-trigger"][data-loop-id="${loopId}"]`);
        buttons.forEach(btn => {
            btn.classList.toggle('lm-live-loop-btn--playing', playing);
            if (btn.classList.contains('lc-card-btn--play')) {
                btn.classList.toggle('lc-card-btn--playing', playing);
                btn.textContent = playing ? '⏹' : '▶';
            }
        });
    }

    // =========================================================
    // ARRANGER — INIT
    // =========================================================

    async _initArrangerSynth() {
        if (!this._arrangerSynth) this._arrangerSynth = await LoopUtils.createSynth({ initialProgram: 0 });
    }

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
        } catch (err) {
            LoopUtils.handleError(err, 'arr.list');
        }
    }

    _renderArrList(arrs) {
        const el = this.$('#la-arr-list');
        if (!el) return;
        if (!arrs.length) { el.innerHTML = `<div class="lc-empty">${this.t('loopCreator.arrangementsEmpty')}</div>`; return; }
        el.innerHTML = arrs.map(a => `
            <div class="la-arr-item${a.id===this.currentArrangementId ? ' la-arr-item--active':''}"
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

    _newArrangementConfirm() {
        const hasContent = (this.blocks?.length || 0) > 0 || (this.tracks?.length || 0) > 0;
        if (hasContent && this._arrDirty) {
            if (!confirm(this.t('loopManager.confirmNewArrangement'))) return;
        }
        this._newArrangement();
    }

    async _newArrangement() {
        try {
            const r = await this.api.sendCommand('arrangement_create', {
                name: this.t('loopCreator.untitledArrangement'),
                global_tempo: this.arrangementTempo, total_bars: this.arrangementBars
            });
            this.currentArrangementId = r.arrangementId;
            await this._loadArrangementById(r.arrangementId);
            await this._loadArrangements();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.new', {
                toast: this.t('loopManager.errCreateArrangement')
            });
        }
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
            this._resetArrHistory();
            this._selectedBlocks.clear();
            const f = (id, v) => { const el = this.$(id); if (el) el.value = v; };
            f('#la-name-input', arrangement.name);
            f('#la-tempo',      arrangement.global_tempo);
            f('#la-bars',       arrangement.total_bars);
            this._renderTimeline();
            this._renderArrList([arrangement]);
        } catch (err) {
            LoopUtils.handleError(err, 'arr.load', {
                toast: this.t('loopManager.errLoadArrangement')
            });
        }
    }

    // =========================================================
    // ARRANGER — UNDO/REDO HISTORY (T3)
    // =========================================================

    _snapshotArr() {
        return {
            tracks: this.tracks.map(t => ({ ...t })),
            blocks: this.blocks.map(b => ({ ...b }))
        };
    }

    _resetArrHistory() {
        this._arrHistory = [this._snapshotArr()];
        this._arrHistoryIdx = 0;
        this._refreshUndoButtons();
        this._markArrDirty(false);
    }

    _pushArrHistory() {
        // Drop forward history if we branched
        this._arrHistory = this._arrHistory.slice(0, this._arrHistoryIdx + 1);
        this._arrHistory.push(this._snapshotArr());
        if (this._arrHistory.length > ARRANGER_HISTORY_LIMIT) {
            this._arrHistory.shift();
        } else {
            this._arrHistoryIdx++;
        }
        this._refreshUndoButtons();
        this._markArrDirty(true);
    }

    _arrUndo() {
        if (this._arrHistoryIdx <= 0) return;
        this._arrHistoryIdx--;
        this._restoreArrSnapshot(this._arrHistory[this._arrHistoryIdx]);
    }

    _arrRedo() {
        if (this._arrHistoryIdx >= this._arrHistory.length - 1) return;
        this._arrHistoryIdx++;
        this._restoreArrSnapshot(this._arrHistory[this._arrHistoryIdx]);
    }

    _restoreArrSnapshot(snap) {
        if (!snap) return;
        this.tracks = snap.tracks.map(t => ({ ...t }));
        this.blocks = snap.blocks.map(b => ({ ...b }));
        this._selectedBlocks.clear();
        this._renderTimeline();
        this._refreshUndoButtons();
        this._markArrDirty(true);
    }

    _markArrDirty(dirty) {
        this._arrDirty = !!dirty;
        const saveBtn = this.$('#lc-header-save');
        if (saveBtn) saveBtn.classList.toggle('lc-btn--dirty', this._arrDirty);
    }

    _refreshUndoButtons() {
        const u = this.$('#la-undo-btn');
        const r = this.$('#la-redo-btn');
        if (u) u.disabled = this._arrHistoryIdx <= 0;
        if (r) r.disabled = this._arrHistoryIdx >= this._arrHistory.length - 1;
    }

    // =========================================================
    // ARRANGER — PALETTE
    // =========================================================

    _renderPalette() {
        const grid = this.$('#la-palette-grid');
        if (!grid) return;
        if (!this.library.length) { grid.innerHTML = `<div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>`; return; }
        grid.innerHTML = this.library.map(loop => {
            const family = LoopUtils.familyForProgram(loop.instrument_program ?? 0);
            return `<div class="la-palette-chip" draggable="true" data-loop-id="${loop.id}"
                data-loop-bars="${loop.bars}" data-loop-name="${this.escape(loop.name)}"
                style="--family-color:${family.color}">
                <div class="la-chip-name">${this._instrIconHtml(loop.instrument_program ?? 0, 'instrument', 'la-chip-icon')} ${this.escape(loop.name)}</div>
                <div class="la-chip-meta">${loop.bars}${this.t('loopCreator.barsUnit')}</div>
            </div>`;
        }).join('');
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

    _renderTimeline() { this._renderRuler(); this._renderTracks(); this._renderPalette(); this._refreshBlockSelectionUI(); }

    _renderRuler() {
        const ruler = this.$('#la-ruler');
        if (!ruler) return;
        const BAR_W = this._barWidth();
        let html = '';
        for (let b = 0; b < this.arrangementBars; b++) {
            const marker = (b % 4 === 0) ? `<span class="la-ruler-label">${b+1}</span>` : '';
            html += `<div class="la-ruler-cell" style="width:${BAR_W}px">${marker}</div>`;
        }
        ruler.style.width = (BAR_W * this.arrangementBars) + 'px';
        ruler.innerHTML = html;
    }

    _renderTracks() {
        const container = this.$('#la-tracks');
        if (!container) return;
        container.innerHTML = '';
        for (const track of this.tracks) container.appendChild(this._buildTrackEl(track));
    }

    _buildTrackEl(track) {
        const BAR_W  = this._barWidth();
        const totalW = BAR_W * this.arrangementBars;
        const trackEl = document.createElement('div');
        trackEl.className = 'la-track';
        trackEl.dataset.trackId = track.id;
        trackEl.innerHTML = `
            <div class="la-track-label">
                <input type="text" class="la-track-name-input lc-name-input" value="${this.escape(track.label)}" data-track-id="${track.id}" />
                <button class="lc-card-btn lc-card-btn--danger" data-track-action="delete" data-track-id="${track.id}" title="${this.t('loopCreator.deleteTrack')}">✕</button>
            </div>
            <div class="la-track-cells" data-track-id="${track.id}" style="width:${totalW}px">
                ${this._buildCells(track.id, BAR_W)}
            </div>`;

        const cells = trackEl.querySelector('.la-track-cells');
        cells.addEventListener('dragstart', (e) => {
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (!blockEl) return;
            const blockId = parseInt(blockEl.dataset.blockId);
            const block = this.blocks.find(b => b.id === blockId);
            if (!block) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify({
                source:   'block',
                blockId,
                loopBars: block.loop_bars,
                reps:     block.repetitions
            }));
            blockEl.classList.add('la-block--dragging');
        });
        cells.addEventListener('dragend', (e) => {
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (blockEl) blockEl.classList.remove('la-block--dragging');
            this._hideDropPreview();
        });
        cells.addEventListener('dragover',  (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = (e.dataTransfer.types?.length ? 'move' : 'copy');
            this._showDropPreview(cells, this._barFromX(e.offsetX, BAR_W), BAR_W);
        });
        cells.addEventListener('dragleave', () => this._hideDropPreview());
        cells.addEventListener('drop',      (e) => {
            e.preventDefault(); this._hideDropPreview();
            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                const bar = this._barFromX(e.offsetX, BAR_W);
                if (data.source === 'block' && data.blockId) {
                    this._moveBlock(data.blockId, track.id, bar);
                } else if (data.loopId) {
                    this._addBlock(track.id, data.loopId, bar, data.loopBars || 2);
                }
            } catch (err) {
                LoopUtils.handleError(err, 'arr.drop.parse');
            }
        });

        // Wire block actions and selection (single delegated listener — no setTimeout race)
        cells.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('[data-block-action]');
            if (actionBtn) {
                e.stopPropagation();
                const bid = parseInt(actionBtn.dataset.blockId);
                if (actionBtn.dataset.blockAction === 'reps-inc') this._changeReps(bid, +1);
                if (actionBtn.dataset.blockAction === 'reps-dec') this._changeReps(bid, -1);
                if (actionBtn.dataset.blockAction === 'delete')   this._deleteBlock(bid);
                return;
            }
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (blockEl) {
                const bid = parseInt(blockEl.dataset.blockId);
                this._toggleBlockSelection(bid, e.shiftKey || e.metaKey || e.ctrlKey);
            }
        });

        const nameInput = trackEl.querySelector('.la-track-name-input');
        nameInput?.addEventListener('change', async () => {
            try {
                await this.api.sendCommand('arrangement_update_track', { trackId: track.id, label: nameInput.value });
                const t = this.tracks.find(x => x.id === track.id);
                if (t) t.label = nameInput.value;
                this._pushArrHistory();
            } catch (err) {
                LoopUtils.handleError(err, 'arr.track.rename', {
                    toast: this.t('loopManager.errSave')
                });
            }
        });
        trackEl.querySelector('[data-track-action="delete"]')?.addEventListener('click', () => this._deleteTrack(track.id));
        return trackEl;
    }

    _buildCells(trackId, BAR_W) {
        let html = '';
        this.blocks.filter(b => b.track_id === trackId).forEach((block) => {
            const loop   = this.library.find(l => l.id === block.loop_id);
            const family = LoopUtils.familyForProgram(loop?.instrument_program ?? 0);
            const blockW = block.loop_bars * block.repetitions * BAR_W;
            const blockL = block.position_bar * BAR_W;
            const selected = this._selectedBlocks.has(block.id);
            html += `<div class="la-block${selected ? ' la-block--selected' : ''}"
                draggable="true" data-block-id="${block.id}" data-loop-bars="${block.loop_bars}"
                data-block-reps="${block.repetitions}"
                data-wide="${blockW >= 70 ? 'true' : 'false'}"
                style="left:${blockL}px;width:${blockW}px;background:${family.color}"
                title="${this.t('loopManager.blockDragHint')}">
                <div class="la-block-label">${this._instrIconHtml(loop?.instrument_program ?? 0, 'instrument', 'la-block-icon')} ${this.escape(block.loop_name)} ×${block.repetitions}</div>
                <div class="la-block-actions">
                    <button class="la-block-btn" draggable="false" data-block-action="reps-dec" data-block-id="${block.id}">−</button>
                    <span class="la-block-reps">${block.repetitions}</span>
                    <button class="la-block-btn" draggable="false" data-block-action="reps-inc" data-block-id="${block.id}">+</button>
                    <button class="la-block-btn la-block-btn--del" draggable="false" data-block-action="delete" data-block-id="${block.id}" title="${this.t('loopCreator.deleteBlock')}">✕</button>
                </div>
            </div>`;
        });
        return html;
    }

    _toggleBlockSelection(blockId, additive) {
        if (additive) {
            if (this._selectedBlocks.has(blockId)) this._selectedBlocks.delete(blockId);
            else this._selectedBlocks.add(blockId);
        } else {
            const onlyOne = this._selectedBlocks.size === 1 && this._selectedBlocks.has(blockId);
            this._selectedBlocks.clear();
            if (!onlyOne) this._selectedBlocks.add(blockId);
        }
        this._refreshBlockSelectionUI();
    }

    _clearBlockSelection() {
        if (!this._selectedBlocks.size) return;
        this._selectedBlocks.clear();
        this._refreshBlockSelectionUI();
    }

    _refreshBlockSelectionUI() {
        this.$$('.la-block').forEach(el => {
            const bid = parseInt(el.dataset.blockId);
            el.classList.toggle('la-block--selected', this._selectedBlocks.has(bid));
        });
    }

    async _deleteSelectedBlocks() {
        const ids = [...this._selectedBlocks];
        if (!ids.length) return;
        for (const bid of ids) {
            try {
                await this.api.sendCommand('arrangement_delete_block', { blockId: bid });
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.deleteMulti', {
                    toast: this.t('loopManager.errSave')
                });
            }
        }
        this.blocks = this.blocks.filter(b => !this._selectedBlocks.has(b.id));
        this._selectedBlocks.clear();
        this._renderTimeline();
        this._pushArrHistory();
    }

    _barWidth() {
        const wrap = this.$('#la-timeline-wrap');
        const available = (wrap?.clientWidth || 800) - 140;
        const base = Math.max(24, Math.min(60, Math.floor(available / this.arrangementBars)));
        const zoomed = Math.round(base * (this._arrangerZoom || 1));
        return Math.max(12, Math.min(240, zoomed));
    }

    _arrZoom(factor) {
        const next = Math.max(0.25, Math.min(8, (this._arrangerZoom || 1) * factor));
        if (next === this._arrangerZoom) return;
        this._arrangerZoom = next;
        this._renderTimeline();
    }

    _arrZoomReset() {
        if (this._arrangerZoom === 1) return;
        this._arrangerZoom = 1;
        this._renderTimeline();
    }

    _barFromX(offsetX, barW) {
        return Math.max(0, Math.min(this.arrangementBars - 1, Math.floor(offsetX / barW)));
    }

    _showDropPreview(cells, bar, barW) {
        this._hideDropPreview();
        const preview = document.createElement('div');
        preview.className  = 'la-drop-preview';
        preview.style.left  = (bar * barW) + 'px';
        preview.style.width = barW + 'px';
        cells.appendChild(preview);
        this._dropPreview = preview;
    }

    _hideDropPreview() { this._dropPreview?.remove(); this._dropPreview = null; }

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
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.track.add', {
                toast: this.t('loopManager.errSave')
            });
        }
    }

    async _deleteTrack(trackId) {
        try {
            await this.api.sendCommand('arrangement_delete_track', { trackId });
            this.tracks = this.tracks.filter(t => t.id !== trackId);
            this.blocks = this.blocks.filter(b => b.track_id !== trackId);
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.track.delete', {
                toast: this.t('loopManager.errSave')
            });
        }
    }

    async _addBlock(trackId, loopId, positionBar, loopBars) {
        try {
            const r = await this.api.sendCommand('arrangement_add_block', {
                trackId, loopId, position_bar: positionBar, repetitions: 1
            });
            const loop = this.library.find(l => l.id === loopId);
            this.blocks.push({
                id: r.blockId, track_id: trackId, loop_id: loopId,
                position_bar: positionBar, repetitions: 1,
                loop_name: loop?.name || '?', loop_bars: loop?.bars || loopBars
            });
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.add', {
                toast: this.t('loopManager.errSave')
            });
        }
    }

    async _moveBlock(blockId, newTrackId, newPositionBar) {
        const block = this.blocks.find(b => b.id === blockId);
        if (!block) return;
        if (block.track_id === newTrackId && block.position_bar === newPositionBar) return;
        try {
            await this.api.sendCommand('arrangement_update_block', {
                blockId,
                track_id: newTrackId,
                position_bar: newPositionBar
            });
            block.track_id     = newTrackId;
            block.position_bar = newPositionBar;
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.move', {
                toast: this.t('loopManager.errSave')
            });
        }
    }

    async _changeReps(blockId, delta) {
        const block = this.blocks.find(b => b.id === blockId);
        if (!block) return;
        const newReps = Math.max(1, block.repetitions + delta);
        try {
            await this.api.sendCommand('arrangement_update_block', { blockId, repetitions: newReps });
            block.repetitions = newReps;
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.update', {
                toast: this.t('loopManager.errSave')
            });
        }
    }

    async _deleteBlock(blockId) {
        try {
            await this.api.sendCommand('arrangement_delete_block', { blockId });
            this.blocks = this.blocks.filter(b => b.id !== blockId);
            this._selectedBlocks.delete(blockId);
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.delete', {
                toast: this.t('loopManager.errSave')
            });
        }
    }

    async _saveArrangement() {
        this.arrangementName = this.$('#la-name-input')?.value?.trim() || this.t('loopCreator.untitledArrangement');
        const tempo = LoopUtils.validate.tempo(this.$('#la-tempo')?.value, this.arrangementTempo);
        const bars  = LoopUtils.validate.arrBars(this.$('#la-bars')?.value, this.arrangementBars);
        try {
            if (this.currentArrangementId) {
                await this.api.sendCommand('arrangement_update', {
                    arrangementId: this.currentArrangementId,
                    name: this.arrangementName, global_tempo: tempo, total_bars: bars
                });
                await this._loadArrangements();
                this._markArrDirty(false);
                LoopUtils.toast(this.t('loopCreator.statusSaved'), 'success');
            }
        } catch (err) {
            LoopUtils.handleError(err, 'arr.save', {
                toast: `${this.t('loopCreator.statusError')}: ${err.message}`
            });
        }
    }

    async _deleteArrangement(id) {
        try {
            await this.api.sendCommand('arrangement_delete', { arrangementId: id });
            if (this.currentArrangementId === id) await this._newArrangement();
            await this._loadArrangements();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.delete', {
                toast: this.t('loopManager.errSave')
            });
        }
    }

    _adjustArrTempo(d) {
        this.arrangementTempo = LoopUtils.validate.tempo(this.arrangementTempo + d, this.arrangementTempo);
        const el = this.$('#la-tempo'); if (el) el.value = this.arrangementTempo;
    }

    _adjustArrBars(d) {
        this.arrangementBars = LoopUtils.validate.arrBars(this.arrangementBars + d, this.arrangementBars);
        const el = this.$('#la-bars'); if (el) el.value = this.arrangementBars;
        this._renderTimeline();
    }

    // =========================================================
    // ARRANGER — PLAYBACK
    // =========================================================

    async _playArrangement() {
        if (!this.currentArrangementId || this.isArrangerPlaying) return;
        this._stopArrangerPlay();
        this.isArrangerPlaying = true;
        this.$('#la-play-btn')?.classList.add('lc-btn-record--active');

        const secPerBar  = 60 / this.arrangementTempo * 4;
        const events = [];
        const programsToLoad = new Set([0]);

        for (const block of this.blocks) {
            const loopData = await this._fetchLoopData(block.loop_id);
            if (!loopData) continue;
            const prog      = loopData.instrument_program ?? 0;
            programsToLoad.add(prog);
            const seq       = LoopUtils.parseSequence(loopData.midi_data);
            const loopTempo = loopData.tempo || 120;
            const loopPPQ   = loopData.ppq   || 480;
            const spt       = 60 / (loopTempo * loopPPQ);
            const loopDurSec = loopData.bars * (60 / loopTempo) * 4;
            for (let rep = 0; rep < block.repetitions; rep++) {
                const offsetSec = block.position_bar * secPerBar + rep * loopDurSec;
                for (const note of seq) {
                    events.push({ ms: (offsetSec + note.t * spt) * 1000, note: note.n, vel: note.v || 80, durSec: (note.g || note.l || 120) * spt, prog });
                }
            }
        }

        const target = this._getOutputTarget(this._arrangerSynth);

        // Preload all instruments used
        if (target) {
            for (const prog of programsToLoad) {
                if (!target.loadedInstruments?.has(prog)) {
                    await target.loadInstrument(prog).catch(err =>
                        LoopUtils.handleError(err, 'arr.synth.loadInstrument'));
                }
            }
        }

        // Assign each unique program to its own MIDI channel so they play simultaneously
        const programChannelMap = new Map();
        let chIdx = 0;
        for (const prog of programsToLoad) {
            const ch = chIdx++ % 16;
            programChannelMap.set(prog, ch);
            try { target?.setChannelInstrument?.(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'arr.synth.setChannelInstrument'); }
        }

        // Sort by time and schedule notes on their assigned channels
        events.sort((a, b) => a.ms - b.ms);

        for (const ev of events) {
            const evCh = programChannelMap.get(ev.prog) ?? 0;
            this._arrangerTimers.push(setTimeout(() => {
                if (!this.isArrangerPlaying) return;
                try { target?.playNote?.(ev.note, ev.vel, evCh, ev.durSec); }
                catch (err) { LoopUtils.handleError(err, 'arr.synth.playNote'); }
            }, ev.ms));
        }
        const totalMs = this.arrangementBars * secPerBar * 1000;
        this._arrangerTimers.push(setTimeout(() => this._stopArrangerPlay(), totalMs));

        this._arrangerStartTime = performance.now();
        this._startPlaybarRAF();
    }

    _stopArrangerPlay() {
        this._arrangerTimers.forEach(t => clearTimeout(t));
        this._arrangerTimers = [];
        this.isArrangerPlaying = false;
        this.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
        try { this._arrangerSynth?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'arr.synth.cancelAllNotes'); }
        try { this._deviceShim?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'arr.device.cancelAllNotes'); }
        this._stopPlaybarRAF();
        this._renderPlaybar();
    }

    // =========================================================
    // LIVE — CHANNEL ALLOCATION
    // =========================================================

    _allocLiveChannel() {
        const used = new Set([...this._livePlayingLoops.values()].map(s => s.ch).filter(c => c != null));
        for (let c = 0; c < 16; c++) {
            if (!used.has(c)) return c;
        }
        return 0; // all 16 channels in use: wrap around
    }

    // =========================================================
    // PLAYBACK TIMELINE BAR
    // =========================================================

    _startPlaybarRAF() {
        if (this._playbarRAF) return;
        const tick = () => {
            this._renderPlaybar();
            if (this.isArrangerPlaying) {
                this._playbarRAF = requestAnimationFrame(tick);
            } else {
                this._playbarRAF = null;
            }
        };
        this._playbarRAF = requestAnimationFrame(tick);
    }

    _stopPlaybarRAF() {
        if (this._playbarRAF) { cancelAnimationFrame(this._playbarRAF); this._playbarRAF = null; }
    }

    _renderArrangerPlayhead(elapsedSec) {
        const ph = this.$('#la-playhead');
        if (!ph) return;
        if (elapsedSec == null || !this.isArrangerPlaying) {
            ph.style.display = 'none';
            return;
        }
        const BAR_W = this._barWidth();
        const secPerBar = 60 / this.arrangementTempo * 4;
        const bar = Math.min(this.arrangementBars, elapsedSec / secPerBar);
        // la-track-label is 120px wide and pinned at left:0 within the timeline
        // wrap, so the cells lane begins at x=120px.
        const xWithinTracks = bar * BAR_W;
        ph.style.display = 'block';
        ph.style.transform = `translateX(${120 + xWithinTracks}px)`;
    }

    _renderPlaybar() {
        const fill = this.$('#lc-playbar-fill');
        if (!fill) return;

        if (this.isArrangerPlaying && this._arrangerStartTime) {
            fill.classList.remove('lc-playbar-fill--looping');
            fill.style.removeProperty('--playbar-dur');
            const secPerBar = 60 / this.arrangementTempo * 4;
            const totalMs   = this.arrangementBars * secPerBar * 1000;
            const elapsed   = performance.now() - this._arrangerStartTime;
            const pct = Math.min(100, elapsed / totalMs * 100);
            fill.style.width = pct + '%';
            this._renderArrangerPlayhead(elapsed / 1000);
            return;
        }
        this._renderArrangerPlayhead(null);

        const hasPad  = this._padPlayingIndex.size > 0;
        const hasLive = this._livePlayingLoops.size > 0;
        if (hasPad || hasLive) {
            // Use the shortest active loop duration to pace the fill animation
            let minDurMs = Infinity;
            for (const [idx, data] of this._padPlayTimes) {
                if (this._padPlayingIndex.has(idx) && data.durMs < minDurMs) minDurMs = data.durMs;
            }
            for (const [, state] of this._livePlayingLoops) {
                if (state.durMs && state.durMs < minDurMs) minDurMs = state.durMs;
            }
            if (!isFinite(minDurMs)) minDurMs = 2000;
            fill.style.setProperty('--playbar-dur', (minDurMs / 1000).toFixed(3) + 's');
            if (!fill.classList.contains('lc-playbar-fill--looping')) {
                fill.classList.add('lc-playbar-fill--looping');
            }
        } else {
            fill.classList.remove('lc-playbar-fill--looping');
            fill.style.width = '0%';
        }
    }

    // =========================================================
    // KEYBOARD TAB — live performance alongside loops
    // =========================================================

    async _enterKeyboardTab() {
        if (!this._kbdSynth) {
            this._kbdSynth = await LoopUtils.createSynth({ initialProgram: this._kbdInstrument });
        }
        if (!this._kbdMounted) this._mountKbdPanel();
    }

    _mountKbdPanel() {
        const container = this.$('#lm-kbd-panel');
        if (!container || !window.keyboardModal) return;
        if (window.keyboardModal._panelMode) {
            // Editor (or another host) currently owns the keyboard panel —
            // give them precedence; we'll mount on next tab activation.
            return;
        }
        try {
            window.keyboardModal.mountAsPanel(container, {
                onNoteOn:  (note, vel) => this._kbdNoteOn(note, vel),
                onNoteOff: (note)      => this._kbdNoteOff(note),
                onInstrumentSelected: ({ deviceId, channel, gmProgram }) => {
                    // Cancel any sustained voice before switching instrument /
                    // device so it doesn't keep ringing on the previous program.
                    this._kbdStopAllNotes();
                    this._kbdOutputDevice  = deviceId || null;
                    this._kbdOutputChannel = channel ?? 0;
                    this._kbdInstrument    = gmProgram ?? 0;
                    if (this._kbdSynth) {
                        try { this._kbdSynth.setChannelInstrument(0, this._kbdInstrument); }
                        catch (err) { LoopUtils.handleError(err, 'kbd.synth.setChannelInstrument'); }
                        if (!this._kbdSynth.loadedInstruments?.has(this._kbdInstrument)) {
                            this._kbdSynth.loadInstrument(this._kbdInstrument).catch(err =>
                                LoopUtils.handleError(err, 'kbd.synth.loadInstrument'));
                        }
                    }
                    // Auto-flip the output toggle if the user picks a real device.
                    if (deviceId && this._kbdOutputTarget !== 'live') {
                        this._kbdOutputTarget = 'live';
                        this._refreshKbdOutputUI();
                    } else if (!deviceId && this._kbdOutputTarget !== 'synth') {
                        this._kbdOutputTarget = 'synth';
                        this._refreshKbdOutputUI();
                    }
                }
            });
            this._kbdMounted = true;
        } catch (err) {
            LoopUtils.handleError(err, 'kbd.mount', {
                toast: this.t('loopManager.errKbdMount')
            });
        }
    }

    _unmountKbdPanel() {
        try { window.keyboardModal?.unmountPanel?.(); }
        catch (err) { LoopUtils.handleError(err, 'kbd.unmount'); }
        this._kbdMounted = false;
        this._kbdStopAllNotes();
    }

    _kbdNoteOn(note, velocity = 80) {
        if (this._kbdActiveKeys.has(note)) return;
        this._kbdActiveKeys.add(note);
        if (this._kbdOutputTarget === 'live' && this._kbdOutputDevice) {
            this.api.sendCommand('midi_send_note', {
                deviceId: this._kbdOutputDevice,
                channel:  this._kbdOutputChannel ?? 0,
                note, velocity
            }).catch(err => LoopUtils.handleError(err, 'kbd.live.noteOn'));
            return;
        }
        if (!this._kbdSynth) return;
        try {
            const env = this._kbdSynth.playNote(note, velocity, 0, 9999);
            if (env) this._kbdEnvelopes.set(note, env);
        } catch (err) {
            LoopUtils.handleError(err, 'kbd.synth.playNote');
        }
    }

    _kbdNoteOff(note) {
        this._kbdActiveKeys.delete(note);
        if (this._kbdOutputTarget === 'live' && this._kbdOutputDevice) {
            this.api.sendCommand('midi_send_note', {
                deviceId: this._kbdOutputDevice,
                channel:  this._kbdOutputChannel ?? 0,
                note, velocity: 0
            }).catch(err => LoopUtils.handleError(err, 'kbd.live.noteOff'));
            return;
        }
        const env = this._kbdEnvelopes.get(note);
        if (!env) return;
        for (const e of env) {
            try { e?.cancel?.(); }
            catch (err) { LoopUtils.handleError(err, 'kbd.synth.cancel'); }
        }
        this._kbdEnvelopes.delete(note);
    }

    _kbdStopAllNotes() {
        // Live device: send a note-off for every held note before clearing.
        if (this._kbdOutputTarget === 'live' && this._kbdOutputDevice && this._kbdActiveKeys.size) {
            for (const n of this._kbdActiveKeys) {
                this.api.sendCommand('midi_send_note', {
                    deviceId: this._kbdOutputDevice,
                    channel:  this._kbdOutputChannel ?? 0,
                    note: n, velocity: 0
                }).catch(err => LoopUtils.handleError(err, 'kbd.live.flushNoteOff'));
            }
        }
        // Synth: cancel any envelopes still ringing.
        for (const env of this._kbdEnvelopes.values()) {
            for (const e of env) { try { e?.cancel?.(); } catch (_) { /* best-effort */ } }
        }
        this._kbdEnvelopes.clear();
        this._kbdActiveKeys.clear();
    }

    _kbdToggleOutput() {
        // Release any held note on the previous target to avoid stuck notes.
        this._kbdStopAllNotes();
        this._kbdOutputTarget = this._kbdOutputTarget === 'synth' ? 'live' : 'synth';
        this._refreshKbdOutputUI();
    }

    _refreshKbdOutputUI() {
        const btn   = this.$('#lm-kbd-output-btn');
        const label = this.$('#lm-kbd-output-label');
        const isLive = this._kbdOutputTarget === 'live';
        if (btn) {
            btn.textContent = isLive ? '🔌' : '🔊';
            btn.classList.toggle('lc-btn-output--active', isLive);
        }
        if (label) label.textContent = isLive ? this.t('loopManager.outputLive') : this.t('loopManager.outputSynth');
    }

    // =========================================================
    // SHARED — FETCH LOOP DATA
    // =========================================================

    async _fetchLoopData(loopId) {
        if (this._fetchLoopDataCache.has(loopId)) return this._fetchLoopDataCache.get(loopId);
        try {
            const r = await this.api.sendCommand('loop_get', { loopId });
            this._fetchLoopDataCache.set(loopId, r.loop);
            return r.loop;
        } catch (err) {
            LoopUtils.handleError(err, 'loop.fetch');
            return null;
        }
    }

    // =========================================================
    // DRAG (doc-level for arranger block moves — future)
    // =========================================================

    _onDocMouseUp()   {}
    _onDocMouseMove() {}
}

// Expose both names for backward compatibility
if (typeof window !== 'undefined') {
    window.LoopManagerModal  = LoopManagerModal;
    window.LoopCreatorModal  = LoopManagerModal;
}
