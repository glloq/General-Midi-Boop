// ============================================================================
// Fichier: public/js/views/components/DrumPatternEditor.js
// Description: Main drum pattern editor component
//   Orchestrates DrumGridRenderer + DrumToolsPanel
//   Handles bidirectional sync with MIDI editor (piano roll)
//   Manages hit add/edit/delete, velocity editing
// ============================================================================

class DrumPatternEditor {
    constructor(modal) {
        this.modal = modal;
        this.api = modal.api;
        this.logger = window.logger || console;

        // State
        this.isVisible = false;
        this.channel = 9;              // Drum channel (MIDI channel 10 = index 9)
        this.gridEvents = [];          // Current grid data
        this.isSyncing = false;        // Guard against sync loops

        // Sub-components
        this.gridRenderer = null;      // DrumGridRenderer instance
        this.toolsPanel = null;        // DrumToolsPanel instance

        // DOM references
        this.containerEl = null;
        this.gridCanvasEl = null;
        this.toolsPanelEl = null;

        // Default velocity for new hits
        this.defaultVelocity = 100;

        // Quantize resolution in subdivisions per beat
        this.quantizeDiv = 4; // 16th notes

        // Bind methods
        this._onGridAdd = this._handleGridAdd.bind(this);
        this._onGridEditVelocity = this._handleGridEditVelocity.bind(this);
        this._onGridSelection = this._handleGridSelection.bind(this);
        this._onGridLabelClick = this._handleGridLabelClick.bind(this);
        this._onGridPlayRow = this._handleGridPlayRow.bind(this);
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
     * Show the drum pattern panel for a given channel.
     * @param {Array} midiNotes - Current MIDI notes for this channel {t, n, v, g, c}
     * @param {number} channel - MIDI channel number (usually 9)
     */
    show(midiNotes, channel) {
        this.channel = channel;

        if (!this.containerEl) {
            this._createDOM();
        }
        this.containerEl.style.display = 'flex';
        this.isVisible = true;

        this._setPianoRollVisible(false);
        this._initGridRenderer();
        this._initToolsPanel();

        // Set initial cursor for default pan mode
        if (this.gridCanvasEl) {
            this.gridCanvasEl.style.cursor = 'grab';
        }

        // Convert MIDI notes to grid events
        this.loadFromMidi(midiNotes);

        // Sync playable notes from channel highlight data
        this._syncPlayableNotes();

        this._detachCanvasEvents();
        this._attachCanvasEvents();

        // Update main toolbar mode buttons for drum editor
        if (this.modal.updateModeButtons) this.modal.updateModeButtons();
        if (this.modal.updateEditButtons) this.modal.updateEditButtons();
        if (this.modal.updateUndoRedoButtonsState) this.modal.updateUndoRedoButtonsState();

        // Resize after layout settles and sync timeline alignment
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.handleResize();
                if (this.modal.syncAllEditors) this.modal.syncAllEditors();
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
        if (this.modal.updateModeButtons) this.modal.updateModeButtons();
        if (this.modal.updateEditButtons) this.modal.updateEditButtons();
        if (this.modal.updateUndoRedoButtonsState) this.modal.updateUndoRedoButtonsState();
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
        if (this.gridRenderer) {
            this.gridRenderer.destroy();
            this.gridRenderer = null;
        }
        if (this.toolsPanel) {
            this.toolsPanel.destroy();
            this.toolsPanel = null;
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
        this.containerEl.className = 'drum-pattern-editor-panel';
        this.containerEl.innerHTML = `
            <div class="drum-pattern-header">
                <div class="drum-pattern-title">
                    <span class="drum-pattern-icon">${this.t('drumPattern.icon')}</span>
                    <span class="drum-pattern-badge" id="drum-pattern-badge">${this.t('drumPattern.title')}</span>
                    <select class="drum-quantize-select" id="drum-quantize-select" title="${this.t('drumPattern.quantize')}">
                        <option value="1">1/4</option>
                        <option value="2">1/8</option>
                        <option value="3">1/8T</option>
                        <option value="4" selected>1/16</option>
                        <option value="6">1/16T</option>
                        <option value="8">1/32</option>
                    </select>
                    <label class="drum-velocity-label" title="${this.t('drumPattern.defaultVelocity')}">
                        ${this.t('drumPattern.velocityLabel')}
                        <input type="number" class="drum-velocity-input" id="drum-velocity-input"
                            min="1" max="127" value="${this.defaultVelocity}" />
                    </label>
                </div>
                <div class="drum-pattern-toolbar">
                    <button class="drum-tool-btn drum-mode-btn active" data-action="drum-mode" data-mode="pan" title="${this.t('windEditor.pan')}">&#x2725;</button>
                    <button class="drum-tool-btn drum-mode-btn" data-action="drum-mode" data-mode="select" title="${this.t('windEditor.select')}">&#x2B1C;</button>
                    <span class="drum-separator"></span>
                    <button class="drum-tool-btn drum-close-btn" data-action="drum-close" title="${this.t('common.close')}">&times;</button>
                </div>
            </div>
            <div class="drum-pattern-body">
                <div class="drum-grid-canvas-wrapper">
                    <canvas id="drum-grid-canvas" class="drum-grid-canvas"></canvas>
                </div>
                <div class="drum-tools-panel-wrapper" id="drum-tools-panel-wrapper">
                </div>
            </div>
        `;

        const notesSection = this.modal.container?.querySelector('.notes-section');
        if (notesSection) {
            notesSection.appendChild(this.containerEl);
        }

        this.gridCanvasEl = this.containerEl.querySelector('#drum-grid-canvas');
        this.toolsPanelEl = this.containerEl.querySelector('#drum-tools-panel-wrapper');

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

            // Only handle drum-* actions (not tools panel actions)
            const action = btn.dataset.action;
            if (!action.startsWith('drum-')) return;

            switch (action) {
                case 'drum-mode':
                    this._setEditMode(btn.dataset.mode);
                    break;
                case 'drum-undo':
                    if (this.gridRenderer?.undo()) this._syncToMidi();
                    break;
                case 'drum-redo':
                    if (this.gridRenderer?.redo()) this._syncToMidi();
                    break;
                case 'drum-copy':
                    this.gridRenderer?.copySelected();
                    break;
                case 'drum-paste':
                    if (this.gridRenderer?.hasClipboard()) {
                        const tick = this.gridRenderer.playheadTick || 0;
                        this.gridRenderer.paste(tick);
                        this._syncToMidi();
                    }
                    break;
                case 'drum-zoom-in':
                    if (this.gridRenderer) {
                        this.gridRenderer.setZoom(this.gridRenderer.ticksPerPixel / 1.5);
                    }
                    break;
                case 'drum-zoom-out':
                    if (this.gridRenderer) {
                        this.gridRenderer.setZoom(this.gridRenderer.ticksPerPixel * 1.5);
                    }
                    break;
                case 'drum-delete':
                    if (this.gridRenderer?.deleteSelected() > 0) {
                        this._syncToMidi();
                    }
                    break;
                case 'drum-select-all':
                    this.gridRenderer?.selectAll();
                    break;
                case 'drum-close':
                    this.hide();
                    this.modal._updateDrumButtonState?.(false);
                    break;
            }
        });

        // Quantize selector
        const quantSelect = this.containerEl.querySelector('#drum-quantize-select');
        if (quantSelect) {
            quantSelect.addEventListener('change', () => {
                this.quantizeDiv = parseInt(quantSelect.value, 10) || 4;
                if (this.gridRenderer) {
                    this.gridRenderer.quantizeDiv = this.quantizeDiv;
                    this.gridRenderer.redraw();
                }
            });
        }

        // Velocity input
        const velInput = this.containerEl.querySelector('#drum-velocity-input');
        if (velInput) {
            velInput.addEventListener('change', () => {
                this.defaultVelocity = Math.max(1, Math.min(127, parseInt(velInput.value, 10) || 100));
            });
        }
    }

