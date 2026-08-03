// tests/adaptation-audit-regressions.test.js
// Regression guards for correctness bugs found during the system audit:
//   - MidiTransposer.compressNoteToRange folded to the wrong PITCH CLASS
//     (reflection instead of octave folding).
//   - InstrumentCapabilitiesValidator flagged note_range_min === 0 as missing
//     (falsy-value bug) and accepted an inverted range (min > max).

import { describe, test, expect } from '@jest/globals';
import MidiTransposer from '../src/midi/adaptation/MidiTransposer.js';
import InstrumentCapabilitiesValidator from '../src/midi/adaptation/InstrumentCapabilitiesValidator.js';

const mockLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('MidiTransposer.compressNoteToRange — octave folding preserves pitch class', () => {
  const t = new MidiTransposer(mockLogger);

  test('in-range notes are unchanged', () => {
    expect(t.compressNoteToRange(64, 60, 72)).toBe(64);
    expect(t.compressNoteToRange(60, 60, 72)).toBe(60);
    expect(t.compressNoteToRange(72, 60, 72)).toBe(72);
  });

  test('out-of-range notes fold to the SAME pitch class (mod 12)', () => {
    // Range [60,72]. Each folded note must share the source pitch class.
    for (const note of [49, 50, 59, 73, 74, 84, 36, 24, 96]) {
      const folded = t.compressNoteToRange(note, 60, 72);
      expect(folded).toBeGreaterThanOrEqual(60);
      expect(folded).toBeLessThanOrEqual(72);
      // Endpoints 60 and 72 are both pitch class 0, so allow either when the
      // source is pitch class 0; otherwise require an exact pitch-class match.
      expect(folded % 12).toBe(note % 12);
    }
  });

  test('the specific reflection bug is gone: 49 (C#) → 61 (C#), not 71 (B)', () => {
    expect(t.compressNoteToRange(49, 60, 72)).toBe(61);
    expect(t.compressNoteToRange(73, 60, 72)).toBe(61);
    expect(t.compressNoteToRange(74, 60, 72)).toBe(62);
  });

  test('sub-octave ranges clamp instead of looping forever', () => {
    // Range narrower than 12 semitones cannot hold every pitch class.
    const r = t.compressNoteToRange(58, 60, 66);
    expect(r).toBeGreaterThanOrEqual(60);
    expect(r).toBeLessThanOrEqual(66);
  });
});

describe('InstrumentCapabilitiesValidator — range validity', () => {
  const v = new InstrumentCapabilitiesValidator();
  const base = {
    gm_program: 0,
    polyphony: 8,
    note_selection_mode: 'range',
    note_range_max: 108
  };

  test('note_range_min === 0 is accepted (not reported missing)', () => {
    const res = v.validateInstrument({ ...base, note_range_min: 0 });
    const missingFields = res.missing.map((m) => m.field);
    expect(missingFields).not.toContain('note_range_min');
    expect(res.isValid).toBe(true);
  });

  test('an inverted range (min > max) is flagged', () => {
    const res = v.validateInstrument({ ...base, note_range_min: 72, note_range_max: 48 });
    expect(res.isValid).toBe(false);
    expect(res.missing.some((m) => m.field === 'note_range_max')).toBe(true);
  });

  test('a normal ordered range validates', () => {
    const res = v.validateInstrument({ ...base, note_range_min: 21, note_range_max: 108 });
    expect(res.isValid).toBe(true);
  });
});
