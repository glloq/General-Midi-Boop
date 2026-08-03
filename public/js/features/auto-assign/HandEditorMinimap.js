/**
 * @file HandEditorMinimap.js
 * @description Compact horizontal overview of the whole file for the
 * full-length editor modal. Sits between the toolbar and the main
 * area. Shows:
 *   - the chord events as grey dots (red if any note is unplayable);
 *   - the fretting hand trajectory as a faint green ribbon
 *     (Y = anchor / numFrets);
 *   - the playhead as a thin red vertical line;
 *   - the timeline's current viewport as a translucent draggable
 *     rectangle.
 *
 * Click = jump to that time. Drag the viewport rectangle = scroll the
 * main timeline. Click the rectangle then drag = same.
 *
 * Public API:
 *   const m = new HandEditorMinimap(canvas, {
 *     totalSec, ticksPerSec, numFrets,
 *     onSeek: (sec) => …, onScrollViewport: (sec) => …
 *   });
 *   m.setTimeline(events);
 *   m.setTrajectory(points);
 *   m.setPlayhead(sec);
 *   m.setViewport(scrollSec, viewportSec);
 *   m.draw();
 *   m.destroy();
 */
(function () {
  'use strict';

  class HandEditorMinimap {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.totalSec = Number.isFinite(opts.totalSec) && opts.totalSec > 0 ? opts.totalSec : 0;
      this.ticksPerSec =
        Number.isFinite(opts.ticksPerSec) && opts.ticksPerSec > 0 ? opts.ticksPerSec : 480;
      this.numFrets = Number.isFinite(opts.numFrets) && opts.numFrets > 0 ? opts.numFrets : 24;
      this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : null;
      this.onScrollViewport =
        typeof opts.onScrollViewport === 'function' ? opts.onScrollViewport : null;

      this._chordHits = []; // [{sec, hasUnplayable}]
      this._infeasibleShifts = []; // [sec]
      this._trajectory = [];
      this.playheadSec = 0;
      this.viewport = { sec: 0, span: 0 };

      this._drag = null; // 'viewport' while dragging the box
      this._dirty = true;
      this._rafHandle = null;

      if (this.canvas?.addEventListener) {
        this._mouseDownHandler = (e) => this._handleMouseDown(e);
        this._mouseMoveHandler = (e) => this._handleMouseMove(e);
        this._mouseUpHandler = () => this._handleMouseUp();
        this.canvas.addEventListener('mousedown', this._mouseDownHandler);
        document.addEventListener('mousemove', this._mouseMoveHandler);
        document.addEventListener('mouseup', this._mouseUpHandler);
      }
    }

    // ----------------------------------------------------------------
    //  Public API
    // ----------------------------------------------------------------

    setTimeline(events) {
      const list = Array.isArray(events) ? events : [];
      this._chordHits = list
        .filter((e) => e && e.type === 'chord' && Number.isFinite(e.tick))
        .map((e) => ({
          sec: e.tick / this.ticksPerSec,
          hasUnplayable: Array.isArray(e.unplayable) && e.unplayable.length > 0
        }));
      this._infeasibleShifts = list
        .filter(
          (e) =>
            e &&
            e.type === 'shift' &&
            Number.isFinite(e.tick) &&
            e.motion &&
            e.motion.feasible === false
        )
        .map((e) => e.tick / this.ticksPerSec);
      this._scheduleDraw();
    }

    setTrajectory(points) {
      this._trajectory = Array.isArray(points)
        ? points
            .filter((p) => p && Number.isFinite(p.tick) && Number.isFinite(p.anchor))
            .slice()
            .sort((a, b) => a.tick - b.tick)
        : [];
      this._scheduleDraw();
    }

    setPlayhead(sec) {
      const next = Number.isFinite(sec) ? Math.max(0, sec) : 0;
      if (next === this.playheadSec) return;
      this.playheadSec = next;
      this._scheduleDraw();
    }

    setViewport(scrollSec, viewportSec) {
      const sec = Number.isFinite(scrollSec) ? Math.max(0, scrollSec) : 0;
      const span = Number.isFinite(viewportSec) ? Math.max(0, viewportSec) : 0;
      if (sec === this.viewport.sec && span === this.viewport.span) return;
      this.viewport = { sec, span };
      this._scheduleDraw();
    }

    setTotalSec(totalSec) {
      this.totalSec = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
      this._scheduleDraw();
    }

    // ----------------------------------------------------------------
    //  Geometry
    // ----------------------------------------------------------------

    _width() {
      return this.canvas?.clientWidth || this.canvas?.width || 0;
    }

    _height() {
      return this.canvas?.clientHeight || this.canvas?.height || 0;
    }

    _secToX(sec) {
      const w = this._width();
      if (this.totalSec <= 0) return 0;
      return (sec / this.totalSec) * w;
    }

    _xToSec(x) {
      const w = this._width();
      if (w <= 0) return 0;
      return Math.max(0, Math.min(this.totalSec, (x / w) * this.totalSec));
    }

    // ----------------------------------------------------------------
    //  Interaction
    // ----------------------------------------------------------------

    _pointerXY(e) {
      const rect = this.canvas?.getBoundingClientRect
        ? this.canvas.getBoundingClientRect()
        : { left: 0, top: 0 };
      return {
        x: (e.clientX || 0) - rect.left,
        y: (e.clientY || 0) - rect.top
      };
    }

    _viewportRect() {
      const x = this._secToX(this.viewport.sec);
      const w = Math.max(2, this._secToX(this.viewport.sec + this.viewport.span) - x);
      return { x, w };
    }

    _handleMouseDown(e) {
      const { x } = this._pointerXY(e);
      const rect = this._viewportRect();
      // Clicking inside the viewport rectangle starts a drag —
      // pointermove updates the scroll. Clicking outside seeks
      // immediately (no drag).
      if (x >= rect.x && x <= rect.x + rect.w) {
        this._drag = { offsetX: x - rect.x };
        if (e.preventDefault) e.preventDefault();
        return;
      }
      // Center the viewport on the click and emit both seek +
      // scroll so the timeline catches up.
      const centerSec = this._xToSec(x);
      const newScroll = Math.max(0, centerSec - this.viewport.span / 2);
      this.onScrollViewport?.(newScroll);
      this.onSeek?.(centerSec);
    }

    _handleMouseMove(e) {
      if (!this._drag) return;
      const { x } = this._pointerXY(e);
      const newRectX = x - this._drag.offsetX;
      const newScrollSec = Math.max(
        0,
        Math.min(this.totalSec - this.viewport.span, this._xToSec(newRectX))
      );
      this.onScrollViewport?.(newScrollSec);
    }

    _handleMouseUp() {
      this._drag = null;
    }

    // ----------------------------------------------------------------
    //  Render
    // ----------------------------------------------------------------

    _scheduleDraw() {
      this._dirty = true;
      if (this._rafHandle != null) return;
      this._rafHandle = window.requestAnimationFrame(() => {
        this._rafHandle = null;
        if (this._dirty) this.draw();
      });
    }

    draw() {
      this._dirty = false;
      if (!this.ctx || !this.canvas) return;
      const w = this._width();
      const h = this._height();
      if (w <= 0 || h <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const ctx = this.ctx;
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(0, 0, w, h);

      this._drawTrajectoryRibbon(w, h);
      this._drawChordDots(h);
      this._drawInfeasibleMarkers(h);
      this._drawViewportRect(h);
      this._drawPlayhead(h);
    }

    _drawTrajectoryRibbon(w, h) {
      if (!this._trajectory.length || this.numFrets <= 0) return;
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
      for (let i = 0; i < this._trajectory.length; i++) {
        const cur = this._trajectory[i];
        const next = this._trajectory[i + 1];
        const startSec = cur.tick / this.ticksPerSec;
        const endSec = next ? next.tick / this.ticksPerSec : this.totalSec;
        const x0 = this._secToX(startSec);
        const x1 = this._secToX(endSec);
        if (x1 <= x0) continue;
        const yCenter = h * (cur.anchor / this.numFrets);
        const yH = Math.max(2, h * 0.18);
        ctx.fillRect(x0, yCenter - yH / 2, x1 - x0, yH);
      }
    }

    _drawChordDots(h) {
      const ctx = this.ctx;
      for (const ch of this._chordHits) {
        const x = this._secToX(ch.sec);
        ctx.fillStyle = ch.hasUnplayable ? 'rgba(239, 68, 68, 0.85)' : 'rgba(75, 85, 99, 0.55)';
        ctx.fillRect(x - 1, h * 0.4, 2, h * 0.2);
      }
    }

    _drawInfeasibleMarkers(h) {
      if (!this._infeasibleShifts.length) return;
      const ctx = this.ctx;
      ctx.fillStyle = '#f5c518';
      for (const sec of this._infeasibleShifts) {
        const x = this._secToX(sec);
        ctx.fillRect(x - 1, 1, 2, h - 2);
      }
    }

    _drawViewportRect(h) {
      const { x, w } = this._viewportRect();
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(37, 99, 235, 0.18)';
      ctx.fillRect(x, 0, w, h);
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.65)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, 0.5, Math.max(1, w - 1), h - 1);
    }

    _drawPlayhead(h) {
      if (!Number.isFinite(this.playheadSec)) return;
      const x = this._secToX(this.playheadSec);
      const ctx = this.ctx;
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // ----------------------------------------------------------------
    //  Lifecycle
    // ----------------------------------------------------------------

    destroy() {
      this._chordHits = [];
      this._infeasibleShifts = [];
      this._trajectory = [];
      if (this.canvas?.removeEventListener && this._mouseDownHandler) {
        this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
      }
      if (this._mouseMoveHandler) document.removeEventListener('mousemove', this._mouseMoveHandler);
      if (this._mouseUpHandler) document.removeEventListener('mouseup', this._mouseUpHandler);
      this._mouseDownHandler = null;
      this._mouseMoveHandler = null;
      this._mouseUpHandler = null;
    }
  }

  if (typeof window !== 'undefined') {
    window.HandEditorMinimap = HandEditorMinimap;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HandEditorMinimap;
  }
})();
