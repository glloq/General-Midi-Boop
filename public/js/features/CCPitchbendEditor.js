/**
 * CCPitchbendEditor - Control Change and Pitchbend editor synchronized with the piano roll
 *
 * Features:
 * - Edit CC1, CC2, CC5, CC7, CC10, CC11, CC74, CC77, pitchbend
 * - Tools: select, move, line, continuous draw
 * - Horizontal synchronization with the piano roll
 * - Honors the time grid and zoom
 * - Filter by selected channel
 *
 * Extends BaseLaneEditor — shared scaffolding (constructor, listeners,
 * RAF, history, conversions, destroy) lives there; this file owns the
 * CC/pitchbend-specific data ops, hit-test, value clamping (different
 * for CC vs PB), staircase rendering, line preview with curves and the
 * cursor tooltip overlay.
 *
 * Public surface preserved for the MidiEditor consumers:
 *   - constructor(container, options)
 *   - setCC, setChannel, setNote, setCurveType, setDrawDensity, setTool
 *   - loadEvents, getEvents, clear, syncWith
 *   - selectedEvents (alias of base selectedIds)
 *   - events (read AND direct mutation in MidiEditorEditActions:287)
 *   - deleteSelected, resize, destroy, element, renderThrottled
 */

class CCPitchbendEditor extends BaseLaneEditor {
    constructor(container, options = {}) {
        super(container, options);

        this.events = [];

        this.currentCC = 'cc1'; // 'cc1'..'cc77', 'pitchbend', 'aftertouch', 'polyAftertouch'
        this.currentNote = null; // For poly aftertouch
        this.drawDensityMultiplier = 1;

        // Pixel cache for selection-rect preview (same pattern as
        // Velocity — selectionStart + last mouse pos).
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
        this.selectionStart = null;

        this.init();

        // The base's createUI() adds canvas + element. We need to layer
        // the tooltip overlay on top, in the same parent.
        this._installTooltip();
    }

    // -----------------------------------------------------------------
    // Back-compat alias
    // -----------------------------------------------------------------
    get selectedEvents() { return this.selectedIds; }

    // =================================================================
    // BaseLaneEditor hooks
    // =================================================================

    _className() { return 'cc-pitchbend-editor'; }
    _dataField() { return 'events'; }
    _idOf(item) { return item ? item.id : undefined; }

