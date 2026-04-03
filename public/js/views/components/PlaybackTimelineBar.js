// ============================================================================
// Fichier: public/js/views/components/PlaybackTimelineBar.js
// Description: Reusable Canvas-based playback timeline bar component
//   Displays a measure/beat ruler, draggable playhead, and draggable
//   start/end range markers. Designed for integration into piano roll,
//   wind, drum, and tablature editors.
//
//   Interaction model:
//   - Drag playhead marker → seek
//   - Double-click on empty area → seek to that position
//   - Drag on empty area → pan the view horizontally
//   - Mouse wheel → horizontal scroll
//   - Touch support for all interactions
// ============================================================================

// eslint-disable-next-line no-unused-vars
class PlaybackTimelineBar {
    constructor(container, options = {}) {
        // Create canvas element inside container
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.canvas.style.display = 'block';
        this.canvas.style.width = '100%';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        // Time signature
        this.ticksPerBeat = options.ticksPerBeat || 480;
        this.beatsPerMeasure = options.beatsPerMeasure || 4;

        // Layout
        this.leftOffset = options.leftOffset || 0;
        this.height = options.height || 30;
        this.canvas.style.height = this.height + 'px';

        // Zoom / scroll
        this.ticksPerPixel = 2;
        this.scrollX = 0;          // tick offset for horizontal scroll

        // Playhead
        this.playheadTick = 0;

        // Range markers
        this.rangeStart = 0;
        this.rangeEnd = 0;

        // Total ticks in the sequence
        this.totalTicks = 0;

        // Callbacks
        this.onSeek = options.onSeek || null;
        this.onRangeChange = options.onRangeChange || null;
        this.onPan = options.onPan || null;

        // Interaction state
        this._isDragging = false;
        this._dragTarget = null;    // 'playhead' | 'rangeStart' | 'rangeEnd'
        this._hoverTarget = null;   // for cursor changes
        this._dirty = true;
        this._rafId = null;

        // Pan state (drag on empty area to scroll the view)
        this._isPanning = false;
        this._panStartX = 0;
        this._panStartScrollX = 0;

        // Double-click detection
        this._lastClickTime = 0;
        this._lastClickX = 0;
        this._DOUBLE_CLICK_MS = 350;
        this._DOUBLE_CLICK_PX = 8;

        // Marker geometry constants
        this._markerSize = 8;       // triangle half-width

        // Colors (populated by updateTheme)
        this.colors = {};
        this.updateTheme();

        // Bind event handlers
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onWheel = this._handleWheel.bind(this);
        this._onDblClick = this._handleDblClick.bind(this);
        this._onTouchStart = this._handleTouchStart.bind(this);
        this._onTouchMove = this._handleTouchMove.bind(this);
        this._onTouchEnd = this._handleTouchEnd.bind(this);
        this._onResize = this.resize.bind(this);

        // Mouse events
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        this.canvas.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);

        // Double-click for seek
        this.canvas.addEventListener('dblclick', this._onDblClick);

        // Wheel for horizontal scroll
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

