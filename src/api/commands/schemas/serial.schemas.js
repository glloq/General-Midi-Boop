/**
 * @file src/api/commands/schemas/serial.schemas.js
 * @description Declarative validation schemas for the `serial_*` WebSocket
 * commands. Consumed by `JsonValidator.validateByCommand`.
 *
 * `SerialCommands` shipped with 6/6 commands unvalidated, and the fuzzing
 * campaign showed a hostile string travelling intact all the way to the
 * transport: `Port not open: ../../../../../…/etc/passwd`
 * (docs/audit/2026-09-07/01_API_CONTRACT.md §3.4). Nothing is opened by that
 * path — `closePort` only looks it up in a Map — but a 200 000-character or
 * control-byte-laden device path has no business reaching the serial layer or
 * the logs in the first place.
 */
import {
  fieldRules,
  isBoolLike,
  isNonEmptyStr,
  isStr,
  MAX_ID_LEN,
  MAX_NAME_LEN
} from './helpers.js';

/** A POSIX device path: printable, bounded, no control bytes, no NUL. */
function isDevicePath(v) {
  // eslint-disable-next-line no-control-regex -- control bytes are exactly what we reject
  return isNonEmptyStr(v, MAX_ID_LEN) && !/[\x00-\x1f\x7f]/.test(v);
}

export const serial_open = {
  custom: fieldRules([
    ['path', isDevicePath, 'path must be a device path without control bytes', { required: true }],
    ['name', (v) => isStr(v, MAX_NAME_LEN), 'name must be a string'],
    [
      'direction',
      (v) => ['in', 'out', 'both'].includes(v),
      'direction must be one of: in, out, both'
    ]
  ])
};

export const serial_close = {
  custom: fieldRules([
    ['path', isDevicePath, 'path must be a device path without control bytes', { required: true }]
  ])
};

export const serial_set_enabled = {
  custom: fieldRules([['enabled', isBoolLike, 'enabled must be a boolean', { required: true }]])
};

const schemas = {
  serial_open,
  serial_close,
  serial_set_enabled
};

export default schemas;
