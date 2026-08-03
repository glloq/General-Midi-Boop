// tests/schema-bank-effects.test.js
// Schemas for `bank_effects_*` WS commands (PR 3, ROADMAP_DI_2026-05-21).

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const ok = (result) => expect(result).toEqual({ valid: true, errors: [] });
const errs = (result, expected) => {
  expect(result.valid).toBe(false);
  for (const fragment of expected) {
    expect(result.errors.join(' | ')).toContain(fragment);
  }
};

describe('bank_effects_get', () => {
  test('valid with bankId', () => {
    ok(JsonValidator.validateByCommand('bank_effects_get', { bankId: 'GM' }));
  });
  test('missing bankId', () => {
    errs(JsonValidator.validateByCommand('bank_effects_get', {}), ['bankId is required']);
  });
  test('bankId too long', () => {
    errs(JsonValidator.validateByCommand('bank_effects_get', { bankId: 'x'.repeat(65) }), [
      'bankId must be at most 64 characters'
    ]);
  });
});

describe('bank_effects_list', () => {
  test('valid with empty payload', () => {
    ok(JsonValidator.validateByCommand('bank_effects_list', {}));
  });
});

describe('bank_effects_update', () => {
  test('valid with only bankId (partial update)', () => {
    ok(JsonValidator.validateByCommand('bank_effects_update', { bankId: 'GM' }));
  });
  test('valid with all fields at bounds', () => {
    ok(
      JsonValidator.validateByCommand('bank_effects_update', {
        bankId: 'GM',
        reverb_mix: 0,
        reverb_decay_s: 3.0,
        echo_mix: 1,
        echo_time_ms: 50,
        echo_feedback: 0.9
      })
    );
  });
  test('reverb_mix out of range', () => {
    errs(
      JsonValidator.validateByCommand('bank_effects_update', { bankId: 'GM', reverb_mix: 1.5 }),
      ['reverb_mix must be between 0 and 1']
    );
  });
  test('echo_time_ms must be integer', () => {
    errs(
      JsonValidator.validateByCommand('bank_effects_update', { bankId: 'GM', echo_time_ms: 100.5 }),
      ['echo_time_ms must be an integer']
    );
  });
  test('echo_feedback above max', () => {
    errs(
      JsonValidator.validateByCommand('bank_effects_update', { bankId: 'GM', echo_feedback: 1.0 }),
      ['echo_feedback must be between 0 and 0.9']
    );
  });
  test('missing bankId', () => {
    errs(JsonValidator.validateByCommand('bank_effects_update', { reverb_mix: 0.5 }), [
      'bankId is required'
    ]);
  });
});

describe('bank_effects_reset', () => {
  test('valid with bankId', () => {
    ok(JsonValidator.validateByCommand('bank_effects_reset', { bankId: 'GM' }));
  });
  test('missing bankId', () => {
    errs(JsonValidator.validateByCommand('bank_effects_reset', {}), ['bankId is required']);
  });
});
