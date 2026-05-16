// tests/sf2-converter-drum-tuning.test.js
//
// Regression guard for the "drums sound like a bell" bug. GM drum kits set
// SF2 ScaleTuning = 0 (the sample must play at its recorded pitch for any
// key). The converter used to forward per-zone CoarseTune/FineTune verbatim;
// combined with the client's forced root that transposed percussive samples
// into a sustained tonal ring. convertPresetFromSF2 must now zero coarse/fine
// tune for fixed-pitch (scaleTuning === 0) zones, while leaving normal
// melodic zones (default scaleTuning 100) untouched.

import { describe, it, expect } from '@jest/globals';
import pkg from 'soundfont2';
import { convertPresetFromSF2 } from '../src/files/SF2Converter.js';

const { GeneratorType: GT } = pkg;

// Build a fake instrument zone in the shape SF2Converter reads: a `sample`
// (header + Int16 data) plus a `generators` map keyed by the numeric
// GeneratorType values the converter looks up.
function makeZone({ key, coarseTune, fineTune, scaleTuning }) {
  const generators = {
    [GT.KeyRange]: { range: { lo: key, hi: key } },
    [GT.CoarseTune]: { value: coarseTune },
    [GT.FineTune]: { value: fineTune },
  };
  if (scaleTuning !== undefined) {
    generators[GT.ScaleTuning] = { value: scaleTuning };
  }
  return {
    generators,
    sample: {
      header: { originalPitch: 60, sampleRate: 44100, startLoop: 0, endLoop: 0 },
      data: new Int16Array([0, 1, -1, 2, -2, 0]),
    },
  };
}

function makeSF2({ bank, preset, zones }) {
  return {
    banks: {
      [bank]: {
        presets: {
          [preset]: {
            zones: [{ generators: {}, instrument: { zones } }],
          },
        },
      },
    },
  };
}

describe('convertPresetFromSF2 — drum scaleTuning / bell fix', () => {
  it('zeros coarse/fine tune for fixed-pitch drum zones (scaleTuning 0)', () => {
    const sf2 = makeSF2({
      bank: 128,
      preset: 0,
      zones: [
        makeZone({ key: 38, coarseTune: -5, fineTune: 40, scaleTuning: 0 }),
        makeZone({ key: 45, coarseTune: 0, fineTune: 0, scaleTuning: 0 }),
      ],
    });

    const out = convertPresetFromSF2(sf2, 128, 0);
    expect(out).not.toBeNull();
    expect(out.zones).toHaveLength(2);
    for (const z of out.zones) {
      expect(z.coarseTune).toBe(0);
      expect(z.fineTune).toBe(0);
    }
  });

  it('preserves tune for normal melodic zones (no/default scaleTuning)', () => {
    const sf2 = makeSF2({
      bank: 0,
      preset: 0,
      // No ScaleTuning generator → converter defaults to 100 (normal).
      zones: [makeZone({ key: 60, coarseTune: -5, fineTune: 40 })],
    });

    const out = convertPresetFromSF2(sf2, 0, 0);
    expect(out).not.toBeNull();
    expect(out.zones).toHaveLength(1);
    expect(out.zones[0].coarseTune).toBe(-5);
    expect(out.zones[0].fineTune).toBe(40);
  });
});
