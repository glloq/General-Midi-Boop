// ============================================================================
// Fichier: public/js/views/components/WindMelodyRenderer.js
// Description: Melodic curve canvas renderer for wind/brass instruments
//   Pitch vs time plot optimized for monophonic viewing
//   Shows instrument range zones, articulation markers, breath marks
//   Supports zoom, scroll, selection, undo/redo, and theme awareness
// ============================================================================

class WindMelodyRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Instrument range
        this.noteMin = options.noteMin || 48;
        this.noteMax = options.noteMax || 84;
        this.comfortMin = options.comfortMin || 48;
        this.comfortMax = options.comfortMax || 84;

        // Layout
        this.headerWidth = 50;
        this.topMargin = 20;
        this.bottomMargin = 0;
        this.ticksPerPixel = 2;
        this.scrollX = 0;
        this.scrollY = 0;           // Vertical scroll in semitones (pitch offset)

        // Time signature
        this.ticksPerBeat = 480;
        this.beatsPerMeasure = 4;

        // Display range for pitch (adds padding above/below instrument range)
        this.displayNoteMin = Math.max(0, this.noteMin - 5);
        this.displayNoteMax = Math.min(127, this.noteMax + 5);

        // Range check (out-of-range highlighting)
        this.rangeCheckEnabled = true;

        // Interaction tool: 'pan' (default) or 'edit'
        this.tool = options.tool || 'pan';

        // Scroll change callback (for syncing with external scroll bars)
        this.onScrollChange = options.onScrollChange || null;

        // Data
        this.melodyEvents = [];     // {tick, note, velocity, duration, channel, articulation}
        this.breathMarks = [];      // {tick, type, duration}

        // Selection
        this.selectedEvents = new Set();
        this.selectionRect = null;

        // Playback
        this.playheadTick = 0;

        // Interaction
        this._isDragging = false;
        this._dragStart = null;
        this._dragMode = null;       // 'select' | 'move' | 'resize'
        this._hoverIndex = -1;
        this._moveOffset = null;
        this._resizeIndex = -1;

        // Undo/Redo
        this._undoStack = [];
        this._redoStack = [];
        this._maxUndoSize = 20;

        // RAF-throttled rendering
        this._redrawScheduled = false;

        // Clipboard
        this._clipboard = [];

        // Colors
        this.colors = {};
        this.updateTheme();

        // Bind events
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onDblClick = this._handleDblClick.bind(this);
        this._onWheel = this._handleWheel.bind(this);

        this.canvas.addEventListener('mousedown', this._onMouseDown);
        this.canvas.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('dblclick', this._onDblClick);
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

        // Set initial cursor for pan mode
        if (this.tool === 'pan') {
            this.canvas.style.cursor = 'grab';
        }
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');
        if (isDark) {
            this.colors = {
                background: '#1a1a2e',
                gridLine: '#2d3748',
                measureLine: '#4a5568',
                beatLine: '#2d3748',
                headerBg: '#2d3748',
                headerText: '#a0aec0',
                beatNumber: '#718096',
                playhead: '#ff4444',
                noteColor: '#667eea',
                noteSelected: '#ff6b6b',
                noteOutOfRange: '#ff4444',
                comfortZone: 'rgba(102,126,234,0.08)',
                extendedZone: 'rgba(255,193,7,0.08)',
                outOfRangeZone: 'rgba(100,100,100,0.15)',
                breathRequired: '#ff4444',
                breathSuggested: '#ffb74d',
                selectionRect: 'rgba(102,126,234,0.3)',
                octaveLine: '#3d4a60',
                articulationColor: '#a0aec0',
            };
        } else {
            this.colors = {
                background: '#f0f4ff',
                gridLine: '#d4daff',
                measureLine: '#b0b8e8',
                beatLine: '#d4daff',
                headerBg: '#e0e4f8',
                headerText: '#5a6089',
                beatNumber: '#9498b8',
                playhead: '#ef476f',
                noteColor: '#667eea',
                noteSelected: '#ef476f',
                noteOutOfRange: '#ff4444',
                comfortZone: 'rgba(102,126,234,0.06)',
                extendedZone: 'rgba(255,209,102,0.10)',
                outOfRangeZone: 'rgba(100,100,100,0.12)',
                breathRequired: '#ef476f',
                breathSuggested: '#ffa726',
                selectionRect: 'rgba(102,126,234,0.25)',
                octaveLine: '#c0c8f0',
                articulationColor: '#5a6089',
            };
        }
    }

    // ========================================================================
    // DATA
    // ========================================================================

    setMelodyEvents(events) {
        this.melodyEvents = events || [];
        this.selectedEvents.clear();
        this.requestRedraw();
    }

    setBreathMarks(marks) {
        this.breathMarks = marks || [];
        this.requestRedraw();
    }

    setInstrumentRange(min, max, comfMin, comfMax) {
        this.noteMin = min;
        this.noteMax = max;
        this.comfortMin = comfMin;
        this.comfortMax = comfMax;
        this.displayNoteMin = Math.max(0, min - 5);
        this.displayNoteMax = Math.min(127, max + 5);
        this.requestRedraw();
    }

    setScrollX(tickOffset) {
        this.scrollX = Math.max(0, tickOffset);
        this.requestRedraw();
        this._notifyScrollChange();
    }

    setScrollY(noteOffset) {
        this.scrollY = noteOffset;
        // Adjust display range based on scroll
        const range = this.noteMax - this.noteMin + 10;
        this.displayNoteMin = Math.max(0, this.noteMin - 5 + this.scrollY);
        this.displayNoteMax = Math.min(127, this.displayNoteMin + range);
        this.requestRedraw();
        this._notifyScrollChange();
    }

    setZoom(ticksPerPixel) {
        this.ticksPerPixel = Math.max(0.5, Math.min(20, ticksPerPixel));
        this.requestRedraw();
        this._notifyScrollChange();
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

    /**
     * Center the view on the note range present in the melody events.
     * Called when the editor opens to ensure notes are visible.
     */
    centerOnNotes() {
        if (this.melodyEvents.length === 0) return;

        // Find note range
        let minNote = 127, maxNote = 0, minTick = Infinity;
        for (const evt of this.melodyEvents) {
            if (evt.note < minNote) minNote = evt.note;
            if (evt.note > maxNote) maxNote = evt.note;
            if (evt.tick < minTick) minTick = evt.tick;
        }

        // Center pitch display on the actual notes (with padding)
        const centerNote = Math.floor((minNote + maxNote) / 2);
        const range = this.noteMax - this.noteMin + 10;
        this.displayNoteMin = Math.max(0, centerNote - Math.floor(range / 2));
        this.displayNoteMax = Math.min(127, this.displayNoteMin + range);
        this.scrollY = this.displayNoteMin - Math.max(0, this.noteMin - 5);

        // Scroll horizontally to the first note
        this.scrollX = Math.max(0, minTick - this.ticksPerBeat);

        this.requestRedraw();
        this._notifyScrollChange();
    }

    _notifyScrollChange() {
        if (this.onScrollChange) {
            this.onScrollChange({
                scrollX: this.scrollX,
                scrollY: this.scrollY,
                displayNoteMin: this.displayNoteMin,
                displayNoteMax: this.displayNoteMax,
            });
        }
    }

    _dispatchSelectionChange() {
        this.canvas.dispatchEvent(new CustomEvent('wind:selectionchange', {
            detail: { count: this.selectedEvents.size }
        }));
    }

    // ========================================================================
    // COORDINATE CONVERSION
    // ========================================================================

    _tickToX(tick) {
        return this.headerWidth + (tick - this.scrollX) / this.ticksPerPixel;
    }

    _xToTick(x) {
        return (x - this.headerWidth) * this.ticksPerPixel + this.scrollX;
    }

    _noteToY(note) {
        const pitchRange = this.displayNoteMax - this.displayNoteMin;
        if (pitchRange <= 0) return this.topMargin;
        const drawHeight = this.canvas.height - this.topMargin - this.bottomMargin;
        // Higher notes at top
        return this.topMargin + (1 - (note - this.displayNoteMin) / pitchRange) * drawHeight;
    }

    _yToNote(y) {
        const pitchRange = this.displayNoteMax - this.displayNoteMin;
        if (pitchRange <= 0) return this.displayNoteMin;
        const drawHeight = this.canvas.height - this.topMargin - this.bottomMargin;
        const ratio = 1 - (y - this.topMargin) / drawHeight;
        return Math.round(this.displayNoteMin + ratio * pitchRange);
    }

    _getNoteHeight() {
        const pitchRange = this.displayNoteMax - this.displayNoteMin;
        if (pitchRange <= 0) return 10;
        const drawHeight = this.canvas.height - this.topMargin - this.bottomMargin;
        return Math.max(4, Math.min(20, drawHeight / pitchRange));
    }

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
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        if (w <= 0 || h <= 0) return;

        ctx.clearRect(0, 0, w, h);

        this._renderRangeZones(ctx, w, h);
        this._renderGrid(ctx, w, h);
        this._renderBreathMarks(ctx, w, h);
        this._renderNotes(ctx, w, h);
        this._renderSelectionRect(ctx);
        this._renderPlayhead(ctx, w, h);
    }

    _renderRangeZones(ctx, w, h) {
        const pitchRange = this.displayNoteMax - this.displayNoteMin;
        if (pitchRange <= 0) return;

        // Fill background
        ctx.fillStyle = this.colors.background;
        ctx.fillRect(0, 0, w, h);

        // Out-of-range zones (above noteMax and below noteMin)
        ctx.fillStyle = this.colors.outOfRangeZone;
        const topOutY = this.topMargin;
        const topOutH = this._noteToY(this.noteMax) - this.topMargin;
        if (topOutH > 0) ctx.fillRect(this.headerWidth, topOutY, w - this.headerWidth, topOutH);

        const bottomOutY = this._noteToY(this.noteMin);
        const bottomOutH = h - this.bottomMargin - bottomOutY;
        if (bottomOutH > 0) ctx.fillRect(this.headerWidth, bottomOutY, w - this.headerWidth, bottomOutH);

        // Extended range zones (between range and comfort)
        ctx.fillStyle = this.colors.extendedZone;
        // Top extended: between comfortMax and noteMax
        const extTopY = this._noteToY(this.noteMax);
        const extTopH = this._noteToY(this.comfortMax) - extTopY;
        if (extTopH > 0) ctx.fillRect(this.headerWidth, extTopY, w - this.headerWidth, extTopH);

        // Bottom extended: between noteMin and comfortMin
        const extBotY = this._noteToY(this.comfortMin);
        const extBotH = this._noteToY(this.noteMin) - extBotY;
        if (extBotH > 0) ctx.fillRect(this.headerWidth, extBotY, w - this.headerWidth, extBotH);

        // Comfortable zone (faint highlight)
        ctx.fillStyle = this.colors.comfortZone;
        const comfY = this._noteToY(this.comfortMax);
        const comfH = this._noteToY(this.comfortMin) - comfY;
        if (comfH > 0) ctx.fillRect(this.headerWidth, comfY, w - this.headerWidth, comfH);

        // Header background
        ctx.fillStyle = this.colors.headerBg;
        ctx.fillRect(0, 0, this.headerWidth, h);
    }

    _renderGrid(ctx, w, h) {
        const pitchRange = this.displayNoteMax - this.displayNoteMin;
        if (pitchRange <= 0) return;

        // Horizontal lines at each semitone, thicker at C (octave boundary)
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (let n = this.displayNoteMin; n <= this.displayNoteMax; n++) {
            const y = this._noteToY(n);
            if (y < this.topMargin || y > h - this.bottomMargin) continue;

            const isC = (n % 12 === 0);
            ctx.strokeStyle = isC ? this.colors.octaveLine : this.colors.gridLine;
            ctx.lineWidth = isC ? 1.5 : 0.5;

            ctx.beginPath();
            ctx.moveTo(this.headerWidth, y);
            ctx.lineTo(w, y);
            ctx.stroke();

            // Label C notes and range boundaries
            if (isC || n === this.noteMin || n === this.noteMax) {
                ctx.fillStyle = this.colors.headerText;
                ctx.fillText(WindInstrumentDatabase.noteName(n), this.headerWidth - 4, y);
            }
        }

        // Vertical lines for beats and measures
        const ticksPerMeasure = this.ticksPerBeat * this.beatsPerMeasure;
        const startTick = Math.floor(this.scrollX / this.ticksPerBeat) * this.ticksPerBeat;
        const endTick = this.scrollX + (w - this.headerWidth) * this.ticksPerPixel;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        for (let tick = startTick; tick <= endTick; tick += this.ticksPerBeat) {
            const x = this._tickToX(tick);
            if (x < this.headerWidth || x > w) continue;

            const isMeasure = (tick % ticksPerMeasure === 0);
            ctx.strokeStyle = isMeasure ? this.colors.measureLine : this.colors.beatLine;
            ctx.lineWidth = isMeasure ? 1.5 : 0.5;

            ctx.beginPath();
            ctx.moveTo(x, this.topMargin);
            ctx.lineTo(x, h - this.bottomMargin);
            ctx.stroke();

            // Measure/beat numbers
            if (isMeasure) {
                const measureNum = Math.floor(tick / ticksPerMeasure) + 1;
                ctx.fillStyle = this.colors.beatNumber;
                ctx.font = '10px monospace';
                ctx.fillText(String(measureNum), x, 3);
            }
        }
    }

    _renderNotes(ctx, w, _h) {
        const noteH = this._getNoteHeight();

        for (let i = 0; i < this.melodyEvents.length; i++) {
            const evt = this.melodyEvents[i];
            const x = this._tickToX(evt.tick);
            const noteW = evt.duration / this.ticksPerPixel;
            const y = this._noteToY(evt.note);

            // Skip if off-screen
            if (x + noteW < this.headerWidth || x > w) continue;

            const isSelected = this.selectedEvents.has(i);
            const isOutOfRange = this.rangeCheckEnabled && (evt.note < this.noteMin || evt.note > this.noteMax);

            // Note body
            const alpha = 0.5 + (evt.velocity / 127) * 0.5;
            if (isSelected) {
                ctx.fillStyle = this.colors.noteSelected;
            } else if (isOutOfRange) {
                ctx.fillStyle = this.colors.noteOutOfRange;
            } else {
                ctx.fillStyle = this.colors.noteColor;
            }
            ctx.globalAlpha = alpha;

            const radius = Math.min(3, noteH / 2);
            this._roundRect(ctx, x, y - noteH / 2, Math.max(2, noteW), noteH, radius);
            ctx.fill();

            // Out-of-range border
            if (isOutOfRange) {
                ctx.strokeStyle = this.colors.noteOutOfRange;
                ctx.lineWidth = 2;
                this._roundRect(ctx, x, y - noteH / 2, Math.max(2, noteW), noteH, radius);
                ctx.stroke();
            }

            ctx.globalAlpha = 1;

            // Articulation marker
            this._renderArticulationMarker(ctx, evt, x, y, noteH, noteW);
        }
    }

    _renderArticulationMarker(ctx, evt, x, y, noteH, noteW) {
        const art = evt.articulation || 'normal';
        if (art === 'normal') return;

        const artDef = WindInstrumentDatabase.ARTICULATION_TYPES[art];
        if (!artDef || !artDef.symbol) return;

        ctx.fillStyle = this.colors.articulationColor;
        ctx.font = 'bold 12px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        if (art === 'legato') {
            // Draw arc connecting to next note
            const nextIdx = this.melodyEvents.indexOf(evt) + 1;
            if (nextIdx < this.melodyEvents.length) {
                const nextEvt = this.melodyEvents[nextIdx];
                const nextX = this._tickToX(nextEvt.tick);
                ctx.strokeStyle = this.colors.articulationColor;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                const midX = (x + noteW + nextX) / 2;
                ctx.moveTo(x + noteW / 2, y - noteH / 2 - 2);
                ctx.quadraticCurveTo(midX, y - noteH / 2 - 12, nextX + 4, this._noteToY(nextEvt.note) - noteH / 2 - 2);
                ctx.stroke();
            }
        } else {
            ctx.fillText(artDef.symbol, x + noteW / 2, y - noteH / 2 - 2);
        }
    }

    _renderBreathMarks(ctx, w, _h) {
        for (const mark of this.breathMarks) {
            const x = this._tickToX(mark.tick);
            if (x < this.headerWidth || x > w) continue;

            ctx.fillStyle = mark.type === 'required' ? this.colors.breathRequired : this.colors.breathSuggested;
            ctx.font = 'bold 14px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(',', x, this.topMargin + 14);
        }
    }

    _renderPlayhead(ctx, w, h) {
        const x = this._tickToX(this.playheadTick);
        if (x < this.headerWidth || x > w) return;

        ctx.strokeStyle = this.colors.playhead;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
    }

    _renderSelectionRect(ctx) {
        if (!this.selectionRect) return;
        const { x, y, w, h } = this.selectionRect;
        ctx.fillStyle = this.colors.selectionRect;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = this.colors.noteColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
    }

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    // ========================================================================
    // INTERACTION — MOUSE
    // ========================================================================

    _handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (mx < this.headerWidth) return;

        const hitIdx = this._hitTestNote(mx, my);

        if (e.button === 0) {
            if (this.tool === 'pan') {
                // Pan mode: drag to scroll the view
                if (hitIdx >= 0 && e.shiftKey) {
                    // Shift+click on note in pan mode = select note
                    if (this.selectedEvents.has(hitIdx)) {
                        this.selectedEvents.delete(hitIdx);
                    } else {
                        this.selectedEvents.add(hitIdx);
                    }
                    this.requestRedraw();
                    this._dispatchSelectionChange();
                } else {
                    // Start panning
                    this._isDragging = true;
                    this._dragMode = 'pan';
                    this._dragStart = { x: mx, y: my, scrollX: this.scrollX, displayNoteMin: this.displayNoteMin, displayNoteMax: this.displayNoteMax };
                    this.canvas.style.cursor = 'grabbing';
                }
            } else {
                // Edit mode
                if (hitIdx >= 0) {
                    if (e.shiftKey) {
                        if (this.selectedEvents.has(hitIdx)) {
                            this.selectedEvents.delete(hitIdx);
                        } else {
                            this.selectedEvents.add(hitIdx);
                        }
                        this.requestRedraw();
                        this._dispatchSelectionChange();
                    } else {
                        if (!this.selectedEvents.has(hitIdx)) {
                            this.selectedEvents.clear();
                            this.selectedEvents.add(hitIdx);
                        }
                        this._isDragging = true;
                        this._dragMode = 'move';
                        this._dragStart = { x: mx, y: my };
                        this._moveOffset = { tick: 0, note: 0 };
                        this.requestRedraw();
                        this._dispatchSelectionChange();
                    }
                } else {
                    if (e.shiftKey) {
                        this._isDragging = true;
                        this._dragMode = 'select';
                        this._dragStart = { x: mx, y: my };
                        this.selectionRect = { x: mx, y: my, w: 0, h: 0 };
                    } else {
                        this.selectedEvents.clear();
                        this.requestRedraw();
                        this._dispatchSelectionChange();
                    }
                }
            }
        }
    }

    _handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (this._isDragging && this._dragMode === 'pan') {
            // Pan: scroll view by dragging
            const dx = (mx - this._dragStart.x) * this.ticksPerPixel;
            const dy = (my - this._dragStart.y);
            const noteH = this._getNoteHeight() || 10;
            const noteDelta = Math.round(dy / noteH);

            this.scrollX = Math.max(0, this._dragStart.scrollX - dx);
            const range = this._dragStart.displayNoteMax - this._dragStart.displayNoteMin;
            this.displayNoteMin = Math.max(0, this._dragStart.displayNoteMin + noteDelta);
            this.displayNoteMax = Math.min(127, this.displayNoteMin + range);
            this.scrollY = this.displayNoteMin - Math.max(0, this.noteMin - 5);

            this.requestRedraw();
            this._notifyScrollChange();
        } else if (this._isDragging && this._dragMode === 'select') {
            this.selectionRect = {
                x: Math.min(mx, this._dragStart.x),
                y: Math.min(my, this._dragStart.y),
                w: Math.abs(mx - this._dragStart.x),
                h: Math.abs(my - this._dragStart.y)
            };
            this.requestRedraw();
        } else if (this._isDragging && this._dragMode === 'move') {
            const tickDelta = (mx - this._dragStart.x) * this.ticksPerPixel;
            const noteDelta = -Math.round((my - this._dragStart.y) / (this._getNoteHeight() || 10));
            this._moveOffset = { tick: tickDelta, note: noteDelta };
            this.requestRedraw();
        } else {
            // Hover
            const newHover = this._hitTestNote(mx, my);
            if (newHover !== this._hoverIndex) {
                this._hoverIndex = newHover;
                if (this.tool === 'pan') {
                    this.canvas.style.cursor = newHover >= 0 ? 'pointer' : 'grab';
                } else {
                    this.canvas.style.cursor = newHover >= 0 ? 'pointer' : 'crosshair';
                }
            }
        }
    }

    _handleMouseUp(_e) {
        if (this._isDragging && this._dragMode === 'pan') {
            this.canvas.style.cursor = 'grab';
        } else if (this._isDragging && this._dragMode === 'select') {
            this._selectInRect(this.selectionRect);
            this.selectionRect = null;
            this.requestRedraw();
            this._dispatchSelectionChange();
        } else if (this._isDragging && this._dragMode === 'move' && this._moveOffset) {
            const { tick: dt, note: dn } = this._moveOffset;
            if (Math.abs(dt) > 10 || dn !== 0) {
                this.saveSnapshot();
                for (const idx of this.selectedEvents) {
                    const evt = this.melodyEvents[idx];
                    if (evt) {
                        evt.tick = Math.max(0, Math.round(evt.tick + dt));
                        evt.note = Math.max(0, Math.min(127, evt.note + dn));
                    }
                }
                this.melodyEvents.sort((a, b) => a.tick - b.tick);
                this._rebuildSelectionAfterSort();
                this.canvas.dispatchEvent(new CustomEvent('wind:notesmoved', { detail: {} }));
            }
        }

        this._isDragging = false;
        this._dragStart = null;
        this._dragMode = null;
        this._moveOffset = null;
        this.requestRedraw();
    }

    _handleDblClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (mx < this.headerWidth) return;

        const hitIdx = this._hitTestNote(mx, my);
        if (hitIdx >= 0) {
            // Double-click on note — toggle articulation
            this.canvas.dispatchEvent(new CustomEvent('wind:editarticulation', {
                detail: { index: hitIdx, event: this.melodyEvents[hitIdx] }
            }));
        } else {
            // Double-click on empty — add note
            const tick = Math.max(0, Math.round(this._xToTick(mx)));
            const note = this._yToNote(my);
            this.canvas.dispatchEvent(new CustomEvent('wind:addnote', {
                detail: { tick, note }
            }));
        }
    }

    _handleWheel(e) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            // Zoom
            const factor = e.deltaY > 0 ? 1.2 : 0.8;
            this.setZoom(this.ticksPerPixel * factor);
        } else if (e.shiftKey) {
            // Horizontal scroll with shift+wheel
            const delta = e.deltaY * this.ticksPerPixel * 2;
            this.scrollX = Math.max(0, this.scrollX + delta);
            this.requestRedraw();
            this._notifyScrollChange();
        } else {
            // Vertical pitch scroll (default wheel = vertical)
            const delta = e.deltaY > 0 ? -2 : 2;
            const range = this.displayNoteMax - this.displayNoteMin;
            this.displayNoteMin = Math.max(0, this.displayNoteMin + delta);
            this.displayNoteMax = Math.min(127, this.displayNoteMin + range);
            this.scrollY = this.displayNoteMin - Math.max(0, this.noteMin - 5);
            this.requestRedraw();
            this._notifyScrollChange();
        }
    }

    // ========================================================================
    // HIT TEST
    // ========================================================================

    _hitTestNote(mx, my) {
        const noteH = this._getNoteHeight();
        for (let i = this.melodyEvents.length - 1; i >= 0; i--) {
            const evt = this.melodyEvents[i];
            const x = this._tickToX(evt.tick);
            const noteW = Math.max(4, evt.duration / this.ticksPerPixel);
            const y = this._noteToY(evt.note);

            if (mx >= x && mx <= x + noteW && my >= y - noteH / 2 && my <= y + noteH / 2) {
                return i;
            }
        }
        return -1;
    }

    _selectInRect(rect) {
        if (!rect) return;
        this.selectedEvents.clear();
        const noteH = this._getNoteHeight();
        for (let i = 0; i < this.melodyEvents.length; i++) {
            const evt = this.melodyEvents[i];
            const x = this._tickToX(evt.tick);
            const noteW = Math.max(4, evt.duration / this.ticksPerPixel);
            const y = this._noteToY(evt.note);

            if (x + noteW > rect.x && x < rect.x + rect.w &&
                y + noteH / 2 > rect.y && y - noteH / 2 < rect.y + rect.h) {
                this.selectedEvents.add(i);
            }
        }
    }

    _rebuildSelectionAfterSort() {
        // After sort, indices change — clear selection for simplicity
        this.selectedEvents.clear();
    }

    // ========================================================================
    // UNDO / REDO
    // ========================================================================

    saveSnapshot() {
        this._undoStack.push(JSON.stringify(this.melodyEvents));
        if (this._undoStack.length > this._maxUndoSize) {
            this._undoStack.shift();
        }
        this._redoStack = [];
    }

    undo() {
        if (this._undoStack.length === 0) return false;
        this._redoStack.push(JSON.stringify(this.melodyEvents));
        this.melodyEvents = JSON.parse(this._undoStack.pop());
        this.selectedEvents.clear();
        this.requestRedraw();
        return true;
    }

    redo() {
        if (this._redoStack.length === 0) return false;
        this._undoStack.push(JSON.stringify(this.melodyEvents));
        this.melodyEvents = JSON.parse(this._redoStack.pop());
        this.selectedEvents.clear();
        this.requestRedraw();
        return true;
    }

    // ========================================================================
    // SELECTION OPERATIONS
    // ========================================================================

    selectAll() {
        this.selectedEvents.clear();
        for (let i = 0; i < this.melodyEvents.length; i++) {
            this.selectedEvents.add(i);
        }
        this.requestRedraw();
        this._dispatchSelectionChange();
    }

    deleteSelected() {
        if (this.selectedEvents.size === 0) return 0;
        this.saveSnapshot();
        const toRemove = new Set(this.selectedEvents);
        this.melodyEvents = this.melodyEvents.filter((_, i) => !toRemove.has(i));
        const count = toRemove.size;
        this.selectedEvents.clear();
        this.requestRedraw();
        return count;
    }

    copySelected() {
        if (this.selectedEvents.size === 0) return;
        const indices = Array.from(this.selectedEvents).sort((a, b) => a - b);
        const minTick = Math.min(...indices.map(i => this.melodyEvents[i].tick));
        this._clipboard = indices.map(i => {
            const e = this.melodyEvents[i];
            return { ...e, tick: e.tick - minTick };
        });
    }

    hasClipboard() {
        return this._clipboard.length > 0;
    }

    paste(atTick) {
        if (this._clipboard.length === 0) return;
        this.saveSnapshot();
        const newEvents = this._clipboard.map(e => ({
            ...e, tick: e.tick + atTick
        }));
        this.melodyEvents.push(...newEvents);
        this.melodyEvents.sort((a, b) => a.tick - b.tick);
        this.selectedEvents.clear();
        this.requestRedraw();
        this.canvas.dispatchEvent(new CustomEvent('wind:notesmoved', { detail: {} }));
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        this.canvas.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('dblclick', this._onDblClick);
        this.canvas.removeEventListener('wheel', this._onWheel);
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WindMelodyRenderer;
}
if (typeof window !== 'undefined') {
    window.WindMelodyRenderer = WindMelodyRenderer;
}
