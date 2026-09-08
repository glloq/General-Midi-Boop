/**
 * @file src/api/commands/schemas/routing.schemas.js
 * @description Declarative validation schemas for routing-related
 * WebSocket commands (`route_*`, `filter_*`, `channel_map`, `monitor_*`).
 * Consumed by `JsonValidator.validateRoutingCommand` (P1-3.2b, ADR-004).
 *
 * Snapshot-preserving: error messages match the legacy
 * `JsonValidator.validateRoutingCommand` output captured in
 * `tests/contracts/fixtures/routing/*.contract.json`.
 */
import { fieldRules, isIdLike, isIntLike, isChannel, isPlainObject } from './helpers.js';

// route_create : source + destination required, both truthy.
export const route_create = {
  custom: (data) => {
    const errors = [];
    if (!data.source) errors.push('source is required');
    if (!data.destination) errors.push('destination is required');
    return errors;
  }
};

// route_delete / route_enable / filter_set / filter_clear / channel_map
// share the same rule : routeId required (truthy).
const requireRouteId = {
  custom: (data) => (!data.routeId ? 'routeId is required' : null)
};

export const route_delete = requireRouteId;
export const route_enable = requireRouteId;
export const filter_set = requireRouteId;
export const filter_clear = requireRouteId;
export const channel_map = requireRouteId;

// monitor_start / monitor_stop : deviceId required.
const requireDeviceId = {
  custom: (data) => (!data.deviceId ? 'deviceId is required' : null)
};

export const monitor_start = requireDeviceId;
export const monitor_stop = requireDeviceId;

// ── F-19 backfill: the 9 remaining payload-taking routing commands ──
// `RoutingCommands` turned 7 hostile frames into masked internal errors and
// accepted 37; `route_import` failed with a raw
// `Cannot read properties of undefined (reading 'id')`
// (docs/audit/2026-09-07/01_API_CONTRACT.md §3.3-3.4).
//
// Two commands keep their handler-side required checks instead of a schema
// `required` flag: `file_routing_sync` and `validate_routing_feasibility`
// already emit precise messages that the WS contract fixtures pin
// (`tests/contracts/fixtures/routing/*.contract.json`). Restating them here
// would change the wire text for no security gain — the schema adds the type
// gate those checks never had.

const requireRouteIdTyped = {
  custom: fieldRules([
    ['routeId', isIdLike, 'routeId must be a number or non-empty string', { required: true }]
  ])
};

export const route_info = requireRouteIdTyped;
export const route_export = requireRouteIdTyped;
export const route_duplicate = requireRouteIdTyped;

export const route_test = {
  custom: fieldRules([
    ['routeId', isIdLike, 'routeId must be a number or non-empty string', { required: true }],
    ['channel', isChannel, 'channel must be an integer between 0 and 15'],
    ['note', (v) => isIntLike(v, 0, 127), 'note must be a MIDI note 0-127'],
    ['velocity', (v) => isIntLike(v, 0, 127), 'velocity must be a velocity 0-127'],
    ['duration', (v) => isIntLike(v, 1, 10000), 'duration must be an integer 1-10000 ms']
  ])
};

export const route_import = {
  custom: fieldRules([['route', isPlainObject, 'route must be an object', { required: true }]])
};

export const file_routing_sync = {
  custom: fieldRules([
    ['fileId', isIdLike, 'fileId must be a number or non-empty string'],
    ['channels', isPlainObject, 'channels must be an object keyed by channel']
  ])
};

// `file_routing_bulk_sync` deliberately TOLERATES a non-object `routings` and
// answers `{synced:0, files:0}` — a documented contract case
// (`tests/contracts/fixtures/routing/file_routing_bulk_sync.contract.json`).
// The schema keeps that tolerance and instead bounds what the handler would
// actually iterate: one synchronous transaction per file on a Pi.
const MAX_BULK_FILES = 5000;

export const file_routing_bulk_sync = {
  custom: (data) => {
    if (isPlainObject(data.routings) && Object.keys(data.routings).length > MAX_BULK_FILES) {
      return `routings must cover at most ${MAX_BULK_FILES} files`;
    }
    return null;
  }
};

const feasibilityRules = [
  ['fileId', isIdLike, 'fileId must be a number or non-empty string'],
  ['deviceId', isIdLike, 'deviceId must be a number or non-empty string'],
  ['channel', isChannel, 'channel must be between 0 and 15'],
  ['targetChannel', isChannel, 'targetChannel must be between 0 and 15']
];

export const validate_routing_feasibility = { custom: fieldRules(feasibilityRules) };

export const routing_save_hand_overrides = {
  custom: fieldRules([
    ...feasibilityRules,
    // `null` clears the overrides, and the compiler skips absent/null values —
    // so this rule only rejects the scalars and arrays the handler would carry
    // into the repository.
    ['overrides', isPlainObject, 'overrides must be an object or null']
  ])
};

const schemas = {
  route_create,
  route_delete,
  route_enable,
  filter_set,
  filter_clear,
  channel_map,
  monitor_start,
  monitor_stop,
  route_info,
  route_export,
  route_duplicate,
  route_test,
  route_import,
  file_routing_sync,
  file_routing_bulk_sync,
  validate_routing_feasibility,
  routing_save_hand_overrides
};

export default schemas;
