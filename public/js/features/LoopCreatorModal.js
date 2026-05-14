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

// ARRANGER_HISTORY_LIMIT moved to LoopManagerArrangerFeature (audit §6.6).

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
        this._arrDirty       = false; // explicit init (pre-refactor relied on undefined→falsy)
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

        // ── Arranger tab feature (extracted to LoopManagerArrangerFeature
        // per audit §6.6). State stays on the modal (currentArrangementId,
        // tracks, blocks, _arr*, etc.) — the feature holds the methods.
        this.arrangerFeature = typeof LoopManagerArrangerFeature !== 'undefined'
            ? new LoopManagerArrangerFeature(this)
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
    // ARRANGER — delegated to LoopManagerArrangerFeature (audit §6.6)
    // State stays on the modal; the feature holds the methods only.
    // =========================================================

    async _initArrangerSynth()      { return this.arrangerFeature?._initArrangerSynth(); }
    async _initArrangerTab()        { return this.arrangerFeature?._initArrangerTab(); }
    _renderArrangerEmptyState()     { this.arrangerFeature?._renderArrangerEmptyState(); }
    async _purgeEmptyArrangements() { return this.arrangerFeature?._purgeEmptyArrangements(); }
    async _loadArrangements()       { return this.arrangerFeature?._loadArrangements(); }
    _renderArrList(arrs)            { this.arrangerFeature?._renderArrList(arrs); }
    async _newArrangementConfirm()  { return this.arrangerFeature?._newArrangementConfirm(); }
    async _requestLoadArrangement(id) { return this.arrangerFeature?._requestLoadArrangement(id); }
    async _newArrangement()         { return this.arrangerFeature?._newArrangement(); }
    async _loadArrangementById(id)  { return this.arrangerFeature?._loadArrangementById(id); }
    _snapshotArr()                  { return this.arrangerFeature?._snapshotArr(); }
    _resetArrHistory()              { this.arrangerFeature?._resetArrHistory(); }
    _pushArrHistory()               { this.arrangerFeature?._pushArrHistory(); }
    _arrUndo()                      { this.arrangerFeature?._arrUndo(); }
    _arrRedo()                      { this.arrangerFeature?._arrRedo(); }
    _restoreArrSnapshot(snap)       { this.arrangerFeature?._restoreArrSnapshot(snap); }
    _markArrDirty(dirty)            { this.arrangerFeature?._markArrDirty(dirty); }
    _refreshUndoButtons()           { this.arrangerFeature?._refreshUndoButtons(); }
    _renderPalette()                { this.arrangerFeature?._renderPalette(); }
    _renderTimeline()               { this.arrangerFeature?._renderTimeline(); }
    _renderMinimap()                { this.arrangerFeature?._renderMinimap(); }
    _renderRuler()                  { this.arrangerFeature?._renderRuler(); }
    _renderArrangerStartMarker()    { this.arrangerFeature?._renderArrangerStartMarker(); }
    _renderTracks()                 { this.arrangerFeature?._renderTracks(); }
    _buildTrackEl(track)            { return this.arrangerFeature?._buildTrackEl(track); }
    _isTrackAudible(id)             { return this.arrangerFeature?._isTrackAudible(id); }
    _toggleTrackMute(id)            { this.arrangerFeature?._toggleTrackMute(id); }
    _toggleTrackSolo(id)            { this.arrangerFeature?._toggleTrackSolo(id); }
    _buildCells(trackId, BAR_W)     { return this.arrangerFeature?._buildCells(trackId, BAR_W); }
    _toggleBlockSelection(id, add)  { this.arrangerFeature?._toggleBlockSelection(id, add); }
    _clearBlockSelection()          { this.arrangerFeature?._clearBlockSelection(); }
    _refreshBlockSelectionUI()      { this.arrangerFeature?._refreshBlockSelectionUI(); }
    async _deleteSelectedBlocks()   { return this.arrangerFeature?._deleteSelectedBlocks(); }
    _copySelectedBlocks()           { this.arrangerFeature?._copySelectedBlocks(); }
    async _pasteBlocks(trk, bar)    { return this.arrangerFeature?._pasteBlocks(trk, bar); }
    async _duplicateSelectedBlocks(){ return this.arrangerFeature?._duplicateSelectedBlocks(); }
    _nextFreeBar(trackId)           { return this.arrangerFeature?._nextFreeBar(trackId); }
    _barWidth()                     { return this.arrangerFeature?._barWidth() ?? 0; }
    _arrZoom(factor)                { this.arrangerFeature?._arrZoom(factor); }
    _arrZoomReset()                 { this.arrangerFeature?._arrZoomReset(); }
    _arrZoomV(factor)               { this.arrangerFeature?._arrZoomV(factor); }
    _trackHeight()                  { return this.arrangerFeature?._trackHeight() ?? 0; }
    _toggleLoopPlayback()           { this.arrangerFeature?._toggleLoopPlayback(); }
    _toggleCountIn()                { this.arrangerFeature?._toggleCountIn(); }
    _barFromX(offsetX, barW)        { return this.arrangerFeature?._barFromX(offsetX, barW); }
    _showDropPreview(cells, b, w)   { this.arrangerFeature?._showDropPreview(cells, b, w); }
    _hideDropPreview()              { this.arrangerFeature?._hideDropPreview(); }
    async _addTrack()               { return this.arrangerFeature?._addTrack(); }
    async _deleteTrack(id)          { return this.arrangerFeature?._deleteTrack(id); }
    async _addBlock(t, l, b, lb)    { return this.arrangerFeature?._addBlock(t, l, b, lb); }
    async _moveBlock(id, t, b)      { return this.arrangerFeature?._moveBlock(id, t, b); }
    async _changeReps(id, d)        { return this.arrangerFeature?._changeReps(id, d); }
    async _deleteBlock(id)          { return this.arrangerFeature?._deleteBlock(id); }
    async _saveArrangement(opts)    { return this.arrangerFeature?._saveArrangement(opts); }
    async _deleteArrangement(id)    { return this.arrangerFeature?._deleteArrangement(id); }
    async _duplicateArrangement(id) { return this.arrangerFeature?._duplicateArrangement(id); }
    _adjustArrTempo(d)              { this.arrangerFeature?._adjustArrTempo(d); }
    _adjustArrBars(d)               { this.arrangerFeature?._adjustArrBars(d); }
    async _playArrangement(bar)     { return this.arrangerFeature?._playArrangement(bar); }
    _scheduleCountIn(target, sec)   { this.arrangerFeature?._scheduleCountIn(target, sec); }
    _stopArrangerPlay()             { this.arrangerFeature?._stopArrangerPlay(); }
    _startPlaybarRAF()              { this.arrangerFeature?._startPlaybarRAF(); }
    _stopPlaybarRAF()               { this.arrangerFeature?._stopPlaybarRAF(); }
    _renderArrangerPlayhead(s)      { this.arrangerFeature?._renderArrangerPlayhead(s); }
    _scheduleAutoSave(delay)        { this.arrangerFeature?._scheduleAutoSave(delay); }
    _onDocMouseMove(e)              { this.arrangerFeature?._onDocMouseMove(e); }
    async _onDocMouseUp()           { return this.arrangerFeature?._onDocMouseUp(); }



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

}

// Expose both names for backward compatibility
if (typeof window !== 'undefined') {
    window.LoopManagerModal  = LoopManagerModal;
    window.LoopCreatorModal  = LoopManagerModal;
}
