// src/api/commands/NetworkCommands.js
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

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

export function register(registry, app) {
  registry.register('network_scan', (data) => networkScan(app, data));
  registry.register('network_connected_list', () => networkConnectedList(app));
  registry.register('network_connect', (data) => networkConnect(app, data));
  registry.register('network_disconnect', (data) => networkDisconnect(app, data));
}
