// tests/frontend/keyboard/extra-instrument-views.test.js
// Roadmap completion (docs §20.2): accordion, mallet, kalimba, bagpipe,
// steel-drum, theremin. Each must be registered, auto-detected, own its
// DOM, play through modal.playNote/stopNote, clean up on unmount, and be
// resolved + mounted by KeyboardModal._activateView.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  // KeyboardModal.getBagpipeConfig delegates to the shared
  // MidiConstants.normalizeBagpipeDrones, so it must load first.
  load('../../../public/js/utils/MidiConstants.js');
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  for (const v of ['PianoView', 'FretboardView', 'DrumPadView', 'PianoSliderView',
                   'ListView', 'HarmonicaView', 'HarpView', 'AccordionView',
                   'MalletView', 'KalimbaView', 'BagpipeView', 'SteelDrumView',
                   'ThereminView', 'PercussionPadView']) {
    load(`../../../public/js/features/keyboard/views/${v}.js`);
  }
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
  load('../../../public/js/features/keyboard/KeyboardEvents.js'); // real playNote
  load('../../../public/js/features/KeyboardModal.js');
});

const fire = (el, type, props = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  el.dispatchEvent(ev);
};
const mkModal = (sink) => ({
  playNote: (n) => sink.played.push(n),
  stopNote: (n) => sink.stopped.push(n),
  sendCC: (c, v) => sink.cc.push([c, v]),
  getNoteLabel: (n) => `N${n}`
});

describe('Roadmap views — registration & detection', () => {
  const expectations = [
    ['accordion',  win => win.AccordionView,  { gm_program: 21 }],
    ['accordion',  win => win.AccordionView,  { gm_program: 23 }],
    ['mallet',     win => win.MalletView,     { gm_program: 12 }],
    ['mallet',     win => win.MalletView,     { gm_program: 15 }],
    ['kalimba',    win => win.KalimbaView,    { gm_program: 108 }],
    ['bagpipe',    win => win.BagpipeView,    { gm_program: 109 }],
    ['steel-drum', win => win.SteelDrumView,  { gm_program: 114 }],
    ['theremin',   win => win.ThereminView,   { instrument_type: 'theremin' }],
    ['mallet',     win => win.MalletView,     { gm_program: 9 }],
    ['mallet',     win => win.MalletView,     { gm_program: 11 }],
    ['mallet',     win => win.MalletView,     { gm_program: 47 }],
    ['perc-pad',   win => win.PercussionPadView, { gm_program: 112 }],
    ['perc-pad',   win => win.PercussionPadView, { gm_program: 127 }],
  ];

  for (const [kind, cls, caps] of expectations) {
    it(`${JSON.stringify(caps)} → ${kind} (detector + registry agree)`, () => {
      expect(typeof cls(win)).toBe('function');
      expect(win.instrumentViews.get(kind)).toBe(cls(win));
      expect(win.InstrumentDetector.detect({ capabilities: caps }).viewKind).toBe(kind);
      expect(win.instrumentViews.resolve(caps).viewKind).toBe(kind);
    });
  }

  it('GM 22 stays harmonica (not accordion); melodic percussion → mallet; 16 stays piano', () => {
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 22 } }).viewKind).toBe('harmonica');
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 9 } }).viewKind).toBe('mallet');
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 11 } }).viewKind).toBe('mallet');
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 47 } }).viewKind).toBe('mallet');
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 16 } }).viewKind).toBe('piano');
  });

  it('theremin type wins even with a GM patch present', () => {
    expect(win.InstrumentDetector.detect({
      capabilities: { instrument_type: 'theremin', gm_program: 80 }
    }).viewKind).toBe('theremin');
  });
});

