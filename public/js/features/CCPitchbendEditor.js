/**
 * CCPitchbendEditor - Control Change and Pitchbend editor synchronized with the piano roll
 *
 * Features:
 * - Edit CC1, CC2, CC5, CC7, CC10, CC11, CC74, CC77, pitchbend
 * - Tools: select, move, line, continuous draw
 * - Horizontal synchronization with the piano roll
 * - Honors the time grid and zoom
 * - Filter by selected channel
 */

class CCPitchbendEditor {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            height: options.height || (typeof MidiEditorConstants !== 'undefined' ? MidiEditorConstants.defaultEditorHeight : 150),
            timebase: options.timebase || 480, // PPQ
            xrange: options.xrange || 1920,
            xoffset: options.xoffset || 0,
            grid: options.grid || 15,
            onChange: options.onChange || null, // Callback invoked on changes
            ...options
        };

        // Editor state
        this.events = []; // CC and pitchbend events
        this.selectedEvents = new Set();
        this.currentTool = 'select'; // 'select', 'move', 'line', 'draw'
        this.currentCC = 'cc1'; // 'cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc77', 'pitchbend'
        this.currentChannel = 0;
        this.currentNote = null; // For poly aftertouch: filtered note
        this.curveType = 'linear'; // Curve type for the line tool: 'linear', 'exponential', 'logarithmic', 'sine'
        this.drawDensityMultiplier = 1; // Point density multiplier: <1 = denser, >1 = sparser
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null; // Last tick where a point was created in draw mode

        // History for undo/redo
        this.history = [];
        this.historyIndex = -1;

        // OPTIMIZATION: Render throttling system
        this.pendingRender = false;
        this.renderScheduled = false;
        this.isDirty = false;

        // Buffer canvas for the grid (static)
        this.gridCanvas = null;
        this.gridCtx = null;
        this.gridDirty = true;

        // Initialization
        this.init();
    }

    init() {
        this.createUI();
        this.setupEventListeners();
    }

    createUI() {
        // Main container
        this.element = document.createElement('div');
        this.element.className = 'cc-pitchbend-editor';
        const isDark = document.body.classList.contains('dark-mode');
        this.element.style.cssText = `
            width: 100%;
            flex: 1;
            display: flex;
            flex-direction: column;
            background: ${isDark ? '#1a1a1a' : '#f0f4ff'};
            border-top: 1px solid ${isDark ? '#333' : '#d4daff'};
            position: relative;
            overflow: hidden;
            min-height: 0;
        `;

        // Canvas for rendering
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            cursor: crosshair;
        `;
        this.ctx = this.canvas.getContext('2d');

        // Overlay for interactions
        this.overlay = document.createElement('div');
        this.overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            pointer-events: none;
        `;

        // Tooltip to show the value under the cursor
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

        this.element.appendChild(this.canvas);
        this.element.appendChild(this.overlay);
        this.element.appendChild(this.tooltip);
        this.container.appendChild(this.element);

        // Resize the canvas
        this.resize();
    }

    setupEventListeners() {
        // Store bound references so we can remove them in destroy()
        this._boundMouseDown = this.handleMouseDown.bind(this);
        this._boundMouseMove = (e) => {
            if (this._mouseMoveRAF) return;
            this._mouseMoveRAF = requestAnimationFrame(() => {
                this._mouseMoveRAF = null;
                this.handleMouseMove(e);
            });
        };
        this._boundMouseUp = this.handleMouseUp.bind(this);
        this._boundMouseLeave = this.handleMouseLeave.bind(this);
        this._boundKeyDown = this.handleKeyDown.bind(this);
        this._boundResize = this.resize.bind(this);
        this._boundThemeChanged = () => this._onThemeChanged();

        // Mouse events (mousemove throttled via rAF)
        this.canvas.addEventListener('mousedown', this._boundMouseDown);
        this.canvas.addEventListener('mousemove', this._boundMouseMove);
        this.canvas.addEventListener('mouseup', this._boundMouseUp);
        this.canvas.addEventListener('mouseleave', this._boundMouseLeave);

        // Keyboard events
        document.addEventListener('keydown', this._boundKeyDown);

        // Resize
        window.addEventListener('resize', this._boundResize);

        // Theme change
        document.addEventListener('theme-changed', this._boundThemeChanged);
    }

    _onThemeChanged() {
        const isDark = document.body.classList.contains('dark-mode');
        if (this.element) {
            this.element.style.background = isDark ? '#1a1a1a' : '#f0f4ff';
            this.element.style.borderTopColor = isDark ? '#333' : '#d4daff';
        }
        this.gridDirty = true;
        this.scheduleRender();
    }

    resize() {
        // FIX: Force reflow of the full cascade (container parents + element)
        if (this.container) {
            void this.container.offsetHeight;
        }
        if (this.container && this.container.parentElement) {
            void this.container.parentElement.offsetHeight;
        }
        void this.element.offsetHeight;

        const rect = this.element.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        // Only resize when we have valid dimensions
        if (width > 0 && height > 100) {
            // Store the old height to detect major changes
            const oldHeight = this.canvas.height;

            this.canvas.width = width;
            this.canvas.height = height;

            // OPTIMIZATION: Recreate the grid buffer canvas
            if (!this.gridCanvas) {
                this.gridCanvas = document.createElement('canvas');
                this.gridCtx = this.gridCanvas.getContext('2d');
            }
            this.gridCanvas.width = width;
            this.gridCanvas.height = height;
            this.gridDirty = true;

            // Canvas resized

            this.renderThrottled();

            // FIX: Verify the height is stable after 1 frame
            if (oldHeight > 0 && Math.abs(height - oldHeight) > 50) {
                // Significant change detected, verify stability
                requestAnimationFrame(() => {
                    const newHeight = this.element.getBoundingClientRect().height;
                    if (Math.abs(newHeight - height) > 2) {
                        this.resize();  // Re-run with the real height
                    }
                });
            }
        }
    }

    // === Tool management ===

    setTool(tool) {
        this.currentTool = tool;
        this.canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
    }

    setCC(ccType) {
        this.currentCC = ccType;
        this.cancelInteractions(); // Cancel ongoing actions when the CC type changes
        this.gridDirty = true; // Force grid re-render (different labels for CC vs pitchbend)
        this.isDirty = true;
        this.renderThrottled();
    }

    setChannel(channel) {
        this.currentChannel = channel;
        this.cancelInteractions(); // Cancel ongoing actions when the channel changes
        this.isDirty = true;
        this.renderThrottled();
    }

    setNote(note) {
        this.currentNote = note;
        this.cancelInteractions();
        this.isDirty = true;
        this.renderThrottled();
    }

    setCurveType(curveType) {
        this.curveType = curveType;
    }

    setDrawDensity(multiplier) {
        this.drawDensityMultiplier = multiplier;
    }

    applyCurve(t) {
        switch (this.curveType) {
            case 'linear': return t;
            case 'exponential': return t * t;
            case 'logarithmic': return Math.sqrt(t);
            case 'sine': return (1 - Math.cos(t * Math.PI)) / 2;
            default: return t;
        }
    }

    cancelInteractions() {
        // Cancel all ongoing interactions
        this.lineStart = null;
        this.selectionStart = null;
        this.dragStart = null;
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null;
    }

    // === Coordinate conversion ===

    ticksToX(ticks) {
        return ((ticks - this.options.xoffset) / this.options.xrange) * this.canvas.width;
    }

    xToTicks(x) {
        return Math.round((x / this.canvas.width) * this.options.xrange + this.options.xoffset);
    }

    valueToY(value) {
        // For CC: 0-127 → bottom to top
        // For pitchbend: -8192 to 8191 → bottom to top (16384 values)
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        let normalized;
        if (this.currentCC === 'pitchbend') {
            normalized = (value + 8192) / 16384;
        } else {
            normalized = value / 127;
        }
        return margin + drawH - (normalized * drawH);
    }

    yToValue(y) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = 1 - ((y - margin) / drawH);
        if (this.currentCC === 'pitchbend') {
            return Math.max(-8192, Math.min(8191, Math.round(normalized * 16384 - 8192)));
        } else {
            return Math.max(0, Math.min(127, Math.round(normalized * 127)));
        }
    }

    snapToGrid(ticks) {
        const gridSize = this.options.grid;
        return Math.round(ticks / gridSize) * gridSize;
    }

    // === Event management ===

    addEvent(ticks, value, channel = this.currentChannel, autoSave = true) {
        const snappedTicks = this.snapToGrid(ticks);

        // Check whether an event already exists at this tick (to avoid duplicates)
        const existingEvent = this.events.find(e =>
            e.ticks === snappedTicks &&
            e.type === this.currentCC &&
            e.channel === channel
        );

        if (existingEvent) {
            // Update the existing value
            existingEvent.value = this.clampValue(value);
            if (autoSave) {
                this.renderThrottled();
            }
            return existingEvent;
        }

        const event = {
            type: this.currentCC,
            ticks: snappedTicks,
            value: this.clampValue(value),
            channel: channel,
            id: Date.now() + Math.random()
        };
        // For poly aftertouch, attach the current note
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
        this.selectedEvents.clear();
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

    clampValue(value) {
        if (this.currentCC === 'pitchbend') {
            return Math.max(-8192, Math.min(8191, value));
        } else {
            return Math.max(0, Math.min(127, value));
        }
    }

    // === Editing tools ===

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const value = this.yToValue(y);

        switch (this.currentTool) {
            case 'draw':
                this.isDrawing = true;
                this.lastDrawPosition = { x, y };
                this.lastDrawTicks = this.snapToGrid(ticks);
                this.addEvent(ticks, value, this.currentChannel, false); // Do not save immediately
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
                const clickedEvent = this.getEventAtPosition(x, y);
                if (clickedEvent) {
                    if (e.shiftKey) {
                        if (this.selectedEvents.has(clickedEvent.id)) {
                            this.selectedEvents.delete(clickedEvent.id);
                        } else {
                            this.selectedEvents.add(clickedEvent.id);
                        }
                    } else {
                        this.selectedEvents.clear();
                        this.selectedEvents.add(clickedEvent.id);
                    }
                    this.dragStart = { x, y, ticks, value };
                } else {
                    if (!e.shiftKey) {
                        this.selectedEvents.clear();
                    }
                    this.selectionStart = { x, y };
                }
                this.renderThrottled();
                break;
            }

            case 'move': {
                const moveEvent = this.getEventAtPosition(x, y);
                if (moveEvent) {
                    if (!this.selectedEvents.has(moveEvent.id)) {
                        this.selectedEvents.clear();
                        this.selectedEvents.add(moveEvent.id);
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
        const value = this.yToValue(y);

        if (this.isDrawing && this.currentTool === 'draw') {
            // Continuous draw - only create a point if we've advanced at least one grid tick
            const snappedTicks = this.snapToGrid(ticks);
            if (this.lastDrawTicks === null || Math.abs(snappedTicks - this.lastDrawTicks) >= this.options.grid * this.drawDensityMultiplier) {
                this.addEvent(ticks, value, this.currentChannel, false); // Do not save immediately
                this.lastDrawTicks = snappedTicks;
                this.lastDrawPosition = { x, y };
                this.renderThrottled();
            }
        } else if (this.dragStart && (this.currentTool === 'select' || this.currentTool === 'move')) {
            // Move the selected events
            if (this.selectedEvents.size > 0) {
                const deltaTicks = this.xToTicks(x) - this.dragStart.ticks;
                const deltaValue = this.yToValue(y) - this.dragStart.value;

                Array.from(this.selectedEvents).forEach(id => {
                    const event = this.events.find(e => e.id === id);
                    if (event) {
                        event.ticks = Math.max(0, this.snapToGrid(event.ticks + deltaTicks));
                        event.value = this.clampValue(event.value + deltaValue);
                    }
                });

                this.dragStart = { x, y, ticks, value };
                this.renderThrottled();
            }
        } else if (this.selectionStart) {
            // Selection rectangle
            this.renderSelectionRect(this.selectionStart.x, this.selectionStart.y, x, y);
        } else if (this.lineStart) {
            // Line preview
            this.renderLinePreview(this.lineStart, { ticks, value });
        }

        // Always update the tooltip
        this.updateTooltip(x, y, ticks, value);
    }

    updateTooltip(x, y, ticks, value) {
        if (!this.tooltip) return;

        // Format the value based on type
        let valueStr;
        if (this.currentCC === 'pitchbend') {
            valueStr = `PB: ${value}`;
        } else if (this.currentCC === 'aftertouch') {
            valueStr = `AT: ${value}`;
        } else if (this.currentCC === 'polyAftertouch') {
            valueStr = `PAT: ${value}`;
        } else {
            valueStr = `Val: ${value}`;
        }

        // Format time as measures:beats:ticks
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

    handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
            // Save state after finishing drawing
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
        // Only process shortcuts if the editor is visible
        if (!this.element || this.element.offsetParent === null) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.selectedEvents.size > 0) {
                this.removeEvents(Array.from(this.selectedEvents));
            }
        } else if (e.key === 'Escape') {
            this.selectedEvents.clear();
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

    // === Selection utilities ===

    getEventAtPosition(x, y, threshold = 5) {
        return this.getFilteredEvents().find(event => {
            const ex = this.ticksToX(event.ticks);
            const ey = this.valueToY(event.value);
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
            const ey = this.valueToY(event.value);
            if (ex >= left && ex <= right && ey >= top && ey <= bottom) {
                this.selectedEvents.add(event.id);
            }
        });
    }

    selectAll() {
        this.selectedEvents.clear();
        this.getFilteredEvents().forEach(event => {
            this.selectedEvents.add(event.id);
        });
        this.renderThrottled();
    }

    deleteSelected() {
        if (this.selectedEvents.size === 0) return;

        // Remove the selected events
        this.events = this.events.filter(event => !this.selectedEvents.has(event.id));

        // Clear the selection
        this.selectedEvents.clear();

        // Save state and notify the change
        this.saveState();
        if (this.options.onChange) {
            this.options.onChange();
        }
        this.renderThrottled();
    }

    // === Line tool ===

    createLine(startTicks, startValue, endTicks, endValue) {
        const minTicks = Math.min(startTicks, endTicks);
        const maxTicks = Math.max(startTicks, endTicks);
        const ticksRange = maxTicks - minTicks;
        const valueRange = endValue - startValue;

        // Create points along the line according to the grid
        // Use autoSave=false to avoid saving at every point
        for (let t = minTicks; t <= maxTicks; t += this.options.grid) {
            const progress = ticksRange > 0 ? (t - minTicks) / ticksRange : 0;
            const curveProgress = this.applyCurve(progress);
            const value = Math.round(startValue + valueRange * curveProgress);
            this.addEvent(t, value, this.currentChannel, false);
        }

        // Ensure the exact endpoint is created (may not fall on the grid)
        const lastGridTick = Math.floor((maxTicks - minTicks) / this.options.grid) * this.options.grid + minTicks;
        if (lastGridTick < maxTicks) {
            this.addEvent(maxTicks, Math.round(startValue + valueRange * (ticksRange > 0 ? 1 : 0)), this.currentChannel, false);
        }

        // Save state only once at the end
        this.saveState();
        this.renderThrottled();
    }

    // === Rendering ===

    // OPTIMIZATION: Throttled rendering function
    renderThrottled() {
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.render();
                this.renderScheduled = false;
            });
        }
    }

    render() {
        if (!this.ctx || !this.canvas) {
            console.warn('CCPitchbendEditor: Canvas context not ready');
            return;
        }

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // OPTIMIZATION: Use the buffer canvas for the grid
        // Background grid
        this.renderGrid();

        // Center line (0 for pitchbend, 64 for CC)
        this.renderCenterLine();

        // Events
        this.renderEvents();

        // Reset the dirty flag
        this.isDirty = false;

        // Render complete
    }

    renderGrid() {
        // OPTIMIZATION: Check whether the grid should be redrawn
        // The grid changes if xoffset, xrange, grid, or currentCC change
        if (this.gridDirty || !this.gridCanvas) {
            this.renderGridToBuffer();
            this.gridDirty = false;
        }

        // Copy the grid buffer to the main canvas
        this.ctx.drawImage(this.gridCanvas, 0, 0);
    }

    renderGridToBuffer() {
        if (!this.gridCtx) return;

        const labelMargin = 50; // Margin for labels on the left
        const ctx = this.gridCtx;

        // Clear the buffer
        ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);

        // Vertical grid (time)
        const isDark = document.body.classList.contains('dark-mode');
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

        // Horizontal grid (values)
        if (this.currentCC === 'pitchbend') {
            // For pitchbend: lines at values -8192, -4096, 0, 4096, 8191
            const values = [-8192, -4096, 0, 4096, 8191];
            ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
            ctx.lineWidth = 1;

            values.forEach(value => {
                const y = this.valueToY(value);

                // Grid line
                ctx.beginPath();
                ctx.moveTo(labelMargin, y);
                ctx.lineTo(this.gridCanvas.width, y);
                ctx.stroke();

                // Label area (background)
                ctx.fillStyle = isDark ? '#1a1a1a' : '#f0f4ff';
                ctx.fillRect(0, y - 7, labelMargin - 2, 14);

                // Label
                ctx.fillStyle = isDark ? '#aaa' : '#5a6089';
                ctx.font = '11px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(value.toString(), labelMargin - 5, y + 4);
            });
        } else {
            // For CC: lines at values 0, 32, 64, 96, 127
            const values = [0, 32, 64, 96, 127];
            ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
            ctx.lineWidth = 1;

            values.forEach(value => {
                const y = this.valueToY(value);

                // Grid line
                ctx.beginPath();
                ctx.moveTo(labelMargin, y);
                ctx.lineTo(this.gridCanvas.width, y);
                ctx.stroke();

                // Label area (background)
                ctx.fillStyle = isDark ? '#1a1a1a' : '#f0f4ff';
                ctx.fillRect(0, y - 7, labelMargin - 2, 14);

                // Label
                ctx.fillStyle = isDark ? '#aaa' : '#5a6089';
                ctx.font = '11px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(value.toString(), labelMargin - 5, y + 4);
            });
        }

        // Vertical border separating the label area
        ctx.strokeStyle = isDark ? '#555' : '#b0b8e8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(labelMargin, 0);
        ctx.lineTo(labelMargin, this.gridCanvas.height);
        ctx.stroke();

        // Reset text alignment
        ctx.textAlign = 'left';
    }

    renderCenterLine() {
        const filteredEvents = this.getFilteredEvents();
        const labelMargin = 50;

        const isDark = document.body.classList.contains('dark-mode');
        if (this.currentCC === 'pitchbend') {
            // For pitchbend: always display a center bar at 0
            this.ctx.strokeStyle = isDark ? '#888' : '#667eea';
            this.ctx.lineWidth = 2;
            const y = this.valueToY(0);
            this.ctx.beginPath();
            this.ctx.moveTo(labelMargin, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        } else {
            // For CC: display a bar at 0 when there are no events
            if (filteredEvents.length === 0) {
                this.ctx.strokeStyle = isDark ? '#666' : '#8898d8';
                this.ctx.lineWidth = 2;
                this.ctx.setLineDash([5, 5]);
                const y = this.valueToY(0);
                this.ctx.beginPath();
                this.ctx.moveTo(labelMargin, y);
                this.ctx.lineTo(this.canvas.width, y);
                this.ctx.stroke();
                this.ctx.setLineDash([]);
            }
        }
    }

    renderEvents() {
        const allEvents = this.getFilteredEvents();

        // Sort by ticks
        allEvents.sort((a, b) => a.ticks - b.ticks);

        // Viewport culling: filter to visible range (with 1-event margin for connecting lines)
        const visStart = this.options.xoffset;
        const visEnd = this.options.xoffset + this.options.xrange;
        let firstVisible = 0;
        let lastVisible = allEvents.length - 1;

        // Find first event in or just before visible range
        for (let i = 0; i < allEvents.length; i++) {
            if (allEvents[i].ticks >= visStart) {
                firstVisible = Math.max(0, i - 1);
                break;
            }
        }
        // Find last event in or just after visible range
        for (let i = allEvents.length - 1; i >= 0; i--) {
            if (allEvents[i].ticks <= visEnd) {
                lastVisible = Math.min(allEvents.length - 1, i + 1);
                break;
            }
        }

        const events = allEvents.slice(firstVisible, lastVisible + 1);

        // Draw the lines connecting the events
        if (events.length > 1) {
            this.ctx.strokeStyle = '#4CAF50';
            this.ctx.lineWidth = 2;

            // CC and Pitchbend: staircase curve (discrete values)
            this.ctx.beginPath();
            events.forEach((event, i) => {
                const x = this.ticksToX(event.ticks);
                const y = this.valueToY(event.value);

                if (i === 0) {
                    this.ctx.moveTo(x, y);
                } else {
                    const prevEvent = events[i - 1];
                    const prevY = this.valueToY(prevEvent.value);

                    // Horizontal line from the previous point to the current point's x coordinate
                    this.ctx.lineTo(x, prevY);
                    // Vertical line to the current point
                    this.ctx.lineTo(x, y);
                }
            });
            this.ctx.stroke();
        } else if (events.length === 1) {
            // If there's only one event, display a horizontal line
            this.ctx.strokeStyle = '#4CAF50';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            const x = this.ticksToX(events[0].ticks);
            const y = this.valueToY(events[0].value);
            this.ctx.moveTo(x, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        }

        // Draw the points
        events.forEach(event => {
            const x = this.ticksToX(event.ticks);
            const y = this.valueToY(event.value);
            const isSelected = this.selectedEvents.has(event.id);

            this.ctx.fillStyle = isSelected ? '#FFC107' : '#4CAF50';
            this.ctx.beginPath();
            this.ctx.arc(x, y, isSelected ? 5 : 3, 0, 2 * Math.PI);
            this.ctx.fill();
        });
    }

    // OPTIMIZATION: Use requestAnimationFrame for transient renders
    renderSelectionRect(x1, y1, x2, y2) {
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.render();
                // Draw the selection rectangle on top
                this.ctx.strokeStyle = '#2196F3';
                this.ctx.lineWidth = 1;
                this.ctx.setLineDash([5, 5]);
                this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                this.ctx.setLineDash([]);
                this.renderScheduled = false;
            });
        }
    }

    renderLinePreview(start, end) {
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.render();
                // Draw the preview curve on top
                this.ctx.strokeStyle = '#9E9E9E';
                this.ctx.lineWidth = 1;
                this.ctx.setLineDash([5, 5]);
                this.ctx.beginPath();

                const segments = 30;
                for (let i = 0; i <= segments; i++) {
                    const t = i / segments;
                    const curveT = this.applyCurve(t);
                    const ticks = start.ticks + (end.ticks - start.ticks) * t;
                    const value = start.value + (end.value - start.value) * curveT;
                    const x = this.ticksToX(ticks);
                    const y = this.valueToY(value);
                    if (i === 0) {
                        this.ctx.moveTo(x, y);
                    } else {
                        this.ctx.lineTo(x, y);
                    }
                }

                this.ctx.stroke();
                this.ctx.setLineDash([]);
                this.renderScheduled = false;
            });
        }
    }

    // === Filtering ===

    getFilteredEvents() {
        return this.events.filter(event => {
            if (event.type !== this.currentCC || event.channel !== this.currentChannel) return false;
            // For poly aftertouch, also filter by note
            if (this.currentCC === 'polyAftertouch' && this.currentNote !== null) {
                return event.note === this.currentNote;
            }
            return true;
        });
    }

    // === Synchronization ===

    syncWith(pianoRoll) {
        const oldXRange = this.options.xrange;
        const oldXOffset = this.options.xoffset;
        const oldGrid = this.options.grid;

        this.options.xrange = pianoRoll.xrange;
        this.options.xoffset = pianoRoll.xoffset;
        this.options.grid = pianoRoll.grid;
        this.options.timebase = pianoRoll.timebase;

        // OPTIMIZATION: Mark the grid as dirty if parameters have changed
        if (oldXRange !== this.options.xrange ||
            oldXOffset !== this.options.xoffset ||
            oldGrid !== this.options.grid) {
            this.gridDirty = true;
        }

        this.renderThrottled();
    }

    // === Undo/Redo ===

    saveState() {
        // Debounce: max 1 save per 100ms to avoid lag during continuous drawing
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        this._saveStateTimer = setTimeout(() => {
            this._doSaveState();
        }, 100);
    }

    _doSaveState() {
        const state = JSON.stringify(this.events);
        if (this.history[this.historyIndex] !== state) {
            this.history = this.history.slice(0, this.historyIndex + 1);
            this.history.push(state);
            this.historyIndex++;

            // Limit the history
            if (this.history.length > 50) {
                this.history.shift();
                this.historyIndex--;
            }

            // Notify the change
            if (this.options.onChange && typeof this.options.onChange === 'function') {
                this.options.onChange();
            }
        }
    }

    undo() {
        // Cancel any ongoing saveState timer to avoid history corruption
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.events = JSON.parse(this.history[this.historyIndex]);
            this.selectedEvents.clear();
            this.renderThrottled();

            // Notify the change
            if (this.options.onChange && typeof this.options.onChange === 'function') {
                this.options.onChange();
            }
        }
    }

    redo() {
        // Cancel any ongoing saveState timer to avoid history corruption
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.events = JSON.parse(this.history[this.historyIndex]);
            this.selectedEvents.clear();
            this.renderThrottled();

            // Notify the change
            if (this.options.onChange && typeof this.options.onChange === 'function') {
                this.options.onChange();
            }
        }
    }

    // === Import/Export ===

    loadEvents(events) {
        console.log(`CCPitchbendEditor: Loading ${events.length} events`);
        this.events = events.map(e => ({
            ...e,
            id: e.id || (Date.now() + Math.random())
        }));

        // Log events by type and channel
        const eventsByType = {};
        this.events.forEach(e => {
            const key = `${e.type}-ch${e.channel}`;
            eventsByType[key] = (eventsByType[key] || 0) + 1;
        });
        console.log('CCPitchbendEditor: Events by type/channel:', eventsByType);

        // FIX: Initialize history without triggering onChange
        // (loading existing events isn't a user modification)
        this.history = [JSON.stringify(this.events)];
        this.historyIndex = 0;

        this.renderThrottled();
    }

    getEvents() {
        return this.events;
    }

    clear() {
        this.events = [];
        this.selectedEvents.clear();

        // Reset the history
        this.history = [JSON.stringify(this.events)];
        this.historyIndex = 0;

        this.renderThrottled();

        // Notify the change (clear is a user action)
        if (this.options.onChange && typeof this.options.onChange === 'function') {
            this.options.onChange();
        }
    }

    // === Cleanup ===

    destroy() {
        if (this._mouseMoveRAF) cancelAnimationFrame(this._mouseMoveRAF);
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this._boundMouseDown);
            this.canvas.removeEventListener('mousemove', this._boundMouseMove);
            this.canvas.removeEventListener('mouseup', this._boundMouseUp);
            this.canvas.removeEventListener('mouseleave', this._boundMouseLeave);
        }
        document.removeEventListener('keydown', this._boundKeyDown);
        window.removeEventListener('resize', this._boundResize);
        document.removeEventListener('theme-changed', this._boundThemeChanged);

        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CCPitchbendEditor;
}
