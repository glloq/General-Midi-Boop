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

        /** Emoji shown on the view-toggle button. Subclasses override. */
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

        get mounted() { return this._mounted; }

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
        setCapabilities(_caps) { /* no-op */ }

        /** Called when the visible MIDI range changes (piano family). */
        setNoteRange(_startNote, _noteCount) { /* no-op */ }

        /** External update of the active-notes highlight set. */
        setActiveNotes(_activeMidiSet) { /* no-op */ }

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
        afterPlayNote(_midi) { /* no-op */ }

        /**
         * Set of toolbar group ids that this view wants visible. The
         * controller hides/shows the corresponding `.control-group` elements
         * declaratively. Defaults cover the basic piano family.
         * @returns {Set<string>}
         */
        toolbarGroups() {
            return new Set(['notation', 'velocity']);
        }
    }

    if (typeof window !== 'undefined') window.InstrumentView = InstrumentView;
    if (typeof module !== 'undefined') module.exports = InstrumentView;
})();
