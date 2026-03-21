// ============================================================================
// Fichier: public/js/views/components/TablatureEditor.js
// Description: Main tablature editor component
//   Orchestrates TablatureRenderer + FretboardDiagram
//   Handles bidirectional sync with MIDI editor (piano roll)
//   Manages note add/edit/delete, conversion, and CC generation
// ============================================================================

class TablatureEditor {
    constructor(modal) {
        this.modal = modal;
        this.api = modal.api;
        this.logger = window.logger || console;

        // State
        this.isVisible = false;
        this.tabOnlyMode = false;     // Toggle piano roll visibility
        this.stringInstrument = null;  // Current string instrument config from DB
        this.tabEvents = [];            // Current tablature data
        this.isSyncing = false;         // Guard against sync loops

        // Sub-components
        this.renderer = null;           // TablatureRenderer instance
        this.fretboard = null;          // FretboardDiagram instance

        // DOM references
        this.containerEl = null;
        this.tabCanvasEl = null;
        this.fretboardCanvasEl = null;

        // Bind methods
        this._onTabAdd = this._handleTabAdd.bind(this);
        this._onTabEdit = this._handleTabEdit.bind(this);
        this._onTabSelection = this._handleTabSelection.bind(this);
        this._onTabMove = this._handleTabMove.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);
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

