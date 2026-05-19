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
 * @throws {ConfigurationError}
 */
function _requireNetwork(app) {
  if (!app.networkManager) {
    throw new ConfigurationError('Network manager not available');
  }
  return app.networkManager;
}

/**
 * Resolve the destination IP, accepting both `ip` and the legacy
 * `address` alias.
 * @throws {ValidationError}
 */
function _requireIp(data) {
  if (!data.ip && !data.address) {
    throw new ValidationError('Device IP address is required', 'ip');
  }
  return data.ip || data.address;
}

/**
 * @param {Object} app
 * @param {{timeout?:number, fullScan?:boolean}} data - `timeout` in
 *   seconds (defaults to 5); `fullScan` defaults to true.
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function networkScan(app, data) {
  const mgr = _requireNetwork(app);
  const fullScan = data.fullScan !== undefined ? data.fullScan : true;
  const devices = await mgr.startScan(data.timeout || 5, fullScan);
  return { success: true, data: { devices } };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function networkConnectedList(app) {
  const devices = _requireNetwork(app).getConnectedDevices();
  return { success: true, data: { devices } };
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
  const mgr = _requireNetwork(app);
  const ip = _requireIp(data);
  const result = await mgr.connect(ip, data.port || '5004');
  return { success: true, data: result };
}

/**
 * @param {Object} app
 * @param {{ip?:string, address?:string}} data
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function networkDisconnect(app, data) {
  const mgr = _requireNetwork(app);
  const result = await mgr.disconnect(_requireIp(data));
  return { success: true, data: result };
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
