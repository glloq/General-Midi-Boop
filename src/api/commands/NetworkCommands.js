/**
 * @file src/api/commands/NetworkCommands.js
 * @description WebSocket commands for network MIDI devices (RTP-MIDI,
 * mDNS-discovered AppleMIDI, etc.). All handlers throw
 * {@link ConfigurationError} when the optional NetworkManager is absent.
 *
 * Registered commands:
 *   - `network_scan`             — discovery sweep
 *   - `network_connected_list`   — currently bonded sessions
 *   - `network_connect` / `_disconnect` — by IP (or `address` alias)
 *
 * Validation: imperative inside each handler.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

/**
 * @param {Object} app
 * @param {{timeout?:number, fullScan?:boolean}} data - `timeout` in
 *   seconds (defaults to 5); `fullScan` defaults to true.
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function networkScan(app, data) {
  if (!app.networkManager) {
    throw new ConfigurationError('Network manager not available');
  }

  const timeout = data.timeout || 5;
  const fullScan = data.fullScan !== undefined ? data.fullScan : true;

  const devices = await app.networkManager.startScan(timeout, fullScan);

  return {
    success: true,
    data: {
      devices: devices
    }
  };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function networkConnectedList(app) {
  if (!app.networkManager) {
    throw new ConfigurationError('Network manager not available');
  }

  const devices = app.networkManager.getConnectedDevices();

  return {
    success: true,
    data: {
      devices: devices
    }
  };
}

/**
 * Connect to a network MIDI device. Accepts both `ip` and `address` as
 * the destination key for backwards compatibility with older clients.
 *
 * @param {Object} app
 * @param {{ip?:string, address?:string, port?:string}} data - `port`
 *   defaults to `'5004'` (the AppleMIDI default).
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function networkConnect(app, data) {
  if (!app.networkManager) {
    throw new ConfigurationError('Network manager not available');
  }

  if (!data.ip && !data.address) {
    throw new ValidationError('Device IP address is required', 'ip');
  }

  const ip = data.ip || data.address;
  const port = data.port || '5004';

  const result = await app.networkManager.connect(ip, port);

  return {
    success: true,
    data: result
  };
}

/**
 * @param {Object} app
 * @param {{ip?:string, address?:string}} data
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function networkDisconnect(app, data) {
  if (!app.networkManager) {
    throw new ConfigurationError('Network manager not available');
  }

  if (!data.ip && !data.address) {
    throw new ValidationError('Device IP address is required', 'ip');
  }

  const ip = data.ip || data.address;

  const result = await app.networkManager.disconnect(ip);

  return {
    success: true,
    data: result
  };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('network_scan', (data) => networkScan(app, data));
  registry.register('network_connected_list', () => networkConnectedList(app));
  registry.register('network_connect', (data) => networkConnect(app, data));
  registry.register('network_disconnect', (data) => networkDisconnect(app, data));
}
