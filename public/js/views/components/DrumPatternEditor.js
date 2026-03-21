// ============================================================================
// Fichier: public/js/views/components/DrumPatternEditor.js
// Description: Main drum pattern editor component
//   Orchestrates DrumGridRenderer + DrumKitDiagram
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
        this.kitDiagram = null;        // DrumKitDiagram instance

        // DOM references
        this.containerEl = null;
        this.gridCanvasEl = null;
        this.kitCanvasEl = null;

        // Default velocity for new hits
        this.defaultVelocity = 100;

        // Quantize resolution in subdivisions per beat
        this.quantizeDiv = 4; // 16th notes

        // Bind methods
        this._onGridAdd = this._handleGridAdd.bind(this);
        this._onGridEditVelocity = this._handleGridEditVelocity.bind(this);
        this._onGridSelection = this._handleGridSelection.bind(this);
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
        this._initKitDiagram();

        // Convert MIDI notes to grid events
        this.loadFromMidi(midiNotes);

        this._detachCanvasEvents();
        this._attachCanvasEvents();

        // Resize after layout settles
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
        this._setPianoRollVisible(true);
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
        if (this.kitDiagram) {
            this.kitDiagram.destroy();
            this.kitDiagram = null;
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
                    <span class="drum-pattern-icon">DRUM</span>
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
                        vel
                        <input type="number" class="drum-velocity-input" id="drum-velocity-input"
                            min="1" max="127" value="${this.defaultVelocity}" />
                    </label>
                </div>
                <div class="drum-pattern-toolbar">
                    <button class="drum-tool-btn" data-action="drum-undo" title="${this.t('midiEditor.undo')} (Ctrl+Z)">&#8630;</button>
                    <button class="drum-tool-btn" data-action="drum-redo" title="${this.t('midiEditor.redo')} (Ctrl+Y)">&#8631;</button>
                    <button class="drum-tool-btn" data-action="drum-copy" title="${this.t('midiEditor.copy')} (Ctrl+C)">CPY</button>
                    <button class="drum-tool-btn" data-action="drum-paste" title="${this.t('midiEditor.paste')} (Ctrl+V)">PST</button>
                    <span class="drum-separator"></span>
                    <button class="drum-tool-btn" data-action="drum-zoom-in" title="${this.t('drumPattern.zoomIn')}">+</button>
                    <button class="drum-tool-btn" data-action="drum-zoom-out" title="${this.t('drumPattern.zoomOut')}">-</button>
                    <button class="drum-tool-btn" data-action="drum-delete" title="${this.t('drumPattern.deleteSelected')}">DEL</button>
                    <button class="drum-tool-btn" data-action="drum-select-all" title="${this.t('drumPattern.selectAll')}">ALL</button>
                    <button class="drum-tool-btn drum-close-btn" data-action="drum-close" title="${this.t('common.close')}">&times;</button>
                </div>
            </div>
            <div class="drum-pattern-body">
                <div class="drum-grid-canvas-wrapper">
                    <canvas id="drum-grid-canvas" class="drum-grid-canvas"></canvas>
                </div>
                <div class="drum-kit-diagram-wrapper">
                    <canvas id="drum-kit-canvas" class="drum-kit-canvas"></canvas>
                </div>
            </div>
        `;

        const notesSection = this.modal.container?.querySelector('.notes-section');
        if (notesSection) {
            notesSection.appendChild(this.containerEl);
        }

        this.gridCanvasEl = this.containerEl.querySelector('#drum-grid-canvas');
        this.kitCanvasEl = this.containerEl.querySelector('#drum-kit-canvas');

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

            switch (action) {
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

    // ========================================================================
    // RENDERER INIT
    // ========================================================================

    _initGridRenderer() {
        if (!this.gridCanvasEl) return;

        const wrapper = this.gridCanvasEl.parentElement;
        this.gridCanvasEl.width = wrapper.clientWidth || 800;
        this.gridCanvasEl.height = wrapper.clientHeight || 400;

        if (this.gridRenderer) {
            this.gridRenderer.destroy();
        }

        this.gridRenderer = new DrumGridRenderer(this.gridCanvasEl);

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
    }

    _initKitDiagram() {
        if (!this.kitCanvasEl) return;

        const wrapper = this.kitCanvasEl.parentElement;
        this.kitCanvasEl.width = wrapper.clientWidth || 180;
        this.kitCanvasEl.height = wrapper.clientHeight || 300;

        if (this.kitDiagram) {
            this.kitDiagram.destroy();
        }

        this.kitDiagram = new DrumKitDiagram(this.kitCanvasEl);
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

        // Update kit diagram with currently sounding notes
        if (this.kitDiagram) {
            const activeNotes = this._getNotesAtTick(tick);
            this.kitDiagram.setActiveNotes(activeNotes);
        }
    }

    /**
     * Get notes sounding at a given tick (within a small window)
     * @private
     */
    _getNotesAtTick(tick) {
        const window = 60; // ~1/8 beat lookahead for visual responsiveness
        const notes = [];
        for (const evt of this.gridEvents) {
            if (evt.tick >= tick - window && evt.tick <= tick + window) {
                notes.push({ note: evt.note, velocity: evt.velocity });
            }
        }
        return notes;
    }

    // ========================================================================
    // CANVAS EVENTS
    // ========================================================================

    _attachCanvasEvents() {
        if (this.gridCanvasEl) {
            this.gridCanvasEl.addEventListener('drum:addhit', this._onGridAdd);
            this.gridCanvasEl.addEventListener('drum:editvelocity', this._onGridEditVelocity);
            this.gridCanvasEl.addEventListener('drum:selectionchange', this._onGridSelection);
        }
        document.addEventListener('keydown', this._onKeyDown);
    }

    _detachCanvasEvents() {
        if (this.gridCanvasEl) {
            this.gridCanvasEl.removeEventListener('drum:addhit', this._onGridAdd);
            this.gridCanvasEl.removeEventListener('drum:editvelocity', this._onGridEditVelocity);
            this.gridCanvasEl.removeEventListener('drum:selectionchange', this._onGridSelection);
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
    }

    _handleGridEditVelocity(e) {
        const { index, event } = e.detail;
        if (!this.gridRenderer || !event) return;

        // Prompt for velocity via inline input
        const currentVel = event.velocity || 100;
        const input = prompt(this.t('drumPattern.enterVelocity'), currentVel.toString());
        if (input === null) return;

        const newVel = Math.max(1, Math.min(127, parseInt(input, 10) || currentVel));
        if (newVel !== currentVel) {
            this.gridRenderer.saveSnapshot();
            this.gridRenderer.gridEvents[index].velocity = newVel;
            this.gridRenderer.redraw();
            this._syncToMidi();
        }
    }

    _handleGridSelection(e) {
        // Selection changed — could update status bar or preview
    }

    _handleKeyDown(e) {
        if (!this.isVisible) return;

        // Check if focus is inside our panel or on document
        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'z':
                    e.preventDefault();
                    if (this.gridRenderer?.undo()) this._syncToMidi();
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

        if (this.kitCanvasEl) {
            const wrapper = this.kitCanvasEl.parentElement;
            if (wrapper && wrapper.clientWidth > 0 && wrapper.clientHeight > 0) {
                this.kitCanvasEl.width = wrapper.clientWidth;
                this.kitCanvasEl.height = wrapper.clientHeight;
                if (this.kitDiagram) this.kitDiagram.redraw();
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
        if (this.kitDiagram) {
            this.kitDiagram.updateTheme();
            this.kitDiagram.redraw();
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
