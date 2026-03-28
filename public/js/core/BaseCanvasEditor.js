/**
 * BaseCanvasEditor - Abstract base class for canvas-based editors
 *
 * Provides the shared infrastructure for VelocityEditor, TempoEditor,
 * CCPitchbendEditor, and any future canvas editors that need:
 *
 *   - Canvas setup with grid buffer
 *   - RAF-throttled rendering pipeline
 *   - Tool system (select, move, line, draw)
 *   - Mouse/keyboard event handling with rAF-throttled mousemove
 *   - Selection management (rectangle select, shift-toggle, select all)
 *   - Drag interaction with initial-value tracking
 *   - Line tool with preview and interpolation
 *   - Undo/redo history (debounced, max 50 states)
 *   - Grid synchronization (xoffset, xrange, grid, timebase)
 *   - Resize handling with reflow forcing
 *   - Proper cleanup/destroy
 *
 * Subclasses MUST implement:
 *   - getEditorClassName()          CSS class name for the root element
 *   - valueToY(value)               Map a domain value to canvas Y
 *   - yToValue(y)                   Map canvas Y to a domain value
 *   - serializeState()              Return a JSON-serializable snapshot of data
 *   - restoreState(state)           Restore data from a deserialized snapshot
 *   - renderData()                  Draw editor-specific data (bars, curves, points)
 *   - renderGridLabels(ctx, labelMargin)  Draw horizontal grid lines and labels
 *
 * Subclasses MAY override:
 *   - getDefaultOptions()           Return editor-specific default option values
 *   - initState()                   Initialize editor-specific state properties
 *   - createExtraDOM()              Create additional DOM elements (overlay, etc.)
 *   - getMinResizeHeight()          Minimum height to accept on resize (default 0)
 *   - onToolChanged(tool)           React to tool changes
 *   - onDrawStart(ticks, value, x, y)    Handle draw-tool mousedown
 *   - onDrawMove(ticks, value, x, y)     Handle draw-tool mousemove
 *   - onDrawEnd()                   Handle draw-tool mouseup
 *   - onLineCreate(startTicks, startValue, endTicks, endValue)
 *   - onSelectHit(x, y, shiftKey)   Handle select-tool click on item; return true if item found
 *   - onSelectMiss(x, y, shiftKey)  Handle select-tool click on empty space
 *   - onMoveHit(x, y)              Handle move-tool click on item; return true if item found
 *   - onDragMove(x, y, ticks, value)  Handle dragging selected items
 *   - onDragEnd()                   Finalize drag
 *   - onSelectionRect(x1, y1, x2, y2)  Select items within rectangle
 *   - onSelectAll()                 Select all visible items
 *   - onDeleteSelected()            Delete selected items
 *   - onKeyDown(e)                  Handle additional keyboard shortcuts; return true if handled
 *   - onResize()                    Additional resize logic
 *   - onDestroy()                   Additional cleanup logic
 *   - renderOverlay()               Draw selection rect, line preview, etc. (called after renderData)
 */

class BaseCanvasEditor {

    // =========================================================================
    // 1. Constructor & Initialization
    // =========================================================================

    constructor(container, options = {}) {
        if (new.target === BaseCanvasEditor) {
            throw new Error('BaseCanvasEditor is abstract and cannot be instantiated directly.');
        }

        this.container = container;

        // Merge default options from base + subclass + caller
        this.options = {
            height: 150,
            timebase: 480,
            xrange: 1920,
            xoffset: 0,
            grid: 15,
            onChange: null,
            ...this.getDefaultOptions(),
            ...options
        };

        // Common interaction state
        this.currentTool = 'select';
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null;
        this.lineStart = null;
        this.selectionStart = null;
        this.dragStart = null;
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;

        // Selection set -- stores indices or IDs depending on subclass convention
        this.selectedItems = new Set();

        // Undo/redo history
        this.history = [];
        this.historyIndex = -1;
        this._saveStateTimer = null;

        // RAF-throttled rendering
        this.pendingRender = false;
        this.renderScheduled = false;
        this.isDirty = false;
        this._mouseMoveRAF = null;
        this._suspended = false;

        // Grid buffer canvas
        this.gridCanvas = null;
        this.gridCtx = null;
        this.gridDirty = true;

        // DOM references (created in createUI)
        this.element = null;
        this.canvas = null;
        this.ctx = null;
        this.overlay = null;

        // Let subclass initialize its own state properties
        this.initState();

        // Build UI and bind events
        this._init();
    }

