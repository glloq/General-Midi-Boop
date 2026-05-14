/**
 * VelocityEditor - Note velocity editor synchronized with the piano roll
 *
 * Features:
 * - Display velocity bars as a graph
 * - Tools: select, move, line, continuous draw
 * - Horizontal synchronization with the piano roll
 * - Honors the time grid and zoom
 * - Filter by selected channel
 *
 * Extends BaseLaneEditor — shared scaffolding (constructor, listeners,
 * RAF, history, grid, conversions, destroy) lives there; this file owns
 * the velocity-specific data ops (modify note.v in place), hit-test
 * (returns sequence index), and bar rendering.
 *
 * Public surface preserved for MidiEditorCCPicker / MidiEditorCC /
 * MidiEditorEditActions / MidiEditorSequence :
 *   - constructor(container, options)
 *   - setTool, setChannel, setActiveChannels, currentChannel
 *   - setSequence, getSequence, syncWith
 *   - selectedNotes (alias of base selectedIds — stores sequence indices)
 *   - deleteSelected, updateNoteVelocity, updateSelectedNotesVelocity
 *   - resize, destroy, element, canvas, renderThrottled
 */

// eslint-disable-next-line no-unused-vars
class VelocityEditor extends BaseLaneEditor {
    constructor(container, options = {}) {
        super(container, options);

        this.sequence = [];

        // Pixel cache for selection-rect preview (Velocity uses
        // lastMouseX/Y + selectionStart instead of the base's
        // selectionRect.{currentX,currentY} pattern).
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
        this.selectionStart = null;

        // Match the legacy history cap.
        this.historyCap = 20;

        this.init();
    }

    // -----------------------------------------------------------------
    // Back-compat alias — call sites use `selectedNotes`.
    // The Set stores sequence indices, not item ids.
    // -----------------------------------------------------------------
    get selectedNotes() { return this.selectedIds; }

    // =================================================================
    // BaseLaneEditor hooks
    // =================================================================

    _className() { return 'velocity-editor'; }
    _dataField() { return 'sequence'; }

    /** Velocity selection identity is the index into `this.sequence`. */
    _idOf(item) { return item ? item.__index : undefined; }

