/**
 * @file public/js/features/piano-roll/CanvasPianoRollRenderer.js
 *
 * Audit §1.1 Phase B — Canvas 2D implementation of `PianoRollRenderer`.
 * Replaces the third-party `<webaudio-pianoroll>` element with a custom
 * renderer that supports viewport culling (§3.1), grid-bucket spatial
 * index for hit-detection (§3.2), and partial repaint via dirty
 * rectangles.
 *
 * Architecture — 3 logical layers composed onto a single `<canvas>` per
 * frame to keep DOM minimal:
 *
 *   1. **Background buffer** (offscreen): keyboard column + time/pitch
 *      grid + ruler. Repainted only when viewport / theme / size change
 *      (cached via `_bgDirty`).
 *   2. **Notes layer**: rectangles representing notes, drawn directly
 *      onto the main canvas after compositing the background. Limited
 *      to the visible viewport via the spatial index.
 *   3. **Overlay** (inline): cursor, selection rectangle, drag preview.
 *      Painted every frame in display mode (cheap).
 *
 * The renderer extends `PianoRollRenderer` and is the sole concrete
 * implementation of that contract (the legacy WebaudioPianorollAdapter
 * and the `<webaudio-pianoroll>` element were removed).
 *
 * Current scope (commit B1): skeleton, mount, layout, background grid,
 * keyboard labels, ruler. Notes rendering, spatial index, selection
 * and interaction land in subsequent B-commits.
 */
