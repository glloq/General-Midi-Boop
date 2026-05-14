/**
 * @file public/js/features/piano-roll/PianoRollRenderer.js
 *
 * Audit §1.1 — Piano roll rendering abstraction.
 *
 * Two classes are exported:
 *
 *   - `PianoRollRenderer` (abstract) — the contract every renderer
 *     implementation honours. Defines viewport, sequence, selection,
 *     history, theme and event surface that the MIDI editor consumers
 *     need. Methods throw / are no-ops by default so subclasses only
 *     override what they care about.
 *
 *   - `WebaudioPianorollAdapter` — wraps the existing
 *     `<webaudio-pianoroll>` third-party custom element (see
 *     `public/lib/webaudio-pianoroll-custom.js`). ZERO functional
 *     change vs the legacy code path; this is pure indirection so
 *     consumers stop touching the element's attributes / properties
 *     directly. Step 1 of the §1.1 split.
 *
 * The invariant `modal.pianoRoll === modal.pianoRollRenderer.getElement()`
 * is maintained throughout Phase A so non-migrated call sites (still
 * accessing `modal.pianoRoll.X`) keep working unchanged.
 *
 * In Phase B a second implementation `CanvasPianoRollRenderer` will
 * extend this same contract, swappable via a flag in Phase C.
 */
