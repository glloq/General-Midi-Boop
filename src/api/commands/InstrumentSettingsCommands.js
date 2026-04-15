// src/api/commands/InstrumentSettingsCommands.js
import InstrumentDatabase from '../../storage/InstrumentDatabase.js';
import InstrumentTypeConfig from '../../midi/InstrumentTypeConfig.js';
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

async function instrumentUpdateSettings(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  // Get USB serial number from data or from DeviceManager
  let usbSerialNumber = data.usb_serial_number;
  if (!usbSerialNumber && app.deviceManager) {
    const device = app.deviceManager.getDeviceInfo(data.deviceId);
    if (device && device.usbSerialNumber) {
      usbSerialNumber = device.usbSerialNumber;
    }
  }

  // Channel defaults to 0 for backward compatibility
  const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // Validate sync_delay range (milliseconds, ±5 seconds max)
  if (data.sync_delay !== undefined) {
    const parsedDelay = parseInt(data.sync_delay);
    if (isNaN(parsedDelay) || parsedDelay < -5000 || parsedDelay > 5000) {
      throw new ValidationError('sync_delay must be between -5000 and 5000 milliseconds', 'sync_delay');
    }
    data.sync_delay = parsedDelay;
  }

  // Validate gm_program range (0-127 for instruments, null allowed)
  if (data.gm_program !== undefined && data.gm_program !== null) {
    const gmProg = parseInt(data.gm_program);
    if (isNaN(gmProg) || gmProg < 0 || gmProg > 127) {
      throw new ValidationError('gm_program must be between 0 and 127', 'gm_program');
    }
    data.gm_program = gmProg;
  }

  // Validate custom_name length
  if (data.custom_name && data.custom_name.length > 255) {
    throw new ValidationError('custom_name must not exceed 255 characters', 'custom_name');
  }

  // Validate octave_mode
  if (data.octave_mode !== undefined && data.octave_mode !== null) {
    const validModes = ['chromatic', 'diatonic', 'pentatonic'];
    if (!validModes.includes(data.octave_mode)) {
      throw new ValidationError('octave_mode must be one of: chromatic, diatonic, pentatonic', 'octave_mode');
    }
  }

  // Validate comm_timeout
  if (data.comm_timeout !== undefined && data.comm_timeout !== null) {
    const timeout = parseInt(data.comm_timeout);
    if (isNaN(timeout) || timeout < 100 || timeout > 30000) {
      throw new ValidationError('comm_timeout must be between 100 and 30000 milliseconds', 'comm_timeout');
    }
    data.comm_timeout = timeout;
  }

  const id = app.database.updateInstrumentSettings(data.deviceId, channel, {
    custom_name: data.custom_name,
    sync_delay: data.sync_delay,
    mac_address: data.mac_address,
    usb_serial_number: usbSerialNumber,
    name: data.name,
    gm_program: data.gm_program,
    octave_mode: data.octave_mode,
    comm_timeout: data.comm_timeout
  });

  // Notify routing/playback systems to invalidate cached compensation values
  app.eventBus?.emit('instrument_settings_changed', {
    deviceId: data.deviceId,
    channel
  });

  return {
    success: true,
    id: id
  };
}

async function instrumentGetSettings(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  // Pass channel if provided, otherwise backward compat (first match)
  const channel = data.channel !== undefined ? data.channel : undefined;
  const settings = app.database.getInstrumentSettings(data.deviceId, channel);

  return {
    settings: settings || null
  };
}

async function instrumentUpdateCapabilities(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  // Channel defaults to 0 for backward compatibility
  const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // Validate polyphony range
  if (data.polyphony !== undefined && data.polyphony !== null) {
    const poly = parseInt(data.polyphony);
    if (isNaN(poly) || poly < 1 || poly > 128) {
      throw new ValidationError('polyphony must be between 1 and 128', 'polyphony');
    }
    data.polyphony = poly;
  }

  const id = app.database.updateInstrumentCapabilities(data.deviceId, channel, {
    note_range_min: data.note_range_min,
    note_range_max: data.note_range_max,
    supported_ccs: data.supported_ccs,
    note_selection_mode: data.note_selection_mode,
    selected_notes: data.selected_notes,
    polyphony: data.polyphony,
    capabilities_source: data.capabilities_source || 'manual'
  });

  return {
    success: true,
    id: id
  };
}

async function instrumentGetCapabilities(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  // Pass channel if provided, otherwise backward compat (first match)
  const channel = data.channel !== undefined ? data.channel : undefined;
  const capabilities = app.database.getInstrumentCapabilities(data.deviceId, channel);

  return {
    capabilities: capabilities || null
  };
}

async function instrumentListCapabilities(app) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const instruments = app.database.getAllInstrumentCapabilities();

  return {
    instruments: instruments
  };
}

async function instrumentListRegistered(app) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const instruments = app.database.getInstrumentsWithCapabilities();

  return {
    success: true,
    instruments: instruments,
    total: instruments.length
  };
}

