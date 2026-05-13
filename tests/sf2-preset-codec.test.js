// tests/sf2-preset-codec.test.js
//
// Round-trip integrity for the GMBP binary wire format.
// Float32 sample data must survive encode → decode bit-perfect, and every
// metadata field must round-trip unchanged. A bit-flip here would silently
// corrupt audio in the browser.

import { encodePreset, decodePreset, looksLikeBinaryPreset } from '../src/files/SF2PresetCodec.js';

function makePreset() {
  return {
    zones: [
      {
        sample: Float32Array.from([0, 0.5, -0.5, 1, -1, 0.123456, -0.987654]),
        sampleRate: 44100,
        loopStart: 100,
        loopEnd: 200,
        keyRangeLow: 0,
        keyRangeHigh: 127,
        velRangeLow: 0,
        velRangeHigh: 127,
        midi: 60,
        coarseTune: 0,
        fineTune: 0,
      },
      {
        sample: Float32Array.from([1e-6, -1e-6, 2.5, -2.5]),
        sampleRate: 22050,
        loopStart: 0,
        loopEnd: 0,
        keyRangeLow: 36,
        keyRangeHigh: 48,
        velRangeLow: 64,
        velRangeHigh: 127,
        midi: 42,
        coarseTune: 12,
        fineTune: -50,
      },
    ],
  };
}

describe('SF2PresetCodec', () => {
  test('encode → decode round-trips metadata and samples bit-perfect', () => {
    const original = makePreset();
    const buf = encodePreset(original);

    expect(looksLikeBinaryPreset(buf)).toBe(true);

    const decoded = decodePreset(buf);
    expect(decoded.zones).toHaveLength(original.zones.length);

    for (let i = 0; i < original.zones.length; i++) {
      const a = original.zones[i];
      const b = decoded.zones[i];
      // Float32 → Float32 must be bit-identical (no precision loss).
      expect(Array.from(b.sample)).toEqual(Array.from(a.sample));
      // Metadata must round-trip exactly.
      for (const key of ['sampleRate', 'loopStart', 'loopEnd',
        'keyRangeLow', 'keyRangeHigh', 'velRangeLow', 'velRangeHigh',
        'midi', 'coarseTune', 'fineTune']) {
        expect(b[key]).toBe(a[key]);
      }
    }
  });

  test('handles zero-length samples without misaligning subsequent zones', () => {
    const preset = {
      zones: [
        { sample: new Float32Array(0), sampleRate: 44100, loopStart: 0, loopEnd: 0,
          keyRangeLow: 0, keyRangeHigh: 127, velRangeLow: 0, velRangeHigh: 127,
          midi: 60, coarseTune: 0, fineTune: 0 },
        { sample: Float32Array.from([0.25, -0.25]), sampleRate: 44100, loopStart: 0, loopEnd: 0,
          keyRangeLow: 0, keyRangeHigh: 127, velRangeLow: 0, velRangeHigh: 127,
          midi: 61, coarseTune: 0, fineTune: 0 },
      ],
    };
    const decoded = decodePreset(encodePreset(preset));
    expect(decoded.zones[0].sample.length).toBe(0);
    expect(Array.from(decoded.zones[1].sample)).toEqual([0.25, -0.25]);
  });

  test('looksLikeBinaryPreset returns false on legacy JSON', () => {
    const json = Buffer.from('{"zones":[]}');
    expect(looksLikeBinaryPreset(json)).toBe(false);
  });

  test('decode rejects bad magic', () => {
    const bad = Buffer.alloc(12);
    bad.write('ABCD', 0);
    expect(() => decodePreset(bad)).toThrow(/GMBP/);
  });

  test('decode rejects unsupported version', () => {
    const preset = makePreset();
    const buf = encodePreset(preset);
    buf.writeUInt32LE(99, 4); // tamper version
    expect(() => decodePreset(buf)).toThrow(/version/);
  });

  test('accepts a raw ArrayBuffer (browser arrayBuffer() result)', () => {
    const original = makePreset();
    const buf = encodePreset(original);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const decoded = decodePreset(ab);
    expect(decoded.zones).toHaveLength(2);
    expect(Array.from(decoded.zones[0].sample)).toEqual(Array.from(original.zones[0].sample));
  });
});
