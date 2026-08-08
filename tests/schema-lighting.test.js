// tests/schema-lighting.test.js
// Audit B1: the lighting command surface had NO schema, so numeric/array inputs
// reached the manager and drivers unvalidated. These schemas bound the fields
// that flow into hardware/DB/timers.

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const ok = (r) => expect(r).toEqual({ valid: true, errors: [] });
const bad = (r, fragment) => {
  expect(r.valid).toBe(false);
  if (fragment) expect(r.errors.join(' | ')).toContain(fragment);
};

describe('lighting_device_add', () => {
  test('valid device passes', () => {
    ok(
      JsonValidator.validateByCommand('lighting_device_add', {
        name: 'Strip 1',
        type: 'artnet',
        led_count: 60,
        connection_config: { host: '192.168.1.50', port: 6454 }
      })
    );
  });
  test('missing name rejected', () => {
    bad(
      JsonValidator.validateByCommand('lighting_device_add', { type: 'gpio' }),
      'name is required'
    );
  });
  test('unknown type rejected', () => {
    bad(
      JsonValidator.validateByCommand('lighting_device_add', { name: 'x', type: 'laser' }),
      'type must be one of'
    );
  });
  test('absurd led_count rejected (OOM guard)', () => {
    bad(
      JsonValidator.validateByCommand('lighting_device_add', { name: 'x', led_count: 1e9 }),
      'led_count'
    );
  });
  test('absurd strip led_count rejected', () => {
    bad(
      JsonValidator.validateByCommand('lighting_device_add', {
        name: 'x',
        type: 'gpio_strip',
        connection_config: { strips: [{ led_count: 1e9 }] }
      }),
      'strip led_count'
    );
  });
  test('out-of-range port rejected', () => {
    bad(
      JsonValidator.validateByCommand('lighting_device_add', {
        name: 'x',
        type: 'artnet',
        connection_config: { port: 70000 }
      }),
      'port'
    );
  });
});

describe('lighting_master_dimmer', () => {
  test('valid value passes; absent value (getter) passes', () => {
    ok(JsonValidator.validateByCommand('lighting_master_dimmer', { value: 128 }));
    ok(JsonValidator.validateByCommand('lighting_master_dimmer', {}));
  });
  test('non-numeric / out-of-range value rejected', () => {
    bad(JsonValidator.validateByCommand('lighting_master_dimmer', { value: {} }), 'value');
    bad(JsonValidator.validateByCommand('lighting_master_dimmer', { value: 999 }), 'value');
  });
});

describe('lighting_effect_start', () => {
  test('valid passes', () => {
    ok(
      JsonValidator.validateByCommand('lighting_effect_start', {
        device_id: 1,
        effect_type: 'rainbow',
        led_start: 0,
        led_end: 59
      })
    );
  });
  test('missing device_id/effect_type rejected', () => {
    bad(JsonValidator.validateByCommand('lighting_effect_start', {}), 'device_id is required');
    bad(
      JsonValidator.validateByCommand('lighting_effect_start', { device_id: 1 }),
      'effect_type is required'
    );
  });
  test('non-integer led_end rejected', () => {
    bad(
      JsonValidator.validateByCommand('lighting_effect_start', {
        device_id: 1,
        effect_type: 'chase',
        led_end: 'lots'
      }),
      'led_end must be an integer'
    );
  });
});

describe('lighting_group_create / lighting_group_color', () => {
  test('device_ids over the cap rejected', () => {
    bad(
      JsonValidator.validateByCommand('lighting_group_create', {
        name: 'G',
        device_ids: new Array(300).fill(1)
      }),
      'too many device_ids'
    );
  });
  test('out-of-range rgb rejected', () => {
    bad(JsonValidator.validateByCommand('lighting_group_color', { r: 300 }), 'r must be');
    ok(JsonValidator.validateByCommand('lighting_group_color', { r: 10, g: 20, b: 30 }));
  });
});