    _setEditMode(mode) {
        if (!this.gridRenderer) return;
        this.gridRenderer.tool = mode;

        // Update active class on mode buttons
        const modeButtons = this.containerEl.querySelectorAll('.drum-mode-btn');
        modeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // Update cursor
        if (this.gridCanvasEl) {
            this.gridCanvasEl.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
        }
    }

    // ========================================================================
    // RENDERER & TOOLS INIT
    // ========================================================================

    _initGridRenderer() {
        if (!this.gridCanvasEl) return;

        const wrapper = this.gridCanvasEl.parentElement;
        this.gridCanvasEl.width = wrapper.clientWidth || 800;
        this.gridCanvasEl.height = wrapper.clientHeight || 400;

        if (this.gridRenderer) {
            this.gridRenderer.destroy();
        }

        this.gridRenderer = new DrumGridRenderer(this.gridCanvasEl, {
            tool: 'pan',
            onScrollChange: () => {
                if (this.modal && this.modal.syncAllEditors) {
                    this.modal.syncAllEditors();
                }
            }
        });

        // Sync quantize division
        this.gridRenderer.quantizeDiv = this.quantizeDiv;

        // Sync zoom/scroll with piano roll if available
        if (this.modal.pianoRoll) {
            const pr = this.modal.pianoRoll;
            if (pr.xrange && this.gridCanvasEl.width) {
                this.gridRenderer.ticksPerPixel = pr.xrange / (this.gridCanvasEl.width - this.gridRenderer.headerWidth);
            }
            if (pr.xoffset) {
                this.gridRenderer.scrollX = pr.xoffset;
            }
        }

        // Wire tools panel to the new grid renderer
        if (this.toolsPanel) {
            this.toolsPanel.setGridRenderer(this.gridRenderer);
        }

        // PlaybackTimelineBar is managed by the main MidiEditorModal (no duplicate)
    }

