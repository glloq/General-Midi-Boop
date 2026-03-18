// src/api/commands/DeviceCommands.js

// Presets d'instruments virtuels avec capabilities pre-configurees
const VIRTUAL_INSTRUMENT_PRESETS = {
  piano: {
    name: 'Piano', gm_program: 0,
    note_range_min: 21, note_range_max: 108, polyphony: 64,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 91, 93]
  },
  electric_piano: {
    name: 'Piano Électrique', gm_program: 4,
    note_range_min: 28, note_range_max: 103, polyphony: 32,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 91, 93]
  },
  organ: {
    name: 'Orgue', gm_program: 19,
    note_range_min: 36, note_range_max: 96, polyphony: 16,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 91, 93]
  },
  guitar: {
    name: 'Guitare', gm_program: 25,
    note_range_min: 40, note_range_max: 88, polyphony: 6,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64]
  },
  bass: {
    name: 'Basse', gm_program: 33,
    note_range_min: 28, note_range_max: 67, polyphony: 4,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64]
  },
  violin: {
    name: 'Violon', gm_program: 40,
    note_range_min: 55, note_range_max: 103, polyphony: 4,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71]
  },
  cello: {
    name: 'Violoncelle', gm_program: 42,
    note_range_min: 36, note_range_max: 84, polyphony: 4,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71]
  },
  strings: {
    name: 'Ensemble Cordes', gm_program: 48,
    note_range_min: 36, note_range_max: 96, polyphony: 16,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71]
  },
  trumpet: {
    name: 'Trompette', gm_program: 56,
    note_range_min: 52, note_range_max: 84, polyphony: 1,
    note_selection_mode: 'range', supported_ccs: [1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]
  },
  saxophone: {
    name: 'Saxophone', gm_program: 66,
    note_range_min: 49, note_range_max: 87, polyphony: 1,
    note_selection_mode: 'range', supported_ccs: [1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]
  },
  flute: {
    name: 'Flûte', gm_program: 73,
    note_range_min: 60, note_range_max: 96, polyphony: 1,
    note_selection_mode: 'range', supported_ccs: [1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]
  },
  synth_lead: {
    name: 'Synth Lead', gm_program: 80,
    note_range_min: 36, note_range_max: 96, polyphony: 8,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71, 74, 91]
  },
  synth_pad: {
    name: 'Synth Pad', gm_program: 88,
    note_range_min: 36, note_range_max: 96, polyphony: 16,
    note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71, 74, 91]
  },
  drums: {
    name: 'Batterie', gm_program: 0, channel: 9,
    note_range_min: 35, note_range_max: 81, polyphony: 16,
    note_selection_mode: 'discrete',
    selected_notes: [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 55, 57, 59],
    supported_ccs: [7, 10]
  }
};

async function deviceList(app) {
  const devices = app.deviceManager.getDeviceList();

  // Enrichir les appareils avec les données depuis la base de données
  if (app.database) {
    for (const device of devices) {
      try {
        let settings = app.database.getInstrumentSettings(device.id);

        // Fallback: si pas de settings par device_id, chercher par USB serial number
        if (!settings && device.usbSerialNumber) {
          const bySerial = app.database.findInstrumentByUsbSerial(device.usbSerialNumber);
          if (bySerial && bySerial.device_id !== device.id) {
            app.logger.info(`[deviceList] USB device "${device.id}" matched by serial number "${device.usbSerialNumber}" to DB entry "${bySerial.device_id}" - reconciling`);
            // Mettre à jour le device_id en DB pour correspondre au nouveau nom ALSA
            try {
              app.database.reconcileDeviceId(bySerial.device_id, device.id);
            } catch (e) {
              app.logger.warn(`[deviceList] Failed to reconcile device_id: ${e.message}`);
            }
            settings = app.database.getInstrumentSettings(device.id);
          }
        }

        // Fallback: chercher par MAC address pour les devices Bluetooth
        if (!settings && device.address && device.type === 'bluetooth') {
          const byMac = app.database.findInstrumentByMac(device.address);
          if (byMac && byMac.device_id !== device.id) {
            app.logger.info(`[deviceList] Bluetooth device "${device.id}" matched by MAC "${device.address}" to DB entry "${byMac.device_id}" - reconciling`);
            try {
              app.database.reconcileDeviceId(byMac.device_id, device.id);
            } catch (e) {
              app.logger.warn(`[deviceList] Failed to reconcile device_id: ${e.message}`);
            }
            settings = app.database.getInstrumentSettings(device.id);
          }
        }

        if (settings) {
          if (settings.custom_name) {
            device.displayName = settings.custom_name;
          }
          // Inclure les champs de configuration instrument
          if (settings.gm_program !== null && settings.gm_program !== undefined) {
            device.gm_program = settings.gm_program;
          }
          if (settings.polyphony !== null && settings.polyphony !== undefined) {
            device.polyphony = settings.polyphony;
          }
          if (settings.note_range_min !== null && settings.note_range_min !== undefined) {
            device.note_range_min = settings.note_range_min;
          }
          if (settings.note_range_max !== null && settings.note_range_max !== undefined) {
            device.note_range_max = settings.note_range_max;
          }
          if (settings.note_selection_mode) {
            device.note_selection_mode = settings.note_selection_mode;
          }
          // Inclure le usb_serial_number dans la réponse
          if (settings.usb_serial_number) {
            device.usb_serial_number = settings.usb_serial_number;
          }
        }

        // Toujours inclure le USB serial number du device s'il en a un
        if (device.usbSerialNumber && !device.usb_serial_number) {
          device.usb_serial_number = device.usbSerialNumber;
        }
      } catch (error) {
        // Ignorer les erreurs - l'appareil n'a peut-être pas de settings
      }
    }
  }

  app.logger.debug(`[CommandHandler] deviceList returning ${devices.length} devices:`,
    devices.map(d => `"${d.displayName || d.name}" (${d.type})`).join(', '));
  return { devices: devices };
}