async function instrumentListConnected(app) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const allInstruments = app.database.getInstrumentsWithCapabilities();
  const connectedDevices = app.deviceManager.getDeviceList();
  const connectedDeviceIds = new Set(connectedDevices.map(d => d.id));

  // Build an index by normalized name, serial, and MAC for fallback matching
  const connectedNormalizedNames = new Set();
  const connectedSerials = new Set();
  const connectedMacs = new Set();
  for (const d of connectedDevices) {
    const normalized = InstrumentDatabase.normalizeDeviceName(d.id);
    if (normalized) connectedNormalizedNames.add(normalized);
    if (d.usbSerialNumber) connectedSerials.add(d.usbSerialNumber);
    if (d.address && d.type === 'bluetooth') connectedMacs.add(d.address);
  }

  // Find registered instruments that are connected
  const matchedDeviceIds = new Set();
  const connectedInstruments = allInstruments.filter(inst => {
    // Exact match by device_id
    if (connectedDeviceIds.has(inst.device_id)) {
      matchedDeviceIds.add(inst.device_id);
      return true;
    }
    // Fallback by USB serial number
    if (inst.usb_serial_number && connectedSerials.has(inst.usb_serial_number)) {
      // Find the corresponding device_id
      const matchedDev = connectedDevices.find(d => d.usbSerialNumber === inst.usb_serial_number);
      if (matchedDev) matchedDeviceIds.add(matchedDev.id);
      return true;
    }
    // Fallback by MAC address
    if (inst.mac_address && connectedMacs.has(inst.mac_address)) {
      const matchedDev = connectedDevices.find(d => d.address === inst.mac_address);
      if (matchedDev) matchedDeviceIds.add(matchedDev.id);
      return true;
    }
    // Fallback by normalized name
    if (!inst.device_id.startsWith('virtual_')) {
      const normalized = InstrumentDatabase.normalizeDeviceName(inst.device_id);
      if (normalized && connectedNormalizedNames.has(normalized)) {
        // Find the corresponding device_id
        const matchedDev = connectedDevices.find(d => {
          const dn = InstrumentDatabase.normalizeDeviceName(d.id);
          return dn === normalized;
        });
        if (matchedDev) matchedDeviceIds.add(matchedDev.id);
        return true;
      }
    }
    return false;
  });

  // Add connected devices that are not registered in instruments_latency
  for (const device of connectedDevices) {
    if (!matchedDeviceIds.has(device.id) && device.type !== 'virtual') {
      connectedInstruments.push({
        id: `${device.id}_ch0`,
        device_id: device.id,
        channel: 0,
        name: device.name || device.id,
        custom_name: null,
        gm_program: null,
        polyphony: null,
        note_range_min: null,
        note_range_max: null,
        note_selection_mode: 'range',
        selected_notes: null,
        supported_ccs: null
      });
    }
  }

  return {
    success: true,
    instruments: connectedInstruments,
    total: connectedInstruments.length,
    connectedDevices: connectedDevices.length
  };
}

async function instrumentDelete(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const errors = [];
  const hasChannel = data.channel !== undefined && data.channel !== null;
  const channel = hasChannel ? parseInt(data.channel) : null;

  if (hasChannel && (channel < 0 || channel > 15)) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // Delete instrument settings/capabilities from instruments_latency
  try {
    if (hasChannel) {
      app.database.db.prepare('DELETE FROM instruments_latency WHERE device_id = ? AND channel = ?').run(data.deviceId, channel);
    } else {
      app.database.db.prepare('DELETE FROM instruments_latency WHERE device_id = ?').run(data.deviceId);
    }
  } catch (e) {
    errors.push(`instruments_latency: ${e.message}`);
  }

  // Cascade: delete associated string instrument configs
  try {
    if (hasChannel) {
      app.database.db.prepare('DELETE FROM string_instruments WHERE device_id = ? AND channel = ?').run(data.deviceId, channel);
    } else {
      app.database.db.prepare('DELETE FROM string_instruments WHERE device_id = ?').run(data.deviceId);
    }
  } catch (e) {
    // string_instruments table may not exist
  }

  // Cascade: delete associated MIDI instrument routings
  try {
    if (hasChannel) {
      app.database.db.prepare('DELETE FROM midi_instrument_routings WHERE device_id = ? AND channel = ?').run(data.deviceId, channel);
    } else {
      app.database.db.prepare('DELETE FROM midi_instrument_routings WHERE device_id = ?').run(data.deviceId);
    }
  } catch (e) {
    // midi_instrument_routings table may not exist
  }

  // Delete from instruments table if exists
  try {
    app.database.deleteInstrument(data.deviceId);
  } catch (e) {
    // May not have an instruments entry
  }

  // Also delete latency profile if exists
  try {
    app.database.deleteLatencyProfile(data.deviceId);
  } catch (e) {
    // May not have a latency profile
  }

  if (errors.length > 0) {
    app.logger.warn(`[instrumentDelete] Partial errors for ${data.deviceId}: ${errors.join(', ')}`);
  }

  return {
    success: true
  };
}

export function register(registry, app) {
  registry.register('instrument_update_settings', (data) => instrumentUpdateSettings(app, data));
  registry.register('instrument_get_settings', (data) => instrumentGetSettings(app, data));
  registry.register('instrument_update_capabilities', (data) => instrumentUpdateCapabilities(app, data));
  registry.register('instrument_get_capabilities', (data) => instrumentGetCapabilities(app, data));
  registry.register('instrument_list_capabilities', () => instrumentListCapabilities(app));
  registry.register('instrument_list_registered', () => instrumentListRegistered(app));
  registry.register('instrument_list_connected', () => instrumentListConnected(app));
  registry.register('instrument_delete', (data) => instrumentDelete(app, data));
  registry.register('instrument_types_list', () => ({
    categories: InstrumentTypeConfig.getCategories(),
    hierarchy: InstrumentTypeConfig.hierarchy,
    families: InstrumentTypeConfig.families
  }));
  registry.register('instrument_type_detect', (data) => ({
    ...InstrumentTypeConfig.detectTypeFromProgram(data.gm_program)
  }));
}
