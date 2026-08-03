// tests/frontend/keyboard/toolbar-groups.test.js
// PE-2 regression oracle. _applyToolbarGroups() is a pure extraction of
// the 4 mode-only group toggles previously inlined in setViewMode. This
// test encodes the OLD formulas as an independent oracle and asserts the
// extracted method matches them for every viewKind — guaranteeing zero
// behaviour change — and that it touches NOTHING outside its 4 ids.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/KeyboardModal.js');
});

// The exact pre-PE-2 inline formulas (independent re-implementation).
// octave-bar / minimap / list-view: legacy formulas (PE-2 preserved them
// exactly). note-color: CHANGED post-PE-2 (QA #3) — the 🎨 toggle must
// stay visible on piano-slider; only a drum kit has no pitch colours, so
// it is hidden ONLY in drumpad.
const oracle = (vm) => ({
  'keyboard-octave-bar': vm !== 'piano' && vm !== 'piano-slider',
  'keyboard-minimap-row': !(vm === 'piano' || vm === 'piano-slider' || vm === 'keyboard-list'),
  'keyboard-note-color-group': vm === 'drumpad',
  'keyboard-list-view-group': vm === 'fretboard' || vm === 'drumpad'
});

const ALL_KINDS = [
  'piano',
  'piano-slider',
  'fretboard',
  'drumpad',
  'keyboard-list',
  'harmonica',
  'harp',
  'accordion',
  'mallet',
  'kalimba',
  'bagpipe',
  'steel-drum',
  'theremin'
];
const MANAGED = Object.keys(oracle('piano'));

describe('PE-2 — _applyToolbarGroups behaviour-faithful extraction', () => {
  let m;
  beforeEach(() => {
    document.body.innerHTML = MANAGED.map((id) => `<div id="${id}"></div>`).join('');
    m = new win.KeyboardModal();
  });

  it('is a KeyboardModal method (no mixin needed)', () => {
    expect(typeof m._applyToolbarGroups).toBe('function');
  });

  for (const vm of ALL_KINDS) {
    it(`viewKind "${vm}" → exactly the legacy visibility`, () => {
      m.viewMode = vm;
      m._applyToolbarGroups();
      const exp = oracle(vm);
      for (const id of MANAGED) {
        expect(document.getElementById(id).classList.contains('hidden'), `#${id} for "${vm}"`).toBe(
          exp[id]
        );
      }
    });
  }

  it('idempotent (calling twice yields the same state)', () => {
    m.viewMode = 'fretboard';
    m._applyToolbarGroups();
    const first = MANAGED.map((id) => document.getElementById(id).className);
    m._applyToolbarGroups();
    expect(MANAGED.map((id) => document.getElementById(id).className)).toEqual(first);
  });

  it('toggling across modes flips visibility back and forth', () => {
    const ob = () => document.getElementById('keyboard-octave-bar').classList.contains('hidden');
    m.viewMode = 'piano';
    m._applyToolbarGroups();
    expect(ob()).toBe(false);
    m.viewMode = 'drumpad';
    m._applyToolbarGroups();
    expect(ob()).toBe(true);
    m.viewMode = 'piano-slider';
    m._applyToolbarGroups();
    expect(ob()).toBe(false);
  });
});

describe('PE-2 — scope isolation (caps-aware / view-mode groups untouched)', () => {
  // These belong to updateSlidersVisibility / _updateListViewControls /
  // _updateSlideModeGroupVisibility / _updatePianoSliderGroupVisibility /
  // _selectInstrumentOption — _applyToolbarGroups must never touch them.
  const FOREIGN = [
    'keyboard-view-mode-group',
    'velocity-control-panel',
    'modulation-control-panel',
    'pitch-bend-control-panel',
    'keyboard-piano-slider-group',
    'keyboard-list-cc-group',
    'keyboard-list-pb-group',
    'wind-instrument-panel'
  ];

  it('leaves every out-of-scope group exactly as it was', () => {
    document.body.innerHTML =
      MANAGED.map((id) => `<div id="${id}"></div>`).join('') +
      FOREIGN.map((id, i) => `<div id="${id}" class="${i % 2 ? 'hidden' : 'shown'}"></div>`).join(
        ''
      );
    const m = new win.KeyboardModal();
    const before = FOREIGN.map((id) => document.getElementById(id).className);
    for (const vm of ALL_KINDS) {
      m.viewMode = vm;
      m._applyToolbarGroups();
    }
    expect(FOREIGN.map((id) => document.getElementById(id).className)).toEqual(before);
  });

  it('no-throw when managed elements are absent', () => {
    document.body.innerHTML = '';
    const m = new win.KeyboardModal();
    m.viewMode = 'piano';
    expect(() => m._applyToolbarGroups()).not.toThrow();
  });
});
