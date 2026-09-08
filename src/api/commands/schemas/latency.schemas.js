/**
 * @file src/api/commands/schemas/latency.schemas.js
 * @description Declarative validation schemas for `latency_*` WebSocket
 * commands (P1-3.2c, ADR-004). Consumed by
 * `JsonValidator.validateByCommand`.
 */
import {
  fieldRules,
  isIdLike,
  isIntLike,
  isNumLike,
  isChannel,
  isNonEmptyStr,
  isArrayMax,
  MAX_ID_LEN
} from './helpers.js';

const requireDeviceId = {
  custom: (data) => (!data.deviceId ? 'deviceId is required' : null)
};

export const latency_measure = requireDeviceId;
export const latency_get = requireDeviceId;
export const latency_delete = requireDeviceId;

// latency_set : deviceId + latency (positive number) required.
// Double-error pattern preserved (snapshot-aligned) : both messages stack
// when latency is missing, because `undefined` also fails the type check.
export const latency_set = {
  custom: (data) => {
    const errors = [];
    if (!data.deviceId) errors.push('deviceId is required');
    if (data.latency === undefined) {
      errors.push('latency is required');
    } else if (typeof data.latency !== 'number' || data.latency < 0) {
      errors.push('latency must be a positive number');
    }
    return errors;
  }
};

// ── F-19 backfill: the 5 remaining payload-taking latency/calibration
// commands. `LatencyCommands` accepted 56 of 70 hostile frames — the highest
// acceptance rate of any module with real side effects: these handlers spawn
// `arecord` pipelines and emit MIDI notes
// (docs/audit/2026-09-07/01_API_CONTRACT.md §3.3).
//
// The value ranges (threshold 0.01-0.10, measurements 1-20, channel 0-15) are
// already enforced imperatively by the handlers with precise messages; the
// schemas add the type gate those checks assume.

/** ALSA device strings are format-checked by `DelayCalibrator.isValidAlsaDevice`. */
const alsaRule = ['alsaDevice', (v) => isNonEmptyStr(v, MAX_ID_LEN), 'alsaDevice must be a string'];

export const calibrate_delay = {
  custom: fieldRules([
    ['deviceId', isIdLike, 'deviceId must be a number or non-empty string'],
    ['channel', isChannel, 'channel must be between 0 and 15'],
    ['threshold', (v) => isNumLike(v, 0, 1), 'threshold must be a number'],
    [
      'measurements',
      (v) => isIntLike(v, 1, 20),
      'measurements must be an integer between 1 and 20'
    ],
    alsaRule
  ])
};

export const calibrate_preview_note = {
  custom: fieldRules([
    ['deviceId', isIdLike, 'deviceId must be a number or non-empty string'],
    ['channel', isChannel, 'channel must be between 0 and 15']
  ])
};

export const calibrate_monitor_start = { custom: fieldRules([alsaRule]) };
export const tuner_monitor_start = { custom: fieldRules([alsaRule]) };

export const latency_auto_calibrate = {
  custom: fieldRules([
    [
      'deviceIds',
      (v) => isArrayMax(256)(v) && v.every(isIdLike),
      'deviceIds must be an array of device ids'
    ]
  ])
};

const schemas = {
  latency_measure,
  latency_set,
  latency_get,
  latency_delete,
  latency_auto_calibrate,
  calibrate_delay,
  calibrate_preview_note,
  calibrate_monitor_start,
  tuner_monitor_start
};

export default schemas;
