// =============================================================================
// PercussionPadView.js — Trigger-pad grid for struck / one-shot GM programs.
// =============================================================================
// Non-melodic percussion and sound effects on a melodic channel (GM 112,
// 113, 115-119 and the GM 120-127 sound-effects block). A chromatic piano
// is the wrong metaphor for these: each MIDI note is just a different pitch
// of the same struck/one-shot sample, so we lay them out as a responsive
// grid of big tap targets (one pad = one MIDI note over the configured
// range). Strike on pointerdown, global pointerup release. Self-owned DOM.
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.InstrumentView) return;
  const InstrumentView = window.InstrumentView;

  const DEFAULT_LO = 60,
    DEFAULT_HI = 83; // C4..B5 fallback

  class PercussionPadView extends InstrumentView {
    static viewKind = 'perc-pad';
    static iconUrl = '/assets/instruments/family_chromatic_percussion.svg';
    static emoji = '🪘';
    static labelKey = 'keyboard.viewPercPad';

    mount(ctx) {
      super.mount(ctx);
      const modal = ctx.modal;
      if (!modal) return;
      const canvas = document.getElementById('keyboard-canvas-container');
      if (!canvas) return;
      document.getElementById('perc-pad-container')?.remove();

      // QA: follow the instrument's configured range, not a fixed span.
      const r =
        typeof modal.getInstrumentNoteRange === 'function' ? modal.getInstrumentNoteRange() : null;
      const lo = r ? r.min : DEFAULT_LO;
      const hi = r ? r.max : DEFAULT_HI;
      const count = Math.max(1, hi - lo + 1);

      const label =
        typeof modal.getNoteLabel === 'function' ? (n) => modal.getNoteLabel(n) : (n) => String(n);

      const root = document.createElement('div');
      root.id = 'perc-pad-container';
      root.className = 'perc-pad-view';
      // Responsive grid: pads auto-fit, square-ish, no overflow. Column
      // count grows with the range so the whole set always fits.
      const cols = Math.min(count, Math.max(4, Math.ceil(Math.sqrt(count) * 1.4)));
      root.style.cssText =
        'display:grid;width:100%;height:100%;box-sizing:border-box;' +
        'padding:12px;gap:8px;align-content:stretch;' +
        `grid-template-columns:repeat(${cols},1fr);` +
        'grid-auto-rows:1fr;touch-action:none;';

      for (let i = 0; i < count; i++) {
        const midi = lo + i;
        const pad = document.createElement('button');
        pad.type = 'button';
        pad.className = 'perc-pad';
        pad.dataset.note = String(midi);
        pad.title = label(midi);
        pad.textContent = label(midi);
        pad.style.cssText =
          'box-sizing:border-box;border:1px solid #2a2a2a;' +
          'border-radius:8px;cursor:pointer;font:11px sans-serif;' +
          'display:flex;align-items:center;justify-content:center;' +
          'min-height:40px;background:#4a5158;color:#f0f0f0;' +
          'user-select:none;';
        if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
          const c = modal.getNoteColor(midi);
          pad.style.background = c.bg;
          pad.style.color = c.text;
        }
        root.appendChild(pad);
      }
      canvas.appendChild(root);

      // Piano-like drag: slide across the pads for a glissando.
      this._initCellView({ root, selector: '.perc-pad' });
    }

    unmount() {
      this._cellViewUnmount();
      super.unmount();
    }
  }

  if (typeof window !== 'undefined') window.PercussionPadView = PercussionPadView;
  if (typeof module !== 'undefined') module.exports = PercussionPadView;
})();
