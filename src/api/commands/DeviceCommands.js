// src/api/commands/DeviceCommands.js
import { NotFoundError, ConfigurationError } from '../../core/errors/index.js';

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
    throw new NotFoundError('Device', data.deviceId);
  }
  return { device: device };
}

async function deviceSetProperties(_app, _data) {
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
    throw new ConfigurationError('Database not available');
  }

  // Channel defaults to 0 for backward compatibility
  const channel = data.channel !== undefined ? data.channel : 0;
  const id = app.database.saveSysExIdentity(data.deviceId, channel, data.identity);

  return {
    success: true,
    id: id
  };
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
}