(function () {
    'use strict';

    /**
     * Abstract piano-roll renderer. All methods are chainable when they
     * don't return a value, returning `this`. Setters silently no-op
     * when the renderer isn't mounted yet.
     */
    class PianoRollRenderer {
        /**
         * @param {Object} opts
         * @param {HTMLElement} opts.container - host element
         * @param {number}  [opts.width]
         * @param {number}  [opts.height]
         * @param {number}  [opts.ppq=480]
         * @param {number}  [opts.tempo=120]
         * @param {string}  [opts.mode='dragpoly']
         */
        constructor(opts = {}) {
            this._opts = {
                width:  opts.width  ?? 0,
                height: opts.height ?? 0,
                ppq:    opts.ppq    ?? 480,
                tempo:  opts.tempo  ?? 120,
                mode:   opts.mode   ?? 'dragpoly'
            };
            this._container = opts.container || null;
            this._mounted = false;
        }

        // ----------------------------------------------------------------
        // Lifecycle
        // ----------------------------------------------------------------

        mount()        { throw new Error('PianoRollRenderer.mount() must be overridden'); }
        destroy()      { this._mounted = false; }
        getElement()   { return null; }
        isMounted()    { return this._mounted; }

        // ----------------------------------------------------------------
        // Viewport
        // ----------------------------------------------------------------

        setSize(/* w, h */)     { return this; }
        setXRange(/* ticks */)  { return this; }
        getXRange()             { return 0; }
        setYRange(/* notes */)  { return this; }
        getYRange()             { return 0; }
        setXOffset(/* ticks */) { return this; }
        getXOffset()            { return 0; }
        setYOffset(/* note */)  { return this; }
        getYOffset()            { return 0; }
        setCursor(/* tick */)   { return this; }
        getCursor()             { return 0; }
        setMarkers(/* a, b */)  { return this; }
        getMarkers()            { return { start: 0, end: 0 }; }

        // ----------------------------------------------------------------
        // Musical config
        // ----------------------------------------------------------------

        setTempo(/* bpm */)     { return this; }
        setTimebase(/* ppq */)  { return this; }
        setGrid(/* ticks */)    { return this; }
        setSnap(/* ticks */)    { return this; }
        setEditMode(/* mode */) { return this; }
        setUIMode(/* mode */)   { return this; }
        getUIMode()             { return null; }

        // ----------------------------------------------------------------
        // Data
        // ----------------------------------------------------------------

        setSequence(/* notes */)    { return this; }
        getSequence()                { return []; }
        pushNote(/* note */)         { return this; }
        clearSequence()              { return this; }
        setChannelColors(/* map */)  { return this; }
        setDefaultChannel(/* ch */)  { return this; }
        setChannelPlayableHighlights(/* map */) { return this; }

        // ----------------------------------------------------------------
        // Selection & edit
        // ----------------------------------------------------------------

        getSelectedNotes()      { return []; }
        getSelectionCount()     { return 0; }
        selectAll()             { return this; }
        deselectAll()           { return this; }
        copySelection()         { return []; }
        pasteNotes(/* notes, offset */) { return this; }
        deleteSelection()       { return this; }
        changeChannelSelection(/* ch */) { return this; }

        // ----------------------------------------------------------------
        // History
        // ----------------------------------------------------------------

        undo()        { return false; }
        redo()        { return false; }
        canUndo()     { return false; }
        canRedo()     { return false; }
        saveSnapshot(){ return this; }
        clearHistory(){ return this; }

        // ----------------------------------------------------------------
        // Rendering
        // ----------------------------------------------------------------

        redraw()              { return this; }
        redrawMarker()        { return this; }
        invalidateGridBuffer(){ return this; }
        beginBatchUpdate()    { return this; }
        endBatchUpdate()      { return this; }

        // ----------------------------------------------------------------
        // Theme
        // ----------------------------------------------------------------

        /**
         * @param {Object<string,string>} colorsMap - keys like
         *   `collt`, `coldk`, `colgrid`, `colnote`, `colnotesel`, etc.
         */
        setThemeColors(/* colorsMap */) { return this; }

        // ----------------------------------------------------------------
        // Events
        // ----------------------------------------------------------------

        /**
         * Supported events: 'change', 'selectionchange', 'viewportchange',
         * 'notedragmove', 'pianokey', 'pianokeyup'. Subclasses route them
         * to whichever underlying mechanism they use.
         */
        on(/* event, handler */)  { return this; }
        off(/* event, handler */) { return this; }
    }


    /**
     * Adapter wrapping the third-party `<webaudio-pianoroll>` element.
     * Reproduces the exact mount sequence and property write order that
     * was previously inline in `MidiEditorRouting.initPianoRoll()`.
     */
    class WebaudioPianorollAdapter extends PianoRollRenderer {
        constructor(opts = {}) {
            super(opts);
            /** @type {HTMLElement|null} */
            this._el = null;
            /** Bookkeeping for `on`/`off` so `destroy()` cleans up. */
            this._listeners = new Map(); // event -> Set<handler>
        }

        // ----------------------------------------------------------------
        // Lifecycle
        // ----------------------------------------------------------------

        /**
         * Create the `<webaudio-pianoroll>` element. **Initial HTML
         * attributes only** — JS property assignments (sequence, colors,
         * tempo, …) come AFTER `appendChild`, matching the legacy order.
         */
        mount() {
            if (this._mounted) return this;
            if (!this._container) throw new Error('WebaudioPianorollAdapter: container is required');
            if (typeof customElements === 'undefined'
                || !customElements.get('webaudio-pianoroll')) {
                throw new Error('WebaudioPianorollAdapter: <webaudio-pianoroll> is not registered');
            }
            const el = document.createElement('webaudio-pianoroll');
            el.setAttribute('width',  String(this._opts.width));
            el.setAttribute('height', String(this._opts.height));
            el.setAttribute('editmode', this._opts.mode);
            this._el = el;
            this._mounted = true;
            return this;
        }

        attachToContainer() {
            if (!this._el || !this._container) return this;
            this._container.appendChild(this._el);
            return this;
        }

        destroy() {
            if (this._el) {
                // Detach all listeners we tracked.
                for (const [event, set] of this._listeners) {
                    for (const handler of set) this._el.removeEventListener(event, handler);
                }
                this._listeners.clear();
                this._el.parentNode?.removeChild(this._el);
            }
            this._el = null;
            super.destroy();
            return this;
        }

        getElement() { return this._el; }

        // ----------------------------------------------------------------
        // Viewport
        // ----------------------------------------------------------------

        setSize(w, h) {
            if (!this._el) return this;
            this._el.setAttribute('width',  String(w));
            this._el.setAttribute('height', String(h));
            return this;
        }
        setXRange(ticks) {
            if (!this._el) return this;
            this._el.setAttribute('xrange', String(ticks));
            this._el.xrange = ticks;
            return this;
        }
        getXRange() {
            return this._el ? (this._el.xrange ?? parseInt(this._el.getAttribute('xrange')) ?? 0) : 0;
        }
        setYRange(notes) {
            if (!this._el) return this;
            this._el.setAttribute('yrange', String(notes));
            this._el.yrange = notes;
            return this;
        }
        getYRange() {
            return this._el ? (this._el.yrange ?? parseInt(this._el.getAttribute('yrange')) ?? 0) : 0;
        }
        setXOffset(ticks) {
            if (!this._el) return this;
            this._el.xoffset = ticks;
            this._el.setAttribute('xoffset', String(ticks));
            return this;
        }
        getXOffset() {
            return this._el ? (this._el.xoffset ?? parseInt(this._el.getAttribute('xoffset')) ?? 0) : 0;
        }
        setYOffset(note) {
            if (!this._el) return this;
            this._el.setAttribute('yoffset', String(note));
            this._el.yoffset = note;
            return this;
        }
        getYOffset() {
            return this._el ? (this._el.yoffset ?? parseInt(this._el.getAttribute('yoffset')) ?? 0) : 0;
        }
        setCursor(tick) {
            if (!this._el) return this;
            this._el.cursor = tick;
            return this;
        }
        getCursor() {
            return this._el ? (this._el.cursor ?? 0) : 0;
        }
        setMarkers(start, end) {
            if (!this._el) return this;
            this._el.setAttribute('markstart', String(start));
            this._el.setAttribute('markend',   String(end));
            return this;
        }
        getMarkers() {
            if (!this._el) return { start: 0, end: 0 };
            return {
                start: this._el.markstart ?? parseInt(this._el.getAttribute('markstart')) ?? 0,
                end:   this._el.markend   ?? parseInt(this._el.getAttribute('markend'))   ?? 0
            };
        }

        // ----------------------------------------------------------------
        // Musical config
        // ----------------------------------------------------------------

        setTempo(bpm)     { if (this._el) this._el.tempo    = bpm;   return this; }
        setTimebase(ppq)  { if (this._el) this._el.timebase = ppq;   return this; }
        setGrid(ticks)    { if (this._el) this._el.grid     = ticks; return this; }
        setSnap(ticks)    { if (this._el) this._el.snap     = ticks; return this; }
        setEditMode(mode) {
            if (this._el) this._el.setAttribute('editmode', mode);
            return this;
        }
        setUIMode(mode) {
            if (this._el?.setUIMode) this._el.setUIMode(mode);
            return this;
        }
        getUIMode() {
            return this._el?.getUIMode ? this._el.getUIMode() : null;
        }

        // ----------------------------------------------------------------
        // Data
        // ----------------------------------------------------------------

        setSequence(notes) {
            if (this._el) this._el.sequence = notes || [];
            return this;
        }
        getSequence() {
            return this._el?.sequence || [];
        }
        pushNote(note) {
            if (this._el && Array.isArray(this._el.sequence)) this._el.sequence.push(note);
            return this;
        }
        clearSequence() {
            if (this._el && Array.isArray(this._el.sequence)) this._el.sequence.length = 0;
            return this;
        }
        setChannelColors(map) {
            if (this._el) this._el.channelColors = map;
            return this;
        }
        setDefaultChannel(ch) {
            if (this._el) this._el.defaultChannel = ch;
            return this;
        }
        setChannelPlayableHighlights(map) {
            if (!this._el) return this;
            this._el.channelPlayableHighlights = map;
            this._el._highlightsDirty = true;
            if (typeof this._el.invalidateGridBuffer === 'function') this._el.invalidateGridBuffer();
            return this;
        }

        // ----------------------------------------------------------------
        // Selection & edit
        // ----------------------------------------------------------------

        getSelectedNotes() {
            return this._el?.getSelectedNotes ? this._el.getSelectedNotes() : [];
        }
        getSelectionCount() {
            return this._el?.getSelectionCount ? this._el.getSelectionCount() : 0;
        }
        selectAll() {
            if (this._el?.selectAll) this._el.selectAll();
            return this;
        }
        deselectAll() {
            if (this._el?.deselectAll) this._el.deselectAll();
            return this;
        }
        copySelection() {
            return this._el?.copySelection ? this._el.copySelection() : [];
        }
        pasteNotes(notes, offsetTick) {
            if (this._el?.pasteNotes) this._el.pasteNotes(notes, offsetTick);
            return this;
        }
        deleteSelection() {
            if (this._el?.deleteSelection) this._el.deleteSelection();
            return this;
        }
        changeChannelSelection(ch) {
            if (this._el?.changeChannelSelection) this._el.changeChannelSelection(ch);
            return this;
        }

        // ----------------------------------------------------------------
        // History
        // ----------------------------------------------------------------

        undo()         { return this._el?.undo    ? !!this._el.undo()    : false; }
        redo()         { return this._el?.redo    ? !!this._el.redo()    : false; }
        canUndo()      { return this._el?.canUndo ? !!this._el.canUndo() : false; }
        canRedo()      { return this._el?.canRedo ? !!this._el.canRedo() : false; }
        saveSnapshot() { if (this._el?.saveSnapshot) this._el.saveSnapshot(); return this; }
        clearHistory() { if (this._el?.clearHistory) this._el.clearHistory(); return this; }

        // ----------------------------------------------------------------
        // Rendering
        // ----------------------------------------------------------------

        redraw() {
            if (this._el?.redraw) this._el.redraw();
            return this;
        }
        redrawMarker() {
            if (this._el?.redrawMarker) this._el.redrawMarker();
            return this;
        }
        invalidateGridBuffer() {
            if (this._el?.invalidateGridBuffer) this._el.invalidateGridBuffer();
            return this;
        }
        beginBatchUpdate() {
            if (this._el?.beginBatchUpdate) this._el.beginBatchUpdate();
            return this;
        }
        endBatchUpdate() {
            if (this._el?.endBatchUpdate) this._el.endBatchUpdate();
            return this;
        }

        // ----------------------------------------------------------------
        // Theme
        // ----------------------------------------------------------------

        setThemeColors(map) {
            if (!this._el || !map) return this;
            for (const key in map) {
                if (Object.prototype.hasOwnProperty.call(map, key)) {
                    this._el.setAttribute(key, map[key]);
                }
            }
            return this;
        }

        // ----------------------------------------------------------------
        // Events
        // ----------------------------------------------------------------

        on(event, handler) {
            if (!this._el || typeof handler !== 'function') return this;
            this._el.addEventListener(event, handler);
            let set = this._listeners.get(event);
            if (!set) { set = new Set(); this._listeners.set(event, set); }
            set.add(handler);
            return this;
        }
        off(event, handler) {
            if (!this._el) return this;
            this._el.removeEventListener(event, handler);
            this._listeners.get(event)?.delete(handler);
            return this;
        }

        // ----------------------------------------------------------------
        // Adapter-only convenience: direct attribute setter for things
        // that don't map cleanly to a contract method (xruler, wheelzoom,
        // xscroll, yscroll, bgsrc, kbsrc, …). Use sparingly — prefer
        // proper API methods.
        // ----------------------------------------------------------------

        setAttribute(name, value) {
            if (this._el) this._el.setAttribute(name, String(value));
            return this;
        }

        querySelector(sel) {
            return this._el?.querySelector ? this._el.querySelector(sel) : null;
        }
    }


    // ---------------------------------------------------------------------
    // Exports
    // ---------------------------------------------------------------------

    if (typeof window !== 'undefined') {
        window.PianoRollRenderer = PianoRollRenderer;
        window.WebaudioPianorollAdapter = WebaudioPianorollAdapter;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { PianoRollRenderer, WebaudioPianorollAdapter };
    }
})();
