/**
 * @file src/api/commands/DeviceCommands.js
 * @description WebSocket command handlers for MIDI device discovery,
 * inspection and lifecycle.
 *
 * Registered commands:
 *   - `device_list`                 — enumerate ports + enrich with DB
 *   - `device_refresh`              — rescan hardware then deduplicate
 *   - `device_info`                 — single-device detail
 *   - `device_set_properties`       — placeholder, currently no-op
 *   - `device_enable`               — toggle a port on/off
 *   - `device_identity_request`     — emit MIDI Universal Identity Request
 *   - `sysex_identity_request`      — alias of the above
 *   - `device_save_sysex_identity`  — persist sniffed identity
 *
 * Validation: see `device.schemas.js`.
 */
import { NotFoundError, ConfigurationError } from '../../core/errors/index.js';

/**
 * Enumerate every MIDI port currently visible to the DeviceManager and
 * enrich each entry with persisted settings (custom display name, GM
 * program, polyphony, note-range, USB serial, channel-level instruments).
 * Database lookups are best-effort: a missing or partial settings row
 * never prevents a device from appearing.
 *
 * @param {Object} app - Application facade.
 * @returns {Promise<{devices: Object[]}>}
 */
async function deviceList(app) {
  const devices = app.deviceManager.getDeviceList();

  // Enrich devices with data from the database
  if (app.database) {
    for (const device of devices) {
      try {
        const settings = app.deviceReconciliationService.resolveSettings(device);

        if (settings) {
          if (settings.custom_name) {
            device.displayName = settings.custom_name;
          }
          // Include instrument configuration fields (backward compatibility: first channel)
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
          // Include the usb_serial_number in the response
          if (settings.usb_serial_number) {
            device.usb_serial_number = settings.usb_serial_number;
          }
        }

        // Enrich with device-level custom_name (takes priority over instrument-level)
        try {
          const deviceSettings = app.deviceSettingsRepository.findByDeviceId(device.id);
          if (deviceSettings && deviceSettings.custom_name) {
            device.displayName = deviceSettings.custom_name;
            device.deviceCustomName = deviceSettings.custom_name;
          }
        } catch (_e) { /* ignore */ }

        // Load all instruments/channels configured on this device
        try {
          const allInstruments = app.instrumentRepository.findByDevice(device.id);
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
          // No multi-channel instruments, not a problem
        }

        // Always include the device's USB serial number if it has one
        if (device.usbSerialNumber && !device.usb_serial_number) {
          device.usb_serial_number = device.usbSerialNumber;
        }
      } catch (error) {
        // Ignore errors - the device may not have any settings
      }
    }
  }

  app.logger.debug(`[CommandHandler] deviceList returning ${devices.length} devices:`,
    devices.map(d => `"${d.displayName || d.name}" (${d.type})`).join(', '));
  return { devices: devices };
}

/**
 * Force a hardware rescan and run instrument-row deduplication keyed by
 * USB serial (cleans up after a device replaced/repaired its address).
 *
 * @param {Object} app
 * @returns {Promise<{devices: Object[]}>}
 */
async function deviceRefresh(app) {
  const devices = await app.deviceManager.scanDevices();

  // After a scan, reconcile device_ids by USB serial number
  if (app.database) {
    try {
      const removed = app.instrumentRepository.deduplicateByUsbSerial();
      if (removed > 0) {
        app.logger.info(`[deviceRefresh] Deduplicated ${removed} instrument entries by USB serial`);
      }
    } catch (e) {
      app.logger.warn(`[deviceRefresh] Deduplication failed: ${e.message}`);
    }
  }

  return { devices: devices };
}

/**
 * Look up a single device by id.
 *
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{device: Object}>}
 * @throws {NotFoundError} When `deviceId` is unknown.
 */
async function deviceInfo(app, data) {
  const device = app.deviceManager.getDeviceInfo(data.deviceId);
  if (!device) {
    throw new NotFoundError('Device', data.deviceId);
  }
  return { device: device };
}

/**
 * Placeholder for per-device property updates.
 * TODO: wire to `DeviceSettingsRepository#update` once the UI surfaces
 * an editor.
 *
 * @returns {Promise<{success: true}>}
 */
async function deviceSetProperties(_app, _data) {
  return { success: true };
}

/**
 * Toggle a device on or off in the DeviceManager (no DB persistence —
 * the toggle is process-local).
 *
 * @param {Object} app
 * @param {{deviceId:string, enabled:boolean}} data
 * @returns {Promise<{success: true}>}
 */
async function deviceEnable(app, data) {
  app.deviceManager.enableDevice(data.deviceId, data.enabled);
  return { success: true };
}

/**
 * Send a MIDI Universal Identity Request SysEx to a device. Response
 * (if any) arrives asynchronously through the normal MIDI input path —
 * this command only emits the request.
 *
 * @param {Object} app
 * @param {{deviceName:string, deviceId?:number}} data - `deviceId`
 *   defaults to `0x7F` (the SysEx broadcast address).
 * @returns {Promise<{success:true, message:string}>}
 * @throws Propagates any error thrown by `DeviceManager#sendIdentityRequest`.
 */
async function deviceIdentityRequest(app, data) {
  app.deviceManager.sendIdentityRequest(
    data.deviceName,
    data.deviceId || 0x7F
  );

  return {
    success: true,
    message: 'Identity Request sent. Waiting for response...'
  };
}

/**
 * Persist a previously sniffed Universal Identity Reply against the
 * given device/channel.
 *
 * @param {Object} app
 * @param {{deviceId:string, channel?:number, identity:Object}} data -
 *   `channel` defaults to 0 for backward compatibility with single-channel
 *   devices.
 * @returns {Promise<{success:true, id:number}>}
 * @throws {ConfigurationError} When the database is not available.
 */
async function deviceSaveSysExIdentity(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const channel = data.channel !== undefined ? data.channel : 0;
  const id = app.instrumentRepository.saveSysExIdentity(data.deviceId, channel, data.identity);

  return {
    success: true,
    id: id
  };
}

/**
 * Wire every device-related command on the registry.
 *
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
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
