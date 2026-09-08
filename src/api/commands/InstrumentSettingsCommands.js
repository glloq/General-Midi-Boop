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
 * Light shape validation for the instrument-specific play configs
 * (migration 022). `null`/`undefined` are valid (clears / leaves the
 * feature). Keeps validation intentionally permissive — the views
 * defensively default every field via getBagpipeConfig/getAccordionConfig.
 * @throws {ValidationError}
 */
export function validateBagpipeConfigPayload(cfg) {
  if (cfg === null || cfg === undefined) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ValidationError('bagpipe_config must be an object', 'bagpipe_config');
  }
  if (cfg.drones !== undefined) {
    if (!Array.isArray(cfg.drones)) {
      throw new ValidationError('bagpipe_config.drones must be an array', 'bagpipe_config');
    }
    const allNums = cfg.drones.every((n) => Number.isInteger(n) && n >= 0 && n <= 127);
    const allObjs = cfg.drones.every(
      (d) =>
        d &&
        typeof d === 'object' &&
        !Array.isArray(d) &&
        Number.isInteger(d.note) &&
        d.note >= 0 &&
        d.note <= 127 &&
        (d.enabled === undefined || typeof d.enabled === 'boolean')
    );
    if (cfg.drones.length && !allNums && !allObjs) {
      throw new ValidationError(
        'bagpipe_config.drones must be MIDI notes 0-127 or {note,enabled} objects',
        'bagpipe_config'
      );
    }
  }
  if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') {
    throw new ValidationError('bagpipe_config.enabled must be a boolean', 'bagpipe_config');
  }
}

export function validateAccordionConfigPayload(cfg) {
  if (cfg === null || cfg === undefined) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ValidationError('accordion_config must be an object', 'accordion_config');
  }
  const oneOf = (v, set, f) => {
    if (v !== undefined && !set.includes(v)) {
      throw new ValidationError(`accordion_config.${f} invalid`, 'accordion_config');
    }
  };
  // 'chromatic' is still accepted leniently — it is merged into 'free' by
  // read-time normalization (no data migration), so legacy clients/payloads
  // must not be rejected here.
  oneOf(cfg.bass_system, ['stradella', 'chromatic', 'free'], 'bass_system');
  oneOf(cfg.right_display, ['buttons', 'keyboard'], 'right_display');
  if (cfg.bass_range !== undefined) {
    const br = cfg.bass_range;
    if (typeof br !== 'object' || br === null || Array.isArray(br)) {
      throw new ValidationError(
        'accordion_config.bass_range must be an object',
        'accordion_config'
      );
    }
    const note = (v) => v === undefined || (Number.isInteger(v) && v >= 0 && v <= 127);
    if (!note(br.min) || !note(br.max)) {
      throw new ValidationError('accordion_config.bass_range invalid', 'accordion_config');
    }
    if (Number.isInteger(br.min) && Number.isInteger(br.max) && br.min > br.max) {
      throw new ValidationError('accordion_config.bass_range invalid', 'accordion_config');
    }
  }
  // Stradella geometry (left side). All optional; lenient like bass_range.
  if (
    cfg.bass_cols !== undefined &&
    !(Number.isInteger(cfg.bass_cols) && cfg.bass_cols >= 1 && cfg.bass_cols <= 20)
  ) {
    throw new ValidationError('accordion_config.bass_cols invalid', 'accordion_config');
  }
  if (
    cfg.bass_base !== undefined &&
    !(Number.isInteger(cfg.bass_base) && cfg.bass_base >= 0 && cfg.bass_base <= 127)
  ) {
    throw new ValidationError('accordion_config.bass_base invalid', 'accordion_config');
  }
  if (cfg.bass_funcs !== undefined) {
    const FUNCS = ['counterbass', 'bass', 'major', 'minor', 'dom7', 'dim7'];
    if (!Array.isArray(cfg.bass_funcs) || !cfg.bass_funcs.every((f) => FUNCS.includes(f))) {
      throw new ValidationError('accordion_config.bass_funcs invalid', 'accordion_config');
    }
  }
}

// harmonica_config: { type: 'diatonic'|'chromatic', key: 'C'..'B' }. Both
// optional; absence → diatonic C (HarmonicaView default). The chromatic flag
// lives ONLY here — keyboard_type is never set for a harmonica.
export function validateHarmonicaConfigPayload(cfg) {
  if (cfg === null || cfg === undefined) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ValidationError('harmonica_config must be an object', 'harmonica_config');
  }
  if (cfg.type !== undefined && !['diatonic', 'chromatic'].includes(cfg.type)) {
    throw new ValidationError('harmonica_config.type invalid', 'harmonica_config');
  }
  const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  if (cfg.key !== undefined && !KEYS.includes(cfg.key)) {
    throw new ValidationError('harmonica_config.key invalid', 'harmonica_config');
  }
}

