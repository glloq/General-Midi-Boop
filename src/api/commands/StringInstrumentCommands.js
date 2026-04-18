// src/api/commands/StringInstrumentCommands.js

import TablatureConverter from '../../midi/TablatureConverter.js';
import { ValidationError, NotFoundError } from '../../core/errors/index.js';

/**
 * WebSocket commands for string instrument configuration and tablature management.
 * Handles CRUD for string instruments, tuning presets, and tablature data.
 */

// ==================== STRING INSTRUMENT CONFIG ====================

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

async function stringInstrumentGetPresets(app) {
  const presets = app.stringInstrumentRepository.findAllTuningPresets();
  return { presets };
}

async function stringInstrumentApplyPreset(app, data) {
  if (!data.preset_key) throw new ValidationError('preset_key is required', 'preset_key');

  const preset = app.stringInstrumentRepository.findTuningPreset(data.preset_key);
  if (!preset) throw new NotFoundError('Preset', data.preset_key);

  return { preset };
}

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

async function tablatureGet(app, data) {
  if (data.midi_file_id === undefined) throw new ValidationError('midi_file_id is required', 'midi_file_id');

  const tablature = app.stringInstrumentRepository.findTablature(
    data.midi_file_id, data.channel
  );
  return { tablature };
}

async function tablatureGetByFile(app, data) {
  if (data.midi_file_id === undefined) throw new ValidationError('midi_file_id is required', 'midi_file_id');

  const tablatures = app.stringInstrumentRepository.findTablaturesByFile(data.midi_file_id);
  return { tablatures };
}

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
