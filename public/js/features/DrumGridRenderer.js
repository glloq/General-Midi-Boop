// ============================================================================
// Fichier: public/js/features/DrumGridRenderer.js
// Description: Step sequencer grid for drum/percussion editing
//   Rows = drum instruments (labeled by GM name)
//   Columns = time steps (beats/subdivisions)
//   Click cells to toggle hits, velocity shown via opacity
//   Supports scrolling, zoom, playhead, selection, and theme awareness
// ============================================================================

class DrumGridRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // GM drum note names (note 35-81)
        this.NOTE_NAMES = {
            35: 'Acoustic Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare',
            39: 'Hand Clap', 40: 'Electric Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat',
            43: 'High Floor Tom', 44: 'Pedal Hi-Hat', 45: 'Low Tom', 46: 'Open Hi-Hat',
            47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1', 50: 'High Tom',
            51: 'Ride Cymbal 1', 52: 'Chinese Cymbal', 53: 'Ride Bell', 54: 'Tambourine',
            55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 58: 'Vibraslap',
            59: 'Ride Cymbal 2', 60: 'Hi Bongo', 61: 'Low Bongo', 62: 'Mute Hi Conga',
            63: 'Open Hi Conga', 64: 'Low Conga', 65: 'High Timbale', 66: 'Low Timbale',
            67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas',
            71: 'Short Whistle', 72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro',
            75: 'Claves', 76: 'Hi Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica',
            79: 'Open Cuica', 80: 'Mute Triangle', 81: 'Open Triangle'
        };

        // Short labels for compact display
        this.SHORT_NAMES = {
            35: 'AcKick', 36: 'Kick', 37: 'Stick', 38: 'Snare',
            39: 'Clap', 40: 'ESnare', 41: 'LFlrTom', 42: 'ClHH',
            43: 'HFlrTom', 44: 'PdlHH', 45: 'LowTom', 46: 'OpHH',
            47: 'LMTom', 48: 'HMTom', 49: 'Crash1', 50: 'HiTom',
            51: 'Ride1', 52: 'China', 53: 'RdBell', 54: 'Tamb',
            55: 'Splash', 56: 'Cowbell', 57: 'Crash2', 58: 'Vibra',
            59: 'Ride2', 60: 'HiBong', 61: 'LoBong', 62: 'MtCnga',
            63: 'OpCnga', 64: 'LoCnga', 65: 'HiTimb', 66: 'LoTimb',
            67: 'HiAgo', 68: 'LoAgo', 69: 'Cabasa', 70: 'Maraca',
            71: 'SWhstl', 72: 'LWhstl', 73: 'SGuiro', 74: 'LGuiro',
            75: 'Claves', 76: 'HiWdBk', 77: 'LoWdBk', 78: 'MtCuic',
            79: 'OpCuic', 80: 'MtTri', 81: 'OpTri'
        };

        // Category colors for drum types
        this.CATEGORY_MAP = {
            35: 'kick', 36: 'kick',
            37: 'snare', 38: 'snare', 39: 'snare', 40: 'snare',
            41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom',
            42: 'hihat', 44: 'hihat', 46: 'hihat',
            49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash',
            51: 'ride', 53: 'ride', 59: 'ride',
            54: 'misc', 56: 'misc', 58: 'misc', 69: 'misc', 70: 'misc',
            60: 'latin', 61: 'latin', 62: 'latin', 63: 'latin', 64: 'latin',
            65: 'latin', 66: 'latin', 67: 'latin', 68: 'latin',
            71: 'misc', 72: 'misc', 73: 'misc', 74: 'misc', 75: 'misc',
            76: 'misc', 77: 'misc', 78: 'misc', 79: 'misc', 80: 'misc', 81: 'misc'
        };

        // Standard display order (most important instruments first)
        this.DEFAULT_ROW_ORDER = [
            49, 57, 55, 52,       // Crashes
            51, 59, 53,           // Rides
            42, 46, 44,           // Hi-hats
            50, 48, 47, 45,       // Toms (high to low)
            43, 41,               // Floor toms
            38, 40, 37, 39,       // Snares
            36, 35,               // Kicks
            54, 56, 70, 75,       // Misc
            60, 61, 62, 63, 64,   // Latin
            65, 66, 67, 68        // More latin
        ];

        // Layout
        this.headerWidth = 80;       // Left margin for instrument labels
        this.rowHeight = 20;         // Pixels per row
        this.topMargin = 20;         // Space for beat numbers
        this.ticksPerPixel = 2;      // Horizontal zoom
        this.scrollX = 0;            // Horizontal scroll in ticks
        this.scrollY = 0;            // Vertical scroll in pixels

        // Time signature
        this.ticksPerBeat = 480;
        this.beatsPerMeasure = 4;

        // Quantize division (subdivisions per beat): 1=1/4, 2=1/8, 3=1/8T, 4=1/16, 6=1/16T, 8=1/32
        this.quantizeDiv = 4;

        // Grid data: array of { tick, note, velocity, duration, channel, selected }
        this.gridEvents = [];

        // Visible rows: only notes that actually appear in the data
        this.visibleNotes = [];       // Sorted note numbers for rows

        // Playable notes: Set<noteNumber> or null (all playable) or undefined (not set)
        this.playableNotes = undefined;
        // Muted notes (toggled off by user click on label): Set<noteNumber>
        this.mutedNotes = new Set();

        // Selection
        this.selectedEvents = new Set();
        this.selectionRect = null;

        // Playback
        this.playheadTick = 0;

        // Interaction
        this._isDragging = false;
        this._dragStart = null;
        this._dragMode = null;
        this._hoverEvent = null;

        // Edit mode: 'pan' (default) or 'select'
        this.tool = options.tool || 'pan';

        // Undo/Redo
        this._undoStack = [];
        this._redoStack = [];
        this._maxUndoSize = 20;

        // RAF-throttled rendering
        this._redrawScheduled = false;

        // Clipboard
        this._clipboard = [];

        // Scroll change callback (notifies parent when scroll/zoom changes)
        this.onScrollChange = options.onScrollChange || null;

        // Colors
        this.colors = {};
        this.categoryColors = {};
        this.updateTheme();

        // Bind events
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onDblClick = this._handleDblClick.bind(this);
        this._onContextMenu = (e) => { if (e.button === 1) e.preventDefault(); };
        this._onWheel = this._handleWheel.bind(this);

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
        if (isDark) {
            this.colors = {
                background: '#1a1a2e',
                rowEven: '#1e2234',
                rowOdd: '#1a1a2e',
                gridLine: '#2d3748',
                measureLine: '#4a5568',
                beatLine: '#2d3748',
                headerBg: '#2d3748',
                headerText: '#a0aec0',
                beatNumber: '#718096',
                playhead: '#ff4444',
                hoverRow: 'rgba(102,126,234,0.12)',
                selectedBg: '#667eea',
                selectionRect: 'rgba(102,126,234,0.3)',
            };
            this.categoryColors = {
                kick: '#667eea', snare: '#ff4444', hihat: '#28a745',
                tom: '#ffc107', crash: '#17a2b8', ride: '#6c757d',
                latin: '#9b59b6', misc: '#6c757d'
            };
        } else {
            this.colors = {
                background: '#f0f4ff',
                rowEven: '#e8ecff',
                rowOdd: '#f0f4ff',
                gridLine: '#d4daff',
                measureLine: '#b0b8e8',
                beatLine: '#d4daff',
                headerBg: '#e0e4f8',
                headerText: '#5a6089',
                beatNumber: '#9498b8',
                playhead: '#ef476f',
                hoverRow: 'rgba(102,126,234,0.08)',
                selectedBg: '#667eea',
                selectionRect: 'rgba(102,126,234,0.3)',
            };
            this.categoryColors = {
                kick: '#667eea', snare: '#ef476f', hihat: '#06d6a0',
                tom: '#ffd166', crash: '#118ab2', ride: '#073b4c',
                latin: '#9b59b6', misc: '#8e99a4'
            };
        }
    }

    // ========================================================================
    // DATA
    // ========================================================================

    setGridEvents(events) {
        this.gridEvents = events || [];
        this._updateVisibleNotes();
        this.requestRedraw();
    }

    _updateVisibleNotes() {
        // Determine which notes are actually used
        const usedNotes = new Set();
        for (const evt of this.gridEvents) {
            usedNotes.add(evt.note);
        }

        // Use DEFAULT_ROW_ORDER for sorting, then add any notes not in the default order
        this.visibleNotes = this.DEFAULT_ROW_ORDER.filter(n => usedNotes.has(n));
        for (const n of usedNotes) {
            if (!this.visibleNotes.includes(n)) {
                this.visibleNotes.push(n);
            }
        }
    }

    setScrollX(tickOffset) {
        this.scrollX = Math.max(0, tickOffset);
        this.requestRedraw();
        this._notifyScrollChange();
    }

    setScrollY(pixelOffset) {
        this.scrollY = Math.max(0, pixelOffset);
        this.requestRedraw();
    }

    setZoom(ticksPerPixel) {
        this.ticksPerPixel = Math.max(0.5, Math.min(20, ticksPerPixel));
        this.requestRedraw();
        this._notifyScrollChange();
    }

    _notifyScrollChange() {
        if (this.onScrollChange) this.onScrollChange();
    }

    /**
     * Vertical zoom: adjust row height.
     * factor < 1 = zoom in (taller rows), factor > 1 = zoom out (shorter rows)
     */
    setVerticalZoom(factor) {
        this.rowHeight = Math.max(12, Math.min(40, Math.round(this.rowHeight / factor)));
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

    // ========================================================================
    // SELECTION
    // ========================================================================

    selectEvent(index) { this.selectedEvents.add(index); this.requestRedraw(); }
    deselectEvent(index) { this.selectedEvents.delete(index); this.requestRedraw(); }
    clearSelection() { this.selectedEvents.clear(); this.requestRedraw(); }

    selectAll() {
        for (let i = 0; i < this.gridEvents.length; i++) this.selectedEvents.add(i);
        this.requestRedraw();
    }

    getSelectedEvents() {
        return Array.from(this.selectedEvents).map(i => this.gridEvents[i]).filter(Boolean);
    }

    getSelectedIndices() {
        return Array.from(this.selectedEvents);
    }

    deleteSelected() {
        if (this.selectedEvents.size === 0) return 0;
        this.saveSnapshot();
        const indices = Array.from(this.selectedEvents).sort((a, b) => b - a);
        for (const i of indices) this.gridEvents.splice(i, 1);
        this.selectedEvents.clear();
        this._updateVisibleNotes();
        this.requestRedraw();
        return indices.length;
    }

    // ========================================================================
    // UNDO / REDO
    // ========================================================================

    saveSnapshot() {
        this._undoStack.push(this.gridEvents.map(e => ({ ...e })));
        this._redoStack = [];
        if (this._undoStack.length > this._maxUndoSize) this._undoStack.shift();
    }

    undo() {
        if (this._undoStack.length === 0) return false;
        this._redoStack.push(this.gridEvents.map(e => ({ ...e })));
        this.gridEvents = this._undoStack.pop().map(e => ({ ...e }));
        this.selectedEvents.clear();
        this._updateVisibleNotes();
        this.requestRedraw();
        return true;
    }

    redo() {
        if (this._redoStack.length === 0) return false;
        this._undoStack.push(this.gridEvents.map(e => ({ ...e })));
        this.gridEvents = this._redoStack.pop().map(e => ({ ...e }));
        this.selectedEvents.clear();
        this._updateVisibleNotes();
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
        for (const evt of this._clipboard) {
            this.gridEvents.push({ ...evt, tick: evt.tick + atTick });
        }
        this.gridEvents.sort((a, b) => a.tick - b.tick);
        this._updateVisibleNotes();
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

        ctx.fillStyle = this.colors.background;
        ctx.fillRect(0, 0, w, h);

        this._drawRowBackgrounds(w, h);
        this._drawGrid(w, h);
        this._drawHits(w, h);

        if (this.selectionRect) this._drawSelectionRect();

        this._drawPlayhead(w, h);
        this._drawHeader(w);
        this._drawRowLabels(h);
        this._drawScrollbar(w, h);
    }

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.requestRedraw();
    }

    // ========================================================================
    // DRAWING
    // ========================================================================

    _drawRowBackgrounds(w, h) {
        const ctx = this.ctx;
        for (let i = 0; i < this.visibleNotes.length; i++) {
            const note = this.visibleNotes[i];
            const y = this._rowToY(i);
            if (y + this.rowHeight < 0 || y > h) continue;

            ctx.fillStyle = i % 2 === 0 ? this.colors.rowEven : this.colors.rowOdd;
            ctx.fillRect(this.headerWidth, y, w - this.headerWidth, this.rowHeight);

            // Dim muted rows
            if (this.mutedNotes.has(note)) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
                ctx.fillRect(this.headerWidth, y, w - this.headerWidth, this.rowHeight);
            }
        }
    }

    _drawGrid(w, h) {
        const ctx = this.ctx;
        const ticksPerMeasure = this.ticksPerBeat * this.beatsPerMeasure;
        const startTick = this.scrollX;
        const endTick = startTick + (w - this.headerWidth) * this.ticksPerPixel;

        // Subdivision lines (based on quantize division)
        const ticksPerDiv = this.ticksPerBeat / this.quantizeDiv;
        const firstDiv = Math.floor(startTick / ticksPerDiv) * ticksPerDiv;
        ctx.strokeStyle = this.colors.gridLine;
        ctx.lineWidth = 0.5;
        ctx.globalAlpha = 0.4;
        for (let tick = firstDiv; tick <= endTick; tick += ticksPerDiv) {
            const x = this._tickToX(tick);
            if (x < this.headerWidth) continue;
            ctx.beginPath();
            ctx.moveTo(x, this.topMargin);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        ctx.globalAlpha = 1.0;

        // Beat lines
        const firstBeat = Math.floor(startTick / this.ticksPerBeat) * this.ticksPerBeat;
        ctx.strokeStyle = this.colors.beatLine;
        ctx.lineWidth = 0.5;
        for (let tick = firstBeat; tick <= endTick; tick += this.ticksPerBeat) {
            const x = this._tickToX(tick);
            if (x < this.headerWidth) continue;
            ctx.beginPath();
            ctx.moveTo(x, this.topMargin);
            ctx.lineTo(x, h);
            ctx.stroke();
        }

        // Measure lines
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
        }

        // Row divider lines
        ctx.strokeStyle = this.colors.gridLine;
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= this.visibleNotes.length; i++) {
            const y = this._rowToY(i);
            ctx.beginPath();
            ctx.moveTo(this.headerWidth, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
    }

    _drawHits(w, _h) {
        const ctx = this.ctx;
        const startTick = this.scrollX;
        const endTick = startTick + (w - this.headerWidth) * this.ticksPerPixel;

        for (let i = 0; i < this.gridEvents.length; i++) {
            const evt = this.gridEvents[i];
            if (evt.tick < startTick - 100 || evt.tick > endTick) continue;

            const rowIndex = this.visibleNotes.indexOf(evt.note);
            if (rowIndex < 0) continue;

            const x = this._tickToX(evt.tick);
            if (x < this.headerWidth - 5) continue;

            const y = this._rowToY(rowIndex);
            const isSelected = this.selectedEvents.has(i);

            // Hit cell
            const cellW = Math.max(6, Math.min(16, this.rowHeight - 4));
            const cellH = this.rowHeight - 4;
            const cx = x - cellW / 2;
            const cy = y + 2;

            // Velocity-based opacity
            const velocity = evt.velocity || 100;
            const isMuted = this.mutedNotes.has(evt.note);
            const alpha = isMuted ? 0.15 : (0.3 + (velocity / 127) * 0.7);

            const category = this.CATEGORY_MAP[evt.note] || 'misc';
            const color = this.categoryColors[category] || this.categoryColors.misc;

            if (isSelected && !isMuted) {
                ctx.fillStyle = this.colors.selectedBg;
                ctx.globalAlpha = 1;
            } else {
                ctx.fillStyle = isMuted ? '#555' : color;
                ctx.globalAlpha = alpha;
            }

            ctx.beginPath();
            ctx.roundRect(cx, cy, cellW, cellH, 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;

            // Mini velocity bar at bottom of cell (secondary visual cue)
            const velRatio = velocity / 127;
            ctx.fillStyle = isSelected ? '#ffffff' : color;
            ctx.globalAlpha = 0.9;
            ctx.fillRect(cx, cy + cellH - 2, cellW * velRatio, 2);
            ctx.globalAlpha = 1.0;

            // Duration line if present
            if (evt.duration && evt.duration > 0) {
                const endX = this._tickToX(evt.tick + evt.duration);
                if (endX > x + cellW / 2) {
                    ctx.strokeStyle = isSelected ? this.colors.selectedBg : color;
                    ctx.lineWidth = 2;
                    ctx.globalAlpha = 0.4;
                    ctx.beginPath();
                    ctx.moveTo(cx + cellW, y + this.rowHeight / 2);
                    ctx.lineTo(Math.min(endX, w), y + this.rowHeight / 2);
                    ctx.stroke();
                    ctx.globalAlpha = 1.0;
                }
            }
        }
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

        // Triangle
        ctx.fillStyle = this.colors.playhead;
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 7);
        ctx.closePath();
        ctx.fill();
    }

    _drawHeader(w) {
        const ctx = this.ctx;
        // Background for beat number row
        ctx.fillStyle = this.colors.headerBg;
        ctx.fillRect(0, 0, w, this.topMargin);

        // Measure/beat numbers
        const ticksPerMeasure = this.ticksPerBeat * this.beatsPerMeasure;
        const startTick = this.scrollX;
        const endTick = startTick + (w - this.headerWidth) * this.ticksPerPixel;

        const firstMeasure = Math.floor(startTick / ticksPerMeasure) * ticksPerMeasure;
        ctx.fillStyle = this.colors.beatNumber;
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        for (let tick = firstMeasure; tick <= endTick; tick += ticksPerMeasure) {
            const x = this._tickToX(tick);
            if (x < this.headerWidth) continue;
            const measureNum = Math.round(tick / ticksPerMeasure) + 1;
            ctx.fillText(measureNum.toString(), x + 2, this.topMargin - 5);
        }
    }

    _getNoteName(note) {
        if (typeof i18n !== 'undefined') {
            const translated = i18n.t('drumNotes.' + note);
            if (translated !== 'drumNotes.' + note) return translated;
        }
        return this.NOTE_NAMES[note] || `Note ${note}`;
    }

    _getShortName(note) {
        if (typeof i18n !== 'undefined') {
            const translated = i18n.t('drumNotes.short.' + note);
            if (translated !== 'drumNotes.short.' + note) return translated;
        }
        return this.SHORT_NAMES[note] || `${note}`;
    }

    _drawRowLabels(h) {
        const ctx = this.ctx;
        // Header background
        ctx.fillStyle = this.colors.headerBg;
        ctx.fillRect(0, this.topMargin, this.headerWidth, h - this.topMargin);

        // Border
        ctx.strokeStyle = this.colors.measureLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.headerWidth, 0);
        ctx.lineTo(this.headerWidth, h);
        ctx.stroke();

        const hasPlayableInfo = this.playableNotes !== undefined;

        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < this.visibleNotes.length; i++) {
            const note = this.visibleNotes[i];
            const y = this._rowToY(i);
            const cy = y + this.rowHeight / 2;

            if (cy < this.topMargin || cy > h) continue;

            const isMuted = this.mutedNotes.has(note);

            // Playable note background (only when routing info available)
            if (hasPlayableInfo && !isMuted) {
                const isPlayable = this.playableNotes === null || this.playableNotes.has(note);
                if (isPlayable) {
                    ctx.fillStyle = 'rgba(0, 200, 80, 0.25)';
                    ctx.fillRect(0, y, this.headerWidth, this.rowHeight);
                }
            }

            // Muted row: grey overlay on label area
            if (isMuted) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
                ctx.fillRect(0, y, this.headerWidth, this.rowHeight);
            }

            // Mute toggle indicator (wider zone at left)
            const muteW = 16;
            if (isMuted) {
                ctx.fillStyle = 'rgba(255, 60, 60, 0.3)';
                ctx.fillRect(0, y, muteW, this.rowHeight);
                // Cross icon
                ctx.strokeStyle = '#ff4444';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(4, cy - 4);
                ctx.lineTo(12, cy + 4);
                ctx.moveTo(12, cy - 4);
                ctx.lineTo(4, cy + 4);
                ctx.stroke();
            } else {
                ctx.fillStyle = 'rgba(0, 200, 80, 0.15)';
                ctx.fillRect(0, y, muteW, this.rowHeight);
                // Small filled circle
                ctx.beginPath();
                ctx.arc(8, cy, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#00c850';
                ctx.fill();
            }

            // Separator line after mute zone
            ctx.strokeStyle = this.colors.measureLine;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(muteW, y);
            ctx.lineTo(muteW, y + this.rowHeight);
            ctx.stroke();

            // Category color indicator
            const category = this.CATEGORY_MAP[note] || 'misc';
            const color = this.categoryColors[category] || this.categoryColors.misc;

            ctx.fillStyle = color;
            ctx.fillRect(18, y + 2, 4, this.rowHeight - 4);

            // Label text (clickable for play)
            if (isMuted) {
                ctx.fillStyle = '#555';
            } else if (hasPlayableInfo && (this.playableNotes === null || this.playableNotes.has(note))) {
                ctx.fillStyle = '#00e050';
            } else {
                ctx.fillStyle = this.colors.headerText;
            }
            const label = this._getShortName(note);
            ctx.fillText(label, this.headerWidth - 6, cy);
        }

        ctx.textAlign = 'left'; // Reset
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
        ctx.strokeStyle = this.colors.selectedBg;
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

    _rowToY(rowIndex) {
        return this.topMargin + rowIndex * this.rowHeight - this.scrollY;
    }

    _yToRow(y) {
        return Math.floor((y - this.topMargin + this.scrollY) / this.rowHeight);
    }

    _yToNote(y) {
        const rowIndex = this._yToRow(y);
        if (rowIndex < 0 || rowIndex >= this.visibleNotes.length) return -1;
        return this.visibleNotes[rowIndex];
    }

    getRequiredHeight() {
        return this.topMargin + this.visibleNotes.length * this.rowHeight + 10;
    }

    getMaxTick() {
        if (this.gridEvents.length === 0) return 0;
        return Math.max(...this.gridEvents.map(e => e.tick + (e.duration || 0)));
    }

    // ========================================================================
    // HIT TESTING
    // ========================================================================

    _hitTest(canvasX, canvasY) {
        const tick = this._xToTick(canvasX);
        const note = this._yToNote(canvasY);
        if (note < 0) return -1;

        const hitRadius = 8 * this.ticksPerPixel;
        for (let i = 0; i < this.gridEvents.length; i++) {
            const evt = this.gridEvents[i];
            if (evt.note === note && Math.abs(evt.tick - tick) < hitRadius) {
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

        // Click on row label area
        if (x < this.headerWidth && y > this.topMargin) {
            const rowIndex = this._yToRow(y);
            if (rowIndex >= 0 && rowIndex < this.visibleNotes.length) {
                const note = this.visibleNotes[rowIndex];
                if (x <= 16) {
                    // Mute toggle zone (left side)
                    if (this.mutedNotes.has(note)) {
                        this.mutedNotes.delete(note);
                    } else {
                        this.mutedNotes.add(note);
                    }
                    this.requestRedraw();
                    this._emitEvent('labelclick', { note, muted: this.mutedNotes.has(note) });
                } else {
                    // Label area: play the drum sound
                    this._emitEvent('playrow', { note });
                }
                return;
            }
        }

        // Pan mode: pan by default, select with shift
        // Select mode: select by default, pan with alt/middle
        const forcePan = e.altKey || e.button === 1;
        const usePan = forcePan || (this.tool === 'pan' && !e.shiftKey);

        if (usePan) {
            this._isDragging = true;
            this._dragMode = 'pan';
            this._dragStart = { x, y, scrollX: this.scrollX, scrollY: this.scrollY };
            this.canvas.style.cursor = 'grabbing';
            e.preventDefault();
            return;
        }

        const hitIndex = this._hitTest(x, y);

        if (hitIndex >= 0) {
            if (e.ctrlKey || e.metaKey) {
                if (this.selectedEvents.has(hitIndex)) {
                    this.selectedEvents.delete(hitIndex);
                } else {
                    this.selectedEvents.add(hitIndex);
                }
            } else if (!this.selectedEvents.has(hitIndex)) {
                this.selectedEvents.clear();
                this.selectedEvents.add(hitIndex);
            }
            this.requestRedraw();
            this._emitEvent('selectionchange', { selected: this.getSelectedIndices() });
        } else {
            if (!e.ctrlKey && !e.metaKey) this.selectedEvents.clear();
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
                const dy = y - this._dragStart.y;
                this.scrollX = Math.max(0, this._dragStart.scrollX - dx);
                this.scrollY = Math.max(0, this._dragStart.scrollY - dy);
                this.requestRedraw();
                this._notifyScrollChange();
            }
            return;
        }

        // Cursor for label zone (always clickable for mute toggle)
        if (x < this.headerWidth && y > this.topMargin) {
            this.canvas.style.cursor = 'pointer';
        } else if (!this._isDragging) {
            this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
        }

        // Hover
        const hitIndex = this._hitTest(x, y);
        if (hitIndex !== this._hoverEvent) {
            this._hoverEvent = hitIndex >= 0 ? hitIndex : null;
            this.requestRedraw();
        }
    }

    _handleMouseUp(_e) {
        if (this._isDragging && this._dragMode === 'select' && this.selectionRect) {
            const r = this.selectionRect;
            const minX = Math.min(r.x1, r.x2);
            const maxX = Math.max(r.x1, r.x2);
            const minY = Math.min(r.y1, r.y2);
            const maxY = Math.max(r.y1, r.y2);

            for (let i = 0; i < this.gridEvents.length; i++) {
                const evt = this.gridEvents[i];
                const rowIndex = this.visibleNotes.indexOf(evt.note);
                if (rowIndex < 0) continue;
                const evtX = this._tickToX(evt.tick);
                const evtY = this._rowToY(rowIndex) + this.rowHeight / 2;

                if (evtX >= minX && evtX <= maxX && evtY >= minY && evtY <= maxY) {
                    this.selectedEvents.add(i);
                }
            }
            this._emitEvent('selectionchange', { selected: this.getSelectedIndices() });
        }

        this._isDragging = false;
        this._dragMode = null;
        this._dragStart = null;
        this.selectionRect = null;
        this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
        this.requestRedraw();
    }

    _handleDblClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hitIndex = this._hitTest(x, y);

        if (hitIndex >= 0) {
            // Double-click existing: edit velocity
            this._emitEvent('editvelocity', { index: hitIndex, event: this.gridEvents[hitIndex] });
        } else {
            // Double-click empty: add hit
            const tick = this._xToTick(x);
            const note = this._yToNote(y);
            if (note >= 0 && tick >= 0) {
                // Quantize to current subdivision
                const ticksPerDiv = this.ticksPerBeat / this.quantizeDiv;
                const quantizedTick = Math.round(tick / ticksPerDiv) * ticksPerDiv;
                this._emitEvent('addhit', { tick: quantizedTick, note });
            }
        }
    }

    // ========================================================================
    // WHEEL SCROLL
    // ========================================================================

    _handleWheel(e) {
        e.preventDefault();

        const maxScrollY = Math.max(0, this.getRequiredHeight() - this.canvas.height);

        if (e.shiftKey) {
            // Horizontal scroll
            this.scrollX = Math.max(0, this.scrollX + e.deltaY * this.ticksPerPixel);
        } else {
            // Vertical scroll
            this.scrollY = Math.max(0, Math.min(maxScrollY, this.scrollY + e.deltaY));
        }

        this.requestRedraw();
        this._notifyScrollChange();
    }

    // ========================================================================
    // SCROLLBAR OVERLAY
    // ========================================================================

    /**
     * Draw a vertical scrollbar overlay when content exceeds canvas height
     */
    _drawScrollbar(w, h) {
        const totalHeight = this.getRequiredHeight();
        if (totalHeight <= h) return; // No scrollbar needed

        const ctx = this.ctx;
        const scrollbarWidth = 6;
        const scrollbarX = w - scrollbarWidth - 2;
        const maxScrollY = totalHeight - h;
        const trackHeight = h - this.topMargin - 4;
        const thumbRatio = h / totalHeight;
        const thumbHeight = Math.max(20, trackHeight * thumbRatio);
        const thumbY = this.topMargin + 2 + (this.scrollY / maxScrollY) * (trackHeight - thumbHeight);

        // Track
        ctx.fillStyle = 'rgba(128, 128, 128, 0.15)';
        ctx.fillRect(scrollbarX, this.topMargin + 2, scrollbarWidth, trackHeight);

        // Thumb
        ctx.fillStyle = 'rgba(128, 128, 128, 0.4)';
        ctx.beginPath();
        ctx.roundRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight, 3);
        ctx.fill();
    }

    // ========================================================================
    // EVENT EMITTER
    // ========================================================================

    _emitEvent(type, detail) {
        this.canvas.dispatchEvent(new CustomEvent(`drum:${type}`, { detail, bubbles: true }));
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
    module.exports = DrumGridRenderer;
}
if (typeof window !== 'undefined') {
    window.DrumGridRenderer = DrumGridRenderer;
}
