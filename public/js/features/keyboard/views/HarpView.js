// =============================================================================
// HarpView.js — Concert-harp view (GM 46): vertical strings + glissando.
// =============================================================================
// Second self-owned-DOM view (after HarmonicaView). 22 vertical strings,
// C-major diatonic from C3 (MIDI 48) up three octaves to C6 — matching the
// historical 22-string harp preset. Pluck a string with pointerdown;
// dragging horizontally across strings performs a glissando (each newly
// entered string is plucked). A single global pointerup releases every
// ringing string (same model as HarmonicaView / handleGlobalMouseUp).
//
// Traditional colour cue: C strings red, F strings dark — the reference
// landmarks a harpist uses.
//
// Detection: InstrumentDetector excludes GM 46 from the fretboard range
// and maps it to viewKind 'harp'; registerBuiltins adds a matching rule
// *before* the 24-47 fretboard rule. An explicit instrument_type='string'
// or a manual stringInstrumentConfig still forces the fretboard view.
// =============================================================================
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.InstrumentView) return;
  const InstrumentView = window.InstrumentView;

  // C-major diatonic. Default span C3 (48) → C6 (84) when the
  // instrument declares no range.
  const SCALE = new Set([0, 2, 4, 5, 7, 9, 11]);
  const DEFAULT_LO = 48,
    DEFAULT_HI = 84;

  // Diatonic (C-major) MIDI notes within [lo,hi] inclusive.
  function diatonicStrings(lo, hi) {
    const out = [];
    for (let n = lo; n <= hi; n++) if (SCALE.has(((n % 12) + 12) % 12)) out.push(n);
    return out.length ? out : [lo];
  }

  class HarpView extends InstrumentView {
    static viewKind = 'harp';
    static iconUrl = '/assets/instruments/harp.svg';
    static emoji = '🪕';
    static labelKey = 'keyboard.viewHarp';

    mount(ctx) {
      super.mount(ctx);
      const modal = ctx.modal;
      if (!modal) return;
      const canvas = document.getElementById('keyboard-canvas-container');
      if (!canvas) return;

      document.getElementById('harp-container')?.remove();

      const root = document.createElement('div');
      root.id = 'harp-container';
      root.className = 'harp-view';
      root.style.cssText =
        'display:flex;align-items:stretch;justify-content:center;' +
        'gap:4px;padding:18px;height:100%;touch-action:none;';

      const label =
        typeof modal.getNoteLabel === 'function' ? (n) => modal.getNoteLabel(n) : (n) => String(n);

      // Strings follow the note selection configured in the
      // instrument-settings modal. For a harp (GM 46) that modal
      // does NOT expose the guitar "strings/tuning" tab — the
      // playable notes come from the Notes section saved in
      // capabilities and surfaced via getInstrumentNoteRange():
      //   • discrete selection → render EXACTLY those MIDI notes
      //     (count matches what the user entered, accidentals kept);
      //   • continuous range  → diatonic strings across the range
      //     (a harp is a diatonic instrument — accidentals are
      //     pedal/lever changes, not separate strings).
      // The configured selection always wins over the 47-string
      // Harpe preset; that preset is only the last resort when no
      // range is available at all (e.g. no instrument selected).
      let STRINGS;
      const rng =
        typeof modal.getInstrumentNoteRange === 'function' ? modal.getInstrumentNoteRange() : null;
      if (rng && Array.isArray(rng.notes) && rng.notes.length) {
        STRINGS = rng.notes.slice();
      } else if (rng && Number.isFinite(rng.min) && Number.isFinite(rng.max)) {
        STRINGS = diatonicStrings(rng.min, rng.max);
      } else {
        const cfg = modal._harpStringConfig;
        STRINGS =
          cfg && Array.isArray(cfg.tuning) && cfg.tuning.length
            ? cfg.tuning.slice()
            : diatonicStrings(DEFAULT_LO, DEFAULT_HI);
      }

      STRINGS.forEach((midi, idx) => {
        const cls = midi % 12;
        const isC = cls === 0;
        const isF = cls === 5;
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'harp-string' + (isC ? ' harp-string-c' : isF ? ' harp-string-f' : '');
        s.dataset.idx = String(idx);
        s.dataset.note = String(midi);
        s.title = label(midi);
        s.style.cssText =
          'flex:1 1 0;min-width:16px;max-width:34px;height:100%;' +
          'display:flex;flex-direction:column;' +
          'justify-content:flex-end;align-items:center;padding:0;' +
          'border:none;border-radius:3px;cursor:pointer;' +
          'background:' +
          (isC ? '#c0392b' : isF ? '#2c3e50' : '#cfd6dc') +
          ';opacity:.85;transition:opacity .05s;';
        if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
          s.style.background = modal.getNoteColor(midi).bg;
        }
        // Visible note label in the header-selected format
        // (US / FR / MIDI via modal.getNoteLabel). Vertical text so
        // it stays legible on a narrow string. pointer-events:none
        // keeps elementFromPoint hit-testing on the string itself.
        const lbl = document.createElement('span');
        lbl.className = 'harp-string-label';
        lbl.textContent = label(midi);
        lbl.style.cssText =
          'pointer-events:none;user-select:none;white-space:nowrap;' +
          'font-size:10px;line-height:1;padding:4px 0;' +
          'color:' +
          (isC || isF ? '#f5f7fa' : '#1b2733') +
          ';writing-mode:vertical-rl;text-orientation:mixed;';
        s.appendChild(lbl);
        root.appendChild(s);
      });

      canvas.appendChild(root);
      // Piano-like glissando: sweeping onto a string plucks it and
      // releases the previous one, so re-entering a string already
      // crossed in the same gesture re-triggers its MIDI note (a
      // real harp glissando re-plucks on every pass). Keyed by
      // string index (the configured selection may repeat a note).
      this._initCellView({
        root,
        selector: '.harp-string',
        keyOf: (c) => c.dataset.idx,
        onCellOn: (c) => {
          c.style.opacity = '1';
        },
        onCellOff: (c) => {
          c.style.opacity = '.85';
        }
      });
    }

    unmount() {
      this._cellViewUnmount();
      super.unmount();
    }
  }

  if (typeof window !== 'undefined') window.HarpView = HarpView;
  if (typeof module !== 'undefined') module.exports = HarpView;
})();
