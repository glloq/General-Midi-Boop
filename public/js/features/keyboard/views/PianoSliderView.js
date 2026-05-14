// =============================================================================
// PianoSliderView.js — Wind instrument "piano-slider" (GM 56-79).
// =============================================================================
// Equal-width keys (no white/black distinction) with continuous pitch bend
// on horizontal drag. Designed for monophonic wind instruments (brass,
// reeds, pipe). Pairs with the wind articulation panel + breath slider
// (CC#2). Velocity ↔ articulation factor is wired in willPlayNote().
//
// Phase D delegation: mount() calls modal.generatePianoSlider() and
// modal._showWindControls(preset). willPlayNote applies the same
// articulation logic as the legacy KeyboardWindMixin.playNote override —
// which is *the* reason the legacy code needs `_windOrigPlayNote` (KM-C4).
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    // Mirrors WIND_ARTICULATIONS in KeyboardWind.js — kept here so the
    // velocity transform is self-contained on the View.
    const ARTICULATION_FACTORS = {
        normal:   1.0,
        legato:   1.0,
        staccato: 0.9,
        accent:   1.2
    };

    class PianoSliderView extends InstrumentView {
        static viewKind = 'piano-slider';
        static emoji = '🎺';
        static labelKey = 'keyboard.viewPianoSlider';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            if (typeof modal.generatePianoSlider === 'function') {
                modal.generatePianoSlider();
            }
            const windPreset = ctx.options && ctx.options.windPreset;
            if (windPreset && typeof modal._showWindControls === 'function') {
                modal._showWindControls(windPreset);
            }
        }

        unmount() {
            const modal = this.ctx && this.ctx.modal;
            if (modal) {
                if (typeof modal._hideWindControls === 'function') {
                    modal._hideWindControls();
                }
                if (typeof modal._cancelStaccatoTimers === 'function') {
                    modal._cancelStaccatoTimers();
                }
            }
            super.unmount();
        }

        setCapabilities(_caps) {
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal.generatePianoSlider === 'function') {
                modal.generatePianoSlider();
            }
        }

        willPlayNote(midi, velocity, opts) {
            // Match KeyboardWindMixin.playNote: scale velocity by the
            // articulation factor and clamp to 1..127.
            const modal = this.ctx && this.ctx.modal;
            const art = (modal && modal.currentArticulation) || 'normal';
            const factor = ARTICULATION_FACTORS[art] != null
                ? ARTICULATION_FACTORS[art] : 1.0;
            const scaled = Math.max(1, Math.min(127, Math.round(velocity * factor)));
            return { midi, velocity: scaled, opts };
        }

        toolbarGroups() {
            return new Set([
                'notation', 'velocity',
                'view-mode', 'piano-slider',
                'modulation', 'pitch-bend',
                'wind-panel'
            ]);
        }
    }

    if (typeof window !== 'undefined') window.PianoSliderView = PianoSliderView;
    if (typeof module !== 'undefined') module.exports = PianoSliderView;
})();
