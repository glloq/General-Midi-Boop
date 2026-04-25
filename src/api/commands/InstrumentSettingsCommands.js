/**
 * @file src/api/commands/InstrumentSettingsCommands.js
 * @description WebSocket commands for per-channel instrument settings
 * (custom name, sync delay, GM program, octave mode, capabilities) and
 * the registered/connected listings.
 *
 * Registered commands:
 *   - `instrument_update_settings` / `instrument_get_settings`
 *   - `instrument_update_capabilities` / `instrument_get_capabilities`
 *   - `instrument_list_capabilities`
 *   - `instrument_list_registered` / `instrument_list_connected`
 *   - `instrument_delete`
 *
 * Settings updates emit `instrument_settings_changed` on the EventBus
 * so cached latency / GM mapping values are recomputed.
 *
 * Validation: imperative inside each handler (range checks for MIDI
 * fields, length cap for free-text custom names).
 */
import InstrumentDatabase from '../../persistence/tables/InstrumentDatabase.js';
import InstrumentTypeConfig from '../../midi/adaptation/InstrumentTypeConfig.js';
import InstrumentCapabilitiesValidator from '../../midi/adaptation/InstrumentCapabilitiesValidator.js';
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';
import { validateVoicePayload } from './InstrumentVoiceCommands.js';

/**
 * Run the hand-position config payload through the shared validator so a
 * malformed structure (wrong mode, cross-unit fields, bad bounds…) is
 * rejected at save time rather than ending up in the DB and tripping the
 * planner at playback. `null` / `undefined` / explicit `{enabled: false}`
 * are accepted — they mean "disable the feature". Exported for tests.
 */
export function validateHandsConfigPayload(handsConfig) {
  if (handsConfig === null || handsConfig === undefined) return;
  const validator = new InstrumentCapabilitiesValidator();
  const issues = validator._validateHandsConfig(handsConfig);
  if (issues.length === 0) return;
  const first = issues[0];
  throw new ValidationError(
    first.reason || `Invalid hands_config (${first.field})`,
    first.field || 'hands_config'
  );
}

