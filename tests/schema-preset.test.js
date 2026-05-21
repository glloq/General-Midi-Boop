// tests/schema-preset.test.js
// Schemas for `preset_*` WS commands (PR 3, ROADMAP_DI_2026-05-21).

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const ok = (result) => expect(result).toEqual({ valid: true, errors: [] });
const errs = (result, expected) => {
  expect(result.valid).toBe(false);
  for (const fragment of expected) {
    expect(result.errors.join(' | ')).toContain(fragment);
  }
};

describe('preset_save', () => {
  test('valid minimal', () => {
    ok(JsonValidator.validateByCommand('preset_save', { name: 'My preset', data: {} }));
  });
  test('valid with optional fields', () => {
    ok(JsonValidator.validateByCommand('preset_save', {
      name: 'Mix A',
      description: 'Live set',
      type: 'routing',
      data: { routes: [] }
    }));
  });
  test('missing name', () => {
    errs(JsonValidator.validateByCommand('preset_save', { data: {} }), ['name is required']);
  });
  test('missing data', () => {
    errs(JsonValidator.validateByCommand('preset_save', { name: 'X' }), ['data is required']);
  });
  test('data must be object', () => {
    errs(
      JsonValidator.validateByCommand('preset_save', { name: 'X', data: 'string-not-object' }),
      ['data must be an object']
    );
  });
});

describe('preset_load / preset_export', () => {
  test('valid with numeric id', () => {
    ok(JsonValidator.validateByCommand('preset_load', { presetId: 42 }));
    ok(JsonValidator.validateByCommand('preset_export', { presetId: 42 }));
  });
  test('valid with string id', () => {
    ok(JsonValidator.validateByCommand('preset_load', { presetId: 'abc' }));
  });
  test('missing presetId', () => {
    errs(JsonValidator.validateByCommand('preset_load', {}), ['presetId is required']);
    errs(JsonValidator.validateByCommand('preset_export', {}), ['presetId is required']);
  });
});

describe('preset_list', () => {
  test('valid with type', () => {
    ok(JsonValidator.validateByCommand('preset_list', { type: 'routing' }));
  });
  test('missing type', () => {
    errs(JsonValidator.validateByCommand('preset_list', {}), ['type is required']);
  });
});

describe('preset_delete', () => {
  test('valid', () => {
    ok(JsonValidator.validateByCommand('preset_delete', { presetId: 7 }));
  });
  test('missing presetId', () => {
    errs(JsonValidator.validateByCommand('preset_delete', {}), ['presetId is required']);
  });
});

describe('preset_rename', () => {
  test('valid', () => {
    ok(JsonValidator.validateByCommand('preset_rename', { presetId: 1, newName: 'Renamed' }));
  });
  test('missing newName', () => {
    errs(
      JsonValidator.validateByCommand('preset_rename', { presetId: 1 }),
      ['newName is required']
    );
  });
  test('missing presetId', () => {
    errs(
      JsonValidator.validateByCommand('preset_rename', { newName: 'X' }),
      ['presetId is required']
    );
  });
});