// ── Pluck-style views: identical lifecycle contract ─────────────────────────
describe.each([
  ['accordion',  'accordion-container',  '.accordion-key'],
  ['mallet',     'mallet-container',     '.mallet-bar'],
  ['kalimba',    'kalimba-container',    '.kalimba-tine'],
  ['steel-drum', 'steel-drum-container', '.steel-section'],
  ['perc-pad',   'perc-pad-container',   '.perc-pad'],
])('%s — self-owned DOM lifecycle', (kind, containerId, cellSel) => {
  let sink, modal, view;
  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    sink = { played: [], stopped: [], cc: [] };
    modal = mkModal(sink);
    view = new (win.instrumentViews.get(kind))();
    view.mount({ modal });
  });
  afterEach(() => { try { view.unmount(); } catch { /* idempotent */ } });

  it('mounts its own container with playable cells', () => {
    const root = document.getElementById(containerId);
    expect(root).not.toBeNull();
    expect(root.querySelectorAll(cellSel).length).toBeGreaterThan(0);
  });

  it('pointerdown plays; global pointerup releases (no stuck notes)', () => {
    const root = document.getElementById(containerId);
    const cell = root.querySelector(cellSel);
    const note = parseInt(cell.dataset.note, 10);
    fire(cell, 'pointerdown');
    expect(sink.played).toContain(note);
    expect(cell.classList.contains('active')).toBe(true);
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped).toContain(note);
    expect(root.querySelectorAll(`${cellSel}.active`).length).toBe(0);
  });

  it('unmount() removes the container and is idempotent', () => {
    view.unmount();
    expect(document.getElementById(containerId)).toBeNull();
    expect(view.mounted).toBe(false);
    expect(() => view.unmount()).not.toThrow();
  });

  it('_activateView resolves & mounts it, switching unmounts it', () => {
    const m = new (win.KeyboardModal)();
    m.regeneratePianoKeys = () => {};
    m._activateView(kind);
    expect(m._activeView).toBeInstanceOf(win.instrumentViews.get(kind));
    expect(document.getElementById(containerId)).not.toBeNull();
    m._activateView('piano');
    expect(document.getElementById(containerId)).toBeNull();
  });
});

describe('accordion — Stradella grid, soufflet, no volume slider', () => {
  let sink, v;
  const mount = (cfg) => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    sink = { played: [], stopped: [] };
    const modal = {
      playNote: (n) => sink.played.push(n),
      stopNote: (n) => sink.stopped.push(n),
      getNoteLabel: (n) => `N${n}`,
      getAccordionConfig: () => cfg,
    };
    v = new (win.AccordionView)();
    v.mount({ modal });
  };
  afterEach(() => { try { v.unmount(); } catch { /* idempotent */ } });

  it('Stradella bass = 6 rows × 12 circle-of-fifths columns (72 points)', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    expect(document.querySelectorAll('.accordion-bass .accordion-key').length)
      .toBe(72);
    expect(document.querySelector('.accordion-stradella')).not.toBeNull();
  });

  it('a Stradella chord button plays its full multi-note chord', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    // Row order: CB, B, M, m, 7, °. The "M" (major) button of the C
    // column triggers a 3-note chord.
    const major = [...document.querySelectorAll('.accordion-bass .accordion-key')]
      .find((b) => /N\d+M$/.test(b.title));
    expect(major).toBeTruthy();
    fire(major, 'pointerdown');
    expect(sink.played.length).toBe(3);
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped.length).toBe(3);
  });

  it('no bellows slider; velocity passes through unscaled (volume bar removed)', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    expect(document.getElementById('accordion-bellows')).toBeNull();
    // Inherited base default: identity transform (no bellows scaling).
    expect(v.willPlayNote(60, 100, {})).toEqual({ midi: 60, velocity: 100, opts: {} });
  });

  it('decorative soufflet present and not a playable key', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    const soufflet = document.querySelector('.accordion-bellows-visual');
    expect(soufflet).not.toBeNull();
    expect(soufflet.classList.contains('accordion-key')).toBe(false);
    expect(soufflet.style.pointerEvents).toBe('none');
  });

  it('free-bass renders a chromatic single-note board on bass_range', () => {
    mount({ bass_system: 'free', right_display: 'keyboard',
            bass_range: { min: 36, max: 47 } });
    const board = document.querySelector('.accordion-bass.accordion-board');
    expect(board).not.toBeNull();
    expect(board.querySelectorAll('.accordion-key').length).toBe(12);
  });
});

