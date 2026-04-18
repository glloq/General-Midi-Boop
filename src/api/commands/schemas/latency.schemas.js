/**
 * @file src/api/commands/schemas/latency.schemas.js
 * @description Declarative validation schemas for `latency_*` WebSocket
 * commands (P1-3.2c, ADR-004). Consumed by
 * `JsonValidator.validateLatencyCommand`.
 */

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

const schemas = {
  latency_measure,
  latency_set,
  latency_get,
  latency_delete
};

export default schemas;
