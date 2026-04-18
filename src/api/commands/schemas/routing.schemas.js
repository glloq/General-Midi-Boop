/**
 * @file src/api/commands/schemas/routing.schemas.js
 * @description Declarative validation schemas for routing-related
 * WebSocket commands (`route_*`, `filter_*`, `channel_map`, `monitor_*`).
 * Consumed by `JsonValidator.validateRoutingCommand` (P1-3.2b, ADR-004).
 *
 * Snapshot-preserving: error messages match the legacy
 * `JsonValidator.validateRoutingCommand` output captured in
 * `docs/refactor/contracts/routing/*.contract.json`.
 */

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

const schemas = {
  route_create,
  route_delete,
  route_enable,
  filter_set,
  filter_clear,
  channel_map,
  monitor_start,
  monitor_stop
};

export default schemas;