describe('configured note range (QA) — views follow instrument settings', () => {
  const rangedModal = (min, max) => ({
    playNote() {}, stopNote() {}, sendCC() {},
    getNoteLabel: (n) => `N${n}`,
    getInstrumentNoteRange: () => ({ min, max, notes: null }),
  });

  it('MalletView: piano-like layout, bar count follows the range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.MalletView)();
    v.mount({ modal: rangedModal(60, 64) });        // C4..E4
    const bars = [...document.querySelectorAll('.mallet-bar')];
    // 60 C,61 C#,62 D,63 D#,64 E → 3 naturals + 2 accidentals
    expect(bars.map(b => b.dataset.note)).toEqual(['60', '61', '62', '63', '64']);
    const nat = document.querySelectorAll('.mallet-bar-nat');
    const acc = document.querySelectorAll('.mallet-bar-acc');
    expect(nat.length).toBe(3);
    expect(acc.length).toBe(2);
    // Piano-like: accidentals sit ABOVE (absolute, top:0), naturals bottom:0
    for (const a of acc) {
      expect(a.style.position).toBe('absolute');
      expect(a.style.top).toBe('0px');
    }
    for (const nn of nat) expect(nn.style.bottom).toBe('0px');
    v.unmount();
  });

  it('MalletView: no caps → default C4..B5 (24 chromatic)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.MalletView)();
    v.mount({ modal: { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}` } });
    const bars = document.querySelectorAll('.mallet-bar');
    expect(bars.length).toBe(24);                    // 60..83
    v.unmount();
  });

  it('SteelDrumView: section count follows the range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.SteelDrumView)();
    v.mount({ modal: rangedModal(48, 59) });         // 12 notes
    expect(document.querySelectorAll('.steel-section').length).toBe(12);
    v.unmount();
  });

  it('HarpView: diatonic strings within the range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.HarpView)();
    v.mount({ modal: rangedModal(60, 64) });         // C,D,E in C-major
    expect([...document.querySelectorAll('.harp-string')]
      .map(s => s.dataset.note)).toEqual(['60', '62', '64']);
    v.unmount();
  });

  it('KalimbaView: tine count follows the range (diatonic)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.KalimbaView)();
    v.mount({ modal: rangedModal(60, 71) });         // C..B = 7 diatonic
    expect(document.querySelectorAll('.kalimba-tine').length).toBe(7);
    v.unmount();
  });

  it('HarmonicaView: holes trimmed to the configured range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.HarmonicaView)();
    v.mount({ modal: rangedModal(60, 72) });         // Richter from 60, ≤72
    const blow = [...document.querySelectorAll('.harmonica-blow')]
      .map(b => parseInt(b.dataset.note, 10));
    expect(blow[0]).toBe(60);
    expect(Math.max(...blow)).toBeLessThanOrEqual(72);
    expect(blow.length).toBeLessThan(10);            // trimmed vs full 10
    v.unmount();
  });

  it('BagpipeView: chanter follows the range, drone unchanged', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getInstrumentNoteRange = () => ({ min: 55, max: 60, notes: null });
    const v = new (win.BagpipeView)();
    v.mount({ modal: m });
    const ch = [...document.querySelectorAll('.bagpipe-hole')]
      .map(h => parseInt(h.dataset.note, 10));
    expect(ch[0]).toBe(55);
    expect(Math.max(...ch)).toBeLessThanOrEqual(60);
    expect(sink.played).toContain(45);               // A2 drone still on mount
    v.unmount();
  });
});

describe('instrument-specific settings (QA #3) — bagpipe + accordion', () => {
  it('getBagpipeConfig: defaults + normalizes legacy/object shapes', () => {
    const m = new (win.KeyboardModal)();
    expect(m.getBagpipeConfig()).toEqual({
      drones: [45], droneObjs: [{ note: 45, enabled: true }], enabled: true });
    // legacy number[] → all enabled
    m.selectedDeviceCapabilities = { bagpipe_config: { drones: [45, 45, 33], enabled: false } };
    expect(m.getBagpipeConfig()).toEqual({
      drones: [45, 45, 33],
      droneObjs: [{ note: 45, enabled: true }, { note: 45, enabled: true }, { note: 33, enabled: true }],
      enabled: false });
    // object shape: `drones` keeps only enabled notes, `droneObjs` keeps all
    m.selectedDeviceCapabilities = { bagpipe_config: {
      drones: [{ note: 33, enabled: true }, { note: 45, enabled: false }] } };
    const cfg = m.getBagpipeConfig();
    expect(cfg.drones).toEqual([33]);
    expect(cfg.droneObjs).toEqual([{ note: 33, enabled: true }, { note: 45, enabled: false }]);
    m.selectedDeviceCapabilities = { bagpipe_config: { drones: [] } };
    expect(m.getBagpipeConfig().drones).toEqual([45]);   // empty → default
  });

  it('getAccordionConfig: defaults + normalizes caps.accordion_config (no hands)', () => {
    const m = new (win.KeyboardModal)();
    expect(m.getAccordionConfig()).toEqual(
      { bass_system: 'stradella', right_display: 'buttons',
        bass_range: { min: 36, max: 60 } });
    m.selectedDeviceCapabilities = { accordion_config:
      { bass_system: 'free', right_display: 'keyboard', hands: 'left',
        bass_range: { min: 48, max: 55 } } };
    // `hands` is ignored — only per-side play possibilities are kept.
    expect(m.getAccordionConfig()).toEqual(
      { bass_system: 'free', right_display: 'keyboard',
        bass_range: { min: 48, max: 55 } });
    // legacy 'chromatic' normalized → 'free'
    m.selectedDeviceCapabilities = { accordion_config: { bass_system: 'chromatic' } };
    expect(m.getAccordionConfig().bass_system).toBe('free');
    // malformed range → C2..C4 default; inverted → swapped
    m.selectedDeviceCapabilities = { accordion_config: { bass_range: { min: 200 } } };
    expect(m.getAccordionConfig().bass_range).toEqual({ min: 36, max: 60 });
    m.selectedDeviceCapabilities = { accordion_config: { bass_range: { min: 70, max: 40 } } };
    expect(m.getAccordionConfig().bass_range).toEqual({ min: 40, max: 70 });
    m.selectedDeviceCapabilities = { accordion_config:
      { bass_system: 'bogus', right_display: 'z' } };
    expect(m.getAccordionConfig()).toEqual(
      { bass_system: 'stradella', right_display: 'buttons',
        bass_range: { min: 36, max: 60 } });
  });

  it('AccordionView: both sides ALWAYS present (no hand show/hide)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}`,
                getAccordionConfig: () => ({ bass_system: 'stradella',
                  right_display: 'buttons' }) };
    const v = new (win.AccordionView)();
    v.mount({ modal: m });
    expect(document.querySelector('.accordion-bass')).not.toBeNull();
    expect(document.querySelector('.accordion-treble')).not.toBeNull();
    const titles = [...document.querySelectorAll('.accordion-zone-title')]
      .map(t => t.textContent);
    expect(titles.length).toBe(2);
    expect(titles.some(t => t.includes('Côté gauche'))).toBe(true);
    expect(titles.some(t => t.includes('Côté droit'))).toBe(true);
    v.unmount();
  });

  it('AccordionView: right_display=keyboard → piano-style right side', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}`,
                getInstrumentNoteRange: () => ({ min: 60, max: 71, notes: null }),
                getAccordionConfig: () => ({ bass_system: 'stradella',
                  right_display: 'keyboard' }) };
    const v = new (win.AccordionView)();
    v.mount({ modal: m });
    const treble = document.querySelector('.accordion-treble');
    expect(treble.classList.contains('accordion-piano')).toBe(true);
    expect(document.querySelectorAll('.accordion-treble .accordion-key').length).toBe(12);
    expect(document.querySelectorAll('.accordion-key-black').length).toBe(5);
    // still both sides
    expect(document.querySelectorAll('.accordion-zone').length).toBe(2);
    expect(document.querySelector('.accordion-bass')).not.toBeNull();
    v.unmount();
  });

  it('BagpipeView: plays every configured drone on mount; toggle all', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({ drones: [45, 33, 57], enabled: true });
    const v = new (win.BagpipeView)();
    v.mount({ modal: m });
    expect(sink.played.filter(n => [45, 33, 57].includes(n)).sort()).toEqual([33, 45, 57]);
    document.getElementById('bagpipe-drone-toggle').click();   // off
    expect(sink.stopped.filter(n => [45, 33, 57].includes(n)).sort()).toEqual([33, 45, 57]);
    v.unmount();
  });

  it('BagpipeView: drones disabled in settings → silent on mount', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({ drones: [45], enabled: false });
    const v = new (win.BagpipeView)();
    v.mount({ modal: m });
    expect(sink.played).not.toContain(45);
    document.getElementById('bagpipe-drone-toggle').click();    // user starts it
    expect(sink.played).toContain(45);
    v.unmount();
  });

  it('AccordionView: stradella bass = full 6×12 grid (72 points)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}`,
                getAccordionConfig: () => ({ bass_system: 'stradella',
                  right_display: 'buttons' }) };
    const v = new (win.AccordionView)();
    v.mount({ modal: m });
    expect(document.querySelectorAll('.accordion-bass .accordion-key').length).toBe(72);
    expect(document.querySelector('.accordion-bass.accordion-stradella')).not.toBeNull();
    v.unmount();
  });

  it('AccordionView: free-bass uses configured span, decoupled from treble (no negatives)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}`,
                // a low treble range used to make the OLD bHi-23 derivation
                // produce negative MIDI notes — must no longer matter.
                getInstrumentNoteRange: () => ({ min: 12, max: 35, notes: null }),
                getAccordionConfig: () => ({ bass_system: 'free',
                  right_display: 'buttons', bass_range: { min: 48, max: 52 } }) };
    const v = new (win.AccordionView)();
    v.mount({ modal: m });
    const bass = [...document.querySelectorAll('.accordion-bass .accordion-key')];
    const notes = bass.map(b => parseInt(b.dataset.note, 10));
    expect(notes).toEqual([48, 49, 50, 51, 52]);   // from config, not derived
    expect(notes.every(n => n >= 0)).toBe(true);   // negative-note bug fixed
    expect(bass.length).not.toBe(12);              // not Stradella
    v.unmount();
  });

  it('AccordionView: free-bass with no configured range → C2..C4 default', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}`,
                getAccordionConfig: () => ({ bass_system: 'free',
                  right_display: 'buttons' }) };
    const v = new (win.AccordionView)();
    v.mount({ modal: m });
    const bass = [...document.querySelectorAll('.accordion-bass .accordion-key')];
    const notes = bass.map(b => parseInt(b.dataset.note, 10));
    expect(notes[0]).toBe(36);
    expect(notes[notes.length - 1]).toBe(60);      // FREE_BASS_LO..FREE_BASS_HI
    v.unmount();
  });
});

describe('note colours — 🎨 applies to every instrument view', () => {
  it('KeyboardModal.getNoteColor: octave-invariant 12-colour palette', () => {
    const m = new (win.KeyboardModal)();
    expect(m.getNoteColor(60)).toEqual(m.getNoteColor(72));   // C == C
    expect(m.getNoteColor(60).bg).toBe('#EF4444');            // C red
    expect(m.getNoteColor(61).bg).toBe('#F4622A');            // C#
    expect(m.getNoteColor(59).bg).toBe('#A855F7');            // B violet
    expect(m.getNoteColor(0)).toEqual(m.getNoteColor(120));   // wraps
  });

  const VIEWS = [
    ['HarmonicaView', 'harmonica-container', '.harmonica-hole'],
    ['HarpView', 'harp-container', '.harp-string'],
    ['AccordionView', 'accordion-container', '.accordion-key'],
    ['MalletView', 'mallet-container', '.mallet-bar'],
    ['KalimbaView', 'kalimba-container', '.kalimba-tine'],
    ['BagpipeView', 'bagpipe-container', '.bagpipe-hole'],
    ['SteelDrumView', 'steel-drum-container', '.steel-section'],
    ['PercussionPadView', 'perc-pad-container', '.perc-pad'],
  ];

  for (const [cls, containerId, sel] of VIEWS) {
    it(`${cls}: cells get the chromatic colour only when showNoteColors`, () => {
      document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
      const modal = {
        playNote() {}, stopNote() {}, sendCC() {},
        getNoteLabel: (n) => `N${n}`,
        showNoteColors: false,
        getNoteColor: () => ({ bg: 'rgb(1, 2, 3)', text: 'rgb(255, 255, 255)' })
      };
      // OFF → no forced colour
      let v = new (win[cls])();
      v.mount({ modal });
      const offBg = document.querySelector(`${containerId ? '#' + containerId + ' ' : ''}${sel}`).style.background;
      expect(offBg).not.toBe('rgb(1, 2, 3)');
      v.unmount();
      // ON → every cell painted with getNoteColor().bg
      modal.showNoteColors = true;
      v = new (win[cls])();
      v.mount({ modal });
      const cells = document.querySelectorAll(`#${containerId} ${sel}`);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell.style.background).toBe('rgb(1, 2, 3)');
      }
      v.unmount();
    });
  }

  it('the 🎨 toggle rerenders a self-owned view (live colour update)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const modal = {
      playNote() {}, stopNote() {}, getNoteLabel: (n) => `N${n}`,
      showNoteColors: false,
      getNoteColor: () => ({ bg: 'rgb(9, 9, 9)', text: 'rgb(0, 0, 0)' })
    };
    const v = new (win.KalimbaView)();
    v.mount({ modal });
    expect(document.querySelector('.kalimba-tine').style.background).not.toBe('rgb(9, 9, 9)');
    modal.showNoteColors = true;          // user clicks 🎨
    v.rerender();                          // what the toggle handler calls
    for (const t of document.querySelectorAll('.kalimba-tine')) {
      expect(t.style.background).toBe('rgb(9, 9, 9)');
    }
    v.unmount();
  });
});

