// tests/frontend/keyboard/keyboard-piano-mallet-skin.test.js
// Verifies generatePianoKeys() tags #piano-container with data-mallet-skin
// for bar-type chromatic-percussion instruments, and removes it otherwise
// (the container is reused across instrument selections — no stale skin).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
beforeAll(() => {
  const src = readFileSync(
    resolve(__dirname, '../../../public/js/features/keyboard/KeyboardPiano.js'), 'utf8');
  new Function('window', src)(win);
});

// Minimal `this` context for generatePianoKeys: a small one-octave window.
function ctx(overrides = {}) {
  return {
    startNote: 60,
    visibleNoteCount: 12,
    blackNoteSemitones: new Set([1, 3, 6, 8, 10]),
    showNoteColors: false,
    getNoteLabel: (n) => String(n),
    isNotePlayable: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="piano-container" class="piano-container"></div>';
});

const gen = () => win.KeyboardPianoMixin.generatePianoKeys;
const container = () => document.getElementById('piano-container');

describe('generatePianoKeys — data-mallet-skin', () => {
  const cases = [
    [8, 'metal-soft'],   // Celesta
    [9, 'metal-bright'], // Glockenspiel
    [11, 'metal-warm'],  // Vibraphone
    [12, 'wood-dark'],   // Marimba
    [13, 'wood-light'],  // Xylophone
  ];

  for (const [program, skin] of cases) {
    it(`GM ${program} → data-mallet-skin="${skin}"`, () => {
      gen().call(ctx({ selectedDeviceCapabilities: { gm_program: program } }));
      expect(container().dataset.malletSkin).toBe(skin);
    });
  }

  it('non-bar instrument (GM 0, piano) sets no skin', () => {
    gen().call(ctx({ selectedDeviceCapabilities: { gm_program: 0 } }));
    expect(container().dataset.malletSkin).toBeUndefined();
  });

  it('excluded chromatic-percussion (GM 10 music box, 14 tubular bells, 15 dulcimer) sets no skin', () => {
    for (const program of [10, 14, 15]) {
      gen().call(ctx({ selectedDeviceCapabilities: { gm_program: program } }));
      expect(container().dataset.malletSkin).toBeUndefined();
    }
  });

  it('falls back to selectedDevice.gm_program when capabilities absent', () => {
    gen().call(ctx({ selectedDevice: { gm_program: 12 } }));
    expect(container().dataset.malletSkin).toBe('wood-dark');
  });

  it('clears a stale skin when switching from a bar instrument to piano', () => {
    gen().call(ctx({ selectedDeviceCapabilities: { gm_program: 9 } }));
    expect(container().dataset.malletSkin).toBe('metal-bright');
    gen().call(ctx({ selectedDeviceCapabilities: { gm_program: 0 } }));
    expect(container().dataset.malletSkin).toBeUndefined();
  });
});