        // Touch events
        this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        this.canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });

        // Resize
        window.addEventListener('resize', this._onResize);

        // Initial sizing
        this.resize();

        // Initial render
        this._scheduleRender();
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
                headerText: '#a0aec0',
                beatText: '#718096',
                playhead: '#ff4444',
                rangeMarker: '#4caf50',
                rangeFill: 'rgba(76, 175, 80, 0.12)',
                border: '#2d3748',
            };
        } else {
            this.colors = {
                background: '#f0f4ff',
                gridLine: '#d4daff',
                measureLine: '#b0b8e8',
                headerText: '#5a6089',
                beatText: '#9498b8',
                playhead: '#ff4444',
                rangeMarker: '#4caf50',
                rangeFill: 'rgba(76, 175, 80, 0.10)',
                border: '#d4daff',
            };
        }

        this._dirty = true; this._scheduleRender();
    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    setLeftOffset(px) {
        if (this.leftOffset !== px) {
            this.leftOffset = px;
            this._dirty = true; this._scheduleRender();
        }
    }

    setZoom(ticksPerPixel) {
        this.ticksPerPixel = Math.max(0.5, Math.min(20, ticksPerPixel));
        this._dirty = true; this._scheduleRender();
    }

    setScrollX(tickOffset) {
        this.scrollX = Math.max(0, tickOffset);
        this._dirty = true; this._scheduleRender();
    }

    setPlayhead(tick) {
        if (this.playheadTick !== tick) {
            this.playheadTick = tick;
            this._dirty = true; this._scheduleRender();
        }
    }

    setRange(startTick, endTick) {
        this.rangeStart = Math.max(0, startTick);
        this.rangeEnd = Math.max(this.rangeStart, endTick);
        this._dirty = true; this._scheduleRender();
    }

    getRange() {
        return { start: this.rangeStart, end: this.rangeEnd };
    }

    setTotalTicks(ticks) {
        this.totalTicks = Math.max(0, ticks);
        this._dirty = true; this._scheduleRender();
    }

    setTimeSignature(ticksPerBeat, beatsPerMeasure) {
        this.ticksPerBeat = ticksPerBeat || 480;
        this.beatsPerMeasure = beatsPerMeasure || 4;
        this._dirty = true; this._scheduleRender();
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.container.getBoundingClientRect();
        const w = rect.width;
        const h = this.height;

        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this._dirty = true; this._scheduleRender();
    }

    // ========================================================================
    // COORDINATE HELPERS
    // ========================================================================

    /** Convert a tick value to an x pixel position on the canvas. */
    _tickToX(tick) {
        return this.leftOffset + (tick - this.scrollX) / this.ticksPerPixel;
    }

    /** Convert an x pixel position on the canvas to a tick value. */
    _xToTick(x) {
        return (x - this.leftOffset) * this.ticksPerPixel + this.scrollX;
    }

    /** Snap a tick to the nearest beat boundary. */
    _snapToBeat(tick) {
        const beatTicks = this.ticksPerBeat;
        return Math.round(tick / beatTicks) * beatTicks;
    }

    // ========================================================================
    // HIT TESTING
    // ========================================================================

    /**
     * Determine what element (if any) is under the given canvas-local point.
     * Returns 'playhead' | 'rangeStart' | 'rangeEnd' | null
     */
    _hitTest(x, y) {
        const ms = this._markerSize;
        const h = this.height;

        // Playhead triangle (top of canvas, pointing down)
        const phX = this._tickToX(this.playheadTick);
        if (Math.abs(x - phX) <= ms && y <= ms * 2) {
            return 'playhead';
        }

        // Range start marker (bottom-left triangle)
        const rsX = this._tickToX(this.rangeStart);
        if (Math.abs(x - rsX) <= ms && y >= h - ms * 2) {
            return 'rangeStart';
        }

        // Range end marker (bottom-right triangle)
        const reX = this._tickToX(this.rangeEnd);
        if (Math.abs(x - reX) <= ms && y >= h - ms * 2) {
            return 'rangeEnd';
        }

        return null;
    }

    // ========================================================================
    // MOUSE INTERACTION
    // ========================================================================

    _getCanvasPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _handleMouseDown(e) {
        const pos = this._getCanvasPos(e);
        const target = this._hitTest(pos.x, pos.y);

        if (target) {
            // Start dragging a specific marker (playhead, rangeStart, rangeEnd)
            this._isDragging = true;
            this._dragTarget = target;
            e.preventDefault();
            return;
        }

        // Empty area → start panning the view
        if (pos.x >= this.leftOffset) {
            this._isPanning = true;
            this._panStartX = pos.x;
            this._panStartScrollX = this.scrollX;
            this.canvas.style.cursor = 'grabbing';
            e.preventDefault();
        }
    }

    _handleMouseMove(e) {
        const pos = this._getCanvasPos(e);

        // Marker dragging (playhead, range markers)
        if (this._isDragging && this._dragTarget) {
            const tick = Math.max(0, this._xToTick(pos.x));
            const snapped = this._snapToBeat(tick);

            switch (this._dragTarget) {
                case 'playhead':
                    this.playheadTick = snapped;
                    this._dirty = true; this._scheduleRender();
                    if (this.onSeek) this.onSeek(this.playheadTick);
                    break;

                case 'rangeStart':
                    this.rangeStart = Math.min(snapped, this.rangeEnd);
                    this._dirty = true; this._scheduleRender();
                    if (this.onRangeChange) this.onRangeChange(this.rangeStart, this.rangeEnd);
                    break;

                case 'rangeEnd':
                    this.rangeEnd = Math.max(snapped, this.rangeStart);
                    this._dirty = true; this._scheduleRender();
                    if (this.onRangeChange) this.onRangeChange(this.rangeStart, this.rangeEnd);
                    break;
            }
            return;
        }

        // View panning (drag on empty area)
        if (this._isPanning) {
            const dx = pos.x - this._panStartX;
            const tickDelta = dx * this.ticksPerPixel;
            const newScrollX = Math.max(0, this._panStartScrollX - tickDelta);
            this.scrollX = newScrollX;
            this._dirty = true; this._scheduleRender();
            if (this.onPan) this.onPan(this.scrollX);
            return;
        }

        // Hover cursor changes
        const target = this._hitTest(pos.x, pos.y);
        if (target !== this._hoverTarget) {
            this._hoverTarget = target;
            if (target === 'playhead' || target === 'rangeStart' || target === 'rangeEnd') {
                this.canvas.style.cursor = 'ew-resize';
            } else if (pos.x >= this.leftOffset) {
                this.canvas.style.cursor = 'grab';
            } else {
                this.canvas.style.cursor = 'default';
            }
        }
    }

    _handleMouseUp(_e) {
        if (this._isDragging) {
            this._isDragging = false;
            this._dragTarget = null;
        }
        if (this._isPanning) {
            this._isPanning = false;
            this.canvas.style.cursor = 'grab';
        }
    }

    // Double-click → seek playhead to position
    _handleDblClick(e) {
        const pos = this._getCanvasPos(e);
        if (pos.x < this.leftOffset) return;

        // Don't double-click on markers (they use drag)
        const target = this._hitTest(pos.x, pos.y);
        if (target) return;

        const tick = Math.max(0, this._xToTick(pos.x));
        this.playheadTick = this._snapToBeat(tick);
        this._dirty = true; this._scheduleRender();
        if (this.onSeek) this.onSeek(this.playheadTick);
        e.preventDefault();
    }

    // ========================================================================
    // WHEEL (horizontal scroll)
    // ========================================================================

    _handleWheel(e) {
        e.preventDefault();

        // Use deltaX for horizontal scroll; fall back to deltaY if no horizontal delta
        let delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;

        // Line mode (deltaMode === 1): multiply by ~40px equivalent
        if (e.deltaMode === 1) delta *= 40;
        // Page mode (deltaMode === 2): multiply by canvas width
        if (e.deltaMode === 2) {
            const w = this.canvas.width / (window.devicePixelRatio || 1);
            delta *= (w - this.leftOffset);
        }

        const tickDelta = delta * this.ticksPerPixel;
        const newScrollX = Math.max(0, this.scrollX + tickDelta);
        this.scrollX = newScrollX;
        this._dirty = true; this._scheduleRender();
        if (this.onPan) this.onPan(this.scrollX);
    }

    // ========================================================================
    // TOUCH INTERACTION
    // ========================================================================

    _getTouchPos(touch) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }

    _handleTouchStart(e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();

        const pos = this._getTouchPos(e.touches[0]);
        const target = this._hitTest(pos.x, pos.y);

        // Double-tap detection → seek
        const now = Date.now();
        if (now - this._lastClickTime < this._DOUBLE_CLICK_MS &&
            Math.abs(pos.x - this._lastClickX) < this._DOUBLE_CLICK_PX) {
            // Double-tap: seek playhead
            if (pos.x >= this.leftOffset && !target) {
                const tick = Math.max(0, this._xToTick(pos.x));
                this.playheadTick = this._snapToBeat(tick);
                this._dirty = true; this._scheduleRender();
                if (this.onSeek) this.onSeek(this.playheadTick);
            }
            this._lastClickTime = 0;
            return;
        }
        this._lastClickTime = now;
        this._lastClickX = pos.x;

        if (target) {
            // Drag a marker
            this._isDragging = true;
            this._dragTarget = target;
            return;
        }

        // Pan on empty area
        if (pos.x >= this.leftOffset) {
            this._isPanning = true;
            this._panStartX = pos.x;
            this._panStartScrollX = this.scrollX;
        }
    }

    _handleTouchMove(e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();

        const pos = this._getTouchPos(e.touches[0]);

        // Marker drag
        if (this._isDragging && this._dragTarget) {
            const tick = Math.max(0, this._xToTick(pos.x));
            const snapped = this._snapToBeat(tick);

            switch (this._dragTarget) {
                case 'playhead':
                    this.playheadTick = snapped;
                    this._dirty = true; this._scheduleRender();
                    if (this.onSeek) this.onSeek(this.playheadTick);
                    break;
                case 'rangeStart':
                    this.rangeStart = Math.min(snapped, this.rangeEnd);
                    this._dirty = true; this._scheduleRender();
                    if (this.onRangeChange) this.onRangeChange(this.rangeStart, this.rangeEnd);
                    break;
                case 'rangeEnd':
                    this.rangeEnd = Math.max(snapped, this.rangeStart);
                    this._dirty = true; this._scheduleRender();
                    if (this.onRangeChange) this.onRangeChange(this.rangeStart, this.rangeEnd);
                    break;
            }
            return;
        }

        // Pan
        if (this._isPanning) {
            const dx = pos.x - this._panStartX;
            const tickDelta = dx * this.ticksPerPixel;
            const newScrollX = Math.max(0, this._panStartScrollX - tickDelta);
            this.scrollX = newScrollX;
            this._dirty = true; this._scheduleRender();
            if (this.onPan) this.onPan(this.scrollX);
        }
    }

    _handleTouchEnd(e) {
        e.preventDefault();
        if (this._isDragging) {
            this._isDragging = false;
            this._dragTarget = null;
        }
        if (this._isPanning) {
            this._isPanning = false;
        }
    }

    // ========================================================================
    // RENDER (on-demand, no continuous RAF loop)
    // ========================================================================

    /**
     * Mark the timeline as needing a redraw.
     * Schedules a single RAF callback — no continuous loop.
     */
    _scheduleRender() {
        if (!this._rafId) {
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                if (this._dirty) {
                    this._dirty = false;
                    this._draw();
                }
            });
        }
    }

    // ========================================================================
    // DRAWING
    // ========================================================================

    _draw() {
        const ctx = this.ctx;
        const w = this.canvas.width / (window.devicePixelRatio || 1);
        const h = this.height;
        const c = this.colors;

        // Clear
        ctx.fillStyle = c.background;
        ctx.fillRect(0, 0, w, h);

        // Bottom border
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h - 0.5);
        ctx.lineTo(w, h - 0.5);
        ctx.stroke();

        // Left offset area (label gutter)
        if (this.leftOffset > 0) {
            ctx.fillStyle = c.background;
            ctx.fillRect(0, 0, this.leftOffset, h);
            // Separator line
            ctx.strokeStyle = c.border;
            ctx.beginPath();
            ctx.moveTo(this.leftOffset - 0.5, 0);
            ctx.lineTo(this.leftOffset - 0.5, h);
            ctx.stroke();
        }

        // Clip to the timeline area (right of leftOffset)
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.leftOffset, 0, w - this.leftOffset, h);
        ctx.clip();

        // Draw ruler gridlines and labels
        this._drawRuler(ctx, w, h);

        // Draw range shading
        this._drawRangeFill(ctx, h);

        // Draw range markers
        this._drawRangeMarkers(ctx, h);

        // Draw playhead
        this._drawPlayhead(ctx, h);

        ctx.restore();
    }

    _drawRuler(ctx, w, h) {
        const c = this.colors;
        const ticksPerMeasure = this.ticksPerBeat * this.beatsPerMeasure;

        // Determine visible tick range
        const startTick = Math.max(0, this.scrollX);
        const endTick = this.scrollX + (w - this.leftOffset) * this.ticksPerPixel;

        // First visible measure
        const firstMeasure = Math.floor(startTick / ticksPerMeasure);
        const lastMeasure = Math.ceil(endTick / ticksPerMeasure);

        // Measure lines and labels
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

        for (let m = firstMeasure; m <= lastMeasure; m++) {
            const measureTick = m * ticksPerMeasure;
            const x = this._tickToX(measureTick);

            if (x < this.leftOffset || x > w) continue;

            // Measure line (full height)
            ctx.strokeStyle = c.measureLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, 0);
            ctx.lineTo(Math.round(x) + 0.5, h);
            ctx.stroke();

            // Measure number
            ctx.fillStyle = c.headerText;
            ctx.fillText(String(m + 1), x + 4, h * 0.35);

            // Beat subdivision tick marks
            for (let b = 1; b < this.beatsPerMeasure; b++) {
                const beatTick = measureTick + b * this.ticksPerBeat;
                const bx = this._tickToX(beatTick);

                if (bx < this.leftOffset || bx > w) continue;

                // Shorter tick mark for beats
                ctx.strokeStyle = c.gridLine;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(Math.round(bx) + 0.5, h * 0.55);
                ctx.lineTo(Math.round(bx) + 0.5, h);
                ctx.stroke();

                // Beat number (optional, show when zoomed in enough)
                const pixelsPerBeat = this.ticksPerBeat / this.ticksPerPixel;
                if (pixelsPerBeat > 30) {
                    ctx.fillStyle = c.beatText;
                    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                    ctx.fillText(String(b + 1), bx + 2, h * 0.75);
                    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                }
            }
        }
    }

    _drawRangeFill(ctx, h) {
        if (this.rangeStart >= this.rangeEnd) return;

        const c = this.colors;
        const x1 = this._tickToX(this.rangeStart);
        const x2 = this._tickToX(this.rangeEnd);

        ctx.fillStyle = c.rangeFill;
        ctx.fillRect(x1, 0, x2 - x1, h);
    }

    _drawRangeMarkers(ctx, h) {
        const c = this.colors;
        const ms = this._markerSize;

        // Start marker — upward-pointing triangle at the bottom
        const sx = this._tickToX(this.rangeStart);
        ctx.fillStyle = c.rangeMarker;
        ctx.beginPath();
        ctx.moveTo(sx, h);
        ctx.lineTo(sx - ms, h - ms * 1.5);
        ctx.lineTo(sx + ms, h - ms * 1.5);
        ctx.closePath();
        ctx.fill();

        // End marker — upward-pointing triangle at the bottom
        const ex = this._tickToX(this.rangeEnd);
        ctx.fillStyle = c.rangeMarker;
        ctx.beginPath();
        ctx.moveTo(ex, h);
        ctx.lineTo(ex - ms, h - ms * 1.5);
        ctx.lineTo(ex + ms, h - ms * 1.5);
        ctx.closePath();
        ctx.fill();
    }

    _drawPlayhead(ctx, h) {
        const c = this.colors;
        const ms = this._markerSize;
        const px = this._tickToX(this.playheadTick);

        // Vertical line
        ctx.strokeStyle = c.playhead;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
        ctx.stroke();

        // Downward-pointing triangle at the top
        ctx.fillStyle = c.playhead;
        ctx.beginPath();
        ctx.moveTo(px, ms * 1.5);
        ctx.lineTo(px - ms, 0);
        ctx.lineTo(px + ms, 0);
        ctx.closePath();
        ctx.fill();
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
        // Stop render loop
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        // Remove event listeners
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('dblclick', this._onDblClick);
        this.canvas.removeEventListener('wheel', this._onWheel);
        this.canvas.removeEventListener('touchstart', this._onTouchStart);
        this.canvas.removeEventListener('touchmove', this._onTouchMove);
        this.canvas.removeEventListener('touchend', this._onTouchEnd);
        window.removeEventListener('resize', this._onResize);

        // Remove canvas from DOM
        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}
