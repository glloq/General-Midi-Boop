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
        // Kit de batterie : routing canal 9 (convention GM) au lieu de
        // canal 0 mélodique. Mis à jour par onInstrumentSelected.
        this._isDrumKit = false;

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
        this.outputNoteMin = 36;
        this.outputNoteMax = 84;
        this.outputGmProgram = 0;

        // Piano roll editor (extracted component)
        this.pianoRollEditor = null;

        // Tabs: 'piano' (virtual keyboard) | 'editor' (piano roll)
        this.activeTab = 'piano';

        // Animation
        this._playheadRAF = null;
        this._playheadStartTime = 0;
        this._recordingRAF = null;

        // Debounced piano-roll refresh (for fast keystrokes on tempo/bars)
        this._refreshTimer = null;

        // Unsaved-changes tracking (snapshot taken at open + after each save)
        this._savedSnapshot = null;

        // Metronome / count-in
        this._metronomeEnabled = false;
        this._countInEnabled   = false;
        this._metronomeTimers  = [];
        this._metronomeCtx     = null;
        this._countInActive    = false;
    }

    _currentSnapshot() {
        const seq = this.pianoRollEditor?.getSequence() ?? this.sequence ?? [];
        return JSON.stringify({
            name: this.loopName,
            tempo: this.tempo,
            tsn: this.timeSigNum, tsd: this.timeSigDen,
            bars: this.bars, ppq: this.ppq,
            prog: this.instrumentProgram,
            seq
        });
    }

    _isDirty() {
        if (this._savedSnapshot == null) return false;
        return this._currentSnapshot() !== this._savedSnapshot;
    }

    _markSaved() {
        this._savedSnapshot = this._currentSnapshot();
    }

    // =========================================================
    // OPEN OVERRIDE — supports { loopId } arg for editing
    // =========================================================

    open({ loopId } = {}) {
        if (this.isOpen) return;
        if (loopId) {
            this._loadLoopStateById(loopId).then(() => {
                this.activeTab = 'editor';
                if (!this.isOpen) super.open();
            });
        } else {
            this._resetLoopState();
            this.activeTab = 'piano';
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
            // Restaure le flag drum kit à partir du programme stocké
            // (offset 128 dans MidiSynthesizer._decodeKitProgram).
            this._isDrumKit        = this.instrumentProgram >= 128;
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
        const timeSigOptions = [
            ['2/4','2','4'], ['3/4','3','4'], ['4/4','4','4'],
            ['5/4','5','4'], ['6/8','6','8'], ['7/8','7','8']
        ];
        const timeSigHtml = timeSigOptions.map(([label, num, den]) =>
            `<option value="${num}:${den}" ${this.timeSigNum == num && this.timeSigDen == den ? 'selected' : ''}>${label}</option>`
        ).join('');
        return `
        <div class="modal-header le-header">
            <div class="le-header-meta">
                <input type="text" class="lc-name-input le-name-input" id="lc-name-input"
                    value="${this.escape(this.loopName || this.t('loopCreator.untitled'))}"
                    placeholder="${this.t('loopCreator.namePlaceholder')}" />
                <div class="lc-spinbox" title="${this.t('loopCreator.tempo')}">
                    <button class="lc-spin-btn" data-action="tempo-dec">‹</button>
                    <input type="number" id="lc-tempo" class="lc-spin-input lc-spin-input--sm" value="${this.tempo}" min="20" max="300" step="1" />
                    <button class="lc-spin-btn" data-action="tempo-inc">›</button>
                </div>
                <span class="lc-unit le-header-unit">BPM</span>
                <select id="lc-timesig" class="lc-select lc-select-xs" title="${this.t('loopCreator.timeSignature')}">${timeSigHtml}</select>
                <div class="lc-spinbox" title="${this.t('loopCreator.bars')}">
                    <button class="lc-spin-btn" data-action="bars-dec">‹</button>
                    <input type="number" id="lc-bars" class="lc-spin-input lc-spin-input--sm" value="${this.bars}" min="1" max="32" step="1" />
                    <button class="lc-spin-btn" data-action="bars-inc">›</button>
                </div>
                <span class="lc-unit le-header-unit" title="${this.t('loopCreator.bars')}">M</span>
            </div>
            <div class="le-header-actions">
                <button class="lc-btn lc-btn-sm le-output-toggle" id="le-output-toggle"
                        data-action="toggle-output"
                        title="${this.t('loopCreator.outputLabel')}"
                        aria-pressed="false">
                    <span class="le-output-icon" id="le-output-icon" aria-hidden="true">🔊</span>
                    <span class="le-output-label" id="le-output-label">${this.t('loopManager.outputSynth')}</span>
                </button>
                <button class="lc-btn lc-btn-sm" data-action="save-loop-as-new" title="${this.t('loopEditor.saveAsNew')}">📋+</button>
                <button class="lc-btn lc-btn-primary lc-btn-sm" data-action="save-loop">💾 ${this.t('loopCreator.save')}</button>
                <button class="modal-close" data-action="close" aria-label="${this.t('common.close')}">&times;</button>
            </div>
        </div>`;
    }

    renderBody() {
        const isPianoTab = this.activeTab === 'piano';
        const isEditorTab = this.activeTab === 'editor';
        return `
        <div class="le-layout">
            <!-- ── Transport bar (big REC + Play/Stop / Metro/CountIn / minimap info) ── -->
            <div class="le-transport-bar">
                <button class="le-rec-big${''}" id="lc-record-btn" data-action="record"
                        title="${this.t('loopCreator.record')} (R)" aria-label="${this.t('loopCreator.record')}">
                    <span class="le-rec-big-dot"></span>
                    <span class="le-rec-big-label">REC</span>
                </button>

                <div class="le-transport-stack">
                    <div class="le-transport-row le-transport-row--top">
                        <button class="lc-btn lc-btn-icon le-btn-play"  data-action="preview"
                                title="${this.t('loopCreator.preview')} (Space)">▶</button>
                        <button class="lc-btn lc-btn-icon le-btn-stop"  data-action="stop-all"
                                title="${this.t('loopCreator.stop')} (Esc)">⏹</button>
                    </div>
                    <div class="le-transport-row le-transport-row--bot">
                        <button class="lc-btn lc-btn-icon" id="lc-metronome-btn" data-action="toggle-metronome"
                                aria-pressed="false" title="${this.t('loopEditor.metronome')}">🎼</button>
                        <button class="lc-btn lc-btn-icon" id="lc-countin-btn" data-action="toggle-count-in"
                                aria-pressed="false" title="${this.t('loopEditor.countIn')}">⏱</button>
                        <span class="lc-rec-indicator hidden" id="lc-rec-indicator"
                              role="status" aria-live="assertive"
                              aria-label="${this.t('loopCreator.recording') || 'Recording'}">
                            <span class="lc-rec-dot lc-rec-dot--pulse" aria-hidden="true"></span>
                            <span class="lc-rec-time" id="lc-rec-time">0:00</span>
                        </span>
                    </div>
                </div>

                <div class="le-minimap-info-wrap">
                    <canvas class="le-minimap-info" id="le-minimap-top"
                            aria-label="${this.t('loopEditor.minimapInfoAria')}"
                            aria-hidden="true"></canvas>
                </div>
            </div>

            <!-- ── Tabs ── -->
            <div class="le-tabs" role="tablist">
                <button class="le-tab${isPianoTab  ? ' le-tab--active' : ''}" data-le-tab="piano"  role="tab" aria-selected="${isPianoTab}">${this.t('loopEditor.tabPianoVirtuel')}</button>
                <button class="le-tab${isEditorTab ? ' le-tab--active' : ''}" data-le-tab="editor" role="tab" aria-selected="${isEditorTab}">${this.t('loopEditor.tabEditor')}</button>
            </div>

            <!-- ── Pane: Piano virtuel ── -->
            <div class="le-pane${isPianoTab ? '' : ' le-pane--hidden'}" id="le-pane-piano" role="tabpanel">
                <div class="lc-ctrl-bar le-ctrl-bar-piano le-ctrl-bar-piano--hidden" id="le-ctrl-bar-piano">
                    <span class="le-group-label">${this.t('loopEditor.groupInput')}</span>
                    <select id="lc-midi-in-device" class="lc-select lc-select-midi" title="${this.t('loopCreator.midiIn')}">
                        <option value="">—</option>
                    </select>
                    <span class="lc-status" id="le-midi-in-hint"></span>
                </div>
                <div class="lc-kb-panel le-kb-panel--standalone" id="lc-kb-panel"></div>
            </div>

            <!-- ── Pane: Éditeur (PianoRollEditor host) ── -->
            <div class="le-pane${isEditorTab ? '' : ' le-pane--hidden'}" id="le-pane-editor" role="tabpanel"></div>

            <!-- ── Status bar (commune) ── -->
            <div class="le-status-bar"><span class="lc-status" id="lc-status"></span></div>
        </div>`;
    }

    renderFooter() { return ''; }

    // =========================================================
    // LIFECYCLE
    // =========================================================

    onOpen() {
        this._initSynth();
        this._attachEvents();
        this._initPianoRollEditor();
        this._loadMidiInDevices();
        this._refreshHeaderOutputUI();
        this._mountKeyboardPanel();
        this._attachKeyboardShortcuts();
        // Take the baseline snapshot AFTER the piano roll editor has the sequence
        requestAnimationFrame(() => this._markSaved());
    }

    _initPianoRollEditor() {
        const host = this.$('#le-pane-editor');
        if (!host) return;

        // Prefer the full MIDI editor (mounted as a slim "loop mode" panel)
        // when it's available on window — it brings CC/PB/Velocity editing,
        // the touch-mode toolbar, and the editor's full piano-roll feature
        // set. Falls back to the legacy PianoRollEditor host when the
        // class isn't loaded (e.g. minimal pages).
        if (typeof window.MidiEditorModal === 'function') {
            this.midiEditorPanel = new window.MidiEditorModal(this.eventBus, this.api, { loopMode: true });
            // The panel exposes the editing primitives ; LoopEditorModal's
            // existing proxy methods (_refreshPianoRollRange, addNote,
            // setCursor, undo, …) keep working through this adapter.
            this.pianoRollEditor = this._buildMidiEditorPanelAdapter(this.midiEditorPanel);
            // CC persistence isn't wired through loop_create/update yet —
            // future work : extend midi_data to carry CC alongside notes
            // so the editor can round-trip pitch bend / velocity / CC1…91.
            const ccEvents = [];
            // showAsPanel is async — wait for the piano-roll element to
            // exist before wiring the minimap so we don't race against the
            // initial RAF inside MidiEditorModal.initPianoRoll().
            const ready = this.midiEditorPanel.showAsPanel(host, {
                sequence:          this.sequence,
                ccEvents,
                tempo:             this.tempo,
                ppq:               this.ppq,
                bars:               this.bars,
                timeSigNum:         this.timeSigNum,
                timeSigDen:         this.timeSigDen,
                channel:            this._isDrumKit ? 9 : 0,
                instrumentProgram:  this.instrumentProgram,
                onChange:           () => { this._syncPanelMinimap(); /* dirty tracked via snapshot */ }
            });
            Promise.resolve(ready).then(() => {
                this._initPanelMinimap();
                this._initPanelResizeObserver();
            });
            return;
        }

        // Legacy fallback — keeps existing tests/pages running.
        const minimapCanvas = this.$('#le-minimap-top');
        this.pianoRollEditor = new window.PianoRollEditor(host, {
            t: (key, params) => this.t(key, params),
            initial: {
                sequence:   this.sequence,
                ppq:        this.ppq,
                tempo:      this.tempo,
                bars:       this.bars,
                timeSigNum: this.timeSigNum,
                timeSigDen: this.timeSigDen,
                noteMin:    this.outputNoteMin,
                noteMax:    this.outputNoteMax
            },
            externalMinimapEl: minimapCanvas,
            minimapReadOnly:   true,
            getStatusEl: () => this.$('#lc-status')
        });
        this.pianoRollEditor.mount();
        // If we open straight into the Editor tab, give the layout a tick
        // before fitting so flex sizes settle.
        if (this.activeTab === 'editor') {
            requestAnimationFrame(() => this.pianoRollEditor.refit());
        }
    }

    /**
     * Wrap MidiEditorModal (panel mode) behind the API LoopEditorModal
     * already calls on the previous PianoRollEditor : getSequence, addNote,
     * setRange, setCursor, undo/redo, copy/paste, etc. Keeps the rest of
     * LoopEditorModal unchanged while swapping the underlying editor.
     */
    _buildMidiEditorPanelAdapter(panel) {
        const owner = this;
        return {
            get host() { return panel.container; },
            getSequence: () => panel.getPanelLoopState().sequence,
            setRange:    ({ tempo, bars, ppq, timeSigNum, timeSigDen, noteMin, noteMax } = {}) => {
                panel.setPanelLoopState({ tempo, bars, ppq, timeSigNum, timeSigDen });
                owner._syncPanelMinimap();
                // noteMin/noteMax are advisory ; the editor lets the user
                // scroll/zoom freely so we don't clamp.
                void noteMin; void noteMax;
            },
            setCursor:          (tick) => {
                if (panel.pianoRoll) panel.pianoRoll.cursor = tick ?? 0;
                owner._panelMinimap?.setPlayhead(tick ?? 0, owner.isPlaying);
            },
            setRecordingPlayhead: (tick) => {
                if (panel.pianoRoll) panel.pianoRoll.cursor = tick ?? 0;
                owner._panelMinimap?.setPlayhead(tick ?? 0, tick != null);
            },
            setMode:    (mode) => {
                const map = { view: 'drag-view', select: 'select', dragpoly: 'edit' };
                panel.editActions?.setEditMode?.(map[mode] || mode);
            },
            undo:           () => panel.editActions?.undo?.(),
            redo:           () => panel.editActions?.redo?.(),
            selectAll:      () => panel.editActions?.selectAll?.(),
            copy:           () => panel.editActions?.copy?.(),
            paste:          () => panel.editActions?.paste?.(),
            deleteSelected: () => panel.editActions?.deleteSelectedNotes?.(),
            addNote:        (noteObj) => {
                // Push the note directly into the live piano-roll sequence
                // so recording stays incremental (rebuilding the whole array
                // would drop the user's selection / view state).
                if (!panel.pianoRoll) return;
                const ch = panel.channels?.[0]?.channel ?? 0;
                const seq = Array.isArray(panel.pianoRoll.sequence) ? panel.pianoRoll.sequence : [];
                seq.push({ ...noteObj, c: ch });
                panel.pianoRoll.sequence = seq;
                panel.fullSequence = seq.map(n => ({ ...n }));
                panel.sequence = panel.fullSequence;
                panel.pianoRoll.redraw?.();
                panel.isDirty = true;
                owner._syncPanelMinimap();
            },
            refit:          () => {
                if (!panel.pianoRoll) return;
                // The editor's piano-roll container only takes its real
                // size once its tab becomes visible. Recompute width/height
                // from the container before redrawing — otherwise a tab
                // that was hidden at mount stays at 0×0.
                const c = panel.container?.querySelector('#piano-roll-container');
                if (c) {
                    const w = c.clientWidth  || 900;
                    const h = c.clientHeight || 200;
                    panel.pianoRoll.setAttribute('width',  w.toString());
                    panel.pianoRoll.setAttribute('height', h.toString());
                }
                panel.pianoRoll.redraw?.();
                owner._syncPanelMinimap();
            },
            destroy:        () => {
                owner._teardownPanelMinimap();
                owner._teardownPanelResizeObserver();
                panel.unmountPanel?.();
            }
        };
    }

    /**
     * Drive the loop editor's `#le-minimap-top` canvas from the embedded
     * MidiEditor panel's webaudio-pianoroll. Replaces what PianoRollEditor
     * used to do via its `externalMinimapEl` option.
     */
    _initPanelMinimap() {
        const canvas = this.$('#le-minimap-top');
        const panel  = this.midiEditorPanel;
        if (!canvas || !panel?.pianoRoll || typeof window.LoopCreatorMinimap !== 'function') return;

        this._panelMinimap = new window.LoopCreatorMinimap(canvas, {
            ppq:        this.ppq,
            timeSigNum: this.timeSigNum,
            bars:       this.bars,
            noteMin:    this.outputNoteMin,
            noteMax:    this.outputNoteMax,
            onSeek:     null  // read-only — the panel owns navigation
        });
        canvas.style.cursor = 'default';
        canvas.style.pointerEvents = 'none';

        const pr = panel.pianoRoll;
        this._panelMinimapObserver = new MutationObserver(() => this._syncPanelMinimap());
        this._panelMinimapObserver.observe(pr, {
            attributes: true, attributeFilter: ['xoffset', 'xrange']
        });
        this._panelMinimapChange = () => this._syncPanelMinimap();
        pr.addEventListener('change', this._panelMinimapChange);
        this._syncPanelMinimap();
    }

    _syncPanelMinimap() {
        const m = this._panelMinimap;
        const pr = this.midiEditorPanel?.pianoRoll;
        if (!m || !pr) return;
        const xoff   = parseFloat(pr.getAttribute('xoffset') || 0);
        const xrange = parseFloat(pr.getAttribute('xrange')  || 0);
        m.setConfig({
            ppq:        this.ppq,
            timeSigNum: this.timeSigNum,
            bars:       this.bars,
            noteMin:    this.outputNoteMin,
            noteMax:    this.outputNoteMax
        });
        m.setNotes(pr.sequence ?? []);
        m.setViewport(xoff, xrange);
    }

    /**
     * The MidiEditor panel reads `clientWidth` / `clientHeight` from the
     * piano-roll container once, at mount time. If the Editor tab was
     * hidden then (new-loop default tab is Piano), clientWidth is 0 and
     * the canvas falls back to a 1000 px width — that's the "right edge
     * stuck at 2/3 of the page" the user reports. A ResizeObserver on
     * the container refits as soon as it gets real dimensions.
     */
    _initPanelResizeObserver() {
        if (this._panelResizeObs) return;
        const container = this.midiEditorPanel?.container?.querySelector('#piano-roll-container');
        if (!container || typeof ResizeObserver === 'undefined') return;
        let lastW = 0, lastH = 0;
        this._panelResizeObs = new ResizeObserver(() => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w === lastW && h === lastH) return;
            lastW = w; lastH = h;
            this.pianoRollEditor?.refit?.();
        });
        this._panelResizeObs.observe(container);
    }

    _teardownPanelResizeObserver() {
        if (this._panelResizeObs) {
            try { this._panelResizeObs.disconnect(); } catch (_) { /* best-effort */ }
            this._panelResizeObs = null;
        }
    }

    _teardownPanelMinimap() {
        if (this._panelMinimapObserver) {
            try { this._panelMinimapObserver.disconnect(); } catch (_) { /* best-effort */ }
            this._panelMinimapObserver = null;
        }
        if (this._panelMinimapChange && this.midiEditorPanel?.pianoRoll) {
            try { this.midiEditorPanel.pianoRoll.removeEventListener('change', this._panelMinimapChange); }
            catch (_) { /* best-effort */ }
        }
        this._panelMinimapChange = null;
        if (this._panelMinimap) {
            try { this._panelMinimap.destroy?.(); } catch (_) { /* best-effort */ }
            this._panelMinimap = null;
        }
    }

    /**
     * Two-state output toggle in the header :
     *   • 'synth'        → preview through the local in-browser synth
     *   • 'instruments'  → send MIDI messages to the connected instrument(s)
     *                       (the actual device is the one chosen via the
     *                        embedded keyboard's instrument selector, or any
     *                        device routed at the session level).
     * The previous device dropdown was removed at the user's request.
     */
    _refreshHeaderOutputUI() {
        const btn   = this.$('#le-output-toggle');
        const icon  = this.$('#le-output-icon');
        const label = this.$('#le-output-label');
        const isDev = this._outputTarget === 'live';
        if (btn) {
            btn.classList.toggle('le-output-toggle--device', isDev);
            btn.setAttribute('aria-pressed', isDev ? 'true' : 'false');
        }
        if (icon)  icon.textContent  = isDev ? '🔌' : '🔊';
        if (label) label.textContent = isDev
            ? this.t('loopCreator.outputLive')
            : this.t('loopManager.outputSynth');
    }

    close() {
        if (!this.isOpen || !this._isDirty()) {
            super.close();
            return;
        }
        // Confirmation accessible (modale stylable + focus trap) au lieu
        // du window.confirm natif (AUDIT §A1). Le close() reste synchrone
        // côté API publique ; la branche async ne fait qu'appeler super
        // après acceptation utilisateur.
        const doSuperClose = () => super.close();
        LoopUtils.confirm(this.t('loopEditor.confirmDiscardChanges'), {
            icon: '⚠️',
            title: this.t('loopEditor.confirmDiscardTitle') || this.t('loopEditor.confirmDiscardChanges'),
            danger: true
        }).then((ok) => { if (ok) doSuperClose(); });
    }

    onClose() {
        this._detachKeyboardShortcuts();
        this._unmountKeyboardPanel();
        this._stopAll();
        this._stopRecordingAnimation();
        this._stopMidiInMonitor();
        this._stopMetronome();
        this._countInActive = false;
        if (this.pianoRollEditor) {
            this.pianoRollEditor.destroy();
            this.pianoRollEditor = null;
        }
        if (this.midiEditorPanel) {
            try { this.midiEditorPanel.unmountPanel(); } catch (_) { /* best-effort */ }
            this.midiEditorPanel = null;
        }
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
        // Libère le AudioContext du métronome — sinon le navigateur
        // plafonne à ~6 contextes par tab et le métronome reste muet
        // après plusieurs cycles open/close (AUDIT §L6).
        // close() retourne une Promise : on swallow l'éventuel reject
        // (déjà fermé, état invalide…) pour éviter un unhandledRejection.
        if (this._metronomeCtx) {
            try {
                const p = this._metronomeCtx.close?.();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (_) {}
            this._metronomeCtx = null;
        }
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
        // Tab switch
        const tabBtn = e.target.closest('.le-tab[data-le-tab]');
        if (tabBtn) { this._switchTab(tabBtn.dataset.leTab); return; }

        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        switch (btn.dataset.action) {
            case 'tempo-dec':         this._adjustTempo(-1);    break;
            case 'tempo-inc':         this._adjustTempo(+1);    break;
            case 'bars-dec':          this._adjustBars(-1);     break;
            case 'bars-inc':          this._adjustBars(+1);     break;
            case 'toggle-output':     this._toggleOutput();     break;
            case 'record':            this._toggleRecording();  break;
            case 'preview':           this._previewLoop();      break;
            case 'stop-all':          this._stopAll();          break;
            case 'save-loop':         this._saveLoop();         break;
            case 'save-loop-as-new':  this._saveLoop({ asNew: true }); break;
            case 'toggle-metronome':  this._toggleMetronome();  break;
            case 'toggle-count-in':   this._toggleCountIn();    break;
            case 'close':             this.close();             break;
        }
    }

    _switchTab(tab) {
        if (tab !== 'piano' && tab !== 'editor') return;
        if (this.activeTab === tab) return;
        this.activeTab = tab;
        this.$$('.le-tab').forEach(b => {
            const on = b.dataset.leTab === tab;
            b.classList.toggle('le-tab--active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        const piano  = this.$('#le-pane-piano');
        const editor = this.$('#le-pane-editor');
        if (piano)  piano.classList.toggle('le-pane--hidden',  tab !== 'piano');
        if (editor) editor.classList.toggle('le-pane--hidden', tab !== 'editor');
        if (tab === 'editor' && this.pianoRollEditor) {
            requestAnimationFrame(() => this.pianoRollEditor.refit());
        }
        if (tab === 'piano') {
            // Re-probe keyboards each time the user comes back to the Piano
            // tab, in case they plugged in a keyboard since the modal opened.
            this._loadMidiInDevices();
        }
    }

    _onChange(e) {
        const id = e.target.id;
        if (id === 'lc-timesig') {
            const [num, den] = e.target.value.split(':').map(Number);
            this.timeSigNum = num; this.timeSigDen = den;
            this._refreshPianoRollRange();
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

            const ed = this.pianoRollEditor;
            if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); ed?.undo?.();           return; }
            if (mod && e.key.toLowerCase() === 'z' &&  e.shiftKey) { e.preventDefault(); ed?.redo?.();           return; }
            if (mod && e.key.toLowerCase() === 'y')                { e.preventDefault(); ed?.redo?.();           return; }
            if (mod && e.key.toLowerCase() === 'a')                { e.preventDefault(); ed?.selectAll?.();      return; }
            if (mod && e.key.toLowerCase() === 'c')                { e.preventDefault(); ed?.copy?.();           return; }
            if (mod && e.key.toLowerCase() === 'v')                { e.preventDefault(); ed?.paste?.();          return; }
            if (mod && e.key.toLowerCase() === 's')                { e.preventDefault(); this._saveLoop();       return; }
            if (e.key === 'Delete' || e.key === 'Backspace')       { e.preventDefault(); ed?.deleteSelected?.(); return; }
            if (e.key === ' ')                                     { e.preventDefault(); this.isPlaying ? this._stopAll() : this._previewLoop(); return; }
            if (e.key === 'Escape')                                { this._stopAll();                            return; }
            if (e.key.toLowerCase() === 'r')                       { this._toggleRecording();                    return; }
            // Mode shortcuts (no modifier): V/S/D
            if (e.key.toLowerCase() === 'v' && !mod)               { ed?.setMode?.('view');     return; }
            if (e.key.toLowerCase() === 's' && !mod && !e.shiftKey){ ed?.setMode?.('select');   return; }
            if (e.key.toLowerCase() === 'd' && !mod)               { ed?.setMode?.('dragpoly'); return; }
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
    // PIANO ROLL — thin proxies to PianoRollEditor
    // =========================================================

    _refreshPianoRollRange() {
        this.pianoRollEditor?.setRange({
            tempo:      this.tempo,
            bars:       this.bars,
            ppq:        this.ppq,
            timeSigNum: this.timeSigNum,
            timeSigDen: this.timeSigDen,
            noteMin:    this.outputNoteMin,
            noteMax:    this.outputNoteMax
        });
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
        // When switching to MIDI mode, ensure outputMode reflects 'device'
        // so _previewNoteOn / _previewViaDevice route properly to whatever
        // device the embedded keyboard / session has set.
        this.outputMode = (this._outputTarget === 'live') ? 'device' : 'synth';
        this._refreshHeaderOutputUI();
        this._setStatus(this._outputTarget === 'live'
            ? this.t('loopCreator.outputLive') : this.t('loopCreator.outputSynth'));
    }

    _startPlayheadAnimation() {
        if (this._playheadRAF) return;
        this._playheadStartTime = performance.now();
        const totalTicks = this.ppq * this.timeSigNum * this.bars;
        const animate = () => {
            if (!this.isPlaying) { this._playheadRAF = null; return; }
            const elapsed = (performance.now() - this._playheadStartTime) / 1000;
            const tick = Math.min(Math.round(elapsed * (this.tempo / 60) * this.ppq), totalTicks);
            this.pianoRollEditor?.setCursor(tick);
            this._playheadRAF = requestAnimationFrame(animate);
        };
        this._playheadRAF = requestAnimationFrame(animate);
    }

    _stopPlayheadAnimation() {
        if (this._playheadRAF) { cancelAnimationFrame(this._playheadRAF); this._playheadRAF = null; }
        this.pianoRollEditor?.setCursor(0);
    }

    _startRecordingAnimation() {
        const totalTicks = this.ppq * this.timeSigNum * this.bars;
        const frame = () => {
            if (!this.isRecording) { this._recordingRAF = null; return; }
            const recTick = Math.round(
                (performance.now() - this.recordStartTime) / 1000 * (this.tempo / 60) * this.ppq
            );
            // Auto-stop when the playhead reaches the configured loop length
            // (bars × time-sig × ppq). Pin the playhead to the end so the
            // visual stays at the boundary instead of overshooting.
            if (recTick >= totalTicks) {
                this.pianoRollEditor?.setRecordingPlayhead(totalTicks);
                this._recordingRAF = null;
                this._stopRecording();
                return;
            }
            this.pianoRollEditor?.setRecordingPlayhead(recTick);
            this._recordingRAF = requestAnimationFrame(frame);
        };
        this._recordingRAF = requestAnimationFrame(frame);
    }

    _stopRecordingAnimation() {
        if (this._recordingRAF) { cancelAnimationFrame(this._recordingRAF); this._recordingRAF = null; }
        this.pianoRollEditor?.setRecordingPlayhead(null);
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
            // Channel 9 pour les kits de batterie (convention GM) — sinon
            // le synth interprète le programme comme un mélodique et joue
            // un piano par défaut.
            const ch = this._isDrumKit ? 9 : 0;
            const envelopes = this._synth.playNote(note, velocity, ch, 9999);
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
        // Read quantize value from the PianoRollEditor's Grid group (if mounted)
        const qEl = this.pianoRollEditor?.host?.querySelector('[data-pre-field="pre-quantize"]');
        const q = parseInt(qEl?.value ?? 0);
        const t = q > 0 ? Math.round(rec.tick / q) * q : rec.tick;
        const g = q > 0 ? Math.max(q, Math.round(durTicks / q) * q) : durTicks;
        this._addNoteToRoll({ t, n: note, v: rec.velocity, g });
    }

    _addNoteToRoll(noteObj) {
        this.pianoRollEditor?.addNote(noteObj);
    }

    // =========================================================
    // RECORDING + MIDI IN
    // =========================================================

    _toggleMetronome() {
        this._metronomeEnabled = !this._metronomeEnabled;
        const b = this.$('#lc-metronome-btn');
        if (b) b.setAttribute('aria-pressed', this._metronomeEnabled ? 'true' : 'false');
        if (!this._metronomeEnabled) this._stopMetronome();
        else if (this.isRecording || this.isPlaying) this._startMetronome();
    }

    _toggleCountIn() {
        this._countInEnabled = !this._countInEnabled;
        const b = this.$('#lc-countin-btn');
        if (b) b.setAttribute('aria-pressed', this._countInEnabled ? 'true' : 'false');
    }

    _ensureMetronomeCtx() {
        if (!this._metronomeCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) this._metronomeCtx = new Ctx();
        }
        return this._metronomeCtx;
    }

    _tick(strong = false) {
        const ctx = this._ensureMetronomeCtx();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = strong ? 1500 : 900;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(strong ? 0.25 : 0.15, now + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.08);
    }

    _startMetronome() {
        this._stopMetronome();
        if (!this._metronomeEnabled) return;
        const secPerBeat = 60 / this.tempo;
        const beatsPerBar = this.timeSigNum;
        let beat = 0;
        const fire = () => {
            this._tick(beat % beatsPerBar === 0);
            beat++;
        };
        fire();
        const id = setInterval(fire, secPerBeat * 1000);
        this._metronomeTimers.push(id);
    }

    _stopMetronome() {
        this._metronomeTimers.forEach(id => clearInterval(id));
        this._metronomeTimers = [];
    }

    _toggleRecording() {
        this.isRecording ? this._stopRecording() : this._startRecording();
    }

    _startRecording() {
        if (this._countInEnabled) {
            this._runCountInThen(() => this._beginRecording());
        } else {
            this._beginRecording();
        }
    }

    _beginRecording() {
        this.isRecording     = true;
        this.recordedNotes   = [];
        this.recordStartTime = performance.now();
        this.$('#lc-record-btn')?.classList.add('lc-btn-record--active');
        this.$('#lc-rec-indicator')?.classList.remove('hidden');
        if (this._midiInDevice) this._startMidiInMonitor();
        this._startRecordingAnimation();
        this._startRecordingTimer();
        if (this._metronomeEnabled) this._startMetronome();
        this._setStatus(this.t('loopCreator.statusRecording'));
    }

    _runCountInThen(then) {
        // Planning absolu sur l'horloge système (performance.now) plutôt
        // que des setTimeout cumulatifs, qui dérivent de 100+ ms sur 4
        // mesures à cause du jitter JS (AUDIT §L5). On planifie chaque
        // beat à `t0 + i × secPerBeat` ; si le timer tire en retard, le
        // suivant est ré-aligné sur l'horloge absolue.
        this._countInActive = true;
        const beatsPerBar = this.timeSigNum;
        const secPerBeat  = 60 / this.tempo;
        const btn = this.$('#lc-record-btn');
        btn?.classList.add('lc-btn-record--active');
        const t0 = performance.now();
        const scheduleBeat = (beat) => {
            if (!this._countInActive) return;
            const targetMs = t0 + beat * secPerBeat * 1000;
            const delay = Math.max(0, targetMs - performance.now());
            setTimeout(() => {
                if (!this._countInActive) return;
                this._tick(beat === 0);
                if (beat + 1 >= beatsPerBar) {
                    this._countInActive = false;
                    then();
                    return;
                }
                this._setStatus(this.t('loopEditor.countInStatus', { beat: beat + 2, total: beatsPerBar }));
                scheduleBeat(beat + 1);
            }, delay);
        };
        this._setStatus(this.t('loopEditor.countInStatus', { beat: 1, total: beatsPerBar }));
        scheduleBeat(0);
    }

    _stopRecording() {
        if (this._countInActive) {
            this._countInActive = false;
            this.$('#lc-record-btn')?.classList.remove('lc-btn-record--active');
            this._setStatus('');
            return;
        }
        this.isRecording = false;
        for (const rec of [...this.recordedNotes]) this._finalizeNoteOff(rec.note);
        this.recordedNotes = [];
        this.$('#lc-record-btn')?.classList.remove('lc-btn-record--active');
        this.$('#lc-rec-indicator')?.classList.add('hidden');
        this._stopMidiInMonitor();
        this._stopRecordingAnimation();
        this._stopRecordingTimer();
        this._stopMetronome();
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
        // Token de session : invalidé par _stopMidiInMonitor / onClose. Si
        // la modale est fermée pendant le `await monitor_start`, on ne doit
        // PAS attacher le handler ni marquer active (AUDIT §L2).
        const token = Symbol('midiInSession');
        this._monitorSession = token;
        try {
            await this.api.sendCommand('monitor_start', { deviceId: this._midiInDevice });
            if (this._monitorSession !== token) {
                // Session annulée pendant l'await — stop ce qu'on vient de démarrer.
                try { await this.api.sendCommand('monitor_stop', { deviceId: this._midiInDevice }); } catch (_) {}
                return;
            }
            this._monitorActive = true;
            this._midiInHandler = (data) => {
                // Garde de session : ignore les events orphelins si la
                // modale a été close ou un autre device sélectionné entre-temps.
                if (this._monitorSession !== token) return;
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
            this._monitorSession = null;
            LoopUtils.handleError(err, 'editor.midiIn.start', {
                toast: this.t('loopEditor.errMidiIn')
            });
        }
    }

    async _stopMidiInMonitor() {
        // Invalide la session AVANT tout await — couvre le cas où on a
        // démarré mais pas encore attaché le handler.
        this._monitorSession = null;
        const wasActive = this._monitorActive;
        this._monitorActive = false;
        // Détache toujours le handler s'il a été enregistré, même si la
        // commande monitor_stop échoue derrière.
        if (this._midiInHandler) {
            this.api.off?.('monitor_event', this._midiInHandler);
            this._midiInHandler = null;
        }
        if (wasActive && this._midiInDevice) {
            try { await this.api.sendCommand('monitor_stop', { deviceId: this._midiInDevice }); }
            catch (err) { LoopUtils.handleError(err, 'editor.midiIn.stop'); }
        }
    }

    /**
     * Populate the MIDI-In selector with **real keyboards only** — i.e.
     * devices that have replied to a Universal SysEx Identity Request with
     * a manufacturer id that is NOT our own DIY GMB code (0x7D).
     *
     * The piano control bar (`#le-ctrl-bar-piano`) is shown only when at
     * least one such device is detected ; otherwise it stays hidden.
     */
    async _loadMidiInDevices() {
        const sel = this.$('#lc-midi-in-device');
        const bar = this.$('#le-ctrl-bar-piano');
        if (!sel) return;

        // Probe every connected device first so freshly-plugged keyboards
        // get a chance to identify themselves before we filter.
        await this._probeKeyboardIdentities();

        try {
            const allDevices = await this.api.listDevices();
            const realKeyboards = (allDevices || []).filter(d => {
                const connected = (d.status === 2 || d.connected === true);
                if (!connected) return false;
                const mfr = d.sysex_manufacturer_id;
                if (!mfr) return false;        // never identified → not a keyboard
                const mfrLow = String(mfr).toLowerCase();
                if (mfrLow === '0x7d' || mfrLow === '7d') return false; // GMB DIY
                return true;
            });

            const existing = sel.value;
            sel.innerHTML = `<option value="">IN:—</option>`;
            for (const d of realKeyboards) {
                const id  = d.device_id || d.id;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = `IN: ${d.displayName || d.name || id}`;
                if (id === existing) opt.selected = true;
                sel.appendChild(opt);
            }

            const hasKeyboard = realKeyboards.length > 0;
            if (bar) bar.classList.toggle('le-ctrl-bar-piano--hidden', !hasKeyboard);
            if (!hasKeyboard) {
                this._midiInDevice = null;
            }
        } catch (err) {
            LoopUtils.handleError(err, 'editor.midiIn.list');
        }
    }

    /**
     * Send a SysEx Identity Request to every connected device and wait
     * briefly so replies have time to come back and be persisted by the
     * backend. Best-effort — failures are ignored.
     */
    async _probeKeyboardIdentities() {
        try {
            const all = await this.api.listDevices();
            const candidates = (all || []).filter(d => d.status === 2 || d.connected === true);
            const probes = candidates.map(d => {
                const id = d.device_id || d.id;
                return this.api.sendCommand('sysex_identity_request', { deviceId: id })
                    .catch(() => {}); // input-only / unsupported devices throw — ignore
            });
            if (!probes.length) return;
            await Promise.race([
                Promise.all(probes),
                new Promise(res => setTimeout(res, 150))
            ]);
            // Give replies a window to land in the DB before re-querying.
            await new Promise(res => setTimeout(res, 350));
        } catch (err) {
            LoopUtils.handleError(err, 'editor.midiIn.probe');
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

                // Détection drum kit : channel 9 (convention GM) ou
                // gmProgram >= 128 (drum kits encodés avec offset 128 dans
                // MidiSynthesizer._decodeKitProgram). Sans ça, les notes
                // étaient jouées sur le canal 0 en path mélodique →
                // sonnaient en piano au lieu de la batterie.
                const isDrum = channel === 9 || (gmProgram != null && gmProgram >= 128);

                this.outputMode        = deviceId ? 'device' : 'synth';
                this.outputDeviceId    = deviceId || null;
                this.outputChannel     = isDrum ? 9 : (channel ?? 0);
                this.outputGmProgram   = gmProgram ?? 0;
                this.instrumentProgram = gmProgram ?? 0;
                this._isDrumKit        = isDrum;

                try {
                    if (isDrum) {
                        // Écrit le programme sur le canal 9 (canal drums GM)
                        // ET pré-charge le kit pour que la 1ère frappe sonne.
                        this._synth?.setChannelInstrument?.(9, this.instrumentProgram);
                        this._synth?.loadDrumKit?.().catch(err =>
                            LoopUtils.handleError(err, 'editor.synth.loadDrumKit'));
                    } else {
                        this._synth?.setChannelInstrument?.(0, this.instrumentProgram);
                        // Préload pour que la 1ère key press produise du son.
                        if (this._synth && !this._synth.loadedInstruments?.has(this.instrumentProgram)) {
                            this._synth.loadInstrument(this.instrumentProgram).catch(err =>
                                LoopUtils.handleError(err, 'editor.synth.loadInstrument'));
                        }
                    }
                } catch (err) { LoopUtils.handleError(err, 'editor.synth.setChannelInstrument'); }

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
        const seq = this.pianoRollEditor?.getSequence() ?? [];
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
        try {
            if (this._isDrumKit) {
                this._synth.setChannelInstrument(9, this.instrumentProgram);
                this._synth.loadDrumKit?.().catch(err =>
                    LoopUtils.handleError(err, 'editor.preview.loadDrumKit'));
            } else {
                this._synth.setChannelInstrument(0, this.instrumentProgram);
            }
        } catch (err) { LoopUtils.handleError(err, 'editor.preview.setChannelInstrument'); }
        this._synth.onPlaybackEnd = done;
        this.isPlaying = true;
        this._setStatus(this.t('loopCreator.statusPlaying'));
        this._startPlayheadAnimation();
        // Force le canal 9 sur toutes les notes en mode drum kit, sinon
        // loadSequence les met sur le canal 0 (path mélodique → piano).
        const ch = this._isDrumKit ? 9 : 0;
        const routedSeq = seq.map(n => ({ ...n, c: ch }));
        this._synth.loadSequence(routedSeq, this.tempo, this.ppq);
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

        // Note-off le plus tardif de la séquence : c'est lui qui définit
        // la vraie fin de preview, pas la longueur logique du loop. Sans
        // ça, une note finale qui dépasse la dernière mesure est coupée
        // brutalement (AUDIT §L1).
        let lastOffMs = this.ppq * this.timeSigNum * this.bars * spt * 1000;

        for (const note of seq) {
            const onMs  = note.t * spt * 1000;
            const offMs = (note.t + (note.g || note.l || 120)) * spt * 1000;
            if (offMs > lastOffMs) lastOffMs = offMs;
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
        // 50 ms de marge pour laisser le note-off arriver côté device.
        this._playbackTimers.push(setTimeout(() => {
            this.isPlaying = false; this._setStatus('');
        }, lastOffMs + 50));
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

    async _saveLoop({ asNew = false } = {}) {
        this.loopName = (this.$('#lc-name-input')?.value?.trim()) || this.t('loopCreator.untitled');
        if (asNew) {
            this.loopName = this.t('loopManager.duplicateNameSuffix', { name: this.loopName });
            const nameEl = this.$('#lc-name-input'); if (nameEl) nameEl.value = this.loopName;
        }
        const seq = this.pianoRollEditor?.getSequence() ?? [];
        const payload = {
            name: this.loopName, tempo: this.tempo,
            time_sig_num: this.timeSigNum, time_sig_den: this.timeSigDen,
            bars: this.bars, ppq: this.ppq,
            instrument_program: this.instrumentProgram,
            midi_data: JSON.stringify(seq)
        };
        try {
            if (this.currentLoopId && !asNew) {
                await this.api.sendCommand('loop_update', { loopId: this.currentLoopId, ...payload });
            } else {
                const r = await this.api.sendCommand('loop_create', payload);
                this.currentLoopId = r.loopId;
            }
            const titleEl = this.dialog?.querySelector('.le-header-title');
            if (titleEl) titleEl.textContent = `✏️ ${this.loopName}`;
            this._setStatus(this.t('loopCreator.statusSaved'));
            LoopUtils.toast(this.t('loopCreator.statusSaved'), 'success');
            this._markSaved();
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
