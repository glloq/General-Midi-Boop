/**
 * CanvasRenderer — Shared base class for canvas-based MIDI renderers.
 *
 * Background
 * ----------
 * DrumGridRenderer, TablatureRenderer and WindMelodyRenderer each render
 * a MIDI grid/staff/tab on a `<canvas>`. They duplicated the same
 * scaffolding: scrollX/zoom state, RAF coalescing, mouse + wheel +
 * dblclick listener wiring, selection state, undo/redo stack, clipboard,
 * tick↔x conversion, playhead and time-signature setters (audit §6.2 —
 * ~3000 lines across the three).
 *
 * This base owns the truly identical parts. Subclasses override the
 * abstract `redraw()`, `setVerticalZoom()` and the input handler
 * implementations (`_handleMouseDown` etc.) — their semantics diverge
 * too much to factor (drum cell vs string-fret vs note-pitch).
 *
 * Hook surface (override in subclass)
 * -----------------------------------
 *   - `redraw()`                          — paint the canvas (required)
 *   - `_handleMouseDown/Move/Up/DblClick/Wheel` — interaction (required)
 *   - `setVerticalZoom(factor)`           — value-axis zoom (override)
 *   - `_xToTick(x)` for sub-tick precision (override; default rounds)
 *   - `_attachContextMenu()`              — return true to also attach
 *     the auxclick handler (DrumGrid + Tablature) — default false
 *     (WindMelody doesn't need it).
 */

