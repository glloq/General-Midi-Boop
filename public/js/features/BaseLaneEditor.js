/**
 * BaseLaneEditor — Shared scaffolding for 1D lane editors on a canvas.
 *
 * Background
 * ----------
 * VelocityEditor, CCPitchbendEditor and TempoEditor each implement a
 * "lane" — a horizontal strip showing values over time (note velocities,
 * CC/pitchbend curves, tempo changes). Their constructors, event wiring,
 * RAF render loop, history machinery, grid rendering, and tool state
 * machine were copy-pasted, with only minor parameter differences (audit
 * §6.1 — ~40 % duplication, ~2 850 lines across the three).
 *
 * This base class owns the IDENTICAL parts. Subclasses override the few
 * methods that genuinely differ (data shape, hit-test, value↔Y, glyph
 * rendering, optional extra listeners). The goal isn't to express every
 * subtlety here — it is to make subclasses smaller and consistent so a
 * fix landed in one place propagates to all editors.
 *
 * Hook surface (subclasses override)
 * ----------------------------------
 *   - `_className()`                       — CSS class for the host div
 *   - `_dataField()`                       — name of the array field ("events"|"sequence")
 *   - `_idOf(item)` / `_itemHasId(item,id)`— selection identity
 *   - `_valueToY(value)` / `_yToValue(y)`  — vertical mapping
 *   - `_renderData()`                      — paint the lane glyphs
 *   - `_renderHorizontalGrid(ctx, ...)`    — paint value-axis lines+labels
 *   - `_attachExtraListeners() / _detachExtraListeners()` — e.g. Tempo wheel
 *   - `_onHistoryRestore()`                — post-undo/redo hook
 *   - `_renderCenterLine()`                — optional decoration
 *
 * Audit notes
 * -----------
 * The base does NOT try to factor `handleMouseDown/Move/Up` or
 * `createLine` — these are subclass-specific (note vs event vs tempo
 * point hit-test, sort semantics, value clamping). Factoring them would
 * require deeper data-model unification (audit §1.2) which is a separate
 * refactor.
 */

