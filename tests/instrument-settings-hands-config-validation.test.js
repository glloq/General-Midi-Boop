// tests/instrument-settings-hands-config-validation.test.js
// The save commands `instrument_update_capabilities` and
// `instrument_save_all` forward hands_config to the DB. Before writing we
// run the payload through the shared validator so a malformed config
// (cross-unit, wrong mode, out-of-range…) is rejected synchronously
// instead of silently corrupting the instrument row. Covers the exported
// `validateHandsConfigPayload` helper directly — no SQLite required.

import { describe, test, expect } from '@jest/globals';
import { validateHandsConfigPayload } from '../src/api/commands/InstrumentSettingsCommands.js';
import { ValidationError } from '../src/core/errors/index.js';

describe('validateHandsConfigPayload', () => {
  test('null/undefined are accepted (feature disabled)', () => {
    expect(() => validateHandsConfigPayload(null)).not.toThrow();
    expect(() => validateHandsConfigPayload(undefined)).not.toThrow();
  });

  test('explicit { enabled: false } is accepted', () => {
    expect(() => validateHandsConfigPayload({ enabled: false, hands: [] })).not.toThrow();
  });

  test('well-formed semitones config is accepted', () => {
    expect(() => validateHandsConfigPayload({
      enabled: true,
      mode: 'semitones',
      hand_move_semitones_per_sec: 60,
      hands: [
        { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
        { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
      ]
    })).not.toThrow();
  });

  test('well-formed frets config (mm-only) is accepted', () => {
    expect(() => validateHandsConfigPayload({
      enabled: true,
      mode: 'frets',
      mechanism: 'string_sliding_fingers',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
    })).not.toThrow();
  });

  test('cross-unit fields are rejected with a ValidationError', () => {
    const bad = {
      enabled: true,
      mode: 'frets',
      mechanism: 'string_sliding_fingers',
      hand_move_mm_per_sec: 250,
      hand_move_semitones_per_sec: 60,  // cross-unit
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
    };
    expect(() => validateHandsConfigPayload(bad)).toThrow(ValidationError);
  });

  test('wrong hand id in frets mode is rejected', () => {
    const bad = {
      enabled: true,
      mode: 'frets',
      mechanism: 'string_sliding_fingers',
      hand_move_frets_per_sec: 12,
      hands: [{ id: 'left', cc_position_number: 22, hand_span_frets: 4 }]
    };
    expect(() => validateHandsConfigPayload(bad)).toThrow(/fretting/);
  });

  test('out-of-range hand_span_mm is rejected', () => {
    const bad = {
      enabled: true,
      mode: 'frets',
      mechanism: 'string_sliding_fingers',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 300 }]
    };
    expect(() => validateHandsConfigPayload(bad)).toThrow(/hand_span_mm/);
  });

  test('missing both span units in frets mode is rejected', () => {
    const bad = {
      enabled: true,
      mode: 'frets',
      mechanism: 'string_sliding_fingers',
      hand_move_frets_per_sec: 12,
      hands: [{ id: 'fretting', cc_position_number: 22 }]
    };
    expect(() => validateHandsConfigPayload(bad)).toThrow(ValidationError);
  });

  test('missing mechanism in frets mode is rejected', () => {
    const bad = {
      enabled: true,
      mode: 'frets',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
    };
    expect(() => validateHandsConfigPayload(bad)).toThrow(/mechanism/);
  });

  test('mechanism = independent_fingers is rejected (V2 stub)', () => {
    const bad = {
      enabled: true,
      mode: 'frets',
      mechanism: 'independent_fingers',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
    };
    expect(() => validateHandsConfigPayload(bad)).toThrow(/V2|not yet implemented/);
  });

  test('fret_sliding_fingers without num_fingers is rejected', () => {
    const bad = {
      enabled: true,
      mode: 'frets',
      mechanism: 'fret_sliding_fingers',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
    };
    expect(() => validateHandsConfigPayload(bad)).toThrow(/num_fingers/);
  });

  test('fret_sliding_fingers with valid num_fingers is accepted', () => {
    expect(() => validateHandsConfigPayload({
      enabled: true,
      mode: 'frets',
      mechanism: 'fret_sliding_fingers',
      hand_move_mm_per_sec: 250,
      hands: [{
        id: 'fretting', cc_position_number: 22, hand_span_mm: 80,
        num_fingers: 4, variable_height_fingers_count: 2
      }]
    })).not.toThrow();
  });

  test('invalid JSON string is rejected', () => {
    expect(() => validateHandsConfigPayload('{ not json')).toThrow(ValidationError);
  });

  test('rejected payloads carry the offending field name', () => {
    try {
      validateHandsConfigPayload({
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 200, hand_span_mm: 80 }]
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toMatch(/cc_position_number/);
    }
  });
});
