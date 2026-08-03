// tests/string-instrument-scale-length.test.js
// Unit tests for the scale-length presets and normalization helper added
// to StringInstrumentDatabase. Uses no SQLite — only the static catalogue
// and the pure helper.

import { describe, test, expect } from '@jest/globals';
import StringInstrumentDatabase from '../src/persistence/tables/StringInstrumentDatabase.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const noDbStub = new StringInstrumentDatabase(null, silentLogger);

describe('SCALE_LENGTH_PRESETS catalogue', () => {
  test('exposes a non-empty catalogue', () => {
    const presets = StringInstrumentDatabase.SCALE_LENGTH_PRESETS;
    expect(typeof presets).toBe('object');
    expect(Object.keys(presets).length).toBeGreaterThan(0);
  });

  test('every preset has a name and a finite scale_length_mm in [100, 2000]', () => {
    for (const [key, preset] of Object.entries(StringInstrumentDatabase.SCALE_LENGTH_PRESETS)) {
      expect(typeof preset.name).toBe('string');
      expect(preset.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(preset.scale_length_mm)).toBe(true);
      expect(preset.scale_length_mm).toBeGreaterThanOrEqual(100);
      expect(preset.scale_length_mm).toBeLessThanOrEqual(2000);
      // Sanity: keys are slug-safe
      expect(key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test('covers the families the UI advertises', () => {
    const presets = StringInstrumentDatabase.SCALE_LENGTH_PRESETS;
    // At least one entry per advertised family.
    expect(Object.keys(presets).some((k) => k.startsWith('guitar'))).toBe(true);
    expect(Object.keys(presets).some((k) => k.startsWith('bass'))).toBe(true);
    expect(Object.keys(presets).some((k) => k.startsWith('ukulele'))).toBe(true);
    expect(presets.violin).toBeDefined();
    expect(presets.cello).toBeDefined();
    expect(presets.contrabass).toBeDefined();
  });
});

describe('getScaleLengthPresets / getScaleLengthPreset', () => {
  test('getScaleLengthPresets returns the static catalogue', () => {
    expect(noDbStub.getScaleLengthPresets()).toBe(StringInstrumentDatabase.SCALE_LENGTH_PRESETS);
  });

  test('getScaleLengthPreset returns the entry by key', () => {
    const guitar = noDbStub.getScaleLengthPreset('guitar_classical');
    expect(guitar).toBeDefined();
    expect(guitar.scale_length_mm).toBe(650);
  });

  test('getScaleLengthPreset returns null for unknown keys', () => {
    expect(noDbStub.getScaleLengthPreset('not_a_real_preset')).toBeNull();
  });
});

describe('_normalizeScaleLength', () => {
  test('null/undefined/empty string → null (preset not chosen)', () => {
    expect(noDbStub._normalizeScaleLength(null)).toBeNull();
    expect(noDbStub._normalizeScaleLength(undefined)).toBeNull();
    expect(noDbStub._normalizeScaleLength('')).toBeNull();
  });

  test('NaN-like inputs → null (defensive, no throw)', () => {
    expect(noDbStub._normalizeScaleLength('not a number')).toBeNull();
    expect(noDbStub._normalizeScaleLength(NaN)).toBeNull();
  });

  test('valid integer is rounded and returned', () => {
    expect(noDbStub._normalizeScaleLength(648)).toBe(648);
    expect(noDbStub._normalizeScaleLength(648.4)).toBe(648);
    expect(noDbStub._normalizeScaleLength('650')).toBe(650);
  });

  test('values just inside bounds are accepted', () => {
    expect(noDbStub._normalizeScaleLength(100)).toBe(100);
    expect(noDbStub._normalizeScaleLength(2000)).toBe(2000);
  });

  test('values outside [100, 2000] throw — silent clamping would hide UI bugs', () => {
    expect(() => noDbStub._normalizeScaleLength(50)).toThrow(/scale_length_mm/);
    expect(() => noDbStub._normalizeScaleLength(2500)).toThrow(/scale_length_mm/);
  });
});