(function () {
    'use strict';

    /** Soft caps for {@link CanvasRenderer.setZoom}. */
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 20;

    /** Default undo-history depth. */
    const DEFAULT_MAX_UNDO = 20;

    class CanvasRenderer {
        /**
         * @param {HTMLCanvasElement} canvas
         * @param {Object} [options]
         * @param {number} [options.headerWidth=0]       - Left margin reserved for labels.
         * @param {number} [options.topMargin=0]         - Top margin (ruler).
         * @param {number} [options.ticksPerBeat=480]
         * @param {number} [options.beatsPerMeasure=4]
         * @param {Function} [options.onScrollChange]    - Notified after scrollX/zoom changes.
         * @param {number} [options.maxUndo=DEFAULT_MAX_UNDO]
         */
        constructor(canvas, options = {}) {
            if (!canvas) throw new Error('CanvasRenderer: canvas is required');
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');

            // Layout
            this.headerWidth     = options.headerWidth     ?? 0;
            this.topMargin       = options.topMargin       ?? 0;
            this.ticksPerBeat    = options.ticksPerBeat    ?? 480;
            this.beatsPerMeasure = options.beatsPerMeasure ?? 4;

            // Scroll / zoom
            this.scrollX        = 0;
            this.ticksPerPixel  = 2; // px per tick → tickToX divides by this

            // Playhead
            this.playheadTick = 0;

            // RAF coalescing
            this._redrawScheduled = false;
            this._rafId = 0;

            // Interaction state (concrete handlers are subclass-defined)
            this._isDragging = false;
            this._dragStart  = null;
            this._dragMode   = null;

            // Selection
            this.selectedEvents = new Set();
            this.selectionRect = null;

            // Undo / redo
            this._undoStack = [];
            this._redoStack = [];
            this._maxUndoSize = options.maxUndo ?? DEFAULT_MAX_UNDO;

            // Clipboard
            this._clipboard = [];

            // Theme tokens — subclass populates via updateTheme() if needed.
            this.colors = {};

            // External callback for scroll/zoom changes.
            this.onScrollChange = options.onScrollChange ?? null;

            // Bind input handlers — subclass MUST implement them.
            this._onMouseDown  = (e) => this._handleMouseDown(e);
            this._onMouseMove  = (e) => this._handleMouseMove(e);
            this._onMouseUp    = (e) => this._handleMouseUp(e);
            this._onDblClick   = (e) => this._handleDblClick(e);
            this._onWheel      = (e) => this._handleWheel(e);
            this._onContextMenu = (e) => {
                // Middle-click guard preserved from legacy renderers — some
                // mice translate auxclick into a context menu request.
                if (e.button === 1) e.preventDefault();
            };

            this._attachListeners();
        }

        // =================================================================
        // Listener wiring
        // =================================================================

        _attachListeners() {
            this.canvas.addEventListener('mousedown',  this._onMouseDown);
            this.canvas.addEventListener('mousemove',  this._onMouseMove);
            this.canvas.addEventListener('mouseup',    this._onMouseUp);
            this.canvas.addEventListener('dblclick',   this._onDblClick);
            this.canvas.addEventListener('wheel',      this._onWheel, { passive: false });
            if (this._attachContextMenu()) {
                this.canvas.addEventListener('auxclick',    this._onContextMenu);
                this.canvas.addEventListener('contextmenu', this._onContextMenu);
            }
        }

        /**
         * @returns {boolean} `true` to attach auxclick/contextmenu.
         *   Subclasses that need a middle-click handler override this.
         */
        _attachContextMenu() { return false; }

        // =================================================================
        // Scroll / zoom setters
        // =================================================================

        setScrollX(tickOffset) {
            this.scrollX = Math.max(0, tickOffset);
            this.requestRedraw();
            this._notifyScrollChange();
        }

        setZoom(ticksPerPixel) {
            this.ticksPerPixel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, ticksPerPixel));
            this.requestRedraw();
            this._notifyScrollChange();
        }

        setPlayhead(tick) {
            this.playheadTick = tick;
            this.requestRedraw();
        }

        setTimeSignature(ticksPerBeat, beatsPerMeasure) {
            this.ticksPerBeat    = ticksPerBeat;
            this.beatsPerMeasure = beatsPerMeasure;
            this.requestRedraw();
        }

        _notifyScrollChange() {
            if (typeof this.onScrollChange === 'function') {
                try { this.onScrollChange(); }
                catch (_) { /* best-effort */ }
            }
        }

        // =================================================================
        // Selection helpers
        // =================================================================

        selectEvent(index)    { this.selectedEvents.add(index); }
        deselectEvent(index)  { this.selectedEvents.delete(index); }
        clearSelection()      { this.selectedEvents.clear(); }

        // =================================================================
        // Coordinate conversion. Subclasses needing sub-tick precision
        // (WindMelody) override `_xToTick`.
        // =================================================================

        _tickToX(tick) {
            return this.headerWidth + (tick - this.scrollX) / this.ticksPerPixel;
        }

        _xToTick(x) {
            return Math.round((x - this.headerWidth) * this.ticksPerPixel + this.scrollX);
        }

        // =================================================================
        // RAF render coalescing
        // =================================================================

        requestRedraw() {
            if (this._redrawScheduled) return;
            this._redrawScheduled = true;
            this._rafId = requestAnimationFrame(() => {
                this._redrawScheduled = false;
                this._rafId = 0;
                this.redraw();
            });
        }

        /** Paint the canvas. MUST be overridden by the subclass. */
        redraw() {
            throw new Error('CanvasRenderer: subclass must implement redraw()');
        }

        // =================================================================
        // Canvas size
        // =================================================================

        /**
         * Default `resize` assigns the canvas size and triggers a redraw.
         * Subclasses that need to recompute layout (DrumGrid scrollbar,
         * Tablature line spacing) can override and call `super.resize()`.
         */
        resize(width, height) {
            if (width !== undefined && height !== undefined) {
                this.canvas.width = width;
                this.canvas.height = height;
            }
            this.requestRedraw();
        }

        // =================================================================
        // Abstract input handlers — subclass MUST implement.
        // =================================================================

        _handleMouseDown(/* e */) { /* override */ }
        _handleMouseMove(/* e */) { /* override */ }
        _handleMouseUp(/* e */)   { /* override */ }
        _handleDblClick(/* e */)  { /* override */ }
        _handleWheel(/* e */)     { /* override */ }

        // =================================================================
        // Vertical-zoom hook — subclass implements (row / line / note).
        // =================================================================

        setVerticalZoom(/* factor */) { /* override */ }

        // =================================================================
        // Cleanup
        // =================================================================

        destroy() {
            if (this._rafId) {
                cancelAnimationFrame(this._rafId);
                this._rafId = 0;
            }
            this._redrawScheduled = false;

            this.canvas.removeEventListener('mousedown',  this._onMouseDown);
            this.canvas.removeEventListener('mousemove',  this._onMouseMove);
            this.canvas.removeEventListener('mouseup',    this._onMouseUp);
            this.canvas.removeEventListener('dblclick',   this._onDblClick);
            this.canvas.removeEventListener('wheel',      this._onWheel);
            if (this._attachContextMenu()) {
                this.canvas.removeEventListener('auxclick',    this._onContextMenu);
                this.canvas.removeEventListener('contextmenu', this._onContextMenu);
            }

            this.selectedEvents.clear();
            this._undoStack.length = 0;
            this._redoStack.length = 0;
            this._clipboard.length = 0;
        }
    }

    if (typeof window !== 'undefined') {
        window.CanvasRenderer = CanvasRenderer;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = CanvasRenderer;
    }
})();
