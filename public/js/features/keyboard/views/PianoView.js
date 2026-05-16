// =============================================================================
// PianoView.js — Standard piano keyboard (white + black DIVs).
// =============================================================================
// The canonical view used when the selected instrument is anything except
// a drum kit, a fretted/bowed string, or a wind instrument.
//
// Phase D (strangler fig): mount/unmount delegate to the legacy mixin
// methods (regeneratePianoKeys, _setupPianoDelegation, _cleanFingersCanvas)
// living on KeyboardModal.prototype. The View owns the *identity* of the
// piano view (viewKind / iconUrl / emoji / labelKey) so the registry
// is fully functional. New piano-specific features are expected to be
// added here rather than in KeyboardPiano.js — the mixin will gradually
// shrink as functionality migrates over (Phase E and beyond).
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    class PianoView extends InstrumentView {
        static viewKind = 'piano';
        static iconUrl = '/assets/instruments/acoustic_grand.svg';
        static emoji = '🎹';
        static labelKey = 'keyboard.viewPiano';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            // Reuse the legacy render pipeline (Phase D delegation).
            if (typeof modal.regeneratePianoKeys === 'function') {
                modal.regeneratePianoKeys();
            }
        }

        unmount() {
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal._cleanFingersCanvas === 'function') {
                // Hand-fingers overlay is shared with list view; controller
                // is responsible for tearing it down only when leaving both.
            }
            super.unmount();
        }

        setNoteRange(startNote, noteCount) {
            const modal = this.ctx && this.ctx.modal;
            if (!modal) return;
            modal.startNote = startNote;
            modal.visibleNoteCount = noteCount;
            if (typeof modal.regeneratePianoKeys === 'function') {
                modal.regeneratePianoKeys();
            }
        }

        setActiveNotes(_active) {
            // Active-note highlighting is currently driven by the legacy
            // mixin via direct DOM class toggling; no extra work needed
            // until Phase E owns the DOM directly.
        }
    }

    if (typeof window !== 'undefined') window.PianoView = PianoView;
    if (typeof module !== 'undefined') module.exports = PianoView;
})();