(function () {
    'use strict';

    /**
     * Debounce window between `saveState()` calls (ms). Matches the
     * historical 100 ms value used by all three editors.
     */
    const DEFAULT_SAVE_DEBOUNCE_MS = 100;

    /** History depth cap (audit §8.3). */
    const DEFAULT_HISTORY_CAP = 50;

    /**
     * Default left margin reserved for value-axis labels in the grid
     * buffer canvas. Subclasses can override via `_labelMargin()`.
     * Matches the piano roll's left chrome (CanvasPianoRollRenderer
     * KB_WIDTH = SB_W 24 + KB_W 40 = 64) so the lane editor's columns
     * line up vertically with the notes above.
     */
    const DEFAULT_LABEL_MARGIN = 64;

    class BaseLaneEditor {
        /**
         * @param {HTMLElement} container
         * @param {Object} options
         * @param {number} [options.height]
         * @param {number} [options.timebase=480]
         * @param {number} [options.xrange=1920]
         * @param {number} [options.xoffset=0]
         * @param {number} [options.grid=15]
         * @param {Function} [options.onChange]
         */
        constructor(container, options = {}) {
            this.container = container;

            const defaultHeight = (typeof MidiEditorConstants !== 'undefined')
                ? MidiEditorConstants.defaultEditorHeight
                : 150;

            this.options = {
                height: options.height || defaultHeight,
                timebase: options.timebase || 480,
                xrange: options.xrange || 1920,
                xoffset: options.xoffset || 0,
                grid: options.grid || 15,
                onChange: options.onChange || null,
                ...options
            };

            // Tool state (shared state machine — values defined by subclass usage).
            this.currentTool = 'select';
            this.curveType = 'linear';
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
            this.lineStart = null;
            this.dragStart = null;
            this.selectionRect = null;

            // Selection. Subclasses pick what `_idOf()` returns (sequence index
            // for note-based editors, item.id for event-based editors).
            this.selectedIds = new Set();

            // Channel filtering (Velocity / CC). Tempo ignores it.
            this.currentChannel = 0;
            this.activeChannels = new Set([0]);

            // Undo/redo stack of JSON snapshots of `this[this._dataField()]`.
            this.history = [];
            this.historyIndex = -1;
            this.historyCap = DEFAULT_HISTORY_CAP;

            // RAF coalescing for render() and mousemove() (audit §6.3).
            this._renderRafId = 0;
            this._mouseMoveRAF = null;
            this._saveStateTimer = null;

            // Off-screen grid cache.
            this.gridCanvas = null;
            this.gridCtx = null;
            this.gridDirty = true;
        }

        // =================================================================
        // OVERRIDABLE HOOKS — subclasses customize behaviour here.
        // Defaults are deliberately conservative so that an editor can
        // start subclassing without implementing every hook on day one.
        // =================================================================

        /** @returns {string} CSS class for the editor's root element. */
        _className() { return 'lane-editor'; }

        /** @returns {string} Property name for the data array. */
        _dataField() { return 'events'; }

        /** @returns {Array} Current data array (read-through). */
        _getDataArray() { return this[this._dataField()] || []; }

        /** Replace the data array in-place. */
        _setDataArray(arr) { this[this._dataField()] = arr || []; }

        /** Items visible after filtering (channels, CC type, …). */
        _getVisibleData() { return this._getDataArray(); }

        /**
         * @param {*} item
         * @returns {*} Identity for selection. By default, the item's `id`.
         */
        _idOf(item) { return item ? item.id : undefined; }

        /** Convert a value-axis number to a pixel Y. Subclass MUST override. */
        _valueToY(/* value */) {
            throw new Error('BaseLaneEditor: _valueToY() must be overridden');
        }

        /** Inverse of `_valueToY`. Subclass MUST override. */
        _yToValue(/* y */) {
            throw new Error('BaseLaneEditor: _yToValue() must be overridden');
        }

        /** Pixel margin reserved for value labels on the left edge. */
        _labelMargin() { return DEFAULT_LABEL_MARGIN; }

        /** Subclasses paint their values (bars/curves/lines). */
        _renderData() { /* override */ }

        /** Optional decoration (Tempo: 120 BPM line; CC: zero line). */
        _renderCenterLine() { /* optional override */ }

        /** Optional value-axis grid lines + labels. */
        _renderHorizontalGrid(/* ctx, isDark */) { /* optional override */ }

        /** Add an extra listener (e.g. Tempo's wheel handler). */
        _attachExtraListeners() { /* optional override */ }

        /** Mirror `_attachExtraListeners` — invoked from `destroy()`. */
        _detachExtraListeners() { /* optional override */ }

        /** Called after an undo/redo restores the data array. */
        _onHistoryRestore() { /* optional override */ }

        // =================================================================
        // CONSTRUCTION + LIFECYCLE — identical across all editors.
        // =================================================================

        /**
         * Standard init pipeline. Subclasses normally don't override.
         * The constructor doesn't call this automatically so the subclass
         * has a chance to initialise specific fields before the UI/listeners
         * touch them.
         */
        init() {
            this.createUI();
            this.setupEventListeners();
        }

        createUI() {
            const isDark = document.body.classList.contains('dark-mode');

            this.element = document.createElement('div');
            this.element.className = this._className();
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
            this.container.appendChild(this.element);

            this.resize();
        }

        setupEventListeners() {
            this._boundMouseDown   = (e) => this.handleMouseDown(e);
            this._boundMouseMove   = (e) => {
                if (this._mouseMoveRAF) return;
                this._mouseMoveRAF = requestAnimationFrame(() => {
                    this._mouseMoveRAF = null;
                    this.handleMouseMove(e);
                });
            };
            this._boundMouseUp     = (e) => this.handleMouseUp(e);
            this._boundMouseLeave  = (e) => this.handleMouseLeave(e);
            this._boundKeyDown     = (e) => this.handleKeyDown(e);
            this._boundResize      = () => this.resize();
            this._boundThemeChanged = () => this._onThemeChanged();

            this.canvas.addEventListener('mousedown',  this._boundMouseDown);
            this.canvas.addEventListener('mousemove',  this._boundMouseMove);
            this.canvas.addEventListener('mouseup',    this._boundMouseUp);
            this.canvas.addEventListener('mouseleave', this._boundMouseLeave);

            document.addEventListener('keydown', this._boundKeyDown);
            window.addEventListener('resize',  this._boundResize);
            document.addEventListener('theme-changed', this._boundThemeChanged);

            this._attachExtraListeners();
        }

        _onThemeChanged() {
            const isDark = document.body.classList.contains('dark-mode');
            if (this.element) {
                this.element.style.background = isDark ? '#1a1a1a' : '#f0f4ff';
                this.element.style.borderTopColor = isDark ? '#333' : '#d4daff';
            }
            this.gridDirty = true;
            this.renderThrottled();
        }

        resize() {
            // Force reflow up the cascade so we capture the final size.
            if (this.container) void this.container.offsetHeight;
            if (this.container?.parentElement) void this.container.parentElement.offsetHeight;
            if (this.element) void this.element.offsetHeight;

            const rect = this.element.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            if (width <= 0 || height <= 0) return;

            this.canvas.width = width;
            this.canvas.height = height;

            if (!this.gridCanvas) {
                this.gridCanvas = document.createElement('canvas');
                this.gridCanvas.width = width;
                this.gridCanvas.height = height;
                this.gridCtx = this.gridCanvas.getContext('2d');
            } else if (this.gridCanvas.width !== width || this.gridCanvas.height !== height) {
                this.gridCanvas.width = width;
                this.gridCanvas.height = height;
            }
            this.gridDirty = true;
            this.renderThrottled();
        }

        destroy() {
            if (this._mouseMoveRAF) cancelAnimationFrame(this._mouseMoveRAF);
            if (this._renderRafId)  { cancelAnimationFrame(this._renderRafId); this._renderRafId = 0; }
            if (this._saveStateTimer) clearTimeout(this._saveStateTimer);

            if (this.canvas) {
                this.canvas.removeEventListener('mousedown',  this._boundMouseDown);
                this.canvas.removeEventListener('mousemove',  this._boundMouseMove);
                this.canvas.removeEventListener('mouseup',    this._boundMouseUp);
                this.canvas.removeEventListener('mouseleave', this._boundMouseLeave);
            }
            document.removeEventListener('keydown', this._boundKeyDown);
            window.removeEventListener('resize',    this._boundResize);
            document.removeEventListener('theme-changed', this._boundThemeChanged);

            this._detachExtraListeners();

            if (this.element?.parentNode) {
                this.element.parentNode.removeChild(this.element);
            }
        }

        // =================================================================
        // COORDINATE CONVERSION
        // =================================================================

        ticksToX(ticks) {
            const m = this._labelMargin();
            const usable = Math.max(1, this.canvas.width - m);
            return m + ((ticks - this.options.xoffset) / this.options.xrange) * usable;
        }

        xToTicks(x) {
            const m = this._labelMargin();
            const usable = Math.max(1, this.canvas.width - m);
            return Math.round(((x - m) / usable) * this.options.xrange + this.options.xoffset);
        }

        snapToGrid(ticks) {
            const g = this.options.grid;
            return Math.round(ticks / g) * g;
        }

        // =================================================================
        // VIEWPORT SETTERS — used by the modal's sync layer.
        // =================================================================

        setXRange(xrange)  { this.options.xrange  = xrange;  this.gridDirty = true; this.renderThrottled(); }
        setXOffset(xoffset){ this.options.xoffset = xoffset; this.gridDirty = true; this.renderThrottled(); }
        setGrid(grid)     { this.options.grid    = grid;    this.gridDirty = true; this.renderThrottled(); }

        // =================================================================
        // TOOL STATE
        // =================================================================

        setTool(tool) {
            this.currentTool = tool;
            if (this.canvas) this.canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
        }

        setCurveType(curveType) {
            this.curveType = curveType;
        }

        /**
         * Interpolation curves used by `createLine()` in subclasses.
         * @param {number} t - Linear progress 0..1.
         * @returns {number} Eased progress.
         */
        applyCurve(t) {
            switch (this.curveType) {
                case 'linear':       return t;
                case 'exponential':  return t * t;
                case 'logarithmic':  return Math.sqrt(t);
                case 'sine':         return (1 - Math.cos(t * Math.PI)) / 2;
                default:             return t;
            }
        }

        cancelInteractions() {
            this.lineStart = null;
            this.selectionStart = null;
            this.selectionRect = null;
            this.dragStart = null;
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
        }

        // =================================================================
        // SELECTION
        // =================================================================

        selectAll() {
            this.selectedIds.clear();
            for (const item of this._getDataArray()) {
                this.selectedIds.add(this._idOf(item));
            }
            this.renderThrottled();
        }

        clearSelection() {
            if (this.selectedIds.size > 0) {
                this.selectedIds.clear();
                this.renderThrottled();
            }
        }

        /**
         * Rectangle selection in pixel space. Subclasses override
         * `_getVisibleData()` if filtering is needed.
         */
        selectInRect(x1, y1, x2, y2) {
            const left = Math.min(x1, x2);
            const right = Math.max(x1, x2);
            const top = Math.min(y1, y2);
            const bottom = Math.max(y1, y2);

            for (const item of this._getVisibleData()) {
                const ex = this.ticksToX(this._ticksOf(item));
                const ey = this._valueToY(this._valueOf(item));
                if (ex >= left && ex <= right && ey >= top && ey <= bottom) {
                    this.selectedIds.add(this._idOf(item));
                }
            }
        }

        /** Tick coordinate of an item. Defaults to `item.ticks`. */
        _ticksOf(item) { return item.ticks; }

        /** Value of an item (used by `selectInRect`). Override per editor. */
        _valueOf(item) { return item.value ?? 0; }

        // =================================================================
        // UNDO / REDO — JSON snapshot of the data array.
        // =================================================================

        saveState() {
            if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
            this._saveStateTimer = setTimeout(() => this._doSaveState(), DEFAULT_SAVE_DEBOUNCE_MS);
        }

        _doSaveState() {
            this._saveStateTimer = null;
            const snapshot = JSON.stringify(this._getDataArray());

            if (this.historyIndex < this.history.length - 1) {
                this.history = this.history.slice(0, this.historyIndex + 1);
            }
            this.history.push(snapshot);
            this.historyIndex++;

            if (this.history.length > this.historyCap) {
                this.history.shift();
                this.historyIndex--;
            }

            this.notifyChange();
        }

        undo() {
            if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
            if (this.historyIndex <= 0) return false;
            this.historyIndex--;
            return this._restoreFromHistory();
        }

        redo() {
            if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
            if (this.historyIndex >= this.history.length - 1) return false;
            this.historyIndex++;
            return this._restoreFromHistory();
        }

        _restoreFromHistory() {
            try {
                this._setDataArray(JSON.parse(this.history[this.historyIndex]));
            } catch (e) {
                console.error(`${this._className()}: failed to restore history`, e);
                return false;
            }
            this.selectedIds.clear();
            this._onHistoryRestore();
            this.renderThrottled();
            this.notifyChange();
            return true;
        }

        notifyChange() {
            if (typeof this.options.onChange === 'function') {
                try { this.options.onChange(this._getDataArray()); }
                catch (_) { /* best-effort */ }
            }
        }

        // =================================================================
        // RENDER PIPELINE — base draws scaffolding, subclasses draw glyphs.
        // =================================================================

        renderThrottled() {
            if (this._renderRafId) return;
            this._renderRafId = requestAnimationFrame(() => {
                this._renderRafId = 0;
                this.render();
            });
        }

        render() {
            if (!this.ctx || !this.canvas) return;
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            this._renderGrid();
            this._renderCenterLine();
            this._renderData();
            this._renderSelectionRect();
        }

        _renderGrid() {
            if (this.gridDirty || !this.gridCanvas) {
                this._renderGridToBuffer();
                this.gridDirty = false;
            }
            this.ctx.drawImage(this.gridCanvas, 0, 0);
        }

        /**
         * Time-axis grid + label margin. Value-axis is delegated to
         * `_renderHorizontalGrid()`.
         */
        _renderGridToBuffer() {
            if (!this.gridCtx) return;
            const ctx = this.gridCtx;
            const labelMargin = this._labelMargin();
            const isDark = document.body.classList.contains('dark-mode');

            ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);

            // Label area background.
            ctx.fillStyle = isDark ? '#1e1e1e' : '#e0e4f8';
            ctx.fillRect(0, 0, labelMargin, this.gridCanvas.height);

            // Vertical (time) grid — heavier on the beat.
            const ticksPerBeat = this.options.timebase;
            const gridSize = this.options.grid || ticksPerBeat;
            const startTick = Math.floor(this.options.xoffset / ticksPerBeat) * ticksPerBeat;
            const endTick = this.options.xoffset + this.options.xrange;

            for (let t = startTick; t <= endTick; t += gridSize) {
                const x = this.ticksToX(t);
                if (x < labelMargin || x > this.gridCanvas.width) continue;
                const isBeat = (t % ticksPerBeat) === 0;
                ctx.strokeStyle = isDark
                    ? (isBeat ? '#383838' : '#2a2a2a')
                    : (isBeat ? '#d4daff' : '#e8ecff');
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, this.gridCanvas.height);
                ctx.stroke();
            }

            // Value-axis grid (delegated to subclass).
            this._renderHorizontalGrid(ctx, isDark);
        }

        _renderSelectionRect() {
            const r = this.selectionRect;
            if (!r || r.currentX === undefined) return;
            this.ctx.strokeStyle = '#2196F3';
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([5, 5]);
            this.ctx.strokeRect(r.x, r.y, r.currentX - r.x, r.currentY - r.y);
            this.ctx.setLineDash([]);
        }

        // =================================================================
        // INPUT — base intentionally does NOT implement handleMouseDown /
        // Move / Up / Leave / KeyDown. The semantics diverge enough across
        // editors (note vs event vs sorted-tempo points) that factoring
        // them properly would require a unified data model first. Keep
        // them in subclasses for now.
        // =================================================================

        handleMouseDown(/* e */) { /* override */ }
        handleMouseMove(/* e */) { /* override */ }
        handleMouseUp(/* e */)   { /* override */ }
        handleMouseLeave(e)      { this.handleMouseUp(e); }
        handleKeyDown(/* e */)   { /* override */ }
    }

    // Dual export.
    if (typeof window !== 'undefined') {
        window.BaseLaneEditor = BaseLaneEditor;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BaseLaneEditor;
    }
})();
