// =============================================================================
// DrumPadView.js — Drum kit grid (GM channel 9 / drum-type instruments).
// =============================================================================
// 16+ pads laid out as a grid, mapped to drum MIDI notes (typically 35-81).
// Each pad shows its drum SVG + name. No octave navigation, no minimap, no
// modulation wheel (drums don't respond to CC#1).
//
// Phase D delegation: mount() calls modal.renderDrumPad() (legacy mixin
// in KeyboardPiano.js).
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    class DrumPadView extends InstrumentView {
        static viewKind = 'drumpad';
        static emoji = '🥁';
        static labelKey = 'keyboard.viewDrumPad';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (modal && typeof modal.renderDrumPad === 'function') {
                modal.renderDrumPad();
            }
        }

        unmount() {
            // Drum pad has no persistent interaction state (each pad listens
            // via event delegation at render time, and the container is
            // hidden by the controller). Nothing to tear down.
            super.unmount();
        }

        setCapabilities(_caps) {
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.renderDrumPad === 'function') {
                modal.renderDrumPad();
            }
        }

        toolbarGroups() {
            // Drums: velocity + view-mode toggle (back to piano family).
            // No notation toggle (drum names instead of solfège), no list
            // view, no pitch bend, no modulation.
            return new Set(['velocity', 'view-mode']);
        }
    }

    if (typeof window !== 'undefined') window.DrumPadView = DrumPadView;
    if (typeof module !== 'undefined') module.exports = DrumPadView;
})();
