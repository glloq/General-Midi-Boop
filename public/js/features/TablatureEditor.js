// ============================================================================
// Fichier: public/js/features/TablatureEditor.js
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
        this._autoSaveTimer = null;     // Debounce timer for auto-save

        // Sub-components
        this.renderer = null;           // TablatureRenderer instance
        this.fretboard = null;          // FretboardDiagram instance

        // DOM references
        this.containerEl = null;
        this.tabCanvasEl = null;
        this.fretboardCanvasEl = null;

        // Edit mode: 'select' | 'pan' | 'change-string'
        this.editMode = 'pan';

        // Bind methods
        this._onTabAdd = this._handleTabAdd.bind(this);
        this._onTabEdit = this._handleTabEdit.bind(this);
        this._onTabSelection = this._handleTabSelection.bind(this);
        this._onTabMove = this._handleTabMove.bind(this);
        this._onTabChangeString = this._handleTabChangeString.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onFretboardClick = this._handleFretboardClick.bind(this);
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

        // Update labels for the current instrument (name, tuning, algorithm)
        this._updateLabels();

        // Split view: piano roll + tablature
        this._setPianoRollVisible(false);

        // Initialize renderer and fretboard
        this._initRenderer();
        this._initFretboard();

        // Set initial cursor for default pan mode
        if (this.tabCanvasEl) {
            this.tabCanvasEl.style.cursor = 'grab';
        }

        // Convert MIDI notes to tablature
        await this.convertFromMidi(midiNotes);

        // Detach first to prevent duplicate listeners on repeated show() calls
        this._detachCanvasEvents();
        this._attachCanvasEvents();

        // Update main toolbar mode buttons for tablature editor
        if (this.modal.editActions.updateModeButtons) this.modal.editActions.updateModeButtons();
        if (this.modal.editActions.updateEditButtons) this.modal.editActions.updateEditButtons();
        if (this.modal.editActions.updateUndoRedoButtonsState) this.modal.editActions.updateUndoRedoButtonsState();

        // Resize canvases after layout settles (split view needs recalculation)
        // Use double-rAF to ensure the browser has completed layout first
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.handleResize();
                if (this.modal.ccPicker?.syncAllEditors) this.modal.ccPicker.syncAllEditors();
            });
        });

        // Watch for container size changes (e.g. CC section open/close)
        this._startResizeObserver();
    }

    hide() {
        this._stopResizeObserver();
        if (this.containerEl) {
            this.containerEl.style.display = 'none';
        }
        this.isVisible = false;
        this._detachCanvasEvents();

        // Restore the piano roll
        this._setPianoRollVisible(true);

        // Restore main toolbar for piano roll
        if (this.modal.editActions.updateModeButtons) this.modal.editActions.updateModeButtons();
        if (this.modal.editActions.updateEditButtons) this.modal.editActions.updateEditButtons();
        if (this.modal.editActions.updateUndoRedoButtonsState) this.modal.editActions.updateUndoRedoButtonsState();

        // Refresh timeline / navigation bar to piano-roll viewport.
        if (this.modal.ccPicker?.syncAllEditors) this.modal.ccPicker.syncAllEditors();
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

        if (visible) {
            // Restore piano roll
            if (pianoRollWrapper) pianoRollWrapper.style.display = '';
        } else {
            // Hide piano roll — tablature takes full space
            if (pianoRollWrapper) pianoRollWrapper.style.display = 'none';
        }
    }

    destroy() {
        this._stopResizeObserver();
        if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
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
    // THEME
    // ========================================================================

    updateTheme() {
        if (this.renderer) {
            this.renderer.updateTheme();
            this.renderer.redraw();
        }
        if (this.fretboard) {
            this.fretboard.updateTheme();
            this.fretboard.redraw();
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
                    <span class="tablature-icon">${this.t('tablature.icon')}</span>
                    <span class="tablature-instrument-badge" id="tab-instrument-badge"></span>
                    <span class="tablature-tuning" id="tab-tuning-display"></span>
                    <select class="tab-algo-select" id="tab-algo-select" title="${this.t('tablature.algorithm')}">
                        <option value="min_movement">${this.t('tablature.algoMinMovement')}</option>
                        <option value="lowest_fret">${this.t('tablature.algoLowestFret')}</option>
                        <option value="highest_fret">${this.t('tablature.algoHighestFret')}</option>
                        <option value="zone">${this.t('tablature.algoZone')}</option>
                    </select>
                </div>
                <div class="tablature-toolbar">
                    <span class="tab-mode-group">
                        <button class="tab-tool-btn tab-mode-btn" data-action="tab-mode" data-mode="select" title="${this.t('tablature.modeSelect')}">&#x2B1C;</button>
                        <button class="tab-tool-btn tab-mode-btn active" data-action="tab-mode" data-mode="pan" title="${this.t('tablature.modePan')}">&#x2725;</button>
                        <button class="tab-tool-btn tab-mode-btn" data-action="tab-mode" data-mode="change-string" title="${this.t('tablature.modeChangeString')}">&#x21C5;</button>
                    </span>
                    <span class="tab-separator"></span>
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

        const badgeEl = this.containerEl.querySelector('#tab-instrument-badge');
        const tuningEl = this.containerEl.querySelector('#tab-tuning-display');

        if (badgeEl) {
            // Use the channel's GM instrument name if available, otherwise the string instrument name
            const channelInfo = this.modal.channels?.find(c => c.channel === this.channel);
            const gmName = channelInfo?.instrument;
            const siName = this.stringInstrument.instrument_name;
            const nStrings = this.stringInstrument.tuning?.length || this.stringInstrument.num_strings || 6;

            // Prefer GM name (e.g. "Acoustic Guitar (nylon)"), fall back to string instrument name
            const displayName = gmName || siName || this.t('stringInstrument.string');
            badgeEl.textContent = `${displayName} · ${this.t('tablature.strings', { count: nStrings })}`;
            badgeEl.title = displayName;
        }
        if (tuningEl && this.stringInstrument.tuning) {
            const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
            tuningEl.textContent = this.stringInstrument.tuning
                .map(n => noteNames[n % 12])
                .join('-');
        }

        // Set algorithm selector
        const algoSelect = this.containerEl.querySelector('#tab-algo-select');
        if (algoSelect) {
            algoSelect.value = this.stringInstrument.tab_algorithm || 'min_movement';
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
            tuning: this.stringInstrument.tuning,
            numFrets: this.stringInstrument.num_frets,
            isFretless: this.stringInstrument.is_fretless,
            onScrollChange: () => {
                if (this.modal && this.modal.ccPicker?.syncAllEditors) {
                    this.modal.ccPicker.syncAllEditors();
                }
            }
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

        // PlaybackTimelineBar is managed by the main MidiEditorModal (no duplicate)
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
                const dropped = response.stats && typeof response.stats.dropped === 'number'
                    ? response.stats.dropped
                    : Math.max(0, midiNotes.length - this.tabEvents.length);
                this._notifyDroppedNotes(dropped);
                if (this.renderer) {
                    this.renderer.setTabEvents(this.tabEvents);
                }
            }
        } catch (error) {
            this.logger.error('Failed to convert MIDI to tablature:', error);
            // Fallback: try client-side simple conversion
            this.tabEvents = this._simpleMidiToTab(midiNotes);
            this._notifyDroppedNotes(Math.max(0, midiNotes.length - this.tabEvents.length));
            if (this.renderer) {
                this.renderer.setTabEvents(this.tabEvents);
            }
        }

        // Auto-save converted tablature for backend playback
        this._autoSave();
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
            // Determine which strings are occupied at this tick by earlier notes
            const occupiedStrings = new Set();
            for (let i = events.length - 1; i >= 0; i--) {
                const ev = events[i];
                if (ev.tick + ev.duration <= note.t) {
                    if (note.t - ev.tick > 7680) break;
                    continue;
                }
                if (ev.tick < note.t) {
                    occupiedStrings.add(ev.string);
                }
            }

            // Find first available string that can play this note
            let placed = false;
            for (let s = 0; s < tuning.length; s++) {
                const stringNum = s + 1;
                if (occupiedStrings.has(stringNum)) continue;
                const fret = note.n - tuning[s];
                if (fret >= 0 && (this.stringInstrument.is_fretless || fret <= numFrets)) {
                    events.push({
                        tick: note.t,
                        string: stringNum,
                        fret: fret,
                        velocity: note.v,
                        duration: note.g,
                        midiNote: note.n,
                        channel: note.c
                    });
                    placed = true;
                    break;
                }
            }

            if (placed) continue;

            // Clamp fallback: pick the free string whose raw fret is closest to
            // the playable range, clamp the fret, and mark unplayable so the
            // renderer displays it in the warning colour. Avoids silent drops.
            let bestString = -1;
            let bestFret = 0;
            let bestDist = Infinity;
            const maxAllowed = this.stringInstrument.is_fretless ? 48 : numFrets;
            for (let s = 0; s < tuning.length; s++) {
                const stringNum = s + 1;
                if (occupiedStrings.has(stringNum)) continue;
                const raw = note.n - tuning[s];
                const dist = raw < 0 ? -raw : Math.max(0, raw - maxAllowed);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestString = stringNum;
                    bestFret = Math.max(0, Math.min(raw, maxAllowed));
                }
            }
            if (bestString !== -1) {
                events.push({
                    tick: note.t,
                    string: bestString,
                    fret: bestFret,
                    velocity: note.v,
                    duration: note.g,
                    midiNote: note.n,
                    channel: note.c,
                    unplayable: true
                });
            }
        }

        return events;
    }

    /**
     * Emit a user notification when conversion dropped notes.
     * @private
     */
    _notifyDroppedNotes(dropped) {
        if (!dropped || dropped <= 0) return;
        if (!this.modal || typeof this.modal.showNotification !== 'function') return;
        this.modal.showNotification(
            `${dropped} note(s) ignorée(s) : conflits de cordes insolubles sur cet instrument.`,
            'warn'
        );
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

            // Auto-save so backend playback uses the latest fingering
            this._autoSave();
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
        m.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels, true);

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
            // Pull scroll from the piano roll (single source of truth for
            // horizontal scroll position — same pattern as DrumPatternEditor
            // and WindInstrumentEditor). The piano roll's auto-scroll in
            // MidiEditorPlayback.updatePlaybackCursor drives the shared
            // xoffset, which keeps every editor visually aligned.
            const pr = this.modal.pianoRoll;
            if (pr) {
                this.renderer.scrollX = pr.xoffset || 0;
            }

            this.renderer.setPlayhead(tick);
        }

        // PlaybackTimelineBar is updated by MidiEditorModal.updatePlaybackCursor()

        // Update fretboard diagram with current positions
        if (this.fretboard) {
            const currentPositions = this._getPositionsAtTick(tick);
            this.fretboard.setActivePositions(currentPositions);
            // C.4: also update the hand-window overlay so the operator
            // sees where the mechanical hand sits at the current tick.
            this._updateFretboardHandWindow(tick);
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

    /**
     * Compute the current hand-position window from the tab events
     * around `tick` and push it to the FretboardDiagram. Falls back to
     * clearing the window when no fretted note sits in the lookback
     * period (open strings don't anchor the hand).
     * @private
     */
    _updateFretboardHandWindow(tick) {
        if (!this.fretboard || typeof this.fretboard.setHandWindow !== 'function') return;
        const span = Number.isFinite(this._handSpanFrets) && this._handSpanFrets > 0
            ? this._handSpanFrets
            : 4;
        // Sliding window — last ~2 beats of fretted notes feed the anchor.
        const lookbackTicks = (this.renderer?.ticksPerBeat || 480) * 2;
        const recentFretted = this.tabEvents
            .filter(e => e.fret > 0 && e.tick <= tick && e.tick >= tick - lookbackTicks)
            .map(e => e.fret);
        if (recentFretted.length === 0) {
            this.fretboard.setHandWindow(null);
            return;
        }
        const anchorFret = Math.min(...recentFretted);
        const topFret = Math.max(...recentFretted);
        const level = (topFret - anchorFret) > span ? 'warning' : 'ok';
        this.fretboard.setHandWindow({ anchorFret, spanFrets: span, level });
    }

    /**
     * Push hand-position warnings to the renderer so problematic events
     * (too many fingers, move-too-fast, chord-span-exceeded) get an
     * amber/red border around their fret number. Pass `[]` or null to
     * clear the highlights.
     * @param {Array<{tick:number, string?:number, code:string, level:string}>} warnings
     */
    setHandWarnings(warnings) {
        if (this.renderer && typeof this.renderer.setHandWarnings === 'function') {
            this.renderer.setHandWarnings(warnings || []);
        }
    }

    /**
     * Configure the hand-span (in frets) used by the FretboardDiagram
     * overlay. Typically wired from the instrument's hands_config.
     * @param {number} spanFrets
     */
    setHandSpanFrets(spanFrets) {
        if (Number.isFinite(spanFrets) && spanFrets > 0) {
            this._handSpanFrets = spanFrets;
            // Repaint with the new span on the next playhead update; for
            // an immediate visual effect, redraw at the current tick.
            if (this.renderer && this.fretboard) {
                this._updateFretboardHandWindow(this.renderer.playheadTick || 0);
            }
        }
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
        this.tabCanvasEl.addEventListener('tab:changestring', this._onTabChangeString);
        if (this.fretboardCanvasEl) {
            this.fretboardCanvasEl.addEventListener('fretboard:click', this._onFretboardClick);
        }
        document.addEventListener('keydown', this._onKeyDown);
    }

    _detachCanvasEvents() {
        if (!this.tabCanvasEl) return;
        this.tabCanvasEl.removeEventListener('tab:addevent', this._onTabAdd);
        this.tabCanvasEl.removeEventListener('tab:editevent', this._onTabEdit);
        this.tabCanvasEl.removeEventListener('tab:selectionchange', this._onTabSelection);
        this.tabCanvasEl.removeEventListener('tab:moveevents', this._onTabMove);
        this.tabCanvasEl.removeEventListener('tab:changestring', this._onTabChangeString);
        if (this.fretboardCanvasEl) {
            this.fretboardCanvasEl.removeEventListener('fretboard:click', this._onFretboardClick);
        }
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

    _handleTabSelection(_e) {
        // Update fretboard to show selected positions
        if (this.fretboard && this.renderer) {
            const positions = this.renderer.getSelectedEvents()
                .map(evt => ({ string: evt.string, fret: evt.fret, velocity: evt.velocity }));
            this.fretboard.setActivePositions(positions);
        }
    }

    _handleTabMove(_e) {
        // Notes were moved by drag — sync back to MIDI
        this.tabEvents = this.renderer.tabEvents;
        this.syncToMidi();
    }

    _handleFretboardClick(e) {
        if (!this.modal.keyboardPlaybackEnabled) return;
        const midiNote = e.detail.midiNote;
        this.modal.playNoteFeedback(midiNote, 100, this.channel);
    }

    _handleTabChangeString(e) {
        const { targetString } = e.detail;
        if (!targetString || !this.renderer || this.renderer.selectedEvents.size === 0) return;
        if (!this.stringInstrument) return;

        const tuning = this.stringInstrument.tuning;
        const numFrets = this.stringInstrument.num_frets;
        const maxFret = this.stringInstrument.is_fretless ? 48 : (numFrets || 24);
        const indices = this.renderer.getSelectedIndices();

        // Check all can move to the target string.
        const moves = [];
        for (const i of indices) {
            const evt = this.tabEvents[i];
            if (!evt) continue;
            const newFret = evt.midiNote - tuning[targetString - 1];
            if (newFret < 0 || newFret > maxFret) return; // Can't play on that string
            moves.push({ index: i, newString: targetString, newFret });
        }

        if (moves.length === 0) return;

        this.renderer.saveSnapshot();
        for (const m of moves) {
            this.tabEvents[m.index].string = m.newString;
            this.tabEvents[m.index].fret = m.newFret;
        }
        this.renderer.setTabEvents(this.tabEvents);
        this.syncToMidi();
    }

    _handleKeyDown(e) {
        if (!this.isVisible) return;

        // Don't intercept when focus is on form inputs (e.g. fret input)
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

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
        } else if (e.key === 'ArrowUp' && !isCtrl) {
            // Move selected notes up one string (higher string number = lower pitch)
            if (this.renderer && this.renderer.selectedEvents.size > 0) {
                e.preventDefault();
                this._moveSelectedStrings(1);
            }
        } else if (e.key === 'ArrowDown' && !isCtrl) {
            // Move selected notes down one string (lower string number = higher pitch)
            if (this.renderer && this.renderer.selectedEvents.size > 0) {
                e.preventDefault();
                this._moveSelectedStrings(-1);
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (this.renderer?.deleteSelected() > 0) {
                this.tabEvents = this.renderer.tabEvents;
                this.syncToMidi();
            }
        } else if (isCtrl && e.key === 'a') {
            e.preventDefault();
            this.renderer?.selectAll();
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

    /**
     * Set the active edit mode and update UI
     * @param {'select'|'pan'|'change-string'} mode
     */
    _setEditMode(mode) {
        if (!mode) return;
        this.editMode = mode;

        // Update mode button UI
        const modeButtons = this.containerEl?.querySelectorAll('.tab-mode-btn');
        if (modeButtons) {
            modeButtons.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }

        // Update renderer mode
        if (this.renderer) {
            this.renderer.setEditMode(mode);
        }

        // Update canvas cursor
        if (this.tabCanvasEl) {
            const cursors = { 'select': 'crosshair', 'pan': 'grab', 'change-string': 'ns-resize' };
            this.tabCanvasEl.style.cursor = cursors[mode] || 'crosshair';
        }
    }

    /**
     * Move selected notes up or down by one string, keeping the same MIDI note.
     * @param {number} direction - -1 = up (higher string number), +1 = down (lower string number)
     */
    _moveSelectedStrings(direction) {
        if (!this.renderer || this.renderer.selectedEvents.size === 0) return;
        if (!this.stringInstrument) return;

        const tuning = this.stringInstrument.tuning;
        const numFrets = this.stringInstrument.num_frets;
        const numStrings = this.stringInstrument.num_strings;
        const indices = this.renderer.getSelectedIndices();

        // Check all can move before committing.
        const moves = [];
        for (const i of indices) {
            const evt = this.tabEvents[i];
            if (!evt) continue;
            const newString = evt.string + direction;
            if (newString < 1 || newString > numStrings) return; // Can't move out of range
            const newFret = evt.midiNote - tuning[newString - 1];
            const maxFret = this.stringInstrument.is_fretless ? 48 : (numFrets || 24);
            if (newFret < 0 || newFret > maxFret) return; // Can't play on that string
            moves.push({ index: i, newString, newFret });
        }

        if (moves.length === 0) return;

        this.renderer.saveSnapshot();
        for (const m of moves) {
            this.tabEvents[m.index].string = m.newString;
            this.tabEvents[m.index].fret = m.newFret;
        }
        this.renderer.setTabEvents(this.tabEvents);
        this.syncToMidi();
    }

    /**
     * Handle algorithm change from selector — re-convert MIDI notes
     * @param {string} algorithm
     */
    async _onAlgorithmChange(algorithm) {
        if (!this.stringInstrument || !algorithm) return;

        // Save to DB
        if (this.stringInstrument.id) {
            try {
                await this.api.sendCommand('string_instrument_update', {
                    id: this.stringInstrument.id,
                    tab_algorithm: algorithm
                });
                this.stringInstrument.tab_algorithm = algorithm;
            } catch (error) {
                this.logger.error('Failed to save algorithm preference:', error);
            }
        }

        // Re-convert from current MIDI notes with the new algorithm
        const channelNotes = (this.modal.fullSequence || []).filter(n => n.c === this.channel);
        await this.convertFromMidi(channelNotes);
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
            input.style.left = `${canvasRect.left + x + window.scrollX - 15}px`;
            input.style.top = `${canvasRect.top + y + window.scrollY - 12}px`;
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

        // Algorithm selector
        const algoSelect = this.containerEl.querySelector('#tab-algo-select');
        if (algoSelect) {
            algoSelect.addEventListener('change', (e) => {
                this._onAlgorithmChange(e.target.value);
            });
        }

        this.containerEl.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (!action) return;

            switch (action) {
                case 'tab-mode':
                    this._setEditMode(e.target.closest('[data-mode]')?.dataset.mode);
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
                if (this.tabCanvasEl.width !== w || this.tabCanvasEl.height !== h) {
                    this.tabCanvasEl.width = w;
                    this.tabCanvasEl.height = h;
                }
            }
            if (this.renderer) this.renderer.redraw();
        }

        if (this.fretboardCanvasEl) {
            const wrapper = this.fretboardCanvasEl.parentElement;
            if (wrapper) {
                const w = wrapper.clientWidth || 180;
                const h = wrapper.clientHeight || 200;
                if (this.fretboardCanvasEl.width !== w || this.fretboardCanvasEl.height !== h) {
                    this.fretboardCanvasEl.width = w;
                    this.fretboardCanvasEl.height = h;
                }
            }
            if (this.fretboard) this.fretboard.redraw();
        }
    }

    _startResizeObserver() {
        this._stopResizeObserver();
        if (typeof ResizeObserver === 'undefined') return;

        this._resizeObserver = new ResizeObserver(() => {
            if (!this._resizeRAF) {
                this._resizeRAF = requestAnimationFrame(() => {
                    this._resizeRAF = null;
                    this.handleResize();
                });
            }
        });

        if (this.tabCanvasEl?.parentElement) {
            this._resizeObserver.observe(this.tabCanvasEl.parentElement);
        }
        if (this.fretboardCanvasEl?.parentElement) {
            this._resizeObserver.observe(this.fretboardCanvasEl.parentElement);
        }
    }

    _stopResizeObserver() {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._resizeRAF) {
            cancelAnimationFrame(this._resizeRAF);
            this._resizeRAF = null;
        }
    }

    // ========================================================================
    // SAVE / LOAD
    // ========================================================================

    /**
     * Debounced auto-save — persists tablature to DB so backend playback
     * (MidiPlayer) always has up-to-date CC20/CC21 fingering data.
     * @private
     */
    _autoSave() {
        const fileId = this.modal?.currentFile;
        if (!fileId || !this.stringInstrument) return;

        if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
        this._autoSaveTimer = setTimeout(() => {
            this.save(fileId);
        }, 500);
    }

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
