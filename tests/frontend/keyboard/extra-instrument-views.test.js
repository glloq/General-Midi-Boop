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
  load('../../../public/js/features/keyboard/HarmonicaLayout.js');
  for (const v of [
    'PianoView',
    'FretboardView',
    'DrumPadView',
    'PianoSliderView',
    'ListView',
    'HarmonicaView',
    'HarpView',
    'AccordionView',
    'MalletView',
    'MusicBoxView',
    'KalimbaView',
    'BagpipeView',
    'SteelDrumView',
    'ThereminView',
    'PercussionPadView'
  ]) {
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
    ['accordion', (win) => win.AccordionView, { gm_program: 21 }],
    ['accordion', (win) => win.AccordionView, { gm_program: 23 }],
    ['mallet', (win) => win.MalletView, { gm_program: 12 }],
    ['mallet', (win) => win.MalletView, { gm_program: 15 }],
    ['kalimba', (win) => win.KalimbaView, { gm_program: 108 }],
    ['bagpipe', (win) => win.BagpipeView, { gm_program: 109 }],
    ['steel-drum', (win) => win.SteelDrumView, { gm_program: 114 }],
    ['theremin', (win) => win.ThereminView, { instrument_type: 'theremin' }],
    ['mallet', (win) => win.MalletView, { gm_program: 9 }],
    ['mallet', (win) => win.MalletView, { gm_program: 11 }],
    ['music-box', (win) => win.MusicBoxView, { gm_program: 10 }],
    ['perc-pad', (win) => win.PercussionPadView, { gm_program: 112 }],
    ['perc-pad', (win) => win.PercussionPadView, { gm_program: 127 }]
  ];

  for (const [kind, cls, caps] of expectations) {
    it(`${JSON.stringify(caps)} → ${kind} (detector + registry agree)`, () => {
      expect(typeof cls(win)).toBe('function');
      expect(win.instrumentViews.get(kind)).toBe(cls(win));
      expect(win.InstrumentDetector.detect({ capabilities: caps }).viewKind).toBe(kind);
      expect(win.instrumentViews.resolve(caps).viewKind).toBe(kind);
    });
  }

  it('GM 22 harmonica; 9/11 mallet; 10 music-box; 8/16/47 piano', () => {
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 22 } }).viewKind).toBe(
      'harmonica'
    );
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 9 } }).viewKind).toBe(
      'mallet'
    );
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 11 } }).viewKind).toBe(
      'mallet'
    );
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 10 } }).viewKind).toBe(
      'music-box'
    );
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 8 } }).viewKind).toBe(
      'piano'
    );
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 47 } }).viewKind).toBe(
      'piano'
    );
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 16 } }).viewKind).toBe(
      'piano'
    );
  });

  it('GM 111 (Shanai) → piano-slider (reed, non-contiguous with 56-79)', () => {
    const windDb = {
      isWindInstrument: (p) => (p >= 56 && p <= 79) || p === 111,
      getPresetByProgram: (p) => ({ name: `wind-${p}` })
    };
    expect(win.instrumentViews.get('piano-slider')).toBe(win.PianoSliderView);
    expect(
      win.InstrumentDetector.detect({
        capabilities: { gm_program: 111 },
        windDb
      }).viewKind
    ).toBe('piano-slider');
    expect(win.instrumentViews.resolve({ gm_program: 111 }).viewKind).toBe('piano-slider');
    expect(win.instrumentViews.resolve({ gm_program: 111 }).options.wind).toBe(true);
  });

  it('theremin type wins even with a GM patch present', () => {
    expect(
      win.InstrumentDetector.detect({
        capabilities: { instrument_type: 'theremin', gm_program: 80 }
      }).viewKind
    ).toBe('theremin');
  });
});

