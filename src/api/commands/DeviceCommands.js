// src/api/commands/DeviceCommands.js
import InstrumentDatabase from '../../storage/InstrumentDatabase.js';

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

        // Fallback: chercher par nom normalisé (sans les numéros de port ALSA)
        // Couvre le cas courant où le numéro de port ALSA change entre reboots
        if (!settings && device.type === 'usb') {
          const byName = app.database.findInstrumentByNormalizedName(device.id);
          if (byName && byName.device_id !== device.id) {
            app.logger.info(`[deviceList] USB device "${device.id}" matched by normalized name to DB entry "${byName.device_id}" - reconciling`);
            try {
              app.database.reconcileDeviceId(byName.device_id, device.id);
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
          // Inclure les champs de configuration instrument (rétro-compatibilité: premier canal)
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

        // Charger tous les instruments/canaux configurés sur ce device
        try {
          const allInstruments = app.database.getInstrumentsByDevice(device.id);
          if (allInstruments && allInstruments.length > 0) {
            device.instruments = allInstruments.map(inst => {
              let supportedCcs = null;
              if (inst.supported_ccs) {
                try { supportedCcs = JSON.parse(inst.supported_ccs); } catch (e) { /* ignore */ }
              }
              let selectedNotes = null;
              if (inst.selected_notes) {
                try { selectedNotes = JSON.parse(inst.selected_notes); } catch (e) { /* ignore */ }
              }
              return {
                ...inst,
                supported_ccs: supportedCcs,
                selected_notes: selectedNotes,
                note_selection_mode: inst.note_selection_mode || 'range'
              };
            });
          }
        } catch (e) {
          // Pas d'instruments multi-canal, pas grave
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

  // Validate gm_program range (0-127 for instruments, null allowed)
  if (data.gm_program !== undefined && data.gm_program !== null) {
    const gmProg = parseInt(data.gm_program);
    if (isNaN(gmProg) || gmProg < 0 || gmProg > 127) {
      throw new Error('gm_program must be between 0 and 127');
    }
    data.gm_program = gmProg;
  }

  // Validate custom_name length
  if (data.custom_name && data.custom_name.length > 255) {
    throw new Error('custom_name must not exceed 255 characters');
  }

  // Validate octave_mode
  if (data.octave_mode !== undefined && data.octave_mode !== null) {
    const validModes = ['chromatic', 'diatonic', 'pentatonic'];
    if (!validModes.includes(data.octave_mode)) {
      throw new Error('octave_mode must be one of: chromatic, diatonic, pentatonic');
    }
  }

  // Validate comm_timeout
  if (data.comm_timeout !== undefined && data.comm_timeout !== null) {
    const timeout = parseInt(data.comm_timeout);
    if (isNaN(timeout) || timeout < 100 || timeout > 30000) {
      throw new Error('comm_timeout must be between 100 and 30000 milliseconds');
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

  // Validate polyphony range
  if (data.polyphony !== undefined && data.polyphony !== null) {
    const poly = parseInt(data.polyphony);
    if (isNaN(poly) || poly < 1 || poly > 128) {
      throw new Error('polyphony must be between 1 and 128');
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

  // Construire un index par nom normalisé, serial, et MAC pour fallback matching
  const connectedNormalizedNames = new Set();
  const connectedSerials = new Set();
  const connectedMacs = new Set();
  for (const d of connectedDevices) {
    const normalized = InstrumentDatabase.normalizeDeviceName(d.id);
    if (normalized) connectedNormalizedNames.add(normalized);
    if (d.usbSerialNumber) connectedSerials.add(d.usbSerialNumber);
    if (d.address && d.type === 'bluetooth') connectedMacs.add(d.address);
  }

  // Trouver les instruments enregistrés qui sont connectés
  const matchedDeviceIds = new Set();
  const connectedInstruments = allInstruments.filter(inst => {
    // Match exact par device_id
    if (connectedDeviceIds.has(inst.device_id)) {
      matchedDeviceIds.add(inst.device_id);
      return true;
    }
    // Fallback par USB serial number
    if (inst.usb_serial_number && connectedSerials.has(inst.usb_serial_number)) {
      // Trouver le device_id correspondant
      const matchedDev = connectedDevices.find(d => d.usbSerialNumber === inst.usb_serial_number);
      if (matchedDev) matchedDeviceIds.add(matchedDev.id);
      return true;
    }
    // Fallback par MAC address
    if (inst.mac_address && connectedMacs.has(inst.mac_address)) {
      const matchedDev = connectedDevices.find(d => d.address === inst.mac_address);
      if (matchedDev) matchedDeviceIds.add(matchedDev.id);
      return true;
    }
    // Fallback par nom normalisé
    if (!inst.device_id.startsWith('virtual_')) {
      const normalized = InstrumentDatabase.normalizeDeviceName(inst.device_id);
      if (normalized && connectedNormalizedNames.has(normalized)) {
        // Trouver le device_id correspondant
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

  // Ajouter les périphériques connectés qui ne sont pas enregistrés dans instruments_latency
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
    throw new Error('Database not available');
  }

  if (!data.deviceId) {
    throw new Error('deviceId is required');
  }

  const errors = [];
  const hasChannel = data.channel !== undefined && data.channel !== null;
  const channel = hasChannel ? parseInt(data.channel) : null;

  if (hasChannel && (channel < 0 || channel > 15)) {
    throw new Error('channel must be between 0 and 15');
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
    console.warn(`[instrumentDelete] Partial errors for ${data.deviceId}: ${errors.join(', ')}`);
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

/**
 * Toggle virtual instruments on/off.
 * When disabled: disables all routings pointing to virtual instruments in DB.
 * When enabled: re-enables previously disabled virtual instrument routings.
 */
/**
 * Liste tous les instruments configurés sur un device (tous canaux)
 */
async function instrumentListByDevice(app, data) {
  if (!app.database) {
    throw new Error('Database not available');
  }

  if (!data.deviceId) {
    throw new Error('deviceId is required');
  }

  const instruments = app.database.getInstrumentsByDevice(data.deviceId);

  // Parse JSON fields for each instrument
  const parsed = instruments.map(inst => {
    let supportedCcs = null;
    if (inst.supported_ccs) {
      try { supportedCcs = JSON.parse(inst.supported_ccs); } catch (e) { /* ignore */ }
    }
    let selectedNotes = null;
    if (inst.selected_notes) {
      try { selectedNotes = JSON.parse(inst.selected_notes); } catch (e) { /* ignore */ }
    }
    return {
      ...inst,
      supported_ccs: supportedCcs,
      selected_notes: selectedNotes,
      note_selection_mode: inst.note_selection_mode || 'range'
    };
  });

  return {
    success: true,
    deviceId: data.deviceId,
    instruments: parsed,
    total: parsed.length
  };
}

/**
 * Ajoute un nouvel instrument à un device existant sur un canal spécifique
 */
async function instrumentAddToDevice(app, data) {
  if (!app.database) {
    throw new Error('Database not available');
  }

  if (!data.deviceId) {
    throw new Error('deviceId is required');
  }

  const channel = data.channel !== undefined ? parseInt(data.channel) : null;
  if (channel === null || channel < 0 || channel > 15) {
    throw new Error('channel is required and must be between 0 and 15');
  }

  // Vérifier que le canal n'est pas déjà utilisé
  const existing = app.database.getInstrumentSettings(data.deviceId, channel);
  if (existing) {
    throw new Error(`Channel ${channel} is already in use on device ${data.deviceId}`);
  }

  // Créer les settings de base
  const settings = {
    name: data.name || `Instrument Ch${channel + 1}`,
    custom_name: data.custom_name || data.name || null,
    gm_program: data.gm_program !== undefined ? data.gm_program : null
  };

  // Get USB serial number from DeviceManager if available
  if (app.deviceManager) {
    const device = app.deviceManager.getDeviceInfo(data.deviceId);
    if (device && device.usbSerialNumber) {
      settings.usb_serial_number = device.usbSerialNumber;
    }
  }

  const id = app.database.updateInstrumentSettings(data.deviceId, channel, settings);

  // Ajouter les capabilities si fournies
  const capabilities = {};
  if (data.note_range_min !== undefined) capabilities.note_range_min = data.note_range_min;
  if (data.note_range_max !== undefined) capabilities.note_range_max = data.note_range_max;
  if (data.polyphony !== undefined) capabilities.polyphony = data.polyphony;
  if (data.note_selection_mode) capabilities.note_selection_mode = data.note_selection_mode;
  if (data.selected_notes) capabilities.selected_notes = data.selected_notes;
  if (data.supported_ccs) capabilities.supported_ccs = data.supported_ccs;

  if (Object.keys(capabilities).length > 0) {
    capabilities.capabilities_source = 'manual';
    app.database.updateInstrumentCapabilities(data.deviceId, channel, capabilities);
  }

  app.logger.info(`Instrument added to device ${data.deviceId} on channel ${channel}: ${settings.name}`);

  return {
    success: true,
    id: `${data.deviceId}_${channel}`,
    deviceId: data.deviceId,
    channel: channel
  };
}

async function virtualInstrumentToggle(app, data) {
  if (!app.database) {
    throw new Error('Database not available');
  }

  const enabled = !!data.enabled;

  if (enabled) {
    const result = app.database.enableVirtualRoutings();
    app.logger.info(`Virtual instruments enabled - re-enabled ${result.enabledCount} routings`);
    return { success: true, enabledCount: result.enabledCount, affectedFileIds: result.affectedFileIds };
  } else {
    const result = app.database.disableVirtualRoutings();
    app.logger.info(`Virtual instruments disabled - disabled ${result.disabledCount} routings`);
    return { success: true, disabledCount: result.disabledCount, affectedFileIds: result.affectedFileIds };
  }
}

export function register(registry, app) {
  registry.register('device_list', () => deviceList(app));
  registry.register('device_refresh', () => deviceRefresh(app));
  registry.register('device_info', (data) => deviceInfo(app, data));
  registry.register('device_set_properties', (data) => deviceSetProperties(app, data));
  registry.register('device_enable', (data) => deviceEnable(app, data));
  registry.register('device_identity_request', (data) => deviceIdentityRequest(app, data));
  registry.register('sysex_identity_request', (data) => deviceIdentityRequest(app, data));
  registry.register('device_save_sysex_identity', (data) => deviceSaveSysExIdentity(app, data));
  registry.register('instrument_update_settings', (data) => instrumentUpdateSettings(app, data));
  registry.register('instrument_get_settings', (data) => instrumentGetSettings(app, data));
  registry.register('instrument_update_capabilities', (data) => instrumentUpdateCapabilities(app, data));
  registry.register('instrument_get_capabilities', (data) => instrumentGetCapabilities(app, data));
  registry.register('instrument_list_capabilities', () => instrumentListCapabilities(app));
  registry.register('instrument_list_registered', () => instrumentListRegistered(app));
  registry.register('instrument_list_connected', () => instrumentListConnected(app));
  registry.register('instrument_delete', (data) => instrumentDelete(app, data));
  registry.register('instrument_add_to_device', (data) => instrumentAddToDevice(app, data));
  registry.register('instrument_list_by_device', (data) => instrumentListByDevice(app, data));
  registry.register('instrument_create_virtual', (data) => instrumentCreateVirtual(app, data));
  registry.register('virtual_create', (data) => virtualCreate(app, data));
  registry.register('virtual_delete', (data) => virtualDelete(app, data));
  registry.register('virtual_list', () => virtualList(app));
  registry.register('virtual_instrument_toggle', (data) => virtualInstrumentToggle(app, data));
}
