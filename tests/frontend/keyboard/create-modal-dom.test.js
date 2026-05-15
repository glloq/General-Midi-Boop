// tests/frontend/keyboard/create-modal-dom.test.js
// PE-1 (Phase E safety net): freezes the structural contract produced by
// KeyboardModal.createModal() — container ids, their order inside
// #keyboard-canvas-container, the toolbar group ids and the slider panel
// ids. PE-4 (HTML template extraction) and PE-5 (per-view render
// relocation) are pure code-motion whose only other validation is the
// browser; this test makes a structural regression fail in CI instead.
//
// The mixins are applied explicitly here: the `new Function('window',src)`
// sandbox does not satisfy the `typeof KeyboardXxxMixin` guards in
// KeyboardModal.js, so without this the prototype would lack createModal.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  load('../../../public/js/features/keyboard/SwipeTracker.js');
  load('../../../public/js/features/keyboard/NoteEngine.js');
  load('../../../public/js/features/keyboard/VoicingEngine.js');
  load('../../../public/js/features/keyboard/NoteSlider.js');
  for (const mx of ['KeyboardPiano', 'KeyboardEvents', 'KeyboardControls',
                     'KeyboardChords', 'KeyboardSlider', 'KeyboardListView',
                     'KeyboardWind']) {
    load(`../../../public/js/features/keyboard/${mx}.js`);
  }
  load('../../../public/js/features/KeyboardModal.js');

  // Apply mixins exactly like KeyboardModal.js's _applyMixin would, in the
  // same order (later wins on collision — matches production semantics).
  for (const name of ['KeyboardPianoMixin', 'KeyboardEventsMixin',
                       'KeyboardControlsMixin', 'KeyboardChordsMixin',
                       'KeyboardSliderMixin', 'KeyboardListViewMixin',
                       'KeyboardWindMixin']) {
    if (win[name]) Object.assign(win.KeyboardModal.prototype, win[name]);
  }
});

function buildModal() {
  document.body.innerHTML = '';
  const m = new (win.KeyboardModal)();
  m.createModal();
  return m;
}

describe('PE-1 — createModal() structural contract', () => {
  it('mixins are wired (createModal is callable)', () => {
    expect(typeof win.KeyboardModal.prototype.createModal).toBe('function');
    expect(typeof win.KeyboardModal.prototype.generatePianoKeys).toBe('function');
  });

  it('mounts the overlay + dialog with the canvas container', () => {
    const m = buildModal();
    expect(m.container).toBeTruthy();
    expect(m.container.classList.contains('keyboard-modal')).toBe(true);
    expect(document.body.contains(m.container)).toBe(true);
    expect(document.getElementById('keyboard-canvas-container')).not.toBeNull();
  });

  it('keeps the 6 built-in canvas children in the expected order', () => {
    buildModal();
    const canvas = document.getElementById('keyboard-canvas-container');
    const ids = [...canvas.children].map(c => c.id).filter(Boolean);
    expect(ids).toEqual([
      'piano-container',
      'piano-slider-container',
      'fretboard-container',
      'drumpad-container',
      'keyboard-list-container',
      'km-hand-band'
    ]);
  });

  it('only #piano-container is visible by default (others .hidden)', () => {
    buildModal();
    expect(document.getElementById('piano-container').classList.contains('hidden')).toBe(false);
    for (const id of ['piano-slider-container', 'fretboard-container',
                      'drumpad-container', 'keyboard-list-container', 'km-hand-band']) {
      expect(document.getElementById(id).classList.contains('hidden')).toBe(true);
    }
  });

  it('exposes the stable chrome ids (header / minimap / octave bar)', () => {
    buildModal();
    for (const id of ['instrument-trigger', 'instrument-dropdown',
                      'keyboard-close-btn', 'keyboard-view-mode-group',
                      'keyboard-view-toggle', 'keyboard-minimap-row',
                      'keyboard-minimap-track', 'keyboard-octave-bar',
                      'keyboard-octave-display']) {
      expect(document.getElementById(id), `#${id}`).not.toBeNull();
    }
  });

  it('exposes the slider/control panels and their inputs', () => {
    buildModal();
    for (const id of ['velocity-control-panel', 'modulation-control-panel',
                      'pitch-bend-control-panel', 'keyboard-velocity',
                      'mod-wheel-track', 'pitch-bend-track']) {
      expect(document.getElementById(id), `#${id}`).not.toBeNull();
    }
  });

  it('exposes the notation radio group with US/FR/MIDI', () => {
    buildModal();
    const toggle = document.getElementById('keyboard-notation-toggle');
    expect(toggle).not.toBeNull();
    const fmts = [...toggle.querySelectorAll('.notation-btn')]
      .map(b => b.dataset.notation).sort();
    expect(fmts).toEqual(['english', 'midi', 'solfege']);
  });

  it('rebuilds identically on a second createModal() (idempotent shape)', () => {
    const snap = () => {
      buildModal();
      const c = document.getElementById('keyboard-canvas-container');
      return [...c.children].map(x => x.id).join(',');
    };
    expect(snap()).toBe(snap());
  });
});