/**
 * Persist per-channel instrument settings (custom name, sync delay,
 * GM program, octave mode, comm timeout). When `usb_serial_number` is
 * not supplied, it is looked up from the live DeviceManager so the row
 * remains identifiable across USB re-enumerations.
 *
 * Emits `instrument_settings_changed` on the EventBus.
 *
 * @param {Object} app
 * @param {Object} data - `{deviceId, channel?, custom_name?,
 *   sync_delay?, mac_address?, usb_serial_number?, name?, gm_program?,
 *   octave_mode?, comm_timeout?}`. Channel defaults to 0.
 * @returns {Promise<{success:true, id:(string|number)}>}
 * @throws {ConfigurationError|ValidationError}
 */
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

  // Coerce omni_mode to 0/1 for SQLite INTEGER CHECK
  if (data.omni_mode !== undefined && data.omni_mode !== null) {
    data.omni_mode = data.omni_mode ? 1 : 0;
  }

  // Coerce voices_share_notes to 0/1 for SQLite INTEGER CHECK
  if (data.voices_share_notes !== undefined && data.voices_share_notes !== null) {
    data.voices_share_notes = data.voices_share_notes ? 1 : 0;
  }

  // `instruments_latency.device_id` has a FK to `devices(id)`. Ensure
  // the parent row exists (idempotent INSERT OR IGNORE) before the
  // settings row is upserted — otherwise the first save for a newly
  // discovered / hot-plugged device trips SQLITE_CONSTRAINT and the
  // client sees a generic "Internal server error".
  if (app.deviceSettingsRepository) {
    app.deviceSettingsRepository.ensureDevice(
      data.deviceId,
      data.name || data.deviceId,
      'output'
    );
  }

  const id = app.instrumentRepository.updateSettings(data.deviceId, channel, {
    custom_name: data.custom_name,
    sync_delay: data.sync_delay,
    mac_address: data.mac_address,
    usb_serial_number: usbSerialNumber,
    name: data.name,
    gm_program: data.gm_program,
    octave_mode: data.octave_mode,
    comm_timeout: data.comm_timeout,
    omni_mode: data.omni_mode,
    voices_share_notes: data.voices_share_notes
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

/**
 * Read per-channel instrument settings. When `channel` is omitted, the
 * repository returns the first matching row (legacy single-channel
 * behaviour).
 *
 * @param {Object} app
 * @param {{deviceId:string, channel?:number}} data
 * @returns {Promise<{settings: ?Object}>}
 * @throws {ConfigurationError}
 */
async function instrumentGetSettings(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const channel = data.channel !== undefined ? data.channel : undefined;
  const settings = app.instrumentRepository.getSettings(data.deviceId, channel);

  return {
    settings: settings || null
  };
}

/**
 * Persist per-channel capabilities (polyphony, note range, supported
 * CCs, instrument type). Validates the polyphony range and channel
 * bounds; emits `instrument_settings_changed`.
 *
 * @param {Object} app
 * @param {Object} data - `{deviceId, channel?, polyphony?, note_range_min?,
 *   note_range_max?, supported_ccs?, instrument_type?, ...}`.
 * @returns {Promise<{success:true, id:(string|number)}>}
 * @throws {ConfigurationError|ValidationError}
 */
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

  // Same FK guard as instrument_update_settings — capabilities can be
  // saved before settings for a freshly discovered device.
  if (app.deviceSettingsRepository) {
    app.deviceSettingsRepository.ensureDevice(
      data.deviceId,
      data.name || data.deviceId,
      'output'
    );
  }

  const updatePayload = {
    note_range_min: data.note_range_min,
    note_range_max: data.note_range_max,
    supported_ccs: data.supported_ccs,
    note_selection_mode: data.note_selection_mode,
    selected_notes: data.selected_notes,
    polyphony: data.polyphony,
    capabilities_source: data.capabilities_source || 'manual'
  };
  // Only forward hands_config when the caller explicitly sent it, so an
  // update that does not touch the Hands section preserves the existing
  // value (pass `null` to clear the feature).
  if (Object.prototype.hasOwnProperty.call(data, 'hands_config')) {
    validateHandsConfigPayload(data.hands_config);
    updatePayload.hands_config = data.hands_config;
  }
  const id = app.instrumentRepository.updateCapabilities(data.deviceId, channel, updatePayload);

  return {
    success: true,
    id: id
  };
}

/**
 * Read per-channel capabilities. Channel-less call returns the first
 * matching row.
 *
 * @param {Object} app
 * @param {{deviceId:string, channel?:number}} data
 * @returns {Promise<{capabilities: ?Object}>}
 * @throws {ConfigurationError|ValidationError}
 */
async function instrumentGetCapabilities(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  // Pass channel if provided, otherwise backward compat (first match)
  const channel = data.channel !== undefined ? data.channel : undefined;
  const capabilities = app.instrumentRepository.getCapabilities(data.deviceId, channel);

  return {
    capabilities: capabilities || null
  };
}

/**
 * List capability rows for every registered instrument (across every
 * channel).
 *
 * @param {Object} app
 * @returns {Promise<{instruments:Object[]}>}
 * @throws {ConfigurationError}
 */
async function instrumentListCapabilities(app) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const instruments = app.instrumentRepository.getAllCapabilities();

  return {
    instruments: instruments
  };
}

/**
 * List every registered instrument (with capabilities), regardless of
 * whether the underlying device is currently connected.
 *
 * @param {Object} app
 * @returns {Promise<{success:true, instruments:Object[], total:number}>}
 * @throws {ConfigurationError}
 */
async function instrumentListRegistered(app) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const instruments = app.instrumentRepository.findAllWithCapabilities();

  return {
    success: true,
    instruments: instruments,
    total: instruments.length
  };
}