    _initToolsPanel() {
        if (!this.toolsPanelEl) return;

        if (this.toolsPanel) {
            this.toolsPanel.destroy();
        }

        this.toolsPanel = new DrumToolsPanel(this.toolsPanelEl, {
            onChanged: () => this._syncToMidi()
        });

        if (this.gridRenderer) {
            this.toolsPanel.setGridRenderer(this.gridRenderer);
        }
    }

    /**
     * Sync playable notes from channel highlight data into the grid renderer.
     * If channel 9 has routing with playable notes info, pass it to the grid.
     */
    _syncPlayableNotes() {
        if (!this.gridRenderer) return;
        const highlights = this.modal.channelPlayableHighlights;
        if (highlights && highlights.has(this.channel)) {
            // Set<noteNumber> or null (null = all notes playable)
            this.gridRenderer.playableNotes = highlights.get(this.channel);
        } else {
            this.gridRenderer.playableNotes = undefined;
        }
        this.gridRenderer.mutedNotes.clear();
    }

    /**
     * Called when playable notes highlight changes (e.g. user clicks "Notes jouables").
     * Auto-mutes notes that are not playable by the routed instrument.
     */
    syncPlayableNoteMutes() {
        if (!this.gridRenderer) return;

        const highlights = this.modal.channelPlayableHighlights;
        if (highlights && highlights.has(this.channel)) {
            const playable = highlights.get(this.channel);
            this.gridRenderer.playableNotes = playable;

            // Auto-mute non-playable notes if we have a discrete set
            if (playable && playable.size > 0) {
                for (const note of this.gridRenderer.visibleNotes) {
                    if (!playable.has(note)) {
                        this.gridRenderer.mutedNotes.add(note);
                    } else {
                        this.gridRenderer.mutedNotes.delete(note);
                    }
                }
            } else {
                // null = all playable → unmute all
                this.gridRenderer.mutedNotes.clear();
            }
        } else {
            // No highlight info → clear playable state and unmute all
            this.gridRenderer.playableNotes = undefined;
            this.gridRenderer.mutedNotes.clear();
        }

        this.gridRenderer.redraw();
    }

    // ========================================================================
    // CONVERSION — MIDI → GRID
    // ========================================================================

    /**
     * Convert MIDI notes to grid events (1:1 mapping for drums)
     * @param {Array} midiNotes - Notes in pianoroll format {t, n, v, g, c}
     */
    loadFromMidi(midiNotes) {
        if (!midiNotes || midiNotes.length === 0) {
            this.gridEvents = [];
            if (this.gridRenderer) this.gridRenderer.setGridEvents([]);
            return;
        }

        this.gridEvents = midiNotes.map(note => ({
            tick: note.t,
            note: note.n,
            velocity: note.v || 100,
            duration: note.g || 120,
            channel: note.c !== undefined ? note.c : this.channel,
        }));

        if (this.gridRenderer) {
            this.gridRenderer.setGridEvents(this.gridEvents);
        }
    }