    /**
     * Show the tablature panel for a given channel's string instrument.
     * Replaces the piano roll in the same space.
     * @param {Object} stringInstrument - Config from string_instruments table
     * @param {Array} midiNotes - Current MIDI notes for this channel
     * @param {number} channel - MIDI channel number
     */
    async show(stringInstrument, midiNotes, channel) {
        this.stringInstrument = stringInstrument;
        this.channel = channel;

        // Build or show the container
        if (!this.containerEl) {
            this._createDOM();
        }
        this.containerEl.style.display = 'flex';
        this.isVisible = true;

        // Split view: piano roll + tablature
        this._setPianoRollVisible(false);

        // Initialize renderer and fretboard
        this._initRenderer();
        this._initFretboard();

        // Convert MIDI notes to tablature
        await this.convertFromMidi(midiNotes);

        // Detach first to prevent duplicate listeners on repeated show() calls
        this._detachCanvasEvents();
        this._attachCanvasEvents();

        // Resize canvases after layout settles (split view needs recalculation)
        // Use double-rAF to ensure the browser has completed layout first
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.handleResize();
            });
        });
    }

    hide() {
        if (this.containerEl) {
            this.containerEl.style.display = 'none';
        }
        this.isVisible = false;
        this._detachCanvasEvents();

        // Restore the piano roll
        this._setPianoRollVisible(true);
    }

    /**
     * Hide piano roll and give full space to tablature, or restore piano roll.
     * Channel buttons (mute/hide) remain visible — they are in .channels-toolbar, not .notes-section.
     * @param {boolean} visible - If true, restore piano roll; if false, hide it for tablature
     */
    _setPianoRollVisible(visible) {
        const notesSection = this.modal.container?.querySelector('.notes-section');
        if (!notesSection) return;

        const pianoRollWrapper = notesSection.querySelector('.piano-roll-wrapper');
        const hScrollControls = notesSection.querySelector('.scroll-controls-horizontal');

        if (visible) {
            // Restore piano roll
            if (pianoRollWrapper) pianoRollWrapper.style.display = '';
        } else {
            // Hide piano roll — tablature takes full space
            // Keep horizontal scroll controls visible for tablature navigation
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
        if (this.fretboard) {
            this.fretboard.destroy();
            this.fretboard = null;
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
        this.containerEl.className = 'tablature-editor-panel';
        this.containerEl.innerHTML = `
            <div class="tablature-header">
                <div class="tablature-title">
                    <span class="tablature-icon">TAB</span>
                    <span class="tablature-instrument-name" id="tab-instrument-name"></span>
                    <span class="tablature-tuning" id="tab-tuning-display"></span>
                </div>
                <div class="tablature-toolbar">
                    <button class="tab-tool-btn" data-action="tab-undo" title="${this.t('midiEditor.undo')} (Ctrl+Z)">&#8630;</button>
                    <button class="tab-tool-btn" data-action="tab-redo" title="${this.t('midiEditor.redo')} (Ctrl+Y)">&#8631;</button>
                    <button class="tab-tool-btn" data-action="tab-copy" title="Copy (Ctrl+C)">CPY</button>
                    <button class="tab-tool-btn" data-action="tab-paste" title="Paste (Ctrl+V)">PST</button>
                    <button class="tab-tool-btn" data-action="tab-zoom-in" title="${this.t('tablature.zoomIn')}">+</button>
                    <button class="tab-tool-btn" data-action="tab-zoom-out" title="${this.t('tablature.zoomOut')}">-</button>
                    <button class="tab-tool-btn" data-action="tab-delete" title="${this.t('tablature.deleteSelected')}">DEL</button>
                    <button class="tab-tool-btn" data-action="tab-select-all" title="${this.t('tablature.selectAll')}">ALL</button>
                    <button class="tab-tool-btn tab-close-btn" data-action="tab-close" title="${this.t('common.close')}">&times;</button>
                </div>
            </div>
            <div class="tablature-body">
                <div class="tablature-canvas-wrapper">
                    <canvas id="tablature-canvas" class="tablature-canvas"></canvas>
                </div>
                <div class="fretboard-diagram-wrapper">
                    <canvas id="fretboard-canvas" class="fretboard-canvas"></canvas>
                </div>
            </div>
        `;

        // Insert inside .notes-section (same space as piano roll)
        const notesSection = this.modal.container?.querySelector('.notes-section');
        if (notesSection) {
            notesSection.appendChild(this.containerEl);
        }

        // Get canvas references
        this.tabCanvasEl = this.containerEl.querySelector('#tablature-canvas');
        this.fretboardCanvasEl = this.containerEl.querySelector('#fretboard-canvas');

        // Attach toolbar events
        this._attachToolbarEvents();

        // Update labels
        this._updateLabels();
    }

    _updateLabels() {
        if (!this.stringInstrument || !this.containerEl) return;

        const nameEl = this.containerEl.querySelector('#tab-instrument-name');
        const tuningEl = this.containerEl.querySelector('#tab-tuning-display');

        if (nameEl) {
            nameEl.textContent = this.stringInstrument.instrument_name || 'Guitar';
        }
        if (tuningEl && this.stringInstrument.tuning) {
            const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
            const tuningStr = this.stringInstrument.tuning
                .map(n => noteNames[n % 12])
                .join('-');
            tuningEl.textContent = `(${tuningStr})`;
        }
    }

    // ========================================================================
    // RENDERER INIT
    // ========================================================================

    _initRenderer() {
        if (!this.tabCanvasEl || !this.stringInstrument) return;

        const wrapper = this.tabCanvasEl.parentElement;
        this.tabCanvasEl.width = wrapper.clientWidth || 800;
        // Use available wrapper height, fallback to string-based calculation
        this.tabCanvasEl.height = wrapper.clientHeight || (this.stringInstrument.num_strings * 20 + 30);

        if (this.renderer) {
            this.renderer.destroy();
        }

        this.renderer = new TablatureRenderer(this.tabCanvasEl, {
            numStrings: this.stringInstrument.num_strings,
            tuning: this.stringInstrument.tuning,
            numFrets: this.stringInstrument.num_frets,
            isFretless: this.stringInstrument.is_fretless
        });

        // Sync zoom/scroll with piano roll if available
        if (this.modal.pianoRoll) {
            const pr = this.modal.pianoRoll;
            // Match horizontal scale
            if (pr.xrange && this.tabCanvasEl.width) {
                this.renderer.ticksPerPixel = pr.xrange / (this.tabCanvasEl.width - this.renderer.headerWidth);
            }
            if (pr.xoffset) {
                this.renderer.scrollX = pr.xoffset;
            }
        }
    }

    _initFretboard() {
        if (!this.fretboardCanvasEl || !this.stringInstrument) return;

        const wrapper = this.fretboardCanvasEl.parentElement;
        this.fretboardCanvasEl.width = wrapper.clientWidth || 150;
        this.fretboardCanvasEl.height = wrapper.clientHeight || 200;

        if (this.fretboard) {
            this.fretboard.destroy();
        }

        this.fretboard = new FretboardDiagram(this.fretboardCanvasEl, {
            numStrings: this.stringInstrument.num_strings,
            tuning: this.stringInstrument.tuning,
            numFrets: this.stringInstrument.num_frets,
            isFretless: this.stringInstrument.is_fretless
        });
    }

    // ========================================================================
    // CONVERSION — MIDI → TAB
    // ========================================================================

    /**
     * Convert MIDI notes to tablature using backend converter
     * @param {Array} midiNotes - Notes in pianoroll format {t, n, v, g, c}
     */
    async convertFromMidi(midiNotes) {
        if (!midiNotes || midiNotes.length === 0 || !this.stringInstrument) {
            this.tabEvents = [];
            if (this.renderer) this.renderer.setTabEvents([]);
            return;
        }

        try {
            const response = await this.api.sendCommand('tablature_convert_from_midi', {
                notes: midiNotes,
                string_instrument_id: this.stringInstrument.id
            });

            if (response && response.tablature) {
                this.tabEvents = response.tablature;
                if (this.renderer) {
                    this.renderer.setTabEvents(this.tabEvents);
                }
            }
        } catch (error) {
            this.logger.error('Failed to convert MIDI to tablature:', error);
            // Fallback: try client-side simple conversion
            this.tabEvents = this._simpleMidiToTab(midiNotes);
            if (this.renderer) {
                this.renderer.setTabEvents(this.tabEvents);
            }
        }
    }

    /**
     * Simple client-side fallback conversion (no optimization)
     * @private
     */
    _simpleMidiToTab(midiNotes) {
        const tuning = this.stringInstrument.tuning;
        const numFrets = this.stringInstrument.num_frets;
        const events = [];

        for (const note of midiNotes) {
            // Find first string that can play this note
            for (let s = 0; s < tuning.length; s++) {
                const fret = note.n - tuning[s];
                if (fret >= 0 && (this.stringInstrument.is_fretless || fret <= numFrets)) {
                    events.push({
                        tick: note.t,
                        string: s + 1,
                        fret: fret,
                        velocity: note.v,
                        duration: note.g,
                        midiNote: note.n,
                        channel: note.c
                    });
                    break;
                }
            }
        }

        return events;
    }

    // ========================================================================
    // CONVERSION — TAB → MIDI (bidirectional sync)
    // ========================================================================

    /**
     * Convert current tablature back to MIDI and sync with piano roll
     */
    async syncToMidi() {
        if (this.isSyncing || !this.stringInstrument) return;
        this.isSyncing = true;

        try {
            const response = await this.api.sendCommand('tablature_convert_to_midi', {
                tab_events: this.tabEvents,
                string_instrument_id: this.stringInstrument.id
            });

            if (response && response.notes) {
                // Update the modal's sequence for this channel
                this._updateModalSequence(response.notes, response.cc_events);
            }
        } catch (error) {
            this.logger.error('Failed to sync tablature to MIDI:', error);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Called when piano roll notes change — update tablature
     * @param {Array} midiNotes - Updated notes for this channel
     */
    async onMidiNotesChanged(midiNotes) {
        if (this.isSyncing || !this.isVisible) return;
        this.isSyncing = true;

        try {
            await this.convertFromMidi(midiNotes);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Update the modal's fullSequence with converted MIDI notes
     * @private
     */
    _updateModalSequence(newNotes, ccEvents) {
        const m = this.modal;
        if (!m.fullSequence) return;

        // Remove existing notes for this channel
        m.fullSequence = m.fullSequence.filter(n => n.c !== this.channel);

        // Add converted notes
        m.fullSequence.push(...newNotes);

        // Sort by tick
        m.fullSequence.sort((a, b) => a.t - b.t);

        // Store CC events for playback
        if (!m._tablatureCCEvents) m._tablatureCCEvents = {};
        m._tablatureCCEvents[this.channel] = ccEvents || [];

        // Update visible sequence
        const previousActiveChannels = new Set(m.activeChannels);
        m.updateSequenceFromActiveChannels(previousActiveChannels, true);

        // Refresh piano roll
        if (m.pianoRoll) {
            m.pianoRoll.sequence = m.sequence;
            if (typeof m.pianoRoll.redraw === 'function') {
                m.pianoRoll.redraw();
            }
        }

        m.isDirty = true;
    }

    // ========================================================================
    // PLAYBACK SYNC
    // ========================================================================

    /**
     * Update playhead position (called during playback)
     * @param {number} tick - Current playback tick
     */
    updatePlayhead(tick) {
        if (!this.isVisible) return;

        if (this.renderer) {
            this.renderer.setPlayhead(tick);

            // Auto-scroll to keep playhead visible
            const canvasWidth = this.tabCanvasEl?.width || 800;
            const playheadX = this.renderer._tickToX(tick);
            if (playheadX > canvasWidth * 0.8 || playheadX < this.renderer.headerWidth) {
                this.renderer.setScrollX(tick - (canvasWidth * 0.2) * this.renderer.ticksPerPixel);
            }
        }

        // Update fretboard diagram with current positions
        if (this.fretboard) {
            const currentPositions = this._getPositionsAtTick(tick);
            this.fretboard.setActivePositions(currentPositions);
        }
    }

    /**
     * Get active tab positions at a given tick
     * @private
     */
    _getPositionsAtTick(tick) {
        const tolerance = 60; // Small window around exact tick
        return this.tabEvents
            .filter(e => tick >= e.tick - tolerance && tick <= e.tick + (e.duration || 480))
            .map(e => ({ string: e.string, fret: e.fret, velocity: e.velocity }));
    }

    // ========================================================================
    // EVENT HANDLERS — CANVAS
    // ========================================================================

    _attachCanvasEvents() {
        if (!this.tabCanvasEl) return;
        this.tabCanvasEl.addEventListener('tab:addevent', this._onTabAdd);
        this.tabCanvasEl.addEventListener('tab:editevent', this._onTabEdit);
        this.tabCanvasEl.addEventListener('tab:selectionchange', this._onTabSelection);
        this.tabCanvasEl.addEventListener('tab:moveevents', this._onTabMove);
        document.addEventListener('keydown', this._onKeyDown);
    }

    _detachCanvasEvents() {
        if (!this.tabCanvasEl) return;
        this.tabCanvasEl.removeEventListener('tab:addevent', this._onTabAdd);
        this.tabCanvasEl.removeEventListener('tab:editevent', this._onTabEdit);
        this.tabCanvasEl.removeEventListener('tab:selectionchange', this._onTabSelection);
        this.tabCanvasEl.removeEventListener('tab:moveevents', this._onTabMove);
        document.removeEventListener('keydown', this._onKeyDown);
    }

    _handleTabAdd(e) {
        const { tick, string } = e.detail;
        this._showFretInput(tick, string);
    }

    _handleTabEdit(e) {
        const { index, event } = e.detail;
        this._showFretInput(event.tick, event.string, index);
    }

    _handleTabSelection(e) {
        // Update fretboard to show selected positions
        if (this.fretboard && this.renderer) {
            const positions = this.renderer.getSelectedEvents()
                .map(evt => ({ string: evt.string, fret: evt.fret, velocity: evt.velocity }));
            this.fretboard.setActivePositions(positions);
        }
    }

    _handleTabMove(e) {
        // Notes were moved by drag — sync back to MIDI
        this.tabEvents = this.renderer.tabEvents;
        this.syncToMidi();
    }

    _handleKeyDown(e) {
        if (!this.isVisible) return;

        // Only intercept when tablature panel is focused/visible
        const isCtrl = e.ctrlKey || e.metaKey;

        if (isCtrl && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            this._performUndo();
        } else if (isCtrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            this._performRedo();
        } else if (isCtrl && e.key === 'c') {
            if (this.renderer && this.renderer.selectedEvents.size > 0) {
                e.preventDefault();
                this.renderer.copySelected();
            }
        } else if (isCtrl && e.key === 'v') {
            if (this.renderer && this.renderer.hasClipboard()) {
                e.preventDefault();
                const pasteTick = this.renderer.playheadTick || 0;
                const count = this.renderer.paste(pasteTick);
                if (count > 0) {
                    this.tabEvents = this.renderer.tabEvents;
                    this.syncToMidi();
                }
            }
        }
    }

    _performUndo() {
        if (!this.renderer || !this.renderer.canUndo()) return;
        if (this.renderer.undo()) {
            this.tabEvents = this.renderer.tabEvents;
            this.syncToMidi();
        }
    }

    _performRedo() {
        if (!this.renderer || !this.renderer.canRedo()) return;
        if (this.renderer.redo()) {
            this.tabEvents = this.renderer.tabEvents;
            this.syncToMidi();
        }
    }

    _toggleTabOnlyMode() {
        // No longer needed — tablature now replaces the piano roll in the same space
        // Kept for API compatibility
    }

    /**
     * Show inline input for entering a fret number
     * @param {number} tick
     * @param {number} string - 1-based string number
     * @param {number} [editIndex] - If editing existing event, its index
     */
    _showFretInput(tick, string, editIndex = null) {
        // Remove any existing input
        const existing = this.containerEl?.querySelector('.tab-fret-input');
        if (existing) existing.remove();

        const maxFret = this.stringInstrument?.num_frets || 24;
        const currentFret = editIndex !== null ? this.tabEvents[editIndex]?.fret || 0 : 0;

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'tab-fret-input';
        input.min = 0;
        input.max = maxFret;
        input.value = currentFret;
        input.style.position = 'absolute';

        // Position near the click
        if (this.renderer) {
            const displayIndex = this.stringInstrument.num_strings - string;
            const canvasRect = this.tabCanvasEl.getBoundingClientRect();
            const x = this.renderer._tickToX(tick);
            const y = this.renderer._stringToY(displayIndex);
            input.style.left = `${canvasRect.left + x - 15}px`;
            input.style.top = `${canvasRect.top + y - 12}px`;
        }

        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            const fretVal = parseInt(input.value);
            if (!isNaN(fretVal) && fretVal >= 0 && fretVal <= maxFret) {
                if (this.renderer) this.renderer.saveSnapshot();
                if (editIndex !== null) {
                    // Update existing
                    this.tabEvents[editIndex].fret = fretVal;
                    this.tabEvents[editIndex].midiNote = this.stringInstrument.tuning[string - 1] + fretVal;
                } else {
                    // Add new
                    const midiNote = this.stringInstrument.tuning[string - 1] + fretVal;
                    this.tabEvents.push({
                        tick,
                        string,
                        fret: fretVal,
                        velocity: 100,
                        duration: this.modal.snapValues?.[this.modal.currentSnapIndex]?.ticks * 4 || 480,
                        midiNote,
                        channel: this.channel
                    });
                    // Sort by tick
                    this.tabEvents.sort((a, b) => a.tick - b.tick);
                }

                if (this.renderer) this.renderer.setTabEvents(this.tabEvents);
                this.syncToMidi();
            }
            input.remove();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { committed = true; input.remove(); }
        });
        input.addEventListener('blur', commit);

        document.body.appendChild(input);
        input.focus();
        input.select();
    }

    // ========================================================================
    // EVENT HANDLERS — TOOLBAR
    // ========================================================================

    _attachToolbarEvents() {
        if (!this.containerEl) return;

        this.containerEl.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (!action) return;

            switch (action) {
                case 'tab-view-mode':
                    this._toggleTabOnlyMode();
                    break;
                case 'tab-undo':
                    this._performUndo();
                    break;
                case 'tab-redo':
                    this._performRedo();
                    break;
                case 'tab-copy':
                    if (this.renderer) this.renderer.copySelected();
                    break;
                case 'tab-paste':
                    if (this.renderer && this.renderer.hasClipboard()) {
                        const pasteTick = this.renderer.playheadTick || 0;
                        const count = this.renderer.paste(pasteTick);
                        if (count > 0) {
                            this.tabEvents = this.renderer.tabEvents;
                            this.syncToMidi();
                        }
                    }
                    break;
                case 'tab-zoom-in':
                    if (this.renderer) {
                        this.renderer.setZoom(this.renderer.ticksPerPixel * 0.75);
                    }
                    break;
                case 'tab-zoom-out':
                    if (this.renderer) {
                        this.renderer.setZoom(this.renderer.ticksPerPixel * 1.33);
                    }
                    break;
                case 'tab-delete':
                    if (this.renderer) {
                        const count = this.renderer.deleteSelected();
                        if (count > 0) {
                            this.tabEvents = this.renderer.tabEvents;
                            this.syncToMidi();
                        }
                    }
                    break;
                case 'tab-select-all':
                    if (this.renderer) this.renderer.selectAll();
                    break;
                case 'tab-close':
                    this.hide();
                    break;
            }
        });
    }

    // ========================================================================
    // SCROLL SYNC WITH PIANO ROLL
    // ========================================================================

    /**
     * Sync scroll position from piano roll
     * @param {number} xoffset - Piano roll X offset in ticks
     * @param {number} xrange - Piano roll visible tick range
     */
    syncScrollFromPianoRoll(xoffset, xrange) {
        if (!this.renderer || !this.isVisible) return;

        this.renderer.scrollX = xoffset || 0;
        if (xrange && this.tabCanvasEl) {
            this.renderer.ticksPerPixel = xrange / (this.tabCanvasEl.width - this.renderer.headerWidth);
        }
        this.renderer.redraw();
    }

    // ========================================================================
    // RESIZE
    // ========================================================================

    handleResize() {
        if (!this.isVisible || !this.containerEl) return;

        if (this.tabCanvasEl) {
            const wrapper = this.tabCanvasEl.parentElement;
            if (wrapper) {
                const w = wrapper.clientWidth || 800;
                const h = wrapper.clientHeight || (this.stringInstrument?.num_strings || 6) * 20 + 40;
                this.tabCanvasEl.width = w;
                this.tabCanvasEl.height = h;
            }
            if (this.renderer) this.renderer.redraw();
        }

        if (this.fretboardCanvasEl) {
            const wrapper = this.fretboardCanvasEl.parentElement;
            if (wrapper) {
                const w = wrapper.clientWidth || 180;
                const h = wrapper.clientHeight || 200;
                this.fretboardCanvasEl.width = w;
                this.fretboardCanvasEl.height = h;
            }
            if (this.fretboard) this.fretboard.redraw();
        }
    }

    // ========================================================================
    // SAVE / LOAD
    // ========================================================================

    /**
     * Save current tablature to database
     * @param {number} midiFileId
     */
    async save(midiFileId) {
        if (!this.stringInstrument || !midiFileId) return;

        try {
            await this.api.sendCommand('tablature_save', {
                midi_file_id: midiFileId,
                channel: this.channel,
                string_instrument_id: this.stringInstrument.id,
                tablature_data: this.tabEvents
            });
        } catch (error) {
            this.logger.error('Failed to save tablature:', error);
        }
    }

    /**
     * Load tablature from database
     * @param {number} midiFileId
     */
    async load(midiFileId) {
        if (!midiFileId) return;

        try {
            const response = await this.api.sendCommand('tablature_get', {
                midi_file_id: midiFileId,
                channel: this.channel
            });

            if (response?.tablature?.tablature_data) {
                this.tabEvents = response.tablature.tablature_data;
                if (this.renderer) this.renderer.setTabEvents(this.tabEvents);
            }
        } catch (error) {
            this.logger.error('Failed to load tablature:', error);
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TablatureEditor;
}
if (typeof window !== 'undefined') {
    window.TablatureEditor = TablatureEditor;
}