describe('kalimba — top-down orientation + tine labels + notation', () => {
  let sink, modal, v;
  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    sink = { played: [], stopped: [], cc: [] };
    modal = mkModal(sink);
    modal.getNoteLabel = (n) => `US${n}`;            // simulate US format
    v = new (win.KalimbaView)();
    v.mount({ modal });
  });
  afterEach(() => { try { v.unmount(); } catch { /* */ } });

  it('is anchored at the top (played from top → bottom)', () => {
    const root = document.getElementById('kalimba-container');
    expect(root.style.alignItems).toBe('flex-start');
  });

  it('every tine shows its note label via modal.getNoteLabel', () => {
    const tines = [...document.querySelectorAll('.kalimba-tine')];
    expect(tines.length).toBe(17);
    for (const t of tines) {
      const lbl = t.querySelector('.kalimba-tine-label');
      expect(lbl).not.toBeNull();
      expect(lbl.textContent).toBe(`US${t.dataset.note}`);
    }
  });

  it('rerender() rebuilds the labels with the new notation format', () => {
    const note0 = document.querySelector('.kalimba-tine').dataset.note;
    expect(document.querySelector('.kalimba-tine-label').textContent).toBe(`US${note0}`);
    modal.getNoteLabel = (n) => `${n}`;              // switch to MIDI format
    v.rerender();
    const t0 = document.querySelector('.kalimba-tine');
    expect(t0.querySelector('.kalimba-tine-label').textContent).toBe(`${t0.dataset.note}`);
    // still playable after rerender
    fire(t0, 'pointerdown');
    expect(sink.played).toContain(parseInt(t0.dataset.note, 10));
  });

  it('label span does not block plucking (closest resolves to the tine)', () => {
    const lbl = document.querySelector('.kalimba-tine-label');
    fire(lbl, 'pointerdown');
    expect(sink.played.length).toBe(1);
  });
});

