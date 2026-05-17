// tests/frontend/keyboard/keyboard-mallet-view-skin.test.js
// MalletView is the real renderer for glockenspiel/vibraphone/marimba/
// xylophone (GM 9/11/12/13) — not the piano. It must give each a
// realistic per-material bar colour and tag the root with
// data-mallet-skin so the CSS struck-bar active feedback applies.
// Excluded programs (tubular bells 14, dulcimer 15) keep the legacy
// warm-wood look (no skin).

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  new Function('window', readFileSync(resolve(__dirname, rel), 'utf8'))(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/views/MalletView.js');
});

const fire = (el, type, props = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  el.dispatchEvent(ev);
};

let view;
const mount = (caps) => {
  document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
  const modal = {
    playNote() {}, stopNote() {},
    getNoteLabel: (n) => `${n}`,
    getInstrumentNoteRange: () => ({ min: 60, max: 71, notes: null }),
    selectedDeviceCapabilities: caps,
  };
  view = new (win.MalletView)();
  view.mount({ modal });
};
afterEach(() => { try { view.unmount(); } catch { /* idempotent */ } });

const root = () => document.getElementById('mallet-container');
const natBar = () => root().querySelector('.mallet-bar-nat');
const accBar = () => root().querySelector('.mallet-bar-acc');

describe('MalletView — realistic per-instrument bar material', () => {
  const skinned = [
    [9, 'metal-bright'],
    [11, 'metal-warm'],
    [12, 'wood-dark'],
    [13, 'wood-light'],
  ];

  for (const [gm, skin] of skinned) {
    it(`GM ${gm} → data-mallet-skin="${skin}" with gradient bars`, () => {
      mount({ gm_program: gm });
      expect(root().dataset.malletSkin).toBe(skin);
      expect(natBar().style.background).toContain('linear-gradient');
      expect(accBar().style.background).toContain('linear-gradient');
    });
  }

  it('excluded GM 14 (tubular bells) keeps the legacy flat wood look, no skin', () => {
    mount({ gm_program: 14 });
    expect(root().dataset.malletSkin).toBeUndefined();
    expect(natBar().style.background).not.toContain('linear-gradient');
  });

  it('no capabilities → default wood look, no skin', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.MalletView)();
    v.mount({ modal: { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}` } });
    expect(document.getElementById('mallet-container').dataset.malletSkin).toBeUndefined();
    v.unmount();
  });

  it('falls back to selectedDevice.gm_program when capabilities absent', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.MalletView)();
    v.mount({ modal: { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}`,
      selectedDevice: { gm_program: 12 } } });
    expect(document.getElementById('mallet-container').dataset.malletSkin).toBe('wood-dark');
    v.unmount();
  });

  it('showNoteColors still overrides the material colour (🎨 unchanged)', () => {
    document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
    const v = new (win.MalletView)();
    v.mount({ modal: { playNote() {}, stopNote() {}, getNoteLabel: (n) => `${n}`,
      selectedDeviceCapabilities: { gm_program: 9 },
      showNoteColors: true, getNoteColor: () => ({ bg: 'rgb(1, 2, 3)', text: '#fff' }) } });
    for (const bar of document.querySelectorAll('.mallet-bar')) {
      expect(bar.style.background).toBe('rgb(1, 2, 3)');
    }
    v.unmount();
  });

  it('pressing a bar toggles .active (drives the CSS struck-bar feedback)', () => {
    mount({ gm_program: 9 });
    const bar = root().querySelector('.mallet-bar');
    fire(bar, 'pointerdown');
    expect(bar.classList.contains('active')).toBe(true);
    document.dispatchEvent(new Event('pointerup'));
    expect(bar.classList.contains('active')).toBe(false);
  });
});
