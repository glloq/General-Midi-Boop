// ============================================================================
// Fichier: public/js/features/NavigationOverviewBar.js
// Description: Canvas-based navigation overview bar for the MIDI editor.
//   Displays a simple bar with a draggable viewport rectangle representing
//   the currently visible portion of the timeline. Allows quick navigation
//   by clicking or dragging to move the view.
//
//   Interaction model:
//   - Click on empty area → jump view to that position
//   - Drag viewport rectangle → pan the view horizontally
//   - Drag on empty area → jump then drag continuously
// ============================================================================

// eslint-disable-next-line no-unused-vars
class NavigationOverviewBar {
    constructor(container, options = {}) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.canvas.style.display = 'block';
        this.canvas.style.width = '100%';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        // Layout
        this.height = options.height || 20;
        this.canvas.style.height = this.height + 'px';

        // Viewport state
        this.xoffset = 0;
        this.xrange = 1920;
        this.maxTick = 0;

        // Minimap state (optional overlay of channel notes)
        this.minimapNotes = null;
        this.minimapColor = null;
        this.minimapPitchRange = null;

        // Callbacks
        this.onNavigate = options.onNavigate || null;
        this.onZoom = options.onZoom || null;

        // Interaction state
        this._isDragging = false;
        this._dragOffsetX = 0; // offset from click to viewport left edge
        this._dirty = true;
        this._rafId = null;
        this._lastNavigateTime = 0;

        // Colors
        this.colors = {};
        this.updateTheme();

        // Bind event handlers
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onResize = this.resize.bind(this);

