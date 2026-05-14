// =============================================================================
// FretboardView.js — String instrument view (guitar/bass/violin/cello/sitar…).
// =============================================================================
// Renders a horizontal fretboard with strings + frets + chord buttons.
// Bowed instruments (violin, viola, cello, contrabass, tremolo, pizzicato,
// fiddle) get a hold-to-bow bar instead of a strum bar; plucked instruments
// get a normal strum.
//
// Phase D delegation: mount() calls modal.renderFretboard() (legacy mixin
// in KeyboardPiano.js + KeyboardChords.js + KeyboardSlider.js). The View
// owns the identity + cleanup contract so the registry can wire it up
// cleanly, and gradually take over the rendering in later phases.
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    class FretboardView extends InstrumentView {
        static viewKind = 'fretboard';
        static emoji = '🎸';
        static labelKey = 'keyboard.viewFretboard';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            if (typeof modal.renderFretboard === 'function') {
                modal.renderFretboard();
            }
        }

        unmount() {
            const modal = this.ctx && this.ctx.modal;
            if (modal) {
                // String slide mode interaction handlers.
                if (typeof modal.destroyStringSliders === 'function') {
                    modal.destroyStringSliders();
                }
                // Bowed instruments hold a sustained bow; release it so
                // notes don't ring after the bar is gone.
                if (typeof modal._stopActiveBow === 'function') {
                    modal._stopActiveBow();
                }
            }
            super.unmount();
        }

        setCapabilities(_caps) {
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.renderFretboard === 'function') {
                modal.renderFretboard();
            }
        }

        toolbarGroups() {
            // Fretboard exposes pitch-bend (slide mode), chord controls,
            // notation + velocity. No piano-slider, no list-view.
            return new Set([
                'notation', 'velocity',
                'view-mode', 'slide-mode',
                'modulation', 'pitch-bend'
            ]);
        }
    }

    if (typeof window !== 'undefined') window.FretboardView = FretboardView;
    if (typeof module !== 'undefined') module.exports = FretboardView;
})();