/**
 * Resolve a channel from `data.channel` (defaults to 0) and enforce the
 * 0-15 bound. Shared by every per-channel settings/capabilities handler.
 * @returns {number}
 * @throws {ValidationError}
 */
function _resolveChannel(data) {
  const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }
  return channel;
}

/**
 * @throws {ConfigurationError}
 */
function _requireDatabase(app) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }
}

/**
 * `instruments_latency.device_id` has a FK to `devices(id)`. Ensure the
 * parent row exists (idempotent) before any settings/capabilities row is
 * upserted — otherwise the first save for a freshly discovered /
 * hot-plugged device trips SQLITE_CONSTRAINT and the client sees a
 * generic "Internal server error".
 */
function _ensureDeviceRow(app, data) {
  if (app.deviceSettingsRepository) {
    app.deviceSettingsRepository.ensureDevice(data.deviceId, data.name || data.deviceId, 'output');
  }
}

const VALID_OCTAVE_MODES = ['chromatic', 'diatonic', 'pentatonic'];

/**
 * Validate + coerce in place every per-channel settings field shared by
 * `instrument_update_settings` and `instrument_save_all`. Numeric fields
 * are parsed to numbers; boolean-ish fields are coerced to 0/1 for the
 * SQLite INTEGER CHECK constraints. Mutates `data` (same contract the
 * callers already relied on).
 *
 * @param {Object} data
 * @param {{sf2?:boolean}} [opts] - When `sf2`, also validate
 *   `custom_sf2_id` (only `instrument_update_settings` accepts it).
 * @throws {ValidationError}
 */
