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
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  for (const v of ['PianoView', 'FretboardView', 'DrumPadView', 'PianoSliderView',
                   'ListView', 'HarmonicaView', 'HarpView', 'AccordionView',
                   'MalletView', 'KalimbaView', 'BagpipeView', 'SteelDrumView',
                   'ThereminView']) {
    load(`../../../public/js/features/keyboard/views/${v}.js`);
  }
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
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
  ];

  for (const [kind, cls, caps] of expectations) {
    it(`${JSON.stringify(caps)} → ${kind} (detector + registry agree)`, () => {
      expect(typeof cls(win)).toBe('function');
      expect(win.instrumentViews.get(kind)).toBe(cls(win));
      expect(win.InstrumentDetector.detect({ capabilities: caps }).viewKind).toBe(kind);
      expect(win.instrumentViews.resolve(caps).viewKind).toBe(kind);
    });
  }

  it('GM 22 stays harmonica (not accordion); 11/16 stay piano (not mallet)', () => {
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 22 } }).viewKind).toBe('harmonica');
    expect(win.InstrumentDetector.detect({ capabilities: { gm_program: 11 } }).viewKind).toBe('piano');
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

describe('accordion — bellows scales velocity (applied on press)', () => {
  let v, modal, velAtPlay;
  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    velAtPlay = [];
    modal = {
      velocity: 100,
      playNote() { velAtPlay.push(this.velocity); },
      stopNote() {},
      getNoteLabel: (n) => `N${n}`
    };
    v = new (win.AccordionView)();
    v.mount({ modal });
  });
  afterEach(() => { try { v.unmount(); } catch { /* idempotent */ } });

  it('willPlayNote math: centre=1×, ×0.5 below, clamped above', () => {
    expect(v.willPlayNote(60, 100).velocity).toBe(100);   // bellows 64 → ×1
    const b = document.getElementById('accordion-bellows');
    b.value = '32'; b.dispatchEvent(new Event('input'));
    expect(v.willPlayNote(60, 100).velocity).toBe(50);    // ×0.5
    b.value = '127'; b.dispatchEvent(new Event('input'));
    expect(v.willPlayNote(60, 100).velocity).toBe(127);   // clamped
  });

  it('pressing a key actually sends the bellows-scaled velocity', () => {
    const b = document.getElementById('accordion-bellows');
    b.value = '32'; b.dispatchEvent(new Event('input'));     // factor 0.5
    const key = document.querySelector('.accordion-key');
    fire(key, 'pointerdown');
    expect(velAtPlay).toEqual([50]);                          // 100 × 0.5
    expect(modal.velocity).toBe(100);                         // restored after
  });

  it('centre bellows (64) leaves velocity unchanged', () => {
    fire(document.querySelector('.accordion-key'), 'pointerdown');
    expect(velAtPlay).toEqual([100]);
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
