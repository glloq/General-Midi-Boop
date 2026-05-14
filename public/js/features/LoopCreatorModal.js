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
    /** Back-compat: feature owns the loop array; modal exposes it readonly. */
    get library() { return this.libraryFeature?.library || []; }
    /** Back-compat: Library cards read this Map to display play indicator. */
    get _livePlayingLoops() { return this.liveFeature?.playingLoops || new Map(); }
    /** Back-compat: a few call-sites read modal._liveSynth directly. */
    get _liveSynth() { return this.liveFeature?.synth || null; }
    /** Back-compat: Library cards / _deleteLoopById read this array. */
    get _padSlots() { return this.padFeature?.slots || []; }
    /** Back-compat: _switchTab + _onClick read this flag. */
    get _padPickerIndex() { return this.padFeature?.pickerIndex ?? null; }
    /** Back-compat: _renderPlaybar iterates Pad start/dur per index. */
    get _padPlayTimes() { return this.padFeature?.playTimes || new Map(); }
    /** Back-compat: doClose calls this if armed. */
    get _padClearLongPress() { return this.padFeature ? () => this.padFeature.clearLongPress() : null; }
    /** Back-compat: _renderPlaybar inspects which pads are currently playing. */
    get _padPlayingIndex() { return this.padFeature?.playingIndex || new Set(); }

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
        // ── Library tab feature (extracted to LoopManagerLibraryFeature
        // per audit §6.6). Owns `library` array + search/filter/sort state.
        // The modal exposes `this.library` as a getter for back-compat with
        // the other features that read it directly (Pad, Live, Arranger).
        this.libraryFeature = typeof LoopManagerLibraryFeature !== 'undefined'
            ? new LoopManagerLibraryFeature(this, {
                onDeleteLoop:    (id) => this._deleteLoopById(id),
                onOpenLoopEditor: (id) => this._loopEditor.open({ loopId: id }),
                onLibraryLoaded: () => {
                    if (this.activeTab === 'live') this._renderLiveArea();
                    this._renderPalette();
                }
            })
            : null;

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

        // Arranger UX state
        this._trackMute       = new Set();   // track ids muted (local, not persisted)
        this._trackSolo       = new Set();   // track ids soloed
        this._blockClipboard  = [];          // copied blocks (relative positions)
        this._resizeState     = null;        // active block resize state
        this._autoSaveTimer   = null;        // debounced metadata save
        this._blockMenuEl     = null;        // open context menu element
        this._paletteSearch   = '';          // palette filter text
        this._arrangerZoomV   = 1;           // vertical zoom (track height multiplier)
        this._arrangerLoop    = false;       // loop arrangement playback
        this._arrangerCountIn = false;       // play 1-bar metronome before start
        this._arrangerStartBar = 0;          // bar offset where playback begins
        this._trackDragId     = null;        // track currently being reordered (visual only)

        // Shared loop data cache (pad + live + arranger)
        this._fetchLoopDataCache = new Map();

        // ── Pad tab feature (extracted to LoopManagerPadFeature per audit §6.6).
        // Owns the grid layout, slots, play mode, quantize, synth, picker.
        this.padFeature = typeof LoopManagerPadFeature !== 'undefined'
            ? new LoopManagerPadFeature(this)
            : null;

        // ── Live state ──
        // ── Live tab feature (extracted to LoopManagerLiveFeature
        // per audit §6.6). Owns playingLoops Map, synth, search.
        this.liveFeature = typeof LoopManagerLiveFeature !== 'undefined'
            ? new LoopManagerLiveFeature(this)
            : null;

        // ── Keyboard tab feature (extracted to LoopManagerKeyboardFeature
        // per audit §6.6). Owns its own state (synth, mounted, envelopes,
        // activeKeys, instrument, isDrum). Public API used by this modal:
        //   keyboard.enterTab(), keyboard.unmount(), keyboard.stopAllNotes(),
        //   keyboard.mounted.
        this.keyboard = typeof LoopManagerKeyboardFeature !== 'undefined'
            ? new LoopManagerKeyboardFeature(this)
            : null;

        // ── Playback timeline bar ──
        // (_padPlayTimes lives on padFeature.playTimes; getter below.)
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
                <span class="lc-header-title" aria-hidden="true">∞</span>
                <span class="lc-header-subtitle">${this.t('loopManager.title')}</span>
            </div>
            <div class="lc-header-tabs" role="tablist" aria-label="${this.t('loopManager.title')}">
                <button class="lc-tab${this.activeTab==='library'  ? ' lc-tab--active':''}" data-tab="library"  role="tab" id="lc-tab-library"  aria-controls="lc-pane-library"  aria-selected="${this.activeTab==='library'}"  tabindex="${this.activeTab==='library'?'0':'-1'}"><span aria-hidden="true">🗂</span> ${this.t('loopManager.tabLibrary')}</button>
                <button class="lc-tab${this.activeTab==='pad'      ? ' lc-tab--active':''}" data-tab="pad"      role="tab" id="lc-tab-pad"      aria-controls="lc-pane-pad"      aria-selected="${this.activeTab==='pad'}"      tabindex="${this.activeTab==='pad'?'0':'-1'}"><span class="lc-tab-icon lc-tab-icon--pad" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/><circle cx="5" cy="5"  r="1.1" fill="currentColor" stroke="none"/><circle cx="11" cy="5"  r="1.1" fill="currentColor" stroke="none"/><circle cx="5" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="11" cy="11" r="1.1" fill="currentColor" stroke="none"/></svg></span> ${this.t('loopManager.tabPad')}</button>
                <button class="lc-tab${this.activeTab==='live'     ? ' lc-tab--active':''}" data-tab="live"     role="tab" id="lc-tab-live"     aria-controls="lc-pane-live"     aria-selected="${this.activeTab==='live'}"     tabindex="${this.activeTab==='live'?'0':'-1'}"><span aria-hidden="true">⚡</span> ${this.t('loopManager.tabLive')}</button>
                <button class="lc-tab${this.activeTab==='keyboard' ? ' lc-tab--active':''}" data-tab="keyboard" role="tab" id="lc-tab-keyboard" aria-controls="lc-pane-keyboard" aria-selected="${this.activeTab==='keyboard'}" tabindex="${this.activeTab==='keyboard'?'0':'-1'}"><span aria-hidden="true">🎹</span> ${this.t('loopManager.tabKeyboard')}</button>
                <button class="lc-tab${this.activeTab==='arranger' ? ' lc-tab--active':''}" data-tab="arranger" role="tab" id="lc-tab-arranger" aria-controls="lc-pane-arranger" aria-selected="${this.activeTab==='arranger'}" tabindex="${this.activeTab==='arranger'?'0':'-1'}"><span aria-hidden="true">∞</span> ${this.t('loopManager.tabArranger')}</button>
            </div>
            <div class="lc-header-actions">
                <button class="lc-btn lc-btn-sm lc-header-output-btn" id="lc-header-output-btn"
                    data-action="toggle-output"
                    aria-pressed="${this._globalOutput.mode === 'device' ? 'true' : 'false'}"
                    title="${this.t('loopCreator.outputLabel')}">
                    <span class="lc-header-output-icon" id="lc-header-output-icon" aria-hidden="true">🔊</span>
                    <span class="lc-header-output-label" id="lc-header-output-label">${this.t('loopManager.outputSynth')}</span>
                </button>
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
        <div class="lc-pane${this.activeTab==='keyboard' ? '' : ' lc-pane--hidden'} lm-kbd-pane" id="lc-pane-keyboard" role="tabpanel" aria-labelledby="lc-tab-keyboard">
            <div class="lm-kbd-panel" id="lm-kbd-panel"></div>
        </div>`;
    }

    renderFooter() { return ''; }

    // =========================================================
    // RENDERING — TAB 1: LIBRARY
    // =========================================================

    _renderLibraryTab() {
        return this.libraryFeature ? this.libraryFeature.renderTabHtml() : "";
    }

    // =========================================================
    // RENDERING — TAB 2: PAD
    // =========================================================

    _renderPadTab() {
        return this.padFeature ? this.padFeature.renderTabHtml() : "";
    }


    // =========================================================
    // RENDERING — TAB 3: LIVE
    // =========================================================

    _renderLiveTab() {
        return this.liveFeature ? this.liveFeature.renderTabHtml() : "";
    }

    // =========================================================
    // RENDERING — TAB 4: ARRANGER
    // =========================================================

    _renderArrangerTab() {
        // Raccourcis platform-aware (AUDIT §U2 : ⌘ sur Mac, Ctrl ailleurs).
        const mod = LoopUtils.modKeyLabel();
        const sft = LoopUtils.shiftKeyLabel();
        return `
        <div class="lc-pane${this.activeTab==='arranger' ? '' : ' lc-pane--hidden'}" id="lc-pane-arranger" role="tabpanel" aria-labelledby="lc-tab-arranger">
            <div class="lc-ctrl-bar lc-ctrl-bar--arr">
                <!-- Groupe 1 — Identité de l'arrangement -->
                <input type="text" class="lc-name-input la-toolbar-name" id="la-name-input"
                    aria-label="${this.t('loopCreator.arrangementName')}"
                    value="${this.escape(this.arrangementName || this.t('loopCreator.untitledArrangement'))}"
                    placeholder="${this.t('loopCreator.arrangementName')}" />

                <!-- Groupe 2 — Transport (play, stop, loop, count-in) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.t('loopManager.groupTransport') || 'Transport'}">
                    <button class="lc-btn lc-btn-icon lc-btn-primary-ish" data-action="arr-play" id="la-play-btn"
                        title="${this.t('loopCreator.play')} (Space)" aria-label="${this.t('loopCreator.play')}"><span aria-hidden="true">▶</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-stop"
                        title="${this.t('loopCreator.stop')} (Esc)" aria-label="${this.t('loopCreator.stop')}"><span aria-hidden="true">⏹</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-toggle-loop" id="la-loop-btn"
                        title="${this.t('loopManager.loopPlayback')}"
                        aria-label="${this.t('loopManager.loopPlayback')}"
                        aria-pressed="${this._arrangerLoop ? 'true' : 'false'}"><span aria-hidden="true">🔁</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-toggle-countin" id="la-countin-btn"
                        title="${this.t('loopManager.countIn')}"
                        aria-label="${this.t('loopManager.countIn')}"
                        aria-pressed="${this._arrangerCountIn ? 'true' : 'false'}"><span aria-hidden="true">⏲</span></button>
                </div>

                <!-- Groupe 3 — Propriétés (tempo, mesures) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.t('loopManager.groupProperties') || 'Properties'}">
                    <div class="lc-spinbox" title="${this.t('loopCreator.tempo')}">
                        <button class="lc-spin-btn" data-action="arr-tempo-dec" aria-label="${this.t('loopCreator.tempo')} −"><span aria-hidden="true">‹</span></button>
                        <input type="number" id="la-tempo" class="lc-spin-input lc-spin-input--sm" value="${this.arrangementTempo}" min="20" max="300" aria-label="${this.t('loopCreator.tempo')}" />
                        <button class="lc-spin-btn" data-action="arr-tempo-inc" aria-label="${this.t('loopCreator.tempo')} +"><span aria-hidden="true">›</span></button>
                    </div>
                    <span class="lc-unit" aria-hidden="true">BPM</span>
                    <div class="lc-spinbox" title="${this.t('loopCreator.totalBars')}">
                        <button class="lc-spin-btn" data-action="arr-bars-dec" aria-label="${this.t('loopCreator.totalBars')} −"><span aria-hidden="true">‹</span></button>
                        <input type="number" id="la-bars" class="lc-spin-input lc-spin-input--sm" value="${this.arrangementBars}" min="4" max="256" step="4" aria-label="${this.t('loopCreator.totalBars')}" />
                        <button class="lc-spin-btn" data-action="arr-bars-inc" aria-label="${this.t('loopCreator.totalBars')} +"><span aria-hidden="true">›</span></button>
                    </div>
                    <span class="lc-unit" aria-hidden="true">${this.t('loopCreator.barsUnitShort') || 'M'}</span>
                </div>

                <!-- Groupe 4 — Édition (undo/redo) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.t('loopManager.groupHistory') || 'Edit history'}">
                    <button class="lc-btn lc-btn-icon" data-action="arr-undo" id="la-undo-btn"
                        title="${this.t('loopCreator.undo')} (${mod}+Z)" aria-label="${this.t('loopCreator.undo')}" disabled><span aria-hidden="true">↶</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-redo" id="la-redo-btn"
                        title="${this.t('loopCreator.redo')} (${mod}+${sft}+Z)" aria-label="${this.t('loopCreator.redo')}" disabled><span aria-hidden="true">↷</span></button>
                </div>

                <!-- Groupe 5 — Vue (zoom horizontal + vertical) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.t('loopManager.groupZoom') || 'Zoom'}">
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoom-out"
                        title="${this.t('loopEditor.zoomHOut')}" aria-label="${this.t('loopEditor.zoomHOut')}"><span aria-hidden="true">−↔</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoom-reset"
                        title="${this.t('loopManager.zoomReset')}" aria-label="${this.t('loopManager.zoomReset')}"><span aria-hidden="true">⌖</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoom-in"
                        title="${this.t('loopEditor.zoomHIn')}" aria-label="${this.t('loopEditor.zoomHIn')}"><span aria-hidden="true">+↔</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoomv-out"
                        title="${this.t('loopManager.zoomVOut')}" aria-label="${this.t('loopManager.zoomVOut')}"><span aria-hidden="true">−↕</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoomv-in"
                        title="${this.t('loopManager.zoomVIn')}" aria-label="${this.t('loopManager.zoomVIn')}"><span aria-hidden="true">+↕</span></button>
                </div>

                <span class="lc-ctrl-spacer"></span>

                <!-- Groupe 6 — Structure (add track, new arrangement) — actions secondaires, à droite -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.t('loopManager.groupStructure') || 'Structure'}">
                    <button class="lc-btn lc-btn-icon" data-action="arr-add-track"
                        title="${this.t('loopCreator.addTrack')}" aria-label="${this.t('loopCreator.addTrack')}"><span aria-hidden="true">＋</span></button>
                    <button class="lc-btn lc-btn-sm" data-action="arr-new"
                        title="${this.t('loopCreator.newArrangement')}"><span aria-hidden="true">🆕</span> ${this.t('loopCreator.newArrangement')}</button>
                </div>
            </div>

            <div class="la-area" id="la-area">
                <div class="la-palette" id="la-palette">
                    <div class="la-palette-title">${this.t('loopCreator.palette')}</div>
                    <input type="search" id="la-palette-search" class="lc-name-input la-palette-search"
                        aria-label="${this.t('loopManager.search')}"
                        placeholder="${this.t('loopManager.search')}" autocomplete="off" />
                    <div class="la-palette-grid" id="la-palette-grid">
                        <div class="lc-empty">${this.t('loopCreator.libraryEmpty')}</div>
                    </div>
                </div>
                <div class="la-timeline-col">
                    <canvas class="la-minimap" id="la-minimap" height="48"
                        aria-label="${this.t('loopManager.arrangerMinimap') || 'Arrangement overview'}"
                        title="${this.t('loopManager.arrangerMinimapHint') || 'Click to seek; drag to pan'}"></canvas>
                    <div class="la-timeline-wrap" id="la-timeline-wrap">
                        <div class="la-ruler" id="la-ruler"></div>
                        <div class="la-tracks" id="la-tracks"></div>
                        <div class="la-playhead" id="la-playhead" style="display:none"></div>
                    </div>
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
        // _createDOM has already rendered the body with constructor defaults.
        // Load persisted layout, then push the loaded values back onto the bar
        // (cols/rows inputs + mode/quantize buttons) so the UI matches state.
        this._loadPadLayout();
        this._syncPadControls();
        this._initArrangerSynth();
        this._initPadSynth();
        this._initLiveSynth();
        this._attachEvents();
        this._loadLibrary();
        this._loadHeaderOutputDevices();
        document.addEventListener('mouseup',    this._boundDocMouseUp);
        document.addEventListener('mousemove',  this._boundDocMouseMove);
        document.addEventListener('keydown',    this._boundKeyDown);

        // Run the per-tab init that `_switchTab` would normally trigger.
        // Without this, opening on a non-library tab (or even library if
        // the async library load hasn't fired yet) leaves the pane
        // visually selected but unpopulated until the user manually
        // clicks another tab and back.
        this._initActiveTab();
    }

    /**
     * Initial-render hook : run the same per-tab init that `_switchTab`
     * performs, but for the currently active tab. Idempotent — every
     * `_render*` / `_init*` it calls is safe to invoke twice.
     */
    _initActiveTab() {
        switch (this.activeTab) {
            case 'library':  this._filterAndRenderLibrary(); break;
            case 'pad':      this._renderPadGrid();           break;
            case 'live':     this._renderLiveArea();          break;
            case 'keyboard': this.keyboard?.enterTab();        break;
            case 'arranger': this._initArrangerTab();         break;
        }
    }

    // ── Global output selector (header) ────────────────────────
    async _loadHeaderOutputDevices() {
        // Devices are no longer picked from the header — the keyboard panel's
        // instrument selector sets the global deviceId. We still cache the
        // device list here so other tabs can resolve names if needed.
        try {
            const allDevices = await this.api.listDevices();
            this._cachedDevices = (allDevices || []).filter(d => d.status === 2 || d.connected === true);
        } catch (err) {
            LoopUtils.handleError(err, 'manager.header.listDevices');
            this._cachedDevices = [];
        }
        this._refreshHeaderOutputUI();
    }

    _refreshHeaderOutputUI() {
        const btn   = this.$('#lc-header-output-btn');
        const icon  = this.$('#lc-header-output-icon');
        const label = this.$('#lc-header-output-label');
        const isDev = this._globalOutput.mode === 'device';
        if (icon)  icon.textContent  = isDev ? '🔌' : '🔊';
        if (label) label.textContent = isDev ? this.t('loopManager.outputLive') : this.t('loopManager.outputSynth');
        if (btn) {
            btn.classList.toggle('lc-header-output-btn--device', isDev);
            btn.setAttribute('aria-pressed', isDev ? 'true' : 'false');
        }
    }

    _toggleHeaderOutput() {
        // Pure mode switch: preview-synth ⇄ live-device. If no device has
        // been picked yet in the virtual piano, the per-tab routing
        // gracefully falls back to the synth (see keyboard._routingDevice
        // and _getOutputTarget) — no upfront check needed.
        const next = this._globalOutput.mode === 'device' ? 'synth' : 'device';
        this._setGlobalOutput({ mode: next });
    }

    _setGlobalOutput(next) {
        const prev = this._globalOutput;
        this._globalOutput = { ...prev, ...next };
        // Switching target: stop everything to avoid stuck notes
        if (prev.mode !== this._globalOutput.mode || prev.deviceId !== this._globalOutput.deviceId) {
            this._stopAllPads();
            this._liveStopAll();
            this._stopArrangerPlay();
            this.keyboard?.stopAllNotes();
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

    close() {
        if (!this._arrDirty) {
            super.close();
            return;
        }
        // Confirmation accessible (AUDIT §A1).
        const doSuperClose = () => super.close();
        LoopUtils.confirm(this.t('loopManager.confirmDiscardChanges'), {
            icon: '⚠️',
            danger: true
        }).then((ok) => { if (ok) doSuperClose(); });
    }

    onClose() {
        if (this._autoSaveTimer) { clearTimeout(this._autoSaveTimer); this._autoSaveTimer = null; }
        this._closeBlockMenu();
        this._stopAllPads();
        this._liveStopAll();
        this._stopArrangerPlay();
        this._stopPlaybarRAF();
        this._closePadPicker();
        this.keyboard?.stopAllNotes();
        if (this.keyboard?.mounted) this.keyboard.unmount();
        // Coupe les timers/UI résiduels du Pad et de l'Arranger (AUDIT §L9, §L10).
        if (typeof this._padClearLongPress === 'function') this._padClearLongPress();
        this._hideDropPreview();
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

        // Navigation clavier dans la tablist (APG tabs pattern, AUDIT §A2).
        // Capture en premier — pas conditionné par l'input/textarea check
        // car le focus est sur un bouton tab.
        if (t?.classList?.contains('lc-tab') && t.getAttribute('role') === 'tab') {
            const tabs = ['library', 'pad', 'live', 'keyboard', 'arranger'];
            const i = tabs.indexOf(t.dataset.tab);
            if (i >= 0) {
                let next = -1;
                if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
                else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = tabs.length - 1;
                if (next >= 0) {
                    e.preventDefault();
                    this._switchTab(tabs[next]);
                    this.$(`#lc-tab-${tabs[next]}`)?.focus();
                    return;
                }
            }
        }

        if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
        if (this._loopEditor?.isOpen) return; // editor handles its own shortcuts

        const mod = e.ctrlKey || e.metaKey;

        if (this.activeTab === 'arranger') {
            if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this._arrUndo(); return; }
            if (mod && e.key.toLowerCase() === 'z' &&  e.shiftKey) { e.preventDefault(); this._arrRedo(); return; }
            if (mod && e.key.toLowerCase() === 'y')                { e.preventDefault(); this._arrRedo(); return; }
            if (mod && e.key.toLowerCase() === 's')                { e.preventDefault(); this._saveArrangement(); return; }
            if (e.key === ' ') { e.preventDefault(); this.isArrangerPlaying ? this._stopArrangerPlay() : this._playArrangement(this._arrangerStartBar); return; }
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
            if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); this._copySelectedBlocks(); return; }
            if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); this._copySelectedBlocks(); this._deleteSelectedBlocks(); return; }
            if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); this._pasteBlocks(); return; }
            if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this._duplicateSelectedBlocks(); return; }
        }

        if (this.activeTab === 'live') {
            if (e.key === 'Escape') { this._liveStopAll(); return; }
        }
    }

    // =========================================================
    // TAB SWITCHING
    // =========================================================

    _switchTab(tab) {
        // Close the pad assignment picker if leaving the Pad tab
        if (this.activeTab === 'pad' && tab !== 'pad' && this._padPickerIndex !== null) {
            this._closePadPicker();
        }
        this.activeTab = tab;
        this.$$('.lc-tab').forEach(btn => {
            const active = btn.dataset.tab === tab;
            btn.classList.toggle('lc-tab--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
            // APG : tabindex roving — un seul tab focusable à la fois.
            btn.setAttribute('tabindex', active ? '0' : '-1');
        });
        this.$$('.lc-pane').forEach(pane => {
            pane.classList.toggle('lc-pane--hidden', !pane.id.endsWith(tab));
        });
        const saveBtn = this.$('#lc-header-save');
        if (saveBtn) saveBtn.style.display = tab === 'arranger' ? '' : 'none';

        // The embedded keyboard panel can only live in one host at a time, so
        // unmount it whenever the user leaves the Keyboard tab.
        if (tab !== 'keyboard' && this.keyboard?.mounted) this.keyboard.unmount();

        if (tab === 'library')  this._filterAndRenderLibrary();
        if (tab === 'pad')      this._renderPadGrid();
        if (tab === 'live')     this._renderLiveArea();
        if (tab === 'keyboard') this.keyboard?.enterTab();
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
            case 'stop-all-playback': this._stopAllPads(); this._liveStopAll(); this._stopArrangerPlay(); this.keyboard?.stopAllNotes(); break;
            case 'toggle-output':    this._toggleHeaderOutput(); break;
            // Library
            case 'new-loop':  this._loopEditor.open(); break;
            // Pad
            case 'pad-clear-all':this._clearAllPads(); break;
            case 'pad-cols-dec': this._adjustPadCols(-1); break;
            case 'pad-cols-inc': this._adjustPadCols(+1); break;
            case 'pad-rows-dec': this._adjustPadRows(-1); break;
            case 'pad-rows-inc': this._adjustPadRows(+1); break;
            case 'pad-set-mode':     this._setPadPlayMode(btn.dataset.mode); break;
            case 'pad-set-quantize': this._setPadQuantize(btn.dataset.quantize); break;
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
            case 'arr-play':         this._playArrangement(this._arrangerStartBar); break;
            case 'arr-stop':         this._stopArrangerPlay();  break;
            case 'arr-new':          this._newArrangementConfirm(); break;
            case 'arr-zoom-in':      this._arrZoom(1.5);        break;
            case 'arr-zoom-out':     this._arrZoom(1 / 1.5);    break;
            case 'arr-zoom-reset':   this._arrZoomReset();      break;
            case 'arr-zoomv-in':     this._arrZoomV(1.3);       break;
            case 'arr-zoomv-out':    this._arrZoomV(1 / 1.3);   break;
            case 'arr-toggle-loop':  this._toggleLoopPlayback(); break;
            case 'arr-toggle-countin': this._toggleCountIn();   break;
            case 'arr-undo':         this._arrUndo();           break;
            case 'arr-redo':         this._arrRedo();           break;
            case 'save-arrangement': this._saveArrangement();   break;
            case 'close':            this.close();              break;
        }
    }

    _onContextMenu(e) {
        const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
        if (cell) {
            e.preventDefault();
            this._openPadPicker(parseInt(cell.dataset.padIndex), cell);
            return;
        }
        const blockEl = e.target.closest('.la-block[data-block-id]');
        if (blockEl) {
            e.preventDefault();
            const bid = parseInt(blockEl.dataset.blockId);
            if (!this._selectedBlocks.has(bid)) {
                this._selectedBlocks.clear();
                this._selectedBlocks.add(bid);
                this._refreshBlockSelectionUI();
            }
            this._openBlockMenu(e.clientX, e.clientY);
        }
    }

    _openBlockMenu(x, y) {
        this._closeBlockMenu();
        const menu = document.createElement('div');
        menu.className = 'la-block-menu';
        menu.style.left = x + 'px';
        menu.style.top  = y + 'px';
        const items = [
            { action: 'duplicate', label: this.t('loopManager.blockMenuDuplicate'), icon: '⎘' },
            { action: 'copy',      label: this.t('loopManager.blockMenuCopy'),      icon: '⧉' },
            { action: 'reps-inc',  label: this.t('loopManager.blockMenuRepsInc'),   icon: '+' },
            { action: 'reps-dec',  label: this.t('loopManager.blockMenuRepsDec'),   icon: '−' },
            { action: 'delete',    label: this.t('loopManager.blockMenuDelete'),    icon: '🗑', danger: true }
        ];
        menu.innerHTML = items.map(it =>
            `<button class="la-block-menu-item${it.danger ? ' la-block-menu-item--danger' : ''}" data-menu-action="${it.action}">
                <span class="la-block-menu-icon">${it.icon}</span>${it.label}
            </button>`
        ).join('');
        document.body.appendChild(menu);
        // Clamp position to viewport
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-menu-action]');
            if (!btn) return;
            this._closeBlockMenu();
            const a = btn.dataset.menuAction;
            const ids = [...this._selectedBlocks];
            switch (a) {
                case 'duplicate': this._duplicateSelectedBlocks(); break;
                case 'copy':      this._copySelectedBlocks(); break;
                case 'reps-inc':  ids.forEach(id => this._changeReps(id, +1)); break;
                case 'reps-dec':  ids.forEach(id => this._changeReps(id, -1)); break;
                case 'delete':    this._deleteSelectedBlocks(); break;
            }
        });
        // Dismiss on outside click / escape
        this._blockMenuEl = menu;
        this._blockMenuDismiss = (ev) => {
            if (ev.type === 'keydown' && ev.key !== 'Escape') return;
            if (ev.type === 'mousedown' && menu.contains(ev.target)) return;
            this._closeBlockMenu();
        };
        setTimeout(() => {
            document.addEventListener('mousedown', this._blockMenuDismiss);
            document.addEventListener('keydown',   this._blockMenuDismiss);
        }, 0);
    }

    _closeBlockMenu() {
        if (!this._blockMenuEl) return;
        document.removeEventListener('mousedown', this._blockMenuDismiss);
        document.removeEventListener('keydown',   this._blockMenuDismiss);
        this._blockMenuEl.remove();
        this._blockMenuEl = null;
        this._blockMenuDismiss = null;
    }

    _onChange(e) {
        const id = e.target.id;
        if (id === 'lm-lib-filter') {
            this.libraryFeature?.setFilter(e.target.value);
        } else if (id === 'lm-lib-sort') {
            this.libraryFeature?.setSort(e.target.value);
        } else if (id === 'lm-pad-cols') {
            this._setPadCols(parseInt(e.target.value));
        } else if (id === 'lm-pad-rows') {
            this._setPadRows(parseInt(e.target.value));
        } else if (id === 'la-bars') {
            const v = LoopUtils.validate.arrBars(e.target.value, this.arrangementBars);
            const changed = v !== this.arrangementBars;
            this.arrangementBars = v;
            e.target.value = v;
            if (changed) {
                this._renderTimeline();
                this._pushArrHistory();
                this._scheduleAutoSave();
            }
        }
    }

    _onInput(e) {
        const id = e.target.id;
        if (id === 'lm-lib-search') {
            this.libraryFeature?.setSearch(e.target.value);
        } else if (id === 'lm-live-search') {
            this.liveFeature?.setSearch(e.target.value);
        } else if (id === 'la-palette-search') {
            this._paletteSearch = e.target.value;
            this._renderPalette();
        } else if (id === 'la-name-input') {
            if (this.arrangementName === e.target.value) return;
            this.arrangementName = e.target.value;
            this._markArrDirty(true);
            this._scheduleAutoSave();
        } else if (id === 'la-tempo') {
            const v = LoopUtils.validate.tempo(e.target.value, this.arrangementTempo);
            if (v !== this.arrangementTempo) {
                this.arrangementTempo = v;
                this._markArrDirty(true);
                this._scheduleAutoSave();
            }
        }
    }

    _scheduleAutoSave(delayMs = 800) {
        if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
        this._autoSaveTimer = setTimeout(() => {
            this._autoSaveTimer = null;
            if (this._arrDirty && this.currentArrangementId) this._saveArrangement({ silent: true });
        }, delayMs);
    }

    // =========================================================
    // LIBRARY
    // =========================================================

    async _loadLibrary() {
        return this.libraryFeature?.loadLibrary();
    }

    _filterAndRenderLibrary() {
        this.libraryFeature?.filterAndRender();
    }


    async _deleteLoopById(id) {
        try {
            await this.api.sendCommand('loop_delete', { loopId: id });
            this._fetchLoopDataCache.delete(id);
            // Remove from pad slots if assigned (cross-feature cleanup)
            this.padFeature?.cleanupSlotsForLoop(id);
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

    async _initPadSynth()     { return this.padFeature?.initSynth(); }
    _renderPadGrid()          { this.padFeature?.renderGrid(); }
    _setPadCols(v)            { this.padFeature?.setCols(v); }
    _setPadRows(v)            { this.padFeature?.setRows(v); }
    _adjustPadCols(d)         { this.padFeature?.adjustCols(d); }
    _adjustPadRows(d)         { this.padFeature?.adjustRows(d); }
    _setPadPlayMode(mode)     { this.padFeature?.setPlayMode(mode); }
    _setPadQuantize(q)        { this.padFeature?.setQuantize(q); }
    async _triggerPad(i, opts){ return this.padFeature?.trigger(i, opts); }
    _stopPad(i)               { this.padFeature?.stop(i); }
    _stopAllPads()            { this.padFeature?.stopAll(); }
    _assignPadSlot(i, loopId) { this.padFeature?.assignSlot(i, loopId); }
    _openPadPicker(i, anchor) { this.padFeature?.openPicker(i, anchor); }
    _closePadPicker()         { this.padFeature?.closePicker(); }
    _persistPadLayout()       { this.padFeature?._persist(); }
    _loadPadLayout()          { this.padFeature?.load(); }
    async _clearAllPads()     { return this.padFeature?.clearAll(); }


    // =========================================================
    // LIVE TAB
    // =========================================================

    async _initLiveSynth() { return this.liveFeature?.initSynth(); }
    _renderLiveArea()      { this.liveFeature?.renderArea(); }
    async _liveTrigger(id) { return this.liveFeature?.trigger(id); }
    _liveStop(id)          { this.liveFeature?.stop(id); }
    _liveStopAll()         { this.liveFeature?.stopAll(); }


    // =========================================================
    // ARRANGER — INIT
    // =========================================================

    async _initArrangerSynth() {
        if (!this._arrangerSynth) this._arrangerSynth = await LoopUtils.createSynth({ initialProgram: 0 });
    }

    async _initArrangerTab() {
        await this._loadLibrary();
        // Nettoyage one-shot des arrangements vides (sans block) accumulés
        // par l'ancien auto-create. Ne supprime que les arrangements créés
        // avant cette session et qui n'ont jamais reçu de block.
        await this._purgeEmptyArrangements();
        await this._loadArrangements();
        if (this.currentArrangementId) {
            const ok = await this._loadArrangementById(this.currentArrangementId);
            if (!ok) {
                // L'arrangement précédemment ouvert a pu être purgé ou
                // supprimé entre-temps — fallback sur l'empty state.
                this.currentArrangementId = null;
                this._renderArrangerEmptyState();
            }
        } else {
            // Pas d'auto-create : on affiche un empty state avec un CTA
            // dans la track area. L'utilisateur clique « + Nouvel
            // arrangement » pour créer (cf. _newArrangementConfirm).
            this._renderArrangerEmptyState();
        }
    }

    /**
     * Affiche un empty state dans la zone tracks quand aucun arrangement
     * n'est sélectionné. Évite la création automatique de fichiers
     * fantômes à chaque ouverture de la modale.
     */
    _renderArrangerEmptyState() {
        const tracksEl = this.$('#la-tracks');
        const rulerEl  = this.$('#la-ruler');
        if (rulerEl)  rulerEl.innerHTML  = '';
        if (tracksEl) tracksEl.innerHTML = `
            <div class="la-empty-state">
                <p>${this.t('loopManager.arrangerEmptyState') || 'No arrangement selected.'}</p>
                <button class="lc-btn lc-btn-primary" data-action="arr-new">
                    + ${this.t('loopCreator.newArrangement')}
                </button>
            </div>`;
        // Vider l'overlay playbar + désactiver le play
        this.tracks = [];
        this.blocks = [];
    }

    /**
     * Supprime les arrangements existants qui n'ont aucun block et ne
     * sont pas l'arrangement actuel. Best-effort : les erreurs sont
     * journalisées mais n'interrompent pas le flux.
     */
    async _purgeEmptyArrangements() {
        try {
            const r = await this.api.sendCommand('arrangement_list');
            const arrs = r.arrangements || [];
            for (const arr of arrs) {
                if (arr.id === this.currentArrangementId) continue;
                try {
                    const detail = await this.api.sendCommand('arrangement_get', { arrangementId: arr.id });
                    if ((detail.blocks || []).length === 0) {
                        await this.api.sendCommand('arrangement_delete', { arrangementId: arr.id });
                    }
                } catch (e) {
                    // Continue avec les autres arrangements en cas d'erreur ponctuelle.
                }
            }
        } catch (err) {
            LoopUtils.handleError(err, 'arr.purgeEmpty');
        }
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
                <button class="lc-card-btn" data-arr-action="duplicate" data-arr-id="${a.id}"
                    title="${this.t('loopManager.duplicateArrangement')}">⎘</button>
                <button class="lc-card-btn lc-card-btn--danger" data-arr-action="delete" data-arr-id="${a.id}"
                    title="${this.t('loopManager.deleteArrangement')}">🗑</button>
            </div>`).join('');
        if (!el.dataset.lcWired) {
            el.dataset.lcWired = '1';
            el.addEventListener('click', async (e) => {
                const del = e.target.closest('[data-arr-action="delete"]');
                if (del) {
                    const id = parseInt(del.dataset.arrId);
                    const item = el.querySelector(`[data-arr-id="${id}"] .la-arr-name`);
                    const name = item?.textContent || '';
                    const ok = await LoopUtils.confirm(
                        this.t('loopManager.confirmDeleteArrangement', { name }),
                        { icon: '🗑️', danger: true }
                    );
                    if (ok) this._deleteArrangement(id);
                    return;
                }
                const dup = e.target.closest('[data-arr-action="duplicate"]');
                if (dup) {
                    e.stopPropagation();
                    this._duplicateArrangement(parseInt(dup.dataset.arrId));
                    return;
                }
                const item = e.target.closest('[data-arr-id]');
                if (item) this._requestLoadArrangement(parseInt(item.dataset.arrId));
            });
        }
    }

    async _newArrangementConfirm() {
        const hasContent = (this.blocks?.length || 0) > 0 || (this.tracks?.length || 0) > 0;
        if (hasContent && this._arrDirty) {
            const ok = await LoopUtils.confirm(this.t('loopManager.confirmNewArrangement'),
                { icon: '⚠️', danger: true });
            if (!ok) return;
        }
        this._newArrangement();
    }

    async _requestLoadArrangement(id) {
        if (id === this.currentArrangementId) return;
        if (this._arrDirty) {
            const ok = await LoopUtils.confirm(this.t('loopManager.confirmSwitchArrangement'),
                { icon: '⚠️', danger: true });
            if (!ok) return;
        }
        this._loadArrangementById(id);
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
            this._trackMute.clear();
            this._trackSolo.clear();
            this._arrangerStartBar = 0;
            this._renderTimeline();
            this._loadArrangements();   // refresh full list so other items remain visible
            return true;
        } catch (err) {
            LoopUtils.handleError(err, 'arr.load', {
                toast: this.t('loopManager.errLoadArrangement')
            });
            return false;
        }
    }

    // =========================================================
    // ARRANGER — UNDO/REDO HISTORY (T3)
    // =========================================================

    _snapshotArr() {
        return {
            name:   this.arrangementName,
            tempo:  this.arrangementTempo,
            bars:   this.arrangementBars,
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
        if (snap.name  !== undefined) this.arrangementName  = snap.name;
        if (snap.tempo !== undefined) this.arrangementTempo = snap.tempo;
        if (snap.bars  !== undefined) this.arrangementBars  = snap.bars;
        this.tracks = snap.tracks.map(t => ({ ...t }));
        this.blocks = snap.blocks.map(b => ({ ...b }));
        this._selectedBlocks.clear();
        // Sync inputs with restored metadata
        const setVal = (sel, v) => { const el = this.$(sel); if (el && v !== undefined) el.value = v; };
        setVal('#la-name-input', this.arrangementName);
        setVal('#la-tempo',      this.arrangementTempo);
        setVal('#la-bars',       this.arrangementBars);
        // Prune mute/solo for tracks that no longer exist
        const ids = new Set(this.tracks.map(t => t.id));
        for (const id of this._trackMute) if (!ids.has(id)) this._trackMute.delete(id);
        for (const id of this._trackSolo) if (!ids.has(id)) this._trackSolo.delete(id);
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
        const q = (this._paletteSearch || '').trim().toLowerCase();
        const items = q
            ? this.library.filter(l => (l.name || '').toLowerCase().includes(q)
                  || (GM_PROGRAM_NAMES[l.instrument_program ?? 0] || '').toLowerCase().includes(q))
            : this.library;
        if (!items.length) { grid.innerHTML = `<div class="lc-empty">${this.t('loopManager.noResults')}</div>`; return; }
        grid.innerHTML = items.map(loop => {
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
                const loopBars = parseInt(chip.dataset.loopBars);
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    loopId: parseInt(chip.dataset.loopId),
                    loopBars,
                    loopName: chip.dataset.loopName
                }));
                this._dragInfo = { type: 'palette', loopBars, reps: 1 };
            });
            chip.addEventListener('dragend', () => { this._dragInfo = null; });
        });
    }

    // =========================================================
    // ARRANGER — TIMELINE
    // =========================================================

    _renderTimeline() { this._renderRuler(); this._renderTracks(); this._renderMinimap(); this._renderPalette(); this._refreshBlockSelectionUI(); }

    /**
     * Minimap d'aperçu canvas (compacte) au-dessus du timeline arranger.
     * Affiche l'arrangement entier dans une bande horizontale :
     *  - lignes horizontales = tracks
     *  - rectangles colorés = blocks (couleur famille GM)
     *  - rectangle viewport = portion actuellement visible dans le
     *    timeline scrollable
     *  - click/drag = scroll le timeline principal sur la position
     */
    _renderMinimap() {
        const canvas = this.$('#la-minimap');
        if (!canvas) return;
        const wrap = this.$('#la-timeline-wrap');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const W = canvas.clientWidth  || canvas.parentElement?.clientWidth || 600;
        const H = parseInt(canvas.getAttribute('height')) || 48;
        if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
            canvas.width  = W * dpr;
            canvas.height = H * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        ctx.clearRect(0, 0, W, H);

        const totalBars = Math.max(1, this.arrangementBars);
        const trackCount = Math.max(1, this.tracks?.length || 0);
        const barW   = W / totalBars;
        const rowH   = (H - 4) / trackCount;
        const trackIndexById = new Map((this.tracks || []).map((t, i) => [t.id, i]));

        // Fond + grille très légère toutes les 4 mesures.
        ctx.fillStyle = 'rgba(0,0,0,0.04)';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1;
        for (let b = 0; b <= totalBars; b += 4) {
            const x = b * barW;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }

        // Blocks.
        for (const block of (this.blocks || [])) {
            const ti = trackIndexById.get(block.track_id);
            if (ti === undefined) continue;
            const x = block.position_bar * barW;
            const w = Math.max(1, block.loop_bars * block.repetitions * barW);
            const y = 2 + ti * rowH;
            const h = Math.max(2, rowH - 2);
            const loop = this.library.find(l => l.id === block.loop_id);
            const family = LoopUtils.familyForProgram(loop?.instrument_program ?? 0);
            ctx.fillStyle = family.color;
            ctx.fillRect(x, y, w, h);
        }

        // Viewport rectangle : portion visible du timeline scrollable.
        if (wrap) {
            const cellsBarW = this._barWidth();
            const tracksTotalW = cellsBarW * totalBars; // largeur du contenu cells (sans label)
            if (tracksTotalW > 0) {
                const scrollL = wrap.scrollLeft;
                const visibleW = wrap.clientWidth - 120; // soustrait labels sticky
                const viewStart = Math.max(0, scrollL / cellsBarW);
                const viewBars  = Math.min(totalBars - viewStart, visibleW / cellsBarW);
                ctx.strokeStyle = '#f5a623';
                ctx.lineWidth = 2;
                ctx.strokeRect(viewStart * barW + 1, 1, Math.max(2, viewBars * barW - 2), H - 2);
                ctx.fillStyle = 'rgba(245,166,35,0.10)';
                ctx.fillRect(viewStart * barW + 1, 1, Math.max(2, viewBars * barW - 2), H - 2);
            }
        }

        // Wire l'interaction une seule fois.
        if (!canvas.dataset.lcWired) {
            canvas.dataset.lcWired = '1';
            const seek = (clientX) => {
                const rect = canvas.getBoundingClientRect();
                const x = clientX - rect.left;
                const ratio = Math.max(0, Math.min(1, x / rect.width));
                const targetBar = ratio * this.arrangementBars;
                const w = this.$('#la-timeline-wrap');
                if (!w) return;
                const cellsBarW = this._barWidth();
                w.scrollLeft = Math.max(0, targetBar * cellsBarW - (w.clientWidth - 120) / 2);
                this._renderMinimap();
            };
            let dragging = false;
            canvas.addEventListener('mousedown', (e) => { dragging = true; seek(e.clientX); });
            canvas.addEventListener('mousemove', (e) => { if (dragging) seek(e.clientX); });
            window.addEventListener('mouseup', () => { dragging = false; });
            wrap?.addEventListener('scroll', () => this._renderMinimap(), { passive: true });
            // Re-render à chaque resize de la modale
            const ro = new ResizeObserver(() => this._renderMinimap());
            ro.observe(canvas);
        }
    }

    _renderRuler() {
        const ruler = this.$('#la-ruler');
        if (!ruler) return;
        const BAR_W = this._barWidth();
        // Spacer 120px = largeur des track-labels, garantit que la 1ère
        // mesure du ruler est alignée avec le début des cells.
        let html = '<div class="la-ruler-spacer" aria-hidden="true"></div>';
        for (let b = 0; b < this.arrangementBars; b++) {
            const marker = (b % 4 === 0) ? `<span class="la-ruler-label">${b+1}</span>` : '';
            html += `<div class="la-ruler-cell" data-ruler-bar="${b}" style="width:${BAR_W}px">${marker}</div>`;
        }
        ruler.style.width = (120 + BAR_W * this.arrangementBars) + 'px';
        ruler.innerHTML = html;
        if (!ruler.dataset.lcWired) {
            ruler.dataset.lcWired = '1';
            ruler.title = this.t('loopManager.rulerClickHint');
            ruler.style.cursor = 'pointer';
            ruler.addEventListener('click', (e) => {
                const cell = e.target.closest('[data-ruler-bar]');
                if (!cell) return;
                const bar = parseInt(cell.dataset.rulerBar);
                if (Number.isNaN(bar)) return;
                if (this.isArrangerPlaying) {
                    this._stopArrangerPlay();
                    this._playArrangement(bar);
                } else {
                    this._arrangerStartBar = bar;
                    this._renderArrangerStartMarker();
                }
            });
        }
        this._renderArrangerStartMarker();
    }

    _renderArrangerStartMarker() {
        const wrap = this.$('#la-timeline-wrap');
        if (!wrap) return;
        let marker = wrap.querySelector('.la-start-marker');
        if (this._arrangerStartBar <= 0 || this.isArrangerPlaying) {
            marker?.remove();
            return;
        }
        if (!marker) {
            marker = document.createElement('div');
            marker.className = 'la-start-marker';
            wrap.appendChild(marker);
        }
        const BAR_W  = this._barWidth();
        const labelW = this.$('.la-track-label')?.offsetWidth || 120;
        marker.style.transform = `translateX(${labelW + this._arrangerStartBar * BAR_W}px)`;
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
        const muted  = this._trackMute.has(track.id);
        const soloed = this._trackSolo.has(track.id);
        const audible = this._isTrackAudible(track.id);
        const trackEl = document.createElement('div');
        trackEl.className = `la-track${muted ? ' la-track--muted' : ''}${soloed ? ' la-track--solo' : ''}${audible ? '' : ' la-track--silent'}`;
        trackEl.dataset.trackId = track.id;
        trackEl.style.height = this._trackHeight() + 'px';
        // Label par défaut « Piste N » côté client si le backend n'en a
        // pas posé (Phase 1 a vidé les labels par défaut pour i18n).
        const defaultLabel = this.t('loopManager.defaultTrackName', { index: (track.track_index ?? 0) + 1 })
            || `Track ${(track.track_index ?? 0) + 1}`;
        const displayLabel = (track.label && track.label.trim()) || defaultLabel;
        trackEl.innerHTML = `
            <div class="la-track-label">
                <input type="text" class="la-track-name-input lc-name-input"
                    value="${this.escape(displayLabel)}"
                    placeholder="${this.escape(defaultLabel)}"
                    aria-label="${this.t('loopManager.trackName') || 'Track name'}"
                    data-track-id="${track.id}" />
                <button class="la-track-toggle la-track-toggle--mute${muted ? ' la-track-toggle--active' : ''}"
                    data-track-action="mute" data-track-id="${track.id}"
                    aria-pressed="${muted}" title="${this.t('loopManager.trackMute')}">M</button>
                <button class="la-track-toggle la-track-toggle--solo${soloed ? ' la-track-toggle--active' : ''}"
                    data-track-action="solo" data-track-id="${track.id}"
                    aria-pressed="${soloed}" title="${this.t('loopManager.trackSolo')}">S</button>
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
            this._dragInfo = { type: 'block', loopBars: block.loop_bars, reps: block.repetitions };
        });
        cells.addEventListener('dragend', (e) => {
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (blockEl) blockEl.classList.remove('la-block--dragging');
            this._hideDropPreview();
            this._dragInfo = null;
        });
        cells.addEventListener('dragover',  (e) => {
            e.preventDefault();
            // dropEffect doit matcher effectAllowed posé au dragstart :
            // - palette chip / library card → effectAllowed='copy' → dropEffect='copy'
            // - block existant → effectAllowed='move' → dropEffect='move'
            // Firefox (strict HTML5 DnD spec) annule le drop si mismatch
            // → bouton drop pas firé.
            e.dataTransfer.dropEffect = (this._dragInfo?.type === 'block') ? 'move' : 'copy';
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

        // Resize handle — initiates a custom drag that updates repetitions live
        cells.addEventListener('mousedown', (e) => {
            const handle = e.target.closest('[data-block-resize]');
            if (!handle) return;
            e.preventDefault();
            e.stopPropagation();
            const blockEl = handle.closest('.la-block');
            const blockId = parseInt(handle.dataset.blockResize);
            const block   = this.blocks.find(b => b.id === blockId);
            if (!block || !blockEl) return;
            const rect    = blockEl.getBoundingClientRect();
            this._resizeState = {
                blockId,
                blockEl,
                leftPx:   rect.left,
                barW:     this._barWidth(),
                loopBars: block.loop_bars,
                origReps: block.repetitions,
                newReps:  block.repetitions
            };
            blockEl.classList.add('la-block--resizing');
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
        trackEl.querySelector('[data-track-action="mute"]')?.addEventListener('click', () => this._toggleTrackMute(track.id));
        trackEl.querySelector('[data-track-action="solo"]')?.addEventListener('click', () => this._toggleTrackSolo(track.id));
        // Le sélecteur de canal MIDI a été retiré du header de track : le
        // routing canal est automatiquement géré par _playArrangement
        // (allocation dynamique selon les programmes utilisés).
        return trackEl;
    }

    _isTrackAudible(trackId) {
        if (this._trackMute.has(trackId)) return false;
        if (this._trackSolo.size > 0)     return this._trackSolo.has(trackId);
        return true;
    }

    _toggleTrackMute(trackId) {
        if (this._trackMute.has(trackId)) this._trackMute.delete(trackId);
        else                              this._trackMute.add(trackId);
        this._renderTracks();
    }

    _toggleTrackSolo(trackId) {
        if (this._trackSolo.has(trackId)) this._trackSolo.delete(trackId);
        else                              this._trackSolo.add(trackId);
        this._renderTracks();
    }

    _buildCells(trackId, BAR_W) {
        let html = '';
        this.blocks.filter(b => b.track_id === trackId).forEach((block) => {
            const loop   = this.library.find(l => l.id === block.loop_id);
            const family = LoopUtils.familyForProgram(loop?.instrument_program ?? 0);
            const blockW = block.loop_bars * block.repetitions * BAR_W;
            const blockL = block.position_bar * BAR_W;
            const selected = this._selectedBlocks.has(block.id);
            const endBar   = block.position_bar + block.loop_bars * block.repetitions;
            const overflow = endBar > this.arrangementBars;
            const classes  = ['la-block'];
            if (selected) classes.push('la-block--selected');
            if (overflow) classes.push('la-block--overflow');
            const title = overflow
                ? this.t('loopManager.blockOverflow', { end: endBar, total: this.arrangementBars })
                : this.t('loopManager.blockDragHint');
            html += `<div class="${classes.join(' ')}"
                draggable="true" data-block-id="${block.id}" data-loop-bars="${block.loop_bars}"
                data-block-reps="${block.repetitions}"
                data-wide="${blockW >= 70 ? 'true' : 'false'}"
                style="left:${blockL}px;width:${blockW}px;background:${family.color}"
                title="${title}">
                <div class="la-block-label">${this._instrIconHtml(loop?.instrument_program ?? 0, 'instrument', 'la-block-icon')} ${this.escape(block.loop_name)} ×${block.repetitions}${overflow ? ' ⚠' : ''}</div>
                <div class="la-block-actions">
                    <button class="la-block-btn" draggable="false" data-block-action="reps-dec" data-block-id="${block.id}">−</button>
                    <span class="la-block-reps">${block.repetitions}</span>
                    <button class="la-block-btn" draggable="false" data-block-action="reps-inc" data-block-id="${block.id}">+</button>
                    <button class="la-block-btn la-block-btn--del" draggable="false" data-block-action="delete" data-block-id="${block.id}" title="${this.t('loopCreator.deleteBlock')}">✕</button>
                </div>
                <div class="la-block-resize" draggable="false" data-block-resize="${block.id}" title="${this.t('loopManager.dragToResize')}"></div>
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

    _copySelectedBlocks() {
        const sel = this.blocks.filter(b => this._selectedBlocks.has(b.id));
        if (!sel.length) return;
        const minBar = Math.min(...sel.map(b => b.position_bar));
        const tracksOrder = this.tracks.map(t => t.id);
        const minTrackIdx = Math.min(...sel.map(b => tracksOrder.indexOf(b.track_id)));
        this._blockClipboard = sel.map(b => ({
            loop_id:        b.loop_id,
            loop_name:      b.loop_name,
            loop_bars:      b.loop_bars,
            repetitions:    b.repetitions,
            track_offset:   tracksOrder.indexOf(b.track_id) - minTrackIdx,
            bar_offset:     b.position_bar - minBar
        }));
        LoopUtils.toast?.(this.t('loopManager.blocksCopied', { count: sel.length }), 'info');
    }

    async _pasteBlocks(targetTrackId = null, targetBar = null) {
        if (!this._blockClipboard.length || !this.currentArrangementId) return;
        const tracksOrder = this.tracks.map(t => t.id);
        if (!tracksOrder.length) return;
        // Default paste anchor: after the rightmost existing block on the first track
        const baseTrackIdx = targetTrackId != null
            ? Math.max(0, tracksOrder.indexOf(targetTrackId))
            : 0;
        const baseBar = targetBar != null
            ? targetBar
            : this._nextFreeBar(tracksOrder[baseTrackIdx]);
        const newBlocks = [];
        for (const item of this._blockClipboard) {
            const trackIdx = Math.min(tracksOrder.length - 1, baseTrackIdx + item.track_offset);
            const trackId  = tracksOrder[trackIdx];
            const posBar   = Math.max(0, Math.min(this.arrangementBars - 1, baseBar + item.bar_offset));
            try {
                const r = await this.api.sendCommand('arrangement_add_block', {
                    trackId, loopId: item.loop_id, position_bar: posBar, repetitions: item.repetitions
                });
                const created = {
                    id: r.blockId, track_id: trackId, loop_id: item.loop_id,
                    position_bar: posBar, repetitions: item.repetitions,
                    loop_name: item.loop_name, loop_bars: item.loop_bars
                };
                this.blocks.push(created);
                newBlocks.push(created.id);
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.paste', {
                    toast: this.t('loopManager.errSave')
                });
            }
        }
        if (newBlocks.length) {
            this._selectedBlocks = new Set(newBlocks);
            this._renderTimeline();
            this._pushArrHistory();
        }
    }

    async _duplicateSelectedBlocks() {
        const sel = this.blocks.filter(b => this._selectedBlocks.has(b.id));
        if (!sel.length) return;
        const newIds = [];
        for (const b of sel) {
            const span     = b.loop_bars * b.repetitions;
            const posBar   = Math.max(0, Math.min(this.arrangementBars - 1, b.position_bar + span));
            try {
                const r = await this.api.sendCommand('arrangement_add_block', {
                    trackId: b.track_id, loopId: b.loop_id, position_bar: posBar, repetitions: b.repetitions
                });
                const dup = {
                    id: r.blockId, track_id: b.track_id, loop_id: b.loop_id,
                    position_bar: posBar, repetitions: b.repetitions,
                    loop_name: b.loop_name, loop_bars: b.loop_bars
                };
                this.blocks.push(dup);
                newIds.push(dup.id);
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.duplicate', {
                    toast: this.t('loopManager.errSave')
                });
            }
        }
        if (newIds.length) {
            this._selectedBlocks = new Set(newIds);
            this._renderTimeline();
            this._pushArrHistory();
        }
    }

    _nextFreeBar(trackId) {
        let end = 0;
        for (const b of this.blocks) {
            if (b.track_id !== trackId) continue;
            const e = b.position_bar + b.loop_bars * b.repetitions;
            if (e > end) end = e;
        }
        return Math.min(end, Math.max(0, this.arrangementBars - 1));
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
        if (this._arrangerZoom === 1 && this._arrangerZoomV === 1) return;
        this._arrangerZoom  = 1;
        this._arrangerZoomV = 1;
        this._renderTimeline();
    }

    _arrZoomV(factor) {
        const next = Math.max(0.6, Math.min(3, (this._arrangerZoomV || 1) * factor));
        if (next === this._arrangerZoomV) return;
        this._arrangerZoomV = next;
        this._renderTracks();
    }

    _trackHeight() {
        return Math.round(50 * (this._arrangerZoomV || 1));
    }

    _toggleLoopPlayback() {
        this._arrangerLoop = !this._arrangerLoop;
        const btn = this.$('#la-loop-btn');
        if (btn) {
            btn.setAttribute('aria-pressed', this._arrangerLoop ? 'true' : 'false');
            btn.classList.toggle('lc-btn-icon--active', this._arrangerLoop);
        }
    }

    _toggleCountIn() {
        this._arrangerCountIn = !this._arrangerCountIn;
        const btn = this.$('#la-countin-btn');
        if (btn) {
            btn.setAttribute('aria-pressed', this._arrangerCountIn ? 'true' : 'false');
            btn.classList.toggle('lc-btn-icon--active', this._arrangerCountIn);
        }
    }

    _barFromX(offsetX, barW) {
        return Math.max(0, Math.min(this.arrangementBars - 1, Math.floor(offsetX / barW)));
    }

    _showDropPreview(cells, bar, barW) {
        this._hideDropPreview();
        const info     = this._dragInfo || {};
        const widthBars = Math.max(1, (info.loopBars || 1) * (info.reps || 1));
        const preview  = document.createElement('div');
        preview.className  = 'la-drop-preview';
        preview.style.left  = (bar * barW) + 'px';
        preview.style.width = (widthBars * barW) + 'px';
        if (bar + widthBars > this.arrangementBars) preview.classList.add('la-drop-preview--overflow');
        cells.appendChild(preview);
        this._dropPreview = preview;
    }

    _hideDropPreview() { this._dropPreview?.remove(); this._dropPreview = null; }

    // =========================================================
    // ARRANGER — CRUD
    // =========================================================

    async _addTrack() {
        if (!this.currentArrangementId) return;
        const label = `Track ${this.tracks.length + 1}`;
        try {
            const r = await this.api.sendCommand('arrangement_add_track', {
                arrangementId: this.currentArrangementId,
                label
            });
            this.tracks.push({
                id: r.trackId,
                arrangement_id: this.currentArrangementId,
                track_index: this.tracks.length,
                label,
                midi_channel: 1
            });
            this._renderTimeline();
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

    async _saveArrangement({ silent = false } = {}) {
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
                if (!silent) LoopUtils.toast(this.t('loopCreator.statusSaved'), 'success');
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

    async _duplicateArrangement(sourceId) {
        if (this._arrDirty && !confirm(this.t('loopManager.confirmSwitchArrangement'))) return;
        try {
            const r = await this.api.sendCommand('arrangement_get', { arrangementId: sourceId });
            const { arrangement, tracks, blocks } = r;
            const create = await this.api.sendCommand('arrangement_create', {
                name: this.t('loopManager.copySuffix', { name: arrangement.name }),
                global_tempo: arrangement.global_tempo,
                total_bars:   arrangement.total_bars
            });
            const newId = create.arrangementId;
            // _create auto-adds 3 default tracks — remove them first
            const created = await this.api.sendCommand('arrangement_get', { arrangementId: newId });
            for (const t of created.tracks) {
                await this.api.sendCommand('arrangement_delete_track', { trackId: t.id });
            }
            // Recreate source tracks (keeping order) and remember the id mapping
            const trackIdMap = new Map();
            for (let i = 0; i < tracks.length; i++) {
                const src = tracks[i];
                const tr = await this.api.sendCommand('arrangement_add_track', {
                    arrangementId: newId,
                    label: src.label,
                    midi_channel: src.midi_channel,
                    track_index: i
                });
                trackIdMap.set(src.id, tr.trackId);
            }
            // Recreate blocks
            for (const b of blocks) {
                const newTrackId = trackIdMap.get(b.track_id);
                if (!newTrackId) continue;
                await this.api.sendCommand('arrangement_add_block', {
                    trackId: newTrackId,
                    loopId:  b.loop_id,
                    position_bar: b.position_bar,
                    repetitions: b.repetitions
                });
            }
            await this._loadArrangementById(newId);
            LoopUtils.toast?.(this.t('loopManager.arrangementDuplicated'), 'success');
        } catch (err) {
            LoopUtils.handleError(err, 'arr.duplicate', {
                toast: this.t('loopManager.errDuplicateArrangement')
            });
        }
    }

    _adjustArrTempo(d) {
        const prev = this.arrangementTempo;
        this.arrangementTempo = LoopUtils.validate.tempo(prev + d, prev);
        const el = this.$('#la-tempo'); if (el) el.value = this.arrangementTempo;
        if (this.arrangementTempo !== prev) {
            this._markArrDirty(true);
            this._scheduleAutoSave();
        }
    }

    _adjustArrBars(d) {
        const prev = this.arrangementBars;
        this.arrangementBars = LoopUtils.validate.arrBars(prev + d, prev);
        const el = this.$('#la-bars'); if (el) el.value = this.arrangementBars;
        if (this.arrangementBars !== prev) {
            this._renderTimeline();
            this._pushArrHistory();
            this._scheduleAutoSave();
        }
    }

    // =========================================================
    // ARRANGER — PLAYBACK
    // =========================================================

    async _playArrangement(startBar = 0) {
        if (!this.currentArrangementId || this.isArrangerPlaying) return;
        this._stopArrangerPlay();
        this.isArrangerPlaying = true;
        this.$('#la-play-btn')?.classList.add('lc-btn-record--active');

        const secPerBar  = 60 / this.arrangementTempo * 4;
        this._arrangerStartBar = Math.max(0, Math.min(this.arrangementBars - 1, startBar | 0));
        const startSec   = this._arrangerStartBar * secPerBar;
        const totalSec   = this.arrangementBars * secPerBar;
        const events = [];
        const programsToLoad = new Set([0]);

        for (const block of this.blocks) {
            if (!this._isTrackAudible(block.track_id)) continue;
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
                    const evSec = offsetSec + note.t * spt;
                    if (evSec < startSec || evSec >= totalSec) continue;
                    events.push({
                        sec: evSec - startSec,
                        note: note.n, vel: note.v || 80,
                        durSec: (note.g || note.l || 120) * spt,
                        prog,
                        trackId: block.track_id
                    });
                }
            }
        }

        // Garde-fou : on ne peut router que 16 programmes distincts (canaux
        // MIDI 0-15). Au-delà, l'ancien code faisait `chIdx++ % 16` et
        // écrasait silencieusement les premiers canaux → instruments
        // sortaient avec le mauvais son (AUDIT §L4). Mieux vaut refuser
        // explicitement la lecture que la fausser.
        const MAX_DISTINCT_PROGRAMS = 16;
        if (programsToLoad.size > MAX_DISTINCT_PROGRAMS) {
            LoopUtils.toast(
                this.t('loopManager.errTooManyPrograms', { max: MAX_DISTINCT_PROGRAMS, count: programsToLoad.size })
                    || `Arrangement uses ${programsToLoad.size} distinct programs (max ${MAX_DISTINCT_PROGRAMS}). Playback cancelled.`,
                'error'
            );
            this.isArrangerPlaying = false;
            this.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
            return;
        }

        const target = this._getOutputTarget(this._arrangerSynth);

        // Preload all instruments used. Drum kits (prog ≥ 128) passent
        // par loadDrumKit() — loadInstrument() les traiterait comme un
        // programme mélodique et ne chargerait pas les samples de batterie.
        if (target) {
            for (const prog of programsToLoad) {
                if (prog >= 128) {
                    target.setChannelInstrument?.(9, prog);
                    await target.loadDrumKit?.().catch(err =>
                        LoopUtils.handleError(err, 'arr.synth.loadDrumKit'));
                } else if (!target.loadedInstruments?.has(prog)) {
                    await target.loadInstrument(prog).catch(err =>
                        LoopUtils.handleError(err, 'arr.synth.loadInstrument'));
                }
            }
        }

        // Allocate channels: tracks with a custom midi_channel keep theirs;
        // remaining programs auto-assign onto the rest.
        const trackChMap = new Map();   // trackId → channel
        const usedCh     = new Set();
        for (const t of this.tracks) {
            const ch = (t.midi_channel ?? 0);
            if (ch > 0 && ch <= 16 && !usedCh.has(ch - 1)) {
                trackChMap.set(t.id, ch - 1);
                usedCh.add(ch - 1);
            }
        }
        // Second garde-fou (AUDIT §L4) : programmes + canaux pré-réservés
        // par les tracks ne doivent pas dépasser 16 au total. Le check
        // initial sur programsToLoad.size > 16 ne couvrait pas le cas où
        // des tracks revendiquent un midi_channel personnalisé (usedCh).
        if (programsToLoad.size + usedCh.size > 16) {
            LoopUtils.toast(
                this.t('loopManager.errTooManyPrograms', {
                    max: 16 - usedCh.size,
                    count: programsToLoad.size
                }) || `Arrangement needs ${programsToLoad.size + usedCh.size} MIDI channels (max 16). Playback cancelled.`,
                'error'
            );
            this.isArrangerPlaying = false;
            this.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
            return;
        }
        // Drum programs (prog ≥ 128) sont épinglés sur le canal 9 (canal GM
        // drums) ; le synth ne reconnaît un kit que là. On réserve donc
        // le canal 9 avant d'auto-allouer les autres programmes pour éviter
        // qu'un instrument mélodique ne le récupère.
        const programChannelMap = new Map();
        const hasDrumProgram = [...programsToLoad].some(p => p >= 128);
        if (hasDrumProgram) usedCh.add(9);
        let chIdx = 0;
        const nextFreeCh = () => {
            while (chIdx < 16 && usedCh.has(chIdx)) chIdx++;
            const c = chIdx % 16;
            chIdx++;
            return c;
        };
        for (const prog of programsToLoad) {
            const ch = prog >= 128 ? 9 : nextFreeCh();
            programChannelMap.set(prog, ch);
            try { target?.setChannelInstrument?.(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'arr.synth.setChannelInstrument'); }
        }
        // Set per-track channel programs (channel hosts that track's loop progs)
        for (const [trackId, ch] of trackChMap) {
            // Use the first block on that track to determine which program to load
            const block = this.blocks.find(b => b.track_id === trackId);
            if (!block) continue;
            const loop = this.library.find(l => l.id === block.loop_id);
            const prog = loop?.instrument_program ?? 0;
            try { target?.setChannelInstrument?.(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'arr.synth.setChannelInstrument.track'); }
        }

        const scheduleEvents = (offsetMs) => {
            for (const ev of events) {
                // Drum events ignorent l'override midi_channel du track :
                // ils DOIVENT sortir sur le canal 9 pour que le synth les
                // route via drumPresets au lieu du chemin mélodique.
                const ch = ev.prog >= 128
                    ? 9
                    : (trackChMap.has(ev.trackId)
                        ? trackChMap.get(ev.trackId)
                        : (programChannelMap.get(ev.prog) ?? 0));
                this._arrangerTimers.push(setTimeout(() => {
                    if (!this.isArrangerPlaying) return;
                    try { target?.playNote?.(ev.note, ev.vel, ch, ev.durSec); }
                    catch (err) { LoopUtils.handleError(err, 'arr.synth.playNote'); }
                }, offsetMs + ev.sec * 1000));
            }
        };

        events.sort((a, b) => a.sec - b.sec);

        const countInMs = this._arrangerCountIn ? secPerBar * 1000 : 0;
        const playableMs = (totalSec - startSec) * 1000;

        if (this._arrangerCountIn) {
            this._scheduleCountIn(target, secPerBar);
            // Le count-in réécrit channel 9 avec le Woodblock (programme 115).
            // S'il y a un drum kit dans l'arrangement, on restaure son programme
            // juste avant que les notes drum ne démarrent, sinon le synth
            // utilisera kit 115 au lieu du kit choisi par l'utilisateur.
            if (hasDrumProgram) {
                const drumProg = [...programsToLoad].find(p => p >= 128);
                this._arrangerTimers.push(setTimeout(() => {
                    if (!this.isArrangerPlaying) return;
                    try { target?.setChannelInstrument?.(9, drumProg); }
                    catch (err) { LoopUtils.handleError(err, 'arr.restoreDrumProg'); }
                }, Math.max(0, countInMs - 5)));
            }
        }
        scheduleEvents(countInMs);

        if (this._arrangerLoop) {
            // Re-arm playback when the iteration completes (cooperative loop)
            this._arrangerTimers.push(setTimeout(() => {
                if (!this.isArrangerPlaying) return;
                this.isArrangerPlaying = false;
                this._arrangerTimers.forEach(t => clearTimeout(t));
                this._arrangerTimers = [];
                this._playArrangement(0);
            }, countInMs + playableMs));
        } else {
            this._arrangerTimers.push(setTimeout(() => this._stopArrangerPlay(), countInMs + playableMs));
        }

        this._arrangerStartTime = performance.now() + countInMs;
        this._startPlaybarRAF();
    }

    _scheduleCountIn(target, secPerBar) {
        // 4 clicks (a beat) using GM Woodblock (program 115) on channel 9
        const ch = 9;
        try { target?.setChannelInstrument?.(ch, 115); }
        catch (err) { LoopUtils.handleError(err, 'arr.countIn.setProgram'); }
        const beatMs = (secPerBar / 4) * 1000;
        for (let i = 0; i < 4; i++) {
            this._arrangerTimers.push(setTimeout(() => {
                if (!this.isArrangerPlaying) return;
                try { target?.playNote?.(76, 100, ch, 0.08); }
                catch (err) { LoopUtils.handleError(err, 'arr.countIn.playNote'); }
            }, i * beatMs));
        }
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
        this._renderArrangerStartMarker();
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
        const bar = Math.min(this.arrangementBars, this._arrangerStartBar + elapsedSec / secPerBar);
        const labelW = this.$('.la-track-label')?.offsetWidth || 120;
        ph.style.display = 'block';
        ph.style.transform = `translateX(${labelW + bar * BAR_W}px)`;
    }

    _renderPlaybar() {
        const fill = this.$('#lc-playbar-fill');
        if (!fill) return;

        if (this.isArrangerPlaying && this._arrangerStartTime) {
            fill.classList.remove('lc-playbar-fill--looping');
            fill.style.removeProperty('--playbar-dur');
            const secPerBar = 60 / this.arrangementTempo * 4;
            const totalMs   = this.arrangementBars * secPerBar * 1000;
            const startMs   = this._arrangerStartBar * secPerBar * 1000;
            const elapsed   = performance.now() - this._arrangerStartTime;
            const pct = Math.min(100, Math.max(0, (startMs + elapsed) / totalMs * 100));
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
    // DRAG (doc-level — block resize via right-edge handle)
    // =========================================================

    _onDocMouseMove(e) {
        const r = this._resizeState;
        if (!r) return;
        // Recalcul à chaque move : barW peut avoir changé (resize fenêtre,
        // zoom changé via raccourci), et leftPx peut s'être décalé (scroll
        // horizontal du container). Le coût d'un getBoundingClientRect par
        // mousemove est négligeable comparé à un décalage de plusieurs
        // mesures pendant un drag (AUDIT §L3).
        const curRect = r.blockEl.getBoundingClientRect();
        const curBarW = this._barWidth();
        if (curBarW > 0) r.barW = curBarW;
        r.leftPx = curRect.left;
        const widthPx     = Math.max(r.barW, e.clientX - r.leftPx);
        const newReps     = Math.max(1, Math.round(widthPx / (r.loopBars * r.barW)));
        if (newReps === r.newReps) return;
        r.newReps = newReps;
        const w = r.loopBars * newReps * r.barW;
        r.blockEl.style.width = w + 'px';
        const repsLabel = r.blockEl.querySelector('.la-block-reps');
        if (repsLabel) repsLabel.textContent = newReps;
        const nameLabel = r.blockEl.querySelector('.la-block-label');
        if (nameLabel) {
            const block = this.blocks.find(b => b.id === r.blockId);
            const overflow = block && (block.position_bar + r.loopBars * newReps > this.arrangementBars);
            r.blockEl.classList.toggle('la-block--overflow', !!overflow);
        }
        r.blockEl.dataset.wide = w >= 70 ? 'true' : 'false';
    }

    async _onDocMouseUp() {
        const r = this._resizeState;
        if (!r) return;
        this._resizeState = null;
        r.blockEl.classList.remove('la-block--resizing');
        if (r.newReps === r.origReps) return;
        try {
            await this.api.sendCommand('arrangement_update_block', {
                blockId: r.blockId, repetitions: r.newReps
            });
            const block = this.blocks.find(b => b.id === r.blockId);
            if (block) block.repetitions = r.newReps;
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.resize', {
                toast: this.t('loopManager.errSave')
            });
            this._renderTimeline();
        }
    }
}

// Expose both names for backward compatibility
if (typeof window !== 'undefined') {
    window.LoopManagerModal  = LoopManagerModal;
    window.LoopCreatorModal  = LoopManagerModal;
}
