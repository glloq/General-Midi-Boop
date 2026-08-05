// tests/scale-snapper.test.js
// ScaleSnapper materialises the in-scale MIDI notes for a diatonic/pentatonic
// octave_mode, mirroring the frontend InstrumentSettingsModal.computePlayableNotes
// so the backend can enforce scale membership. Pure — no DB / MIDI stack.

import { describe, test, expect } from '@jest/globals';
import {
  scaleNotes,
  restrictsScale,
  SCALE_INTERVALS
} from '../src/midi/adaptation/ScaleSnapper.js';

describe('restrictsScale', () => {
  test('true only for known non-chromatic scales', () => {
    expect(restrictsScale('diatonic')).toBe(true);
    expect(restrictsScale('pentatonic')).toBe(true);
    expect(restrictsScale('chromatic')).toBe(false);
    expect(restrictsScale(null)).toBe(false);
    expect(restrictsScale(undefined)).toBe(false);
    expect(restrictsScale('bogus')).toBe(false);
  });
});

describe('scaleNotes', () => {
  test('chromatic / unknown / absent → every note in range', () => {
    expect(scaleNotes(60, 64, 'chromatic')).toEqual([60, 61, 62, 63, 64]);
    expect(scaleNotes(60, 64, 'bogus')).toEqual([60, 61, 62, 63, 64]);
    expect(scaleNotes(60, 62)).toEqual([60, 61, 62]);
  });

  test('diatonic C major (root 0) keeps only in-scale pitch classes', () => {
    // C major over C4..C5: C D E F G A B C
    expect(scaleNotes(60, 72, 'diatonic', 0)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  test('pentatonic C (root 0)', () => {
    // C pentatonic over C4..C5: C D E G A C
    expect(scaleNotes(60, 72, 'pentatonic', 0)).toEqual([60, 62, 64, 67, 69, 72]);
  });

  test('scale root shifts the pattern (D major)', () => {
    // D major over D4..D5: D E F# G A B C# D  → 62 64 66 67 69 71 73 74
    expect(scaleNotes(62, 74, 'diatonic', 2)).toEqual([62, 64, 66, 67, 69, 71, 73, 74]);
  });

  test('root is normalised mod 12 (and negative roots)', () => {
    expect(scaleNotes(60, 72, 'diatonic', 12)).toEqual(scaleNotes(60, 72, 'diatonic', 0));
    expect(scaleNotes(60, 72, 'diatonic', -12)).toEqual(scaleNotes(60, 72, 'diatonic', 0));
  });

  test('bounds clamped to 0-127 and inverted range → empty', () => {
    expect(scaleNotes(-5, 1, 'chromatic')).toEqual([0, 1]);
    expect(scaleNotes(126, 200, 'chromatic')).toEqual([126, 127]);
    expect(scaleNotes(80, 70, 'diatonic', 0)).toEqual([]);
  });

  test('interval tables match the documented frontend scales', () => {
    expect(SCALE_INTERVALS.diatonic).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(SCALE_INTERVALS.pentatonic).toEqual([0, 2, 4, 7, 9]);
  });
});
