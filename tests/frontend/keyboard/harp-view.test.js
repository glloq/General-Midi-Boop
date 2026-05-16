// tests/frontend/keyboard/harp-view.test.js
// Second proof of the "add an instrument view" recipe (docs §20):
// HarpView (GM 46) — registered, auto-detected (without stealing the
// fretboard from string-typed instruments), owns its DOM, supports
// pluck + glissando, cleans up on unmount, resolved by _activateView.

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
  load('../../../public/js/features/keyboard/views/HarpView.js');
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
  load('../../../public/js/features/KeyboardModal.js');
});

const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

describe('Harp — registration & detection', () => {
  it('HarpView is registered and resolvable', () => {
    expect(typeof win.HarpView).toBe('function');
    expect(win.HarpView.viewKind).toBe('harp');
    expect(win.instrumentViews.get('harp')).toBe(win.HarpView);
  });

  it('GM 46 resolves to harp (registry rule precedes fretboard 24-47)', () => {
    const r = win.instrumentViews.resolve({ gm_program: 46 });
    expect(r.viewKind).toBe('harp');
    expect(r.ViewClass).toBe(win.HarpView);
  });

  it('InstrumentDetector maps GM 46 to harp, not fretboard', () => {
    const d = win.InstrumentDetector.detect({ capabilities: { gm_program: 46 } });
    expect(d.viewKind).toBe('harp');
    expect(d.isHarp).toBe(true);
    expect(d.canFretboard).toBe(false);
  });

  it('neighbours: 45 pizzicato stays fretboard, 47 timpani → mallet', () => {
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 45 } }).viewKind).toBe('fretboard');
    // GM 47 (Timpani) is now excluded from the fretboard range and routed
    // to the tuned-bar mallet view (like the GM 46 harp exclusion).
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 47 } }).viewKind).toBe('mallet');
  });

  it('escape hatch: explicit string type / stringConfig still forces fretboard for GM 46', () => {
    expect(win.InstrumentDetector.detect({
      capabilities: { gm_program: 46, instrument_type: 'string' }
    }).viewKind).toBe('fretboard');
    expect(win.InstrumentDetector.detect({
      capabilities: { gm_program: 46 },
      stringInstrumentConfig: { strings: 22 }
    }).viewKind).toBe('fretboard');
  });

  it('drum still wins over harp on channel 9', () => {
    expect(win.InstrumentDetector.detect({
      capabilities: { gm_program: 46, channel: 9 }
    }).viewKind).toBe('drumpad');
  });
});

describe('Harp — self-owned DOM lifecycle', () => {
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
    view = new (win.HarpView)();
    view.mount({ modal });
  });

  afterEach(() => { try { view.unmount(); } catch { /* idempotent */ } });

  it('mount() builds 22 C-major strings C3..C6 (C/F landmarks coloured)', () => {
    const root = document.getElementById('harp-container');
    expect(root).not.toBeNull();
    const strings = root.querySelectorAll('.harp-string');
    expect(strings.length).toBe(22);
    expect(strings[0].dataset.note).toBe('48');   // C3
    expect(strings[21].dataset.note).toBe('84');  // C6
    // Diatonic: no accidentals (every note class in the C-major scale)
    const scale = new Set([0, 2, 4, 5, 7, 9, 11]);
    for (const s of strings) expect(scale.has(parseInt(s.dataset.note, 10) % 12)).toBe(true);
    expect(root.querySelectorAll('.harp-string-c').length).toBe(4); // C3,C4,C5,C6
    expect(root.querySelectorAll('.harp-string-f').length).toBe(3); // F3,F4,F5
  });

  it('plucking a string plays it; global pointerup releases it', () => {
    const root = document.getElementById('harp-container');
    const s = root.querySelectorAll('.harp-string')[0]; // C3 = 48
    fire(s, 'pointerdown');
    expect(played).toEqual([48]);
    expect(s.classList.contains('active')).toBe(true);
    document.dispatchEvent(new Event('pointerup'));
    expect(stopped).toEqual([48]);
    expect(s.classList.contains('active')).toBe(false);
  });

  it('dragging across strings performs a glissando (each new string plucked once)', () => {
    const root = document.getElementById('harp-container');
    const s = root.querySelectorAll('.harp-string');
    fire(s[0], 'pointerdown');     // press C3
    fire(s[1], 'pointermove');     // drag → D3
    fire(s[2], 'pointermove');     // → E3
    fire(s[2], 'pointermove');     // same string, no re-trigger
    expect(played).toEqual([48, 50, 52]);
    document.dispatchEvent(new Event('pointerup'));
    expect(stopped.sort((a, b) => a - b)).toEqual([48, 50, 52]);
    expect(root.querySelectorAll('.harp-string.active').length).toBe(0);
  });

  it('pointermove without a prior pointerdown does nothing', () => {
    const root = document.getElementById('harp-container');
    fire(root.querySelectorAll('.harp-string')[3], 'pointermove');
    expect(played).toEqual([]);
  });

  it('setActiveNotes highlights matching strings', () => {
    const root = document.getElementById('harp-container');
    view.setActiveNotes(new Set([48, 84]));
    const lit = [...root.querySelectorAll('.harp-string.active')]
      .map(c => c.dataset.note).sort();
    expect(lit).toEqual(['48', '84']);
  });

  it('unmount() stops ringing strings and removes its container', () => {
    const root = document.getElementById('harp-container');
    fire(root.querySelectorAll('.harp-string')[0], 'pointerdown'); // ring 48
    view.unmount();
    expect(stopped).toEqual([48]);
    expect(document.getElementById('harp-container')).toBeNull();
    expect(view.mounted).toBe(false);
  });
});

describe('Harp — configured strings (modal._harpStringConfig)', () => {
  afterEach(() => {
    document.getElementById('harp-container')?.remove();
  });

  it('renders exactly the configured tuning, in order', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const view = new (win.HarpView)();
    view.mount({
      modal: {
        playNote() {}, stopNote() {}, getNoteLabel: (n) => `N${n}`,
        _harpStringConfig: { tuning: [40, 45, 50, 55, 59], num_strings: 5 }
      }
    });
    const root = document.getElementById('harp-container');
    const strings = root.querySelectorAll('.harp-string');
    expect(strings.length).toBe(5);
    expect([...strings].map(s => s.dataset.note))
      .toEqual(['40', '45', '50', '55', '59']);
    view.unmount();
  });

  it('falls back to the 22 diatonic strings when no config is present', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const view = new (win.HarpView)();
    view.mount({ modal: { playNote() {}, stopNote() {}, getNoteLabel: (n) => `N${n}` } });
    const strings = document.querySelectorAll('.harp-string');
    expect(strings.length).toBe(22);
    expect(strings[0].dataset.note).toBe('48');
    expect(strings[21].dataset.note).toBe('84');
    view.unmount();
  });
});

describe('Harp — KeyboardModal._activateView integration', () => {
  it('_activateView("harp") mounts HarpView; switching unmounts it', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = new (win.KeyboardModal)();
    m.regeneratePianoKeys = () => {}; // piano fallback is a mixin (absent here)

    m._activateView('harp');
    expect(m._activeView).toBeInstanceOf(win.HarpView);
    expect(m._activeViewKind).toBe('harp');
    expect(document.getElementById('harp-container')).not.toBeNull();

    m._activateView('piano');
    expect(document.getElementById('harp-container')).toBeNull();
    expect(m._activeView).toBeInstanceOf(win.PianoView);
  });
});
