// src/api/commands/VirtualInstrumentCommands.js
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

const VIRTUAL_INSTRUMENT_PRESETS = {
  piano: {
    name: 'Virtual Piano',
    gm_program: 0,
    polyphony: 128,
    note_range_min: 21,
    note_range_max: 108,
    note_selection_mode: 'range'
  },
  organ: {
    name: 'Virtual Organ',
    gm_program: 19,
    polyphony: 64,
    note_range_min: 36,
    note_range_max: 96,
    note_selection_mode: 'range'
  },
  strings: {
    name: 'Virtual Strings',
    gm_program: 48,
    polyphony: 32,
    note_range_min: 28,
    note_range_max: 103,
    note_selection_mode: 'range'
  },
  synth: {
    name: 'Virtual Synth',
    gm_program: 80,
    polyphony: 16,
    note_range_min: 0,
    note_range_max: 127,
    note_selection_mode: 'range'
  },
  drums: {
    name: 'Virtual Drums',
    gm_program: 0,
    polyphony: 32,
    note_range_min: 35,
    note_range_max: 81,
    note_selection_mode: 'selected'
  }
};

async function instrumentCreateVirtual(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const preset = data.preset ? VIRTUAL_INSTRUMENT_PRESETS[data.preset] : null;
  const name = data.name || (preset ? preset.name : 'Virtual Instrument');
  const deviceId = `virtual_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const channel = data.channel !== undefined ? parseInt(data.channel) : 0;

  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // Create instrument settings entry
  const id = app.database.updateInstrumentSettings(deviceId, channel, {
    custom_name: name,
    gm_program: data.gm_program !== undefined ? data.gm_program : (preset ? preset.gm_program : null),
    name: name
  });

  // Create capabilities entry if preset or explicit capabilities provided
  const capabilities = {
    polyphony: data.polyphony || (preset ? preset.polyphony : null),
    note_range_min: data.note_range_min !== undefined ? data.note_range_min : (preset ? preset.note_range_min : null),
    note_range_max: data.note_range_max !== undefined ? data.note_range_max : (preset ? preset.note_range_max : null),
    note_selection_mode: data.note_selection_mode || (preset ? preset.note_selection_mode : 'range'),
    capabilities_source: 'virtual'
  };

  app.database.updateInstrumentCapabilities(deviceId, channel, capabilities);

  // Register with device manager if available
  if (app.deviceManager && typeof app.deviceManager.addVirtualDevice === 'function') {
    app.deviceManager.addVirtualDevice(deviceId, {
      name: name,
      type: 'virtual',
      enabled: true
    });
  }

  return {
    success: true,
    deviceId: deviceId,
    id: id,
    name: name,
    channel: channel
  };
}

async function virtualCreate(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const name = data.name || data.deviceId;

  // Register with device manager
  if (app.deviceManager && typeof app.deviceManager.addVirtualDevice === 'function') {
    app.deviceManager.addVirtualDevice(data.deviceId, {
      name: name,
      type: 'virtual',
      enabled: data.enabled !== false
    });
  }

  return {
    success: true,
    deviceId: data.deviceId,
    name: name
  };
}

async function virtualDelete(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  // Remove from device manager
  if (app.deviceManager && typeof app.deviceManager.removeVirtualDevice === 'function') {
    app.deviceManager.removeVirtualDevice(data.deviceId);
  }

  // Clean up database entries
  if (app.database) {
    try {
      app.database.db.prepare('DELETE FROM instruments_latency WHERE device_id = ?').run(data.deviceId);
    } catch (e) {
      // May not exist
    }
    try {
      app.database.deleteInstrument(data.deviceId);
    } catch (e) {
      // May not exist
    }
  }

  return {
    success: true,
    deviceId: data.deviceId
  };
}

async function virtualList(app) {
  const devices = app.deviceManager.getDeviceList();
  const virtualDevices = devices.filter(d => d.type === 'virtual');

  // Enrich with database info if available
  if (app.database) {
    for (const device of virtualDevices) {
      try {
        const settings = app.database.getInstrumentSettings(device.id);
        if (settings) {
          if (settings.custom_name) device.displayName = settings.custom_name;
          if (settings.gm_program !== null && settings.gm_program !== undefined) {
            device.gm_program = settings.gm_program;
          }
        }
      } catch (e) {
        // Ignore
      }
    }
  }

  return {
    success: true,
    devices: virtualDevices,
    total: virtualDevices.length,
    presets: Object.keys(VIRTUAL_INSTRUMENT_PRESETS)
  };
}

async function instrumentListByDevice(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const instruments = app.database.getInstrumentsByDevice(data.deviceId);

  return {
    success: true,
    instruments: instruments || [],
    deviceId: data.deviceId,
    total: instruments ? instruments.length : 0
  };
}

async function instrumentAddToDevice(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  const id = app.database.updateInstrumentSettings(data.deviceId, channel, {
    custom_name: data.name || null,
    gm_program: data.gm_program !== undefined ? data.gm_program : null,
    name: data.name || data.deviceId
  });

  if (data.polyphony || data.note_range_min !== undefined || data.note_range_max !== undefined) {
    app.database.updateInstrumentCapabilities(data.deviceId, channel, {
      polyphony: data.polyphony || null,
      note_range_min: data.note_range_min,
      note_range_max: data.note_range_max,
      note_selection_mode: data.note_selection_mode || 'range',
      capabilities_source: data.capabilities_source || 'manual'
    });
  }

  return {
    success: true,
    id: id,
    deviceId: data.deviceId,
    channel: channel
  };
}

async function virtualInstrumentToggle(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const enabled = data.enabled !== undefined ? !!data.enabled : true;

  // Toggle via device manager
  if (app.deviceManager && typeof app.deviceManager.enableDevice === 'function') {
    app.deviceManager.enableDevice(data.deviceId, enabled);
  }

  return {
    success: true,
    deviceId: data.deviceId,
    enabled: enabled
  };
}

export function register(registry, app) {
  registry.register('instrument_create_virtual', (data) => instrumentCreateVirtual(app, data));
  registry.register('virtual_create', (data) => virtualCreate(app, data));
  registry.register('virtual_delete', (data) => virtualDelete(app, data));
  registry.register('virtual_list', () => virtualList(app));
  registry.register('instrument_list_by_device', (data) => instrumentListByDevice(app, data));
  registry.register('instrument_add_to_device', (data) => instrumentAddToDevice(app, data));
  registry.register('virtual_instrument_toggle', (data) => virtualInstrumentToggle(app, data));
}