async function deviceRefresh(app) {
  const devices = await app.deviceManager.scanDevices();

  // Après un scan, reconcilier les device_ids par USB serial number
  if (app.database) {
    try {
      const removed = app.database.deduplicateByUsbSerial();
      if (removed > 0) {
        app.logger.info(`[deviceRefresh] Deduplicated ${removed} instrument entries by USB serial`);
      }
    } catch (e) {
      app.logger.warn(`[deviceRefresh] Deduplication failed: ${e.message}`);
    }
  }

  return { devices: devices };
}

async function deviceInfo(app, data) {
  const device = app.deviceManager.getDeviceInfo(data.deviceId);
  if (!device) {
    throw new Error(`Device not found: ${data.deviceId}`);
  }
  return { device: device };
}

async function deviceSetProperties(app, data) {
  // Future implementation for device-specific settings
  return { success: true };
}

async function deviceEnable(app, data) {
  app.deviceManager.enableDevice(data.deviceId, data.enabled);
  return { success: true };
}

async function deviceIdentityRequest(app, data) {
  // sendIdentityRequest() will throw an exception if it fails
  app.deviceManager.sendIdentityRequest(
    data.deviceName,
    data.deviceId || 0x7F
  );

  return {
    success: true,
    message: 'Identity Request sent. Waiting for response...'
  };
}

async function deviceSaveSysExIdentity(app, data) {
  if (!app.database) {
    throw new Error('Database not available');
  }

  // Channel defaults to 0 for backward compatibility
  const channel = data.channel !== undefined ? data.channel : 0;
  const id = app.database.saveSysExIdentity(data.deviceId, channel, data.identity);

  return {
    success: true,
    id: id
  };
}

