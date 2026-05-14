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
 * The renderer extends `PianoRollRenderer` and conforms to the same
 * contract as `WebaudioPianorollAdapter`. Drop-in swap is gated by the
 * feature flag wired in `MidiEditorRouting` (see Phase B5).
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
    const SB_W     = 12;       // vertical scrollbar column on the left edge
    const KB_W     = 40;       // keyboard column (without scrollbar)
    const KB_WIDTH = SB_W + KB_W; // total left chrome — notes start at x >= KB_WIDTH
    const RULER_H  = 18;       // top ruler
    const NOTE_H_MIN = 4;      // min note row height (pitch)
    const NOTE_H_MAX = 24;     // max note row height (pitch)

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
            this._yoffset = 36;    // pitch
            this._yrange = 36;     // pitches visible
            this._tempo = opts.tempo ?? 120;
            this._timebase = opts.ppq ?? 480;
            this._grid = 120;
            this._snap = 120;
            this._editMode = opts.mode ?? 'dragpoly';
            this._uiMode = 'drag-view';

            // ---- theme ----
            // Defaults match a light theme. MidiEditorViewport._applyPianoRollTheme
            // overrides these via setThemeColors() based on the user's current
            // (light/dark) preference. White keys should *look white* — using
            // a dark grey as default made the keyboard look entirely grey.
            this._theme = {
                collt:          '#ddd6f3',
                coldk:          '#d2cae8',
                colgrid:        '#c8c0de',
                colrulerbg:     '#d5cdef',
                colrulerfg:     '#4a3f6b',
                colrulerborder: '#c0b8d8',
                colnote:        '#5e8eff',
                colnotesel:     '#ffd866',
                colnoteborder:  'rgba(102,126,234,0.25)',
                colkbwhite:     '#f8f8f8',
                colkbblack:     '#222222',
                colcursor:      '#e74c3c'
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
            this._bucketTicks = 480 * 4;  // 1 measure per bucket by default
            this._buckets = new Map();
            this._bucketsDirty = true;

            // ---- Interaction (B4) ----
            this._selectionRect = null;   // {x0, y0, x, y} in CSS px while drawing
            this._dragging = null;        // {mode: 'rect'|'pan'|'note'|'pianokey'}
            this._mouseDownHandler = null;
            this._mouseMoveHandler = null;
            this._mouseUpHandler = null;
            this._wheelHandler = null;
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
            this._mouseDownHandler = (e) => this._onMouseDown(e);
            this._mouseMoveHandler = (e) => this._onMouseMove(e);
            this._mouseUpHandler   = (e) => this._onMouseUp(e);
            this._wheelHandler     = (e) => this._onWheel(e);
            this._dblClickHandler  = (e) => this._onDblClick(e);
            this._keyDownHandler   = (e) => this._onKeyDown(e);
            this._el.addEventListener('mousedown', this._mouseDownHandler);
            this._el.addEventListener('dblclick',  this._dblClickHandler);
            this._el.addEventListener('keydown',   this._keyDownHandler);
            // Move/Up bind on window so a drag that leaves the canvas still
            // completes deterministically.
            window.addEventListener('mousemove', this._mouseMoveHandler);
            window.addEventListener('mouseup',   this._mouseUpHandler);
            this._el.addEventListener('wheel', this._wheelHandler, { passive: false });
        }

        attachToContainer() {
            if (!this._el || !this._container) return this;
            this._container.appendChild(this._el);
            this._scheduleRender();
            return this;
        }

        destroy() {
            if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
            this._handlers.clear();
            if (this._el) {
                this._el.removeEventListener('mousedown', this._mouseDownHandler);
                this._el.removeEventListener('dblclick',  this._dblClickHandler);
                this._el.removeEventListener('keydown',   this._keyDownHandler);
                this._el.removeEventListener('wheel',     this._wheelHandler);
            }
            window.removeEventListener('mousemove', this._mouseMoveHandler);
            window.removeEventListener('mouseup',   this._mouseUpHandler);
            if (this._el?.parentNode) this._el.parentNode.removeChild(this._el);
            this._el = null;
            this._ctx = null;
            this._bgCanvas = null;
            this._bgCtx = null;
            super.destroy();
            return this;
        }

        getElement() { return this._el; }

        // ----------------------------------------------------------------
        // Size handling (devicePixelRatio aware)
        // ----------------------------------------------------------------

        _applySize(w, h) {
            if (!this._el) return;
            const dpr = window.devicePixelRatio || 1;
            this._cssWidth = w;
            this._cssHeight = h;
            this._el.width  = Math.round(w * dpr);
            this._el.height = Math.round(h * dpr);
            this._el.style.width  = w + 'px';
            this._el.style.height = h + 'px';
            this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            this._bgCanvas.width  = this._el.width;
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

        setXRange(ticks) { if (this._xrange !== ticks) { this._xrange = ticks; this._bgDirty = true; this._scheduleRender(); } return this; }
        getXRange()      { return this._xrange; }
        setYRange(notes) { if (this._yrange !== notes) { this._yrange = notes; this._bgDirty = true; this._scheduleRender(); } return this; }
        getYRange()      { return this._yrange; }
        setXOffset(t)    { if (this._xoffset !== t) { this._xoffset = t; this._bgDirty = true; this._scheduleRender(); } return this; }
        getXOffset()     { return this._xoffset; }
        setYOffset(n)    { if (this._yoffset !== n) { this._yoffset = n; this._bgDirty = true; this._scheduleRender(); } return this; }
        getYOffset()     { return this._yoffset; }
        setCursor(t)     { if (this._cursor !== t) { this._cursor = t; this._scheduleRender(); } return this; }
        getCursor()      { return this._cursor; }
        setMarkers(a, b) { this._markstart = a; this._markend = b; this._scheduleRender(); return this; }
        getMarkers()     { return { start: this._markstart, end: this._markend }; }

        // ----------------------------------------------------------------
        // Musical config
        // ----------------------------------------------------------------

        setTempo(bpm)     { this._tempo = bpm; return this; }
        getTempo()        { return this._tempo; }
        setTimebase(ppq)  { this._timebase = ppq; this._bgDirty = true; this._scheduleRender(); return this; }
        getTimebase()     { return this._timebase; }
        setGrid(ticks)    { this._grid = ticks; this._bgDirty = true; this._scheduleRender(); return this; }
        setSnap(ticks)    { this._snap = ticks; return this; }
        setEditMode(mode) { this._editMode = mode; return this; }
        setUIMode(mode)   { this._uiMode = mode; return this; }
        getUIMode()       { return this._uiMode; }

        // ----------------------------------------------------------------
        // Data
        // ----------------------------------------------------------------

        setSequence(notes) {
            this._sequence = Array.isArray(notes) ? notes : [];
            this._bucketsDirty = true;
            this._scheduleRender();
            return this;
        }
        getSequence()                 { return this._sequence; }
        pushNote(note)                { this._sequence.push(note); this._bucketsDirty = true; this._scheduleRender(); return this; }
        clearSequence()               { this._sequence.length = 0; this._bucketsDirty = true; this._scheduleRender(); return this; }
        setChannelColors(map)         { this._channelColors = map || []; this._scheduleRender(); return this; }
        setDefaultChannel(ch)         { this._defaultChannel = ch; return this; }
        getDefaultChannel()           { return this._defaultChannel; }
        setChannelPlayableHighlights(map) {
            this._channelPlayableHighlights = map;
            this._bgDirty = true;
            this._scheduleRender();
            return this;
        }

        // ----------------------------------------------------------------
        // Selection (B4)
        // ----------------------------------------------------------------

        getSelectedNotes()    { return this._sequence.filter(n => n.f === 1); }
        getSelectionCount()   { return this.getSelectedNotes().length; }
        selectAll()           { this._sequence.forEach(n => n.f = 1); this._scheduleRender(); return this; }
        deselectAll()         { this._sequence.forEach(n => n.f = 0); this._scheduleRender(); return this; }
        copySelection()       { return this.getSelectedNotes().map(n => ({...n, f: 0})); }
        pasteNotes(notes, offsetTick) {
            if (!Array.isArray(notes)) return this;
            const off = offsetTick ?? this._cursor ?? 0;
            this.deselectAll();
            notes.forEach(n => this._sequence.push({...n, t: (n.t ?? 0) + off, f: 1}));
            this._bucketsDirty = true;
            this._scheduleRender();
            this._emit('change');
            return this;
        }
        deleteSelection() {
            const before = this._sequence.length;
            this._sequence = this._sequence.filter(n => n.f !== 1);
            if (this._sequence.length !== before) {
                this._bucketsDirty = true;
                this._scheduleRender();
                this._emit('change');
            }
            return this;
        }
        changeChannelSelection(ch) {
            this._sequence.forEach(n => { if (n.f === 1) n.c = ch; });
            this._scheduleRender();
            this._emit('change');
            return this;
        }

        // ----------------------------------------------------------------
        // History (snapshot-based, simple JSON undo stack)
        // ----------------------------------------------------------------

        _undoStack = [];
        _redoStack = [];
        _maxHistory = 100;

        saveSnapshot() {
            this._undoStack.push(JSON.stringify(this._sequence));
            if (this._undoStack.length > this._maxHistory) this._undoStack.shift();
            this._redoStack.length = 0;
            return this;
        }
        clearHistory() { this._undoStack.length = 0; this._redoStack.length = 0; return this; }
        canUndo()      { return this._undoStack.length > 0; }
        canRedo()      { return this._redoStack.length > 0; }
        undo() {
            if (!this.canUndo()) return false;
            this._redoStack.push(JSON.stringify(this._sequence));
            const snap = this._undoStack.pop();
            try {
                this._sequence = JSON.parse(snap);
                this._bucketsDirty = true;
                this._scheduleRender();
                this._emit('change');
                return true;
            } catch { return false; }
        }
        redo() {
            if (!this.canRedo()) return false;
            this._undoStack.push(JSON.stringify(this._sequence));
            const snap = this._redoStack.pop();
            try {
                this._sequence = JSON.parse(snap);
                this._bucketsDirty = true;
                this._scheduleRender();
                this._emit('change');
                return true;
            } catch { return false; }
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
        redrawMarker() { this._scheduleRender(); return this; }
        invalidateGridBuffer() { this._bgDirty = true; this._scheduleRender(); return this; }

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
            if (!set) { set = new Set(); this._handlers.set(event, set); }
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
                try { handler(ev); } catch (e) { console.error(`CanvasPianoRollRenderer ${event}:`, e); }
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

            // B2: notes layer (placeholder for now — overrides land in B2)
            this._paintNotes();

            // Overlay (cursor + markers + selection rect)
            this._paintOverlay();
        }

        // Background = keyboard column + ruler + grid lines
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

            // Time grid lines
            const ppq = this._timebase || 480;
            const beat = ppq;
            const startTick = Math.floor(this._xoffset / beat) * beat;
            const endTick = this._xoffset + this._xrange;
            ctx.strokeStyle = this._theme.colgrid;
            ctx.lineWidth = 1;
            for (let t = startTick; t <= endTick; t += beat) {
                const x = this._tickToX(t);
                if (x < KB_WIDTH || x > W) continue;
                const isMeasure = (t % (beat * 4)) === 0;
                ctx.globalAlpha = isMeasure ? 0.7 : 0.35;
                ctx.beginPath();
                ctx.moveTo(x + 0.5, RULER_H);
                ctx.lineTo(x + 0.5, H);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            // Keyboard column
            this._paintKeyboard(ctx);

            // Ruler (beats / measures)
            this._paintRuler(ctx);
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
            // Right border — separates the keyboard column from the notes
            // area. Drawn full-height so it visually frames the timeline
            // start (audit follow-up: timeline left edge = piano right edge).
            ctx.strokeStyle = this._theme.colrulerborder;
            ctx.beginPath();
            ctx.moveTo(KB_WIDTH + 0.5, 0);
            ctx.lineTo(KB_WIDTH + 0.5, H);
            ctx.stroke();
        }

        _paintRuler(ctx) {
            const W = this._cssWidth;
            // Ruler bg starts at KB_WIDTH so its left edge aligns with the
            // right edge of the piano keys — the area to the left (scrollbar
            // + keyboard top) is filled by _paintKeyboard / scrollbar render.
            ctx.fillStyle = this._theme.colrulerbg;
            ctx.fillRect(KB_WIDTH, 0, W - KB_WIDTH, RULER_H);
            ctx.strokeStyle = this._theme.colrulerborder;
            ctx.beginPath();
            ctx.moveTo(KB_WIDTH, RULER_H + 0.5);
            ctx.lineTo(W,        RULER_H + 0.5);
            ctx.stroke();

            const ppq = this._timebase || 480;
            const beatsPerMeasure = 4;
            const measureTicks = ppq * beatsPerMeasure;
            const startMeasure = Math.floor(this._xoffset / measureTicks);
            const endTick = this._xoffset + this._xrange;
            ctx.fillStyle = this._theme.colrulerfg;
            ctx.font = '10px monospace';
            ctx.textBaseline = 'middle';
            for (let m = startMeasure; m * measureTicks <= endTick; m++) {
                const tick = m * measureTicks;
                const x = this._tickToX(tick);
                if (x < KB_WIDTH - 4 || x > W) continue;
                ctx.fillText(String(m + 1), x + 2, RULER_H / 2);
            }
        }

        _paintNotes() {
            if (!this._sequence.length) return;
            if (this._bucketsDirty) this._rebuildBuckets();

            const ctx = this._ctx;
            const W = this._cssWidth;
            const noteH = this._noteHeight();
            const visStartTick = this._xoffset;
            const visEndTick   = this._xoffset + this._xrange;
            const minNote = this._yoffset;
            const maxNote = this._yoffset + this._yrange - 1;
            const seen = new Set();

            // Iterate only the buckets that intersect the visible viewport
            // (§3.1 viewport culling). With 1-measure buckets we visit
            // O(xrange / measure) buckets — typically <10 vs full O(n).
            const startBucket = Math.floor(visStartTick / this._bucketTicks);
            const endBucket   = Math.floor(visEndTick   / this._bucketTicks);
            for (let b = startBucket; b <= endBucket; b++) {
                const bucket = this._buckets.get(b);
                if (!bucket) continue;
                for (const idx of bucket) {
                    if (seen.has(idx)) continue;
                    seen.add(idx);
                    const n = this._sequence[idx];
                    if (!n) continue;
                    // Visibility filter
                    if (n.n < minNote || n.n > maxNote) continue;
                    const t0 = n.t;
                    const t1 = n.t + (n.g || 0);
                    if (t1 < visStartTick || t0 > visEndTick) continue;

                    const x  = this._tickToX(t0);
                    const x2 = this._tickToX(t1);
                    const y  = this._noteToY(n.n);
                    const w  = Math.max(2, x2 - x);
                    const h  = Math.max(2, noteH - 1);

                    const selected = n.f === 1;
                    const ch = n.c ?? 0;
                    const color = selected
                        ? this._theme.colnotesel
                        : (this._channelColors[ch % 16] || this._theme.colnote);

                    // Alpha based on velocity if present (0..127)
                    const vel = n.v ?? 100;
                    ctx.globalAlpha = 0.45 + (Math.min(127, Math.max(0, vel)) / 127) * 0.55;

                    ctx.fillStyle = color;
                    ctx.fillRect(x, y, w, h);
                    ctx.strokeStyle = this._theme.colnoteborder;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                }
            }
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
            for (let i = 0; i < this._sequence.length; i++) {
                const n = this._sequence[i];
                if (!n) continue;
                const t0 = n.t;
                const t1 = n.t + (n.g || 0);
                const b0 = Math.floor(t0 / B);
                const b1 = Math.floor(t1 / B);
                for (let b = b0; b <= b1; b++) {
                    let set = this._buckets.get(b);
                    if (!set) { set = new Set(); this._buckets.set(b, set); }
                    set.add(i);
                }
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
                const newY = Math.max(0, Math.min(128 - this._yrange,
                    Math.round(ratio * 128 - this._yrange / 2)));
                if (newY !== this._yoffset) {
                    this._yoffset = newY;
                    this._bgDirty = true;
                    this._emit('viewportchange', {
                        xoffset: this._xoffset, yoffset: this._yoffset,
                        xrange: this._xrange, yrange: this._yrange
                    });
                    this._scheduleRender();
                }
                this._dragging = { mode: 'scrollbar' };
                return;
            }

            // Clicked on the keyboard column → emit pianokey
            if (x < KB_WIDTH && y > RULER_H) {
                const note = this._yToNote(y);
                if (note >= NOTE_MIN && note <= NOTE_MAX) {
                    this._emit('pianokey', { note });
                    this._dragging = { mode: 'pianokey', note };
                }
                return;
            }
            // Clicked on the ruler → seek cursor (UX courtesy)
            if (y < RULER_H && x >= KB_WIDTH) {
                const tick = this._xToTick(x);
                this.setCursor(tick);
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
                    startX: x, startY: y,
                    startXOffset: this._xoffset,
                    startYOffset: this._yoffset
                };
                this._el.style.cursor = 'grabbing';
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
                const newY = Math.max(0, Math.min(128 - this._yrange,
                    Math.round(ratio * 128 - this._yrange / 2)));
                if (newY !== this._yoffset) {
                    this._yoffset = newY;
                    this._bgDirty = true;
                    this._emit('viewportchange', {
                        xoffset: this._xoffset, yoffset: this._yoffset,
                        xrange: this._xrange, yrange: this._yrange
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
                const newYOff = Math.max(0, Math.min(NOTE_MAX - this._yrange,
                    Math.round(d.startYOffset + dy * notePerPx)));
                if (newXOff !== this._xoffset) {
                    this._xoffset = newXOff;
                    this._bgDirty = true;
                    this._emit('viewportchange', { xoffset: this._xoffset, yoffset: this._yoffset, xrange: this._xrange });
                }
                if (newYOff !== this._yoffset) {
                    this._yoffset = newYOff;
                    this._bgDirty = true;
                    this._emit('viewportchange', { xoffset: this._xoffset, yoffset: this._yoffset, xrange: this._xrange });
                }
                this._scheduleRender();
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
                    this._bucketsDirty = true;
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
                        this._bucketsDirty = true;
                        this._scheduleRender();
                    }
                }
            }
        }

        _onMouseUp(e) {
            if (!this._dragging) return;
            const d = this._dragging;
            if (d.mode === 'move' || d.mode === 'resize') {
                // The mutation already happened in mousemove. Finalize with a
                // single `change` emit (debouncing per-frame events would cost
                // more than this one-shot at end of drag).
                this._emit('change');
                this._dragging = null;
                if (this._el) this._el.style.cursor = '';
                return;
            }
            if (d.mode === 'rect' && this._selectionRect) {
                // Convert the rect to tick/note bounds, mark intersecting notes f=1
                const r = this._selectionRect;
                const x1 = Math.min(r.x0, r.x), x2 = Math.max(r.x0, r.x);
                const y1 = Math.min(r.y0, r.y), y2 = Math.max(r.y0, r.y);
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
                        if (n.f !== 1) { n.f = 1; changed = true; }
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
                    this._yrange = newRange;
                    this._bgDirty = true;
                    this._emit('viewportchange', { xoffset: this._xoffset, yoffset: this._yoffset, xrange: this._xrange, yrange: this._yrange });
                    this._scheduleRender();
                }
                return;
            }
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const factor = e.deltaY > 0 ? 1.2 : 0.8;
                const newRange = Math.max(16, Math.min(100000, Math.round(this._xrange * factor)));
                if (newRange !== this._xrange) {
                    this._xrange = newRange;
                    this._bgDirty = true;
                    this._emit('viewportchange', { xoffset: this._xoffset, yoffset: this._yoffset, xrange: this._xrange });
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
                    this._emit('viewportchange', { xoffset: this._xoffset, yoffset: this._yoffset, xrange: this._xrange });
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
                    this._bgDirty = true;
                    this._emit('viewportchange', { xoffset: this._xoffset, yoffset: this._yoffset, xrange: this._xrange });
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
            if (x < KB_WIDTH || y < RULER_H) return null;
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
                    const isResizeHandle = (noteEndX - x) <= RESIZE_HANDLE_PX
                                        && (n.g || 0) >= tol * 2;
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

        _onDblClick(e) {
            if (!this._el) return;
            const { x, y } = this._localCoords(e);
            // Only create inside the notes area (not on keyboard, not on ruler)
            if (x < KB_WIDTH || y < RULER_H) return;
            // If clicking on an existing note, deletion would be intuitive
            // but `<webaudio-pianoroll>` doesn't do that — keep parity and
            // ignore dblclick on hit.
            if (this._hitTestNote(x, y)) return;
            const tickRaw = this._xToTick(x);
            const note = this._yToNote(y);
            if (note < NOTE_MIN || note > NOTE_MAX) return;
            const t = Math.max(0, this._snapTicks(tickRaw));
            const gate = Math.max(MIN_NOTE_GATE,
                Math.round((this._snap || this._grid || 120) * DEFAULT_NEW_NOTE_GATE_RATIO));
            this.saveSnapshot();
            const newNote = { t, g: gate, n: note, c: this._defaultChannel, v: 100, f: 1 };
            this.deselectAll();
            this._sequence.push(newNote);
            this._bucketsDirty = true;
            this._scheduleRender();
            this._emit('change');
            this._emit('selectionchange');
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
            } else if (ctrl && (e.key === 'z' || (e.shiftKey && (e.key === 'Z' || e.key === 'z')))) {
                e.preventDefault();
                if (e.shiftKey) this.redo();
                else            this.undo();
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

            // Selection rectangle (active drag)
            if (this._selectionRect) {
                const r = this._selectionRect;
                const x1 = Math.min(r.x0, r.x), y1 = Math.min(r.y0, r.y);
                const x2 = Math.max(r.x0, r.x), y2 = Math.max(r.y0, r.y);
                ctx.fillStyle = 'rgba(94, 142, 255, 0.15)';
                ctx.strokeStyle = '#5e8eff';
                ctx.lineWidth = 1;
                ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
            }

            // Vertical scroll indicator on the LEFT edge of the canvas
            // (left of the keyboard column). Spans full height (y=0..H) so
            // it visually frames the keyboard from the top-left corner. The
            // thumb shows which slice of the 128 MIDI notes is currently
            // visible; viewport = [yoffset, yoffset+yrange].
            //
            // Scroll: shift+wheel, click in track to jump, drag thumb.
            // Zoom : ctrl/cmd+shift+wheel.
            const sbY0 = 0;
            const sbH = H;
            // Track background.
            ctx.fillStyle = 'rgba(0,0,0,0.10)';
            ctx.fillRect(0, sbY0, SB_W, sbH);

            // Octave divisions in the background — light separators every
            // 12 semitones so the user reads which pitch range the thumb
            // covers. C0 (MIDI 12) through C9 (MIDI 120). Skipping C-1
            // because it's just 1 row at the top.
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let oct = 1; oct <= 10; oct++) {
                const midi = oct * 12;
                if (midi >= 128) break;
                const y = sbY0 + sbH * (midi / 128);
                ctx.moveTo(0, y + 0.5);
                ctx.lineTo(SB_W, y + 0.5);
            }
            ctx.stroke();

            // Octave labels — tiny, only when there's room.
            if (sbH / 10 >= 10) {
                ctx.fillStyle = 'rgba(0,0,0,0.55)';
                ctx.font = '8px monospace';
                ctx.textBaseline = 'top';
                for (let oct = 1; oct <= 9; oct++) {
                    const midi = oct * 12;
                    const y = sbY0 + sbH * (midi / 128);
                    ctx.fillText(`C${oct - 1}`, 1, y + 1);
                }
            }

            // Thumb — shows current viewport slice.
            const thumbY = sbY0 + sbH * (this._yoffset / 128);
            const thumbH = Math.max(20, sbH * (this._yrange / 128));
            ctx.fillStyle = 'rgba(94, 142, 255, 0.55)';
            ctx.fillRect(1, thumbY, SB_W - 2, thumbH);
            ctx.strokeStyle = 'rgba(94, 142, 255, 0.85)';
            ctx.lineWidth = 1;
            ctx.strokeRect(1.5, thumbY + 0.5, SB_W - 3, thumbH - 1);
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
