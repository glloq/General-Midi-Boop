// src/api/commands/schemas/device.schemas.js
// Declarative schemas for device WS commands (P1-3.2c, ADR-004).

const requireDeviceId = {
  custom: (data) => (!data.deviceId ? 'deviceId is required' : null)
};

export const device_info = requireDeviceId;
export const device_enable = requireDeviceId;
export const virtual_delete = requireDeviceId;
export const ble_disconnect = requireDeviceId;

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

const schemas = {
  device_info,
  device_enable,
  device_set_properties,
  virtual_create,
  virtual_delete,
  ble_connect,
  ble_disconnect
};

export default schemas;
