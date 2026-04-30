// tests/instrument-capabilities-validator-n-hands.test.js
// Validator: N-hand semitones config (1, 3, 4 hands) plus pitch_split_notes
// and track_map cross-checks.

import { describe, test, expect } from '@jest/globals';
import InstrumentCapabilitiesValidator from '../src/midi/adaptation/InstrumentCapabilitiesValidator.js';

const baseInstrument = () => ({
  gm_program: 0,
  polyphony: 32,
  note_selection_mode: 'range',
  note_range_min: 21,
  note_range_max: 108
});

describe('InstrumentCapabilitiesValidator — N-hand semitones', () => {
  test('one-hand config (h1) is valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        hands: [{ id: 'h1', cc_position_number: 23, hand_span_semitones: 14 }]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('four-hand config (h1..h4) is valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'h1', cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'h2', cc_position_number: 24, hand_span_semitones: 14 },
          { id: 'h3', cc_position_number: 25, hand_span_semitones: 14 },
          { id: 'h4', cc_position_number: 26, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('five hands is rejected', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        hands: [
          { id: 'h1', cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'h2', cc_position_number: 24, hand_span_semitones: 14 },
          { id: 'h3', cc_position_number: 25, hand_span_semitones: 14 },
          { id: 'h4', cc_position_number: 26, hand_span_semitones: 14 },
          { id: 'h5', cc_position_number: 27, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
  });

  test('invalid hand id is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        hands: [{ id: 'bogus', cc_position_number: 23, hand_span_semitones: 14 }]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.hands[0].id')).toBe(true);
  });

  test('pitch_split_notes ascending and N-1 long is valid', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        hand_move_semitones_per_sec: 60,
        assignment: { mode: 'pitch_split', pitch_split_notes: [48, 60, 72] },
        hands: [
          { id: 'h1', cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'h2', cc_position_number: 24, hand_span_semitones: 14 },
          { id: 'h3', cc_position_number: 25, hand_span_semitones: 14 },
          { id: 'h4', cc_position_number: 26, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(true);
  });

  test('pitch_split_notes wrong length is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        assignment: { mode: 'pitch_split', pitch_split_notes: [60] },
        hands: [
          { id: 'h1', cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'h2', cc_position_number: 24, hand_span_semitones: 14 },
          { id: 'h3', cc_position_number: 25, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => m.field === 'hands_config.assignment.pitch_split_notes')).toBe(true);
  });

  test('pitch_split_notes non-ascending is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        assignment: { mode: 'pitch_split', pitch_split_notes: [60, 50] },
        hands: [
          { id: 'h1', cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'h2', cc_position_number: 24, hand_span_semitones: 14 },
          { id: 'h3', cc_position_number: 25, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => /ascending/.test(m.reason || ''))).toBe(true);
  });

  test('track_map with stale hand id is flagged', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
        assignment: { mode: 'track', track_map: { h1: [0], hX: [1] } },
        hands: [
          { id: 'h1', cc_position_number: 23, hand_span_semitones: 14 },
          { id: 'h2', cc_position_number: 24, hand_span_semitones: 14 }
        ]
      }
    });
    expect(r.isValid).toBe(false);
    expect(r.missing.some(m => /track_map\.hX/.test(m.field || ''))).toBe(true);
  });

  test('legacy left/right ids still validate (backward compat)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const r = v.validateInstrument({
      ...baseInstrument(),
      hands_config: {
        enabled: true, mode: 'semitones',
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