// ── Pluck-style views: identical lifecycle contract ─────────────────────────
describe.each([
  ['accordion', 'accordion-container', '.accordion-key'],
  ['mallet', 'mallet-container', '.mallet-bar'],
  ['music-box', 'music-box-container', '.music-box-tooth'],
  ['kalimba', 'kalimba-container', '.kalimba-tine'],
  ['steel-drum', 'steel-drum-container', '.steel-section'],
  ['perc-pad', 'perc-pad-container', '.perc-pad']
])('%s — self-owned DOM lifecycle', (kind, containerId, cellSel) => {
  let sink, modal, view;
  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    sink = { played: [], stopped: [], cc: [] };
    modal = mkModal(sink);
    view = new (win.instrumentViews.get(kind))();
    view.mount({ modal });
  });
  afterEach(() => {
    try {
      view.unmount();
    } catch {
      /* idempotent */
    }
  });

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

  it('pointer drag glissando: new cell sounds, previous released (piano-like)', () => {
    const root = document.getElementById(containerId);
    const cells = [...root.querySelectorAll(cellSel)];
    const a = cells[0];
    const b = cells.find((c) => c.dataset.note !== a.dataset.note) || cells[1];
    const nA = parseInt(a.dataset.note, 10);
    const nB = parseInt(b.dataset.note, 10);
    fire(a, 'pointerdown');
    expect(sink.played).toContain(nA);
    fire(b, 'pointermove'); // drag onto the next cell
    expect(sink.stopped).toContain(nA); // previous released (monophonic)
    expect(sink.played).toContain(nB); // new cell sounded
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped).toContain(nB);
    expect(root.querySelectorAll(`${cellSel}.active`).length).toBe(0); // no stuck
  });

  it('pointermove without a prior pointerdown is a no-op (hover safe)', () => {
    const root = document.getElementById(containerId);
    const cell = root.querySelector(cellSel);
    fire(cell, 'pointermove');
    expect(sink.played).toEqual([]);
  });

  it('unmount() removes the container and is idempotent', () => {
    view.unmount();
    expect(document.getElementById(containerId)).toBeNull();
    expect(view.mounted).toBe(false);
    expect(() => view.unmount()).not.toThrow();
  });

  it('_activateView resolves & mounts it, switching unmounts it', () => {
    const m = new win.KeyboardModal();
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
      getAccordionConfig: () => cfg
    };
    v = new win.AccordionView();
    v.mount({ modal });
  };
  afterEach(() => {
    try {
      v.unmount();
    } catch {
      /* idempotent */
    }
  });

  it('Stradella bass = 6 rows × 12 circle-of-fifths columns (72 points)', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    expect(document.querySelectorAll('.accordion-bass .accordion-key').length).toBe(72);
    expect(document.querySelector('.accordion-stradella')).not.toBeNull();
  });

  it('a Stradella chord button plays its full multi-note chord', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    // Row order: CB, B, M, m, 7, °. The "M" (major) button of the C
    // column triggers a 3-note chord.
    const major = [...document.querySelectorAll('.accordion-bass .accordion-key')].find((b) =>
      /N\d+M$/.test(b.title)
    );
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
    mount({ bass_system: 'free', right_display: 'keyboard', bass_range: { min: 36, max: 47 } });
    const board = document.querySelector('.accordion-bass.accordion-board');
    expect(board).not.toBeNull();
    expect(board.querySelectorAll('.accordion-key').length).toBe(12);
  });

  it('glissando: sliding onto a new key releases the old and plays the new', () => {
    mount({ bass_system: 'free', right_display: 'buttons', bass_range: { min: 36, max: 47 } });
    const keys = [...document.querySelectorAll('.accordion-bass .accordion-key')];
    const n0 = parseInt(keys[0].dataset.note, 10);
    const n1 = parseInt(keys[1].dataset.note, 10);
    fire(keys[0], 'pointerdown');
    expect(sink.played).toContain(n0);
    fire(keys[1], 'pointermove'); // slide onto the next key
    expect(sink.stopped).toContain(n0); // previous released
    expect(sink.played).toContain(n1); // new one sounding
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped).toContain(n1);
  });

  it('glissando: no slide before pointerdown (move alone is inert)', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    const key = document.querySelector('.accordion-bass .accordion-key');
    fire(key, 'pointermove');
    expect(sink.played).toEqual([]);
  });

  it('treble: pressing a button lights its twin (C-griff helper rank); bass never lit', () => {
    mount({ bass_system: 'stradella', right_display: 'buttons' });
    const treble = [...document.querySelectorAll('.accordion-treble .accordion-key')];
    // A pitch lives on >=2 treble buttons (3 principal + 2 helper ranks).
    const byNote = new Map();
    treble.forEach((b) => {
      const n = b.dataset.note;
      if (!byNote.has(n)) byNote.set(n, []);
      byNote.get(n).push(b);
    });
    const twins = [...byNote.values()].find((arr) => arr.length >= 2);
    expect(twins).toBeTruthy();
    fire(twins[0], 'pointerdown');
    expect(twins[0].classList.contains('active')).toBe(true);
    expect(twins[1].classList.contains('active')).toBe(true); // twin lit too
    expect(document.querySelectorAll('.accordion-bass .accordion-key.active').length).toBe(0); // bass untouched
    document.dispatchEvent(new Event('pointerup'));
    expect(document.querySelectorAll('.accordion-key.active').length).toBe(0);
  });
});

