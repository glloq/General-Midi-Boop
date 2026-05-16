// tests/frontend/midi-synth-drum-materialise.test.js
//
// Regression guard for the "drums sound like a bell" bug. When a drum
// preset's root is force-overridden (the only path used by
// _loadSF2DrumPreset), the sample MUST play at exactly playback rate 1.0,
// so _materialiseSF2Preset must zero coarseTune/fineTune *unconditionally*
// for that zone — not merely when null. The melodic path
// (forcedRootMidi == null) must leave tuning untouched.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

beforeAll(() => {
  // MidiSynthesizer.js destructures window.MidiSynthesizerConstants at
  // eval time, so materialise the constants IIFE first.
  delete window.MidiSynthesizerConstants;
  new Function(
    readFileSync(resolve(__dirname,
      '../../public/js/audio/MidiSynthesizerConstants.js'), 'utf8')
  ).call(window);
  new Function(
    readFileSync(resolve(__dirname,
      '../../public/js/audio/MidiSynthesizer.js'), 'utf8')
  ).call(window);
});

// Call the prototype method with a fake `this` so we never run the heavy
// constructor. Only `this.audioContext.createBuffer` is used.
function materialise(preset, forcedRootMidi) {
  const fakeThis = {
    audioContext: {
      createBuffer: () => ({ getChannelData: () => ({ set() {} }) }),
    },
  };
  return window.MidiSynthesizer.prototype._materialiseSF2Preset.call(
    fakeThis, preset, forcedRootMidi);
}

describe('MidiSynthesizer._materialiseSF2Preset — drum tuning / bell fix', () => {
  it('forced root (drum): zeros coarse/fine tune and pins originalPitch', () => {
    const zone = {
      sample: new Float32Array([0, 0.5, -0.5, 0.25]),
      sampleRate: 44100,
      originalPitch: 6000,
      coarseTune: -5,
      fineTune: 40,
    };
    materialise({ zones: [zone] }, 45);

    expect(zone.originalPitch).toBe(4500); // 45 * 100
    expect(zone.coarseTune).toBe(0);
    expect(zone.fineTune).toBe(0);
    expect(zone.buffer).toBeTruthy();
    expect(zone.sample).toBeNull();
  });

  it('no forced root (melodic): preserves coarse/fine tune', () => {
    const zone = {
      sample: new Float32Array([0, 0.5, -0.5, 0.25]),
      sampleRate: 44100,
      originalPitch: 3000,
      midi: 30,
      coarseTune: -5,
      fineTune: 40,
    };
    materialise({ zones: [zone] }, null);

    expect(zone.originalPitch).toBe(3000); // untouched (not null)
    expect(zone.coarseTune).toBe(-5);
    expect(zone.fineTune).toBe(40);
  });
});
