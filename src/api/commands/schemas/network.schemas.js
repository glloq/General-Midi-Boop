/**
 * @file src/api/commands/schemas/network.schemas.js
 * @description Declarative validation schemas for `network_*`
 * WebSocket commands (PR 3, ROADMAP_DI_2026-05-21).
 *
 * Network/RTP-MIDI device control. `network_connect` / `_disconnect`
 * accept either `ip` or its legacy `address` alias — checked via a
 * custom validator since neither is independently required.
 * See `src/api/commands/NetworkCommands.js`.
 */

const requireIpOrAddress = (data) => {
  if (!data.ip && !data.address) return 'Device IP address is required';
  return null;
};

export const network_scan = {
  fields: {
    timeout: { type: 'number', min: 0 },
    fullScan: { type: 'boolean' }
  }
};

export const network_connected_list = {};

export const network_connect = {
  fields: {
    ip: { type: 'string', minLength: 1 },
    address: { type: 'string', minLength: 1 },
    port: { type: 'string', minLength: 1 }
  },
  custom: requireIpOrAddress
};

export const network_disconnect = {
  fields: {
    ip: { type: 'string', minLength: 1 },
    address: { type: 'string', minLength: 1 }
  },
  custom: requireIpOrAddress
};

const schemas = {
  network_scan,
  network_connected_list,
  network_connect,
  network_disconnect
};

export default schemas;
