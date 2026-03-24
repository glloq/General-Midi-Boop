// ============================================================================
// Fichier: public/js/views/components/TablatureRenderer.js
// Description: Canvas-based tablature rendering engine
//   Renders classic tablature: horizontal lines = strings, numbers = frets
//   Supports scrolling, zoom, playhead, selection, and theme awareness
// ============================================================================

class TablatureRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Instrument config (tuning array length is authoritative for string count)
        this.tuning = options.tuning || [40, 45, 50, 55, 59, 64];
        this.numStrings = this.tuning.length;
        this.numFrets = options.numFrets || 24;
        this.isFretless = options.isFretless || false;
        this.capoFret = options.capoFret || 0;

        // Layout constants
        this.lineSpacing = 20;        // Pixels between string lines
        this.headerWidth = 40;        // Left margin for string labels
        this.topMargin = 10;
        this.bottomMargin = 10;
        this.ticksPerPixel = 2;       // Horizontal zoom (lower = more zoomed in)
        this.scrollX = 0;             // Horizontal scroll offset in ticks

        // Tablature data: array of { tick, string, fret, velocity, duration, midiNote, channel, selected }
        this.tabEvents = [];

        // Selection
        this.selectedEvents = new Set();  // Set of event indices
        this.selectionRect = null;        // { x1, y1, x2, y2 } in canvas coords during drag

        // Playback
        this.playheadTick = 0;
        this.isPlaying = false;

        // Measure lines
        this.ticksPerBeat = 480;
        this.beatsPerMeasure = 4;

        // Colors (updated by updateTheme)
        this.colors = {};
        this.updateTheme();

        // String labels (from highest to lowest, top to bottom)
        this.stringLabels = this._computeStringLabels();

        // Edit mode (set by TablatureEditor toolbar)
        this._editMode = 'pan'; // 'select' | 'pan' | 'change-string'

        // Interaction state
        this._isDragging = false;
        this._dragStart = null;
        this._hoverEvent = null;
        this._dragMode = null;    // 'select' | 'move' | 'pan'
        this._moveStartTick = 0;  // Tick position at drag start for note moving
        this._moveStartString = 0;

        // Undo/redo (snapshot-based, same pattern as piano roll)
        this._undoStack = [];
        this._redoStack = [];
        this._maxUndoSize = 20;

        // RAF-throttled rendering
        this._redrawScheduled = false;

        // Clipboard
        this._clipboard = [];

        // Bind event handlers
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onDblClick = this._handleDblClick.bind(this);
        this._onWheel = this._handleWheel.bind(this);

        this._onContextMenu = (e) => { if (e.button === 1) e.preventDefault(); };
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        this.canvas.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('dblclick', this._onDblClick);
        this.canvas.addEventListener('auxclick', this._onContextMenu);
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');
        const isColored = document.body.classList.contains('theme-colored');
        if (isColored) {
            this.colors = {
                background: '#f0f4ff',
                stringLine: '#b0b8e8',
                stringLabel: '#5a6089',
                fretNumber: '#2d3561',
                fretNumberSelected: '#ffffff',
                fretNumberBg: 'transparent',
                fretNumberSelectedBg: '#667eea',
                measureLine: '#d4daff',
                beatLine: '#e8eeff',
                playhead: '#ef476f',
                hoverHighlight: 'rgba(102,126,234,0.15)',
                selectionRect: 'rgba(102,126,234,0.3)',
                unplayable: '#ef476f',
            };
        } else if (isDark) {
            this.colors = {
                background: '#1a1a2e',
                stringLine: '#4a5568',
                stringLabel: '#a0aec0',
                fretNumber: '#e0e0e0',
                fretNumberSelected: '#ffffff',
                fretNumberBg: 'transparent',
                fretNumberSelectedBg: '#667eea',
                measureLine: '#2d3748',
                beatLine: '#1f2937',
                playhead: '#ff4444',
                hoverHighlight: 'rgba(102,126,234,0.2)',
                selectionRect: 'rgba(102,126,234,0.3)',
                unplayable: '#ff6666',
            };
        } else {
            this.colors = {
                background: '#ffffff',
                stringLine: '#999999',
                stringLabel: '#666666',
                fretNumber: '#222222',
                fretNumberSelected: '#ffffff',
                fretNumberBg: 'transparent',
                fretNumberSelectedBg: '#667eea',
                measureLine: '#e0e0e0',
                beatLine: '#f0f0f0',
                playhead: '#ff4444',
                hoverHighlight: 'rgba(102,126,234,0.1)',
                selectionRect: 'rgba(102,126,234,0.3)',
                unplayable: '#cc0000',
            };
        }
    }

    // ========================================================================
    // DATA
    // ========================================================================

    setTabEvents(events) {
        this.tabEvents = events || [];
        this.requestRedraw();
    }

    setInstrumentConfig(config) {
        this.tuning = config.tuning || [40, 45, 50, 55, 59, 64];
        this.numStrings = this.tuning.length;
        this.numFrets = config.num_frets || config.numFrets || 24;
        this.isFretless = config.is_fretless || config.isFretless || false;
        this.stringLabels = this._computeStringLabels();
        this.requestRedraw();
    }

    setScrollX(tickOffset) {
        this.scrollX = Math.max(0, tickOffset);
        this.requestRedraw();
    }

    setZoom(ticksPerPixel) {
        this.ticksPerPixel = Math.max(0.5, Math.min(20, ticksPerPixel));
        this.requestRedraw();
    }

    setPlayhead(tick) {
        this.playheadTick = tick;
        this.requestRedraw();
    }

    setTimeSignature(ticksPerBeat, beatsPerMeasure) {
        this.ticksPerBeat = ticksPerBeat || 480;
        this.beatsPerMeasure = beatsPerMeasure || 4;
        this.requestRedraw();
    }

    setEditMode(mode) {
        this._editMode = mode || 'select';
    }

    // ========================================================================
    // SELECTION
    // ========================================================================

    selectEvent(index) {
        this.selectedEvents.add(index);
        this.requestRedraw();
    }

    deselectEvent(index) {
        this.selectedEvents.delete(index);
        this.requestRedraw();
    }

    clearSelection() {
        this.selectedEvents.clear();
        this.requestRedraw();
    }

    selectAll() {
        for (let i = 0; i < this.tabEvents.length; i++) {
            this.selectedEvents.add(i);
        }
        this.requestRedraw();
    }

    getSelectedEvents() {
        return Array.from(this.selectedEvents).map(i => this.tabEvents[i]).filter(Boolean);
    }

    getSelectedIndices() {
        return Array.from(this.selectedEvents);
    }

    deleteSelected() {
        if (this.selectedEvents.size === 0) return 0;
        this.saveSnapshot();
        const indices = Array.from(this.selectedEvents).sort((a, b) => b - a);
        for (const i of indices) {
            this.tabEvents.splice(i, 1);
        }
        this.selectedEvents.clear();
        this.requestRedraw();
        return indices.length;
    }

    // ========================================================================
    // UNDO / REDO (snapshot-based)
    // ========================================================================

    saveSnapshot() {
        const snapshot = this.tabEvents.map(e => ({ ...e }));
        this._undoStack.push(snapshot);
        this._redoStack = [];
        if (this._undoStack.length > this._maxUndoSize) {
            this._undoStack.shift();
        }
    }

    undo() {
        if (this._undoStack.length === 0) return false;
        this._redoStack.push(this.tabEvents.map(e => ({ ...e })));
        this.tabEvents = this._undoStack.pop().map(e => ({ ...e }));
        this.selectedEvents.clear();
        this.requestRedraw();
        return true;
    }

    redo() {
        if (this._redoStack.length === 0) return false;
        this._undoStack.push(this.tabEvents.map(e => ({ ...e })));
        this.tabEvents = this._redoStack.pop().map(e => ({ ...e }));
        this.selectedEvents.clear();
        this.requestRedraw();
        return true;
    }

    canUndo() { return this._undoStack.length > 0; }
    canRedo() { return this._redoStack.length > 0; }

    // ========================================================================
    // CLIPBOARD
    // ========================================================================

    copySelected() {
        if (this.selectedEvents.size === 0) return 0;
        const selected = this.getSelectedEvents();
        if (selected.length === 0) return 0;
        const minTick = Math.min(...selected.map(e => e.tick));
        this._clipboard = selected.map(e => ({ ...e, tick: e.tick - minTick }));
        return this._clipboard.length;
    }

    paste(atTick) {
        if (this._clipboard.length === 0) return 0;
        this.saveSnapshot();
        this.selectedEvents.clear();
        const baseIndex = this.tabEvents.length;
        for (const evt of this._clipboard) {
            this.tabEvents.push({ ...evt, tick: evt.tick + atTick });
        }
        this.tabEvents.sort((a, b) => a.tick - b.tick);
        // Select pasted events (find them by reference after sort)
        for (let i = 0; i < this.tabEvents.length; i++) {
            if (this.tabEvents[i].tick >= atTick) {
                // Check if this is one of our pasted events
                for (const clipEvt of this._clipboard) {
                    if (this.tabEvents[i].tick === clipEvt.tick + atTick &&
                        this.tabEvents[i].string === clipEvt.string &&
                        this.tabEvents[i].fret === clipEvt.fret) {
                        this.selectedEvents.add(i);
                        break;
                    }
                }
            }
        }
        this.requestRedraw();
        return this._clipboard.length;
    }

    hasClipboard() { return this._clipboard.length > 0; }

    // ========================================================================
    // RENDERING
    // ========================================================================

    /** Schedule a redraw on the next animation frame (coalesced). */
    requestRedraw() {
        if (!this._redrawScheduled) {
            this._redrawScheduled = true;
            requestAnimationFrame(() => {
                this._redrawScheduled = false;
                this.redraw();
            });
        }
    }

    redraw() {
        const { canvas, ctx } = this;
        const w = canvas.width;
        const h = canvas.height;

        // Clear
        ctx.fillStyle = this.colors.background;
        ctx.fillRect(0, 0, w, h);

        // Draw grid (measure/beat lines)
        this._drawGrid(w, h);

        // Draw string lines
        this._drawStringLines(w, h);

        // Draw tab events (fret numbers on strings)
        this._drawTabEvents(w, h);

        // Draw selection rectangle if dragging
        if (this.selectionRect) {
            this._drawSelectionRect();
        }

        // Draw playhead
        this._drawPlayhead(w, h);
    }

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.requestRedraw();
    }

    // ========================================================================
    // DRAWING HELPERS
    // ========================================================================

    _drawGrid(w, h) {
        const ctx = this.ctx;
        const ticksPerMeasure = this.ticksPerBeat * this.beatsPerMeasure;
        const startTick = this.scrollX;
        const endTick = startTick + (w - this.headerWidth) * this.ticksPerPixel;

        // Beat lines
        const firstBeat = Math.floor(startTick / this.ticksPerBeat) * this.ticksPerBeat;
        ctx.strokeStyle = this.colors.beatLine;
        ctx.lineWidth = 0.5;
        for (let tick = firstBeat; tick <= endTick; tick += this.ticksPerBeat) {
            const x = this._tickToX(tick);
            if (x < this.headerWidth) continue;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }

        // Measure lines (thicker)
        const firstMeasure = Math.floor(startTick / ticksPerMeasure) * ticksPerMeasure;
        ctx.strokeStyle = this.colors.measureLine;
        ctx.lineWidth = 1;
        for (let tick = firstMeasure; tick <= endTick; tick += ticksPerMeasure) {
            const x = this._tickToX(tick);
            if (x < this.headerWidth) continue;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();

            // Measure number
            const measureNum = Math.round(tick / ticksPerMeasure) + 1;
            ctx.fillStyle = this.colors.stringLabel;
            ctx.font = '9px monospace';
            ctx.fillText(measureNum.toString(), x + 2, 9);
        }
    }

    _drawStringLines(w, h) {
        const ctx = this.ctx;

        for (let s = 0; s < this.numStrings; s++) {
            const y = this._stringToY(s);

            // String line
            ctx.strokeStyle = this.colors.stringLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(this.headerWidth, y);
            ctx.lineTo(w, y);
            ctx.stroke();

            // String label (on the left)
            ctx.fillStyle = this.colors.stringLabel;
            ctx.font = 'bold 12px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(this.stringLabels[s], this.headerWidth / 2, y);
        }

        ctx.textAlign = 'left'; // Reset
    }

    _drawTabEvents(w, h) {
        const ctx = this.ctx;
        const startTick = this.scrollX;
        const endTick = startTick + (w - this.headerWidth) * this.ticksPerPixel;

        for (let i = 0; i < this.tabEvents.length; i++) {
            const event = this.tabEvents[i];
            if (event.tick + (event.duration || 0) < startTick || event.tick > endTick) continue;

            const x = this._tickToX(event.tick);
            if (x < this.headerWidth - 5) continue;

            // String index: display is reversed (highest string = top = index 0)
            const displayIndex = this.numStrings - event.string;
            if (displayIndex < 0 || displayIndex >= this.numStrings) continue;

            const y = this._stringToY(displayIndex);
            const isSelected = this.selectedEvents.has(i);
            const isHovered = this._hoverEvent === i && !isSelected;
            const isUnplayable = !this.isFretless && (event.fret < 0 || event.fret > this.numFrets);
            const fretText = event.fret.toString();

            // Measure text width for background
            ctx.font = 'bold 13px monospace';
            const textWidth = ctx.measureText(fretText).width;
            const padding = 3;

            // Hover highlight (drawn behind the note)
            if (isHovered) {
                ctx.fillStyle = this.colors.hoverHighlight;
                ctx.fillRect(x - textWidth / 2 - padding - 2, y - 10,
                    textWidth + (padding + 2) * 2, 20);
            }

            // Background rectangle
            if (isSelected) {
                ctx.fillStyle = this.colors.fretNumberSelectedBg;
            } else if (isUnplayable) {
                ctx.fillStyle = this.colors.unplayable;
            } else {
                ctx.fillStyle = this.colors.background;
            }
            ctx.fillRect(x - textWidth / 2 - padding, y - 8, textWidth + padding * 2, 16);

            // Fret number text
            if (isUnplayable && !isSelected) {
                ctx.fillStyle = '#ffffff';
            } else {
                ctx.fillStyle = isSelected ? this.colors.fretNumberSelected : this.colors.fretNumber;
            }
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(fretText, x, y);

            // Duration line (subtle)
            if (event.duration && event.duration > 0) {
                const endX = this._tickToX(event.tick + event.duration);
                const lineEndX = Math.min(endX, w);
                if (lineEndX > x + textWidth / 2 + padding) {
                    ctx.strokeStyle = isSelected ? this.colors.fretNumberSelectedBg : this.colors.stringLine;
                    ctx.lineWidth = 2;
                    ctx.globalAlpha = 0.4;
                    ctx.beginPath();
                    ctx.moveTo(x + textWidth / 2 + padding, y);
                    ctx.lineTo(lineEndX, y);
                    ctx.stroke();
                    ctx.globalAlpha = 1.0;
                }
            }
        }

        ctx.textAlign = 'left'; // Reset
    }

    _drawPlayhead(w, h) {
        if (this.playheadTick < this.scrollX) return;

        const x = this._tickToX(this.playheadTick);
        if (x < this.headerWidth || x > w) return;

        const ctx = this.ctx;
        ctx.strokeStyle = this.colors.playhead;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        // Triangle marker at top
        ctx.fillStyle = this.colors.playhead;
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 7);
        ctx.closePath();
        ctx.fill();
    }

    _drawSelectionRect() {
        const ctx = this.ctx;
        const r = this.selectionRect;
        const x = Math.min(r.x1, r.x2);
        const y = Math.min(r.y1, r.y2);
        const w = Math.abs(r.x2 - r.x1);
        const h = Math.abs(r.y2 - r.y1);

        ctx.fillStyle = this.colors.selectionRect;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = this.colors.fretNumberSelectedBg;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
    }

    // ========================================================================
    // COORDINATE CONVERSION
    // ========================================================================

    _tickToX(tick) {
        return this.headerWidth + (tick - this.scrollX) / this.ticksPerPixel;
    }

    _xToTick(x) {
        return Math.round((x - this.headerWidth) * this.ticksPerPixel + this.scrollX);
    }

    _stringToY(displayIndex) {
        return this.topMargin + displayIndex * this.lineSpacing + this.lineSpacing;
    }

    _yToString(y) {
        // Returns 1-based string number (1 = highest pitch = top line)
        const displayIndex = Math.round((y - this.topMargin - this.lineSpacing) / this.lineSpacing);
        if (displayIndex < 0 || displayIndex >= this.numStrings) return -1;
        return this.numStrings - displayIndex; // Convert display to string number (1-based, high to low)
    }

    /**
     * Get the required canvas height based on number of strings
     */
    getRequiredHeight() {
        return this.topMargin + this.bottomMargin + (this.numStrings + 1) * this.lineSpacing;
    }

    /**
     * Get max tick from events
     */
    getMaxTick() {
        if (this.tabEvents.length === 0) return 0;
        return Math.max(...this.tabEvents.map(e => e.tick + (e.duration || 0)));
    }

    // ========================================================================
    // HIT TESTING
    // ========================================================================

    /**
     * Find event at canvas coordinates
     * @returns {number} Event index, or -1 if none
     */
    _hitTest(canvasX, canvasY) {
        const tick = this._xToTick(canvasX);
        const string = this._yToString(canvasY);
        if (string < 1) return -1;

        const hitRadius = 8 * this.ticksPerPixel; // Pixel tolerance converted to ticks

        for (let i = 0; i < this.tabEvents.length; i++) {
            const evt = this.tabEvents[i];
            if (evt.string === string && Math.abs(evt.tick - tick) < hitRadius) {
                return i;
            }
        }
        return -1;
    }

    // ========================================================================
    // MOUSE INTERACTION
    // ========================================================================

    _handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Alt+click or middle button or pan mode = pan
        if (e.altKey || e.button === 1 || this._editMode === 'pan') {
            this._isDragging = true;
            this._dragMode = 'pan';
            this._dragStart = { x, y, scrollX: this.scrollX };
            e.preventDefault();
            return;
        }

        const hitIndex = this._hitTest(x, y);

        // Change-string mode
        if (this._editMode === 'change-string') {
            const clickedString = this._yToString(y);
            if (clickedString < 1 || clickedString > this.numStrings) return;

            if (hitIndex >= 0) {
                // Clicked directly on a note — select it for subsequent Up/Down
                if (!e.ctrlKey && !e.metaKey) {
                    this.selectedEvents.clear();
                }
                this.selectedEvents.add(hitIndex);
                this.requestRedraw();
                this._emitEvent('selectionchange', { selected: this.getSelectedIndices() });
            } else if (this.selectedEvents.size > 0) {
                // Clicked on empty string line — move selected notes to that string
                this._emitEvent('changestring', { targetString: clickedString });
            }
            return;
        }

        if (hitIndex >= 0) {
            // Clicked on an event
            if (e.ctrlKey || e.metaKey) {
                // Toggle selection
                if (this.selectedEvents.has(hitIndex)) {
                    this.selectedEvents.delete(hitIndex);
                } else {
                    this.selectedEvents.add(hitIndex);
                }
            } else if (!this.selectedEvents.has(hitIndex)) {
                // Select only this event
                this.selectedEvents.clear();
                this.selectedEvents.add(hitIndex);
            }

            // If clicked on a selected event, start drag-to-move
            if (this.selectedEvents.has(hitIndex) && this.selectedEvents.size > 0) {
                this._isDragging = true;
                this._dragMode = 'move';
                this._dragStart = { x, y };
                this._moveStartTick = this._xToTick(x);
                this._moveStartString = this._yToString(y);
            }

            this.requestRedraw();
            this._emitEvent('selectionchange', { selected: this.getSelectedIndices() });
        } else {
            // Start selection rectangle
            if (!e.ctrlKey && !e.metaKey) {
                this.selectedEvents.clear();
            }
            this._isDragging = true;
            this._dragMode = 'select';
            this._dragStart = { x, y };
            this.selectionRect = { x1: x, y1: y, x2: x, y2: y };
            this.requestRedraw();
        }
    }

    _handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this._isDragging) {
            if (this._dragMode === 'select' && this.selectionRect) {
                this.selectionRect.x2 = x;
                this.selectionRect.y2 = y;
                this.requestRedraw();
            } else if (this._dragMode === 'pan') {
                const dx = (x - this._dragStart.x) * this.ticksPerPixel;
                this.scrollX = Math.max(0, this._dragStart.scrollX - dx);
                this.requestRedraw();
            }
            // For 'move' mode, visual feedback is deferred to mouseup (snap to grid)
            return;
        }

        // Hover tracking (no drag)
        const hitIndex = this._hitTest(x, y);
        if (hitIndex !== this._hoverEvent) {
            this._hoverEvent = hitIndex >= 0 ? hitIndex : null;
            this.requestRedraw();
        }
    }

    _handleMouseUp(e) {
        if (this._isDragging) {
            if (this._dragMode === 'select' && this.selectionRect) {
                const r = this.selectionRect;
                const minX = Math.min(r.x1, r.x2);
                const maxX = Math.max(r.x1, r.x2);
                const minY = Math.min(r.y1, r.y2);
                const maxY = Math.max(r.y1, r.y2);

                for (let i = 0; i < this.tabEvents.length; i++) {
                    const evt = this.tabEvents[i];
                    const displayIndex = this.numStrings - evt.string;
                    const evtX = this._tickToX(evt.tick);
                    const evtY = this._stringToY(displayIndex);

                    if (evtX >= minX && evtX <= maxX && evtY >= minY && evtY <= maxY) {
                        this.selectedEvents.add(i);
                    }
                }
                this._emitEvent('selectionchange', { selected: this.getSelectedIndices() });

            } else if (this._dragMode === 'move') {
                const rect = this.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const currentTick = this._xToTick(x);
                const currentString = this._yToString(y);
                const deltaTick = currentTick - this._moveStartTick;
                const deltaString = (currentString > 0 ? currentString : this._moveStartString) - this._moveStartString;

                if (deltaTick !== 0 || deltaString !== 0) {
                    this.saveSnapshot();
                    const indices = this.getSelectedIndices();
                    for (const i of indices) {
                        const evt = this.tabEvents[i];
                        evt.tick = Math.max(0, evt.tick + deltaTick);
                        if (deltaString !== 0) {
                            const newString = evt.string + deltaString;
                            if (newString >= 1 && newString <= this.numStrings) {
                                // Recalculate fret to preserve the same MIDI note (account for capo)
                                if (evt.midiNote !== undefined && this.tuning) {
                                    const newOpenNote = this.tuning[newString - 1] + this.capoFret;
                                    const newFret = evt.midiNote - newOpenNote;
                                    const maxFret = this.isFretless ? 48 : (this.numFrets || 24);
                                    if (newFret >= 0 && newFret <= maxFret) {
                                        evt.string = newString;
                                        evt.fret = newFret;
                                    }
                                    // else: note can't be played on that string, skip
                                } else {
                                    evt.string = newString;
                                }
                            }
                        }
                    }
                    this.tabEvents.sort((a, b) => a.tick - b.tick);
                    // Rebuild selection indices after sort
                    this._rebuildSelectionAfterSort(indices);
                    this._emitEvent('moveevents', { deltaTick, deltaString });
                }
            }
        }

        this._isDragging = false;
        this._dragMode = null;
        this._dragStart = null;
        this.selectionRect = null;
        this.requestRedraw();
    }

    /**
     * After sorting, selected event indices may have changed.
     * Re-find them by object identity isn't possible after sort,
     * so we tag events before sort and re-find them.
     */
    _rebuildSelectionAfterSort(oldIndices) {
        // Tag selected events before sort
        const tagged = new Set();
        for (const i of oldIndices) {
            if (this.tabEvents[i]) {
                this.tabEvents[i]._selected = true;
                tagged.add(i);
            }
        }
        this.selectedEvents.clear();
        for (let i = 0; i < this.tabEvents.length; i++) {
            if (this.tabEvents[i]._selected) {
                this.selectedEvents.add(i);
                delete this.tabEvents[i]._selected;
            }
        }
    }

    // ========================================================================
    // WHEEL SCROLL
    // ========================================================================

    _handleWheel(e) {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            // Zoom
            const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;
            this.ticksPerPixel = Math.max(0.5, Math.min(20, this.ticksPerPixel * zoomFactor));
        } else if (e.shiftKey) {
            // Horizontal scroll
            this.scrollX = Math.max(0, this.scrollX + e.deltaY * this.ticksPerPixel);
        } else {
            // Default: horizontal scroll (tablature is primarily horizontal)
            this.scrollX = Math.max(0, this.scrollX + e.deltaY * this.ticksPerPixel);
        }

        this.requestRedraw();
    }

    _handleDblClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hitIndex = this._hitTest(x, y);

        if (hitIndex >= 0) {
            // Double click on existing event → edit fret
            this._emitEvent('editevent', { index: hitIndex, event: this.tabEvents[hitIndex] });
        } else {
            // Double click on empty space → add new event
            const tick = this._xToTick(x);
            const string = this._yToString(y);
            if (string >= 1 && string <= this.numStrings && tick >= 0) {
                this._emitEvent('addevent', { tick, string });
            }
        }
    }

    // ========================================================================
    // EVENT EMITTER
    // ========================================================================

    _emitEvent(type, detail) {
        this.canvas.dispatchEvent(new CustomEvent(`tab:${type}`, { detail, bubbles: true }));
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    _computeStringLabels() {
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        // Display top to bottom = highest to lowest string (with capo offset)
        const labels = [];
        for (let i = this.numStrings - 1; i >= 0; i--) {
            const midiNote = this.tuning[i] + this.capoFret;
            if (midiNote !== undefined) {
                const name = noteNames[midiNote % 12];
                const octave = Math.floor(midiNote / 12) - 1;
                labels.push(`${name}${octave}`);
            } else {
                labels.push(`${i + 1}`);
            }
        }
        return labels;
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        this.canvas.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('dblclick', this._onDblClick);
        this.canvas.removeEventListener('auxclick', this._onContextMenu);
        this.canvas.removeEventListener('wheel', this._onWheel);
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TablatureRenderer;
}
if (typeof window !== 'undefined') {
    window.TablatureRenderer = TablatureRenderer;
}
