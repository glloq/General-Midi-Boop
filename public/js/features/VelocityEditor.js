/**
 * VelocityEditor - Note velocity editor synchronized with the piano roll
 *
 * Features:
 * - Display velocity bars as a graph
 * - Tools: select, move, line, continuous draw
 * - Horizontal synchronization with the piano roll
 * - Honors the time grid and zoom
 * - Filter by selected channel
 */

class VelocityEditor {
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
        this.sequence = []; // Notes with velocity
        this.selectedNotes = new Set(); // IDs of selected notes
        this.currentTool = 'select'; // 'select', 'move', 'line', 'draw'
        this.currentChannel = 0;
        this.activeChannels = new Set([0]); // Visible channels
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null;

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
        this.element.className = 'velocity-editor';
        this.element.style.cssText = `
            width: 100%;
            flex: 1;
            display: flex;
            flex-direction: column;
            background: ${document.body.classList.contains('dark-mode') ? '#1a1a1a' : '#f0f4ff'};
            border-top: 1px solid ${document.body.classList.contains('dark-mode') ? '#333' : '#d4daff'};
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
            width: 100%;
            height: 100%;
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

        this.element.appendChild(this.canvas);
        this.element.appendChild(this.overlay);
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
        // Force reflow to get the final dimensions
        void this.element.offsetHeight;

        const rect = this.element.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        // Debug resize removed for performance

        // Only resize when we have valid dimensions
        if (width > 0 && height > 100) {
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

            this.renderThrottled();
        } else {
            console.warn(`VelocityEditor.resize(): Invalid dimensions ${width}x${height}, skipping`);
        }
    }

    // === Tool management ===

    setTool(tool) {
        this.currentTool = tool;
        this.canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
    }

    setChannel(channel) {
        this.currentChannel = channel;
        this.activeChannels = new Set([channel]); // FIX: Update activeChannels for filtering
        this.selectedNotes.clear(); // IMPORTANT: Clear selection since indices become invalid
        // Cancel any ongoing actions
        this.cancelInteractions();
        this.isDirty = true;
        this.renderThrottled();
    }

    setActiveChannels(channels) {
        this.activeChannels = new Set(channels);
        this.selectedNotes.clear(); // IMPORTANT: Clear selection since indices become invalid
        // Cancel any ongoing actions
        this.cancelInteractions();
        this.isDirty = true;
        this.renderThrottled();
    }

    cancelInteractions() {
        // Cancel all ongoing interactions
        this.lineStart = null;
        this.selectionStart = null;
        this.dragStart = null;
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null;
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
    }

    // === Coordinate conversion ===

    ticksToX(ticks) {
        return ((ticks - this.options.xoffset) / this.options.xrange) * this.canvas.width;
    }

    xToTicks(x) {
        return Math.round((x / this.canvas.width) * this.options.xrange + this.options.xoffset);
    }

    velocityToY(velocity) {
        // 0-127 → bottom to top with small margins
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = velocity / 127;
        return margin + drawH - (normalized * drawH);
    }

    yToVelocity(y) {
        const margin = 6;
        const drawH = this.canvas.height - margin * 2;
        const normalized = 1 - ((y - margin) / drawH);
        return Math.round(Math.max(1, Math.min(127, normalized * 127)));
    }

    snapToGrid(ticks) {
        const gridSize = this.options.grid;
        return Math.round(ticks / gridSize) * gridSize;
    }

    // === Sequence management ===

    setSequence(sequence) {
        this.sequence = sequence || [];
        this.selectedNotes.clear();
        this.isDirty = true;
        this.saveState();
        this.renderThrottled();
    }

    getSequence() {
        return this.sequence;
    }

    // === Velocity modification ===

    updateNoteVelocity(noteIndex, velocity) {
        if (noteIndex >= 0 && noteIndex < this.sequence.length) {
            this.sequence[noteIndex].v = Math.max(1, Math.min(127, velocity));
            this.isDirty = true;
            this.notifyChange();
        }
    }

    updateSelectedNotesVelocity(velocity) {
        Array.from(this.selectedNotes).forEach(index => {
            if (index >= 0 && index < this.sequence.length) {
                this.sequence[index].v = Math.max(1, Math.min(127, velocity));
            }
        });
        this.isDirty = true;
        this.saveState();
        this.notifyChange();
        this.renderThrottled();
    }

    adjustVelocity(noteIndex, delta) {
        if (noteIndex >= 0 && noteIndex < this.sequence.length) {
            const note = this.sequence[noteIndex];
            const currentVelocity = (note.v !== undefined && note.v !== null) ? note.v : 100;
            note.v = Math.max(1, Math.min(127, currentVelocity + delta));
            this.isDirty = true;
            this.notifyChange();
        }
    }

    // === Editing tools ===

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const velocity = this.yToVelocity(y);

        switch (this.currentTool) {
            case 'draw': {
                this.isDrawing = true;
                this.lastDrawPosition = { x, y };
                this.lastDrawTicks = this.snapToGrid(ticks);

                // Find the note at this tick and modify its velocity
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
                        if (this.selectedNotes.has(clickedNote)) {
                            this.selectedNotes.delete(clickedNote);
                        } else {
                            this.selectedNotes.add(clickedNote);
                        }
                    } else {
                        this.selectedNotes.clear();
                        this.selectedNotes.add(clickedNote);
                    }
                    this.dragStart = { x, y, ticks, velocity, initialVelocities: new Map() };

                    // Store initial velocities for the drag
                    Array.from(this.selectedNotes).forEach(index => {
                        if (index >= 0 && index < this.sequence.length) {
                            this.dragStart.initialVelocities.set(index, this.sequence[index].v || 100);
                        }
                    });
                } else {
                    if (!e.shiftKey) {
                        this.selectedNotes.clear();
                    }
                    this.selectionStart = { x, y };
                }
                this.renderThrottled();
                break;
            }

            case 'move': {
                const moveNote = this.getNoteAtPosition(x, y);
                if (moveNote !== null) {
                    if (!this.selectedNotes.has(moveNote)) {
                        this.selectedNotes.clear();
                        this.selectedNotes.add(moveNote);
                    }
                    this.dragStart = { x, y, ticks, velocity, initialVelocities: new Map() };

                    // Store initial velocities
                    Array.from(this.selectedNotes).forEach(index => {
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
        const velocity = this.yToVelocity(y);

        // Store mouse position for rendering
        this.lastMouseX = x;
        this.lastMouseY = y;

        if (this.isDrawing && this.currentTool === 'draw') {
            // Continuous draw - modify the velocity of notes under the cursor
            const snappedTicks = this.snapToGrid(ticks);
            if (this.lastDrawTicks === null || Math.abs(snappedTicks - this.lastDrawTicks) >= this.options.grid) {
                const noteAtDraw = this.getNoteAtTick(ticks);
                if (noteAtDraw !== null) {
                    this.updateNoteVelocity(noteAtDraw, velocity);
                }
                this.lastDrawTicks = snappedTicks;
                this.lastDrawPosition = { x, y };
                this.renderThrottled();
            }
        } else if (this.dragStart && (this.currentTool === 'select' || this.currentTool === 'move')) {
            // Vertical movement of velocity bars
            if (this.selectedNotes.size > 0) {
                const deltaVelocity = this.yToVelocity(y) - this.dragStart.velocity;

                Array.from(this.selectedNotes).forEach(index => {
                    if (index >= 0 && index < this.sequence.length) {
                        const initialVelocity = this.dragStart.initialVelocities.get(index) || 100;
                        this.sequence[index].v = Math.max(1, Math.min(127, initialVelocity + deltaVelocity));
                    }
                });

                this.renderThrottled();
            }
        } else if (this.selectionStart || this.lineStart) {
            // Selection rectangle or line preview
            this.renderThrottled();
        }
    }

    handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
            // Save state after finishing drawing
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

    handleMouseLeave(e) {
        this.handleMouseUp(e);
    }

    handleKeyDown(e) {
        // Only process shortcuts if the editor is visible
        if (!this.element || this.element.offsetParent === null) return;

        if (e.key === 'Escape') {
            this.selectedNotes.clear();
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

    getNoteAtPosition(x, y, threshold = 8) {
        // FIX: Return the index in this.sequence (not filtered)
        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;

            const nx = this.ticksToX(note.t);
            const barWidth = Math.max(2, this.ticksToX(note.t + note.g) - nx);
            const ny = this.velocityToY(note.v || 100);

            if (x >= nx - threshold &&
                x <= nx + barWidth + threshold &&
                y >= ny - threshold &&
                y <= this.canvas.height + threshold) {
                return i; // Index in this.sequence
            }
        }
        return null;
    }

    getNoteAtTick(ticks, threshold = null) {
        if (threshold === null) {
            threshold = this.options.grid / 2;
        }

        // FIX: Return the index in this.sequence (not filtered)
        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;
            if (Math.abs(note.t - ticks) <= threshold) {
                return i; // Index in this.sequence
            }
        }
        return null;
    }

    selectInRect(x1, y1, x2, y2) {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);

        // FIX: Use the index in this.sequence (not filtered)
        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;

            const nx = this.ticksToX(note.t);
            const barWidth = Math.max(2, this.ticksToX(note.t + note.g) - nx);
            const ny = this.velocityToY(note.v || 100);

            if (nx >= left && nx + barWidth <= right && ny >= top && ny <= bottom) {
                this.selectedNotes.add(i); // Index in this.sequence
            }
        }

        this.renderThrottled();
    }

    selectAll() {
        this.selectedNotes.clear();
        // FIX: Use the index in this.sequence (not filtered)
        for (let i = 0; i < this.sequence.length; i++) {
            if (this.activeChannels.has(this.sequence[i].c)) {
                this.selectedNotes.add(i); // Index in this.sequence
            }
        }
        this.renderThrottled();
    }

    deleteSelected() {
        if (this.selectedNotes.size === 0) return;

        // Convert to array and sort in descending order to delete from the end
        const indices = Array.from(this.selectedNotes).sort((a, b) => b - a);

        // Remove the selected notes
        indices.forEach(index => {
            if (index >= 0 && index < this.sequence.length) {
                this.sequence.splice(index, 1);
            }
        });

        // Clear the selection
        this.selectedNotes.clear();

        // Save state and notify the change
        this.saveState();
        this.notifyChange();
        this.renderThrottled();
    }

    getFilteredNotes() {
        return this.sequence.filter(note => this.activeChannels.has(note.c));
    }

    // === Line creation ===

    createLine(startTicks, startVelocity, endTicks, endVelocity) {
        const minTicks = Math.min(startTicks, endTicks);
        const maxTicks = Math.max(startTicks, endTicks);

        // Find all notes within the time range
        this.sequence.forEach((note, index) => {
            if (note.t >= minTicks && note.t <= maxTicks && this.activeChannels.has(note.c)) {
                // Linear interpolation (guard against division by zero for same tick)
                const range = endTicks - startTicks;
                const t = range !== 0 ? (note.t - startTicks) / range : 0;
                const velocity = Math.round(startVelocity + t * (endVelocity - startVelocity));
                this.sequence[index].v = Math.max(1, Math.min(127, velocity));
            }
        });

        this.saveState();
        this.notifyChange();
        this.renderThrottled();
    }

    // === Rendering ===

    renderThrottled() {
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                try {
                    this.render();
                } finally {
                    this.renderScheduled = false;
                }
            });
        }
    }

    render() {
        if (!this.ctx || this.canvas.width === 0 || this.canvas.height === 0) {
            return;
        }

        // OPTIMIZATION: Redraw the grid only when needed
        if (this.gridDirty) {
            this.renderGridToBuffer();
            this.gridDirty = false;
        }

        // Clear the main canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Copy the grid from the buffer
        if (this.gridCanvas) {
            this.ctx.drawImage(this.gridCanvas, 0, 0);
        }

        // Draw the velocity bars
        this.renderVelocityBars();

        // Draw the interactive elements
        if (this.selectionStart && this.lastMouseX !== undefined) {
            this.renderSelectionRect(
                this.selectionStart.x,
                this.selectionStart.y,
                this.lastMouseX,
                this.lastMouseY
            );
        }

        if (this.lineStart && this.lastMouseX !== undefined) {
            this.renderLinePreview(this.lineStart, {
                ticks: this.xToTicks(this.lastMouseX),
                velocity: this.yToVelocity(this.lastMouseY)
            });
        }
    }

    renderGridToBuffer() {
        if (!this.gridCtx) return;

        const labelMargin = 50; // SAME AS CC: Margin for labels on the left
        const ctx = this.gridCtx;

        // Clear the buffer
        ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);

        // Vertical grid (time) - SAME AS CC
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

        // Horizontal grid (velocity values) - SAME AS CC
        const values = [0, 32, 64, 96, 127]; // SAME AS CC
        ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
        ctx.lineWidth = 1;

        values.forEach(value => {
            const y = this.velocityToY(value);

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

    renderVelocityBars() {
        const ctx = this.ctx;

        // Viewport culling: visible tick range
        const visStart = this.options.xoffset;
        const visEnd = this.options.xoffset + this.options.xrange;

        for (let i = 0; i < this.sequence.length; i++) {
            const note = this.sequence[i];
            if (!this.activeChannels.has(note.c)) continue;

            // Skip notes outside visible range
            if (note.t + note.g < visStart || note.t > visEnd) continue;

            const velocity = note.v || 100;
            const x = this.ticksToX(note.t);
            const y = this.velocityToY(velocity);
            const barWidth = Math.max(2, this.ticksToX(note.t + note.g) - x);
            const barHeight = this.velocityToY(0) - y;

            // Color based on velocity
            const intensityRatio = velocity / 127;
            const hue = 120 + (240 - 120) * (1 - intensityRatio); // Green (120) to Blue (240)
            const saturation = 60 + 40 * intensityRatio;
            const lightness = 40 + 20 * intensityRatio;

            // Velocity bar - check selection with full index
            const isSelected = this.selectedNotes.has(i); // i is the index in this.sequence
            if (isSelected) {
                ctx.fillStyle = `hsl(50, 100%, 60%)`; // Yellow for selection
            } else {
                ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
            }

            ctx.fillRect(x, y, barWidth, barHeight);

            // Border
            if (isSelected) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, barWidth, barHeight);
            }
        }
    }

    renderSelectionRect(x1, y1, x2, y2) {
        const ctx = this.ctx;
        ctx.strokeStyle = '#2196F3'; // SAME AS CC: Blue
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]); // SAME AS CC
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.setLineDash([]);
    }

    renderLinePreview(start, end) {
        const ctx = this.ctx;
        ctx.strokeStyle = '#9E9E9E'; // SAME AS CC: Gray
        ctx.lineWidth = 1; // SAME AS CC
        ctx.setLineDash([5, 5]); // SAME AS CC
        ctx.beginPath();
        ctx.moveTo(this.ticksToX(start.ticks), this.velocityToY(start.velocity));
        ctx.lineTo(this.ticksToX(end.ticks), this.velocityToY(end.velocity));
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // === Synchronization with piano roll ===

    syncWith(pianoRoll) {
        this.options.xrange = pianoRoll.xrange;
        this.options.xoffset = pianoRoll.xoffset;
        this.options.grid = pianoRoll.grid;
        this.options.timebase = pianoRoll.timebase;
        this.gridDirty = true;
        this.renderThrottled();
    }

    // === History (Undo/Redo) ===

    saveState() {
        // Debounce: max 1 save per 100ms to avoid lag during continuous drawing
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        this._saveStateTimer = setTimeout(() => {
            this._doSaveState();
        }, 100);
    }

    _doSaveState() {
        const state = JSON.stringify({
            sequence: this.sequence.map(note => ({ ...note }))
        });

        // Drop future states if we are in the middle of the history
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        this.history.push(state);

        // Limit history to 20 states (reduced for memory efficiency)
        if (this.history.length > 20) {
            this.history.shift();
            // historyIndex stays stable because we remove the first element
        } else {
            this.historyIndex++;
        }
    }

    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.restoreState(this.history[this.historyIndex]);
        }
    }

    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.restoreState(this.history[this.historyIndex]);
        }
    }

    restoreState(stateStr) {
        try {
            const state = JSON.parse(stateStr);
            this.sequence = state.sequence;
            this.selectedNotes.clear();
            this.notifyChange();
            this.renderThrottled();
        } catch (e) {
            console.error('VelocityEditor: Failed to restore state', e);
        }
    }

    // === Callbacks ===

    notifyChange() {
        if (this.options.onChange) {
            this.options.onChange(this.sequence);
        }
    }

    // === Nettoyage ===

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
        this.gridCanvas = null;
        this.gridCtx = null;
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VelocityEditor;
}