    // ========================================================================
    // CONVERSION — GRID → MIDI (bidirectional sync)
    // ========================================================================

    _syncToMidi() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            // Update grid events from renderer
            if (this.gridRenderer) {
                this.gridEvents = this.gridRenderer.gridEvents;
            }

            // Convert grid events back to MIDI notes
            const newNotes = this.gridEvents.map(evt => ({
                t: evt.tick,
                n: evt.note,
                v: evt.velocity || 100,
                g: evt.duration || 120,
                c: this.channel
            }));

            this._updateModalSequence(newNotes);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Called when piano roll notes change — update grid
     * @param {Array} midiNotes - Updated notes for this channel
     */
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

        // Remove existing notes for this channel
        m.fullSequence = m.fullSequence.filter(n => n.c !== this.channel);

        // Add converted notes
        m.fullSequence.push(...newNotes);

        // Sort by tick
        m.fullSequence.sort((a, b) => a.t - b.t);

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

        if (this.gridRenderer) {
            // Sync scroll with piano roll
            const pr = this.modal.pianoRoll;
            if (pr) {
                this.gridRenderer.scrollX = pr.xoffset || 0;
            }
            this.gridRenderer.setPlayhead(tick);
        }

        // PlaybackTimelineBar is updated by MidiEditorModal.updatePlaybackCursor()
    }

    // ========================================================================
    // CANVAS EVENTS
    // ========================================================================

    _attachCanvasEvents() {
        if (this.gridCanvasEl) {
            this.gridCanvasEl.addEventListener('drum:addhit', this._onGridAdd);
            this.gridCanvasEl.addEventListener('drum:editvelocity', this._onGridEditVelocity);
            this.gridCanvasEl.addEventListener('drum:selectionchange', this._onGridSelection);
            this.gridCanvasEl.addEventListener('drum:labelclick', this._onGridLabelClick);
            this.gridCanvasEl.addEventListener('drum:playrow', this._onGridPlayRow);
        }
        document.addEventListener('keydown', this._onKeyDown);
    }

    _detachCanvasEvents() {
        if (this.gridCanvasEl) {
            this.gridCanvasEl.removeEventListener('drum:addhit', this._onGridAdd);
            this.gridCanvasEl.removeEventListener('drum:editvelocity', this._onGridEditVelocity);
            this.gridCanvasEl.removeEventListener('drum:selectionchange', this._onGridSelection);
            this.gridCanvasEl.removeEventListener('drum:labelclick', this._onGridLabelClick);
            this.gridCanvasEl.removeEventListener('drum:playrow', this._onGridPlayRow);
        }
        document.removeEventListener('keydown', this._onKeyDown);
    }

    // ========================================================================
    // EVENT HANDLERS
    // ========================================================================

    _handleGridAdd(e) {
        const { tick, note } = e.detail;
        if (!this.gridRenderer) return;

        this.gridRenderer.saveSnapshot();
        this.gridRenderer.gridEvents.push({
            tick,
            note,
            velocity: this.defaultVelocity,
            duration: 120,
            channel: this.channel
        });
        this.gridRenderer.gridEvents.sort((a, b) => a.tick - b.tick);
        this.gridRenderer._updateVisibleNotes();
        this.gridRenderer.redraw();
        this._syncToMidi();

        // Play preview sound (skip if note is muted)
        if (!this.gridRenderer.mutedNotes.has(note)) {
            this.modal.playNoteFeedback(note, this.defaultVelocity, this.channel);
        }
    }

    _handleGridEditVelocity(e) {
        const { index, event } = e.detail;
        if (!this.gridRenderer || !event) return;

        // Position the inline input near the hit on the canvas
        const hit = this.gridRenderer.gridEvents[index];
        if (!hit) return;

        const canvasRect = this.gridCanvasEl.getBoundingClientRect();
        const x = this.gridRenderer._tickToX(hit.tick);
        const rowIndex = this.gridRenderer.visibleNotes.indexOf(hit.note);
        const y = rowIndex >= 0 ? this.gridRenderer._rowToY(rowIndex) : 0;

        this._showVelocityInput(index, canvasRect.left + x + window.scrollX, canvasRect.top + y + window.scrollY);
    }

    _showVelocityInput(hitIndex, x, y) {
        // Remove any existing velocity input
        const existing = this.containerEl?.querySelector('.drum-velocity-overlay');
        if (existing) existing.remove();

        const hit = this.gridRenderer?.gridEvents[hitIndex];
        if (!hit) return;

        const currentVel = hit.velocity || 100;

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'drum-velocity-overlay';
        input.min = 1;
        input.max = 127;
        input.value = currentVel;
        input.style.position = 'absolute';
        input.style.left = `${x - 20}px`;
        input.style.top = `${y - 2}px`;
        input.style.width = '46px';
        input.style.height = '22px';
        input.style.fontSize = '11px';
        input.style.textAlign = 'center';
        input.style.zIndex = '9999';
        input.style.border = '1px solid #667eea';
        input.style.borderRadius = '3px';
        input.style.padding = '1px 2px';
        input.style.outline = 'none';
        input.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';

        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            const newVel = Math.max(1, Math.min(127, parseInt(input.value, 10) || currentVel));
            if (newVel !== currentVel) {
                this.gridRenderer.saveSnapshot();
                this.gridRenderer.gridEvents[hitIndex].velocity = newVel;
                this.gridRenderer.redraw();
                this._syncToMidi();
            }
            input.remove();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { committed = true; input.remove(); }
            e.stopPropagation(); // Prevent drum editor shortcuts while typing
        });
        input.addEventListener('blur', commit);

        document.body.appendChild(input);
        input.focus();
        input.select();
    }

    _handleGridSelection(_e) {
        // Selection changed — could update status bar or preview
    }

    _handleGridLabelClick(e) {
        const { note, muted } = e.detail;
        // Play note preview when unmuting
        if (!muted) {
            this.modal.playNoteFeedback(note, 100, this.channel);
        }
    }

    _handleGridPlayRow(e) {
        if (!this.modal.keyboardPlaybackEnabled) return;
        const { note } = e.detail;
        this.modal.playNoteFeedback(note, 100, this.channel);
    }

    _handleKeyDown(e) {
        if (!this.isVisible) return;

        // Check if focus is inside our panel or on document
        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'z':
                    if (e.shiftKey) {
                        // Ctrl+Shift+Z = Redo
                        e.preventDefault();
                        if (this.gridRenderer?.redo()) this._syncToMidi();
                    } else {
                        // Ctrl+Z = Undo
                        e.preventDefault();
                        if (this.gridRenderer?.undo()) this._syncToMidi();
                    }
                    return;
                case 'y':
                    e.preventDefault();
                    if (this.gridRenderer?.redo()) this._syncToMidi();
                    return;
                case 'c':
                    e.preventDefault();
                    this.gridRenderer?.copySelected();
                    return;
                case 'v':
                    e.preventDefault();
                    if (this.gridRenderer?.hasClipboard()) {
                        this.gridRenderer.paste(this.gridRenderer.playheadTick || 0);
                        this._syncToMidi();
                    }
                    return;
                case 'a':
                    e.preventDefault();
                    this.gridRenderer?.selectAll();
                    return;
            }
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (this.gridRenderer?.deleteSelected() > 0) {
                this._syncToMidi();
            }
        }
    }

    // ========================================================================
    // RESIZE
    // ========================================================================

    handleResize() {
        if (!this.isVisible) return;

        if (this.gridCanvasEl) {
            const wrapper = this.gridCanvasEl.parentElement;
            if (wrapper && wrapper.clientWidth > 0 && wrapper.clientHeight > 0) {
                this.gridCanvasEl.width = wrapper.clientWidth;
                this.gridCanvasEl.height = wrapper.clientHeight;
                if (this.gridRenderer) this.gridRenderer.redraw();
            }
        }
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        if (this.gridRenderer) {
            this.gridRenderer.updateTheme();
            this.gridRenderer.redraw();
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DrumPatternEditor;
}
if (typeof window !== 'undefined') {
    window.DrumPatternEditor = DrumPatternEditor;
}
