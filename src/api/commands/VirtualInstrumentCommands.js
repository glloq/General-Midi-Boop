/**
 * @file src/api/commands/VirtualInstrumentCommands.js
 * @description WebSocket commands for virtual MIDI instruments —
 * software-only sources/sinks that show up in the device list and can
 * be routed to like real hardware.
 *
 * Two flavours coexist:
 *   - "Instrument-style" virtuals (`instrument_create_virtual`) include
 *     persisted settings + capabilities + DeviceManager registration,
 *     with optional GM presets.
 *   - "Raw" virtuals (`virtual_create`) are simpler stub devices used
 *     by tests and the editor preview.
 *
 * Registered commands:
 *   - `instrument_create_virtual`
 *   - `virtual_create` / `virtual_delete` / `virtual_list`
 *   - `instrument_list_by_device` / `instrument_add_to_device`
 *   - `virtual_instrument_toggle`
 *
 * Validation: see `device.schemas.js` for `virtual_create` /
 * `virtual_delete`; remaining commands rely on imperative checks.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

/**
 * Built-in capability presets for {@link instrumentCreateVirtual}. Each
 * key is the value clients pass in `data.preset`.
 */
const VIRTUAL_INSTRUMENT_PRESETS = {
  piano: {
    name: 'Virtual Piano',
    gm_program: 0,
    polyphony: 64,
    note_range_min: 21,
    note_range_max: 108,
    note_selection_mode: 'range'
  },
  electric_piano: {
    name: 'Virtual Electric Piano',
    gm_program: 4,
    polyphony: 32,
    note_range_min: 28,
    note_range_max: 103,
    note_selection_mode: 'range'
  },
  organ: {
    name: 'Virtual Organ',
    gm_program: 19,
    polyphony: 16,
    note_range_min: 36,
    note_range_max: 96,
    note_selection_mode: 'range'
  },
  guitar: {
    name: 'Virtual Guitar',
    gm_program: 24,
    polyphony: 6,
    note_range_min: 40,
    note_range_max: 88,
    note_selection_mode: 'range'
  },
  bass: {
    name: 'Virtual Bass',
    gm_program: 33,
    polyphony: 4,
    note_range_min: 28,
    note_range_max: 67,
    note_selection_mode: 'range'
  },
  violin: {
    name: 'Virtual Violin',
    gm_program: 40,
    polyphony: 4,
    note_range_min: 55,
    note_range_max: 103,
    note_selection_mode: 'range'
  },
  cello: {
    name: 'Virtual Cello',
    gm_program: 42,
    polyphony: 4,
    note_range_min: 36,
    note_range_max: 84,
    note_selection_mode: 'range'
  },
  strings: {
    name: 'Virtual Strings',
    gm_program: 48,
    polyphony: 16,
    note_range_min: 36,
    note_range_max: 96,
    note_selection_mode: 'range'
  },
  trumpet: {
    name: 'Virtual Trumpet',
    gm_program: 56,
    polyphony: 1,
    note_range_min: 52,
    note_range_max: 84,
    note_selection_mode: 'range'
  },
  saxophone: {
    name: 'Virtual Saxophone',
    gm_program: 65,
    polyphony: 1,
    note_range_min: 49,
    note_range_max: 87,
    note_selection_mode: 'range'
  },
  flute: {
    name: 'Virtual Flute',
    gm_program: 73,
    polyphony: 1,
    note_range_min: 60,
    note_range_max: 96,
    note_selection_mode: 'range'
  },
  synth_lead: {
    name: 'Virtual Synth Lead',
    gm_program: 80,
    polyphony: 8,
    note_range_min: 36,
    note_range_max: 96,
    note_selection_mode: 'range'
  },
  synth_pad: {
    name: 'Virtual Synth Pad',
    gm_program: 88,
    polyphony: 16,
    note_range_min: 36,
    note_range_max: 96,
    note_selection_mode: 'range'
  },
  drums: {
    name: 'Virtual Drums',
    gm_program: 0,
    polyphony: 32,
    note_range_min: 35,
    note_range_max: 81,
    note_selection_mode: 'discrete',
    selected_notes: Array.from({ length: 81 - 35 + 1 }, (_, i) => 35 + i)
  }
};

