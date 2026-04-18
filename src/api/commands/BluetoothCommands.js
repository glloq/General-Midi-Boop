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
 * @param {Object} app
 * @param {{duration?:number, filter?:string}} data - `duration` in
 *   seconds (defaults to 5); `filter` substring matched against device
 *   names server-side.
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function bleScanStart(app, data) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  const duration = data.duration || 5;
  const filter = data.filter || '';

  const devices = await app.bluetoothManager.startScan(duration, filter);

  return {
    success: true,
    data: {
      devices: devices
    }
  };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 * @throws {ConfigurationError}
 */
async function bleScanStop(app) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  app.bluetoothManager.stopScan();
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{address:string}} data - Bluetooth MAC address.
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function bleConnect(app, data) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  if (!data.address) {
    throw new ValidationError('Device address is required', 'address');
  }

  const result = await app.bluetoothManager.connect(data.address);

  return {
    success: true,
    data: result
  };
}

/**
 * @param {Object} app
 * @param {{address:string}} data
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function bleDisconnect(app, data) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  if (!data.address) {
    throw new ValidationError('Device address is required', 'address');
  }

  const result = await app.bluetoothManager.disconnect(data.address);

  return {
    success: true,
    data: result
  };
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
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  if (!data.address) {
    throw new ValidationError('Device address is required', 'address');
  }

  await app.bluetoothManager.forget(data.address);

  return {
    success: true
  };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:{devices:Object[]}}>}
 * @throws {ConfigurationError}
 */
async function blePaired(app) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  const devices = app.bluetoothManager.getPairedDevices();

  return {
    success: true,
    data: {
      devices: devices
    }
  };
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

  return app.bluetoothManager.getStatus();
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError}
 */
async function blePowerOn(app) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  const result = await app.bluetoothManager.powerOn();

  return {
    success: true,
    data: result
  };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, data:Object}>}
 * @throws {ConfigurationError}
 */
async function blePowerOff(app) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  const result = await app.bluetoothManager.powerOff();

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