    _valueToY(velocity) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = velocity / 127;
        return margin + drawH - (normalized * drawH);
    }

    _yToValue(y) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = 1 - ((y - margin) / drawH);
        return Math.round(Math.max(1, Math.min(127, normalized * 127)));
    }

    // Velocity has its own selection wiring (it tracks indices via
    // `lastMouseX/Y + selectionStart`); the base's selectInRect would
    // require synthetic items with `__index`. Override.
    selectInRect(x1, y1, x2, y2) {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);

        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;
            const nx = this.ticksToX(note.t);
            const barWidth = Math.max(2, this.ticksToX(note.t + note.g) - nx);
            const ny = this._valueToY(note.v || 100);
            if (nx >= left && nx + barWidth <= right && ny >= top && ny <= bottom) {
                this.selectedIds.add(i);
            }
        }
        this.renderThrottled();
    }

    selectAll() {
        this.selectedIds.clear();
        for (let i = 0; i < this.sequence.length; i++) {
            if (this.activeChannels.has(this.sequence[i].c)) {
                this.selectedIds.add(i);
            }
        }
        this.renderThrottled();
    }

    // Velocity-style cancelInteractions adds the lastMouseX/Y reset.
    cancelInteractions() {
        super.cancelInteractions();
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
    }

    // =================================================================
    // Velocity-specific channel filtering
    // =================================================================

    setChannel(channel) {
        this.currentChannel = channel;
        this.activeChannels = new Set([channel]);
        // Indices are invalidated; clear the selection.
        this.selectedIds.clear();
        this.cancelInteractions();
        this.renderThrottled();
    }

    setActiveChannels(channels) {
        this.activeChannels = new Set(channels);
        this.selectedIds.clear();
        this.cancelInteractions();
        this.renderThrottled();
    }

    // =================================================================
    // Sequence management
    // =================================================================

    setSequence(sequence) {
        this.sequence = sequence || [];
        this.selectedIds.clear();
        this.saveState();
        this.renderThrottled();
    }

    getSequence() {
        return this.sequence;
    }

    /** Sync xrange/xoffset/grid/timebase from the piano roll. */
    syncWith(pianoRoll) {
        this.options.xrange = pianoRoll.xrange;
        this.options.xoffset = pianoRoll.xoffset;
        this.options.grid = pianoRoll.grid;
        this.options.timebase = pianoRoll.timebase;
        this.gridDirty = true;
        this.renderThrottled();
    }

    // =================================================================
    // Velocity mutations
    // =================================================================

    updateNoteVelocity(noteIndex, velocity) {
        if (noteIndex >= 0 && noteIndex < this.sequence.length) {
            this.sequence[noteIndex].v = Math.max(1, Math.min(127, velocity));
            this.notifyChange();
        }
    }

    updateSelectedNotesVelocity(velocity) {
        Array.from(this.selectedIds).forEach(index => {
            if (index >= 0 && index < this.sequence.length) {
                this.sequence[index].v = Math.max(1, Math.min(127, velocity));
            }
        });
        this.saveState();
        this.notifyChange();
        this.renderThrottled();
    }

    adjustVelocity(noteIndex, delta) {
        if (noteIndex >= 0 && noteIndex < this.sequence.length) {
            const note = this.sequence[noteIndex];
            const currentVelocity = (note.v !== undefined && note.v !== null) ? note.v : 100;
            note.v = Math.max(1, Math.min(127, currentVelocity + delta));
            this.notifyChange();
        }
    }

    deleteSelected() {
        if (this.selectedIds.size === 0) return;
        // Delete from highest index to lowest so earlier splices don't
        // shift the still-pending indices.
        const indices = Array.from(this.selectedIds).sort((a, b) => b - a);
        indices.forEach(i => {
            if (i >= 0 && i < this.sequence.length) this.sequence.splice(i, 1);
        });
        this.selectedIds.clear();
        this.saveState();
        this.notifyChange();
        this.renderThrottled();
    }

    // =================================================================
    // Hit-test (returns sequence index, not item.id)
    // =================================================================

    getNoteAtPosition(x, y, threshold = 8) {
        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;
            const nx = this.ticksToX(note.t);
            const barWidth = Math.max(2, this.ticksToX(note.t + note.g) - nx);
            const ny = this._valueToY(note.v || 100);
            if (x >= nx - threshold &&
                x <= nx + barWidth + threshold &&
                y >= ny - threshold &&
                y <= this.canvas.height + threshold) {
                return i;
            }
        }
        return null;
    }

    getNoteAtTick(ticks, threshold = null) {
        if (threshold === null) threshold = this.options.grid / 2;
        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;
            if (Math.abs(note.t - ticks) <= threshold) return i;
        }
        return null;
    }

    getFilteredNotes() {
        return this.sequence.filter(note => this.activeChannels.has(note.c));
    }

    // =================================================================
    // Editing tools
    // =================================================================

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const velocity = this._yToValue(y);

        switch (this.currentTool) {
            case 'draw': {
                this.isDrawing = true;
                this.lastDrawPosition = { x, y };
                this.lastDrawTicks = this.snapToGrid(ticks);
                const noteAtDraw = this.getNoteAtTick(ticks);
                if (noteAtDraw !== null) {
                    this.updateNoteVelocity(noteAtDraw, velocity);
                    this.renderThrottled();
                }
                break;
            }

            case 'line':
                if (!this.lineStart) {
                    this.lineStart = { ticks, velocity };
                } else {
                    this.createLine(this.lineStart.ticks, this.lineStart.velocity, ticks, velocity);
                    this.lineStart = null;
                }
                break;

            case 'select': {
                const clickedNote = this.getNoteAtPosition(x, y);
                if (clickedNote !== null) {
                    if (e.shiftKey) {
                        if (this.selectedIds.has(clickedNote)) this.selectedIds.delete(clickedNote);
                        else this.selectedIds.add(clickedNote);
                    } else {
                        this.selectedIds.clear();
                        this.selectedIds.add(clickedNote);
                    }
                    this.dragStart = { x, y, ticks, velocity, initialVelocities: new Map() };
                    Array.from(this.selectedIds).forEach(index => {
                        if (index >= 0 && index < this.sequence.length) {
                            this.dragStart.initialVelocities.set(index, this.sequence[index].v || 100);
                        }
                    });
                } else {
                    if (!e.shiftKey) this.selectedIds.clear();
                    this.selectionStart = { x, y };
                }
                this.renderThrottled();
                break;
            }

            case 'move': {
                const moveNote = this.getNoteAtPosition(x, y);
                if (moveNote !== null) {
                    if (!this.selectedIds.has(moveNote)) {
                        this.selectedIds.clear();
                        this.selectedIds.add(moveNote);
                    }
                    this.dragStart = { x, y, ticks, velocity, initialVelocities: new Map() };
                    Array.from(this.selectedIds).forEach(index => {
                        if (index >= 0 && index < this.sequence.length) {
                            this.dragStart.initialVelocities.set(index, this.sequence[index].v || 100);
                        }
                    });
                }
                this.renderThrottled();
                break;
            }
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const velocity = this._yToValue(y);

        this.lastMouseX = x;
        this.lastMouseY = y;

        if (this.isDrawing && this.currentTool === 'draw') {
            const snappedTicks = this.snapToGrid(ticks);
            if (this.lastDrawTicks === null || Math.abs(snappedTicks - this.lastDrawTicks) >= this.options.grid) {
                const noteAtDraw = this.getNoteAtTick(ticks);
                if (noteAtDraw !== null) this.updateNoteVelocity(noteAtDraw, velocity);
                this.lastDrawTicks = snappedTicks;
                this.lastDrawPosition = { x, y };
                this.renderThrottled();
            }
        } else if (this.dragStart && (this.currentTool === 'select' || this.currentTool === 'move')) {
            if (this.selectedIds.size > 0) {
                const deltaVelocity = this._yToValue(y) - this.dragStart.velocity;
                Array.from(this.selectedIds).forEach(index => {
                    if (index >= 0 && index < this.sequence.length) {
                        const initial = this.dragStart.initialVelocities.get(index) || 100;
                        this.sequence[index].v = Math.max(1, Math.min(127, initial + deltaVelocity));
                    }
                });
                this.renderThrottled();
            }
        } else if (this.selectionStart || this.lineStart) {
            this.renderThrottled();
        }
    }

    handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
            this.saveState();
            this.notifyChange();
        }
        if (this.selectionStart) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this.selectInRect(this.selectionStart.x, this.selectionStart.y, x, y);
            this.selectionStart = null;
        }
        if (this.dragStart) {
            this.saveState();
            this.notifyChange();
            this.dragStart = null;
        }
        this.renderThrottled();
    }

    handleKeyDown(e) {
        if (!this.element || this.element.offsetParent === null) return;

        if (e.key === 'Escape') {
            this.selectedIds.clear();
            this.lineStart = null;
            this.renderThrottled();
        } else if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                this.undo();
                e.preventDefault();
            } else if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
                this.redo();
                e.preventDefault();
            } else if (e.key === 'a') {
                this.selectAll();
                e.preventDefault();
            }
        }
    }

    // =================================================================
    // Line creation
    // =================================================================

    createLine(startTicks, startVelocity, endTicks, endVelocity) {
        const minTicks = Math.min(startTicks, endTicks);
        const maxTicks = Math.max(startTicks, endTicks);
        const range = endTicks - startTicks;
        this.sequence.forEach((note, index) => {
            if (note.t >= minTicks && note.t <= maxTicks && this.activeChannels.has(note.c)) {
                const t = range !== 0 ? (note.t - startTicks) / range : 0;
                const v = Math.round(startVelocity + t * (endVelocity - startVelocity));
                this.sequence[index].v = Math.max(1, Math.min(127, v));
            }
        });
        this.saveState();
        this.notifyChange();
        this.renderThrottled();
    }

    // =================================================================
    // Render — overrides base.render() because Velocity's selection
    // rectangle uses (selectionStart + lastMouseX/Y) instead of the
    // base's selectionRect.{currentX,currentY}, and we need to draw a
    // line-preview overlay.
    // =================================================================

    render() {
        if (!this.ctx || this.canvas.width === 0 || this.canvas.height === 0) return;

        // Grid (buffer-cached).
        if (this.gridDirty) {
            this._renderGridToBuffer();
            this.gridDirty = false;
        }
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.gridCanvas) this.ctx.drawImage(this.gridCanvas, 0, 0);

        this._renderData();

        // Selection rect preview.
        if (this.selectionStart && this.lastMouseX !== undefined) {
            this._drawDashedRect(this.selectionStart.x, this.selectionStart.y,
                                 this.lastMouseX, this.lastMouseY,
                                 '#2196F3');
        }

        // Line preview (anchored at lineStart, follows the mouse).
        if (this.lineStart && this.lastMouseX !== undefined) {
            this.ctx.strokeStyle = '#9E9E9E';
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([5, 5]);
            this.ctx.beginPath();
            this.ctx.moveTo(this.ticksToX(this.lineStart.ticks),
                            this._valueToY(this.lineStart.velocity));
            this.ctx.lineTo(this.lastMouseX, this.lastMouseY);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
        }
    }

    _drawDashedRect(x1, y1, x2, y2, stroke) {
        this.ctx.strokeStyle = stroke;
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 5]);
        this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        this.ctx.setLineDash([]);
    }

    /**
     * Velocity-specific grid layout: same vertical (time) grid as base
     * but a 5-line value axis (0/32/64/96/127) with a heavier separator
     * on the label margin.
     */
    _renderGridToBuffer() {
        if (!this.gridCtx) return;
        const ctx = this.gridCtx;
        const labelMargin = this._labelMargin();
        const isDark = document.body.classList.contains('dark-mode');

        ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);

        // Vertical (time) grid.
        ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
        ctx.lineWidth = 1;
        const gridSize = this.options.grid;
        const startTick = Math.floor(this.options.xoffset / gridSize) * gridSize;
        const endTick = this.options.xoffset + this.options.xrange;
        for (let t = startTick; t <= endTick; t += gridSize) {
            const x = this.ticksToX(t);
            if (x >= 0 && x <= this.gridCanvas.width) {
                ctx.beginPath();
                ctx.moveTo(Math.max(x, labelMargin), 0);
                ctx.lineTo(x, this.gridCanvas.height);
                ctx.stroke();
            }
        }

        // Value-axis (velocity) grid + labels.
        const values = [0, 32, 64, 96, 127];
        ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
        ctx.lineWidth = 1;
        values.forEach(value => {
            const y = this._valueToY(value);
            ctx.beginPath();
            ctx.moveTo(labelMargin, y);
            ctx.lineTo(this.gridCanvas.width, y);
            ctx.stroke();
            ctx.fillStyle = isDark ? '#1a1a1a' : '#f0f4ff';
            ctx.fillRect(0, y - 7, labelMargin - 2, 14);
            ctx.fillStyle = isDark ? '#aaa' : '#5a6089';
            ctx.font = '11px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(value.toString(), labelMargin - 5, y + 4);
        });

        // Label-area separator.
        ctx.strokeStyle = isDark ? '#555' : '#b0b8e8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(labelMargin, 0);
        ctx.lineTo(labelMargin, this.gridCanvas.height);
        ctx.stroke();

        ctx.textAlign = 'left';
    }

    _renderData() {
        const ctx = this.ctx;
        const visStart = this.options.xoffset;
        const visEnd = this.options.xoffset + this.options.xrange;

        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;
            if (note.t + note.g < visStart || note.t > visEnd) continue;

            const velocity = note.v || 100;
            const x = this.ticksToX(note.t);
            const y = this._valueToY(velocity);
            const barWidth = Math.max(2, this.ticksToX(note.t + note.g) - x);
            const barHeight = this._valueToY(0) - y;

            const intensityRatio = velocity / 127;
            const hue = 120 + (240 - 120) * (1 - intensityRatio);
            const saturation = 60 + 40 * intensityRatio;
            const lightness = 40 + 20 * intensityRatio;
            const isSelected = this.selectedIds.has(i);

            ctx.fillStyle = isSelected
                ? `hsl(50, 100%, 60%)`
                : `hsl(${hue}, ${saturation}%, ${lightness}%)`;
            ctx.fillRect(x, y, barWidth, barHeight);

            if (isSelected) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, barWidth, barHeight);
            }
        }
    }

    /**
     * Override the base's history restore so a sequence-level snapshot
     * triggers the legacy onChange contract (the modal pipes it back
     * into pianoRoll.sequence).
     */
    notifyChange() {
        if (typeof this.options.onChange === 'function') {
            try { this.options.onChange(this.sequence); }
            catch (_) { /* best-effort */ }
        }
    }
}

if (typeof window !== 'undefined') {
    window.VelocityEditor = VelocityEditor;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VelocityEditor;
}