function _validateSettingsFields(data, { sf2 = false } = {}) {
  if (data.sync_delay !== undefined) {
    const parsed = parseInt(data.sync_delay);
    if (isNaN(parsed) || parsed < -5000 || parsed > 5000) {
      throw new ValidationError(
        'sync_delay must be between -5000 and 5000 milliseconds',
        'sync_delay'
      );
    }
    data.sync_delay = parsed;
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

  if (
    data.octave_mode !== undefined &&
    data.octave_mode !== null &&
    !VALID_OCTAVE_MODES.includes(data.octave_mode)
  ) {
    throw new ValidationError(
      'octave_mode must be one of: chromatic, diatonic, pentatonic',
      'octave_mode'
    );
  }

  if (data.scale_root !== undefined && data.scale_root !== null) {
    const root = parseInt(data.scale_root);
    if (isNaN(root) || root < 0 || root > 11) {
      throw new ValidationError('scale_root must be a pitch class 0..11', 'scale_root');
    }
    data.scale_root = root;
  }

  if (data.comm_timeout !== undefined && data.comm_timeout !== null) {
    const timeout = parseInt(data.comm_timeout);
    if (isNaN(timeout) || timeout < 100 || timeout > 30000) {
      throw new ValidationError(
        'comm_timeout must be between 100 and 30000 milliseconds',
        'comm_timeout'
      );
    }
    data.comm_timeout = timeout;
  }

  for (const field of [
    'omni_mode',
    'lighting_enabled',
    'voices_share_notes',
    'pitch_bend_enabled'
  ]) {
    if (data[field] !== undefined && data[field] !== null) {
      data[field] = data[field] ? 1 : 0;
    }
  }

  if (sf2 && data.custom_sf2_id !== undefined && data.custom_sf2_id !== null) {
    const sf2Id = parseInt(data.custom_sf2_id);
    if (isNaN(sf2Id) || sf2Id <= 0) {
      throw new ValidationError('custom_sf2_id must be a positive integer', 'custom_sf2_id');
    }
    data.custom_sf2_id = sf2Id;
  }
}

/**
 * Validate + coerce `data.polyphony` (1-128) in place when present.
 * @throws {ValidationError}
 */
function _validatePolyphony(data) {
  if (data.polyphony !== undefined && data.polyphony !== null) {
    const poly = parseInt(data.polyphony);
    if (isNaN(poly) || poly < 1 || poly > 128) {
      throw new ValidationError('polyphony must be between 1 and 128', 'polyphony');
    }
    data.polyphony = poly;
  }
}

/**
 * Resolve `usb_serial_number` from the payload, falling back to the live
 * DeviceManager so a row stays identifiable across USB re-enumerations.
 */
function _resolveUsbSerial(app, data) {
  if (data.usb_serial_number) return data.usb_serial_number;
  if (app.deviceManager) {
    const device = app.deviceManager.getDeviceInfo(data.deviceId);
    if (device && device.usbSerialNumber) return device.usbSerialNumber;
  }
  return data.usb_serial_number;
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
  _requireDatabase(app);

  const usbSerialNumber = _resolveUsbSerial(app, data);
  const channel = _resolveChannel(data);
  _validateSettingsFields(data, { sf2: true });
  _ensureDeviceRow(app, data);

  const id = app.instrumentRepository.updateSettings(data.deviceId, channel, {
    custom_name: data.custom_name,
    sync_delay: data.sync_delay,
    mac_address: data.mac_address,
    usb_serial_number: usbSerialNumber,
    name: data.name,
    gm_program: data.gm_program,
    octave_mode: data.octave_mode,
    scale_root: data.scale_root,
    comm_timeout: data.comm_timeout,
    omni_mode: data.omni_mode,
    lighting_enabled: data.lighting_enabled,
    voices_share_notes: data.voices_share_notes,
    custom_sf2_id: data.custom_sf2_id,
    pitch_bend_enabled: data.pitch_bend_enabled
  });

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
  _requireDatabase(app);
  const settings = app.instrumentRepository.getSettings(data.deviceId, data.channel);
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
  _requireDatabase(app);
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const channel = _resolveChannel(data);
  _validatePolyphony(data);
  _ensureDeviceRow(app, data);

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
  // Same explicit-key contract for the instrument-specific play configs.
  if (Object.prototype.hasOwnProperty.call(data, 'bagpipe_config')) {
    validateBagpipeConfigPayload(data.bagpipe_config);
    updatePayload.bagpipe_config = data.bagpipe_config;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'accordion_config')) {
    validateAccordionConfigPayload(data.accordion_config);
    updatePayload.accordion_config = data.accordion_config;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'harmonica_config')) {
    validateHarmonicaConfigPayload(data.harmonica_config);
    updatePayload.harmonica_config = data.harmonica_config;
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
  _requireDatabase(app);
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  const capabilities = app.instrumentRepository.getCapabilities(data.deviceId, data.channel);
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
  _requireDatabase(app);
  return {
    instruments: app.instrumentRepository.getAllCapabilities()
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
  _requireDatabase(app);
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
  _requireDatabase(app);

  const allInstruments = app.instrumentRepository.findAllWithCapabilities();
  const connectedDevices = app.deviceManager.getDeviceList();
  const connectedDeviceIds = new Set(connectedDevices.map((d) => d.id));

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
  const connectedInstruments = allInstruments.filter((inst) => {
    if (connectedDeviceIds.has(inst.device_id)) {
      matchedDeviceIds.add(inst.device_id);
      return true;
    }
    if (inst.usb_serial_number && connectedSerials.has(inst.usb_serial_number)) {
      const matchedDev = connectedDevices.find((d) => d.usbSerialNumber === inst.usb_serial_number);
      if (matchedDev) matchedDeviceIds.add(matchedDev.id);
      return true;
    }
    if (inst.mac_address && connectedMacs.has(inst.mac_address)) {
      const matchedDev = connectedDevices.find((d) => d.address === inst.mac_address);
      if (matchedDev) matchedDeviceIds.add(matchedDev.id);
      return true;
    }
    if (!inst.device_id.startsWith('virtual_')) {
      const normalized = InstrumentDatabase.normalizeDeviceName(inst.device_id);
      if (normalized && connectedNormalizedNames.has(normalized)) {
        const matchedDev = connectedDevices.find(
          (d) => InstrumentDatabase.normalizeDeviceName(d.id) === normalized
        );
        if (matchedDev) matchedDeviceIds.add(matchedDev.id);
        return true;
      }
    }
    return false;
  });

  // Stub records for live devices that have no instruments_latency row yet.
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
 *
 * The four tables that hang off an instrument — `instruments_latency`,
 * `string_instruments`, `instrument_voices` and `midi_instrument_routings` —
 * are cleared in **one transaction** by
 * {@link InstrumentRepository#deleteInstrumentCascade}: either all four go or
 * none does, and a failure surfaces to the client instead of being logged under
 * a `success: true` (audit F-81).
 *
 * Not cleaned up here — and deliberately no longer promised by this doc
 * comment: `instrument_light_state`, `instrument_light_config` and
 * `lighting_rules` carry no FK to `devices` and no handler removes them
 * (audit F-79, still open).
 *
 * @param {Object} app
 * @param {{deviceId:string, channel?:number}} data
 * @returns {Promise<{success:true}>} Only ever returned when all four deletes
 *   committed.
 * @throws {ConfigurationError|ValidationError|Error} Rethrows a failed cascade
 *   after rollback — nothing was deleted.
 */
export async function instrumentDelete(app, data) {
  _requireDatabase(app);
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const hasChannel = data.channel !== undefined && data.channel !== null;
  const channel = hasChannel ? parseInt(data.channel) : null;

  if (hasChannel && (channel < 0 || channel > 15)) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  const scopedChannel = hasChannel ? channel : undefined;

  // Atomic cascade (F-81). Any real error propagates: the transaction rolled
  // back, so the instrument is intact and the client is told so.
  const cascade = app.instrumentRepository.deleteInstrumentCascade(data.deviceId, scopedChannel);
  if (cascade?.skippedTables?.length) {
    app.logger.warn(
      `[instrumentDelete] ${data.deviceId}: absent table(s) skipped: ${cascade.skippedTables.join(', ')}`
    );
  }

  // Virtual devices also live in the in-memory DeviceManager registry,
  // which feeds device_list. Deleting only the DB row leaves them visible
  // in the instrument modal until they are evicted from that registry too.
  // Mirror virtualDelete(): once the device's last channel is gone,
  // unregister it from the DeviceManager.
  if (
    data.deviceId.startsWith('virtual_') &&
    app.deviceManager &&
    typeof app.deviceManager.removeVirtualDevice === 'function'
  ) {
    let remaining = [];
    try {
      remaining = app.instrumentRepository.findByDevice(data.deviceId) || [];
    } catch (_e) {
      /* table may not exist */
    }
    if (remaining.length === 0) {
      app.deviceManager.removeVirtualDevice(data.deviceId);
    }
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
  _requireDatabase(app);
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const usbSerialNumber = _resolveUsbSerial(app, data);
  const channel = _resolveChannel(data);
  _validateSettingsFields(data, { sf2: true });
  _validatePolyphony(data);

  // Cross-field range check at the save-all boundary, mirroring the
  // per-voice guard in InstrumentVoiceCommands.
  if (
    data.note_range_min != null &&
    data.note_range_max != null &&
    parseInt(data.note_range_min) > parseInt(data.note_range_max)
  ) {
    throw new ValidationError('note_range_min must be <= note_range_max', 'note_range_min');
  }

  // Same contract as instrument_voice_replace.
  const rawVoices = Array.isArray(data.voices) ? data.voices : [];
  const normalizedVoices = rawVoices.map((v) => validateVoicePayload(v));

  _ensureDeviceRow(app, data);

  // Single SQLite transaction so a failure anywhere rolls back the save.
  const tx = app.instrumentRepository.transaction(() => {
    app.instrumentRepository.updateSettings(data.deviceId, channel, {
      custom_name: data.custom_name,
      sync_delay: data.sync_delay,
      mac_address: data.mac_address,
      usb_serial_number: usbSerialNumber,
      name: data.name,
      gm_program: data.gm_program,
      octave_mode: data.octave_mode,
      scale_root: data.scale_root,
      comm_timeout: data.comm_timeout,
      min_note_interval: data.min_note_interval,
      min_note_duration: data.min_note_duration,
      omni_mode: data.omni_mode,
      lighting_enabled: data.lighting_enabled,
      voices_share_notes: data.voices_share_notes,
      // custom_sf2_id and pitch_bend_enabled were previously dropped here, so
      // the Advanced-tab SoundFont override and the Pitch-Bend toggle could
      // never be persisted from the instrument-settings modal (its only save
      // path is instrument_save_all).
      custom_sf2_id: data.custom_sf2_id,
      pitch_bend_enabled: data.pitch_bend_enabled
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
    if (Object.prototype.hasOwnProperty.call(data, 'bagpipe_config')) {
      validateBagpipeConfigPayload(data.bagpipe_config);
      capPayload.bagpipe_config = data.bagpipe_config;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'accordion_config')) {
      validateAccordionConfigPayload(data.accordion_config);
      capPayload.accordion_config = data.accordion_config;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'harmonica_config')) {
      validateHarmonicaConfigPayload(data.harmonica_config);
      capPayload.harmonica_config = data.harmonica_config;
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
        scale_length_mm: si.scale_length_mm,
        string_sliding_system_enabled: si.string_sliding_system_enabled
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
  registry.register('instrument_update_capabilities', (data) =>
    instrumentUpdateCapabilities(app, data)
  );
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