    /**
     * Override to provide editor-specific default options.
     * These are merged between the base defaults and the caller-supplied options.
     */
    getDefaultOptions() {
        return {};
    }

    /**
     * Override to initialize editor-specific state (data arrays, channel, etc.)
     * Called before the DOM is created.
     */
    initState() {
        // no-op by default
    }

    /** @private */
    _init() {
        this._createUI();
        this._setupEventListeners();
    }

    // =========================================================================
    // 2. Canvas Setup & DOM
    // =========================================================================

    /**
     * Must return the CSS class name for the root container element.
     * @abstract
     */
    getEditorClassName() {
        throw new Error('Subclass must implement getEditorClassName()');
    }

    /**
     * Override to return the minimum element height accepted during resize.
     * Values below this threshold cause resize to be skipped.
     * Default is 0 (any positive height is accepted).
     */
    getMinResizeHeight() {
        return 0;
    }

    /** @private */
    _createUI() {
        // Root container
        this.element = document.createElement('div');
        this.element.className = this.getEditorClassName();
        const isDark = document.body.classList.contains('dark-mode');
        const editorBg = isDark ? '#1a1a1a' : '#f0f4ff';
        const editorBorder = isDark ? '#333' : '#d4daff';
        this.element.style.cssText = `
            width: 100%;
            flex: 1;
            display: flex;
            flex-direction: column;
            background: ${editorBg};
            border-top: 1px solid ${editorBorder};
            position: relative;
            overflow: hidden;
            min-height: 0;
        `;

        // Main rendering canvas
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

        this.element.appendChild(this.canvas);

        // Let subclass add extra DOM (overlay, toolbar, etc.)
        this.createExtraDOM();

        this.container.appendChild(this.element);

        // Initial sizing
        this.resize();
    }

    /**
     * Override to append additional DOM elements to this.element.
     * Called after the canvas is appended but before the element is added to the container.
     */
    createExtraDOM() {
        // no-op by default
    }

    // =========================================================================
    // 3. Event Listener Setup
    // =========================================================================

    /** @private */
    _setupEventListeners() {
        // Store bound references so we can remove them in destroy()
        this._boundMouseDown = this._handleMouseDown.bind(this);
        this._boundMouseMove = (e) => {
            if (this._mouseMoveRAF) return;
            this._mouseMoveRAF = requestAnimationFrame(() => {
                this._mouseMoveRAF = null;
                this._handleMouseMove(e);
            });
        };
        this._boundMouseUp = this._handleMouseUp.bind(this);
        this._boundMouseLeave = this._handleMouseLeave.bind(this);
        this._boundKeyDown = this._handleKeyDown.bind(this);
        this._boundResize = this.resize.bind(this);

        this.canvas.addEventListener('mousedown', this._boundMouseDown);
        this.canvas.addEventListener('mousemove', this._boundMouseMove);
        this.canvas.addEventListener('mouseup', this._boundMouseUp);
        this.canvas.addEventListener('mouseleave', this._boundMouseLeave);
        document.addEventListener('keydown', this._boundKeyDown);
        window.addEventListener('resize', this._boundResize);
    }

    // =========================================================================
    // 4. Coordinate Conversion
    // =========================================================================

    /** Convert ticks to canvas X position. */
    ticksToX(ticks) {
        return ((ticks - this.options.xoffset) / this.options.xrange) * this.canvas.width;
    }

    /** Convert canvas X position to ticks. */
    xToTicks(x) {
        return Math.round((x / this.canvas.width) * this.options.xrange + this.options.xoffset);
    }

    /**
     * Convert a domain value to canvas Y coordinate.
     * @abstract
     */
    valueToY(_value) {
        throw new Error('Subclass must implement valueToY()');
    }

