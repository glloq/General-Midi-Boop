// tests/ws-validation-hardening.test.js
// Audit A2 D1:
//   - JsonValidator.validateCommand must reject an array/primitive `data`
//     (typeof [] === 'object' let arrays through, and the dispatcher passes
//     `message.data` straight to the handler).
//   - The JSON.parse reviver drops prototype-pollution keys at the edge so a
//     handler doing a merge cannot pollute Object.prototype.

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';
import { stripDangerousKeys } from '../src/api/WebSocketServer.js';

describe('validateCommand — data must be a plain object (audit A2 D1)', () => {
  test('accepts a plain object', () => {
    expect(JsonValidator.validateCommand({ command: 'x', data: { a: 1 } }).valid).toBe(true);
  });
  test('accepts absent data', () => {
    expect(JsonValidator.validateCommand({ command: 'x' }).valid).toBe(true);
  });
  test('tolerates null data (coerced to {} downstream)', () => {
    expect(JsonValidator.validateCommand({ command: 'x', data: null }).valid).toBe(true);
  });
  test('rejects an array data', () => {
    const r = JsonValidator.validateCommand({ command: 'x', data: [1, 2, 3] });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('Data field must be an object');
  });
  test('rejects a primitive data', () => {
    expect(JsonValidator.validateCommand({ command: 'x', data: 'nope' }).valid).toBe(false);
    expect(JsonValidator.validateCommand({ command: 'x', data: 7 }).valid).toBe(false);
  });
});

describe('stripDangerousKeys — JSON.parse reviver (audit A2 D1)', () => {
  test('drops __proto__ and does not pollute Object.prototype', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":1},"a":1}', stripDangerousKeys);
    expect(parsed.a).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
    // eslint-disable-next-line no-proto
    expect({}.polluted).toBeUndefined();
  });

  test('drops constructor / prototype keys', () => {
    const parsed = JSON.parse('{"constructor":9,"prototype":8,"keep":2}', stripDangerousKeys);
    expect(parsed.keep).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false);
  });

  test('strips nested dangerous keys too', () => {
    const parsed = JSON.parse('{"x":{"__proto__":{"y":1},"z":3}}', stripDangerousKeys);
    expect(parsed.x.z).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(parsed.x, '__proto__')).toBe(false);
  });

  test('leaves ordinary payloads intact', () => {
    const parsed = JSON.parse(
      '{"command":"noteon","data":{"note":60,"velocity":100}}',
      stripDangerousKeys
    );
    expect(parsed).toEqual({ command: 'noteon', data: { note: 60, velocity: 100 } });
  });
});
