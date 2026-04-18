/**
 * @file src/api/commands/StringInstrumentCommands.js
 * @description WebSocket commands for string-instrument configuration
 * (guitar/bass/violin per-channel mapping: tuning, fret count, capo,
 * CC mappings) and tablature CRUD/conversion.
 *
 * Registered commands:
 *   - `string_instrument_create` / `_update` / `_delete` / `_get` / `_list`
 *   - `string_instrument_get_presets` / `_apply_preset` / `_create_from_preset`
 *   - `tablature_save` / `_get` / `_get_by_file` / `_delete`
 *   - `tablature_convert_from_midi` / `_convert_to_midi`
 *
 * Validation: imperative inside each handler.
 */

import TablatureConverter from '../../midi/adaptation/TablatureConverter.js';
import { ValidationError, NotFoundError } from '../../core/errors/index.js';

// ==================== STRING INSTRUMENT CONFIG ====================

/**
 * Persist a new string-instrument config row.
 *
 * @param {Object} app
 * @param {Object} data - Full config payload (device_id, channel,
 *   instrument_name, num_strings, num_frets, tuning, is_fretless,
 *   capo_fret, CC mapping fields, frets_per_string).
 * @returns {Promise<{success:true, id:(string|number)}>}
 */
async function stringInstrumentCreate(app, data) {
  const id = app.stringInstrumentRepository.save({
    device_id: data.device_id,
    channel: data.channel,
    instrument_name: data.instrument_name,
    num_strings: data.num_strings,
    num_frets: data.num_frets,
    tuning: data.tuning,
    is_fretless: data.is_fretless,
    capo_fret: data.capo_fret,
    cc_enabled: data.cc_enabled,
    tab_algorithm: data.tab_algorithm,
    cc_string_number: data.cc_string_number,
    cc_string_min: data.cc_string_min,
    cc_string_max: data.cc_string_max,
    cc_string_offset: data.cc_string_offset,
    cc_fret_number: data.cc_fret_number,
    cc_fret_min: data.cc_fret_min,
    cc_fret_max: data.cc_fret_max,
    cc_fret_offset: data.cc_fret_offset,
    frets_per_string: data.frets_per_string
  });
  return { success: true, id };
}

/**
 * Partial update — only fields present in `data` are written.
 *
 * @param {Object} app
 * @param {Object} data - Must include `id`; remaining fields optional.
 * @returns {Promise<{success:boolean}>}
 * @throws {ValidationError}
 */
async function stringInstrumentUpdate(app, data) {
  if (!data.id) throw new ValidationError('id is required', 'id');

  const updated = app.stringInstrumentRepository.update(data.id, {
    instrument_name: data.instrument_name,
    num_strings: data.num_strings,
    num_frets: data.num_frets,
    tuning: data.tuning,
    is_fretless: data.is_fretless,
    capo_fret: data.capo_fret,
    cc_enabled: data.cc_enabled,
    tab_algorithm: data.tab_algorithm,
    cc_string_number: data.cc_string_number,
    cc_string_min: data.cc_string_min,
    cc_string_max: data.cc_string_max,
    cc_string_offset: data.cc_string_offset,
    cc_fret_number: data.cc_fret_number,
    cc_fret_min: data.cc_fret_min,
    cc_fret_max: data.cc_fret_max,
    cc_fret_offset: data.cc_fret_offset,
    frets_per_string: data.frets_per_string
  });
  return { success: updated };
}

/**
 * Delete by row id, or by `(device_id, channel)` pair.
 *
 * @param {Object} app
 * @param {{id?:(string|number), device_id?:string, channel?:number}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function stringInstrumentDelete(app, data) {
  if (data.id) {
    app.stringInstrumentRepository.delete(data.id);
  } else if (data.device_id !== undefined) {
    app.stringInstrumentRepository.deleteByDeviceChannel(
      data.device_id, data.channel
    );
  } else {
    throw new ValidationError('id or device_id is required', 'id');
  }
  return { success: true };
}

/**
 * Lookup by row id, or by `(device_id, channel)` pair.
 *
 * @param {Object} app
 * @param {{id?:(string|number), device_id?:string, channel?:number}} data
 * @returns {Promise<{instrument: ?Object}>}
 * @throws {ValidationError}
 */
async function stringInstrumentGet(app, data) {
  let instrument;
  if (data.id) {
    instrument = app.stringInstrumentRepository.findById(data.id);
  } else if (data.device_id !== undefined) {
    instrument = app.stringInstrumentRepository.findByDeviceChannel(data.device_id, data.channel);
  } else {
    throw new ValidationError('id or device_id is required', 'id');
  }
  return { instrument };
}

