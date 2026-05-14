/**
 * TempoEditor - Tempo curve editor synchronized with the piano roll
 *
 * Features:
 * - Edit tempo changes over time (tempo map)
 * - Tools: select, move, curved line, continuous draw
 * - Curve types: linear, exponential, logarithmic, sinusoidal
 * - Horizontal synchronization with the piano roll
 * - Honors the time grid and zoom
 *
 * Extends BaseLaneEditor — shared scaffolding (constructor, RAF, history,
 * grid, listeners, destroy) lives there; this file owns the tempo-specific
 * data ops, hit-test, value↔Y mapping and glyph rendering.
 *
 * Public surface preserved for back-compat with MidiEditorCCPicker:
 *   - constructor(container, options)
 *   - setTool, setCurveType, setEvents, getEvents, setXRange/Offset/Grid
 *   - selectedEvents (alias of base `selectedIds`)
 *   - removeEvents, resize, destroy, element, canvas
 */

// eslint-disable-next-line no-unused-vars
class TempoEditor extends BaseLaneEditor {
    constructor(container, options = {}) {
        super(container, {
            minTempo: options.minTempo || 20,
            maxTempo: options.maxTempo || 300,
            ...options
        });

        // Visible vertical range (scrollable subset of min/max).
        this.viewMinTempo = this.options.minTempo;
        this.viewMaxTempo = this.options.maxTempo;
        this.viewRange = 80;

        this.events = [];

        // History cap matches the legacy value (20 instead of base's 50)
        // — tempo edits are tiny snapshots but kept tighter historically.
        this.historyCap = 20;

        this.init();
    }

    // -----------------------------------------------------------------
    // Back-compat alias — existing call sites use `selectedEvents`.
    // -----------------------------------------------------------------
    get selectedEvents() { return this.selectedIds; }

    // =================================================================
    // BaseLaneEditor hooks
    // =================================================================

    _className() { return 'tempo-editor'; }
    _dataField() { return 'events'; }
    _idOf(item)  { return item.id; }
    _ticksOf(item) { return item.ticks; }
    _valueOf(item) { return item.tempo; }

