// tests/frontend/keyboard/note-debug-trace.test.js
// Regression guard for the "no MIDI messages in the debug console" bug.
//
// Every one of the 15 instrument display views must, when played, produce
// EXACTLY ONE app-log trace per note via the shared
// KeyboardEventsMixin.playNote / stopNote, regardless of device state
// (no device selected, virtual/SF2, or real hardware).
//
// Two exercise paths:
//   • The 10 self-owned views own their DOM and wire pointer events
//     (InstrumentView._initGlide / Theremin's own pointerdown) → we mount
//     the real view and simulate a press+release on a real cell.
//   • The 5 legacy piano-family views (piano, fretboard, drumpad,
//     piano-slider, keyboard-list) delegate to the modal's legacy keyboard
//     handlers and expose no _pressCell; they all funnel through the same
//     shared playNote, so we assert that shared debug-trace layer directly.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/utils/MidiConstants.js');
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
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
  load('../../../public/js/features/keyboard/KeyboardEvents.js'); // real playNote/stopNote
});

const fire = (el, type, props = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  el.dispatchEvent(ev);
};

// Fake modal composing the REAL KeyboardEventsMixin so the production
// playNote/stopNote/_logNoteEvent code runs. Spies count the calls coming
// from the view; `logs` captures the app-log trace.
function makeModal(overrides = {}) {
  const logs = [];
  const calls = { play: [], stop: [], cc: [] };
  const modal = {
    ...win.KeyboardEventsMixin,
    velocity: 100,
    activeNotes: new Set(),
    _panelCallbacks: null,
    _activeView: null,
    selectedDevice: null,
    backend: null,
    logger: { info: (m) => logs.push(m), warn() {}, debug() {}, error() {} },
    getNoteNameFromNumber: (n) => 'N' + n,
    t: (k) => k,
    getSelectedChannel: () => 0,
    updatePianoDisplay() {},
    getNoteLabel: (n) => 'N' + n,
    sendCC: (c, v) => calls.cc.push([c, v]),
    showNoteColors: false,
    getNoteColor: () => ({ bg: '', text: '' }),
    ...overrides
  };
  const realPlay = modal.playNote;
  const realStop = modal.stopNote;
  modal.playNote = function (n) {
    calls.play.push(n);
    return realPlay.call(modal, n);
  };
  modal.stopNote = function (n) {
    calls.stop.push(n);
    return realStop.call(modal, n);
  };
  return { modal, logs, calls };
}

const ALL_KINDS = [
  'piano',
  'fretboard',
  'drumpad',
  'piano-slider',
  'keyboard-list',
  'harmonica',
  'harp',
  'accordion',
  'mallet',
  'music-box',
  'kalimba',
  'bagpipe',
  'steel-drum',
  'theremin',
  'perc-pad'
];

describe('every registered view kind exists (no silent drop)', () => {
  it('all 15 display types are registered', () => {
    for (const kind of ALL_KINDS) {
      expect(typeof win.instrumentViews.get(kind)).toBe('function');
    }
    expect(win.instrumentViews.kinds().sort()).toEqual([...ALL_KINDS].sort());
  });
});

// ── Self-owned views: real cell press+release must always trace ────────────
describe.each([
  ['harmonica', () => win.HarmonicaView, '#harmonica-container', '.harmonica-hole'],
  ['harp', () => win.HarpView, '#harp-container', '.harp-string'],
  ['accordion', () => win.AccordionView, '#accordion-container', '.accordion-key'],
  ['mallet', () => win.MalletView, '#mallet-container', '.mallet-bar'],
  ['music-box', () => win.MusicBoxView, '#music-box-container', '.music-box-tooth'],
  ['kalimba', () => win.KalimbaView, '#kalimba-container', '.kalimba-tine'],
  ['bagpipe', () => win.BagpipeView, '#bagpipe-container', '.bagpipe-hole'],
  ['steel-drum', () => win.SteelDrumView, '#steel-drum-container', '.steel-section'],
  ['perc-pad', () => win.PercussionPadView, '#perc-pad-container', '.perc-pad']
])(
  '%s — press+release always emits one on + one off trace (no device selected)',
  (kind, cls, containerSel, cellSel) => {
    let modal, logs, calls, view;
    beforeEach(() => {
      document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
      ({ modal, logs, calls } = makeModal()); // selectedDevice/backend null
      view = new (cls())();
      view.mount({ modal });
    });
    afterEach(() => {
      try {
        view.unmount();
      } catch {
        /* idempotent */
      }
    });

    it('plays + stops the real mixin and logs a virtual trace', () => {
      const cell =
        document.querySelector(`${containerSel} ${cellSel}`) || document.querySelector(cellSel);
      expect(cell).not.toBeNull();
      fire(cell, 'pointerdown');
      document.dispatchEvent(new Event('pointerup'));

      expect(calls.play.length).toBeGreaterThan(0);
      expect(calls.stop.length).toBeGreaterThan(0);
      expect(logs.some((m) => m.includes('virtualNoteOn'))).toBe(true);
      expect(logs.some((m) => m.includes('virtualNoteOff'))).toBe(true);
    });
  }
);

