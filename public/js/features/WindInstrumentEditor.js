// ============================================================================
// Fichier: public/js/features/WindInstrumentEditor.js
// Description: Main wind/brass instrument editor component
//   Orchestrates WindMelodyRenderer + WindArticulationPanel
//   Handles bidirectional sync with MIDI editor (piano roll)
//   Manages monophony enforcement, breath detection, articulations
// ============================================================================

class WindInstrumentEditor {
    constructor(modal) {
        this.modal = modal;
        this.api = modal.api;
        this.logger = window.logger || console;

        // State
        this.isVisible = false;
        this.channel = 0;
        this.windPreset = null;         // WindInstrumentDatabase preset
        this.melodyEvents = [];         // {tick, note, velocity, duration, channel, articulation}
        this.isSyncing = false;

        // Sub-components
        this.renderer = null;           // WindMelodyRenderer instance
        this.articulationPanel = null;  // WindArticulationPanel instance

        // DOM references
        this.containerEl = null;
        this.melodyCanvasEl = null;
        this.toolsPanelEl = null;

        // Default velocity
        this.defaultVelocity = 100;

        // Bind methods
        this._onNoteAdd = this._handleNoteAdd.bind(this);
        this._onNotesMoved = this._handleNotesMoved.bind(this);
        this._onEditArticulation = this._handleEditArticulation.bind(this);
        this._onSelectionChange = this._handleSelectionChange.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onPianoKey = this._handlePianoKey.bind(this);
        this._onNoteDragMove = this._handleNoteDragMove.bind(this);
    }

    // ========================================================================
    // I18N
    // ========================================================================

