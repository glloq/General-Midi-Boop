// tests/schema-session.test.js
// Audit A2 M2: every session_* command reached its handler unvalidated — the
// SESSION_SCHEMA/validateSession pair in JsonValidator was never wired into
// dispatch. In particular session_import persisted an arbitrary, unbounded
// `data` blob to the DB. These schemas are now registered in COMPILED_SCHEMAS.

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const ok = (result) => expect(result).toEqual({ valid: true, errors: [] });
const errs = (result, expected) => {
  expect(result.valid).toBe(false);
  for (const fragment of expected) {
    expect(result.errors.join(' | ')).toContain(fragment);
  }
};

describe('session_save', () => {
  test('valid payload passes', () => {
    ok(JsonValidator.validateByCommand('session_save', { name: 'My set', description: 'x' }));
  });
  test('missing / blank name rejected', () => {
    errs(JsonValidator.validateByCommand('session_save', {}), ['name is required']);
    errs(JsonValidator.validateByCommand('session_save', { name: '   ' }), ['name is required']);
  });
  test('overlong name rejected', () => {
    errs(JsonValidator.validateByCommand('session_save', { name: 'a'.repeat(201) }), [
      'name is too long'
    ]);
  });
});

describe('session_load', () => {
  test('valid payload passes', () => {
    ok(JsonValidator.validateByCommand('session_load', { sessionId: 5, dryRun: true }));
  });
  test('missing sessionId rejected', () => {
    errs(JsonValidator.validateByCommand('session_load', {}), ['sessionId is required']);
  });
  test('non-boolean dryRun rejected', () => {
    errs(JsonValidator.validateByCommand('session_load', { sessionId: 1, dryRun: 'yes' }), [
      'dryRun must be a boolean'
    ]);
  });
});

describe('session_import (audit A2 M2 — unbounded blob)', () => {
  test('valid payload passes', () => {
    ok(
      JsonValidator.validateByCommand('session_import', {
        name: 'imported',
        data: JSON.stringify({ routes: [] })
      })
    );
  });
  test('missing name rejected', () => {
    errs(JsonValidator.validateByCommand('session_import', { data: '{}' }), ['name is required']);
  });
  test('non-string data rejected', () => {
    errs(JsonValidator.validateByCommand('session_import', { name: 'x', data: { routes: [] } }), [
      'data must be a JSON string'
    ]);
  });
  test('oversized data blob rejected', () => {
    errs(
      JsonValidator.validateByCommand('session_import', {
        name: 'x',
        data: 'a'.repeat(1024 * 1024 + 1)
      }),
      ['data exceeds']
    );
  });
});

describe('session_delete / session_export', () => {
  test('require sessionId', () => {
    errs(JsonValidator.validateByCommand('session_delete', {}), ['sessionId is required']);
    errs(JsonValidator.validateByCommand('session_export', {}), ['sessionId is required']);
  });
  test('accept a sessionId', () => {
    ok(JsonValidator.validateByCommand('session_delete', { sessionId: 2 }));
    ok(JsonValidator.validateByCommand('session_export', { sessionId: 2 }));
  });
});
