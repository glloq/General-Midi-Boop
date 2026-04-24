// tests/instrument-capabilities-validator-hands.test.js
// Validator: hands_config optional field. Absent = valid; present but
// malformed = flagged. Regression-focused: existing instruments without
// hands_config must keep passing validation.

import { describe, test, expect } from '@jest/globals';
import InstrumentCapabilitiesValidator from '../src/midi/adaptation/InstrumentCapabilitiesValidator.js';

const baseInstrument = () => ({
  gm_program: 0,
  polyphony: 32,
  note_selection_mode: 'range',
  note_range_min: 21,
  note_range_max: 108
});

describe('InstrumentCapabilitiesValidator — hands_config', () => {
  test('absent hands_config: instrument still valid (regression)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument(baseInstrument());
    expect(r.isValid).toBe(true);
  });

  test('null hands_config: instrument still valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({ ...baseInstrument(), hands_config: null });
    expect(r.isValid).toBe(true);
  });

  test('hands_config disabled: valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: { enabled: false, hands: [] }
    });
    expect(r.isValid).toBe(true);
  });

  test('well-formed two-hand config is valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14, note_range_min: 21, note_range_max: 72, polyphony: 5 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14, note_range_min: 48, note_range_max: 108, polyphony: 5 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('invalid JSON string is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({ ...baseInstrument(), hands_config: '{ bad json' });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config')).toBe(true);
  });

  test('empty hands array is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: { enabled: true, hands: [] }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands')).toBe(true);
  });

  test('duplicate hand id is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        hands: [
          { id: 'left', cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'left', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => /Duplicate hand id/.test(m.reason || ''))).toBe(true);
  });

  test('inverted note range is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        hands: [
          { id: 'left', cc_position_number: 23, hand_span_semitones: 14, note_range_min: 80, note_range_max: 40 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field.endsWith('.note_range'))).toBe(true);
  });

  test('unknown assignment mode is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        assignment: { mode: 'bogus' },
        hands: [{ id: 'left', cc_position_number: 23, hand_span_semitones: 14 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.assignment.mode')).toBe(true);
  });
});