    _valueToY(tempo) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = (tempo - this.viewMinTempo) / (this.viewMaxTempo - this.viewMinTempo);
        return margin + drawH - (normalized * drawH);
    }

    _yToValue(y) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = 1 - ((y - margin) / drawH);
        return Math.round(normalized * (this.viewMaxTempo - this.viewMinTempo) + this.viewMinTempo);
    }

    _onHistoryRestore() {
        // Keep events sorted (the snapshot already is, but be safe).
        this.events.sort((a, b) => a.ticks - b.ticks);
    }

    _attachExtraListeners() {
        this._boundWheel = (e) => this._handleWheel(e);
        this.canvas.addEventListener('wheel', this._boundWheel, { passive: false });
    }

    _detachExtraListeners() {
        if (this.canvas && this._boundWheel) {
            this.canvas.removeEventListener('wheel', this._boundWheel);
        }
    }

    // Convenience aliases kept for clarity in this file's own methods.
    tempoToY(tempo) { return this._valueToY(tempo); }
    yToTempo(y)     { return this._yToValue(y); }

    // =================================================================
    // Tempo-specific value clamping
    // =================================================================

    clampTempo(tempo) {
        return Math.max(this.options.minTempo, Math.min(this.options.maxTempo, tempo));
    }

    // =================================================================
    // Event mutations
    // =================================================================

    addEvent(ticks, tempo, autoSave = true) {
        const snappedTicks = this.snapToGrid(ticks);

        const existing = this.events.find(e => e.ticks === snappedTicks);
        if (existing) {
            existing.tempo = this.clampTempo(tempo);
            if (autoSave) {
                this.saveState();
                this.renderThrottled();
            }
            return existing;
        }

        const event = {
            ticks: snappedTicks,
            tempo: this.clampTempo(tempo),
            id: Date.now() + Math.random()
        };
        this.events.push(event);
        this.events.sort((a, b) => a.ticks - b.ticks);

        if (autoSave) {
            this.saveState();
            this.renderThrottled();
        }
        return event;
    }

    removeEvents(eventIds) {
        this.events = this.events.filter(e => !eventIds.includes(e.id));
        this.selectedIds.clear();
        this.saveState();
        this.renderThrottled();
    }

    moveEvents(eventIds, deltaTicks, deltaTempo) {
        eventIds.forEach(id => {
            const event = this.events.find(e => e.id === id);
            if (event) {
                event.ticks = Math.max(0, this.snapToGrid(event.ticks + deltaTicks));
                event.tempo = this.clampTempo(event.tempo + deltaTempo);
            }
        });
        this.events.sort((a, b) => a.ticks - b.ticks);
        this.saveState();
        this.renderThrottled();
    }

    // =================================================================
    // Input handlers — semantics unchanged from the pre-refactor file.
    // =================================================================

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const tempo = this.yToTempo(y);

        switch (this.currentTool) {
            case 'draw':
                this.isDrawing = true;
                this.lastDrawPosition = { x, y };
                this.lastDrawTicks = this.snapToGrid(ticks);
                this.addEvent(ticks, tempo, false);
                this.renderThrottled();
                break;

            case 'line':
                if (!this.lineStart) {
                    this.lineStart = { ticks, tempo };
                } else {
                    this.createLine(this.lineStart.ticks, this.lineStart.tempo, ticks, tempo);
                    this.lineStart = null;
                }
                break;

            case 'select': {
                const clickedEvent = this.findEventAt(ticks, tempo);
                if (clickedEvent) {
                    if (e.shiftKey) {
                        if (this.selectedIds.has(clickedEvent.id)) {
                            this.selectedIds.delete(clickedEvent.id);
                        } else {
                            this.selectedIds.add(clickedEvent.id);
                        }
                    } else {
                        this.selectedIds.clear();
                        this.selectedIds.add(clickedEvent.id);
                    }
                } else {
                    if (!e.shiftKey) this.selectedIds.clear();
                    this.selectionRect = { x, y };
                }
                this.renderThrottled();
                break;
            }

            case 'move': {
                const eventToMove = this.findEventAt(ticks, tempo);
                if (eventToMove) {
                    if (!this.selectedIds.has(eventToMove.id)) {
                        this.selectedIds.clear();
                        this.selectedIds.add(eventToMove.id);
                    }
                    this.dragStart = { ticks, tempo };
                }
                break;
            }
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const tempo = this.yToTempo(y);

        if (this.isDrawing && this.currentTool === 'draw') {
            const snappedTicks = this.snapToGrid(ticks);
            if (snappedTicks !== this.lastDrawTicks) {
                this.addEvent(ticks, tempo, false);
                this.lastDrawTicks = snappedTicks;
                this.renderThrottled();
            }
        } else if (this.dragStart && this.currentTool === 'move') {
            const deltaTicks = this.snapToGrid(ticks - this.dragStart.ticks);
            const deltaTempo = Math.round(tempo - this.dragStart.tempo);
            if (deltaTicks !== 0 || deltaTempo !== 0) {
                this.moveEvents(Array.from(this.selectedIds), deltaTicks, deltaTempo);
                this.dragStart = { ticks, tempo };
            }
        } else if (this.selectionRect) {
            this.selectionRect.currentX = x;
            this.selectionRect.currentY = y;
            this.renderThrottled();
        }
    }

    handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.saveState();
        }
        if (this.selectionRect) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this.selectInRect(this.selectionRect.x, this.selectionRect.y, x, y);
            this.selectionRect = null;
            this.renderThrottled();
        }
        if (this.dragStart) {
            this.saveState();
            this.notifyChange();
            this.dragStart = null;
        }
    }

    _handleWheel(e) {
        if (!e.shiftKey) {
            e.preventDefault();
            const step = e.deltaY > 0 ? -5 : 5;
            const range = this.viewMaxTempo - this.viewMinTempo;
            this.viewMinTempo = Math.max(this.options.minTempo, this.viewMinTempo + step);
            this.viewMaxTempo = this.viewMinTempo + range;
            if (this.viewMaxTempo > this.options.maxTempo) {
                this.viewMaxTempo = this.options.maxTempo;
                this.viewMinTempo = this.viewMaxTempo - range;
            }
            this.gridDirty = true;
            this.renderThrottled();
        }
    }

    autoFitView() {
        if (this.events.length === 0) {
            this.viewMinTempo = 80;
            this.viewMaxTempo = 160;
        } else {
            let min = Infinity, max = -Infinity;
            for (const ev of this.events) {
                if (ev.tempo < min) min = ev.tempo;
                if (ev.tempo > max) max = ev.tempo;
            }
            const padding = Math.max(10, (max - min) * 0.2);
            this.viewMinTempo = Math.max(this.options.minTempo, Math.floor(min - padding));
            this.viewMaxTempo = Math.min(this.options.maxTempo, Math.ceil(max + padding));
            if (this.viewMaxTempo - this.viewMinTempo < 20) {
                const center = (this.viewMinTempo + this.viewMaxTempo) / 2;
                this.viewMinTempo = Math.max(this.options.minTempo, center - 10);
                this.viewMaxTempo = Math.min(this.options.maxTempo, center + 10);
            }
        }
        this.gridDirty = true;
        this.renderThrottled();
    }

    handleKeyDown(e) {
        if (!this.element || this.element.offsetParent === null) return;
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedIds.size > 0) {
            e.preventDefault();
            this.removeEvents(Array.from(this.selectedIds));
        } else if (e.key === 'Escape') {
            this.cancelInteractions();
            this.selectedIds.clear();
            this.renderThrottled();
        } else if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                e.preventDefault();
                this.undo();
            } else if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
                e.preventDefault();
                this.redo();
            } else if (e.key === 'a') {
                e.preventDefault();
                this.selectAll();
            }
        }
    }

    // =================================================================
    // Hit-test (euclidean distance, pixel-space, threshold 20 px)
    // =================================================================

    findEventAt(ticks, tempo) {
        const threshold = 20;
        const cx = this.ticksToX(ticks);
        const cy = this.tempoToY(tempo);
        for (const event of this.events) {
            const ex = this.ticksToX(event.ticks);
            const ey = this.tempoToY(event.tempo);
            const dx = ex - cx;
            const dy = ey - cy;
            if ((dx * dx + dy * dy) < threshold * threshold) return event;
        }
        return null;
    }

    // =================================================================
    // Line creation with curves
    // =================================================================

    createLine(startTicks, startTempo, endTicks, endTempo) {
        const minTicks = Math.min(startTicks, endTicks);
        const maxTicks = Math.max(startTicks, endTicks);
        const ticksRange = maxTicks - minTicks;
        const tempoRange = endTempo - startTempo;

        for (let t = minTicks; t <= maxTicks; t += this.options.grid) {
            const progress = ticksRange > 0 ? (t - minTicks) / ticksRange : 0;
            const curveProgress = this.applyCurve(progress);
            const tempo = Math.round(startTempo + tempoRange * curveProgress);
            this.addEvent(t, tempo, false);
        }

        this.saveState();
        this.renderThrottled();
    }

    // =================================================================
    // Render hooks
    // =================================================================

    /** Value-axis (tempo) grid lines + labels in the buffer canvas. */
    _renderHorizontalGrid(ctx, isDark) {
        const labelMargin = this._labelMargin();
        const tempoStep = 20; // 20 BPM per line
        const firstLine = Math.floor(this.viewMinTempo / tempoStep) * tempoStep;
        const lastLine = Math.ceil(this.viewMaxTempo / tempoStep) * tempoStep;

        for (let tempo = firstLine; tempo <= lastLine; tempo += tempoStep) {
            const y = this.tempoToY(tempo);
            if (y < 0 || y > this.gridCanvas.height) continue;

            const isDefault = tempo === 120;
            ctx.strokeStyle = isDark
                ? (isDefault ? '#444' : '#2a2a2a')
                : (isDefault ? '#b0b8e8' : '#e8ecff');
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(labelMargin, y);
            ctx.lineTo(this.gridCanvas.width, y);
            ctx.stroke();

            ctx.fillStyle = isDark
                ? (isDefault ? '#aaa' : '#666')
                : (isDefault ? '#5a6089' : '#9498b8');
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`${tempo}`, labelMargin - 5, y + 4);
        }
        ctx.textAlign = 'left';
    }

    _renderCenterLine() {
        const isDark = document.body.classList.contains('dark-mode');
        const y = this.tempoToY(120);
        this.ctx.strokeStyle = isDark ? '#555' : '#b0b8e8';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 5]);
        this.ctx.beginPath();
        this.ctx.moveTo(0, y);
        this.ctx.lineTo(this.canvas.width, y);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
    }

    _renderData() {
        if (this.events.length === 0) return;

        // Polyline through tempo points.
        this.ctx.strokeStyle = '#00bfff';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.events.forEach((event, index) => {
            const x = this.ticksToX(event.ticks);
            const y = this.tempoToY(event.tempo);
            if (index === 0) this.ctx.moveTo(x, y);
            else            this.ctx.lineTo(x, y);
        });
        this.ctx.stroke();

        // Points.
        this.events.forEach(event => {
            const x = this.ticksToX(event.ticks);
            const y = this.tempoToY(event.tempo);
            const isSelected = this.selectedIds.has(event.id);

            this.ctx.fillStyle = isSelected ? '#ffff00' : '#00bfff';
            this.ctx.beginPath();
            this.ctx.arc(x, y, isSelected ? 6 : 4, 0, Math.PI * 2);
            this.ctx.fill();
            if (isSelected) {
                this.ctx.strokeStyle = '#ffffff';
                this.ctx.lineWidth = 2;
                this.ctx.stroke();
            }
        });
    }

    // =================================================================
    // Synchronization API used by MidiEditorCCPicker
    // =================================================================

    setEvents(events) {
        this.events = events || [];
        this.selectedIds.clear();
        this.autoFitView();
    }

    getEvents() {
        return this.events;
    }
}

if (typeof window !== 'undefined') {
    window.TempoEditor = TempoEditor;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TempoEditor;
}