    t(key, params = {}) {
        return typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    show(windPreset, midiNotes, channel) {
        this.channel = channel;
        this.windPreset = windPreset;

        if (!this.containerEl) {
            this._createDOM();
        }
        this.containerEl.style.display = 'flex';
        this.isVisible = true;

        // Update badge
        const badge = this.containerEl.querySelector('#wind-editor-badge');
        if (badge && windPreset) {
            badge.textContent = windPreset.name;
        }

        this._setPianoRollVisible(false);
        this._initRenderer();
        this._initArticulationPanel();

        this.loadFromMidi(midiNotes);

        this._detachCanvasEvents();
        this._attachCanvasEvents();

        // Update main toolbar mode buttons for wind editor
        if (this.modal.editActions.updateModeButtons) this.modal.editActions.updateModeButtons();
        if (this.modal.editActions.updateEditButtons) this.modal.editActions.updateEditButtons();
        if (this.modal.editActions.updateUndoRedoButtonsState) this.modal.editActions.updateUndoRedoButtonsState();

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.handleResize();
                if (this.modal.syncAllEditors) this.modal.syncAllEditors();
                // Center view on the notes after layout settles
                if (this.renderer && this.melodyCanvasEl &&
                    this.melodyCanvasEl.width > 0 && this.melodyCanvasEl.height > 0) {
                    this.renderer.centerOnNotes();
                } else {
                    // Fallback: retry after a short delay if layout not ready
                    setTimeout(() => {
                        this.handleResize();
                        if (this.renderer) this.renderer.centerOnNotes();
                    }, 50);
                }
            });
        });
    }

    hide() {
        if (this.containerEl) {
            this.containerEl.style.display = 'none';
        }
        this.isVisible = false;
        this._detachCanvasEvents();
        this._setPianoRollVisible(true);

        // Restore main toolbar for piano roll
        if (this.modal.editActions.updateModeButtons) this.modal.editActions.updateModeButtons();
        if (this.modal.editActions.updateEditButtons) this.modal.editActions.updateEditButtons();
        if (this.modal.editActions.updateUndoRedoButtonsState) this.modal.editActions.updateUndoRedoButtonsState();
    }

    _setPianoRollVisible(visible) {
        const notesSection = this.modal.container?.querySelector('.notes-section');
        if (!notesSection) return;
        const pianoRollWrapper = notesSection.querySelector('.piano-roll-wrapper');
        if (visible) {
            if (pianoRollWrapper) pianoRollWrapper.style.display = '';
        } else {
            if (pianoRollWrapper) pianoRollWrapper.style.display = 'none';
        }
    }

    destroy() {
        document.removeEventListener('keydown', this._onKeyDown);
        this._detachCanvasEvents();
        if (this.renderer) {
            this.renderer.destroy();
            this.renderer = null;
        }
        if (this.articulationPanel) {
            this.articulationPanel.destroy();
            this.articulationPanel = null;
        }
        if (this.containerEl) {
            this.containerEl.remove();
            this.containerEl = null;
        }
    }

    // ========================================================================
    // DOM CREATION
    // ========================================================================

    _createDOM() {
        this.containerEl = document.createElement('div');
        this.containerEl.className = 'wind-editor-panel';
        this.containerEl.innerHTML = `
            <div class="wind-editor-header">
                <div class="wind-editor-title">
                    <span class="wind-editor-icon">${this.t('windEditor.icon')}</span>
                    <span class="wind-editor-badge" id="wind-editor-badge"></span>
                    <label class="wind-velocity-label" title="${this.t('windEditor.defaultVelocity', { defaultValue: 'Default velocity' })}">
                        ${this.t('windEditor.velocityLabel')}
                        <input type="number" class="wind-velocity-input" id="wind-velocity-input"
                            min="1" max="127" value="${this.defaultVelocity}" />
                    </label>
                </div>
                <div class="wind-editor-toolbar">
                    <button class="wind-tool-btn wind-mode-btn active" data-action="wind-mode" data-mode="pan" title="${this.t('windEditor.pan')}">&#x2725;</button>
                    <button class="wind-tool-btn wind-mode-btn" data-action="wind-mode" data-mode="select" title="${this.t('windEditor.select')}">&#x2B1C;</button>
                    <span class="wind-separator"></span>
                    <button class="wind-tool-btn wind-close-btn" data-action="wind-close" title="${this.t('common.close')}">&times;</button>
                </div>
            </div>
            <div class="wind-editor-body">
                <div class="wind-melody-canvas-wrapper">
                    <canvas id="wind-melody-canvas" class="wind-melody-canvas"></canvas>
                </div>
                <div class="wind-tools-panel-wrapper" id="wind-tools-panel-wrapper">
                </div>
            </div>
        `;

        const notesSection = this.modal.container?.querySelector('.notes-section');
        if (notesSection) {
            notesSection.appendChild(this.containerEl);
        }

        this.melodyCanvasEl = this.containerEl.querySelector('#wind-melody-canvas');
        this.toolsPanelEl = this.containerEl.querySelector('#wind-tools-panel-wrapper');

        this._attachToolbarEvents();
    }

    // ========================================================================
    // TOOLBAR
    // ========================================================================

    _attachToolbarEvents() {
        if (!this.containerEl) return;

        this.containerEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;
            if (!action.startsWith('wind-')) return;

            switch (action) {
                case 'wind-mode':
                    this._setEditMode(btn.dataset.mode);
                    break;
                case 'wind-undo':
                    if (this.renderer?.undo()) {
                        this._enforceMonophony();
                        this._syncToMidi();
                    }
                    break;
                case 'wind-redo':
                    if (this.renderer?.redo()) {
                        this._enforceMonophony();
                        this._syncToMidi();
                    }
                    break;
                case 'wind-copy':
                    this.renderer?.copySelected();
                    break;
                case 'wind-paste':
                    if (this.renderer?.hasClipboard()) {
                        const tick = this.renderer.playheadTick || 0;
                        this.renderer.paste(tick);
                        this._enforceMonophony();
                        this._syncToMidi();
                    }
                    break;
                case 'wind-zoom-in':
                    if (this.renderer) {
                        this.renderer.setZoom(this.renderer.ticksPerPixel / 1.5);
                    }
                    break;
                case 'wind-zoom-out':
                    if (this.renderer) {
                        this.renderer.setZoom(this.renderer.ticksPerPixel * 1.5);
                    }
                    break;
                case 'wind-delete':
                    if (this.renderer?.deleteSelected() > 0) {
                        this._syncToMidi();
                    }
                    break;
                case 'wind-select-all':
                    this.renderer?.selectAll();
                    break;
                case 'wind-close':
                    this.hide();
                    this.modal.tablatureOps._updateWindButtonState?.(false);
                    break;
            }
        });

        // Velocity input
        const velInput = this.containerEl.querySelector('#wind-velocity-input');
        if (velInput) {
            velInput.addEventListener('change', () => {
                this.defaultVelocity = Math.max(1, Math.min(127, parseInt(velInput.value, 10) || 100));
            });
        }
    }

    _setEditMode(mode) {
        if (!this.renderer) return;
        this.renderer.tool = mode;

        // Update active class on mode buttons
        const modeButtons = this.containerEl.querySelectorAll('.wind-mode-btn');
        modeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // Update cursor
        if (mode === 'pan') {
            this.renderer.canvas.style.cursor = 'grab';
        } else {
            this.renderer.canvas.style.cursor = 'crosshair';
        }
    }

    // ========================================================================
    // RENDERER & TOOLS INIT
    // ========================================================================

    _initRenderer() {
        if (!this.melodyCanvasEl) return;

        const wrapper = this.melodyCanvasEl.parentElement;
        this.melodyCanvasEl.width = wrapper.clientWidth || 800;
        this.melodyCanvasEl.height = wrapper.clientHeight || 400;

        if (this.renderer) {
            this.renderer.destroy();
        }

        this.renderer = new WindMelodyRenderer(this.melodyCanvasEl, {
            noteMin: this.windPreset?.rangeMin || 48,
            noteMax: this.windPreset?.rangeMax || 84,
            comfortMin: this.windPreset?.comfortMin || 48,
            comfortMax: this.windPreset?.comfortMax || 84,
            tool: 'pan',
            onScrollChange: (info) => this._syncScrollBars(info),
        });

        // Sync zoom/scroll with piano roll
        if (this.modal.pianoRoll) {
            const pr = this.modal.pianoRoll;
            if (pr.xrange && this.melodyCanvasEl.width) {
                this.renderer.ticksPerPixel = pr.xrange / (this.melodyCanvasEl.width - this.renderer.headerWidth);
            }
            if (pr.xoffset) {
                this.renderer.scrollX = pr.xoffset;
            }
        }

        if (this.articulationPanel) {
            this.articulationPanel.setRenderer(this.renderer);
        }

        // PlaybackTimelineBar is managed by the main MidiEditorModal (no duplicate)
    }

    _initArticulationPanel() {
        if (!this.toolsPanelEl) return;

        if (this.articulationPanel) {
            this.articulationPanel.destroy();
        }

        this.articulationPanel = new WindArticulationPanel(this.toolsPanelEl, {
            onChanged: () => this._syncToMidi(),
            onArticulationSelected: (art) => {
                // Apply articulation to selected notes
                if (this.renderer && this.renderer.selectedEvents.size > 0) {
                    this.renderer.saveSnapshot();
                    for (const idx of this.renderer.selectedEvents) {
                        if (this.renderer.melodyEvents[idx]) {
                            this.renderer.melodyEvents[idx].articulation = art;
                        }
                    }
                    this.renderer.redraw();
                    this._syncToMidi();
                }
            },
        });

        if (this.renderer) {
            this.articulationPanel.setRenderer(this.renderer);
        }

        this._updateInfo();
    }

    // ========================================================================
    // CONVERSION — MIDI → MELODY
    // ========================================================================

    loadFromMidi(midiNotes) {
        if (!midiNotes || midiNotes.length === 0) {
            this.melodyEvents = [];
            if (this.renderer) this.renderer.setMelodyEvents([]);
            this._updateInfo();
            return;
        }

        this.melodyEvents = midiNotes.map(note => ({
            tick: note.t,
            note: note.n,
            velocity: note.v || 100,
            duration: note.g || 240,
            channel: note.c !== undefined ? note.c : this.channel,
            articulation: this._detectArticulation(note),
        }));

        // Sort by tick
        this.melodyEvents.sort((a, b) => a.tick - b.tick);

        if (this.renderer) {
            this.renderer.setMelodyEvents(this.melodyEvents);
        }

        // Enforce monophony after loading
        this._enforceMonophony();

        this._updateInfo();
    }

    /**
     * Heuristic articulation detection from note properties
     */
    _detectArticulation(note) {
        const dur = note.g || 240;
        const vel = note.v || 100;

        // Very short duration → staccato
        if (dur <= 120) return 'staccato';
        // High velocity → accent
        if (vel >= 120) return 'accent';
        // Default
        return 'normal';
    }

    // ========================================================================
    // CONVERSION — MELODY → MIDI (bidirectional sync)
    // ========================================================================

    _syncToMidi() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            if (this.renderer) {
                this.melodyEvents = this.renderer.melodyEvents;
            }

            // Apply articulation factors before syncing to MIDI
            const newNotes = this.melodyEvents.map(evt => {
                const artDef = WindInstrumentDatabase.ARTICULATION_TYPES[evt.articulation || 'normal']
                    || WindInstrumentDatabase.ARTICULATION_TYPES.normal;

                return {
                    t: evt.tick,
                    n: evt.note,
                    v: Math.max(1, Math.min(127, Math.round((evt.velocity || 100) * artDef.velocityFactor))),
                    g: Math.max(1, Math.round((evt.duration || 240) * artDef.durationFactor)),
                    c: this.channel
                };
            });

            this._updateModalSequence(newNotes);
        } finally {
            this.isSyncing = false;
        }

        this._updateInfo();
    }

    onMidiNotesChanged(midiNotes) {
        if (this.isSyncing || !this.isVisible) return;
        this.isSyncing = true;
        try {
            this.loadFromMidi(midiNotes);
        } finally {
            this.isSyncing = false;
        }
    }

    _updateModalSequence(newNotes) {
        const m = this.modal;
        if (!m.fullSequence) return;

        m.fullSequence = m.fullSequence.filter(n => n.c !== this.channel);
        m.fullSequence.push(...newNotes);
        m.fullSequence.sort((a, b) => a.t - b.t);

        const previousActiveChannels = new Set(m.activeChannels);
        m.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels, true);

        if (m.pianoRoll) {
            m.pianoRoll.sequence = m.sequence;
            if (typeof m.pianoRoll.redraw === 'function') {
                m.pianoRoll.redraw();
            }
        }

        m.isDirty = true;
    }

    // ========================================================================
    // MONOPHONY ENFORCEMENT
    // ========================================================================

    _enforceMonophony() {
        if (!this.renderer) return;
        const events = this.renderer.melodyEvents;
        if (events.length <= 1) return;

        // Sort by tick
        events.sort((a, b) => a.tick - b.tick);

        // Remove duplicate notes at the same tick (keep last)
        for (let i = events.length - 2; i >= 0; i--) {
            if (events[i].tick === events[i + 1].tick) {
                events.splice(i, 1);
            }
        }

        // Truncate overlapping notes
        for (let i = 0; i < events.length - 1; i++) {
            const endTick = events[i].tick + events[i].duration;
            if (endTick > events[i + 1].tick) {
                events[i].duration = Math.max(1, events[i + 1].tick - events[i].tick);
            }
        }

        this.renderer.redraw();
    }

    // ========================================================================
    // SCROLL BAR SYNC
    // ========================================================================

    /**
     * Sync external scroll bars when the renderer scroll changes (pan, wheel, etc.)
     * Called by the renderer's onScrollChange callback.
     */
    _syncScrollBars(_info) {
        if (!this.isVisible) return;

        // Use the unified syncAllEditors which now reads from _getActiveViewportState()
        if (this.modal && this.modal.syncAllEditors) {
            this.modal.syncAllEditors();
        }
    }

    /**
     * Called by MidiEditorModal.scrollHorizontal() to sync this editor with the scroll bar.
     * @param {number} percentage - 0-100
     */
    scrollHorizontal(percentage) {
        if (!this.renderer) return;
        const maxTick = this.modal.midiData?.maxTick || 0;
        const canvasWidth = this.melodyCanvasEl?.width || 800;
        const visibleTicks = (canvasWidth - this.renderer.headerWidth) * this.renderer.ticksPerPixel;
        const maxOffset = Math.max(0, maxTick - visibleTicks);
        const newOffset = Math.round((percentage / 100) * maxOffset);
        this.renderer.scrollX = newOffset;
        this.renderer.redraw();
    }

    /**
     * Called by MidiEditorModal.scrollVertical() to sync this editor with the scroll bar.
     * @param {number} percentage - 0-100
     */
    scrollVertical(percentage) {
        if (!this.renderer) return;
        const totalRange = 128;
        const displayRange = this.renderer.displayNoteMax - this.renderer.displayNoteMin;
        const maxOffset = Math.max(0, totalRange - displayRange);
        const newOffset = Math.round((percentage / 100) * maxOffset);
        this.renderer.displayNoteMin = Math.max(0, newOffset);
        this.renderer.displayNoteMax = Math.min(127, newOffset + displayRange);
        this.renderer.scrollY = newOffset - Math.max(0, this.renderer.noteMin - 5);
        this.renderer.redraw();
    }

    // ========================================================================
    // PLAYBACK SYNC
    // ========================================================================

    updatePlayhead(tick) {
        if (!this.isVisible) return;

        if (this.renderer) {
            // Ne pas écraser scrollX si l'utilisateur est en train de pan
            if (!this.renderer._isDragging) {
                const pr = this.modal.pianoRoll;
                if (pr) {
                    this.renderer.setScrollX(pr.xoffset || 0);
                }
            }
            this.renderer.setPlayhead(tick);
        }

        // PlaybackTimelineBar is updated by MidiEditorModal.updatePlaybackCursor()
    }

    // ========================================================================
    // CANVAS EVENTS
    // ========================================================================

    _attachCanvasEvents() {
        if (this.melodyCanvasEl) {
            this.melodyCanvasEl.addEventListener('wind:addnote', this._onNoteAdd);
            this.melodyCanvasEl.addEventListener('wind:notesmoved', this._onNotesMoved);
            this.melodyCanvasEl.addEventListener('wind:editarticulation', this._onEditArticulation);
            this.melodyCanvasEl.addEventListener('wind:selectionchange', this._onSelectionChange);
            this.melodyCanvasEl.addEventListener('wind:pianokey', this._onPianoKey);
            this.melodyCanvasEl.addEventListener('wind:notedragmove', this._onNoteDragMove);
        }
        document.addEventListener('keydown', this._onKeyDown);
    }

    _detachCanvasEvents() {
        if (this.melodyCanvasEl) {
            this.melodyCanvasEl.removeEventListener('wind:addnote', this._onNoteAdd);
            this.melodyCanvasEl.removeEventListener('wind:notesmoved', this._onNotesMoved);
            this.melodyCanvasEl.removeEventListener('wind:editarticulation', this._onEditArticulation);
            this.melodyCanvasEl.removeEventListener('wind:selectionchange', this._onSelectionChange);
            this.melodyCanvasEl.removeEventListener('wind:pianokey', this._onPianoKey);
            this.melodyCanvasEl.removeEventListener('wind:notedragmove', this._onNoteDragMove);
        }
        document.removeEventListener('keydown', this._onKeyDown);
    }

    // ========================================================================
    // EVENT HANDLERS
    // ========================================================================

    _handleNoteAdd(e) {
        const { tick, note } = e.detail;
        if (!this.renderer) return;

        this.renderer.saveSnapshot();

        const articulation = this.articulationPanel?.getCurrentArticulation() || 'normal';
        this.renderer.melodyEvents.push({
            tick,
            note,
            velocity: this.defaultVelocity,
            duration: this.renderer.ticksPerBeat || 480,
            channel: this.channel,
            articulation,
        });
        this.renderer.melodyEvents.sort((a, b) => a.tick - b.tick);

        this._enforceMonophony();

        this.renderer.redraw();
        this._syncToMidi();
    }

    _handleNotesMoved() {
        if (!this.renderer) return;

        this._enforceMonophony();
        this._syncToMidi();
    }

    _handleEditArticulation(e) {
        const { index, event } = e.detail;
        if (!this.renderer || !event) return;

        // Cycle through articulations
        const types = Object.keys(WindInstrumentDatabase.ARTICULATION_TYPES);
        const currentIdx = types.indexOf(event.articulation || 'normal');
        const nextIdx = (currentIdx + 1) % types.length;
        const newArt = types[nextIdx];

        this.renderer.saveSnapshot();
        this.renderer.melodyEvents[index].articulation = newArt;
        this.renderer.redraw();
        this._syncToMidi();

        // Update panel to show current articulation
        if (this.articulationPanel) {
            this.articulationPanel.setArticulation(newArt);
        }
    }

    _handleSelectionChange() {
        this._updateInfo();
    }

    _handlePianoKey(e) {
        if (!this.modal.keyboardPlaybackEnabled) return;
        const note = e.detail.note;
        this.modal.playNoteFeedback(note, 100, this.channel);
    }

    _handleNoteDragMove(e) {
        if (!this.modal.dragPlaybackEnabled) return;
        const notes = e.detail.notes;
        if (notes.length > 0 && notes.length <= 6) {
            notes.forEach(note => {
                this.modal.playNoteFeedback(note.n, note.v || 100, note.c || this.channel);
            });
        }
    }

    _handleKeyDown(e) {
        if (!this.isVisible) return;

        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'z':
                    if (e.shiftKey) {
                        // Ctrl+Shift+Z = Redo
                        e.preventDefault();
                        if (this.renderer?.redo()) {
                            this._enforceMonophony();
                            this._syncToMidi();
                        }
                    } else {
                        // Ctrl+Z = Undo
                        e.preventDefault();
                        if (this.renderer?.undo()) {
                            this._enforceMonophony();
                            this._syncToMidi();
                        }
                    }
                    return;
                case 'y':
                    e.preventDefault();
                    if (this.renderer?.redo()) {
                        this._enforceMonophony();
                        this._syncToMidi();
                    }
                    return;
                case 'c':
                    e.preventDefault();
                    this.renderer?.copySelected();
                    return;
                case 'v':
                    e.preventDefault();
                    if (this.renderer?.hasClipboard()) {
                        this.renderer.paste(this.renderer.playheadTick || 0);
                        this._enforceMonophony();
                        this._syncToMidi();
                    }
                    return;
                case 'a':
                    e.preventDefault();
                    this.renderer?.selectAll();
                    return;
            }
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (this.renderer?.deleteSelected() > 0) {
                this._syncToMidi();
            }
        }
    }

    // ========================================================================
    // INFO UPDATE
    // ========================================================================

    _updateInfo() {
        if (this.articulationPanel) {
            this.articulationPanel.updateInfo(
                this.windPreset,
                this.melodyEvents.length,
                this.renderer?.selectedEvents?.size || 0
            );
        }
    }

    // ========================================================================
    // RESIZE
    // ========================================================================

    handleResize() {
        if (!this.isVisible) return;

        if (this.melodyCanvasEl) {
            const wrapper = this.melodyCanvasEl.parentElement;
            if (wrapper && wrapper.clientWidth > 0 && wrapper.clientHeight > 0) {
                this.melodyCanvasEl.width = wrapper.clientWidth;
                this.melodyCanvasEl.height = wrapper.clientHeight;
                if (this.renderer) {
                    this.renderer.redraw();
                    this.renderer._notifyScrollChange();
                }
            }
        }
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        if (this.renderer) {
            this.renderer.updateTheme();
            this.renderer.redraw();
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WindInstrumentEditor;
}
if (typeof window !== 'undefined') {
    window.WindInstrumentEditor = WindInstrumentEditor;
}