describe('bagpipe — drone lifecycle', () => {
  let sink, view;
  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    sink = { played: [], stopped: [], cc: [] };
    view = new (win.BagpipeView)();
    view.mount({ modal: mkModal(sink) });
  });
  afterEach(() => { try { view.unmount(); } catch { /* idempotent */ } });

  it('drone sounds on mount and the toggle stops/starts it', () => {
    expect(sink.played).toContain(45);                 // drone A2 on mount
    document.getElementById('bagpipe-drone-toggle').click();
    expect(sink.stopped).toContain(45);                // toggled off
    document.getElementById('bagpipe-drone-toggle').click();
    expect(sink.played.filter(n => n === 45).length).toBe(2); // back on
  });

  it('chanter holes play independently of the drone', () => {
    const hole = document.querySelector('.bagpipe-hole');
    const note = parseInt(hole.dataset.note, 10);
    fire(hole, 'pointerdown');
    expect(sink.played).toContain(note);
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped).toContain(note);
  });

  it('unmount() stops the drone and removes the container', () => {
    view.unmount();
    expect(sink.stopped).toContain(45);
    expect(document.getElementById('bagpipe-container')).toBeNull();
  });
});

describe('theremin — 2-D pitch/volume pad', () => {
  let sink, view;
  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    sink = { played: [], stopped: [], cc: [] };
    view = new (win.ThereminView)();
    view.mount({ modal: mkModal(sink) });
  });
  afterEach(() => { try { view.unmount(); } catch { /* idempotent */ } });

  it('pointerdown starts a note from X and sends volume CC from Y', () => {
    const pad = document.getElementById('theremin-container');
    // jsdom has no layout → fallback PAD_W=480: x=240/480=0.5 → note 66
    fire(pad, 'pointerdown', { clientX: 240, clientY: 0 });
    expect(sink.played).toEqual([66]);
    expect(sink.cc.some(([c]) => c === 7)).toBe(true);   // volume CC#7
  });

  it('dragging across a semitone retriggers the note', () => {
    const pad = document.getElementById('theremin-container');
    fire(pad, 'pointerdown', { clientX: 0, clientY: 0 });   // note 48
    fire(pad, 'pointermove', { clientX: 480, clientY: 0 }); // note 84
    expect(sink.played).toEqual([48, 84]);
    expect(sink.stopped).toEqual([48]);                     // old note released
  });

  it('pointerup stops the note; unmount cleans up', () => {
    const pad = document.getElementById('theremin-container');
    fire(pad, 'pointerdown', { clientX: 240, clientY: 10 });
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped).toEqual([66]);
    view.unmount();
    expect(document.getElementById('theremin-container')).toBeNull();
  });
});
