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
    /** Back-compat: every feature reads `modal._globalOutput`. */
    get _globalOutput() { return this.outputRouter?.globalOutput || { mode: 'synth', deviceId: null, channel: 0 }; }
    /** Back-compat: Live/Pad stop-all reads `_deviceShim` for cancelAllNotes. */
    get _deviceShim() { return this.outputRouter?.deviceShim || null; }
    set _deviceShim(v) { if (this.outputRouter) this.outputRouter.deviceShim = v; }
    /** Back-compat: cached device list. */
    get _cachedDevices() { return this.outputRouter?.cachedDevices || []; }

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

        // ── View (HTML rendering) and Events sub-features (audit §1.3).
        this.view = typeof LoopCreatorModalView !== 'undefined'
            ? new LoopCreatorModalView(this)
            : null;
        this.events = typeof LoopCreatorModalEvents !== 'undefined'
            ? new LoopCreatorModalEvents(this)
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
        // Extracted to LoopManagerOutputRouter (audit §6.6). State lives
        // on the router; the modal exposes getters for back-compat.
        this.outputRouter = typeof LoopManagerOutputRouter !== 'undefined'
            ? new LoopManagerOutputRouter(this)
            : null;

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

    // Delegates to view sub-feature (extracted per audit §1.3)
    _renderHeader()        { return this.view?._renderHeader() ?? ''; }
    renderBody()           { return this.view?.renderBody() ?? ''; }
    _renderKeyboardTab()   { return this.view?._renderKeyboardTab() ?? ''; }
    renderFooter()         { return this.view?.renderFooter() ?? ''; }
    _renderLibraryTab()    { return this.view?._renderLibraryTab() ?? ''; }
    _renderPadTab()        { return this.view?._renderPadTab() ?? ''; }
    _renderLiveTab()       { return this.view?._renderLiveTab() ?? ''; }
    _renderArrangerTab()   { return this.view?._renderArrangerTab() ?? ''; }

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
    async _loadHeaderOutputDevices() { return this.outputRouter?.loadDevices(); }
    _refreshHeaderOutputUI()         { this.outputRouter?.refreshUI(); }
    _toggleHeaderOutput()            { this.outputRouter?.toggleMode(); }
    _setGlobalOutput(next)           { this.outputRouter?.setOutput(next); }
    _panicCurrentDevice(target)      { this.outputRouter?.panicTarget(target); }
    _getOutputTarget(fallbackSynth)  { return this.outputRouter?.getTarget(fallbackSynth) ?? fallbackSynth; }


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

    // Delegates to events sub-feature (extracted per audit §1.3)
    _onKeyDown(e)                          { return this.events?._onKeyDown(e); }
    _switchTab(tab)                        { return this.events?._switchTab(tab); }
    _attachEvents()                        { return this.events?._attachEvents(); }
    _onClick(e)                            { return this.events?._onClick(e); }
    _onContextMenu(e)                      { return this.events?._onContextMenu(e); }
    _openBlockMenu(x, y)                   { return this.events?._openBlockMenu(x, y); }
    _closeBlockMenu()                      { return this.events?._closeBlockMenu(); }
    _onChange(e)                           { return this.events?._onChange(e); }
    _onInput(e)                            { return this.events?._onInput(e); }

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

    _gmProgramName(prog)                          { return this.view?.gmProgramName(prog) ?? `Program ${prog}`; }
    _instrIconHtml(prog, kind, extraClass)        { return this.view?.instrIconHtml(prog, kind, extraClass) ?? ""; }

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



    _renderPlaybar()                          { return this.view?._renderPlaybar(); }


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