(function () {
  'use strict';

  /** Pitch range we render — covers full MIDI plus some headroom. */
  const NOTE_MIN = 0;
  const NOTE_MAX = 127;

  /** Default pixel sizes. */
  const SB_W = 24; // vertical scrollbar column on the left edge
  const KB_W = 40; // keyboard column (without scrollbar)
  const KB_WIDTH = SB_W + KB_W; // total left chrome — notes start at x >= KB_WIDTH
  // Internal top ruler removed — the modal's Playback Timeline bar above
  // the canvas already shows measures/time, so an in-canvas ruler just
  // duplicated it and ate vertical space. Kept as a 0 constant so every
  // `RULER_H`-relative coordinate collapses to "no top offset".
  const RULER_H = 0;
  const NOTE_H_MIN = 4; // min note row height (pitch)
  const NOTE_H_MAX = 24; // max note row height (pitch)

  /** Black key indices in an octave (0=C, 1=C#, 2=D, ...). */
  const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

  /** Width of the right-edge resize handle on a note (CSS px). */
  const RESIZE_HANDLE_PX = 6;

  /** Default gate (in ticks) when creating a note via double-click. */
  const DEFAULT_NEW_NOTE_GATE_RATIO = 0.5; // 1/2 of `_snap`

  /** Smallest gate (in ticks) when resizing a note. */
  const MIN_NOTE_GATE = 1;

  class CanvasPianoRollRenderer extends PianoRollRenderer {
    constructor(opts = {}) {
      super(opts);
      /** Main `<canvas>` element appended to the host container. */
      this._el = null;
      /** 2D context of the main canvas. */
      this._ctx = null;
      /** Offscreen background buffer (keyboard + grid + ruler). */
      this._bgCanvas = null;
      this._bgCtx = null;
      /** Marks the bg buffer dirty so the next render() repaints it. */
      this._bgDirty = true;

      // ---- internal state mirrored from the abstract interface ----
      this._sequence = [];
      this._channelColors = [];
      this._defaultChannel = 0;
      this._channelPlayableHighlights = null;
      this._cursor = 0;
      this._markstart = 0;
      this._markend = 0;
      this._xoffset = 0;
      this._xrange = 1920;
      this._yoffset = 36; // pitch
      this._yrange = 36; // pitches visible
      this._tempo = opts.tempo ?? 120;
      this._timebase = opts.ppq ?? 480;
      this._grid = 120;
      this._snap = 120;
      this._editMode = opts.mode ?? 'dragpoly';
      this._uiMode = 'drag-view';

      // Hover crosshair — last known mouse position inside the notes
      // area (null when the cursor is over chrome or outside the
      // canvas). Cleared on mouseleave + during drag.
      this._hoverX = null;
      this._hoverY = null;

      // ---- theme ----
      // Defaults match a light theme. MidiEditorViewport._applyPianoRollTheme
      // overrides these via setThemeColors() based on the user's current
      // (light/dark) preference. White keys should *look white* — using
      // a dark grey as default made the keyboard look entirely grey.
      this._theme = {
        collt: '#ddd6f3',
        coldk: '#d2cae8',
        colgrid: '#c8c0de',
        colrulerbg: '#d5cdef',
        colrulerfg: '#4a3f6b',
        colrulerborder: '#c0b8d8',
        colnote: '#5e8eff',
        colnotesel: '#ffd866',
        colnoteborder: 'rgba(102,126,234,0.25)',
        colkbwhite: '#f8f8f8',
        colkbblack: '#222222',
        colcursor: '#e74c3c',
        colmark: '#ff9f1c'
      };

      // ---- event bus ----
      this._handlers = new Map(); // event -> Set<handler>

      // ---- RAF coalescing ----
      this._rafId = 0;
      this._renderPending = false;

      // ---- batch update gate ----
      this._batchDepth = 0;

      // ---- Spatial index (grid-bucket §3.2) ----
      // Keys: `${Math.floor(tickStart / BUCKET_TICKS)}` → Set<noteIndex>.
      // Cheaper than R-tree; supports O(visible) range queries for
      // viewport culling §3.1.
      this._bucketTicks = 480 * 4; // 1 measure per bucket by default
      this._buckets = new Map();
      this._bucketsDirty = true;
      // Reused across frames to avoid a per-frame Set allocation in
      // the paint hot path (a note can sit in several buckets).
      this._seen = new Set();

      // ---- Interaction (B4) ----
      this._selectionRect = null; // {x0, y0, x, y} in CSS px while drawing
      this._dragging = null; // {mode: 'rect'|'pan'|'note'|'pianokey'}
      this._pointerDownHandler = null;
      this._pointerMoveHandler = null;
      this._pointerUpHandler = null;
      this._wheelHandler = null;
      this._lastPointerType = 'mouse';
      // Self-contained clipboard for the right-click menu + Ctrl+C/V
      // (independent of the modal-level clipboard so it works even
      // when the renderer is used standalone).
      this._clipboard = [];
      this._ctxMenuEl = null;
      this._ctxMenuDismiss = null;
    }

    // ----------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------

    mount() {
      if (this._mounted) return this;
      if (!this._container) throw new Error('CanvasPianoRollRenderer: container is required');
      const canvas = document.createElement('canvas');
      canvas.className = 'piano-roll-canvas';
      canvas.style.cssText = 'display:block;width:100%;height:100%;background:#181a20;';
      canvas.tabIndex = 0; // focusable for keyboard input
      this._el = canvas;
      this._ctx = canvas.getContext('2d');

      this._bgCanvas = document.createElement('canvas');
      this._bgCtx = this._bgCanvas.getContext('2d');

      this._applySize(this._opts.width || 800, this._opts.height || 400);

      // ---- B4: wire mouse + wheel interaction ----
      this._wireInputHandlers();

      this._mounted = true;
      return this;
    }

    _wireInputHandlers() {
      this._pointerDownHandler = (e) => this._onPointerDown(e);
      this._pointerMoveHandler = (e) => this._onPointerMove(e);
      this._pointerUpHandler = (e) => this._onPointerUp(e);
      this._wheelHandler = (e) => this._onWheel(e);
      this._dblClickHandler = (e) => this._onDblClick(e);
      this._keyDownHandler = (e) => this._onKeyDown(e);
      this._contextMenuHandler = (e) => this._onContextMenu(e);
      this._hoverLeaveHandler = () => this._onHoverLeave();
      // Pointer events unify mouse + pen + touch so the editor works
      // on iPad / touchscreens. `touch-action:none` stops the browser
      // from hijacking drags as native scroll / pinch gestures, and
      // pointer capture (set on pointerdown) keeps a drag alive even
      // when the pointer leaves the canvas — replacing the old
      // window-bound mousemove/mouseup pair.
      this._el.style.touchAction = 'none';
      this._el.addEventListener('pointerdown', this._pointerDownHandler);
      this._el.addEventListener('pointermove', this._pointerMoveHandler);
      this._el.addEventListener('pointerup', this._pointerUpHandler);
      this._el.addEventListener('pointercancel', this._pointerUpHandler);
      this._el.addEventListener('pointerleave', this._hoverLeaveHandler);
      this._el.addEventListener('dblclick', this._dblClickHandler);
      this._el.addEventListener('keydown', this._keyDownHandler);
      this._el.addEventListener('contextmenu', this._contextMenuHandler);
      this._el.addEventListener('wheel', this._wheelHandler, { passive: false });
    }

    _onPointerDown(e) {
      this._lastPointerType = e.pointerType;
      // Right button is reserved for the context menu — don't start a
      // drag or grab pointer capture for it.
      if (e.button === 2) return;
      try {
        this._el.setPointerCapture(e.pointerId);
      } catch (_) {
        /* detached */
      }
      this._onMouseDown(e);
    }
    _onPointerMove(e) {
      this._lastPointerType = e.pointerType;
      this._onMouseMove(e); // no-op unless a drag is active
      this._onHover(e); // crosshair (skips touch + during drag)
    }
    _onPointerUp(e) {
      try {
        this._el.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* already released */
      }
      this._onMouseUp(e);
      if (e.pointerType === 'touch') this._onHoverLeave();
    }

    attachToContainer() {
      if (!this._el || !this._container) return this;
      this._container.appendChild(this._el);
      this._scheduleRender();
      return this;
    }

    destroy() {
      if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = 0;
      }
      this._handlers.clear();
      if (this._el) {
        this._el.removeEventListener('pointerdown', this._pointerDownHandler);
        this._el.removeEventListener('pointermove', this._pointerMoveHandler);
        this._el.removeEventListener('pointerup', this._pointerUpHandler);
        this._el.removeEventListener('pointercancel', this._pointerUpHandler);
        this._el.removeEventListener('pointerleave', this._hoverLeaveHandler);
        this._el.removeEventListener('dblclick', this._dblClickHandler);
        this._el.removeEventListener('keydown', this._keyDownHandler);
        this._el.removeEventListener('contextmenu', this._contextMenuHandler);
        this._el.removeEventListener('wheel', this._wheelHandler);
      }
      this._closeContextMenu();
      if (this._el?.parentNode) this._el.parentNode.removeChild(this._el);
      this._el = null;
      this._ctx = null;
      this._bgCanvas = null;
      this._bgCtx = null;
      super.destroy();
      return this;
    }

    getElement() {
      return this._el;
    }

    // ----------------------------------------------------------------
    // Size handling (devicePixelRatio aware)
    // ----------------------------------------------------------------

    _applySize(w, h) {
      if (!this._el) return;
      const dpr = window.devicePixelRatio || 1;
      this._cssWidth = w;
      this._cssHeight = h;
      this._el.width = Math.round(w * dpr);
      this._el.height = Math.round(h * dpr);
      this._el.style.width = w + 'px';
      this._el.style.height = h + 'px';
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this._bgCanvas.width = this._el.width;
      this._bgCanvas.height = this._el.height;
      this._bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this._bgDirty = true;
    }

    setSize(w, h) {
      if (w === this._cssWidth && h === this._cssHeight) return this;
      this._applySize(w, h);
      this._scheduleRender();
      return this;
    }

    // ----------------------------------------------------------------
    // Viewport setters / getters
    // ----------------------------------------------------------------

    // Setters emit `viewportchange` whenever state actually changes so
    // every listener (NavigationOverviewBar, PlaybackTimelineBar,
    // ccPicker.syncAllEditors) sees programmatic scrolls/zooms — not
    // just the wheel-driven path that historically did the emit inline.
    setXRange(ticks) {
      if (this._xrange === ticks) return this;
      // X zoom only shifts the time axis: the cached bg layer
      // (keyboard + octave row bands) is horizontally invariant, so
      // it is NOT invalidated — the time grid is repainted per frame.
      this._xrange = ticks;
      this._emit('viewportchange', {
        xoffset: this._xoffset,
        yoffset: this._yoffset,
        xrange: this._xrange,
        yrange: this._yrange
      });
      this._scheduleRender();
      return this;
    }
    getXRange() {
      return this._xrange;
    }
    setYRange(notes) {
      if (this._yrange === notes) return this;
      this._yrange = notes;
      this._bgDirty = true;
      this._emit('viewportchange', {
        xoffset: this._xoffset,
        yoffset: this._yoffset,
        xrange: this._xrange,
        yrange: this._yrange
      });
      this._scheduleRender();
      return this;
    }
    getYRange() {
      return this._yrange;
    }
    setXOffset(t) {
      if (this._xoffset === t) return this;
      // Horizontal pan: cached bg layer is horizontally invariant
      // (see setXRange) — not invalidated; time grid repaints per frame.
      this._xoffset = t;
      this._emit('viewportchange', {
        xoffset: this._xoffset,
        yoffset: this._yoffset,
        xrange: this._xrange,
        yrange: this._yrange
      });
      this._scheduleRender();
      return this;
    }
    getXOffset() {
      return this._xoffset;
    }
    setYOffset(n) {
      if (this._yoffset === n) return this;
      this._yoffset = n;
      this._bgDirty = true;
      this._emit('viewportchange', {
        xoffset: this._xoffset,
        yoffset: this._yoffset,
        xrange: this._xrange,
        yrange: this._yrange
      });
      this._scheduleRender();
      return this;
    }
    getYOffset() {
      return this._yoffset;
    }
    setCursor(t) {
      if (this._cursor !== t) {
        this._cursor = t;
        this._scheduleRender();
      }
      return this;
    }
    getCursor() {
      return this._cursor;
    }
    setMarkers(a, b) {
      this._markstart = a;
      this._markend = b;
      this._scheduleRender();
      return this;
    }
    getMarkers() {
      return { start: this._markstart, end: this._markend };
    }

    // ----------------------------------------------------------------
    // Musical config
    // ----------------------------------------------------------------

    setTempo(bpm) {
      this._tempo = bpm;
      return this;
    }
    getTempo() {
      return this._tempo;
    }
    setTimebase(ppq) {
      this._timebase = ppq;
      this._bgDirty = true;
      this._scheduleRender();
      return this;
    }
    getTimebase() {
      return this._timebase;
    }
    setGrid(ticks) {
      this._grid = ticks;
      this._bgDirty = true;
      this._scheduleRender();
      return this;
    }
    setSnap(ticks) {
      this._snap = ticks;
      return this;
    }
    setEditMode(mode) {
      this._editMode = mode;
      return this;
    }
    setUIMode(mode) {
      this._uiMode = mode;
      return this;
    }
    getUIMode() {
      return this._uiMode;
    }

    // ----------------------------------------------------------------
    // Data
    // ----------------------------------------------------------------

    // CONTRACT: takes ownership of `notes` by reference (no clone — this
    // is a playback/edit hot path). The caller MUST NOT mutate the array
    // or its note objects afterwards; doing so leaves the spatial bucket
    // index incoherent with the data. Pass a copy if you need to keep one.
    setSequence(notes) {
      this._sequence = Array.isArray(notes) ? notes : [];
      this._bucketsDirty = true;
      this._scheduleRender();
      return this;
    }
    getSequence() {
      return this._sequence;
    }
    pushNote(note) {
      this._sequence.push(note);
      this._bucketsDirty = true;
      this._scheduleRender();
      return this;
    }
    clearSequence() {
      this._sequence.length = 0;
      this._bucketsDirty = true;
      this._scheduleRender();
      return this;
    }
    setChannelColors(map) {
      this._channelColors = map || [];
      this._scheduleRender();
      return this;
    }
    setDefaultChannel(ch) {
      if (ch === this._defaultChannel) return this;
      this._defaultChannel = ch;
      // Keyboard greying depends on the default channel — flag the
      // background so the next paint regenerates the key tints.
      this._bgDirty = true;
      this._scheduleRender();
      return this;
    }
    getDefaultChannel() {
      return this._defaultChannel;
    }
    setChannelPlayableHighlights(map) {
      this._channelPlayableHighlights = map;
      this._bgDirty = true;
      this._scheduleRender();
      return this;
    }

    // ----------------------------------------------------------------
    // Selection (B4)
    // ----------------------------------------------------------------

    getSelectedNotes() {
      return this._sequence.filter((n) => n.f === 1);
    }
    getSelectionCount() {
      return this.getSelectedNotes().length;
    }
    selectAll() {
      this._sequence.forEach((n) => (n.f = 1));
      this._scheduleRender();
      return this;
    }
    deselectAll() {
      this._sequence.forEach((n) => (n.f = 0));
      this._scheduleRender();
      return this;
    }
    copySelection() {
      return this.getSelectedNotes().map((n) => ({ ...n, f: 0 }));
    }
    pasteNotes(notes, offsetTick) {
      if (!Array.isArray(notes)) return this;
      const off = offsetTick ?? this._cursor ?? 0;
      this.deselectAll();
      notes.forEach((n) => this._sequence.push({ ...n, t: (n.t ?? 0) + off, f: 1 }));
      this._bucketsDirty = true;
      this._scheduleRender();
      this._emit('change');
      return this;
    }
    deleteSelection() {
      const before = this._sequence.length;
      this._sequence = this._sequence.filter((n) => n.f !== 1);
      if (this._sequence.length !== before) {
        this._bucketsDirty = true;
        this._scheduleRender();
        this._emit('change');
      }
      return this;
    }
    changeChannelSelection(ch) {
      this._sequence.forEach((n) => {
        if (n.f === 1) n.c = ch;
      });
      this._scheduleRender();
      this._emit('change');
      return this;
    }

    // ----------------------------------------------------------------
    // History (snapshot-based undo stack). Notes are flat objects, so a
    // per-note shallow clone is a full snapshot — and ~10-50x cheaper
    // than JSON.stringify/parse, which on large sequences allocated
    // hundreds of KB per action and caused GC pauses on rapid undo.
    // ----------------------------------------------------------------

    _undoStack = [];
    _redoStack = [];
    _maxHistory = 20;

    _cloneSequence(seq) {
      const out = new Array(seq.length);
      for (let i = 0; i < seq.length; i++) out[i] = { ...seq[i] };
      return out;
    }

    saveSnapshot() {
      this._undoStack.push(this._cloneSequence(this._sequence));
      if (this._undoStack.length > this._maxHistory) this._undoStack.shift();
      this._redoStack.length = 0;
      return this;
    }
    clearHistory() {
      this._undoStack.length = 0;
      this._redoStack.length = 0;
      return this;
    }
    canUndo() {
      return this._undoStack.length > 0;
    }
    canRedo() {
      return this._redoStack.length > 0;
    }
    undo() {
      if (!this.canUndo()) return false;
      this._redoStack.push(this._cloneSequence(this._sequence));
      this._sequence = this._cloneSequence(this._undoStack.pop());
      this._bucketsDirty = true;
      this._scheduleRender();
      this._emit('change');
      return true;
    }
    redo() {
      if (!this.canRedo()) return false;
      this._undoStack.push(this._cloneSequence(this._sequence));
      this._sequence = this._cloneSequence(this._redoStack.pop());
      this._bucketsDirty = true;
      this._scheduleRender();
      this._emit('change');
      return true;
    }

    // ----------------------------------------------------------------
    // Render scheduling (RAF coalescing)
    // ----------------------------------------------------------------

    _scheduleRender() {
      if (this._batchDepth > 0) return;
      if (this._renderPending) return;
      this._renderPending = true;
      this._rafId = requestAnimationFrame(() => {
        this._renderPending = false;
        this._rafId = 0;
        this._paint();
      });
    }

    redraw() {
      this._scheduleRender();
      return this;
    }
    redrawMarker() {
      this._scheduleRender();
      return this;
    }
    invalidateGridBuffer() {
      this._bgDirty = true;
      this._scheduleRender();
      return this;
    }

    beginBatchUpdate() {
      this._batchDepth++;
      return this;
    }
    endBatchUpdate() {
      this._batchDepth = Math.max(0, this._batchDepth - 1);
      if (this._batchDepth === 0) this._scheduleRender();
      return this;
    }

    // ----------------------------------------------------------------
    // Theme
    // ----------------------------------------------------------------

    setThemeColors(map) {
      if (!map) return this;
      Object.assign(this._theme, map);
      this._bgDirty = true;
      this._scheduleRender();
      return this;
    }

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------

    on(event, handler) {
      if (typeof handler !== 'function') return this;
      let set = this._handlers.get(event);
      if (!set) {
        set = new Set();
        this._handlers.set(event, set);
      }
      set.add(handler);
      return this;
    }
    off(event, handler) {
      this._handlers.get(event)?.delete(handler);
      return this;
    }
    _emit(event, detail) {
      const set = this._handlers.get(event);
      if (!set) return;
      const ev = { type: event, detail: detail || {} };
      for (const handler of set) {
        try {
          handler(ev);
        } catch (e) {
          console.error(`CanvasPianoRollRenderer ${event}:`, e);
        }
      }
    }

    // ----------------------------------------------------------------
    // Paint pipeline
    // ----------------------------------------------------------------

    _paint() {
      if (!this._ctx || !this._cssWidth || !this._cssHeight) return;

      if (this._bgDirty) {
        this._paintBackground();
        this._bgDirty = false;
      }

      // Composite background onto main canvas
      this._ctx.drawImage(this._bgCanvas, 0, 0, this._cssWidth, this._cssHeight);

      // Time grid depends on xoffset/xrange/timebase, so it is painted
      // per frame straight onto the main canvas instead of being baked
      // into the cached bg buffer (which would force a full bg repaint
      // on every horizontal pan — the H3 hot path).
      this._paintTimeGrid();

      // B2: notes layer (placeholder for now — overrides land in B2)
      this._paintNotes();

      // Overlay (cursor + markers + selection rect)
      this._paintOverlay();
    }

    // Per-frame time grid (depends on xoffset/xrange/timebase). Drawn
    // straight onto the main canvas after the cached bg buffer. The
    // loop is culled to the visible columns so this is far cheaper than
    // repainting the whole bg buffer on every horizontal pan.
    _paintTimeGrid() {
      const ctx = this._ctx;
      const W = this._cssWidth;
      const H = this._cssHeight;
      const beat = this._timebase || 480;
      const startTick = Math.floor(this._xoffset / beat) * beat;
      const endTick = this._xoffset + this._xrange;
      ctx.save();
      ctx.strokeStyle = this._theme.colgrid;
      ctx.lineWidth = 1;
      for (let t = startTick; t <= endTick; t += beat) {
        const x = this._tickToX(t);
        if (x < KB_WIDTH || x > W) continue;
        const isMeasure = t % (beat * 4) === 0;
        ctx.globalAlpha = isMeasure ? 0.7 : 0.35;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_H);
        ctx.lineTo(x + 0.5, H);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Background (cached) = keyboard column + octave row bands.
    // Horizontally invariant: only Y / size / theme invalidate it.
    _paintBackground() {
      const ctx = this._bgCtx;
      const W = this._cssWidth;
      const H = this._cssHeight;
      ctx.clearRect(0, 0, W, H);

      // Notes-area background (alternating light/dark rows by octave)
      ctx.fillStyle = this._theme.coldk;
      ctx.fillRect(KB_WIDTH, RULER_H, W - KB_WIDTH, H - RULER_H);

      // Pitch row bands — every octave gets a slightly different shade
      const noteH = this._noteHeight();
      for (let n = this._yoffset; n < this._yoffset + this._yrange; n++) {
        if (n < NOTE_MIN || n > NOTE_MAX) continue;
        const y = this._noteToY(n);
        if (BLACK_KEYS.has(n % 12)) {
          ctx.fillStyle = this._theme.collt;
          ctx.fillRect(KB_WIDTH, y, W - KB_WIDTH, noteH);
        }
      }

      // Keyboard column. (The in-canvas time ruler was removed —
      // the modal's Playback Timeline bar above the canvas owns
      // measures/scrub now.)
      this._paintKeyboard(ctx);
    }

    _paintKeyboard(ctx) {
      const noteH = this._noteHeight();
      const H = this._cssHeight;
      // Keyboard background — fills from y=0 (above the ruler) down to
      // the bottom, so the top-left corner above the keys looks like a
      // continuation of the keyboard instead of a stray ruler patch.
      // Offset by SB_W to leave a scrollbar column on the left.
      ctx.fillStyle = this._theme.colkbwhite;
      ctx.fillRect(SB_W, 0, KB_W, H);

      for (let n = this._yoffset; n < this._yoffset + this._yrange; n++) {
        if (n < NOTE_MIN || n > NOTE_MAX) continue;
        const y = this._noteToY(n);
        if (BLACK_KEYS.has(n % 12)) {
          ctx.fillStyle = this._theme.colkbblack;
          ctx.fillRect(SB_W, y, KB_W * 0.62, noteH);
        }
        // C label at each octave boundary
        if (n % 12 === 0 && noteH >= 8) {
          ctx.fillStyle = this._theme.colrulerfg;
          ctx.font = '10px monospace';
          ctx.textBaseline = 'middle';
          ctx.fillText(`C${Math.floor(n / 12) - 1}`, SB_W + KB_W * 0.65, y + noteH / 2);
        }
      }

      // Gray-out the keys the routed instrument on the default
      // channel cannot reach. `setChannelPlayableHighlights` stores
      // a Map<channel, {notes: Set|null, color}>; a null `notes`
      // means "no constraint" so we skip the overlay entirely.
      const hl = this._channelPlayableHighlights;
      const entry = hl && typeof hl.get === 'function' ? hl.get(this._defaultChannel) : null;
      const playable = entry && entry.notes instanceof Set ? entry.notes : null;
      if (playable) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
        for (let n = this._yoffset; n < this._yoffset + this._yrange; n++) {
          if (n < NOTE_MIN || n > NOTE_MAX) continue;
          if (playable.has(n)) continue;
          const y = this._noteToY(n);
          ctx.fillRect(SB_W, y, KB_W, noteH);
        }
      }

      // Right border — separates the keyboard column from the notes
      // area. Drawn full-height so it visually frames the timeline
      // start (audit follow-up: timeline left edge = piano right edge).
      ctx.strokeStyle = this._theme.colrulerborder;
      ctx.beginPath();
      ctx.moveTo(KB_WIDTH + 0.5, 0);
      ctx.lineTo(KB_WIDTH + 0.5, H);
      ctx.stroke();
    }

    _paintNotes() {
      if (!this._sequence.length) return;

      const ctx = this._ctx;
      const W = this._cssWidth;
      const noteH = this._noteHeight();
      const visStartTick = this._xoffset;
      const visEndTick = this._xoffset + this._xrange;
      const minNote = this._yoffset;
      const maxNote = this._yoffset + this._yrange - 1;

      // During an active move/resize drag the note objects mutate
      // every frame. Rebuilding the O(n) bucket index per frame is
      // the main 10k-note/60fps blocker, so skip it: do a flat
      // viewport-culled scan instead (a tight numeric loop, no Map/
      // Set churn). The index is rebuilt once on drag end.
      const dragMut =
        this._dragging && (this._dragging.mode === 'move' || this._dragging.mode === 'resize');
      if (!dragMut && this._bucketsDirty) this._rebuildBuckets();

      // Clip to the note area so notes scrolling left slide *behind*
      // the keyboard column + vertical scrollbar (painted in the bg
      // buffer / overlay) instead of over them.
      ctx.save();
      ctx.beginPath();
      ctx.rect(KB_WIDTH, RULER_H, W - KB_WIDTH, this._cssHeight - RULER_H);
      ctx.clip();

      const drawOne = (n) => {
        if (!n) return;
        if (n.n < minNote || n.n > maxNote) return;
        const t0 = n.t;
        const t1 = n.t + (n.g || 0);
        if (t1 < visStartTick || t0 > visEndTick) return;

        const x = this._tickToX(t0);
        const x2 = this._tickToX(t1);
        const y = this._noteToY(n.n);
        const w = Math.max(2, x2 - x);
        const h = Math.max(2, noteH - 1);

        const selected = n.f === 1;
        const ch = n.c ?? 0;
        const color = selected
          ? this._theme.colnotesel
          : this._channelColors[ch % 16] || this._theme.colnote;

        const vel = n.v ?? 100;
        ctx.globalAlpha = 0.45 + (Math.min(127, Math.max(0, vel)) / 127) * 0.55;

        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = this._theme.colnoteborder;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        // Visual hint for the resize hot-zone — only when the note
        // is wide enough to host the handle. Full alpha so the cue
        // stays legible regardless of velocity.
        if (w > RESIZE_HANDLE_PX * 2 + 2) {
          const prevAlpha = ctx.globalAlpha;
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
          ctx.fillRect(x + w - RESIZE_HANDLE_PX, y + 1, 2, h - 2);
          ctx.globalAlpha = prevAlpha;
        }
      };

      const seq = this._sequence;
      if (dragMut) {
        // Flat culled scan — correct at current positions, no index.
        for (let i = 0; i < seq.length; i++) drawOne(seq[i]);
      } else {
        // Iterate only the buckets that intersect the visible
        // viewport (§3.1 culling) — typically <10 buckets vs O(n).
        const seen = this._seen;
        seen.clear();
        const startBucket = Math.floor(visStartTick / this._bucketTicks);
        const endBucket = Math.floor(visEndTick / this._bucketTicks);
        for (let b = startBucket; b <= endBucket; b++) {
          const bucket = this._buckets.get(b);
          if (!bucket) continue;
          for (const idx of bucket) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            drawOne(seq[idx]);
          }
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    /**
     * Rebuild the grid-bucket spatial index over `_sequence`. Each
     * note is registered into every bucket its `[t, t+g]` interval
     * crosses, so range queries don't miss long-held notes whose
     * `t` is far before the visible window.
     *
     * Cost : O(n × buckets-per-note). Typical = 1-2 buckets per
     * note (1 measure). Rebuilds on `setSequence` / `pushNote` /
     * `clearSequence` / paste / delete / undo.
     */
    _rebuildBuckets() {
      this._buckets.clear();
      const B = this._bucketTicks;
      // Bound how many buckets a single note may span. A corrupt/malicious file
      // can encode a note with a multi-million-tick gate (28-bit VLQ), which
      // would register it into ~140k buckets and freeze the main thread when the
      // editor opens (setSequence → _rebuildBuckets) — a DoS (audit D M2). No
      // real note spans thousands of measures, so capping the index span is
      // safe; only pathological gates lose far-end bucket coverage.
      const MAX_BUCKETS_PER_NOTE = 4096;
      let capped = 0;
      for (let i = 0; i < this._sequence.length; i++) {
        const n = this._sequence[i];
        if (!n) continue;
        const b0 = Math.floor(n.t / B);
        if (!Number.isFinite(b0)) continue;
        let b1 = Math.floor((n.t + (n.g || 0)) / B);
        if (!Number.isFinite(b1) || b1 < b0) b1 = b0;
        if (b1 - b0 > MAX_BUCKETS_PER_NOTE) {
          b1 = b0 + MAX_BUCKETS_PER_NOTE;
          capped++;
        }
        for (let b = b0; b <= b1; b++) {
          let set = this._buckets.get(b);
          if (!set) {
            set = new Set();
            this._buckets.set(b, set);
          }
          set.add(i);
        }
      }
      if (capped > 0) {
        console.warn(
          `PianoRoll: clamped bucket span for ${capped} note(s) with an implausibly long gate`
        );
      }
      this._bucketsDirty = false;
    }

    // ----------------------------------------------------------------
    // B4 — Mouse + wheel interaction
    // ----------------------------------------------------------------

    _localCoords(e) {
      const rect = this._el.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    }

    _onMouseDown(e) {
      if (!this._el) return;
      this._el.focus(); // capture keyboard for shortcuts
      const { x, y } = this._localCoords(e);

      // Clicked on the vertical scrollbar (left edge, full height) →
      // jump scroll. Compute the proportional y position inside the
      // SB rect and recentre `_yoffset` so the thumb tracks the click.
      if (x < SB_W) {
        const sbH = this._cssHeight;
        const ratio = Math.max(0, Math.min(1, y / sbH));
        const newY = Math.max(
          0,
          Math.min(128 - this._yrange, Math.round(ratio * 128 - this._yrange / 2))
        );
        if (newY !== this._yoffset) {
          this._yoffset = newY;
          this._bgDirty = true;
          this._emit('viewportchange', {
            xoffset: this._xoffset,
            yoffset: this._yoffset,
            xrange: this._xrange,
            yrange: this._yrange
          });
          this._scheduleRender();
        }
        this._dragging = { mode: 'scrollbar' };
        return;
      }

      // Clicked on the keyboard column → emit pianokey
      if (x < KB_WIDTH) {
        const note = this._yToNote(y);
        if (note >= NOTE_MIN && note <= NOTE_MAX) {
          this._emit('pianokey', { note });
          this._dragging = { mode: 'pianokey', note };
        }
        return;
      }

      // Inside notes area : hit-test or start selection / pan
      const tick = this._xToTick(x);
      const note = this._yToNote(y);
      const hit = this._hitTestNote(x, y);

      if (this._uiMode === 'drag-view' || e.button === 1 || e.shiftKey) {
        // Pan mode — middle button, shift+drag, or explicit drag-view
        this._dragging = {
          mode: 'pan',
          startX: x,
          startY: y,
          startXOffset: this._xoffset,
          startYOffset: this._yoffset
        };
        this._el.style.cursor = 'grabbing';
        return;
      }

      const m = this._uiMode;

      // add-note / edit : an empty click creates a note; holding and
      // dragging right then sets its duration (reusing the `resize`
      // drag). On an existing note, `edit` falls through to the
      // shared move/resize handler while `add-note` stays inert
      // (parity with double-click — never deletes on tap).
      if (m === 'add-note' || m === 'edit') {
        if (hit) {
          if (m === 'add-note') return;
          // edit → shared move/resize hit block below
        } else {
          const idx = this._createNoteAt(x, y);
          if (idx < 0) return;
          this._dragging = {
            mode: 'resize',
            idx,
            startTick: tick,
            startGate: this._sequence[idx].g || 0
          };
          this._el.style.cursor = 'ew-resize';
          this._scheduleRender();
          return;
        }
      }

      // resize-note (touch) : a press anywhere on a note resizes it;
      // empty space does nothing.
      if (m === 'resize-note') {
        if (!hit) return;
        if (!hit.note.f && !(e.ctrlKey || e.metaKey)) this.deselectAll();
        hit.note.f = 1;
        this._emit('selectionchange');
        this.saveSnapshot();
        this._dragging = {
          mode: 'resize',
          idx: hit.idx,
          startTick: tick,
          startGate: hit.note.g || 0
        };
        this._el.style.cursor = 'ew-resize';
        this._scheduleRender();
        return;
      }

      // drag-notes (touch) : only moves notes — an empty press just
      // clears the selection, never opens a selection rectangle.
      if (m === 'drag-notes' && !hit) {
        if (!(e.ctrlKey || e.metaKey)) this.deselectAll();
        this._scheduleRender();
        return;
      }

      if (hit) {
        // Clicked on a note. Three sub-modes:
        //  - resize : right-edge handle (changes gate of the hit note only)
        //  - move   : body click (moves all selected notes by Δtick/Δnote)
        //  - select : same as move with snapshot for click-without-drag UX
        if (!hit.note.f && !(e.ctrlKey || e.metaKey)) this.deselectAll();
        hit.note.f = 1;
        this._emit('selectionchange');

        this.saveSnapshot(); // pre-mutation snapshot for undo
        if (hit.isResizeHandle) {
          this._dragging = {
            mode: 'resize',
            idx: hit.idx,
            startTick: tick,
            startGate: hit.note.g || 0
          };
          this._el.style.cursor = 'ew-resize';
        } else {
          // Snapshot original positions of every selected note
          const initial = new Map();
          this._sequence.forEach((n, i) => {
            if (n.f === 1) initial.set(i, { t: n.t, nNote: n.n });
          });
          this._dragging = {
            mode: 'move',
            startTick: tick,
            startNote: note,
            initial,
            lastEmittedTick: tick,
            lastEmittedNote: note
          };
          this._el.style.cursor = 'grabbing';
        }
        this._scheduleRender();
        return;
      }

      // Empty area → selection rectangle
      if (!(e.ctrlKey || e.metaKey)) this.deselectAll();
      this._selectionRect = { x0: x, y0: y, x, y };
      this._dragging = { mode: 'rect' };
      this._scheduleRender();
    }

    _onMouseMove(e) {
      if (!this._el || !this._dragging) return;
      const { x, y } = this._localCoords(e);
      const d = this._dragging;
      if (d.mode === 'scrollbar') {
        // Continue dragging the vertical scrollbar thumb.
        const sbH = this._cssHeight;
        const ratio = Math.max(0, Math.min(1, y / sbH));
        const newY = Math.max(
          0,
          Math.min(128 - this._yrange, Math.round(ratio * 128 - this._yrange / 2))
        );
        if (newY !== this._yoffset) {
          this._yoffset = newY;
          this._bgDirty = true;
          this._emit('viewportchange', {
            xoffset: this._xoffset,
            yoffset: this._yoffset,
            xrange: this._xrange,
            yrange: this._yrange
          });
          this._scheduleRender();
        }
        return;
      }
      if (d.mode === 'rect') {
        this._selectionRect.x = x;
        this._selectionRect.y = y;
        this._scheduleRender();
      } else if (d.mode === 'pan') {
        const dx = x - d.startX;
        const dy = y - d.startY;
        const tickPerPx = (this._xrange || 1) / Math.max(1, this._cssWidth - KB_WIDTH);
        const newXOff = Math.max(0, d.startXOffset - dx * tickPerPx);
        const notePerPx = 1 / this._noteHeight();
        const newYOff = Math.max(
          0,
          Math.min(NOTE_MAX - this._yrange, Math.round(d.startYOffset + dy * notePerPx))
        );
        // Coalesce both axes into ONE viewportchange emit so downstream
        // listeners (overview bar, lane editor sync) don't run twice per
        // mousemove frame. The bg cache is horizontally invariant (see
        // `_paintBackground` / `setXOffset`), so only Y changes invalidate it.
        const xChanged = newXOff !== this._xoffset;
        const yChanged = newYOff !== this._yoffset;
        if (xChanged) this._xoffset = newXOff;
        if (yChanged) {
          this._yoffset = newYOff;
          this._bgDirty = true;
        }
        if (xChanged || yChanged) {
          this._emit('viewportchange', {
            xoffset: this._xoffset,
            yoffset: this._yoffset,
            xrange: this._xrange,
            yrange: this._yrange
          });
          this._scheduleRender();
        }
      } else if (d.mode === 'move') {
        // Δ from drag start, snapped to grid
        const tick = this._xToTick(x);
        const note = this._yToNote(y);
        const dt = this._snapTicks(tick - d.startTick);
        const dn = note - d.startNote;
        let mutated = false;
        const movedNotes = [];
        for (const [idx, init] of d.initial) {
          const n = this._sequence[idx];
          if (!n) continue;
          const newT = Math.max(0, init.t + dt);
          const newN = Math.max(NOTE_MIN, Math.min(NOTE_MAX, init.nNote + dn));
          if (n.t !== newT || n.n !== newN) {
            n.t = newT;
            n.n = newN;
            mutated = true;
          }
          movedNotes.push(n);
        }
        if (mutated) {
          // Bucket index intentionally NOT dirtied here — it would
          // force an O(n) rebuild every drag frame. _paintNotes
          // does a flat culled scan while dragging; the index is
          // rebuilt once on _onMouseUp.
          this._scheduleRender();
          // Emit `notedragmove` so CC editors / preview synth can react
          // (matches the webaudio-pianoroll event surface).
          if (tick !== d.lastEmittedTick || note !== d.lastEmittedNote) {
            d.lastEmittedTick = tick;
            d.lastEmittedNote = note;
            this._emit('notedragmove', { notes: movedNotes });
          }
        }
      } else if (d.mode === 'resize') {
        const tick = this._xToTick(x);
        const dt = this._snapTicks(tick - d.startTick);
        const n = this._sequence[d.idx];
        if (n) {
          const newGate = Math.max(MIN_NOTE_GATE, d.startGate + dt);
          if (n.g !== newGate) {
            n.g = newGate;
            // Index rebuilt on _onMouseUp (see move branch).
            this._scheduleRender();
          }
        }
      }
    }

    _onMouseUp() {
      if (!this._dragging) return;
      const d = this._dragging;
      if (d.mode === 'move' || d.mode === 'resize') {
        // The mutation already happened in mousemove. Rebuild the
        // spatial index once now (it was deliberately not dirtied
        // per drag frame) so hit-tests / range queries are correct.
        this._bucketsDirty = true;
        // Finalize with a single `change` emit (debouncing per-frame
        // events would cost more than this one-shot at end of drag).
        this._emit('change');
        this._dragging = null;
        if (this._el) this._el.style.cursor = '';
        return;
      }
      if (d.mode === 'rect' && this._selectionRect) {
        // Convert the rect to tick/note bounds, mark intersecting notes f=1
        const r = this._selectionRect;
        const x1 = Math.min(r.x0, r.x),
          x2 = Math.max(r.x0, r.x);
        const y1 = Math.min(r.y0, r.y),
          y2 = Math.max(r.y0, r.y);
        const t1 = this._xToTick(Math.max(KB_WIDTH, x1));
        const t2 = this._xToTick(Math.max(KB_WIDTH, x2));
        const n1 = this._yToNote(y2); // y inverted
        const n2 = this._yToNote(y1);
        const indices = this._notesInTickRange(Math.min(t1, t2), Math.max(t1, t2));
        let changed = false;
        for (const idx of indices) {
          const n = this._sequence[idx];
          if (!n) continue;
          if (n.n >= Math.min(n1, n2) && n.n <= Math.max(n1, n2)) {
            if (n.f !== 1) {
              n.f = 1;
              changed = true;
            }
          }
        }
        this._selectionRect = null;
        if (changed) this._emit('selectionchange');
        this._scheduleRender();
      } else if (d.mode === 'pianokey') {
        this._emit('pianokeyup', { note: d.note });
      }
      this._dragging = null;
      if (this._el) this._el.style.cursor = '';
    }

    /**
     * Track the mouse over the notes area to drive the crosshair
     * overlay. Falls through silently when a drag is in progress —
     * `_onMouseMove` already updates the drag visuals and the
     * crosshair would compete with them.
     */
    _onHover(e) {
      if (this._dragging) return;
      // No persistent hover on touch — a finger has no "rest"
      // position, so a sticky crosshair would just be noise.
      if (this._lastPointerType === 'touch') {
        if (this._hoverX !== null) this._onHoverLeave();
        return;
      }
      const { x, y } = this._localCoords(e);
      const inside = x >= KB_WIDTH && y >= RULER_H && x <= this._cssWidth && y <= this._cssHeight;
      const nx = inside ? x : null;
      const ny = inside ? y : null;
      if (nx === this._hoverX && ny === this._hoverY) return;
      this._hoverX = nx;
      this._hoverY = ny;
      this._scheduleRender();
    }

    _onHoverLeave() {
      if (this._hoverX === null && this._hoverY === null) return;
      this._hoverX = null;
      this._hoverY = null;
      this._scheduleRender();
    }

    // ----------------------------------------------------------------
    // Right-click context menu
    // ----------------------------------------------------------------

    _onContextMenu(e) {
      if (!this._el) return;
      e.preventDefault();
      this._closeContextMenu();
      const { x, y } = this._localCoords(e);
      const hit = this._hitTestNote(x, y);
      // Right-clicking an unselected note selects just that note so
      // the menu acts on something predictable.
      if (hit && !hit.note.f) {
        this.deselectAll();
        hit.note.f = 1;
        this._emit('selectionchange');
        this._scheduleRender();
      }
      const clickTick = Math.max(0, this._snapTicks(this._xToTick(x)));
      const sel = this.getSelectedNotes();
      const selCount = sel.length;
      const selChannels = new Set(sel.map((n) => n.c ?? 0));
      const curCh = selChannels.size === 1 ? [...selChannels][0] : -1;

      const channelChildren = [];
      for (let ch = 0; ch < 16; ch++) {
        const color = this._channelColors[ch % 16] || this._theme.colnote;
        channelChildren.push({
          label: `Canal ${ch + 1}${ch === curCh ? '  ✓' : ''}`,
          swatch: color,
          action: () => {
            if (ch === curCh) return;
            this.saveSnapshot();
            this.changeChannelSelection(ch);
            // Let the host (modal) register the channel in its
            // panel / activeChannels — `change` alone doesn't.
            this._emit('channelchange', { channel: ch });
          }
        });
      }

      const VELOCITY_PRESETS = [
        ['ppp', 16],
        ['pp', 33],
        ['p', 49],
        ['mp', 64],
        ['mf', 80],
        ['f', 96],
        ['ff', 112],
        ['fff', 127]
      ];
      const velocityChildren = VELOCITY_PRESETS.map(([name, v]) => ({
        label: `${name}  (${v})`,
        action: () => {
          this.saveSnapshot();
          this._sequence.forEach((n) => {
            if (n.f === 1) n.v = v;
          });
          this._scheduleRender();
          this._emit('change');
        }
      }));

      const items = [
        {
          label: 'Copier',
          disabled: selCount === 0,
          action: () => {
            this._clipboard = this.copySelection();
          }
        },
        {
          label: 'Coller',
          disabled: this._clipboard.length === 0,
          action: () => {
            this.saveSnapshot();
            // Anchor the earliest copied note exactly at the
            // (snapped) right-click tick — intuitive "paste here".
            const base = this._clipboard.reduce((m, n) => Math.min(m, n.t ?? 0), Infinity);
            const off = base === Infinity ? clickTick : clickTick - base;
            this.pasteNotes(this._clipboard, off);
          }
        },
        {
          label: 'Supprimer',
          disabled: selCount === 0,
          action: () => {
            this.saveSnapshot();
            this.deleteSelection();
          }
        },
        { separator: true },
        { label: 'Changer de canal', disabled: selCount === 0, children: channelChildren },
        { label: 'Vélocité', disabled: selCount === 0, children: velocityChildren }
      ];
      this._openContextMenu(e.clientX, e.clientY, items);
    }

    _openContextMenu(clientX, clientY, items) {
      const t = this._theme;
      const menu = document.createElement('div');
      menu.className = 'piano-roll-ctxmenu';
      menu.style.cssText = [
        'position:fixed',
        'z-index:100000',
        `left:${clientX}px`,
        `top:${clientY}px`,
        `background:${t.colrulerbg || '#2a2a3a'}`,
        `color:${t.colrulerfg || '#eee'}`,
        `border:1px solid ${t.colrulerborder || '#555'}`,
        'border-radius:6px',
        'padding:4px 0',
        'min-width:180px',
        'box-shadow:0 6px 24px rgba(0,0,0,0.35)',
        'font:13px system-ui,sans-serif',
        'user-select:none'
      ].join(';');
      // Swallow pointer/mouse-down on the menu chrome (padding,
      // separators) so it never reaches the outside-dismiss handler.
      const stop = (ev) => ev.stopPropagation();
      menu.addEventListener('pointerdown', stop);
      menu.addEventListener('mousedown', stop);
      this._renderCtxRows(menu, items, null);
      document.body.appendChild(menu);
      this._ctxMenuEl = menu;
      this._clampCtxMenu();

      // Dismiss on any outside interaction.
      const dismiss = (ev) => {
        if (this._ctxMenuEl && !this._ctxMenuEl.contains(ev.target)) {
          this._closeContextMenu();
        } else if (ev.type === 'keydown' && ev.key === 'Escape') {
          this._closeContextMenu();
        }
      };
      this._ctxMenuDismiss = dismiss;
      setTimeout(() => {
        // The menu may have been closed/destroyed during the 0ms
        // gap — only attach if this dismiss is still the live one,
        // otherwise these listeners would never be removed.
        if (this._ctxMenuDismiss !== dismiss) return;
        document.addEventListener('pointerdown', dismiss, true);
        document.addEventListener('keydown', dismiss, true);
        window.addEventListener('blur', dismiss, true);
      }, 0);
    }

    /**
     * (Re)build the rows of an open context menu element. Supports
     * drill-in submenus (`it.children`) and a colour `it.swatch`.
     * `parentItems` non-null adds a "back" row that re-renders the
     * parent level — keeps the whole thing inside one DOM node so the
     * outside-dismiss containment check still works.
     */
    _renderCtxRows(menu, items, parentItems) {
      const t = this._theme;
      menu.textContent = '';
      const mkRow = (label, { disabled, swatch, lead } = {}) => {
        const row = document.createElement('div');
        row.style.cssText =
          `padding:6px 14px;display:flex;align-items:center;gap:8px;` +
          (disabled ? 'opacity:0.4;cursor:default' : 'cursor:pointer');
        if (swatch) {
          const sw = document.createElement('span');
          sw.style.cssText =
            `width:11px;height:11px;border-radius:2px;flex:0 0 auto;` +
            `background:${swatch};border:1px solid rgba(0,0,0,0.35)`;
          row.appendChild(sw);
        } else if (lead) {
          const sp = document.createElement('span');
          sp.textContent = lead;
          sp.style.cssText = 'flex:0 0 auto;opacity:0.7';
          row.appendChild(sp);
        }
        const txt = document.createElement('span');
        txt.textContent = label;
        txt.style.flex = '1 1 auto';
        row.appendChild(txt);
        return row;
      };

      if (parentItems) {
        const back = mkRow('Retour', { lead: '‹' });
        const goBack = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!this._ctxMenuEl) return;
          this._renderCtxRows(menu, parentItems, null);
          this._clampCtxMenu();
        };
        back.addEventListener('mouseenter', () => {
          back.style.background = 'rgba(94,142,255,0.25)';
        });
        back.addEventListener('mouseleave', () => {
          back.style.background = '';
        });
        back.addEventListener('pointerdown', goBack);
        back.addEventListener('mousedown', goBack);
        menu.appendChild(back);
        const hr = document.createElement('div');
        hr.style.cssText = `height:1px;margin:4px 0;background:${t.colrulerborder || '#555'};opacity:0.6`;
        menu.appendChild(hr);
      }

      for (const it of items) {
        if (it.separator) {
          const hr = document.createElement('div');
          hr.style.cssText = `height:1px;margin:4px 0;background:${t.colrulerborder || '#555'};opacity:0.6`;
          menu.appendChild(hr);
          continue;
        }
        const hasChildren = Array.isArray(it.children);
        const row = mkRow(it.label + (hasChildren ? '' : ''), {
          disabled: it.disabled,
          swatch: it.swatch
        });
        if (hasChildren && !it.disabled) {
          const chev = document.createElement('span');
          chev.textContent = '›';
          chev.style.cssText = 'flex:0 0 auto;opacity:0.7';
          row.appendChild(chev);
        }
        if (!it.disabled) {
          row.addEventListener('mouseenter', () => {
            row.style.background = 'rgba(94,142,255,0.25)';
          });
          row.addEventListener('mouseleave', () => {
            row.style.background = '';
          });
          const activate = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (!this._ctxMenuEl) return;
            if (hasChildren) {
              this._renderCtxRows(menu, it.children, items);
              this._clampCtxMenu();
              return;
            }
            this._closeContextMenu();
            try {
              it.action();
            } catch (_) {
              /* user-cancel / parse */
            }
          };
          row.addEventListener('pointerdown', activate);
          row.addEventListener('mousedown', activate);
        }
        menu.appendChild(row);
      }
    }

    /** Nudge the open menu back inside the viewport after (re)render. */
    _clampCtxMenu() {
      const menu = this._ctxMenuEl;
      if (!menu) return;
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth) {
        menu.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
      }
      if (r.bottom > window.innerHeight) {
        menu.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
      }
    }

    _closeContextMenu() {
      if (this._ctxMenuDismiss) {
        document.removeEventListener('pointerdown', this._ctxMenuDismiss, true);
        document.removeEventListener('keydown', this._ctxMenuDismiss, true);
        window.removeEventListener('blur', this._ctxMenuDismiss, true);
        this._ctxMenuDismiss = null;
      }
      if (this._ctxMenuEl && this._ctxMenuEl.parentNode) {
        this._ctxMenuEl.parentNode.removeChild(this._ctxMenuEl);
      }
      this._ctxMenuEl = null;
    }

    _onWheel(e) {
      // Modifiers:
      //   ctrl/meta + wheel        → horizontal zoom (xrange)
      //   ctrl/meta + shift + wheel → vertical zoom (yrange)
      //   shift + wheel             → vertical scroll (yoffset)
      //   no modifier               → horizontal scroll (xoffset)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.2 : 0.8;
        const newRange = Math.max(12, Math.min(88, Math.round(this._yrange * factor)));
        if (newRange !== this._yrange) {
          // Pivot the zoom around the pitch under the mouse so the
          // note the user is targeting stays put (falls back to
          // viewport-centred zoom when the cursor is over the
          // ruler / keyboard chrome).
          const { x, y } = this._localCoords(e);
          const oldRange = this._yrange;
          // Use the real `_noteHeight()` so the zoom pivot matches
          // exactly what's drawn.
          if (x >= KB_WIDTH && y >= RULER_H) {
            const oldNoteH = this._noteHeight();
            const notesFromTop = (y - RULER_H) / oldNoteH; // fractional
            const pitchAtMouse = this._yoffset + oldRange - 1 - notesFromTop;
            this._yrange = newRange;
            const newNoteH = this._noteHeight();
            const newNotesFromTop = (y - RULER_H) / newNoteH;
            const rawOffset = pitchAtMouse - newRange + 1 + newNotesFromTop;
            this._yoffset = Math.max(0, Math.min(128 - newRange, Math.round(rawOffset)));
          } else {
            this._yrange = newRange;
            this._yoffset = Math.max(0, Math.min(128 - newRange, this._yoffset));
          }
          this._bgDirty = true;
          this._emit('viewportchange', {
            xoffset: this._xoffset,
            yoffset: this._yoffset,
            xrange: this._xrange,
            yrange: this._yrange
          });
          this._scheduleRender();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.2 : 0.8;
        const newRange = Math.max(16, Math.min(100000, Math.round(this._xrange * factor)));
        if (newRange !== this._xrange) {
          // Pivot horizontal zoom around the tick under the mouse
          // (keep the same pixel column under the cursor before /
          // after). Falls back to plain xrange swap when the
          // cursor sits on the keyboard / scrollbar chrome.
          const { x } = this._localCoords(e);
          const w = Math.max(1, this._cssWidth - KB_WIDTH);
          if (x >= KB_WIDTH) {
            const tickAtMouse = (x - KB_WIDTH) * (this._xrange / w) + this._xoffset;
            this._xrange = newRange;
            const newOffset = tickAtMouse - (x - KB_WIDTH) * (newRange / w);
            this._xoffset = Math.max(0, newOffset);
          } else {
            this._xrange = newRange;
          }
          // Horizontal zoom only: bg cache is horizontally invariant
          // (see setXRange). Don't invalidate.
          this._emit('viewportchange', {
            xoffset: this._xoffset,
            yoffset: this._yoffset,
            xrange: this._xrange
          });
          this._scheduleRender();
        }
        return;
      }
      if (e.shiftKey && Math.abs(e.deltaY) > 0) {
        // Vertical scroll — 3 notes per "tick" of wheel delta (matches WAC feel).
        e.preventDefault();
        const step = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 30));
        const newY = Math.max(0, Math.min(128 - this._yrange, this._yoffset + step));
        if (newY !== this._yoffset) {
          this._yoffset = newY;
          this._bgDirty = true;
          this._emit('viewportchange', {
            xoffset: this._xoffset,
            yoffset: this._yoffset,
            xrange: this._xrange
          });
          this._scheduleRender();
        }
        return;
      }
      if (Math.abs(e.deltaY) > 0) {
        e.preventDefault();
        const tickPerPx = (this._xrange || 1) / Math.max(1, this._cssWidth - KB_WIDTH);
        const delta = e.deltaY * tickPerPx;
        const newOff = Math.max(0, this._xoffset + delta);
        if (newOff !== this._xoffset) {
          this._xoffset = newOff;
          // Horizontal pan only: bg cache is horizontally invariant.
          this._emit('viewportchange', {
            xoffset: this._xoffset,
            yoffset: this._yoffset,
            xrange: this._xrange
          });
          this._scheduleRender();
        }
      }
    }

    /**
     * Hit-test a note at (x, y) in CSS coords. Returns `{idx, note,
     * isResizeHandle}` when a note is hit, `null` otherwise.
     * The right-most `RESIZE_HANDLE_PX` of each note triggers a
     * resize cursor; everything else is a body grab.
     */
    _hitTestNote(x, y) {
      if (x < KB_WIDTH) return null;
      const tick = this._xToTick(x);
      const note = this._yToNote(y);
      const tickPerPx = (this._xrange || 1) / Math.max(1, this._cssWidth - KB_WIDTH);
      const tol = tickPerPx * 2;
      const indices = this._notesInTickRange(tick - tol, tick + tol);
      for (const idx of indices) {
        const n = this._sequence[idx];
        if (!n) continue;
        if (n.n !== note) continue;
        if (tick >= n.t && tick <= n.t + (n.g || 0)) {
          const noteEndX = this._tickToX(n.t + (n.g || 0));
          const isResizeHandle = noteEndX - x <= RESIZE_HANDLE_PX && (n.g || 0) >= tol * 2;
          return { idx, note: n, isResizeHandle };
        }
      }
      return null;
    }

    /** Snap a tick offset to the configured grid (`_snap`). */
    _snapTicks(ticks) {
      const s = this._snap || 1;
      return Math.round(ticks / s) * s;
    }

    // ----------------------------------------------------------------
    // B8 — Double-click create
    // ----------------------------------------------------------------

    /**
     * Create a note at the (x, y) CSS coords, snapped to grid, selected
     * and ready for undo. Returns its index in `_sequence`, or -1 when
     * the position is outside the editable area. Shared by the
     * double-click handler and the click-to-create UI modes.
     */
    _createNoteAt(x, y) {
      if (x < KB_WIDTH) return -1;
      const note = this._yToNote(y);
      if (note < NOTE_MIN || note > NOTE_MAX) return -1;
      const t = Math.max(0, this._snapTicks(this._xToTick(x)));
      const gate = Math.max(
        MIN_NOTE_GATE,
        Math.round((this._snap || this._grid || 120) * DEFAULT_NEW_NOTE_GATE_RATIO)
      );
      this.saveSnapshot();
      const newNote = { t, g: gate, n: note, c: this._defaultChannel, v: 100, f: 1 };
      this.deselectAll();
      this._sequence.push(newNote);
      // Index left dirty — _notesInTickRange() rebuilds it lazily so
      // subsequent hit-tests still find the fresh note.
      this._bucketsDirty = true;
      this._scheduleRender();
      this._emit('change');
      this._emit('selectionchange');
      return this._sequence.length - 1;
    }

    _onDblClick(e) {
      if (!this._el) return;
      const { x, y } = this._localCoords(e);
      // Only create inside the notes area (not on the keyboard column)
      if (x < KB_WIDTH) return;
      // If clicking on an existing note, deletion would be intuitive
      // but `<webaudio-pianoroll>` doesn't do that — keep parity and
      // ignore dblclick on hit.
      if (this._hitTestNote(x, y)) return;
      this._createNoteAt(x, y);
    }

    // ----------------------------------------------------------------
    // B9 — Keyboard shortcuts
    // ----------------------------------------------------------------

    _onKeyDown(e) {
      if (!this._el) return;
      // Only handle when the canvas itself has focus (avoids stealing
      // global Ctrl+Z when the user is in another input).
      if (document.activeElement !== this._el) return;

      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (this.getSelectionCount() > 0) {
          this.saveSnapshot();
          this.deleteSelection();
        }
      } else if (ctrl && e.key === 'a') {
        e.preventDefault();
        this.selectAll();
        this._emit('selectionchange');
      } else if (ctrl && (e.key === 'c' || e.key === 'C')) {
        if (this.getSelectionCount() > 0) {
          e.preventDefault();
          this._clipboard = this.copySelection();
        }
      } else if (ctrl && (e.key === 'v' || e.key === 'V')) {
        if (this._clipboard.length > 0) {
          e.preventDefault();
          this.saveSnapshot();
          // Anchor earliest copied note at the playback cursor.
          const base = this._clipboard.reduce((m, n) => Math.min(m, n.t ?? 0), Infinity);
          const off = base === Infinity ? this._cursor : this._cursor - base;
          this.pasteNotes(this._clipboard, off);
        }
      } else if (ctrl && (e.key === 'z' || (e.shiftKey && (e.key === 'Z' || e.key === 'z')))) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (ctrl && e.key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (e.key === 'Escape') {
        this.deselectAll();
        this._emit('selectionchange');
      }
    }

    /**
     * Range query: returns note indices whose interval intersects
     * `[tickStart, tickEnd]`. Used by `_paintNotes()` for viewport
     * culling and by `_hitTestNote()`.
     */
    _notesInTickRange(tickStart, tickEnd) {
      if (this._bucketsDirty) this._rebuildBuckets();
      const out = new Set();
      const B = this._bucketTicks;
      const b0 = Math.floor(tickStart / B);
      const b1 = Math.floor(tickEnd / B);
      for (let b = b0; b <= b1; b++) {
        const bucket = this._buckets.get(b);
        if (!bucket) continue;
        for (const idx of bucket) {
          const n = this._sequence[idx];
          if (!n) continue;
          if (n.t + (n.g || 0) < tickStart) continue;
          if (n.t > tickEnd) continue;
          out.add(idx);
        }
      }
      return out;
    }

    _paintOverlay() {
      const ctx = this._ctx;
      const H = this._cssHeight;
      // Cursor line
      const cx = this._tickToX(this._cursor);
      if (cx >= KB_WIDTH && cx <= this._cssWidth) {
        ctx.strokeStyle = this._theme.colcursor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, RULER_H);
        ctx.lineTo(cx + 0.5, H);
        ctx.stroke();
      }

      // Loop-end boundary: a clear vertical line at the loop length
      // (`_markend`, set to ppq*timeSigNum*bars by the editor) plus a
      // dimmed overlay on the out-of-loop area beyond it, so the user
      // can see where the loop stops while drawing notes.
      if (this._markend > 0) {
        const mx = this._tickToX(this._markend);
        ctx.save();
        const dimX = Math.max(KB_WIDTH, mx);
        if (dimX < this._cssWidth) {
          ctx.fillStyle = 'rgba(20, 22, 32, 0.55)';
          ctx.fillRect(dimX, RULER_H, this._cssWidth - dimX, H - RULER_H);
        }
        if (mx >= KB_WIDTH && mx <= this._cssWidth) {
          ctx.strokeStyle = this._theme.colmark;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(mx + 0.5, RULER_H);
          ctx.lineTo(mx + 0.5, H);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Crosshair following the mouse over the notes area — helps
      // line up a double-click create with a specific tick. Hidden
      // during drag (the drag indicator already conveys position).
      if (this._hoverX !== null && !this._dragging) {
        ctx.strokeStyle = 'rgba(94, 142, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const hx = Math.floor(this._hoverX) + 0.5;
        ctx.moveTo(hx, RULER_H);
        ctx.lineTo(hx, H);
        ctx.stroke();
      }

      // Selection rectangle (active drag)
      if (this._selectionRect) {
        const r = this._selectionRect;
        const x1 = Math.min(r.x0, r.x),
          y1 = Math.min(r.y0, r.y);
        const x2 = Math.max(r.x0, r.x),
          y2 = Math.max(r.y0, r.y);
        ctx.fillStyle = 'rgba(94, 142, 255, 0.15)';
        ctx.strokeStyle = '#5e8eff';
        ctx.lineWidth = 1;
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
      }

      // Vertical scroll indicator on the LEFT edge of the canvas
      // (left of the keyboard column). Spans full height (y=0..H).
      //
      // Layout inside the SB column (24 px):
      //   x = 0..4    → 0-128 range minimap (the "thumb track")
      //   x = 4..24   → visible-range strip: octave dividers + labels
      //                 aligned with the keyboard's C positions
      //
      // The visible-range strip lets the user verify visually that
      // "C3" on the scrollbar is at the same y as "C3" on the
      // keyboard — the audit follow-up complaint was that the old
      // full-range dividers looked off when the keyboard was zoomed.
      //
      // Click/drag anywhere on the SB scrolls via the 0-128 mapping
      // (recentre yoffset so the click ratio matches the target).
      const sbY0 = 0;
      const sbH = H;
      const stripX = 4;
      const trackBg = this._theme.colrulerbg || '#d5cdef';
      const trackFg = this._theme.colrulerfg || '#4a3f6b';
      const trackBorder = this._theme.colrulerborder || '#c0b8d8';

      // Track background — full SB column.
      ctx.fillStyle = trackBg;
      ctx.fillRect(0, sbY0, SB_W, sbH);

      // Right border separating SB from keyboard.
      ctx.strokeStyle = trackBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(SB_W - 0.5, 0);
      ctx.lineTo(SB_W - 0.5, H);
      ctx.stroke();

      // Vertical separator between the 0-128 minimap column and the
      // visible-range strip.
      ctx.beginPath();
      ctx.moveTo(stripX + 0.5, 0);
      ctx.lineTo(stripX + 0.5, H);
      ctx.stroke();

      // 0-128 minimap thumb (left strip, 4 px wide) — shows where in
      // the full pitch range the visible window is, drawn as a solid
      // blue rectangle. Adapts to zoom: shrinks/grows with `yrange`.
      const thumbY = sbY0 + sbH * (this._yoffset / 128);
      const thumbH = Math.max(8, sbH * (this._yrange / 128));
      ctx.fillStyle = '#5e8eff';
      ctx.fillRect(0, thumbY, stripX, thumbH);

      // Visible-range strip — octave dividers at the *same y* as the
      // keyboard's C labels. Iterate the visible range and draw a
      // separator + label for every C (midi % 12 === 0).
      ctx.strokeStyle = trackBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const noteH = this._noteHeight();
      for (let n = this._yoffset; n < this._yoffset + this._yrange; n++) {
        if (n < NOTE_MIN || n > NOTE_MAX) continue;
        if (n % 12 !== 0) continue;
        const y = this._noteToY(n);
        ctx.moveTo(stripX, y + 0.5);
        ctx.lineTo(SB_W, y + 0.5);
      }
      ctx.stroke();

      // Octave labels — same y as the keyboard's C labels. Only when
      // there's vertical room.
      if (noteH >= 8) {
        ctx.fillStyle = trackFg;
        ctx.font = '9px monospace';
        ctx.textBaseline = 'middle';
        for (let n = this._yoffset; n < this._yoffset + this._yrange; n++) {
          if (n < NOTE_MIN || n > NOTE_MAX) continue;
          if (n % 12 !== 0) continue;
          const y = this._noteToY(n);
          ctx.fillText(`C${Math.floor(n / 12) - 1}`, stripX + 3, y + noteH / 2);
        }
      }
    }

    // ----------------------------------------------------------------
    // Coordinate helpers
    // ----------------------------------------------------------------

    _noteHeight() {
      const drawH = this._cssHeight - RULER_H;
      return Math.max(NOTE_H_MIN, Math.min(NOTE_H_MAX, drawH / this._yrange));
    }
    _noteToY(note) {
      // Higher pitch = lower Y (inverted)
      return RULER_H + (this._yoffset + this._yrange - 1 - note) * this._noteHeight();
    }
    _yToNote(y) {
      return this._yoffset + this._yrange - 1 - Math.floor((y - RULER_H) / this._noteHeight());
    }
    _tickToX(tick) {
      const w = this._cssWidth - KB_WIDTH;
      const scale = w / (this._xrange || 1);
      return KB_WIDTH + (tick - this._xoffset) * scale;
    }
    _xToTick(x) {
      const w = this._cssWidth - KB_WIDTH;
      const scale = (this._xrange || 1) / w;
      return Math.round((x - KB_WIDTH) * scale + this._xoffset);
    }
  }

  if (typeof window !== 'undefined') {
    window.CanvasPianoRollRenderer = CanvasPianoRollRenderer;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CanvasPianoRollRenderer };
  }
})();
