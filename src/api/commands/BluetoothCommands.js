/**
 * @file src/api/commands/BluetoothCommands.js
 * @description WebSocket commands for Bluetooth Low Energy MIDI devices.
 * All handlers throw {@link ConfigurationError} when the optional
 * BluetoothManager is not loaded (no `node-ble`, no permissions, or
 * BLE disabled in config).
 *
 * Registered commands:
 *   - `ble_scan_start` / `_stop`   — active scan with optional filter
 *   - `ble_connect` / `_disconnect`/ `_forget`
 *   - `ble_paired`                 — list bonded devices
 *   - `ble_status`                 — adapter availability + state
 *   - `ble_power_on` / `_off`      — adapter power control
 *
 * Validation: see `device.schemas.js` for `ble_connect` / `ble_disconnect`
 * (require `address`); other commands rely on inline checks.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

/**
 * @throws {ConfigurationError}
 */
function _requireBle(app) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }
  return app.bluetoothManager;
}

/**
 * @throws {ValidationError}
 */
function _requireAddress(data) {
  if (!data.address) {
    throw new ValidationError('Device address is required', 'address');
  }
  return data.address;
}

/**
 * @param {Object} app
 * @param {{duration?:number, filter?:string}} data - `duration` in
 *   seconds (defaults to 5); `filter` substring matched against device
 *   names server-side.
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function bleScanStart(app, data) {
  const ble = _requireBle(app);
  try {
    const devices = await ble.startScan(data.duration || 5, data.filter || '');
    return { success: true, data: { devices } };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`BLE scan error: ${error.message}`);
  }
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 * @throws {ConfigurationError}
 */
async function bleScanStop(app) {
  _requireBle(app).stopScan();
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{address:string}} data - Bluetooth MAC address.
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function bleConnect(app, data) {
  const ble = _requireBle(app);
  const result = await ble.connect(_requireAddress(data));
  return { success: true, data: result };
}

/**
 * @param {Object} app
 * @param {{address:string}} data
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function bleDisconnect(app, data) {
  const ble = _requireBle(app);
  const result = await ble.disconnect(_requireAddress(data));
  return { success: true, data: result };
}

/**
 * Remove a previously paired device from the bonding list.
 *
 * @param {Object} app
 * @param {{address:string}} data
 * @returns {Promise<{success:true}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function bleForget(app, data) {
  const ble = _requireBle(app);
  await ble.forget(_requireAddress(data));
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function blePaired(app) {
  const devices = _requireBle(app).getPairedDevices();
  return { success: true, data: { devices } };
}

/**
 * Returns adapter availability + state. Unlike the other handlers, this
 * one does NOT throw when the manager is missing — it reports
 * `{enabled:false, available:false}` so the UI can hide BLE controls.
 *
 * @param {Object} app
 * @returns {Promise<Object>}
 */
async function bleStatus(app) {
  if (!app.bluetoothManager) {
    return {
      enabled: false,
      available: false
    };
  }

  // Wait for adapter initialization so the status reflects the real state,
  // not the transient false/_ready=false during boot.
  if (app.bluetoothManager._initPromise) {
    await app.bluetoothManager._initPromise.catch(() => {});
  }

  return app.bluetoothManager.getStatus();
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError}
 */
async function blePowerOn(app) {
  const result = await _requireBle(app).powerOn();
  return { success: true, data: result };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError}
 */
async function blePowerOff(app) {
  const result = await _requireBle(app).powerOff();
  return { success: true, data: result };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('ble_scan_start', (data) => bleScanStart(app, data));
  registry.register('ble_scan_stop', () => bleScanStop(app));
  registry.register('ble_connect', (data) => bleConnect(app, data));
  registry.register('ble_disconnect', (data) => bleDisconnect(app, data));
  registry.register('ble_forget', (data) => bleForget(app, data));
  registry.register('ble_paired', () => blePaired(app));
  registry.register('ble_status', () => bleStatus(app));
  registry.register('ble_power_on', () => blePowerOn(app));
  registry.register('ble_power_off', () => blePowerOff(app));
}
