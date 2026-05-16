// tests/instrument-settings-play-config-validation.test.js
// Migration 022 adds bagpipe_config / accordion_config columns. The save
// commands forward them to the DB only after the shared validators reject
// malformed payloads (same explicit-key contract as hands_config). Covers
// the exported validators directly — no SQLite required.

import { describe, test, expect } from '@jest/globals';
import {
  validateBagpipeConfigPayload,
  validateAccordionConfigPayload,
  validateHarmonicaConfigPayload
} from '../src/api/commands/InstrumentSettingsCommands.js';
import { ValidationError } from '../src/core/errors/index.js';

describe('validateBagpipeConfigPayload', () => {
  test('null/undefined accepted (clears / leaves feature)', () => {
    expect(() => validateBagpipeConfigPayload(null)).not.toThrow();
    expect(() => validateBagpipeConfigPayload(undefined)).not.toThrow();
  });

  test('well-formed config accepted', () => {
    expect(() => validateBagpipeConfigPayload({ drones: [45, 45, 33], enabled: true })).not.toThrow();
    expect(() => validateBagpipeConfigPayload({ drones: [] })).not.toThrow();
    expect(() => validateBagpipeConfigPayload({ enabled: false })).not.toThrow();
  });

  test('object-shaped drones accepted (legacy number[] still accepted)', () => {
    expect(() => validateBagpipeConfigPayload({
      drones: [{ note: 33, enabled: true }, { note: 45, enabled: false }], enabled: true
    })).not.toThrow();
    expect(() => validateBagpipeConfigPayload({ drones: [{ note: 45 }] })).not.toThrow();
  });

  test('malformed object-shaped drones rejected', () => {
    expect(() => validateBagpipeConfigPayload({ drones: [{ note: 128, enabled: true }] })).toThrow(ValidationError);
    expect(() => validateBagpipeConfigPayload({ drones: [{ note: 45, enabled: 'x' }] })).toThrow(ValidationError);
    expect(() => validateBagpipeConfigPayload({ drones: [45, { note: 33, enabled: true }] })).toThrow(ValidationError);
  });

  test('non-object rejected', () => {
    expect(() => validateBagpipeConfigPayload(42)).toThrow(ValidationError);
    expect(() => validateBagpipeConfigPayload([45])).toThrow(ValidationError);
  });

  test('out-of-range / non-integer drones rejected', () => {
    expect(() => validateBagpipeConfigPayload({ drones: [128] })).toThrow(ValidationError);
    expect(() => validateBagpipeConfigPayload({ drones: [-1] })).toThrow(ValidationError);
    expect(() => validateBagpipeConfigPayload({ drones: [45.5] })).toThrow(ValidationError);
    expect(() => validateBagpipeConfigPayload({ drones: 'x' })).toThrow(ValidationError);
  });

  test('non-boolean enabled rejected', () => {
    expect(() => validateBagpipeConfigPayload({ enabled: 'yes' })).toThrow(ValidationError);
  });
});

describe('validateAccordionConfigPayload', () => {
  test('null/undefined accepted', () => {
    expect(() => validateAccordionConfigPayload(null)).not.toThrow();
    expect(() => validateAccordionConfigPayload(undefined)).not.toThrow();
  });

  test('valid enums accepted (any subset of keys)', () => {
    expect(() => validateAccordionConfigPayload({})).not.toThrow();
    expect(() => validateAccordionConfigPayload({
      bass_system: 'free', right_display: 'keyboard'
    })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_system: 'stradella' })).not.toThrow();
  });

  test('non-object rejected', () => {
    expect(() => validateAccordionConfigPayload('x')).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload([])).toThrow(ValidationError);
  });

  test('invalid enum values rejected', () => {
    expect(() => validateAccordionConfigPayload({ bass_system: 'bogus' })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ right_display: 'touch' })).toThrow(ValidationError);
  });

  test('legacy chromatic accepted leniently (merged into free downstream)', () => {
    expect(() => validateAccordionConfigPayload({ bass_system: 'chromatic' })).not.toThrow();
  });

  test('well-formed bass_range accepted (incl. single bound / empty)', () => {
    expect(() => validateAccordionConfigPayload({ bass_range: { min: 36, max: 60 } })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_range: { min: 40 } })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_range: {} })).not.toThrow();
  });

  test('malformed / inverted bass_range rejected', () => {
    expect(() => validateAccordionConfigPayload({ bass_range: { min: 70, max: 40 } })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_range: { min: -1 } })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_range: { max: 200 } })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_range: { min: 1.5 } })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_range: [36, 60] })).toThrow(ValidationError);
  });

  test('well-formed Stradella geometry accepted', () => {
    expect(() => validateAccordionConfigPayload({ bass_cols: 12 })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_cols: 1 })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_cols: 20 })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_base: 0 })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_base: 127 })).not.toThrow();
    expect(() => validateAccordionConfigPayload({
      bass_funcs: ['counterbass', 'bass', 'major', 'minor', 'dom7', 'dim7'] })).not.toThrow();
    expect(() => validateAccordionConfigPayload({ bass_funcs: [] })).not.toThrow();
  });

  test('malformed Stradella geometry rejected', () => {
    expect(() => validateAccordionConfigPayload({ bass_cols: 0 })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_cols: 21 })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_cols: 1.5 })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_base: -1 })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_base: 200 })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_funcs: 'bass' })).toThrow(ValidationError);
    expect(() => validateAccordionConfigPayload({ bass_funcs: ['bogus'] })).toThrow(ValidationError);
  });
});

describe('validateHarmonicaConfigPayload', () => {
  test('null/undefined/empty accepted (clears / leaves feature)', () => {
    expect(() => validateHarmonicaConfigPayload(null)).not.toThrow();
    expect(() => validateHarmonicaConfigPayload(undefined)).not.toThrow();
    expect(() => validateHarmonicaConfigPayload({})).not.toThrow();
  });

  test('valid type/key (any subset) accepted', () => {
    expect(() => validateHarmonicaConfigPayload({ type: 'diatonic' })).not.toThrow();
    expect(() => validateHarmonicaConfigPayload({ type: 'chromatic', key: 'D' })).not.toThrow();
    expect(() => validateHarmonicaConfigPayload({ key: 'F#' })).not.toThrow();
  });

  test('non-object rejected', () => {
    expect(() => validateHarmonicaConfigPayload('x')).toThrow(ValidationError);
    expect(() => validateHarmonicaConfigPayload([])).toThrow(ValidationError);
    expect(() => validateHarmonicaConfigPayload(42)).toThrow(ValidationError);
  });

  test('invalid type/key rejected', () => {
    expect(() => validateHarmonicaConfigPayload({ type: 'tremolo' })).toThrow(ValidationError);
    expect(() => validateHarmonicaConfigPayload({ key: 'H' })).toThrow(ValidationError);
    expect(() => validateHarmonicaConfigPayload({ key: 'Db' })).toThrow(ValidationError);
  });
});
