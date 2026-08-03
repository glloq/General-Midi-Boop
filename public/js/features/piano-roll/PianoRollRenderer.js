/**
 * @file public/js/features/piano-roll/PianoRollRenderer.js
 *
 * Audit §1.1 — Piano roll rendering abstraction.
 *
 * Exports `PianoRollRenderer` (abstract): the contract every renderer
 * implementation honours. Defines the viewport, sequence, selection,
 * history, theme and event surface that the MIDI / loop editor consumers
 * need. Methods throw / are no-ops by default so subclasses only override
 * what they care about.
 *
 * The sole concrete implementation is `CanvasPianoRollRenderer` (Canvas
 * 2D). The legacy `WebaudioPianorollAdapter` and the third-party
 * `<webaudio-pianoroll>` element it wrapped were removed once the Canvas
 * renderer became the only renderer.
 *
 * The invariant `modal.pianoRoll === modal.pianoRollRenderer.getElement()`
 * is maintained so non-migrated call sites (still accessing
 * `modal.pianoRoll.X`) keep working unchanged.
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
        width: opts.width ?? 0,
        height: opts.height ?? 0,
        ppq: opts.ppq ?? 480,
        tempo: opts.tempo ?? 120,
        mode: opts.mode ?? 'dragpoly'
      };
      this._container = opts.container || null;
      this._mounted = false;
    }

    // ----------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------

    mount() {
      throw new Error('PianoRollRenderer.mount() must be overridden');
    }
    destroy() {
      this._mounted = false;
    }
    getElement() {
      return null;
    }
    isMounted() {
      return this._mounted;
    }

    // ----------------------------------------------------------------
    // Viewport
    // ----------------------------------------------------------------

    setSize(/* w, h */) {
      return this;
    }
    setXRange(/* ticks */) {
      return this;
    }
    getXRange() {
      return 0;
    }
    setYRange(/* notes */) {
      return this;
    }
    getYRange() {
      return 0;
    }
    setXOffset(/* ticks */) {
      return this;
    }
    getXOffset() {
      return 0;
    }
    setYOffset(/* note */) {
      return this;
    }
    getYOffset() {
      return 0;
    }
    setCursor(/* tick */) {
      return this;
    }
    getCursor() {
      return 0;
    }
    setMarkers(/* a, b */) {
      return this;
    }
    getMarkers() {
      return { start: 0, end: 0 };
    }

    // ----------------------------------------------------------------
    // Musical config
    // ----------------------------------------------------------------

    setTempo(/* bpm */) {
      return this;
    }
    getTempo() {
      return 120;
    }
    setTimebase(/* ppq */) {
      return this;
    }
    getTimebase() {
      return 480;
    }
    setGrid(/* ticks */) {
      return this;
    }
    setSnap(/* ticks */) {
      return this;
    }
    setEditMode(/* mode */) {
      return this;
    }
    setUIMode(/* mode */) {
      return this;
    }
    getUIMode() {
      return null;
    }
    /**
     * Pass-through for legacy webaudio-pianoroll attributes
     * (wheelzoom / xscroll / yscroll / xruler / colcursor / colnote …).
     * The Webaudio adapter forwards to the element's `setAttribute`;
     * the Canvas V2 renderer ignores attributes it doesn't implement,
     * because those features (wheel zoom, ruler) live in dedicated
     * code paths there. Chainable.
     */
    setAttribute(/* name, value */) {
      return this;
    }
    /**
     * Pass-through for legacy webaudio-pianoroll inner-element lookup
     * (#wac-cursor, #wac-markstart, #wac-markend). The Webaudio
     * adapter forwards to the element's `querySelector`; the Canvas
     * V2 renderer has no such inner elements to hide and returns
     * `null` so callers' `if (el) ...` branches skip cleanly.
     */
    querySelector(/* sel */) {
      return null;
    }

    // ----------------------------------------------------------------
    // Data
    // ----------------------------------------------------------------

    setSequence(/* notes */) {
      return this;
    }
    getSequence() {
      return [];
    }
    pushNote(/* note */) {
      return this;
    }
    clearSequence() {
      return this;
    }
    setChannelColors(/* map */) {
      return this;
    }
    setDefaultChannel(/* ch */) {
      return this;
    }
    getDefaultChannel() {
      return 0;
    }
    setChannelPlayableHighlights(/* map */) {
      return this;
    }

    // ----------------------------------------------------------------
    // Selection & edit
    // ----------------------------------------------------------------

    getSelectedNotes() {
      return [];
    }
    getSelectionCount() {
      return 0;
    }
    selectAll() {
      return this;
    }
    deselectAll() {
      return this;
    }
    copySelection() {
      return [];
    }
    pasteNotes(/* notes, offset */) {
      return this;
    }
    deleteSelection() {
      return this;
    }
    changeChannelSelection(/* ch */) {
      return this;
    }

    // ----------------------------------------------------------------
    // History
    // ----------------------------------------------------------------

    undo() {
      return false;
    }
    redo() {
      return false;
    }
    canUndo() {
      return false;
    }
    canRedo() {
      return false;
    }
    saveSnapshot() {
      return this;
    }
    clearHistory() {
      return this;
    }

    // ----------------------------------------------------------------
    // Rendering
    // ----------------------------------------------------------------

    redraw() {
      return this;
    }
    redrawMarker() {
      return this;
    }
    invalidateGridBuffer() {
      return this;
    }
    beginBatchUpdate() {
      return this;
    }
    endBatchUpdate() {
      return this;
    }

    // ----------------------------------------------------------------
    // Theme
    // ----------------------------------------------------------------

    /**
     * @param {Object<string,string>} colorsMap - keys like
     *   `collt`, `coldk`, `colgrid`, `colnote`, `colnotesel`, etc.
     */
    setThemeColors(/* colorsMap */) {
      return this;
    }

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------

    /**
     * Supported events: 'change', 'selectionchange', 'viewportchange',
     * 'notedragmove', 'pianokey', 'pianokeyup'. Subclasses route them
     * to whichever underlying mechanism they use.
     */
    on(/* event, handler */) {
      return this;
    }
    off(/* event, handler */) {
      return this;
    }
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------

  if (typeof window !== 'undefined') {
    window.PianoRollRenderer = PianoRollRenderer;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PianoRollRenderer };
  }
})();
