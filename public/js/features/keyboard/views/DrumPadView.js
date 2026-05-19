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
    static iconUrl = '/assets/instruments/family_drum_kits.svg';
    static emoji = '🥁';
    static labelKey = 'keyboard.viewDrumPad';

    mount(ctx) {
      super.mount(ctx);
      const modal = ctx.modal;
      if (modal && typeof modal.renderDrumPad === 'function') {
        modal.renderDrumPad();
      }
    }

    // No unmount override: each pad listens via event delegation at
    // render time and the container is hidden by the controller, so
    // there's no persistent interaction state — the base unmount()
    // suffices.

    setCapabilities(_caps) {
      const modal = this.ctx && this.ctx.modal;
      if (modal && typeof modal.renderDrumPad === 'function') {
        modal.renderDrumPad();
      }
    }
  }

  if (typeof window !== 'undefined') window.DrumPadView = DrumPadView;
  if (typeof module !== 'undefined') module.exports = DrumPadView;
})();
