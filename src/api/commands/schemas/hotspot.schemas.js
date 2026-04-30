/**
 * @file src/api/commands/schemas/hotspot.schemas.js
 * @description Declarative validation schemas for `hotspot_*` WebSocket
 * commands. Consumed by `JsonValidator.validateByCommand`.
 */

/**
 * `hotspot_update_config`: all fields optional individually but at least
 * one must be present. SSID and password are checked for obvious WPA2
 * minimums when provided; band must be 'a' or 'bg'.
 */
export const hotspot_update_config = {
  custom: (data) => {
    if (!data || typeof data !== 'object') return 'payload must be an object';
    const keys = ['ssid', 'password', 'band', 'channel'];
    if (!keys.some((k) => data[k] !== undefined)) return 'no field to update';

    if (data.ssid !== undefined) {
      if (typeof data.ssid !== 'string' || data.ssid.length < 1 || data.ssid.length > 32) {
        return 'ssid must be a string of 1..32 characters';
      }
    }
    if (data.password !== undefined) {
      if (typeof data.password !== 'string' || data.password.length < 8 || data.password.length > 63) {
        return 'password must be a string of 8..63 characters (WPA2)';
      }
    }
    if (data.band !== undefined && data.band !== 'a' && data.band !== 'bg') {
      return "band must be 'a' or 'bg'";
    }
    if (data.channel !== undefined) {
      const ch = Number(data.channel);
      if (!Number.isInteger(ch) || ch < 0 || ch > 196) {
        return 'channel must be an integer between 0 and 196';
      }
    }
    return null;
  }
};

const schemas = {
  hotspot_update_config
};

export default schemas;
