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

        // Instrument config
        this.numStrings = options.numStrings || 6;
        this.tuning = options.tuning || [40, 45, 50, 55, 59, 64];
        this.numFrets = options.numFrets || 24;
        this.isFretless = options.isFretless || false;

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

        // Interaction state
        this._isDragging = false;
        this._dragStart = null;
        this._hoverEvent = null;

        // Bind event handlers
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onDblClick = this._handleDblClick.bind(this);

        this.canvas.addEventListener('mousedown', this._onMouseDown);
        this.canvas.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('dblclick', this._onDblClick);
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');
        this.colors = {
            background: isDark ? '#1a1a2e' : '#ffffff',
            stringLine: isDark ? '#4a5568' : '#999999',
            stringLabel: isDark ? '#a0aec0' : '#666666',
            fretNumber: isDark ? '#e0e0e0' : '#222222',
            fretNumberSelected: '#ffffff',
            fretNumberBg: 'transparent',
            fretNumberSelectedBg: '#667eea',
            measureLine: isDark ? '#2d3748' : '#e0e0e0',
            beatLine: isDark ? '#1f2937' : '#f0f0f0',
            playhead: '#ff4444',
            hoverHighlight: isDark ? 'rgba(102,126,234,0.2)' : 'rgba(102,126,234,0.1)',
            selectionRect: 'rgba(102,126,234,0.3)',
            unplayable: isDark ? '#ff6666' : '#cc0000',
        };
    }

    // ========================================================================
    // DATA
    // ========================================================================

    setTabEvents(events) {
        this.tabEvents = events || [];
        this.redraw();
    }

    setInstrumentConfig(config) {
        this.numStrings = config.num_strings || config.numStrings || 6;
        this.tuning = config.tuning || [40, 45, 50, 55, 59, 64];
        this.numFrets = config.num_frets || config.numFrets || 24;
        this.isFretless = config.is_fretless || config.isFretless || false;
        this.stringLabels = this._computeStringLabels();
        this.redraw();
    }

    setScrollX(tickOffset) {
        this.scrollX = Math.max(0, tickOffset);
        this.redraw();
    }

    setZoom(ticksPerPixel) {
        this.ticksPerPixel = Math.max(0.5, Math.min(20, ticksPerPixel));
        this.redraw();
    }

    setPlayhead(tick) {
        this.playheadTick = tick;
        this.redraw();
    }

    setTimeSignature(ticksPerBeat, beatsPerMeasure) {
        this.ticksPerBeat = ticksPerBeat || 480;
        this.beatsPerMeasure = beatsPerMeasure || 4;
        this.redraw();
    }

    // ========================================================================
    // SELECTION
    // ========================================================================

    selectEvent(index) {
        this.selectedEvents.add(index);
        this.redraw();
    }

    deselectEvent(index) {
        this.selectedEvents.delete(index);
        this.redraw();
    }

    clearSelection() {
        this.selectedEvents.clear();
        this.redraw();
    }

    selectAll() {
        for (let i = 0; i < this.tabEvents.length; i++) {
            this.selectedEvents.add(i);
        }
        this.redraw();
    }

    getSelectedEvents() {
        return Array.from(this.selectedEvents).map(i => this.tabEvents[i]).filter(Boolean);
    }

    getSelectedIndices() {
        return Array.from(this.selectedEvents);
    }

    deleteSelected() {
        const indices = Array.from(this.selectedEvents).sort((a, b) => b - a);
        for (const i of indices) {
            this.tabEvents.splice(i, 1);
        }
        this.selectedEvents.clear();
        this.redraw();
        return indices.length;
    }

    // ========================================================================
    // RENDERING
    // ========================================================================

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
        this.redraw();
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
            const fretText = this.isFretless ? event.fret.toFixed(1) : event.fret.toString();

            // Measure text width for background
            ctx.font = 'bold 13px monospace';
            const textWidth = ctx.measureText(fretText).width;
            const padding = 3;

            // Background rectangle
            if (isSelected) {
                ctx.fillStyle = this.colors.fretNumberSelectedBg;
            } else {
                ctx.fillStyle = this.colors.background;
            }
            ctx.fillRect(x - textWidth / 2 - padding, y - 8, textWidth + padding * 2, 16);

            // Fret number text
            ctx.fillStyle = isSelected ? this.colors.fretNumberSelected : this.colors.fretNumber;
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

        const hitIndex = this._hitTest(x, y);

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
            this.redraw();

            // Emit selection change
            this._emitEvent('selectionchange', { selected: this.getSelectedIndices() });
        } else {
            // Start selection rectangle
            if (!e.ctrlKey && !e.metaKey) {
                this.selectedEvents.clear();
            }
            this._isDragging = true;
            this._dragStart = { x, y };
            this.selectionRect = { x1: x, y1: y, x2: x, y2: y };
            this.redraw();
        }
    }

    _handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this._isDragging && this.selectionRect) {
            this.selectionRect.x2 = x;
            this.selectionRect.y2 = y;
            this.redraw();
        }
    }

    _handleMouseUp(e) {
        if (this._isDragging && this.selectionRect) {
            // Select all events within the rectangle
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
        }

        this._isDragging = false;
        this._dragStart = null;
        this.selectionRect = null;
        this.redraw();
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
        // Display top to bottom = highest to lowest string
        const labels = [];
        for (let i = this.numStrings - 1; i >= 0; i--) {
            const midiNote = this.tuning[i];
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