/**
 * Return the subset of registered instruments whose underlying device
 * is currently connected, plus stub records for live devices that are
 * not yet registered.
 *
 * Matching falls back through several keys (device_id → USB serial →
 * Bluetooth MAC → normalised device name) so identifier drift caused
 * by USB re-enumeration or driver renames does not orphan rows.
 *
 * @param {Object} app
 * @returns {Promise<{success:true, instruments:Object[], total:number,
 *   connectedDevices:number}>}
 * @throws {ConfigurationError}
 */
async function instrumentListConnected(app) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }

  const allInstruments = app.instrumentRepository.findAllWithCapabilities();
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

/**
 * Delete an instrument row. When `channel` is supplied, only that
 * channel is removed; otherwise every channel for the device is wiped.
 * Cascades to the auxiliary tables (string instruments, routings,
 * device settings, lighting rules) so referential integrity is
 * preserved without relying on FK declarations.
 *
 * @param {Object} app
 * @param {{deviceId:string, channel?:number}} data
 * @returns {Promise<{success:boolean, errors?:string[]}>}
 * @throws {ConfigurationError|ValidationError}
 */
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
    app.instrumentRepository.deleteSettingsByDevice(data.deviceId, hasChannel ? channel : undefined);
  } catch (e) {
    errors.push(`instruments_latency: ${e.message}`);
  }

  // Cascade: delete associated string instrument configs
  try {
    app.stringInstrumentRepository.deleteByDevice(data.deviceId, hasChannel ? channel : undefined);
  } catch (e) {
    // string_instruments table may not exist
  }

  // Cascade: delete secondary GM voices (multi-GM) for this instrument
  try {
    if (hasChannel) {
      app.instrumentRepository.deleteVoicesByInstrument(data.deviceId, channel);
    } else {
      // device-wide: purge voices across all channels
      app.instrumentRepository.deleteVoicesByInstrument(data.deviceId);
    }
  } catch (e) {
    errors.push(`instrument_voices: ${e.message}`);
  }

  // Cascade: delete associated MIDI instrument routings
  try {
    app.routingRepository.deleteByDevice(data.deviceId, hasChannel ? channel : undefined);
  } catch (e) {
    // midi_instrument_routings table may not exist
  }

  // The legacy `instruments` table and `instrument_latency` (singular)
  // were removed in v6. The deleteSettingsByDevice() call above already
  // wiped every per-channel row on `instruments_latency` (plural),
  // which is the only place latency + capabilities live now.

  if (errors.length > 0) {
    app.logger.warn(`[instrumentDelete] Partial errors for ${data.deviceId}: ${errors.join(', ')}`);
  }

  // Notify routing / clock / playback caches that this (device, channel)
  // no longer exists — same signal the update handlers emit. Consumers
  // (MidiRouter, MidiClockGenerator, PlaybackScheduler) ignore the
  // payload and invalidate wholesale, so broadcasting `channel: null`
  // for device-wide deletes is safe.
  app.eventBus?.emit('instrument_settings_changed', {
    deviceId: data.deviceId,
    channel: hasChannel ? channel : null
  });

  return {
    success: true
  };
}

/**
 * Atomic save for an entire instrument: settings + capabilities +
 * secondary voices + (optional) string instrument config are all written
 * inside a single SQLite transaction, so a mid-save failure cannot leave
 * a partial row. Replaces the old sequence of three separate WebSocket
 * commands in the UI save path (the individual commands remain registered
 * for backward compat — e.g. auto-assignment writes capabilities on their
 * own).
 *
 * Payload shape:
 *   {
 *     deviceId, channel,
 *     // settings
 *     custom_name?, sync_delay?, mac_address?, usb_serial_number?, name?,
 *     gm_program?, octave_mode?, comm_timeout?,
 *     min_note_interval?, min_note_duration?, omni_mode?,
 *     voices_share_notes?,
 *     // capabilities
 *     polyphony?, note_range_min?, note_range_max?, supported_ccs?,
 *     note_selection_mode?, selected_notes?, capabilities_source?,
 *     // secondary voices (already validated per-voice)
 *     voices?: Array<VoicePayload>,
 *     // string instrument (optional — only for fretted/bowed GM programs)
 *     string_instrument?: Object
 *   }
 *
 * Emits `instrument_settings_changed` once on success.
 * @throws {ConfigurationError|ValidationError}
 */