/**
 * @param {Object} app
 * @param {{device_id?:string}} data - When `device_id` is provided,
 *   lists rows for that device only.
 * @returns {Promise<{instruments:Object[]}>}
 */
async function stringInstrumentList(app, data) {
  let instruments;
  if (data.device_id) {
    instruments = app.stringInstrumentRepository.findByDevice(data.device_id);
  } else {
    instruments = app.stringInstrumentRepository.findAll();
  }
  return { instruments };
}

// ==================== TUNING PRESETS ====================

/**
 * @param {Object} app
 * @returns {Promise<{presets:Object[]}>}
 */
async function stringInstrumentGetPresets(app) {
  const presets = app.stringInstrumentRepository.findAllTuningPresets();
  return { presets };
}

/**
 * Resolve a preset descriptor by key (read-only — caller decides when
 * to persist).
 *
 * @param {Object} app
 * @param {{preset_key:string}} data
 * @returns {Promise<{preset:Object}>}
 * @throws {ValidationError|NotFoundError}
 */
async function stringInstrumentApplyPreset(app, data) {
  if (!data.preset_key) throw new ValidationError('preset_key is required', 'preset_key');

  const preset = app.stringInstrumentRepository.findTuningPreset(data.preset_key);
  if (!preset) throw new NotFoundError('Preset', data.preset_key);

  return { preset };
}

/**
 * UPSERT a string-instrument config materialised from a tuning preset.
 *
 * @param {Object} app
 * @param {{device_id:string, channel:number, preset:string}} data
 * @returns {Promise<{success:true, id:(string|number)}>}
 * @throws {ValidationError|NotFoundError}
 */
async function stringInstrumentCreateFromPreset(app, data) {
  if (!data.device_id) throw new ValidationError('device_id is required', 'device_id');
  if (data.channel === undefined) throw new ValidationError('channel is required', 'channel');
  if (!data.preset) throw new ValidationError('preset key is required', 'preset');

  const preset = app.stringInstrumentRepository.findTuningPreset(data.preset);
  if (!preset) throw new NotFoundError('Preset', data.preset);

  // Use UPSERT: createStringInstrument already has ON CONFLICT DO UPDATE
  const id = app.stringInstrumentRepository.save({
    device_id: data.device_id,
    channel: data.channel,
    instrument_name: preset.name,
    num_strings: preset.strings,
    num_frets: preset.frets,
    tuning: preset.tuning,
    is_fretless: preset.fretless || false,
    capo_fret: 0
  });
  return { success: true, id };
}

// ==================== TABLATURE DATA ====================

/**
 * @param {Object} app
 * @param {{midi_file_id:(string|number), channel:number,
 *   string_instrument_id:(string|number), tablature_data:Object[]}} data
 * @returns {Promise<{success:true, id:(string|number)}>}
 * @throws {ValidationError}
 */
async function tablatureSave(app, data) {
  if (data.midi_file_id === undefined) throw new ValidationError('midi_file_id is required', 'midi_file_id');
  if (data.string_instrument_id === undefined) throw new ValidationError('string_instrument_id is required', 'string_instrument_id');
  if (!Array.isArray(data.tablature_data)) throw new ValidationError('tablature_data must be an array', 'tablature_data');

  const id = app.stringInstrumentRepository.saveTablature(
    data.midi_file_id,
    data.channel,
    data.string_instrument_id,
    data.tablature_data
  );
  return { success: true, id };
}

/**
 * @param {Object} app
 * @param {{midi_file_id:(string|number), channel:number}} data
 * @returns {Promise<{tablature: ?Object}>}
 * @throws {ValidationError}
 */
async function tablatureGet(app, data) {
  if (data.midi_file_id === undefined) throw new ValidationError('midi_file_id is required', 'midi_file_id');

  const tablature = app.stringInstrumentRepository.findTablature(
    data.midi_file_id, data.channel
  );
  return { tablature };
}

/**
 * @param {Object} app
 * @param {{midi_file_id:(string|number)}} data
 * @returns {Promise<{tablatures:Object[]}>}
 * @throws {ValidationError}
 */
async function tablatureGetByFile(app, data) {
  if (data.midi_file_id === undefined) throw new ValidationError('midi_file_id is required', 'midi_file_id');

  const tablatures = app.stringInstrumentRepository.findTablaturesByFile(data.midi_file_id);
  return { tablatures };
}

