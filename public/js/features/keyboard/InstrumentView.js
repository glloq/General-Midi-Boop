// =============================================================================
// InstrumentView.js — Abstract base class for keyboard modal views.
// =============================================================================
// Each visual mode (piano, fretboard, drumpad, piano-slider, list, …) is
// expected to extend InstrumentView and implement at least mount()/unmount().
//
// The KeyboardModalController instantiates exactly one InstrumentView at a
// time and delegates view-specific behaviour to it. Adding a new view to the
// modal is a matter of:
//   1. Creating a class extending InstrumentView
//   2. Registering it on InstrumentViewRegistry
//   3. Adding a detection rule mapping `capabilities` → viewKind
//
// No DOM is allowed in this base class.
// =============================================================================
(function () {
  'use strict';

  /**
   * @typedef {Object} ViewContext
   * @property {HTMLElement} host        DOM element reserved for this view
   * @property {Object}      state       Shared keyboard state (read/write)
   * @property {Object}      backend     BackendAPIClient (for sendCommand)
   * @property {Object}      eventBus    Global EventBus
   * @property {{ t: (k: string, p?: Object) => string }} i18n
   * @property {Object}      capabilities Resolved instrument capabilities
   * @property {Object}      options     Per-view options from detector
   */

  class InstrumentView {
    /** Stable identifier consumed by InstrumentViewRegistry. */
    static viewKind = 'abstract';

    /**
     * SVG icon (adapted instrument illustration) shown on the
     * view-toggle button. Subclasses point this at an asset under
     * /assets/instruments/. `null` ⇒ no SVG, the emoji is used.
     */
    static iconUrl = null;

    /** Emoji fallback used when the SVG asset is missing/404s. */
    static emoji = '❔';

    /** i18n key for the view's display name. */
    static labelKey = 'keyboard.view';

    constructor() {
      /** @type {ViewContext|null} */
      this.ctx = null;
      this._mounted = false;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * Attach the view to its DOM host. Subclasses must call super.mount(ctx)
     * first to wire up `this.ctx` and `this._mounted`.
     * @param {ViewContext} ctx
     */
    mount(ctx) {
      if (this._mounted) {
        throw new Error(`${this.constructor.name}: mount() called twice`);
      }
      this.ctx = ctx;
      this._mounted = true;
    }

    /** Detach DOM + listeners. Idempotent. */
    unmount() {
      this._mounted = false;
      this.ctx = null;
    }

    get mounted() {
      return this._mounted;
    }

    /**
     * Rebuild the view in place (same ctx). Used when something the
     * DOM depends on changed globally — e.g. the note-label format
     * (US / FR / MIDI) toggled while this view is active, so every
     * note label must be regenerated. Generic: unmount + mount.
     */
    rerender() {
      if (!this._mounted || !this.ctx) return;
      const ctx = this.ctx;
      this.unmount();
      this.mount(ctx);
    }

    // ── Hooks (default no-op; subclasses override when relevant) ──────────

    /** Called when the active capabilities object changes mid-view. */
    setCapabilities(_caps) {
      /* no-op */
    }

    /** Called when the visible MIDI range changes (piano family). */
    setNoteRange(_startNote, _noteCount) {
      /* no-op */
    }

    /**
     * Pre-play hook. Allows the view to transform velocity (e.g. wind
     * articulation) or cancel a note. Return `false` to cancel.
     * @param {number} midi
     * @param {number} velocity
     * @param {Object} opts
     * @returns {{midi: number, velocity: number, opts: Object} | false}
     */
    willPlayNote(midi, velocity, opts) {
      return { midi, velocity, opts };
    }

    /**
     * Post-play hook. Called by KeyboardModal.playNote() right after the
     * note-on has been dispatched. Lets a view schedule follow-up
     * behaviour (e.g. wind staccato auto note-off). Default: no-op.
     * @param {number} _midi
     */
    afterPlayNote(_midi) {
      /* no-op */
    }

    /**
     * Translate `key`, returning `fallback` when no translation exists
     * (the i18n layer echoes the key back on a miss). Shared by every
     * view so user-facing strings stay localisable + consistent.
     * @param {string} key
     * @param {string} fallback
     * @returns {string}
     */
    _t(key, fallback) {
      const fn = this.ctx && this.ctx.i18n && this.ctx.i18n.t;
      const v = fn ? fn(key) : null;
      return v && v !== key ? v : fallback;
    }

    // ── Glissando (shared, piano-like drag) ───────────────────────────────
    // The piano lets you press a key and slide across the keyboard:
    // each newly entered key sounds and the previous one is released
    // (monophonic per gesture), with full hit-testing on every pointer
    // sample so fast drags never skip a note. This helper brings the
    // exact same feel to the self-owned discrete views (harmonica,
    // mallet, kalimba, bagpipe chanter, steel-drum, perc-pad) without
    // each re-implementing — and getting — drag tracking subtly wrong.
    //
    // The view supplies: a root element, a CSS `selector` for its
    // playable cells, `_pressCell(cell)` to start a cell's note(s) and
    // `_releaseAll()` to stop everything it is currently sounding.
    // Resolution mirrors the piano + HarpView: use elementFromPoint
    // during a real drag (implicit pointer capture keeps e.target on
    // the original element), fall back to e.target for synthetic events.
    _initGlide(opts) {
      const root = opts && opts.root;
      if (!root) return;
      this._glideRoot = root;
      this._glideSelector = opts.selector;
      this._glideActive = false;
      this._glideKeyVal = null;

      this._glideDown = (e) => {
        const cell = this._glideResolve(e);
        if (!cell) return;
        if (e.cancelable) e.preventDefault();
        if (e.pointerId != null && typeof root.setPointerCapture === 'function') {
          try {
            root.setPointerCapture(e.pointerId);
          } catch (_) {
            /* ignore */
          }
        }
        this._glideActive = true;
        this._glideKeyVal = this._glideKey(cell);
        this._pressCell(cell);
      };
      this._glideMove = (e) => {
        if (!this._glideActive) return;
        const cell = this._glideResolve(e);
        if (!cell) return;
        const k = this._glideKey(cell);
        if (k === this._glideKeyVal) return; // same cell → no transition
        if (e.cancelable) e.preventDefault();
        this._releaseAll(); // piano-like: drop the previous
        this._glideKeyVal = k;
        this._pressCell(cell);
      };
      this._glideUp = () => {
        this._glideActive = false;
        this._glideKeyVal = null;
        this._releaseAll();
      };
      root.addEventListener('pointerdown', this._glideDown);
      root.addEventListener('pointermove', this._glideMove);
      document.addEventListener('pointerup', this._glideUp);
      document.addEventListener('pointercancel', this._glideUp);
    }

    /** Remove the glissando listeners. Idempotent. */
    _teardownGlide() {
      const root = this._glideRoot;
      if (root && this._glideDown) {
        root.removeEventListener('pointerdown', this._glideDown);
        root.removeEventListener('pointermove', this._glideMove);
      }
      if (this._glideUp) {
        document.removeEventListener('pointerup', this._glideUp);
        document.removeEventListener('pointercancel', this._glideUp);
      }
      this._glideRoot = null;
      this._glideDown = this._glideMove = this._glideUp = null;
      this._glideActive = false;
      this._glideKeyVal = null;
    }

    /**
     * Resolve the playable cell under the pointer. Prefers a real
     * hit-test (elementFromPoint) so a fast drag never skips a cell;
     * falls back to e.target so synthetic events (and clicks) still
     * work. Returns null when the point is not on a cell of this view.
     */
    _glideResolve(e) {
      const root = this._glideRoot;
      let el = null;
      if (
        typeof document !== 'undefined' &&
        typeof document.elementFromPoint === 'function' &&
        Number.isFinite(e.clientX) &&
        Number.isFinite(e.clientY)
      ) {
        el = document.elementFromPoint(e.clientX, e.clientY);
      }
      if (!el && e.target) el = e.target;
      const cell = el && el.closest ? el.closest(this._glideSelector) : null;
      return cell && root && root.contains(cell) ? cell : null;
    }

    // ── Discrete-cell view scaffold (shared by the self-owned pluck
    // views: mallet, kalimba, steel-drum, perc-pad, music-box, harp,
    // bagpipe chanter). They all build their own DOM then play one or
    // more MIDI notes per cell with the exact same lifecycle:
    // press = dedupe + .active + playNote; a piano-like glissando drops
    // the previous cell; a global pointerup releases everything; unmount
    // tears it all down; setActiveNotes() reflects local + external
    // highlight. This helper owns that whole contract so each view only
    // describes its cells (one selector, how to read the note key/notes)
    // plus optional per-cell visual side effects. ───────────────────────
    //
    // opts:
    //   root       built container element
    //   selector   CSS selector for the playable cells
    //   keyOf      (cell) => stable id for the press map (default
    //              cell.dataset.note); also used as the glissando key
    //   notesOf    (cell) => number | number[] of MIDI notes to play
    //              (default parseInt(cell.dataset.note))
    //   onCellOn   (cell) => void  extra visual when a cell starts
    //   onCellOff  (cell) => void  extra visual when a cell stops
    _initCellView(opts) {
      const root = opts && opts.root;
      if (!root) return;
      this._cv = {
        selector: opts.selector,
        keyOf: opts.keyOf || ((c) => c.dataset.note),
        notesOf: opts.notesOf || ((c) => parseInt(c.dataset.note, 10)),
        onCellOn: opts.onCellOn || null,
        onCellOff: opts.onCellOff || null
      };
      this._root = root;
      this._pressed = new Map(); // key -> { cell, notes:number[] }
      this._initGlide({ root, selector: opts.selector });
    }

    _glideKey(cell) {
      return this._cv ? this._cv.keyOf(cell) : cell;
    }

    _pressCell(cell) {
      const cv = this._cv;
      if (!cv) return;
      const key = cv.keyOf(cell);
      if (this._pressed.has(key)) return;
      const raw = cv.notesOf(cell);
      const notes = (Array.isArray(raw) ? raw : [raw]).filter(Number.isFinite);
      if (notes.length === 0) return;
      this._pressed.set(key, { cell, notes });
      cell.classList.add('active');
      if (cv.onCellOn) cv.onCellOn(cell);
      const modal = this.ctx && this.ctx.modal;
      if (modal && typeof modal.playNote === 'function') {
        notes.forEach((n) => modal.playNote(n));
      }
    }

    _releaseAll() {
      if (!this._pressed || this._pressed.size === 0) return;
      const cv = this._cv;
      const modal = this.ctx && this.ctx.modal;
      for (const [key, { cell, notes }] of [...this._pressed]) {
        this._pressed.delete(key);
        if (cell) {
          cell.classList.remove('active');
          if (cv && cv.onCellOff) cv.onCellOff(cell);
        }
        if (modal && typeof modal.stopNote === 'function') {
          notes.forEach((n) => modal.stopNote(n));
        }
      }
    }

    /**
     * Reflect the highlight: every cell is lit when it is locally held
     * or any of its notes is in the external active set. `_cv.onCellOn/
     * Off` keep the same extra visual the press path applies.
     */
    _cellViewSetActiveNotes(activeMidiSet) {
      const cv = this._cv;
      if (!this._root || !cv) return;
      const set = activeMidiSet instanceof Set ? activeMidiSet : new Set();
      this._root.querySelectorAll(cv.selector).forEach((cell) => {
        const key = cv.keyOf(cell);
        const raw = cv.notesOf(cell);
        const notes = Array.isArray(raw) ? raw : [raw];
        const on = (this._pressed && this._pressed.has(key)) || notes.some((n) => set.has(n));
        cell.classList.toggle('active', on);
        if (on && cv.onCellOn) cv.onCellOn(cell);
        else if (!on && cv.onCellOff) cv.onCellOff(cell);
      });
    }

    /**
     * Discrete-cell teardown: release sounding notes, drop the glide
     * listeners and remove the container. Does NOT touch the base
     * mounted/ctx state — the view's unmount() calls this then
     * super.unmount() (so a subclass with extra state cleans that up
     * in between).
     */
    _cellViewUnmount() {
      this._releaseAll();
      this._teardownGlide();
      if (this._root) {
        this._root.remove();
        this._root = null;
      }
      this._pressed = null;
      this._cv = null;
    }

    setActiveNotes(activeMidiSet) {
      if (this._cv) this._cellViewSetActiveNotes(activeMidiSet);
    }
  }

  if (typeof window !== 'undefined') window.InstrumentView = InstrumentView;
  if (typeof module !== 'undefined') module.exports = InstrumentView;
})();
