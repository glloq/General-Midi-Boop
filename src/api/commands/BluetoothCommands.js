// src/api/commands/BluetoothCommands.js
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

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

async function bleScanStop(app) {
  if (!app.bluetoothManager) {
    throw new ConfigurationError('Bluetooth not available');
  }

  app.bluetoothManager.stopScan();
  return { success: true };
}

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

async function bleStatus(app) {
  if (!app.bluetoothManager) {
    return {
      enabled: false,
      available: false
    };
  }

  return app.bluetoothManager.getStatus();
}

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
