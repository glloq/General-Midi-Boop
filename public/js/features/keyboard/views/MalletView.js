// =============================================================================
// MalletView.js — Mallet percussion (GM 12 Marimba … 15 Dulcimer).
// =============================================================================
// Marimba/xylophone bar layout: a bottom row of naturals and an offset
// top row of accidentals (the classic two-tier mallet keyboard). Two
// octaves C4..B5. Self-owned DOM; strike on pointerdown, global pointerup
// release (notes decay naturally on the synth).
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.InstrumentView) return;
  const InstrumentView = window.InstrumentView;

  const DEFAULT_LO = 60,
    DEFAULT_HI = 83; // C4..B5 fallback
  const BLACK = new Set([1, 3, 6, 8, 10]); // semitone classes with a sharp

  // Realistic per-instrument bar materials. nat = naturals (lower row),
  // acc = accidentals (upper row), text = label color. Falls back to the
  // historic warm-wood look for non-mapped programs (e.g. tubular bells,
  // dulcimer) so their appearance is unchanged.
  const DEFAULT_SKIN = {
    nat: '#d8b46a',
    acc: '#7a5a2a',
    text: '#222',
    accText: '#fff'
  };
  const MALLET_SKINS = {
    // Glockenspiel — acier poli brillant (froid)
    9: {
      skin: 'metal-bright',
      nat: 'linear-gradient(180deg,#f4f7fa 0%,#cfd6dc 45%,#aeb8c2 100%)',
      acc: 'linear-gradient(180deg,#9aa4b0 0%,#6b7480 100%)',
      text: '#2a3a4a',
      accText: '#eef3f8'
    },
    // Vibraphone — aluminium / or chaud
    11: {
      skin: 'metal-warm',
      nat: 'linear-gradient(180deg,#f2dca0 0%,#d8b773 45%,#c19a4f 100%)',
      acc: 'linear-gradient(180deg,#b08f49 0%,#8a6f33 100%)',
      text: '#4a3712',
      accText: '#fff3d6'
    },
    // Marimba — bois de rose foncé
    12: {
      skin: 'wood-dark',
      nat: 'linear-gradient(180deg,#9c6239 0%,#7a4a2b 100%)',
      acc: 'linear-gradient(180deg,#5a3a22 0%,#3c2415 100%)',
      text: '#f3e3d2',
      accText: '#f3e3d2'
    },
    // Xylophone — bois clair (miel/ambre)
    13: {
      skin: 'wood-light',
      nat: 'linear-gradient(180deg,#e6c089 0%,#c8975a 100%)',
      acc: 'linear-gradient(180deg,#a9763f 0%,#8a5a2e 100%)',
      text: '#5a3a1c',
      accText: '#fbeed8'
    }
  };

  class MalletView extends InstrumentView {
    static viewKind = 'mallet';
    static iconUrl = '/assets/instruments/marimba.svg';
    static emoji = '🎶';
    static labelKey = 'keyboard.viewMallet';

    mount(ctx) {
      super.mount(ctx);
      const modal = ctx.modal;
      if (!modal) return;
      const canvas = document.getElementById('keyboard-canvas-container');
      if (!canvas) return;
      document.getElementById('mallet-container')?.remove();

      // QA: use the instrument's configured note range, not a forced
      // fixed span. Fall back to C4..B5 when no capabilities.
      const r =
        typeof modal.getInstrumentNoteRange === 'function' ? modal.getInstrumentNoteRange() : null;
      const LO = r ? r.min : DEFAULT_LO;
      const HI = r ? r.max : DEFAULT_HI;

      const gmProgram =
        modal.selectedDeviceCapabilities?.gm_program ?? modal.selectedDevice?.gm_program ?? null;
      const skin = (gmProgram != null && MALLET_SKINS[gmProgram]) || DEFAULT_SKIN;

      const root = document.createElement('div');
      root.id = 'mallet-container';
      root.className = 'mallet-view';
      if (skin.skin) root.dataset.malletSkin = skin.skin;
      root.style.cssText =
        'display:flex;align-items:stretch;justify-content:stretch;' +
        'height:100%;padding:14px 10px;box-sizing:border-box;' +
        'touch-action:none;';

      const label =
        typeof modal.getNoteLabel === 'function' ? (n) => modal.getNoteLabel(n) : (n) => String(n);

      // Responsive piano-like geometry expressed in PERCENT so the
      // whole configured range always fits the window (no overflow,
      // no manual zoom). Naturals fill the width; accidentals sit
      // ABOVE the boundary between the right naturals (sharps are
      // shorter and anchored to the very top → visually higher).
      let naturalsCount = 0;
      for (let n = LO; n <= HI; n++) if (!BLACK.has(((n % 12) + 12) % 12)) naturalsCount++;
      naturalsCount = Math.max(1, naturalsCount);
      const NAT_W = 100 / naturalsCount; // % of board width
      const ACC_W = NAT_W * 0.62;

      const board = document.createElement('div');
      board.className = 'mallet-board';
      board.style.cssText = 'position:relative;width:100%;height:100%;min-height:160px;';

      let natIdx = 0;
      const mkBar = (n, isBlack, leftPct, widthPct, posCss) => {
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'mallet-bar' + (isBlack ? ' mallet-bar-acc' : ' mallet-bar-nat');
        bar.dataset.note = String(n);
        bar.title = label(n);
        bar.textContent = label(n);
        bar.style.cssText =
          'position:absolute;box-sizing:border-box;' +
          'border:1px solid #2a2a2a;border-radius:0 0 4px 4px;' +
          'cursor:pointer;font:10px sans-serif;display:flex;' +
          'align-items:flex-end;justify-content:center;padding-bottom:4px;' +
          `left:${leftPct}%;width:${widthPct}%;${posCss}` +
          `z-index:${isBlack ? 2 : 1};` +
          `background:${isBlack ? skin.acc : skin.nat};` +
          `color:${isBlack ? skin.accText : skin.text};`;
        if (modal.showNoteColors && typeof modal.getNoteColor === 'function') {
          const c = modal.getNoteColor(n);
          bar.style.background = c.bg;
          bar.style.color = c.text;
        }
        return bar;
      };

      for (let n = LO; n <= HI; n++) {
        const isBlack = BLACK.has(((n % 12) + 12) % 12);
        if (!isBlack) {
          // Naturals: lower band (bottom 58%).
          board.appendChild(mkBar(n, false, natIdx * NAT_W, NAT_W, 'bottom:0;height:58%;'));
          natIdx++;
        } else {
          // Accidentals: centred on the boundary, anchored to the
          // TOP and shorter → clearly higher than the naturals.
          const leftPct = natIdx * NAT_W - ACC_W / 2;
          board.appendChild(mkBar(n, true, leftPct, ACC_W, 'top:0;height:46%;border-radius:4px;'));
        }
      }

      root.appendChild(board);
      canvas.appendChild(root);

      // Piano-like drag: slide across the bars for a glissando.
      this._initCellView({ root, selector: '.mallet-bar' });
    }

    unmount() {
      this._cellViewUnmount();
      super.unmount();
    }
  }

  if (typeof window !== 'undefined') window.MalletView = MalletView;
  if (typeof module !== 'undefined') module.exports = MalletView;
})();
