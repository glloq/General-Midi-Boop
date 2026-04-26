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
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
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

  test('non-positive travel speed is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        hand_move_semitones_per_sec: 0,
        hands: [
          { id: 'left', cc_position_number: 23, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hand_move_semitones_per_sec')).toBe(true);
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

  test('explicit semitones mode is valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('unknown mode value is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: { enabled: true, mode: 'bananas', hands: [] }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.mode')).toBe(true);
  });
});

describe('InstrumentCapabilitiesValidator — hands_config (frets mode)', () => {
  const guitar = () => ({
    gm_program: 24,
    polyphony: 6,
    note_selection_mode: 'range',
    note_range_min: 40,
    note_range_max: 86
  });

  test('well-formed frets config is valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_frets_per_sec: 12,
        hands: [
          { id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('frets mode with two hands is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_frets_per_sec: 12,
        hands: [
          { id: 'fretting', cc_position_number: 22, hand_span_frets: 4 },
          { id: 'other',    cc_position_number: 23, hand_span_frets: 4 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => /exactly one hand/.test(m.reason || ''))).toBe(true);
  });

  test('frets mode with wrong hand id is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_frets_per_sec: 12,
        hands: [{ id: 'left', cc_position_number: 22, hand_span_frets: 4 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].id')).toBe(true);
  });

  test('frets mode missing both hand_span_mm and hand_span_frets is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_frets_per_sec: 12,
        hands: [{ id: 'fretting', cc_position_number: 22 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => /hand_span/.test(m.field || ''))).toBe(true);
  });

  test('frets mode rejects cross-unit semitone fields on hand', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_frets_per_sec: 12,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4, hand_span_semitones: 14 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].hand_span_semitones')).toBe(true);
  });

  test('frets mode rejects cross-unit semitone travel speed', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_semitones_per_sec: 60,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hand_move_semitones_per_sec')).toBe(true);
  });

  test('frets mode rejects an assignment block', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_frets_per_sec: 12,
        assignment: { mode: 'auto' },
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.assignment')).toBe(true);
  });

  test('frets mode without mechanism is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.mechanism')).toBe(true);
  });

  test('mechanism = independent_fingers is rejected (V2 stub)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'independent_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m =>
      m.field === 'hands_config.mechanism' && /V2/.test(m.reason || '')
    )).toBe(true);
  });

  test('unknown mechanism value is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'bogus',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.mechanism')).toBe(true);
  });

  test('fret_sliding_fingers requires num_fingers', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'fret_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].num_fingers')).toBe(true);
  });

  test('fret_sliding_fingers num_fingers in [1,8] is accepted', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'fret_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, num_fingers: 4 }]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('fret_sliding_fingers num_fingers > 8 is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'fret_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, num_fingers: 12 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].num_fingers')).toBe(true);
  });

  test('fret_sliding_fingers variable_height_fingers_count > num_fingers is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'fret_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{
          id: 'fretting', cc_position_number: 22, hand_span_mm: 80,
          num_fingers: 3, variable_height_fingers_count: 5
        }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m =>
      m.field === 'hands_config.hands[0].variable_height_fingers_count'
    )).toBe(true);
  });

  test('string_sliding_fingers rejects fret_sliding-only fields', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{
          id: 'fretting', cc_position_number: 22, hand_span_mm: 80,
          num_fingers: 4
        }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m =>
      m.field === 'hands_config.hands[0].num_fingers'
    )).toBe(true);
  });

  test('semitones mode rejects stray hand_span_frets', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14, hand_span_frets: 4 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].hand_span_frets')).toBe(true);
  });

  test('semitones mode rejects stray hand_move_frets_per_sec', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hand_move_frets_per_sec: 12,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hand_move_frets_per_sec')).toBe(true);
  });
});

describe('InstrumentCapabilitiesValidator — frets mode mm + max_fingers', () => {
  const guitar = () => ({
    gm_program: 24,
    polyphony: 6,
    note_selection_mode: 'range',
    note_range_min: 40,
    note_range_max: 86
  });

  test('mm-only config is valid (physical model, no frets fallback needed)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('frets-only config is still valid (fallback when no scale length)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_frets_per_sec: 12,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('both mm and frets present is valid (planner picks the available unit at runtime)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hand_move_frets_per_sec: 12,
        hands: [{
          id: 'fretting', cc_position_number: 22,
          hand_span_mm: 80, hand_span_frets: 4
        }]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('hand_span_mm out of [30, 200] is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 250 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].hand_span_mm')).toBe(true);
  });

  test('hand_move_mm_per_sec out of [50, 2000] is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 5000,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hand_move_mm_per_sec')).toBe(true);
  });

  test('missing both speeds is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => /hand_move/.test(m.field || ''))).toBe(true);
  });

  test('max_fingers in [1, 12] is accepted', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, max_fingers: 6 }]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('max_fingers out of [1, 12] is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...guitar(),
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, max_fingers: 0 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].max_fingers')).toBe(true);
  });

  test('semitones mode rejects stray hand_span_mm and max_fingers', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14, hand_span_mm: 80, max_fingers: 5 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].hand_span_mm')).toBe(true);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].max_fingers')).toBe(true);
  });

  test('semitones mode rejects stray hand_move_mm_per_sec', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hand_move_mm_per_sec: 250,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hand_move_mm_per_sec')).toBe(true);
  });
});

describe('InstrumentCapabilitiesValidator — semitones mode mechanism + num_fingers', () => {
  const piano = () => ({
    gm_program: 0,
    polyphony: 32,
    note_selection_mode: 'range',
    note_range_min: 21,
    note_range_max: 108
  });

  test('mechanism = aligned_fingers is accepted', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...piano(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        mechanism: 'aligned_fingers',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14, num_fingers: 5 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14, num_fingers: 5 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('mechanism = independent_fingers_5 (V2) is rejected', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...piano(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        mechanism: 'independent_fingers_5',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m =>
      m.field === 'hands_config.mechanism' && /V2/.test(m.reason || '')
    )).toBe(true);
  });

  test('unknown semitones mechanism is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...piano(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        mechanism: 'bogus',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.mechanism')).toBe(true);
  });

  test('num_fingers in [1,10] is accepted', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...piano(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14, num_fingers: 1 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14, num_fingers: 10 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('num_fingers out of bounds is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...piano(),
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14, num_fingers: 12 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].num_fingers')).toBe(true);
  });

  test('legacy semitones config without mechanism still validates', () => {
    // Pre-mechanism rows must keep validating so a DB rollout that
    // pre-dates the mechanism field doesn't suddenly break instruments.
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...piano(),
      hands_config: {
        enabled: true,
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });
});
