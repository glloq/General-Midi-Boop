// tests/frontend/keyboard/harmonica-view.test.js
// Proof that the "add an instrument view" recipe (docs §20) works
// end-to-end: HarmonicaView is registered, auto-detected for GM 22,
// owns its own DOM, plays through modal.playNote/stopNote, cleans up
// on unmount, and is resolved + mounted by KeyboardModal._activateView.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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
  load('../../../public/js/features/keyboard/views/PianoView.js');
  load('../../../public/js/features/keyboard/views/FretboardView.js');
  load('../../../public/js/features/keyboard/views/DrumPadView.js');
  load('../../../public/js/features/keyboard/views/PianoSliderView.js');
  load('../../../public/js/features/keyboard/views/ListView.js');
  load('../../../public/js/features/keyboard/views/HarmonicaView.js');
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
  load('../../../public/js/features/KeyboardModal.js');
});

const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

describe('Harmonica — registration & detection', () => {
  it('HarmonicaView is registered and resolvable by kind', () => {
    expect(typeof win.HarmonicaView).toBe('function');
    expect(win.HarmonicaView.viewKind).toBe('harmonica');
    expect(win.instrumentViews.get('harmonica')).toBe(win.HarmonicaView);
  });

  it('GM 22 resolves to harmonica via registry rule', () => {
    const r = win.instrumentViews.resolve({ gm_program: 22 });
    expect(r.viewKind).toBe('harmonica');
    expect(r.ViewClass).toBe(win.HarmonicaView);
  });

  it('InstrumentDetector classifies GM 22 as harmonica (21/23 are accordion)', () => {
    const d = win.InstrumentDetector.detect({ capabilities: { gm_program: 22 } });
    expect(d.viewKind).toBe('harmonica');
    expect(d.isHarmonica).toBe(true);
    // GM 21 (Accordion) / 23 (Tango Accordion) now route to AccordionView;
    // 22 (Harmonica) keeps its own view between them.
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 21 } }).viewKind).toBe('accordion');
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 23 } }).viewKind).toBe('accordion');
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 0 } }).viewKind).toBe('piano');
  });

  it('drum/string/wind still win over harmonica when ambiguous', () => {
    // channel 9 drum kit must not be hijacked by a stray GM 22 program
    expect(win.InstrumentDetector.detect({
      capabilities: { gm_program: 22, channel: 9 }
    }).viewKind).toBe('drumpad');
  });
});

describe('Harmonica — self-owned DOM lifecycle', () => {
  let played, stopped, modal, view;

  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    played = [];
    stopped = [];
    modal = {
      playNote: (n) => played.push(n),
      stopNote: (n) => stopped.push(n),
      getNoteLabel: (n) => `N${n}`
    };
    view = new (win.HarmonicaView)();
    view.mount({ modal });
  });

  // Each view registers a document-level pointerup listener; tearing it
  // down keeps tests isolated (no cross-test listener accumulation) and
  // exercises unmount() idempotence.
  afterEach(() => { try { view.unmount(); } catch { /* idempotent */ } });

  it('mount() lazy-creates #harmonica-container with 10 blow + 10 draw holes', () => {
    const root = document.getElementById('harmonica-container');
    expect(root).not.toBeNull();
    expect(root.querySelectorAll('.harmonica-hole').length).toBe(20);
    const blow = root.querySelectorAll('.harmonica-blow');
    const draw = root.querySelectorAll('.harmonica-draw');
    expect(blow.length).toBe(10);
    expect(draw.length).toBe(10);
    // C Richter tuning: hole 1 blow = C4 (60), hole 1 draw = D4 (62)
    expect(blow[0].dataset.note).toBe('60');
    expect(draw[0].dataset.note).toBe('62');
    expect(blow[9].dataset.note).toBe('96'); // hole 10 blow = C7
  });

  it('pressing a hole plays via modal and lights it; global up stops it', () => {
    const root = document.getElementById('harmonica-container');
    const cell = root.querySelector('.harmonica-blow'); // hole 1 blow = 60
    fire(cell, 'pointerdown');
    expect(played).toEqual([60]);
    expect(cell.classList.contains('active')).toBe(true);
    document.dispatchEvent(new Event('pointerup'));
    expect(stopped).toEqual([60]);
    expect(cell.classList.contains('active')).toBe(false);
  });

  it('same MIDI on two holes (G4 = hole2 draw & hole3 blow) plays both', () => {
    const root = document.getElementById('harmonica-container');
    const draws = root.querySelectorAll('.harmonica-draw');
    const blows = root.querySelectorAll('.harmonica-blow');
    expect(draws[1].dataset.note).toBe('67');
    expect(blows[2].dataset.note).toBe('67');
    fire(draws[1], 'pointerdown');
    fire(blows[2], 'pointerdown');
    expect(played).toEqual([67, 67]);            // independent hole tracking
    document.dispatchEvent(new Event('pointerup'));
    expect(stopped.sort()).toEqual([67, 67]);    // global release frees both
    expect(root.querySelectorAll('.harmonica-hole.active').length).toBe(0);
  });

  it('re-pressing the same hole without release does not double-fire', () => {
    const root = document.getElementById('harmonica-container');
    const cell = root.querySelector('.harmonica-blow');
    fire(cell, 'pointerdown');
    fire(cell, 'pointerdown');
    expect(played).toEqual([60]);                 // guarded by _pressed map
  });

  it('global pointerup releases every held hole (no stuck notes)', () => {
    const root = document.getElementById('harmonica-container');
    const cells = root.querySelectorAll('.harmonica-hole');
    fire(cells[0], 'pointerdown');
    fire(cells[5], 'pointerdown');
    expect(played.length).toBe(2);
    document.dispatchEvent(new Event('pointerup'));
    expect(stopped.length).toBe(2);
    expect(root.querySelectorAll('.harmonica-hole.active').length).toBe(0);
  });

  it('setActiveNotes highlights matching holes', () => {
    const root = document.getElementById('harmonica-container');
    view.setActiveNotes(new Set([60, 62]));
    const lit = [...root.querySelectorAll('.harmonica-hole.active')]
      .map(c => c.dataset.note).sort();
    expect(lit).toEqual(['60', '62']);
  });

  it('unmount() stops held notes and removes its container', () => {
    const root = document.getElementById('harmonica-container');
    fire(root.querySelector('.harmonica-blow'), 'pointerdown'); // hold 60
    view.unmount();
    expect(stopped).toEqual([60]);                       // released on teardown
    expect(document.getElementById('harmonica-container')).toBeNull();
    expect(view.mounted).toBe(false);
  });

  it('toolbarGroups excludes octave/minimap/pitch-bend', () => {
    const g = view.toolbarGroups();
    expect(g.has('velocity')).toBe(true);
    expect(g.has('notation')).toBe(true);
    expect(g.has('minimap')).toBe(false);
    expect(g.has('pitch-bend')).toBe(false);
  });
});

describe('Harmonica — KeyboardModal._activateView integration', () => {
  it('_activateView("harmonica") resolves & mounts HarmonicaView; switching unmounts it', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = new (win.KeyboardModal)();
    // Piano fallback render is a mixin (absent in this harness) — stub it.
    m.regeneratePianoKeys = () => {};

    m._activateView('harmonica');
    expect(m._activeView).toBeInstanceOf(win.HarmonicaView);
    expect(m._activeViewKind).toBe('harmonica');
    expect(document.getElementById('harmonica-container')).not.toBeNull();

    m._activateView('piano');
    expect(document.getElementById('harmonica-container')).toBeNull(); // unmounted
    expect(m._activeView).toBeInstanceOf(win.PianoView);
  });
});