describe('configured note range (QA) — views follow instrument settings', () => {
  const rangedModal = (min, max) => ({
    playNote() {},
    stopNote() {},
    sendCC() {},
    getNoteLabel: (n) => `N${n}`,
    getInstrumentNoteRange: () => ({ min, max, notes: null })
  });

  it('MalletView: piano-like layout, bar count follows the range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new win.MalletView();
    v.mount({ modal: rangedModal(60, 64) }); // C4..E4
    const bars = [...document.querySelectorAll('.mallet-bar')];
    // 60 C,61 C#,62 D,63 D#,64 E → 3 naturals + 2 accidentals
    expect(bars.map((b) => b.dataset.note)).toEqual(['60', '61', '62', '63', '64']);
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
    const v = new win.MalletView();
    v.mount({ modal: { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}` } });
    const bars = document.querySelectorAll('.mallet-bar');
    expect(bars.length).toBe(24); // 60..83
    v.unmount();
  });

  it('SteelDrumView: section count follows the range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new win.SteelDrumView();
    v.mount({ modal: rangedModal(48, 59) }); // 12 notes
    expect(document.querySelectorAll('.steel-section').length).toBe(12);
    v.unmount();
  });

  it('HarpView: diatonic strings within the range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new win.HarpView();
    v.mount({ modal: rangedModal(60, 64) }); // C,D,E in C-major
    expect([...document.querySelectorAll('.harp-string')].map((s) => s.dataset.note)).toEqual([
      '60',
      '62',
      '64'
    ]);
    v.unmount();
  });

  it('KalimbaView: tine count follows the range (chromatic, incl. sharps)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new win.KalimbaView();
    v.mount({ modal: rangedModal(60, 71) }); // C..B = 12 chromatic
    const notes = [...document.querySelectorAll('.kalimba-tine')]
      .map((t) => parseInt(t.dataset.note, 10))
      .sort((a, b) => a - b);
    expect(notes.length).toBe(12);
    expect(notes).toContain(61); // C#4 — sharp shown
    v.unmount();
  });

  it('HarmonicaView: holes trimmed to the configured range', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new win.HarmonicaView();
    v.mount({ modal: rangedModal(60, 72) }); // Richter from 60, ≤72
    const blow = [...document.querySelectorAll('.harmonica-blow')].map((b) =>
      parseInt(b.dataset.note, 10)
    );
    expect(blow[0]).toBe(60);
    expect(Math.max(...blow)).toBeLessThanOrEqual(72);
    expect(blow.length).toBeLessThan(10); // trimmed vs full 10
    v.unmount();
  });

  it('BagpipeView: chanter follows the range, drones silent on mount', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getInstrumentNoteRange = () => ({ min: 55, max: 60, notes: null });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    const ch = [...document.querySelectorAll('.bagpipe-hole')].map((h) =>
      parseInt(h.dataset.note, 10)
    );
    expect(ch[0]).toBe(55);
    expect(Math.max(...ch)).toBeLessThanOrEqual(60);
    expect(sink.played).not.toContain(45); // no auto-start
    v.unmount();
  });
});

describe('instrument-specific settings (QA #3) — bagpipe + accordion', () => {
  it('getBagpipeConfig: defaults + normalizes legacy/object shapes', () => {
    const m = new win.KeyboardModal();
    expect(m.getBagpipeConfig()).toEqual({
      drones: [45],
      droneObjs: [{ note: 45, enabled: true }],
      enabled: true
    });
    // legacy number[] → all enabled
    m.selectedDeviceCapabilities = { bagpipe_config: { drones: [45, 45, 33], enabled: false } };
    expect(m.getBagpipeConfig()).toEqual({
      drones: [45, 45, 33],
      droneObjs: [
        { note: 45, enabled: true },
        { note: 45, enabled: true },
        { note: 33, enabled: true }
      ],
      enabled: false
    });
    // object shape: `drones` keeps only enabled notes, `droneObjs` keeps all
    m.selectedDeviceCapabilities = {
      bagpipe_config: {
        drones: [
          { note: 33, enabled: true },
          { note: 45, enabled: false }
        ]
      }
    };
    const cfg = m.getBagpipeConfig();
    expect(cfg.drones).toEqual([33]);
    expect(cfg.droneObjs).toEqual([
      { note: 33, enabled: true },
      { note: 45, enabled: false }
    ]);
    m.selectedDeviceCapabilities = { bagpipe_config: { drones: [] } };
    expect(m.getBagpipeConfig().drones).toEqual([45]); // empty → default
  });

  it('getAccordionConfig: defaults + normalizes caps.accordion_config (no hands)', () => {
    const ALL = ['counterbass', 'bass', 'major', 'minor', 'dom7', 'dim7'];
    const m = new win.KeyboardModal();
    expect(m.getAccordionConfig()).toEqual({
      bass_system: 'stradella',
      right_display: 'buttons',
      bass_range: { min: 36, max: 60 },
      bass_cols: 12,
      bass_base: 36,
      bass_funcs: ALL
    });
    m.selectedDeviceCapabilities = {
      accordion_config: {
        bass_system: 'free',
        right_display: 'keyboard',
        hands: 'left',
        bass_range: { min: 48, max: 55 }
      }
    };
    // `hands` is ignored — only per-side play possibilities are kept.
    expect(m.getAccordionConfig()).toEqual({
      bass_system: 'free',
      right_display: 'keyboard',
      bass_range: { min: 48, max: 55 },
      bass_cols: 12,
      bass_base: 36,
      bass_funcs: ALL
    });
    // legacy 'chromatic' normalized → 'free'
    m.selectedDeviceCapabilities = { accordion_config: { bass_system: 'chromatic' } };
    expect(m.getAccordionConfig().bass_system).toBe('free');
    // malformed range → C2..C4 default; inverted → swapped
    m.selectedDeviceCapabilities = { accordion_config: { bass_range: { min: 200 } } };
    expect(m.getAccordionConfig().bass_range).toEqual({ min: 36, max: 60 });
    m.selectedDeviceCapabilities = { accordion_config: { bass_range: { min: 70, max: 40 } } };
    expect(m.getAccordionConfig().bass_range).toEqual({ min: 40, max: 70 });
    // Stradella geometry: clamped + normalized; bad funcs → all six
    m.selectedDeviceCapabilities = {
      accordion_config: { bass_cols: 8, bass_base: 41, bass_funcs: ['bass', 'major', 'bogus'] }
    };
    const g = m.getAccordionConfig();
    expect(g.bass_cols).toBe(8);
    expect(g.bass_base).toBe(41);
    expect(g.bass_funcs).toEqual(['bass', 'major']);
    m.selectedDeviceCapabilities = {
      accordion_config: { bass_cols: 99, bass_base: 999, bass_funcs: [] }
    };
    const g2 = m.getAccordionConfig();
    expect(g2.bass_cols).toBe(12);
    expect(g2.bass_base).toBe(36);
    expect(g2.bass_funcs).toEqual(ALL);
    m.selectedDeviceCapabilities = {
      accordion_config: { bass_system: 'bogus', right_display: 'z' }
    };
    expect(m.getAccordionConfig()).toEqual({
      bass_system: 'stradella',
      right_display: 'buttons',
      bass_range: { min: 36, max: 60 },
      bass_cols: 12,
      bass_base: 36,
      bass_funcs: ALL
    });
  });

  it('AccordionView: both sides ALWAYS present (no hand show/hide)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = {
      playNote() {},
      stopNote() {},
      getNoteLabel: (n) => `${n}`,
      getAccordionConfig: () => ({ bass_system: 'stradella', right_display: 'buttons' })
    };
    const v = new win.AccordionView();
    v.mount({ modal: m });
    expect(document.querySelector('.accordion-bass')).not.toBeNull();
    expect(document.querySelector('.accordion-treble')).not.toBeNull();
    // two bordered side panels, no caption text
    expect(document.querySelectorAll('.accordion-zone').length).toBe(2);
    expect(document.querySelector('.accordion-zone-title')).toBeNull();
    v.unmount();
  });

  it('AccordionView: right_display=keyboard → piano-style right side', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = {
      playNote() {},
      stopNote() {},
      getNoteLabel: (n) => `${n}`,
      getInstrumentNoteRange: () => ({ min: 60, max: 71, notes: null }),
      getAccordionConfig: () => ({ bass_system: 'stradella', right_display: 'keyboard' })
    };
    const v = new win.AccordionView();
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

  it('BagpipeView: silent on mount; master button toggles every drone', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({ drones: [45, 33, 57], enabled: true });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    expect(sink.played.filter((n) => [45, 33, 57].includes(n))).toEqual([]); // no auto-start
    document.getElementById('bagpipe-drone-toggle').click(); // all on
    expect(sink.played.filter((n) => [45, 33, 57].includes(n)).sort()).toEqual([33, 45, 57]);
    document.getElementById('bagpipe-drone-toggle').click(); // all off
    expect(sink.stopped.filter((n) => [45, 33, 57].includes(n)).sort()).toEqual([33, 45, 57]);
    v.unmount();
  });

  it('BagpipeView: rerender() keeps sounding drones on across a rebuild', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({ drones: [45, 33], enabled: true });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    document.getElementById('bagpipe-drone-toggle').click(); // all on
    sink.played.length = 0;
    sink.stopped.length = 0;
    v.rerender(); // US/FR/MIDI toggle
    expect(
      v._drones
        .filter((d) => d.on)
        .map((d) => d.note)
        .sort()
    ).toEqual([33, 45]);
    expect(sink.played.filter((n) => [33, 45].includes(n)).sort()).toEqual([33, 45]); // restarted
    v.unmount();
  });

  it('BagpipeView: chanter supports piano-like glissando; drones unaffected', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({
      drones: [45],
      droneObjs: [{ note: 45, enabled: true }],
      enabled: true
    });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    const holes = [...document.querySelectorAll('.bagpipe-hole')];
    const nA = parseInt(holes[0].dataset.note, 10);
    const nB = parseInt(holes[1].dataset.note, 10);
    fire(holes[0], 'pointerdown');
    expect(sink.played).toContain(nA);
    fire(holes[1], 'pointermove'); // glide along the chanter
    expect(sink.stopped).toContain(nA);
    expect(sink.played).toContain(nB);
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped).toContain(nB);
    expect(sink.played).not.toContain(45); // drone never auto-sounds
    v.unmount();
  });

  it('BagpipeView: drones never auto-start, even when enabled in settings', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({ drones: [45], enabled: true });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    expect(sink.played).not.toContain(45);
    document.getElementById('bagpipe-drone-toggle').click(); // user starts it
    expect(sink.played).toContain(45);
    v.unmount();
  });

  it('BagpipeView: renders a master + one button per configured drone', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({
      drones: [33, 45],
      droneObjs: [
        { note: 33, enabled: true },
        { note: 45, enabled: true }
      ],
      enabled: true
    });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    expect(document.getElementById('bagpipe-drone-toggle')).not.toBeNull();
    expect(document.querySelectorAll('.bagpipe-drone-one').length).toBe(2);
    v.unmount();
  });

  it('BagpipeView: per-drone buttons live inside the master control', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({
      drones: [33, 45],
      droneObjs: [
        { note: 33, enabled: true },
        { note: 45, enabled: true }
      ],
      enabled: true
    });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    const box = document.querySelector('.bagpipe-drones');
    const master = document.getElementById('bagpipe-drone-toggle');
    expect(box.contains(master)).toBe(true);
    const ones = box.querySelectorAll('.bagpipe-drone-one');
    expect(ones.length).toBe(2);
    ones.forEach((o) => expect(box.contains(o)).toBe(true)); // nested in master box
    v.unmount();
  });

  it('BagpipeView: individual toggle affects only its own drone', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({
      drones: [33, 45],
      droneObjs: [
        { note: 33, enabled: true },
        { note: 45, enabled: true }
      ],
      enabled: true
    });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    expect(sink.played.filter((n) => [33, 45].includes(n))).toEqual([]); // silent on mount
    const btn0 = document.querySelector('.bagpipe-drone-one[data-idx="0"]');
    const btn1 = document.querySelector('.bagpipe-drone-one[data-idx="1"]');
    btn0.click(); // 33 on
    btn1.click(); // 45 on
    expect(sink.played.filter((n) => [33, 45].includes(n)).sort()).toEqual([33, 45]);
    btn1.click(); // 45 off only
    expect(sink.stopped.filter((n) => [33, 45].includes(n))).toEqual([45]);
    v.unmount();
  });

  it('BagpipeView: duplicate drone notes are reference-counted', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({
      // Great Highland: 33, 45, 45
      drones: [33, 45, 45],
      droneObjs: [
        { note: 33, enabled: true },
        { note: 45, enabled: true },
        { note: 45, enabled: true }
      ],
      enabled: true
    });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    const b1 = document.querySelector('.bagpipe-drone-one[data-idx="1"]');
    const b2 = document.querySelector('.bagpipe-drone-one[data-idx="2"]');
    b1.click(); // first 45 on
    b2.click(); // second 45 on
    expect(sink.played.filter((n) => n === 45).length).toBe(1); // played once (ref count)
    b1.click(); // one 45 off
    expect(sink.stopped.filter((n) => n === 45).length).toBe(0); // still sounding
    b2.click(); // last 45 off
    expect(sink.stopped.filter((n) => n === 45).length).toBe(1);
    v.unmount();
  });

  it('BagpipeView: every configured drone gets a button regardless of settings flag', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const sink = { played: [], stopped: [], cc: [] };
    const m = mkModal(sink);
    m.getBagpipeConfig = () => ({
      drones: [33],
      droneObjs: [
        { note: 33, enabled: true },
        { note: 45, enabled: false }
      ],
      enabled: true
    });
    const v = new win.BagpipeView();
    v.mount({ modal: m });
    expect(sink.played.filter((n) => [33, 45].includes(n))).toEqual([]); // nothing auto-starts
    expect(document.querySelectorAll('.bagpipe-drone-one').length).toBe(2);
    document.querySelector('.bagpipe-drone-one[data-idx="1"]').click(); // enable 45
    expect(sink.played).toContain(45);
    v.unmount();
  });

  it('AccordionView: stradella bass = full 6×12 grid (72 points)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = {
      playNote() {},
      stopNote() {},
      getNoteLabel: (n) => `${n}`,
      getAccordionConfig: () => ({ bass_system: 'stradella', right_display: 'buttons' })
    };
    const v = new win.AccordionView();
    v.mount({ modal: m });
    expect(document.querySelectorAll('.accordion-bass .accordion-key').length).toBe(72);
    expect(document.querySelector('.accordion-bass.accordion-stradella')).not.toBeNull();
    v.unmount();
  });

  it('AccordionView: free-bass uses configured span, decoupled from treble (no negatives)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = {
      playNote() {},
      stopNote() {},
      getNoteLabel: (n) => `${n}`,
      // a low treble range used to make the OLD bHi-23 derivation
      // produce negative MIDI notes — must no longer matter.
      getInstrumentNoteRange: () => ({ min: 12, max: 35, notes: null }),
      getAccordionConfig: () => ({
        bass_system: 'free',
        right_display: 'buttons',
        bass_range: { min: 48, max: 52 }
      })
    };
    const v = new win.AccordionView();
    v.mount({ modal: m });
    const bass = [...document.querySelectorAll('.accordion-bass .accordion-key')];
    const notes = bass.map((b) => parseInt(b.dataset.note, 10));
    expect(notes).toEqual([48, 49, 50, 51, 52]); // from config, not derived
    expect(notes.every((n) => n >= 0)).toBe(true); // negative-note bug fixed
    expect(bass.length).not.toBe(12); // not Stradella
    v.unmount();
  });

  it('AccordionView: free-bass with no configured range → C2..C4 default', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const m = {
      playNote() {},
      stopNote() {},
      getNoteLabel: (n) => `${n}`,
      getAccordionConfig: () => ({ bass_system: 'free', right_display: 'buttons' })
    };
    const v = new win.AccordionView();
    v.mount({ modal: m });
    const bass = [...document.querySelectorAll('.accordion-bass .accordion-key')];
    const notes = bass.map((b) => parseInt(b.dataset.note, 10));
    expect(notes[0]).toBe(36);
    expect(notes[notes.length - 1]).toBe(60); // FREE_BASS_LO..FREE_BASS_HI
    v.unmount();
  });
});

describe('note colours — 🎨 applies to every instrument view', () => {
  it('KeyboardModal.getNoteColor: octave-invariant 12-colour palette', () => {
    const m = new win.KeyboardModal();
    expect(m.getNoteColor(60)).toEqual(m.getNoteColor(72)); // C == C
    expect(m.getNoteColor(60).bg).toBe('#EF4444'); // C red
    expect(m.getNoteColor(61).bg).toBe('#F4622A'); // C#
    expect(m.getNoteColor(59).bg).toBe('#A855F7'); // B violet
    expect(m.getNoteColor(0)).toEqual(m.getNoteColor(120)); // wraps
  });

  const VIEWS = [
    ['HarmonicaView', 'harmonica-container', '.harmonica-hole'],
    ['HarpView', 'harp-container', '.harp-string'],
    ['AccordionView', 'accordion-container', '.accordion-key'],
    ['MalletView', 'mallet-container', '.mallet-bar'],
    ['KalimbaView', 'kalimba-container', '.kalimba-tine'],
    ['BagpipeView', 'bagpipe-container', '.bagpipe-hole'],
    ['SteelDrumView', 'steel-drum-container', '.steel-section'],
    ['PercussionPadView', 'perc-pad-container', '.perc-pad']
  ];

  for (const [cls, containerId, sel] of VIEWS) {
    it(`${cls}: cells get the chromatic colour only when showNoteColors`, () => {
      document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
      const modal = {
        playNote() {},
        stopNote() {},
        sendCC() {},
        getNoteLabel: (n) => `N${n}`,
        showNoteColors: false,
        getNoteColor: () => ({ bg: 'rgb(1, 2, 3)', text: 'rgb(255, 255, 255)' })
      };
      // OFF → no forced colour
      let v = new win[cls]();
      v.mount({ modal });
      const offBg = document.querySelector(`${containerId ? '#' + containerId + ' ' : ''}${sel}`)
        .style.background;
      expect(offBg).not.toBe('rgb(1, 2, 3)');
      v.unmount();
      // ON → every cell painted with getNoteColor().bg
      modal.showNoteColors = true;
      v = new win[cls]();
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
      playNote() {},
      stopNote() {},
      getNoteLabel: (n) => `N${n}`,
      showNoteColors: false,
      getNoteColor: () => ({ bg: 'rgb(9, 9, 9)', text: 'rgb(0, 0, 0)' })
    };
    const v = new win.KalimbaView();
    v.mount({ modal });
    expect(document.querySelector('.kalimba-tine').style.background).not.toBe('rgb(9, 9, 9)');
    modal.showNoteColors = true; // user clicks 🎨
    v.rerender(); // what the toggle handler calls
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
    modal.getNoteLabel = (n) => `US${n}`; // simulate US format
    v = new win.KalimbaView();
    v.mount({ modal });
  });
  afterEach(() => {
    try {
      v.unmount();
    } catch {
      /* */
    }
  });

  it('is anchored at the top (played from top → bottom)', () => {
    const root = document.getElementById('kalimba-container');
    // Top-anchored flex layout is now provided by the .kalimba-view
    // rule in keyboard.css (wooden body + resonance hole live there too).
    expect(root.classList.contains('kalimba-view')).toBe(true);
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
    modal.getNoteLabel = (n) => `${n}`; // switch to MIDI format
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
    view = new win.BagpipeView();
    view.mount({ modal: mkModal(sink) });
  });
  afterEach(() => {
    try {
      view.unmount();
    } catch {
      /* idempotent */
    }
  });

  it('drone is silent on mount and the toggle starts/stops it', () => {
    expect(sink.played).not.toContain(45); // no auto-start
    document.getElementById('bagpipe-drone-toggle').click();
    expect(sink.played).toContain(45); // toggled on
    document.getElementById('bagpipe-drone-toggle').click();
    expect(sink.stopped).toContain(45); // toggled off
  });

  it('chanter holes play independently of the drone', () => {
    const hole = document.querySelector('.bagpipe-hole');
    const note = parseInt(hole.dataset.note, 10);
    fire(hole, 'pointerdown');
    expect(sink.played).toContain(note);
    document.dispatchEvent(new Event('pointerup'));
    expect(sink.stopped).toContain(note);
  });

  it('unmount() stops a running drone and removes the container', () => {
    document.getElementById('bagpipe-drone-toggle').click(); // start it
    expect(sink.played).toContain(45);
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
    view = new win.ThereminView();
    view.mount({ modal: mkModal(sink) });
  });
  afterEach(() => {
    try {
      view.unmount();
    } catch {
      /* idempotent */
    }
  });

  it('pointerdown starts a note from X and sends volume CC from Y', () => {
    const pad = document.getElementById('theremin-container');
    // jsdom has no layout → fallback PAD_W=480: x=240/480=0.5 → note 66
    fire(pad, 'pointerdown', { clientX: 240, clientY: 0 });
    expect(sink.played).toEqual([66]);
    expect(sink.cc.some(([c]) => c === 7)).toBe(true); // volume CC#7
  });

  it('dragging across a semitone retriggers the note', () => {
    const pad = document.getElementById('theremin-container');
    fire(pad, 'pointerdown', { clientX: 0, clientY: 0 }); // note 48
    fire(pad, 'pointermove', { clientX: 480, clientY: 0 }); // note 84
    expect(sink.played).toEqual([48, 84]);
    expect(sink.stopped).toEqual([48]); // old note released
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

describe('PianoSliderView — wind controls wiring', () => {
  it('explicit ctx.options.windPreset is honoured (Shanai GM 111)', () => {
    const order = [];
    const modal = {
      generatePianoSlider: () => order.push('slider'),
      _showWindControls: (p) => order.push(`wind:${p.name}`),
      _hideWindControls: () => {},
      currentArticulation: 'normal'
    };
    const v = new win.PianoSliderView();
    v.mount({
      modal,
      options: {
        windPreset: {
          name: 'Shanai',
          gmProgram: 111,
          category: 'reed'
        }
      }
    });
    // Panel + comfort centring BEFORE the strip is rendered.
    expect(order).toEqual(['wind:Shanai', 'slider']);
    v.unmount();
  });

  it(
    'resolves the wind preset from the live instrument (flute, GM 73) — ' +
      'the production path, since _pendingViewOptions is never populated',
    () => {
      const order = [];
      const flute = {
        name: 'Flute',
        gmProgram: 73,
        category: 'pipe',
        rangeMin: 60,
        rangeMax: 96,
        comfortMin: 62,
        comfortMax: 91
      };
      const modal = {
        generatePianoSlider: () => order.push('slider'),
        _showWindControls: (p) => order.push(`wind:${p.name}`),
        _hideWindControls: () => {},
        // Same source _selectInstrumentOption uses (the detector).
        getInstrumentViewInfo: () => ({ isWind: true, windPreset: flute }),
        currentArticulation: 'normal'
      };
      const v = new win.PianoSliderView();
      v.mount({ modal, options: {} }); // ctx.options empty (real life)
      expect(order).toEqual(['wind:Flute', 'slider']); // shown, then rendered
      v.unmount();
    }
  );

  it('a wind→wind switch via setCapabilities re-syncs the panel', () => {
    const seen = [];
    const mk = (name) => ({
      name,
      gmProgram: 73,
      category: 'pipe',
      rangeMin: 60,
      rangeMax: 96,
      comfortMin: 62,
      comfortMax: 91
    });
    let current = mk('Flute');
    const modal = {
      generatePianoSlider: () => {},
      _showWindControls: (p) => seen.push(p.name),
      _hideWindControls: () => {},
      getInstrumentViewInfo: () => ({ isWind: true, windPreset: current }),
      currentArticulation: 'normal'
    };
    const v = new win.PianoSliderView();
    v.mount({ modal, options: {} });
    current = mk('Oboe');
    v.setCapabilities({});
    expect(seen).toEqual(['Flute', 'Oboe']);
    v.unmount();
  });

  it('non-wind instrument → no wind panel (slider still renders)', () => {
    const calls = { wind: 0, slider: 0 };
    const modal = {
      generatePianoSlider: () => {
        calls.slider++;
      },
      _showWindControls: () => {
        calls.wind++;
      },
      _hideWindControls: () => {},
      getInstrumentViewInfo: () => ({ isWind: false, windPreset: null }),
      currentArticulation: 'normal'
    };
    const v = new win.PianoSliderView();
    v.mount({ modal, options: {} });
    expect(calls.wind).toBe(0);
    expect(calls.slider).toBe(1);
    v.unmount();
  });
});
