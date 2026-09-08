/**
 * @file src/api/commands/schemas/device.schemas.js
 * @description Declarative validation schemas for `device_*`,
 * `virtual_*` and `ble_*` WebSocket commands (P1-3.2c, ADR-004).
 * Consumed by `JsonValidator.validateByCommand`.
 */
import {
  fieldRules,
  isIdLike,
  isIntLike,
  isBoolLike,
  isStr,
  isNonEmptyStr,
  isPlainObject,
  isChannel,
  MAX_ID_LEN,
  MAX_NAME_LEN
} from './helpers.js';

const requireDeviceId = {
  custom: (data) => (!data.deviceId ? 'deviceId is required' : null)
};

export const device_info = requireDeviceId;
export const device_enable = requireDeviceId;
export const virtual_delete = requireDeviceId;

// `ble_disconnect` used to reuse `requireDeviceId`, but `bleDisconnect` calls
// `_requireAddress(data)` and the SPA sends `{address}` (public/index.html) —
// so every disconnect was answered "Invalid ble_disconnect data: deviceId is
// required" and the command was unreachable. Aligned with `ble_connect`
// (found while backfilling F-19).
export const ble_disconnect = {
  custom: (data) => (!data.address ? 'address is required' : null)
};

export const device_set_properties = {
  custom: (data) => {
    const errors = [];
    if (!data.deviceId) errors.push('deviceId is required');
    if (!data.properties || typeof data.properties !== 'object') {
      errors.push('properties must be an object');
    }
    return errors;
  }
};

export const virtual_create = {
  custom: (data) => {
    if (!data.name || typeof data.name !== 'string') {
      return 'name is required and must be a string';
    }
    return null;
  }
};

export const ble_connect = {
  custom: (data) => (!data.address ? 'address is required' : null)
};

// ── F-19 backfill: the 7 remaining payload-taking device/BLE commands ──
// `DeviceCommands` turned 21 of 35 hostile frames into masked internal errors
// — the worst ratio measured — and `device_save_sysex_identity` reached
// `NOT NULL constraint failed: instruments_latency.device_id`
// (docs/audit/2026-09-07/01_API_CONTRACT.md §3.3-3.4).

export const ble_forget = {
  custom: (data) => (!data.address ? 'address is required' : null)
};

export const ble_scan_start = {
  custom: fieldRules([
    ['duration', (v) => isIntLike(v, 1, 300), 'duration must be an integer 1-300 seconds'],
    ['filter', (v) => isStr(v, MAX_NAME_LEN), 'filter must be a string']
  ])
};

export const device_get_settings = {
  custom: fieldRules([
    ['deviceId', isIdLike, 'deviceId must be a number or non-empty string', { required: true }]
  ])
};

export const device_update_settings = {
  custom: fieldRules([
    ['deviceId', isIdLike, 'deviceId must be a number or non-empty string', { required: true }],
    ['deviceName', (v) => isStr(v, MAX_NAME_LEN), 'deviceName must be a string'],
    ['custom_name', (v) => isStr(v, 255), 'custom_name must be a string'],
    ['midi_clock_enabled', isBoolLike, 'midi_clock_enabled must be a boolean'],
    [
      'message_rate_limit',
      (v) => isIntLike(v, 0, 100000),
      'message_rate_limit must be a non-negative integer'
    ]
  ])
};

// `deviceId` here is the SysEx *device ID* byte (0-127, 0x7F = broadcast), not
// a transport id — `sendIdentityRequest(data.deviceName, data.deviceId||0x7f)`.
const identityRequestSchema = {
  custom: fieldRules([
    ['deviceName', (v) => isNonEmptyStr(v, MAX_ID_LEN), 'deviceName must be a non-empty string'],
    ['deviceId', (v) => isIntLike(v, 0, 127), 'deviceId must be a SysEx device id 0-127']
  ])
};
export const device_identity_request = identityRequestSchema;
export const sysex_identity_request = identityRequestSchema;

export const device_save_sysex_identity = {
  custom: fieldRules([
    ['deviceId', isIdLike, 'deviceId must be a number or non-empty string', { required: true }],
    ['channel', isChannel, 'channel must be between 0 and 15'],
    ['identity', isPlainObject, 'identity must be an object', { required: true }]
  ])
};

const schemas = {
  device_info,
  device_enable,
  device_set_properties,
  virtual_create,
  virtual_delete,
  ble_connect,
  ble_disconnect,
  ble_forget,
  ble_scan_start,
  device_get_settings,
  device_update_settings,
  device_identity_request,
  sysex_identity_request,
  device_save_sysex_identity
};

export default schemas;