async function instrumentSaveAll(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  // USB serial fallback — same fallback as instrument_update_settings so
  // a newly-discovered device keeps its identity across re-enumeration.
  let usbSerialNumber = data.usb_serial_number;
  if (!usbSerialNumber && app.deviceManager) {
    const device = app.deviceManager.getDeviceInfo(data.deviceId);
    if (device && device.usbSerialNumber) usbSerialNumber = device.usbSerialNumber;
  }

  // Validate identity
  const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // Validate settings fields (same rules as instrument_update_settings)
  if (data.sync_delay !== undefined) {
    const parsedDelay = parseInt(data.sync_delay);
    if (isNaN(parsedDelay) || parsedDelay < -5000 || parsedDelay > 5000) {
      throw new ValidationError('sync_delay must be between -5000 and 5000 milliseconds', 'sync_delay');
    }
    data.sync_delay = parsedDelay;
  }
  if (data.gm_program !== undefined && data.gm_program !== null) {
    const gmProg = parseInt(data.gm_program);
    if (isNaN(gmProg) || gmProg < 0 || gmProg > 127) {
      throw new ValidationError('gm_program must be between 0 and 127', 'gm_program');
    }
    data.gm_program = gmProg;
  }
  if (data.custom_name && data.custom_name.length > 255) {
    throw new ValidationError('custom_name must not exceed 255 characters', 'custom_name');
  }
  if (data.octave_mode !== undefined && data.octave_mode !== null) {
    const validModes = ['chromatic', 'diatonic', 'pentatonic'];
    if (!validModes.includes(data.octave_mode)) {
      throw new ValidationError('octave_mode must be one of: chromatic, diatonic, pentatonic', 'octave_mode');
    }
  }
  if (data.comm_timeout !== undefined && data.comm_timeout !== null) {
    const timeout = parseInt(data.comm_timeout);
    if (isNaN(timeout) || timeout < 100 || timeout > 30000) {
      throw new ValidationError('comm_timeout must be between 100 and 30000 milliseconds', 'comm_timeout');
    }
    data.comm_timeout = timeout;
  }
  if (data.omni_mode !== undefined && data.omni_mode !== null) {
    data.omni_mode = data.omni_mode ? 1 : 0;
  }
  if (data.voices_share_notes !== undefined && data.voices_share_notes !== null) {
    data.voices_share_notes = data.voices_share_notes ? 1 : 0;
  }

  // Validate capabilities
  if (data.polyphony !== undefined && data.polyphony !== null) {
    const poly = parseInt(data.polyphony);
    if (isNaN(poly) || poly < 1 || poly > 128) {
      throw new ValidationError('polyphony must be between 1 and 128', 'polyphony');
    }
    data.polyphony = poly;
  }
  // Cross-field range check at the save-all boundary, mirroring the
  // per-voice guard in InstrumentVoiceCommands.
  if (data.note_range_min != null && data.note_range_max != null
      && parseInt(data.note_range_min) > parseInt(data.note_range_max)) {
    throw new ValidationError('note_range_min must be <= note_range_max', 'note_range_min');
  }

  // Validate secondary voices via the shared validator (same contract as
  // instrument_voice_replace).
  const rawVoices = Array.isArray(data.voices) ? data.voices : [];
  const normalizedVoices = rawVoices.map((v) => validateVoicePayload(v));

  // FK guard — ensureDevice is idempotent.
  if (app.deviceSettingsRepository) {
    app.deviceSettingsRepository.ensureDevice(
      data.deviceId,
      data.name || data.deviceId,
      'output'
    );
  }

  // Run every DB write in a single SQLite transaction so a failure
  // anywhere rolls back the whole save.
  const tx = app.instrumentRepository.transaction(() => {
    app.instrumentRepository.updateSettings(data.deviceId, channel, {
      custom_name: data.custom_name,
      sync_delay: data.sync_delay,
      mac_address: data.mac_address,
      usb_serial_number: usbSerialNumber,
      name: data.name,
      gm_program: data.gm_program,
      octave_mode: data.octave_mode,
      comm_timeout: data.comm_timeout,
      min_note_interval: data.min_note_interval,
      min_note_duration: data.min_note_duration,
      omni_mode: data.omni_mode,
      voices_share_notes: data.voices_share_notes
    });

    const capPayload = {
      note_range_min: data.note_range_min,
      note_range_max: data.note_range_max,
      supported_ccs: data.supported_ccs,
      note_selection_mode: data.note_selection_mode,
      selected_notes: data.selected_notes,
      polyphony: data.polyphony,
      capabilities_source: data.capabilities_source || 'manual'
    };
    // Only forward hands_config when the caller explicitly sent it, so an
    // omitted key preserves the existing DB value (same contract as
    // `instrument_update_capabilities`).
    if (Object.prototype.hasOwnProperty.call(data, 'hands_config')) {
      validateHandsConfigPayload(data.hands_config);
      capPayload.hands_config = data.hands_config;
    }
    app.instrumentRepository.updateCapabilities(data.deviceId, channel, capPayload);

    if (data.string_instrument && app.stringInstrumentRepository) {
      const si = data.string_instrument;
      app.stringInstrumentRepository.save({
        device_id: data.deviceId,
        channel: channel,
        instrument_name: si.instrument_name,
        num_strings: si.num_strings,
        num_frets: si.num_frets,
        tuning: si.tuning,
        is_fretless: si.is_fretless,
        capo_fret: si.capo_fret,
        cc_enabled: si.cc_enabled,
        cc_string_number: si.cc_string_number,
        cc_string_min: si.cc_string_min,
        cc_string_max: si.cc_string_max,
        cc_string_offset: si.cc_string_offset,
        cc_fret_number: si.cc_fret_number,
        cc_fret_min: si.cc_fret_min,
        cc_fret_max: si.cc_fret_max,
        cc_fret_offset: si.cc_fret_offset,
        frets_per_string: si.frets_per_string,
        scale_length_mm: si.scale_length_mm
      });
    }

    app.instrumentRepository.replaceVoices(data.deviceId, channel, normalizedVoices);
  });
  tx();

  app.eventBus?.emit('instrument_settings_changed', {
    deviceId: data.deviceId,
    channel: channel
  });

  return { success: true };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('instrument_update_settings', (data) => instrumentUpdateSettings(app, data));
  registry.register('instrument_get_settings', (data) => instrumentGetSettings(app, data));
  registry.register('instrument_update_capabilities', (data) => instrumentUpdateCapabilities(app, data));
  registry.register('instrument_get_capabilities', (data) => instrumentGetCapabilities(app, data));
  registry.register('instrument_list_capabilities', () => instrumentListCapabilities(app));
  registry.register('instrument_list_registered', () => instrumentListRegistered(app));
  registry.register('instrument_list_connected', () => instrumentListConnected(app));
  registry.register('instrument_delete', (data) => instrumentDelete(app, data));
  registry.register('instrument_save_all', (data) => instrumentSaveAll(app, data));
  registry.register('instrument_types_list', () => ({
    categories: InstrumentTypeConfig.getCategories(),
    hierarchy: InstrumentTypeConfig.hierarchy,
    families: InstrumentTypeConfig.families
  }));
  registry.register('instrument_type_detect', (data) => ({
    ...InstrumentTypeConfig.detectTypeFromProgram(data.gm_program)
  }));
}