/**
 * Delete a single (file, channel) tablature row, or every row for the
 * file when `channel` is omitted.
 *
 * @param {Object} app
 * @param {{midi_file_id:(string|number), channel?:number}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function tablatureDelete(app, data) {
  if (data.midi_file_id === undefined) throw new ValidationError('midi_file_id is required', 'midi_file_id');

  if (data.channel !== undefined) {
    app.stringInstrumentRepository.deleteTablature(data.midi_file_id, data.channel);
  } else {
    app.stringInstrumentRepository.deleteTablaturesByFile(data.midi_file_id);
  }
  return { success: true };
}

// ==================== CONVERSION ====================

/**
 * Run the {@link TablatureConverter} on a list of MIDI notes, returning
 * the inferred tablature events plus the playable note range for the
 * supplied or referenced instrument config.
 *
 * @param {Object} app
 * @param {{notes:Object[], instrument_config?:Object,
 *   string_instrument_id?:(string|number)}} data
 * @returns {Promise<{tablature:Object[], playable_range:Object}>}
 * @throws {ValidationError|NotFoundError}
 */
async function tablatureConvertFromMidi(app, data) {
  if (!data.notes || !Array.isArray(data.notes)) throw new ValidationError('notes array is required', 'notes');
  if (!data.instrument_config && !data.string_instrument_id) {
    throw new ValidationError('instrument_config or string_instrument_id is required', 'instrument_config');
  }

  let config = data.instrument_config;
  if (!config && data.string_instrument_id) {
    config = app.stringInstrumentRepository.findById(data.string_instrument_id);
    if (!config) throw new NotFoundError('StringInstrument', data.string_instrument_id);
  }

  const converter = new TablatureConverter(config);
  const tabEvents = converter.convertMidiToTablature(data.notes);
  const range = converter.getPlayableRange();

  return { tablature: tabEvents, playable_range: range };
}

/**
 * Reverse direction: convert tablature events back into MIDI notes
 * (and matching CC events for fret/string when configured).
 *
 * @param {Object} app
 * @param {{tab_events:Object[], instrument_config?:Object,
 *   string_instrument_id?:(string|number)}} data
 * @returns {Promise<{notes:Object[], cc_events:Object[]}>}
 * @throws {ValidationError|NotFoundError}
 */
async function tablatureConvertToMidi(app, data) {
  if (!data.tab_events || !Array.isArray(data.tab_events)) throw new ValidationError('tab_events array is required', 'tab_events');
  if (!data.instrument_config && !data.string_instrument_id) {
    throw new ValidationError('instrument_config or string_instrument_id is required', 'instrument_config');
  }

  let config = data.instrument_config;
  if (!config && data.string_instrument_id) {
    config = app.stringInstrumentRepository.findById(data.string_instrument_id);
    if (!config) throw new NotFoundError('StringInstrument', data.string_instrument_id);
  }

  const converter = new TablatureConverter(config);
  const { notes, ccEvents } = converter.convertTablatureToMidi(data.tab_events);

  return { notes, cc_events: ccEvents };
}

// ==================== REGISTER ====================

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  // String instrument configuration
  registry.register('string_instrument_create', (data) => stringInstrumentCreate(app, data));
  registry.register('string_instrument_update', (data) => stringInstrumentUpdate(app, data));
  registry.register('string_instrument_delete', (data) => stringInstrumentDelete(app, data));
  registry.register('string_instrument_get', (data) => stringInstrumentGet(app, data));
  registry.register('string_instrument_list', (data) => stringInstrumentList(app, data));

  // Tuning presets
  registry.register('string_instrument_get_presets', () => stringInstrumentGetPresets(app));
  registry.register('string_instrument_apply_preset', (data) => stringInstrumentApplyPreset(app, data));
  registry.register('string_instrument_create_from_preset', (data) => stringInstrumentCreateFromPreset(app, data));

  // Tablature data
  registry.register('tablature_save', (data) => tablatureSave(app, data));
  registry.register('tablature_get', (data) => tablatureGet(app, data));
  registry.register('tablature_get_by_file', (data) => tablatureGetByFile(app, data));
  registry.register('tablature_delete', (data) => tablatureDelete(app, data));

  // Conversion (MIDI ↔ Tablature)
  registry.register('tablature_convert_from_midi', (data) => tablatureConvertFromMidi(app, data));
  registry.register('tablature_convert_to_midi', (data) => tablatureConvertToMidi(app, data));
}