/**
 * Create a fully-fledged virtual instrument: settings row,
 * capabilities row, and a DeviceManager registration so it appears in
 * `device_list` and is routable. Capability defaults come from a named
 * preset when `data.preset` matches a key in
 * {@link VIRTUAL_INSTRUMENT_PRESETS}.
 *
 * @param {Object} app
 * @param {Object} data - `{name?, preset?, channel?, gm_program?,
 *   polyphony?, note_range_min?, note_range_max?, note_selection_mode?}`.
 * @returns {Promise<{success:true, deviceId:string, id:(string|number),
 *   name:string, channel:number}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function instrumentCreateVirtual(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const preset = data.preset ? VIRTUAL_INSTRUMENT_PRESETS[data.preset] : null;
  const name = data.name || (preset ? preset.name : 'Virtual Instrument');
  const deviceId = `virtual_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  // GM drums live on MIDI channel 10 (0-indexed: 9).
  const defaultChannel = data.preset === 'drums' ? 9 : 0;
  const channel = data.channel !== undefined ? parseInt(data.channel) : defaultChannel;

  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // `instruments_latency.device_id` has a FK to `devices(id)`, so the
  // devices row must exist before we can insert any instrument settings
  // for it — otherwise better-sqlite3 raises SQLITE_CONSTRAINT.
  if (app.deviceSettingsRepository) {
    app.deviceSettingsRepository.ensureDevice(deviceId, name, 'virtual');
  }

  // Create instrument settings entry
  const id = app.instrumentRepository.updateSettings(deviceId, channel, {
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
    selected_notes: data.selected_notes !== undefined
      ? data.selected_notes
      : (preset && preset.selected_notes ? preset.selected_notes : null),
    capabilities_source: 'manual'
  };

  app.instrumentRepository.updateCapabilities(deviceId, channel, capabilities);

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

/**
 * Stub virtual device — registers in the DeviceManager only, no DB row.
 *
 * @param {Object} app
 * @param {{deviceId:string, name?:string, enabled?:boolean}} data
 * @returns {Promise<{success:true, deviceId:string, name:string}>}
 * @throws {ValidationError}
 */
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

/**
 * Remove a virtual device from the DeviceManager and best-effort delete
 * any associated instrument settings rows.
 *
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{success:true, deviceId:string}>}
 * @throws {ValidationError}
 */
async function virtualDelete(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  // Remove from device manager
  if (app.deviceManager && typeof app.deviceManager.removeVirtualDevice === 'function') {
    app.deviceManager.removeVirtualDevice(data.deviceId);
  }

  // Clean up DB rows for this device — `instruments_latency` (plural)
  // holds every per-channel row; the legacy generic `instruments` table
  // was removed in v6.
  if (app.instrumentRepository) {
    try {
      app.instrumentRepository.deleteSettingsByDevice(data.deviceId);
    } catch (e) {
      // May not exist
    }
  }

  return {
    success: true,
    deviceId: data.deviceId
  };
}

/**
 * List currently active virtual devices (filtered from the live
 * DeviceManager) plus the available preset keys for the UI.
 *
 * @param {Object} app
 * @returns {Promise<{success:true, devices:Object[], total:number,
 *   presets:string[]}>}
 */
async function virtualList(app) {
  const devices = app.deviceManager.getDeviceList();
  const virtualDevices = devices.filter(d => d.type === 'virtual');

  // Enrich with database info if available
  if (app.instrumentRepository) {
    for (const device of virtualDevices) {
      try {
        const settings = app.instrumentRepository.getAllSettings(device.id);
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

/**
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{success:true, instruments:Object[],
 *   deviceId:string, total:number}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function instrumentListByDevice(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const instruments = app.instrumentRepository.findByDevice(data.deviceId);

  return {
    success: true,
    instruments: instruments || [],
    deviceId: data.deviceId,
    total: instruments ? instruments.length : 0
  };
}

/**
 * Persist a new instrument settings + optional capabilities row on a
 * specific device/channel.
 *
 * @param {Object} app
 * @param {Object} data - `{deviceId, channel?, name?, gm_program?,
 *   polyphony?, note_range_min?, note_range_max?,
 *   note_selection_mode?, capabilities_source?}`.
 * @returns {Promise<{success:true, id:(string|number),
 *   deviceId:string, channel:number}>}
 * @throws {ConfigurationError|ValidationError}
 */
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

  // `instruments_latency.device_id` has a FK to `devices(id)`. The
  // sibling `instrument_update_settings` / `_update_capabilities`
  // handlers call `ensureDevice` for this exact reason — the `+` flow
  // from the modal hits a device that may not yet be registered
  // (freshly discovered, hot-plugged, or virtual-only), so without
  // the guard the first add to that device trips SQLITE_CONSTRAINT
  // and the client sees "Internal server error".
  if (app.deviceSettingsRepository) {
    app.deviceSettingsRepository.ensureDevice(
      data.deviceId,
      data.name || data.deviceId,
      'output'
    );
  }

  const id = app.instrumentRepository.updateSettings(data.deviceId, channel, {
    custom_name: data.name || null,
    gm_program: data.gm_program !== undefined ? data.gm_program : null,
    name: data.name || data.deviceId
  });

  if (data.polyphony || data.note_range_min !== undefined || data.note_range_max !== undefined) {
    app.instrumentRepository.updateCapabilities(data.deviceId, channel, {
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

/**
 * Enable/disable a virtual device through the DeviceManager.
 *
 * @param {Object} app
 * @param {{deviceId:string, enabled?:boolean}} data - `enabled` defaults
 *   to `true`.
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
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

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('instrument_create_virtual', (data) => instrumentCreateVirtual(app, data));
  registry.register('virtual_create', (data) => virtualCreate(app, data));
  registry.register('virtual_delete', (data) => virtualDelete(app, data));
  registry.register('virtual_list', () => virtualList(app));
  registry.register('instrument_list_by_device', (data) => instrumentListByDevice(app, data));
  registry.register('instrument_add_to_device', (data) => instrumentAddToDevice(app, data));
  registry.register('virtual_instrument_toggle', (data) => virtualInstrumentToggle(app, data));
}
