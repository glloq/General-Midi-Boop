// =============================================================================
// SteelDrumView.js — Steel pan / steel drum (GM 114).
// =============================================================================
// Notes laid out as sections around a circle (as on a real tenor pan).
// Two chromatic octaves C4..B5 positioned radially. Strike on
// pointerdown, global pointerup release. Self-owned DOM.
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.InstrumentView) return;
  const InstrumentView = window.InstrumentView;

  const LO = 60,
    HI = 83; // C4..B5 (24 sections)

  class SteelDrumView extends InstrumentView {
    static viewKind = 'steel-drum';
    static iconUrl = '/assets/instruments/steel_drums.svg';
    static emoji = '🛢️';
    static labelKey = 'keyboard.viewSteelDrum';

    mount(ctx) {
      super.mount(ctx);
      const modal = ctx.modal;
      if (!modal) return;
      const canvas = document.getElementById('keyboard-canvas-container');
      if (!canvas) return;
      document.getElementById('steel-drum-container')?.remove();

      const root = document.createElement('div');
      root.id = 'steel-drum-container';
      root.className = 'steel-drum-view';
      // Responsive pan: positions + pocket sizes are PERCENT-based so
      // the whole range always fits with no overlap and no manual zoom.
      // The metallic look (concave bowl, rolled rim, hammered texture)
      // lives in keyboard.css; JS owns only the polar geometry below.

      const label =
        typeof modal.getNoteLabel === 'function' ? (n) => modal.getNoteLabel(n) : (n) => String(n);
      // QA: follow the instrument's configured range, not a fixed span.
      const r =
        typeof modal.getInstrumentNoteRange === 'function' ? modal.getInstrumentNoteRange() : null;
      const lo = r ? r.min : LO;
      const hi = r ? r.max : HI;
      const n = Math.max(1, hi - lo + 1);

      // Ring radius = 38 % of the pan. The pocket diameter must not
      // exceed the centre-to-centre arc between two adjacent pockets
      // (2·R·sin(π/n)); clamp it to a sane on-screen range. Every
      // pocket is the same size.
      const Rpct = 38;
      const arcPct = 2 * Rpct * Math.sin(Math.PI / n);
      const tilePct = Math.max(5, Math.min(20, arcPct * 0.85));

      for (let i = 0; i < n; i++) {
        const midi = lo + i;
        const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
        const cx = 50 + Math.cos(ang) * Rpct;
        const cy = 50 + Math.sin(ang) * Rpct;
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'steel-section';
        s.dataset.note = String(midi);
        s.title = label(midi);
        // Only the computed polar placement is inline; the metallic
        // pocket look is in keyboard.css (.steel-section).
        s.style.cssText =
          `width:${tilePct.toFixed(2)}%;` + `left:${cx.toFixed(2)}%;top:${cy.toFixed(2)}%;`;
        const lbl = document.createElement('span');
        lbl.className = 'steel-section-label';
        lbl.textContent = label(midi);
        s.appendChild(lbl);
        if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
          const c = modal.getNoteColor(midi);
          s.style.background = c.bg;
          lbl.style.color = c.text;
        }
        root.appendChild(s);
      }
      canvas.appendChild(root);

      // Piano-like drag: slide across the sections for a glissando.
      this._initCellView({ root, selector: '.steel-section' });
    }

    unmount() {
      this._cellViewUnmount();
      super.unmount();
    }
  }

  if (typeof window !== 'undefined') window.SteelDrumView = SteelDrumView;
  if (typeof module !== 'undefined') module.exports = SteelDrumView;
})();