describe('theremin — pad press+release always emits a trace (no device selected)', () => {
  let modal, logs, calls, view;
  beforeEach(() => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    ({ modal, logs, calls } = makeModal());
    view = new win.ThereminView();
    view.mount({ modal });
  });
  afterEach(() => {
    try {
      view.unmount();
    } catch {
      /* idempotent */
    }
  });

  it('plays + stops the real mixin and logs a virtual trace', () => {
    const pad = document.getElementById('theremin-container');
    fire(pad, 'pointerdown', { clientX: 240, clientY: 0 });
    document.dispatchEvent(new Event('pointerup'));
    expect(calls.play.length).toBeGreaterThan(0);
    expect(calls.stop.length).toBeGreaterThan(0);
    expect(logs.some((m) => m.includes('virtualNoteOn'))).toBe(true);
    expect(logs.some((m) => m.includes('virtualNoteOff'))).toBe(true);
  });
});

// ── Legacy piano-family views: assert the shared trace layer they funnel
//    through (no _pressCell of their own; routed via legacy key handlers). ──
describe.each(['piano', 'fretboard', 'drumpad', 'piano-slider', 'keyboard-list'])(
  '%s (legacy delegate) — shared playNote/stopNote always traces',
  (kind) => {
    it('exactly one on-line + one off-line, no device selected', () => {
      expect(typeof win.instrumentViews.get(kind)).toBe('function');
      const { modal, logs, calls } = makeModal();
      modal.playNote(60);
      modal.stopNote(60);
      expect(calls.play).toEqual([60]);
      expect(calls.stop).toEqual([60]);
      expect(logs.filter((m) => m.includes('virtualNoteOn')).length).toBe(1);
      expect(logs.filter((m) => m.includes('virtualNoteOff')).length).toBe(1);
    });
  }
);

// ── Device-state matrix on the shared layer ────────────────────────────────
describe('playNote/stopNote device-state matrix', () => {
  it('no device selected → still logs exactly one trace, no MIDI send', () => {
    const { modal, logs, calls } = makeModal();
    modal.playNote(64);
    modal.stopNote(64);
    expect(calls.play).toEqual([64]);
    expect(logs.filter((m) => m.includes('virtualNoteOn')).length).toBe(1);
    expect(logs.filter((m) => m.includes('virtualNoteOff')).length).toBe(1);
  });

  it('virtual/SF2 device → logs trace and never calls backend.sendNoteOn', () => {
    let sent = 0;
    const { modal, logs } = makeModal({
      selectedDevice: { device_id: 'virtual_1', isVirtual: true },
      backend: {
        sendNoteOn: () => {
          sent++;
          return Promise.resolve();
        },
        sendNoteOff: () => {
          sent++;
          return Promise.resolve();
        }
      }
    });
    modal.playNote(67);
    modal.stopNote(67);
    expect(sent).toBe(0);
    expect(logs.filter((m) => m.includes('virtualNoteOn')).length).toBe(1);
    expect(logs.filter((m) => m.includes('virtualNoteOff')).length).toBe(1);
  });

  it('real hardware device → sends MIDI AND still logs a trace (no monitorAll dependency)', () => {
    const sent = [];
    const { modal, logs } = makeModal({
      selectedDevice: { device_id: 'hw_1', isVirtual: false },
      backend: {
        sendNoteOn: (...a) => {
          sent.push(['on', ...a]);
          return Promise.resolve();
        },
        sendNoteOff: (...a) => {
          sent.push(['off', ...a]);
          return Promise.resolve();
        }
      }
    });
    modal.playNote(69);
    modal.stopNote(69);
    expect(sent.some((e) => e[0] === 'on')).toBe(true);
    expect(sent.some((e) => e[0] === 'off')).toBe(true);
    expect(logs.filter((m) => m.includes('virtualNoteOn')).length).toBe(1);
    expect(logs.filter((m) => m.includes('virtualNoteOff')).length).toBe(1);
  });
});
