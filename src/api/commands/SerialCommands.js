// src/api/commands/SerialCommands.js

async function serialScan(app) {
  if (!app.serialMidiManager) {
    return { success: true, available: false, ports: [], message: 'Serial MIDI not available. Install: npm install serialport' };
  }

  const ports = await app.serialMidiManager.scanPorts();
  return { success: true, available: true, ports };
}

async function serialList(app) {
  if (!app.serialMidiManager) {
    return { success: true, ports: [] };
  }

  return { success: true, ports: app.serialMidiManager.getConnectedPorts() };
}

async function serialOpen(app, data) {
  if (!app.serialMidiManager) {
    throw new Error('Serial MIDI not available');
  }
  if (!data.path) {
    throw new Error('path is required');
  }

  const result = await app.serialMidiManager.openPort(
    data.path,
    data.name || null,
    data.direction || 'both'
  );

  return {
    success: true,
    port: {
      path: result.path,
      name: result.name,
      direction: result.direction
    }
  };
}

async function serialClose(app, data) {
  if (!app.serialMidiManager) {
    throw new Error('Serial MIDI not available');
  }
  if (!data.path) {
    throw new Error('path is required');
  }

  await app.serialMidiManager.closePort(data.path);
  return { success: true };
}

async function serialStatus(app) {
  if (!app.serialMidiManager) {
    return { enabled: false, available: false, scanning: false, openPorts: 0, ports: [] };
  }

  return app.serialMidiManager.getStatus();
}

async function serialSetEnabled(app, data) {
  if (data.enabled === undefined) {
    throw new Error('enabled is required');
  }

  if (!app.serialMidiManager) {
    throw new Error('Serial MIDI manager not initialized');
  }

  const result = await app.serialMidiManager.setEnabled(data.enabled);

  // Persist to config.json so the setting survives restarts
  app.config.set('serial.enabled', data.enabled);
  app.config.save();

  return { success: true, ...result };
}

export function register(registry, app) {
  registry.register('serial_scan', () => serialScan(app));
  registry.register('serial_list', () => serialList(app));
  registry.register('serial_open', (data) => serialOpen(app, data));
  registry.register('serial_close', (data) => serialClose(app, data));
  registry.register('serial_status', () => serialStatus(app));
  registry.register('serial_set_enabled', (data) => serialSetEnabled(app, data));
}
