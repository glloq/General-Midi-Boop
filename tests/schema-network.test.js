// tests/schema-network.test.js
// Schemas for `network_*` WS commands (PR 3, ROADMAP_DI_2026-05-21).

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const ok = (result) => expect(result).toEqual({ valid: true, errors: [] });
const errs = (result, expected) => {
  expect(result.valid).toBe(false);
  for (const fragment of expected) {
    expect(result.errors.join(' | ')).toContain(fragment);
  }
};

describe('network_scan', () => {
  test('valid with no payload', () => {
    ok(JsonValidator.validateByCommand('network_scan', {}));
  });
  test('valid with timeout and fullScan', () => {
    ok(JsonValidator.validateByCommand('network_scan', { timeout: 10, fullScan: false }));
  });
  test('negative timeout rejected', () => {
    errs(JsonValidator.validateByCommand('network_scan', { timeout: -1 }), [
      'timeout must be >= 0'
    ]);
  });
  test('fullScan must be boolean', () => {
    errs(JsonValidator.validateByCommand('network_scan', { fullScan: 'yes' }), [
      'fullScan must be a boolean'
    ]);
  });
});

describe('network_connected_list', () => {
  test('valid with empty payload', () => {
    ok(JsonValidator.validateByCommand('network_connected_list', {}));
  });
});

describe('network_connect', () => {
  test('valid with ip', () => {
    ok(JsonValidator.validateByCommand('network_connect', { ip: '192.168.1.10' }));
  });
  test('valid with legacy address alias', () => {
    ok(
      JsonValidator.validateByCommand('network_connect', { address: '192.168.1.10', port: '5004' })
    );
  });
  test('missing both ip and address', () => {
    errs(JsonValidator.validateByCommand('network_connect', {}), ['Device IP address is required']);
  });
});

describe('network_disconnect', () => {
  test('valid with ip', () => {
    ok(JsonValidator.validateByCommand('network_disconnect', { ip: '192.168.1.10' }));
  });
  test('missing ip and address', () => {
    errs(JsonValidator.validateByCommand('network_disconnect', {}), [
      'Device IP address is required'
    ]);
  });
});
