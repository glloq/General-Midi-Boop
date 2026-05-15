// =============================================================================
// PianoSliderView.js — Wind instrument "piano-slider" (GM 56-79).
// =============================================================================
// Equal-width keys (no white/black distinction) with continuous pitch bend
// on horizontal drag. Designed for monophonic wind instruments (brass,
// reeds, pipe). Pairs with the wind articulation panel + breath slider
// (CC#2). Velocity ↔ articulation factor is wired in willPlayNote().
//
// Phase D delegation: mount() calls modal.generatePianoSlider() and
// modal._showWindControls(preset).
//
// KM-C4 done: this view fully owns the wind playing behaviour through the
// InstrumentView contract — willPlayNote() applies the articulation
// velocity factor and afterPlayNote() schedules the staccato auto note-off.
// KeyboardWindMixin no longer overrides playNote (no more _windOrigPlayNote).
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    // Articulation → velocity factor. `staccato` additionally arms an
    // auto note-off after STACCATO_MS (see afterPlayNote).
    const ARTICULATION_FACTORS = {
        normal:   1.0,
        legato:   1.0,
        staccato: 0.9,
        accent:   1.2
    };
    const STACCATO_MS = 120;

    class PianoSliderView extends InstrumentView {
        static viewKind = 'piano-slider';
        static emoji = '🎺';
        static labelKey = 'keyboard.viewPianoSlider';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            this._staccatoTimers = new Map(); // note -> timeout id
            if (typeof modal.generatePianoSlider === 'function') {
                modal.generatePianoSlider();
            }
            const windPreset = ctx.options && ctx.options.windPreset;
            if (windPreset && typeof modal._showWindControls === 'function') {
                modal._showWindControls(windPreset);
            }
        }

        unmount() {
            this._clearStaccatoTimers();
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

        _clearStaccatoTimers() {
            if (!this._staccatoTimers) return;
            for (const id of this._staccatoTimers.values()) clearTimeout(id);
            this._staccatoTimers.clear();
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

        afterPlayNote(note) {
            // Staccato: auto note-off after STACCATO_MS (replaces the old
            // KeyboardWindMixin.playNote staccato branch).
            const modal = this.ctx && this.ctx.modal;
            if (!modal || (modal.currentArticulation || 'normal') !== 'staccato') return;
            if (!this._staccatoTimers) this._staccatoTimers = new Map();
            const prev = this._staccatoTimers.get(note);
            if (prev) clearTimeout(prev);
            const id = setTimeout(() => {
                this._staccatoTimers && this._staccatoTimers.delete(note);
                if (modal.activeNotes && modal.activeNotes.has(note)
                    && typeof modal.stopNote === 'function') {
                    modal.stopNote(note);
                }
            }, STACCATO_MS);
            this._staccatoTimers.set(note, id);
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