    _valueToY(value) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = this.currentCC === 'pitchbend'
            ? (value + 8192) / 16384
            : value / 127;
        return margin + drawH - (normalized * drawH);
    }

    _yToValue(y) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = 1 - ((y - margin) / drawH);
        if (this.currentCC === 'pitchbend') {
            return Math.max(-8192, Math.min(8191, Math.round(normalized * 16384 - 8192)));
        }
        return Math.max(0, Math.min(127, Math.round(normalized * 127)));
    }

    _installTooltip() {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'cc-editor-tooltip';
        this.tooltip.style.cssText = `
            position: absolute;
            background: rgba(0,0,0,0.85);
            color: #fff;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
            pointer-events: none;
            display: none;
            z-index: 10;
            white-space: nowrap;
        `;
        // Layer it inside the editor element (same parent as the canvas).
        if (this.element) this.element.appendChild(this.tooltip);
    }

    cancelInteractions() {
        super.cancelInteractions();
        this.selectionStart = null;
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
    }

    // =================================================================
    // Filter setters
    // =================================================================

    setCC(ccType) {
        this.currentCC = ccType;
        this.cancelInteractions();
        this.gridDirty = true; // Value-axis labels differ CC vs PB.
        this.renderThrottled();
    }

    setChannel(channel) {
        this.currentChannel = channel;
        this.cancelInteractions();
        this.renderThrottled();
    }

    setNote(note) {
        this.currentNote = note;
        this.cancelInteractions();
        this.renderThrottled();
    }

    setDrawDensity(multiplier) {
        this.drawDensityMultiplier = multiplier;
    }

    // =================================================================
    // Value clamping (depends on currentCC)
    // =================================================================

    clampValue(value) {
        return this.currentCC === 'pitchbend'
            ? Math.max(-8192, Math.min(8191, value))
            : Math.max(0, Math.min(127, value));
    }

    // =================================================================
    // Event mutations
    // =================================================================

    addEvent(ticks, value, channel = this.currentChannel, autoSave = true) {
        const snappedTicks = this.snapToGrid(ticks);
        const existing = this.events.find(e =>
            e.ticks === snappedTicks &&
            e.type === this.currentCC &&
            e.channel === channel
        );
        if (existing) {
            existing.value = this.clampValue(value);
            if (autoSave) this.renderThrottled();
            return existing;
        }

        const event = {
            type: this.currentCC,
            ticks: snappedTicks,
            value: this.clampValue(value),
            channel: channel,
            id: Date.now() + Math.random()
        };
        if (this.currentCC === 'polyAftertouch' && this.currentNote !== null) {
            event.note = this.currentNote;
        }
        this.events.push(event);

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

    moveEvents(eventIds, deltaTicks, deltaValue) {
        eventIds.forEach(id => {
            const event = this.events.find(e => e.id === id);
            if (event) {
                event.ticks = Math.max(0, this.snapToGrid(event.ticks + deltaTicks));
                event.value = this.clampValue(event.value + deltaValue);
            }
        });
        this.saveState();
        this.renderThrottled();
    }

    deleteSelected() {
        if (this.selectedIds.size === 0) return;
        this.events = this.events.filter(event => !this.selectedIds.has(event.id));
        this.selectedIds.clear();
        this.saveState();
        if (typeof this.options.onChange === 'function') {
            try { this.options.onChange(); } catch (_) { /* best-effort */ }
        }
        this.renderThrottled();
    }

    // =================================================================
    // Filtering
    // =================================================================

    getFilteredEvents() {
        return this.events.filter(event => {
            if (event.type !== this.currentCC || event.channel !== this.currentChannel) return false;
            if (this.currentCC === 'polyAftertouch' && this.currentNote !== null) {
                return event.note === this.currentNote;
            }
            return true;
        });
    }

    _getVisibleData() { return this.getFilteredEvents(); }

    // =================================================================
    // Hit-test
    // =================================================================

    getEventAtPosition(x, y, threshold = 5) {
        return this.getFilteredEvents().find(event => {
            const ex = this.ticksToX(event.ticks);
            const ey = this._valueToY(event.value);
            return Math.abs(ex - x) <= threshold && Math.abs(ey - y) <= threshold;
        });
    }

    selectInRect(x1, y1, x2, y2) {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        this.getFilteredEvents().forEach(event => {
            const ex = this.ticksToX(event.ticks);
            const ey = this._valueToY(event.value);
            if (ex >= left && ex <= right && ey >= top && ey <= bottom) {
                this.selectedIds.add(event.id);
            }
        });
    }

    selectAll() {
        this.selectedIds.clear();
        this.getFilteredEvents().forEach(event => this.selectedIds.add(event.id));
        this.renderThrottled();
    }

    // =================================================================
    // Tool handlers
    // =================================================================

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const value = this._yToValue(y);

        switch (this.currentTool) {
            case 'draw':
                this.isDrawing = true;
                this.lastDrawPosition = { x, y };
                this.lastDrawTicks = this.snapToGrid(ticks);
                this.addEvent(ticks, value, this.currentChannel, false);
                this.renderThrottled();
                break;

            case 'line':
                if (!this.lineStart) {
                    this.lineStart = { ticks, value };
                } else {
                    this.createLine(this.lineStart.ticks, this.lineStart.value, ticks, value);
                    this.lineStart = null;
                }
                break;

            case 'select': {
                const clicked = this.getEventAtPosition(x, y);
                if (clicked) {
                    if (e.shiftKey) {
                        if (this.selectedIds.has(clicked.id)) this.selectedIds.delete(clicked.id);
                        else this.selectedIds.add(clicked.id);
                    } else {
                        this.selectedIds.clear();
                        this.selectedIds.add(clicked.id);
                    }
                    this.dragStart = { x, y, ticks, value };
                } else {
                    if (!e.shiftKey) this.selectedIds.clear();
                    this.selectionStart = { x, y };
                }
                this.renderThrottled();
                break;
            }

            case 'move': {
                const moveEvent = this.getEventAtPosition(x, y);
                if (moveEvent) {
                    if (!this.selectedIds.has(moveEvent.id)) {
                        this.selectedIds.clear();
                        this.selectedIds.add(moveEvent.id);
                    }
                    this.dragStart = { x, y, ticks, value };
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
        const value = this._yToValue(y);

        this.lastMouseX = x;
        this.lastMouseY = y;

        if (this.isDrawing && this.currentTool === 'draw') {
            const snappedTicks = this.snapToGrid(ticks);
            const advanced = this.lastDrawTicks === null
                || Math.abs(snappedTicks - this.lastDrawTicks) >= this.options.grid * this.drawDensityMultiplier;
            if (advanced) {
                this.addEvent(ticks, value, this.currentChannel, false);
                this.lastDrawTicks = snappedTicks;
                this.lastDrawPosition = { x, y };
                this.renderThrottled();
            }
        } else if (this.dragStart && (this.currentTool === 'select' || this.currentTool === 'move')) {
            if (this.selectedIds.size > 0) {
                const deltaTicks = this.xToTicks(x) - this.dragStart.ticks;
                const deltaValue = this._yToValue(y) - this.dragStart.value;
                Array.from(this.selectedIds).forEach(id => {
                    const event = this.events.find(ev => ev.id === id);
                    if (event) {
                        event.ticks = Math.max(0, this.snapToGrid(event.ticks + deltaTicks));
                        event.value = this.clampValue(event.value + deltaValue);
                    }
                });
                this.dragStart = { x, y, ticks, value };
                this.renderThrottled();
            }
        } else if (this.selectionStart || this.lineStart) {
            this.renderThrottled();
        }

        this.updateTooltip(x, y, ticks, value);
    }

    handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
            this.saveState();
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
            this.dragStart = null;
        }
        this.renderThrottled();
    }

    handleMouseLeave(e) {
        this.handleMouseUp(e);
        if (this.tooltip) this.tooltip.style.display = 'none';
    }

    handleKeyDown(e) {
        if (!this.element || this.element.offsetParent === null) return;

        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedIds.size > 0) {
            this.removeEvents(Array.from(this.selectedIds));
        } else if (e.key === 'Escape') {
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

    updateTooltip(x, y, ticks, value) {
        if (!this.tooltip) return;
        let valueStr;
        switch (this.currentCC) {
            case 'pitchbend':       valueStr = `PB: ${value}`;  break;
            case 'aftertouch':      valueStr = `AT: ${value}`;  break;
            case 'polyAftertouch':  valueStr = `PAT: ${value}`; break;
            default:                valueStr = `Val: ${value}`;
        }
        const ppq = this.options.timebase || 480;
        const beat = Math.floor(ticks / ppq);
        const measure = Math.floor(beat / 4) + 1;
        const beatInMeasure = (beat % 4) + 1;
        const tickInBeat = ticks % ppq;
        const timeStr = `${measure}:${beatInMeasure}:${String(tickInBeat).padStart(3, '0')}`;

        this.tooltip.textContent = `${timeStr}  ${valueStr}`;
        this.tooltip.style.display = 'block';
        this.tooltip.style.left = `${x + 12}px`;
        this.tooltip.style.top = `${y - 24}px`;
    }

    // =================================================================
    // Line creation with curves
    // =================================================================

    createLine(startTicks, startValue, endTicks, endValue) {
        const minTicks = Math.min(startTicks, endTicks);
        const maxTicks = Math.max(startTicks, endTicks);
        const ticksRange = maxTicks - minTicks;
        const valueRange = endValue - startValue;

        for (let t = minTicks; t <= maxTicks; t += this.options.grid) {
            const progress = ticksRange > 0 ? (t - minTicks) / ticksRange : 0;
            const curveProgress = this.applyCurve(progress);
            const value = Math.round(startValue + valueRange * curveProgress);
            this.addEvent(t, value, this.currentChannel, false);
        }

        const lastGridTick = Math.floor((maxTicks - minTicks) / this.options.grid) * this.options.grid + minTicks;
        if (lastGridTick < maxTicks) {
            this.addEvent(maxTicks, Math.round(startValue + valueRange * (ticksRange > 0 ? 1 : 0)), this.currentChannel, false);
        }

        this.saveState();
        this.renderThrottled();
    }

    // =================================================================
    // Sync
    // =================================================================

    syncWith(pianoRoll) {
        const oldXRange = this.options.xrange;
        const oldXOffset = this.options.xoffset;
        const oldGrid = this.options.grid;

        this.options.xrange = pianoRoll.xrange;
        this.options.xoffset = pianoRoll.xoffset;
        this.options.grid = pianoRoll.grid;
        this.options.timebase = pianoRoll.timebase;

        if (oldXRange !== this.options.xrange
            || oldXOffset !== this.options.xoffset
            || oldGrid !== this.options.grid) {
            this.gridDirty = true;
        }
        this.renderThrottled();
    }

    // =================================================================
    // Import / Export
    // =================================================================

    loadEvents(events) {
        this.events = events.map(e => ({
            ...e,
            id: e.id || (Date.now() + Math.random())
        }));
        // Initialize history without triggering onChange (loading existing
        // events is not a user modification).
        this.history = [JSON.stringify(this.events)];
        this.historyIndex = 0;
        this.renderThrottled();
    }

    getEvents() { return this.events; }

    clear() {
        this.events = [];
        this.selectedIds.clear();
        this.history = [JSON.stringify(this.events)];
        this.historyIndex = 0;
        this.renderThrottled();
        if (typeof this.options.onChange === 'function') {
            try { this.options.onChange(); } catch (_) { /* best-effort */ }
        }
    }

    // =================================================================
    // Render — overrides base.render() to add the staircase rendering,
    // center line, selection rect (selectionStart + lastMouseX/Y), and
    // line preview with curve interpolation.
    // =================================================================

    render() {
        if (!this.ctx || !this.canvas) return;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.gridDirty || !this.gridCanvas) {
            this._renderGridToBuffer();
            this.gridDirty = false;
        }
        if (this.gridCanvas) this.ctx.drawImage(this.gridCanvas, 0, 0);

        this._renderCenterLine();
        this._renderData();

        // Selection rect preview.
        if (this.selectionStart && this.lastMouseX !== undefined) {
            this.ctx.strokeStyle = '#2196F3';
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([5, 5]);
            this.ctx.strokeRect(this.selectionStart.x, this.selectionStart.y,
                                this.lastMouseX - this.selectionStart.x,
                                this.lastMouseY - this.selectionStart.y);
            this.ctx.setLineDash([]);
        }

        // Line preview with curve.
        if (this.lineStart && this.lastMouseX !== undefined) {
            const endTicks = this.xToTicks(this.lastMouseX);
            const endValue = this._yToValue(this.lastMouseY);
            this.ctx.strokeStyle = '#9E9E9E';
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([5, 5]);
            this.ctx.beginPath();
            const segments = 30;
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const curveT = this.applyCurve(t);
                const ticks = this.lineStart.ticks + (endTicks - this.lineStart.ticks) * t;
                const value = this.lineStart.value + (endValue - this.lineStart.value) * curveT;
                const x = this.ticksToX(ticks);
                const y = this._valueToY(value);
                if (i === 0) this.ctx.moveTo(x, y);
                else        this.ctx.lineTo(x, y);
            }
            this.ctx.stroke();
            this.ctx.setLineDash([]);
        }
    }

    _renderCenterLine() {
        const filteredEvents = this.getFilteredEvents();
        const labelMargin = this._labelMargin();
        const isDark = document.body.classList.contains('dark-mode');

        if (this.currentCC === 'pitchbend') {
            this.ctx.strokeStyle = isDark ? '#888' : '#667eea';
            this.ctx.lineWidth = 2;
            const y = this._valueToY(0);
            this.ctx.beginPath();
            this.ctx.moveTo(labelMargin, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        } else if (filteredEvents.length === 0) {
            this.ctx.strokeStyle = isDark ? '#666' : '#8898d8';
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([5, 5]);
            const y = this._valueToY(0);
            this.ctx.beginPath();
            this.ctx.moveTo(labelMargin, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
        }
    }

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

        // Value-axis grid + labels.
        const values = this.currentCC === 'pitchbend'
            ? [-8192, -4096, 0, 4096, 8191]
            : [0, 32, 64, 96, 127];
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
        const allEvents = this.getFilteredEvents().sort((a, b) => a.ticks - b.ticks);

        // Viewport culling (+1 boundary event so connecting line stays).
        const visStart = this.options.xoffset;
        const visEnd = this.options.xoffset + this.options.xrange;
        let firstVisible = 0;
        let lastVisible = allEvents.length - 1;
        for (let i = 0; i < allEvents.length; i++) {
            if (allEvents[i].ticks >= visStart) {
                firstVisible = Math.max(0, i - 1);
                break;
            }
        }
        for (let i = allEvents.length - 1; i >= 0; i--) {
            if (allEvents[i].ticks <= visEnd) {
                lastVisible = Math.min(allEvents.length - 1, i + 1);
                break;
            }
        }
        const events = allEvents.slice(firstVisible, lastVisible + 1);

        // Staircase polyline.
        if (events.length > 1) {
            this.ctx.strokeStyle = '#4CAF50';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            events.forEach((event, i) => {
                const x = this.ticksToX(event.ticks);
                const y = this._valueToY(event.value);
                if (i === 0) {
                    this.ctx.moveTo(x, y);
                } else {
                    const prev = events[i - 1];
                    const prevY = this._valueToY(prev.value);
                    this.ctx.lineTo(x, prevY);
                    this.ctx.lineTo(x, y);
                }
            });
            this.ctx.stroke();
        } else if (events.length === 1) {
            this.ctx.strokeStyle = '#4CAF50';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            const x = this.ticksToX(events[0].ticks);
            const y = this._valueToY(events[0].value);
            this.ctx.moveTo(x, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        }

        // Points.
        events.forEach(event => {
            const x = this.ticksToX(event.ticks);
            const y = this._valueToY(event.value);
            const isSelected = this.selectedIds.has(event.id);
            this.ctx.fillStyle = isSelected ? '#FFC107' : '#4CAF50';
            this.ctx.beginPath();
            this.ctx.arc(x, y, isSelected ? 5 : 3, 0, 2 * Math.PI);
            this.ctx.fill();
        });
    }

    // The legacy notifyChange contract (CC's `_doSaveState` used to emit
    // `onChange()` with NO args; preserve that for back-compat).
    notifyChange() {
        if (typeof this.options.onChange === 'function') {
            try { this.options.onChange(); } catch (_) { /* best-effort */ }
        }
    }
}

if (typeof window !== 'undefined') {
    window.CCPitchbendEditor = CCPitchbendEditor;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CCPitchbendEditor;
}