async function instrumentUpdateSettings(app, data) {
  if (!app.database) {
    throw new Error('Database not available');
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
    throw new Error('channel must be between 0 and 15');
  }

  // Validate sync_delay range (milliseconds, ±5 seconds max)
  if (data.sync_delay !== undefined) {
    const parsedDelay = parseInt(data.sync_delay);
    if (isNaN(parsedDelay) || parsedDelay < -5000 || parsedDelay > 5000) {
      throw new Error('sync_delay must be between -5000 and 5000 milliseconds');
    }
    data.sync_delay = parsedDelay;
  }

  const id = app.database.updateInstrumentSettings(data.deviceId, channel, {
    custom_name: data.custom_name,
    sync_delay: data.sync_delay,
    mac_address: data.mac_address,
    usb_serial_number: usbSerialNumber,
    name: data.name,
    gm_program: data.gm_program
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
    throw new Error('Database not available');
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
    throw new Error('Database not available');
  }

  if (!data.deviceId) {
    throw new Error('deviceId is required');
  }

  // Channel defaults to 0 for backward compatibility
  const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
  if (channel < 0 || channel > 15) {
    throw new Error('channel must be between 0 and 15');
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
    throw new Error('Database not available');
  }

  if (!data.deviceId) {
    throw new Error('deviceId is required');
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
    throw new Error('Database not available');
  }

  const instruments = app.database.getAllInstrumentCapabilities();

  return {
    instruments: instruments
  };
}

async function instrumentListRegistered(app) {
  if (!app.database) {
    throw new Error('Database not available');
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
    throw new Error('Database not available');
  }

  const allInstruments = app.database.getInstrumentsWithCapabilities();
  const connectedDevices = app.deviceManager.getDeviceList();
  const connectedDeviceIds = new Set(connectedDevices.map(d => d.id));

  const connectedInstruments = allInstruments.filter(
    inst => connectedDeviceIds.has(inst.device_id)
  );

  return {
    success: true,
    instruments: connectedInstruments,
    total: connectedInstruments.length,
    connectedDevices: connectedDevices.length
  };
}

async function instrumentDelete(app, data) {
  if (!app.database) {
    throw new Error('Database not available');
  }

  if (!data.deviceId) {
    throw new Error('deviceId is required');
  }

  // Delete instrument settings/capabilities from instruments_latency by device_id
  try {
    app.database.db.prepare('DELETE FROM instruments_latency WHERE device_id = ?').run(data.deviceId);
  } catch (e) {
    // May not have latency settings
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

  return {
    success: true
  };
}

/**
 * Cree un instrument virtuel en DB (sans device physique)
 * Utile pour les tests d'auto-assignation
 */
async function instrumentCreateVirtual(app, data) {
  if (!app.database) {
    throw new Error('Database not available');
  }

  // Appliquer le preset si un type est fourni
  const preset = data.type ? VIRTUAL_INSTRUMENT_PRESETS[data.type] : null;

  const name = data.name || (preset ? preset.name : 'Virtual Instrument');
  const deviceId = `virtual_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const channel = preset && preset.channel !== undefined ? preset.channel : (data.channel || 0);

  // Inserer dans instruments_latency avec les settings de base
  const settings = { name: name, custom_name: name };
  if (preset) settings.gm_program = preset.gm_program;
  if (data.gm_program !== undefined) settings.gm_program = data.gm_program;

  app.database.updateInstrumentSettings(deviceId, channel, settings);

  // Construire les capabilities depuis le preset et/ou les donnees fournies
  const capabilities = { capabilities_source: 'manual' };

  if (preset) {
    capabilities.note_range_min = preset.note_range_min;
    capabilities.note_range_max = preset.note_range_max;
    capabilities.polyphony = preset.polyphony;
    capabilities.note_selection_mode = preset.note_selection_mode;
    if (preset.selected_notes) capabilities.selected_notes = preset.selected_notes;
    if (preset.supported_ccs) capabilities.supported_ccs = preset.supported_ccs;
  }

  // Les donnees explicites ecrasent le preset
  if (data.note_range_min !== undefined) capabilities.note_range_min = data.note_range_min;
  if (data.note_range_max !== undefined) capabilities.note_range_max = data.note_range_max;
  if (data.polyphony !== undefined) capabilities.polyphony = data.polyphony;
  if (data.note_selection_mode) capabilities.note_selection_mode = data.note_selection_mode;
  if (data.selected_notes) capabilities.selected_notes = data.selected_notes;
  if (data.supported_ccs) capabilities.supported_ccs = data.supported_ccs;

  if (Object.keys(capabilities).length > 1) {
    app.database.updateInstrumentCapabilities(deviceId, channel, capabilities);
  }

  app.logger.info(`Virtual instrument created: ${name} (${deviceId}, type=${data.type || 'custom'}, ch=${channel})`);

  return { success: true, deviceId, id: `${deviceId}_${channel}`, channel };
}

async function virtualCreate(app, data) {
  const deviceId = app.deviceManager.createVirtualDevice(data.name);
  return { deviceId: deviceId };
}

async function virtualDelete(app, data) {
  app.deviceManager.deleteVirtualDevice(data.deviceId);
  return { success: true };
}

async function virtualList(app) {
  const devices = app.deviceManager.getDeviceList()
    .filter(d => d.type === 'virtual');
  return { devices: devices };
}

export function register(registry, app) {
  registry.register('device_list', () => deviceList(app));
  registry.register('device_refresh', () => deviceRefresh(app));
  registry.register('device_info', (data) => deviceInfo(app, data));
  registry.register('device_set_properties', (data) => deviceSetProperties(app, data));
  registry.register('device_enable', (data) => deviceEnable(app, data));
  registry.register('device_identity_request', (data) => deviceIdentityRequest(app, data));
  registry.register('device_save_sysex_identity', (data) => deviceSaveSysExIdentity(app, data));
  registry.register('instrument_update_settings', (data) => instrumentUpdateSettings(app, data));
  registry.register('instrument_get_settings', (data) => instrumentGetSettings(app, data));
  registry.register('instrument_update_capabilities', (data) => instrumentUpdateCapabilities(app, data));
  registry.register('instrument_get_capabilities', (data) => instrumentGetCapabilities(app, data));
  registry.register('instrument_list_capabilities', () => instrumentListCapabilities(app));
  registry.register('instrument_list_registered', () => instrumentListRegistered(app));
  registry.register('instrument_list_connected', () => instrumentListConnected(app));
  registry.register('instrument_delete', (data) => instrumentDelete(app, data));
  registry.register('instrument_create_virtual', (data) => instrumentCreateVirtual(app, data));
  registry.register('virtual_create', (data) => virtualCreate(app, data));
  registry.register('virtual_delete', (data) => virtualDelete(app, data));
  registry.register('virtual_list', () => virtualList(app));
}