        // Mouse events
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);

        // Wheel event (zoom)
        this._onWheel = this._handleWheel.bind(this);
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

        // Touch events
        this._onTouchStart = this._handleTouchStart.bind(this);
        this._onTouchMove = this._handleTouchMove.bind(this);
        this._onTouchEnd = this._handleTouchEnd.bind(this);
        this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        this.canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });

        // Resize
        window.addEventListener('resize', this._onResize);

        // Theme change
        this._onThemeChanged = () => { this.updateTheme(); this._scheduleRender(); };
        document.addEventListener('theme-changed', this._onThemeChanged);

        // Initial sizing & render
        this.resize();
        this._scheduleRender();
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');

        if (isDark) {
            this.colors = {
                background: '#1e1e2e',
                tick: 'rgba(255, 255, 255, 0.06)',
                viewportBorder: '#667eea',
                viewportFill: 'rgba(102, 126, 234, 0.18)',
                border: '#2d3748',
            };
        } else {
            this.colors = {
                background: '#e8e0f0',
                tick: 'rgba(118, 75, 162, 0.15)',
                viewportBorder: '#764ba2',
                viewportFill: 'rgba(118, 75, 162, 0.18)',
                border: 'rgba(118, 75, 162, 0.25)',
            };
        }

        this._dirty = true;
        this._scheduleRender();
    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    setViewport(xoffset, xrange, maxTick) {
        if (maxTick !== undefined && maxTick !== null) {
            this.maxTick = maxTick;
        }
        this.xoffset = xoffset || 0;
        this.xrange = xrange || 1920;
        this._dirty = true;
        this._scheduleRender();
    }

    setMinimap(notes, color) {
        if (!notes || notes.length === 0) {
            this.minimapNotes = null;
            this.minimapColor = null;
            this.minimapPitchRange = null;
        } else {
            this.minimapNotes = notes;
            this.minimapColor = color || '#888';
            let min = Infinity;
            let max = -Infinity;
            for (const n of notes) {
                if (n.n < min) min = n.n;
                if (n.n > max) max = n.n;
            }
            this.minimapPitchRange = { min, max };
        }
        this._dirty = true;
        this._scheduleRender();
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.container.getBoundingClientRect();
        this.canvas.width = rect.width * dpr;
        this.canvas.height = this.height * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._dirty = true;
        this._scheduleRender();
    }

    destroy() {
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('wheel', this._onWheel);
        this.canvas.removeEventListener('touchstart', this._onTouchStart);
        this.canvas.removeEventListener('touchmove', this._onTouchMove);
        this.canvas.removeEventListener('touchend', this._onTouchEnd);
        window.removeEventListener('resize', this._onResize);
        document.removeEventListener('theme-changed', this._onThemeChanged);
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }

    // ========================================================================
    // RENDERING
    // ========================================================================

    _scheduleRender() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = null;
            if (this._dirty) {
                this._render();
                this._dirty = false;
            }
        });
    }

    _render() {
        const ctx = this.ctx;
        const w = this.canvas.width / (window.devicePixelRatio || 1);
        const h = this.height;

        // Background
        ctx.fillStyle = this.colors.background;
        ctx.fillRect(0, 0, w, h);

        if (this.maxTick <= 0) {
            // No data - just draw background
            return;
        }

        // Tick marks (light graduation)
        this._renderTickMarks(ctx, w, h);

        // Channel minimap (only drawn if set, e.g. single-channel edit mode)
        this._renderMinimap(ctx, w, h);

        // Viewport rectangle
        const vpRect = this._getViewportRect(w, h);
        ctx.fillStyle = this.colors.viewportFill;
        ctx.fillRect(vpRect.x, vpRect.y, vpRect.w, vpRect.h);
        ctx.strokeStyle = this.colors.viewportBorder;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(vpRect.x, vpRect.y, vpRect.w, vpRect.h);

        // Bottom border
        ctx.strokeStyle = this.colors.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h - 0.5);
        ctx.lineTo(w, h - 0.5);
        ctx.stroke();
    }

    _renderTickMarks(ctx, w, h) {
        // Draw light vertical lines to give a sense of scale
        // Adapt number of marks based on maxTick
        const targetMarks = Math.max(4, Math.min(40, Math.floor(w / 30)));
        const tickSpacing = this.maxTick / targetMarks;

        // Round to nice values
        const niceValues = [120, 240, 480, 960, 1920, 3840, 7680, 15360, 30720, 61440];
        let spacing = niceValues[0];
        for (const nv of niceValues) {
            if (nv >= tickSpacing) { spacing = nv; break; }
            spacing = nv;
        }

        ctx.strokeStyle = this.colors.tick;
        ctx.lineWidth = 1;
        ctx.beginPath();

        for (let tick = spacing; tick < this.maxTick; tick += spacing) {
            const x = Math.round((tick / this.maxTick) * w) + 0.5;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
        }
        ctx.stroke();
    }

    _renderMinimap(ctx, w, h) {
        if (!this.minimapNotes || this.maxTick <= 0) return;

        const effectiveMax = Math.max(this.maxTick, this.xoffset + this.xrange);
        if (effectiveMax <= 0) return;

        const padTop = 1;
        const padBottom = 1;
        const usableH = Math.max(0, h - padTop - padBottom);
        const barH = 2;
        const range = this.minimapPitchRange;
        const spread = range ? Math.max(0, range.max - range.min) : 0;
        const centerY = padTop + (usableH - barH) / 2;

        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = this.minimapColor;

        for (const note of this.minimapNotes) {
            const x = (note.t / effectiveMax) * w;
            const barW = Math.max(1, (note.g / effectiveMax) * w);
            let y;
            if (spread === 0) {
                y = centerY;
            } else {
                const norm = (note.n - range.min) / spread;
                y = padTop + (1 - norm) * (usableH - barH);
            }
            ctx.fillRect(x, y, barW, barH);
        }

        ctx.restore();
    }

    _getViewportRect(w, h) {
        const effectiveMax = Math.max(this.maxTick, this.xoffset + this.xrange);
        const x = (this.xoffset / effectiveMax) * w;
        let vpW = (this.xrange / effectiveMax) * w;
        // Minimum width so it stays clickable
        vpW = Math.max(vpW, 16);
        // Clamp to canvas
        const clampedX = Math.min(x, w - vpW);
        return { x: Math.max(0, clampedX), y: 1, w: vpW, h: h - 2 };
    }

    // ========================================================================
    // INTERACTION
    // ========================================================================

    _getCanvasX(e) {
        const rect = this.canvas.getBoundingClientRect();
        return e.clientX - rect.left;
    }

    _isInsideViewport(canvasX) {
        const w = this.canvas.width / (window.devicePixelRatio || 1);
        const vpRect = this._getViewportRect(w, this.height);
        return canvasX >= vpRect.x && canvasX <= vpRect.x + vpRect.w;
    }

    _navigateToX(canvasX) {
        const w = this.canvas.width / (window.devicePixelRatio || 1);
        if (w <= 0 || this.maxTick <= 0) return;

        const effectiveMax = Math.max(this.maxTick, this.xoffset + this.xrange);
        const maxOffset = Math.max(0, effectiveMax - this.xrange);

        // Center the viewport on the clicked position
        const clickTick = (canvasX / w) * effectiveMax;
        const newOffset = Math.max(0, Math.min(maxOffset, clickTick - this.xrange / 2));
        const percentage = maxOffset > 0 ? (newOffset / maxOffset) * 100 : 0;

        if (this.onNavigate) {
            this.onNavigate(percentage);
        }
    }

    _navigateDrag(canvasX) {
        const now = Date.now();
        if (now - this._lastNavigateTime < 16) return; // throttle ~60fps
        this._lastNavigateTime = now;

        const w = this.canvas.width / (window.devicePixelRatio || 1);
        if (w <= 0 || this.maxTick <= 0) return;

        const effectiveMax = Math.max(this.maxTick, this.xoffset + this.xrange);
        const maxOffset = Math.max(0, effectiveMax - this.xrange);

        // Calculate viewport left edge from drag
        const vpLeftTick = ((canvasX - this._dragOffsetX) / w) * effectiveMax;
        const newOffset = Math.max(0, Math.min(maxOffset, vpLeftTick));
        const percentage = maxOffset > 0 ? (newOffset / maxOffset) * 100 : 0;

        if (this.onNavigate) {
            this.onNavigate(percentage);
        }
    }

    _handleWheel(e) {
        e.preventDefault();
        if (!this.onZoom) return;
        // deltaY > 0 = scroll down = zoom out, deltaY < 0 = scroll up = zoom in
        const factor = e.deltaY > 0 ? 1.25 : 0.8;
        this.onZoom(factor);
    }

    _handleMouseDown(e) {
        e.preventDefault();
        const x = this._getCanvasX(e);
        this._isDragging = true;

        if (this._isInsideViewport(x)) {
            // Drag the viewport - calculate offset from viewport left edge
            const w = this.canvas.width / (window.devicePixelRatio || 1);
            const vpRect = this._getViewportRect(w, this.height);
            this._dragOffsetX = x - vpRect.x;
            this.canvas.style.cursor = 'grabbing';
        } else {
            // Click outside - jump to position, then allow drag
            this._navigateToX(x);
            // Set drag offset to center of viewport
            const w = this.canvas.width / (window.devicePixelRatio || 1);
            const vpRect = this._getViewportRect(w, this.height);
            this._dragOffsetX = vpRect.w / 2;
            this.canvas.style.cursor = 'grabbing';
        }
    }

    _handleMouseMove(e) {
        if (this._isDragging) {
            const x = this._getCanvasX(e);
            this._navigateDrag(x);
        } else {
            // Update cursor
            const x = this._getCanvasX(e);
            this.canvas.style.cursor = this._isInsideViewport(x) ? 'grab' : 'pointer';
        }
    }

    _handleMouseUp() {
        if (this._isDragging) {
            this._isDragging = false;
            this.canvas.style.cursor = 'default';
        }
    }

    _handleTouchStart(e) {
        e.preventDefault();
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        const fakeEvent = { clientX: touch.clientX, preventDefault: () => {} };
        this._handleMouseDown(fakeEvent);
    }

    _handleTouchMove(e) {
        e.preventDefault();
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        this._handleMouseMove({ clientX: touch.clientX });
    }

    _handleTouchEnd(e) {
        e.preventDefault();
        this._handleMouseUp();
    }
}
