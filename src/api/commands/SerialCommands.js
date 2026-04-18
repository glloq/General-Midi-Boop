/**
 * @file src/api/commands/SerialCommands.js
 * @description WebSocket commands for serial-port MIDI devices. The
 * SerialMidiManager is optional (depends on the `serialport` native
 * package); read commands degrade to "not available" while write
 * commands throw {@link ConfigurationError}.
 *
 * Registered commands:
 *   - `serial_scan`        — enumerate attached ports
 *   - `serial_list`        — list opened ports
 *   - `serial_open` / `_close`
 *   - `serial_status`      — manager state snapshot
 *   - `serial_set_enabled` — toggle + persist to config.json
 *
 * Validation: imperative inside each handler.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

/**
 * Enumerate every serial port currently visible. When the manager is
 * absent, returns a polite "not available" record so the UI can show a
 * setup hint instead of an error toast.
 *
 * @param {Object} app
 * @returns {Promise<{success:true, available:boolean, ports:Object[],
 *   message?:string}>}
 */
async function serialScan(app) {
  if (!app.serialMidiManager) {
    return { success: true, available: false, ports: [], message: 'Serial MIDI not available. Install: npm install serialport' };
  }

  const ports = await app.serialMidiManager.scanPorts();
  return { success: true, available: true, ports };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, ports:Object[]}>}
 */
async function serialList(app) {
  if (!app.serialMidiManager) {
    return { success: true, ports: [] };
  }

  return { success: true, ports: app.serialMidiManager.getConnectedPorts() };
}

/**
 * Open a serial port. `direction` selects whether MIDI flows in, out, or
 * both (defaults to `'both'`).
 *
 * @param {Object} app
 * @param {{path:string, name?:string, direction?:('in'|'out'|'both')}} data
 * @returns {Promise<{success:true, port:{path:string, name:string,
 *   direction:string}}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function serialOpen(app, data) {
  if (!app.serialMidiManager) {
    throw new ConfigurationError('Serial MIDI not available');
  }
  if (!data.path) {
    throw new ValidationError('path is required', 'path');
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

/**
 * @param {Object} app
 * @param {{path:string}} data
 * @returns {Promise<{success:true}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function serialClose(app, data) {
  if (!app.serialMidiManager) {
    throw new ConfigurationError('Serial MIDI not available');
  }
  if (!data.path) {
    throw new ValidationError('path is required', 'path');
  }

  await app.serialMidiManager.closePort(data.path);
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<Object>} `{enabled, available, scanning, openPorts, ports}`.
 *   Reports `available:false` when the manager is missing.
 */
async function serialStatus(app) {
  if (!app.serialMidiManager) {
    return { enabled: false, available: false, scanning: false, openPorts: 0, ports: [] };
  }

  return app.serialMidiManager.getStatus();
}

/**
 * Toggle serial MIDI on/off. The new value is persisted to
 * `config.json` so it survives restarts.
 *
 * @param {Object} app
 * @param {{enabled:boolean}} data
 * @returns {Promise<{success:true}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function serialSetEnabled(app, data) {
  if (data.enabled === undefined) {
    throw new ValidationError('enabled is required', 'enabled');
  }

  if (!app.serialMidiManager) {
    throw new ConfigurationError('Serial MIDI manager not initialized');
  }

  const result = await app.serialMidiManager.setEnabled(data.enabled);

  app.config.set('serial.enabled', data.enabled);
  app.config.save();

  return { success: true, ...result };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('serial_scan', () => serialScan(app));
  registry.register('serial_list', () => serialList(app));
  registry.register('serial_open', (data) => serialOpen(app, data));
  registry.register('serial_close', (data) => serialClose(app, data));
  registry.register('serial_status', () => serialStatus(app));
  registry.register('serial_set_enabled', (data) => serialSetEnabled(app, data));
}