    /**
     * Convert a canvas Y coordinate to a domain value.
     * @abstract
     */
    yToValue(_y) {
        throw new Error('Subclass must implement yToValue()');
    }

    /** Snap ticks to the nearest grid position. */
    snapToGrid(ticks) {
        const gridSize = this.options.grid;
        return Math.round(ticks / gridSize) * gridSize;
    }

    // =========================================================================
    // 5. Mouse Event Handling
    // =========================================================================

    /** @private */
    _handleMouseDown(e) {
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
                this.onDrawStart(ticks, value, x, y);
                this.renderThrottled();
                break;

            case 'line':
                if (!this.lineStart) {
                    this.lineStart = { ticks, value };
                } else {
                    this.onLineCreate(this.lineStart.ticks, this.lineStart.value, ticks, value);
                    this.lineStart = null;
                }
                break;

            case 'select':
                if (!this.onSelectHit(x, y, e.shiftKey)) {
                    this.onSelectMiss(x, y, e.shiftKey);
                }
                this.renderThrottled();
                break;

            case 'move':
                this.onMoveHit(x, y);
                this.renderThrottled();
                break;
        }
    }

    /** @private */
    _handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const value = this.yToValue(y);

        this.lastMouseX = x;
        this.lastMouseY = y;

        if (this.isDrawing && this.currentTool === 'draw') {
            const snappedTicks = this.snapToGrid(ticks);
            if (this.lastDrawTicks === null || Math.abs(snappedTicks - this.lastDrawTicks) >= this.options.grid) {
                this.onDrawMove(ticks, value, x, y);
                this.lastDrawTicks = snappedTicks;
                this.lastDrawPosition = { x, y };
                this.renderThrottled();
            }
        } else if (this.dragStart && (this.currentTool === 'select' || this.currentTool === 'move')) {
            this.onDragMove(x, y, ticks, value);
            this.renderThrottled();
        } else if (this.selectionStart || this.lineStart) {
            // Selection rectangle or line preview -- just schedule a repaint
            this.renderThrottled();
        }
    }

    /** @private */
    _handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
            this.onDrawEnd();
            this.saveState();
            this.notifyChange();
        }

        if (this.selectionStart) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this.onSelectionRect(this.selectionStart.x, this.selectionStart.y, x, y);
            this.selectionStart = null;
        }

        if (this.dragStart) {
            this.onDragEnd();
            this.saveState();
            this.notifyChange();
            this.dragStart = null;
        }

        this.renderThrottled();
    }

    /** @private */
    _handleMouseLeave(e) {
        this._handleMouseUp(e);
    }

    // =========================================================================
    // 6. Keyboard Event Handling
    // =========================================================================

    /** @private */
    _handleKeyDown(e) {
        // Only process shortcuts when the editor is visible
        if (!this.element || this.element.offsetParent === null) return;

        // Let subclass handle first; if it returns true, stop.
        if (this.onKeyDown(e)) return;

        if (e.key === 'Escape') {
            this.selectedItems.clear();
            this.lineStart = null;
            this.cancelInteractions();
            this.renderThrottled();
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedItems.size > 0) {
            e.preventDefault();
            this.onDeleteSelected();
        } else if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            } else if (e.key === 'y' || (e.shiftKey && (e.key === 'Z' || e.key === 'z'))) {
                e.preventDefault();
                this.redo();
            } else if (e.key === 'a') {
                e.preventDefault();
                this.onSelectAll();
            }
        }
    }

    // =========================================================================
    // 7. Tool Interaction Hooks (override in subclasses)
    // =========================================================================

    /**
     * Called when the draw tool starts (mousedown).
     * @param {number} ticks - Tick position
     * @param {number} value - Domain value at cursor Y
     * @param {number} x - Canvas X
     * @param {number} y - Canvas Y
     */
    onDrawStart(_ticks, _value, _x, _y) {}

    /**
     * Called during draw-tool mousemove (throttled to grid spacing).
     */
    onDrawMove(_ticks, _value, _x, _y) {}

    /**
     * Called when drawing ends (mouseup). saveState() + notifyChange() are
     * called automatically after this.
     */
    onDrawEnd() {}

    /**
     * Called when the line tool's second click occurs.
     * Subclass should create interpolated data between start and end.
     */
    onLineCreate(_startTicks, _startValue, _endTicks, _endValue) {}

    /**
     * Called when the select tool clicks. Subclass should check if an item is
     * at (x, y) and update this.selectedItems accordingly.
     * @returns {boolean} true if an item was found at the position.
     */
    onSelectHit(_x, _y, _shiftKey) {
        return false;
    }

    /**
     * Called when select tool clicks on empty space. Default starts a
     * selection rectangle.
     */
    onSelectMiss(_x, _y, shiftKey) {
        if (!shiftKey) {
            this.selectedItems.clear();
        }
        this.selectionStart = { x: _x, y: _y };
    }

    /**
     * Called when the move tool clicks. Subclass should check if an item is
     * at (x, y) and set up drag state.
     * @returns {boolean} true if an item was found.
     */
    onMoveHit(_x, _y) {
        return false;
    }

    /**
     * Called during drag of selected items.
     */
    onDragMove(_x, _y, _ticks, _value) {}

    /**
     * Called when drag ends (mouseup). saveState() + notifyChange() are
     * called automatically after this.
     */
    onDragEnd() {}

    /**
     * Called to select items within a rectangle (canvas coordinates).
     */
    onSelectionRect(_x1, _y1, _x2, _y2) {}

    /**
     * Called to select all visible items.
     */
    onSelectAll() {
        this.renderThrottled();
    }

    /**
     * Called to delete currently selected items.
     */
    onDeleteSelected() {}

    /**
     * Called for keyboard events not handled by the base class.
     * @returns {boolean} true if the event was consumed.
     */
    onKeyDown(_e) {
        return false;
    }

    // =========================================================================
    // 8. Tool System
    // =========================================================================

    /** Set the active tool. */
    setTool(tool) {
        this.currentTool = tool;
        this.canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
        this.onToolChanged(tool);
    }

    /** Override for tool-change side effects. */
    onToolChanged(_tool) {}

    /** Cancel all in-progress interactions. */
    cancelInteractions() {
        this.lineStart = null;
        this.selectionStart = null;
        this.dragStart = null;
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null;
        this.lastMouseX = undefined;
        this.lastMouseY = undefined;
    }

    // =========================================================================
    // 9. Rendering Pipeline
    // =========================================================================

    /** Schedule a render on the next animation frame (coalesced). */
    renderThrottled() {
        if (this._suspended) { this.isDirty = true; return; }
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.render();
                this.renderScheduled = false;
            });
        }
    }

    /** Suspend rendering (editor not visible). */
    suspend() { this._suspended = true; }

    /** Resume rendering and flush pending dirty state. */
    resume() {
        this._suspended = false;
        if (this.isDirty) {
            this.isDirty = false;
            this.renderThrottled();
        }
    }

    /** Full render pass. */
    render() {
        if (!this.ctx || !this.canvas || this.canvas.width === 0 || this.canvas.height === 0) {
            return;
        }

        // Redraw the grid buffer if stale
        if (this.gridDirty || !this.gridCanvas) {
            this._renderGridToBuffer();
            this.gridDirty = false;
        }

        // Clear main canvas and composite grid
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.gridCanvas) {
            this.ctx.drawImage(this.gridCanvas, 0, 0);
        }

        // Subclass draws its data (bars, curves, points, etc.)
        this.renderData();

        // Draw interactive overlays (selection rect, line preview)
        this._renderInteractiveOverlay();

        // Let subclass draw additional overlays
        this.renderOverlay();

        this.isDirty = false;
    }

    /**
     * Draw editor-specific data onto this.ctx.
     * @abstract
     */
    renderData() {
        throw new Error('Subclass must implement renderData()');
    }

    /** Override to draw additional overlays after the default ones. */
    renderOverlay() {}

    // =========================================================================
    // 10. Grid Rendering (shared grid background)
    // =========================================================================

    /** @private Render the grid into the offscreen buffer canvas. */
    _renderGridToBuffer() {
        if (!this.gridCtx) return;

        const labelMargin = this.getLabelMargin();
        const ctx = this.gridCtx;
        const w = this.gridCanvas.width;
        const h = this.gridCanvas.height;

        ctx.clearRect(0, 0, w, h);

        // Vertical grid lines (time axis)
        const isDark = document.body.classList.contains('dark-mode');
        ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
        ctx.lineWidth = 1;

        const gridSize = this.options.grid;
        const startTick = Math.floor(this.options.xoffset / gridSize) * gridSize;
        const endTick = this.options.xoffset + this.options.xrange;

        for (let t = startTick; t <= endTick; t += gridSize) {
            const x = this.ticksToX(t);
            if (x >= 0 && x <= w) {
                ctx.beginPath();
                ctx.moveTo(Math.max(x, labelMargin), 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
        }

        // Horizontal grid lines + labels (subclass-specific)
        this.renderGridLabels(ctx, labelMargin);

        // Vertical border separating label area
        ctx.strokeStyle = isDark ? '#555' : '#b0b8e8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(labelMargin, 0);
        ctx.lineTo(labelMargin, h);
        ctx.stroke();

        // Reset text align
        ctx.textAlign = 'left';
    }

    /**
     * Return the pixel width of the left label margin.
     * Override to change. Default is 50.
     */
    getLabelMargin() {
        return 50;
    }

    /**
     * Draw horizontal grid lines and value labels onto the grid buffer canvas.
     * @abstract
     * @param {CanvasRenderingContext2D} ctx - The grid buffer context
     * @param {number} labelMargin - Width of the label area in pixels
     */
    renderGridLabels(_ctx, _labelMargin) {
        throw new Error('Subclass must implement renderGridLabels()');
    }

    // =========================================================================
    // 11. Interactive Overlays (selection rect, line preview)
    // =========================================================================

    /** @private */
    _renderInteractiveOverlay() {
        // Selection rectangle
        if (this.selectionStart && this.lastMouseX !== undefined) {
            this._drawSelectionRect(
                this.selectionStart.x,
                this.selectionStart.y,
                this.lastMouseX,
                this.lastMouseY
            );
        }

        // Line tool preview
        if (this.lineStart && this.lastMouseX !== undefined) {
            this._drawLinePreview(this.lineStart, {
                ticks: this.xToTicks(this.lastMouseX),
                value: this.yToValue(this.lastMouseY)
            });
        }
    }

    /** @private */
    _drawSelectionRect(x1, y1, x2, y2) {
        const ctx = this.ctx;
        ctx.strokeStyle = document.body.classList.contains('dark-mode') ? '#2196F3' : '#667eea';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.setLineDash([]);
    }

    /** @private */
    _drawLinePreview(start, end) {
        const ctx = this.ctx;
        ctx.strokeStyle = document.body.classList.contains('dark-mode') ? '#9E9E9E' : '#9498b8';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(this.ticksToX(start.ticks), this.valueToY(start.value));
        ctx.lineTo(this.ticksToX(end.ticks), this.valueToY(end.value));
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // =========================================================================
    // 12. Undo/Redo History
    // =========================================================================

    /**
     * Return a JSON-serializable snapshot of the current editor data.
     * @abstract
     */
    serializeState() {
        throw new Error('Subclass must implement serializeState()');
    }

    /**
     * Restore editor data from a deserialized state object.
     * @abstract
     */
    restoreState(_state) {
        throw new Error('Subclass must implement restoreState()');
    }

    /**
     * Request a history save. Debounced at 100ms to prevent flooding during
     * continuous drawing operations.
     */
    saveState() {
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        this._saveStateTimer = setTimeout(() => {
            this._doSaveState();
        }, 300);
    }

    /** @private */
    _doSaveState() {
        const state = JSON.stringify(this.serializeState());

        // Skip very large states to avoid excessive memory usage (>200KB)
        if (state.length > 200000) return;

        // If identical to current state, skip
        if (this.history[this.historyIndex] === state) return;

        // Truncate any future states when we are mid-history
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        this.history.push(state);
        this.historyIndex++;

        // Cap history at 15 entries for memory efficiency
        if (this.history.length > 15) {
            this.history.shift();
            this.historyIndex--;
        }
    }

    /** Undo the last change. Returns true if successful. */
    undo() {
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.historyIndex > 0) {
            this.historyIndex--;
            try {
                const state = JSON.parse(this.history[this.historyIndex]);
                this.restoreState(state);
            } catch (e) {
                console.error(`${this.getEditorClassName()}: Failed to parse undo state`, e);
                return false;
            }
            this.selectedItems.clear();
            this.notifyChange();
            this.renderThrottled();
            return true;
        }
        return false;
    }

    /** Redo the last undone change. Returns true if successful. */
    redo() {
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            try {
                const state = JSON.parse(this.history[this.historyIndex]);
                this.restoreState(state);
            } catch (e) {
                console.error(`${this.getEditorClassName()}: Failed to parse redo state`, e);
                return false;
            }
            this.selectedItems.clear();
            this.notifyChange();
            this.renderThrottled();
            return true;
        }
        return false;
    }

    /**
     * Reset history to a single snapshot of the current state.
     * Useful after loading data externally (not a user edit).
     */
    resetHistory() {
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        this.history = [JSON.stringify(this.serializeState())];
        this.historyIndex = 0;
    }

    // =========================================================================
    // 13. Grid Synchronization API
    // =========================================================================

    /**
     * Synchronize grid parameters with an external source (e.g. piano roll).
     * Accepts an object with any combination of: xrange, xoffset, grid, timebase.
     */
    syncWith(source) {
        const oldXRange = this.options.xrange;
        const oldXOffset = this.options.xoffset;
        const oldGrid = this.options.grid;

        if (source.xrange !== undefined) this.options.xrange = source.xrange;
        if (source.xoffset !== undefined) this.options.xoffset = source.xoffset;
        if (source.grid !== undefined) this.options.grid = source.grid;
        if (source.timebase !== undefined) this.options.timebase = source.timebase;

        if (oldXRange !== this.options.xrange ||
            oldXOffset !== this.options.xoffset ||
            oldGrid !== this.options.grid) {
            this.gridDirty = true;
        }

        this.renderThrottled();
    }

    /** Set the visible tick range. */
    setXRange(xrange) {
        this.options.xrange = xrange;
        this.gridDirty = true;
        this.renderThrottled();
    }

    /** Set the horizontal scroll offset in ticks. */
    setXOffset(xoffset) {
        this.options.xoffset = xoffset;
        this.gridDirty = true;
        this.renderThrottled();
    }

    /** Set the grid subdivision size in ticks. */
    setGrid(grid) {
        this.options.grid = grid;
        this.gridDirty = true;
        this.renderThrottled();
    }

    // =========================================================================
    // 14. Resize Handling
    // =========================================================================

    /** Recalculate canvas dimensions to match the container. */
    resize() {
        // getBoundingClientRect forces reflow naturally when needed
        const rect = this.element.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const minHeight = this.getMinResizeHeight();

        if (width > 0 && height > minHeight) {
            const oldHeight = this.canvas.height;

            // Resolution scale: lowPowerMode reduces pixel count for better performance
            const dpr = this.options.lowPowerMode ? 0.75 : 1;
            const scaledW = Math.round(width * dpr);
            const scaledH = Math.round(height * dpr);

            this.canvas.width = scaledW;
            this.canvas.height = scaledH;
            this.canvas.style.width = width + 'px';
            this.canvas.style.height = height + 'px';
            if (dpr !== 1) {
                this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            // Ensure grid buffer exists and matches
            if (!this.gridCanvas) {
                this.gridCanvas = document.createElement('canvas');
                this.gridCtx = this.gridCanvas.getContext('2d');
            }
            this.gridCanvas.width = scaledW;
            this.gridCanvas.height = scaledH;
            if (dpr !== 1) {
                this.gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
            this.gridDirty = true;

            this.onResize();
            this.renderThrottled();

            // Stability check: if the height changed dramatically, verify
            // after one frame that the layout has settled.
            if (oldHeight > 0 && Math.abs(height - oldHeight) > 50 && !this._resizeStabilizing) {
                this._resizeStabilizing = true;
                requestAnimationFrame(() => {
                    this._resizeStabilizing = false;
                    const newHeight = this.element.getBoundingClientRect().height;
                    if (Math.abs(newHeight - height) > 2) {
                        this.resize();
                    }
                });
            }
        }
    }

    /** Override for additional resize logic. */
    onResize() {}

    // =========================================================================
    // 15. Change Notification
    // =========================================================================

    /** Invoke the onChange callback if one was provided. */
    notifyChange() {
        if (typeof this.options.onChange === 'function') {
            this.options.onChange();
        }
    }

    // =========================================================================
    // 16. Cleanup / Destroy
    // =========================================================================

    /** Remove all event listeners, cancel pending frames, and detach DOM. */
    destroy() {
        // Cancel pending async work
        if (this._mouseMoveRAF) cancelAnimationFrame(this._mouseMoveRAF);
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);

        // Remove canvas event listeners
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this._boundMouseDown);
            this.canvas.removeEventListener('mousemove', this._boundMouseMove);
            this.canvas.removeEventListener('mouseup', this._boundMouseUp);
            this.canvas.removeEventListener('mouseleave', this._boundMouseLeave);
        }

        // Remove global listeners
        document.removeEventListener('keydown', this._boundKeyDown);
        window.removeEventListener('resize', this._boundResize);

        // Release grid buffer
        this.gridCanvas = null;
        this.gridCtx = null;

        // Let subclass clean up
        this.onDestroy();

        // Detach DOM
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }

    /** Override for additional cleanup. */
    onDestroy() {}

    // =========================================================================
    // 17. Utility Helpers
    // =========================================================================

    /**
     * Helper to draw standard horizontal grid lines with labels.
     * Useful for subclasses implementing renderGridLabels().
     *
     * @param {CanvasRenderingContext2D} ctx - The grid buffer context
     * @param {number} labelMargin - Width of the label area in pixels
     * @param {number[]} values - Domain values where grid lines should be drawn
     * @param {object} [opts] - Optional styling
     * @param {string} [opts.lineColor='#3a3a3a']
     * @param {string} [opts.labelColor='#aaa']
     * @param {string} [opts.bgColor='#1a1a1a']
     * @param {string} [opts.font='11px monospace']
     * @param {function} [opts.formatLabel] - Custom label formatter (value => string)
     * @param {function} [opts.getLineColor] - Per-value line color (value => string|null)
     * @param {function} [opts.getLabelColor] - Per-value label color (value => string|null)
     */
    drawHorizontalGridLines(ctx, labelMargin, values, opts = {}) {
        const isDark = document.body.classList.contains('dark-mode');
        const lineColor = opts.lineColor || (isDark ? '#3a3a3a' : '#d4daff');
        const labelColor = opts.labelColor || (isDark ? '#aaa' : '#5a6089');
        const bgColor = opts.bgColor || (isDark ? '#1a1a1a' : '#f0f4ff');
        const font = opts.font || '11px monospace';
        const formatLabel = opts.formatLabel || ((v) => v.toString());
        const w = this.gridCanvas.width;

        ctx.lineWidth = 1;
        ctx.font = font;
        ctx.textAlign = 'right';

        values.forEach(value => {
            const y = this.valueToY(value);

            // Grid line
            ctx.strokeStyle = (opts.getLineColor && opts.getLineColor(value)) || lineColor;
            ctx.beginPath();
            ctx.moveTo(labelMargin, y);
            ctx.lineTo(w, y);
            ctx.stroke();

            // Label background
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, y - 7, labelMargin - 2, 14);

            // Label text
            ctx.fillStyle = (opts.getLabelColor && opts.getLabelColor(value)) || labelColor;
            ctx.fillText(formatLabel(value), labelMargin - 5, y + 4);
        });
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BaseCanvasEditor;
}
