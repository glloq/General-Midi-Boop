// src/api/commands/StringInstrumentCommands.js

import TablatureConverter from '../../midi/TablatureConverter.js';

/**
 * WebSocket commands for string instrument configuration and tablature management.
 * Handles CRUD for string instruments, tuning presets, and tablature data.
 */

// ==================== STRING INSTRUMENT CONFIG ====================

async function stringInstrumentCreate(app, data) {
  const id = app.database.stringInstrumentDB.createStringInstrument({
    device_id: data.device_id,
    channel: data.channel,
    instrument_name: data.instrument_name,
    num_strings: data.num_strings,
    num_frets: data.num_frets,
    tuning: data.tuning,
    is_fretless: data.is_fretless,
    capo_fret: data.capo_fret,
    cc_enabled: data.cc_enabled,
    tab_algorithm: data.tab_algorithm
  });
  return { success: true, id };
}

async function stringInstrumentUpdate(app, data) {
  if (!data.id) throw new Error('id is required');

  const updated = app.database.stringInstrumentDB.updateStringInstrument(data.id, {
    instrument_name: data.instrument_name,
    num_strings: data.num_strings,
    num_frets: data.num_frets,
    tuning: data.tuning,
    is_fretless: data.is_fretless,
    capo_fret: data.capo_fret,
    cc_enabled: data.cc_enabled,
    tab_algorithm: data.tab_algorithm
  });
  return { success: updated };
}

async function stringInstrumentDelete(app, data) {
  if (data.id) {
    app.database.stringInstrumentDB.deleteStringInstrument(data.id);
  } else if (data.device_id !== undefined) {
    app.database.stringInstrumentDB.deleteStringInstrumentByDeviceChannel(
      data.device_id, data.channel
    );
  } else {
    throw new Error('id or device_id is required');
  }
  return { success: true };
}

async function stringInstrumentGet(app, data) {
  let instrument;
  if (data.id) {
    instrument = app.database.stringInstrumentDB.getStringInstrumentById(data.id);
  } else if (data.device_id !== undefined) {
    instrument = app.database.stringInstrumentDB.getStringInstrument(data.device_id, data.channel);
  } else {
    throw new Error('id or device_id is required');
  }
  return { instrument };
}

async function stringInstrumentList(app, data) {
  let instruments;
  if (data.device_id) {
    instruments = app.database.stringInstrumentDB.getStringInstrumentsByDevice(data.device_id);
  } else {
    instruments = app.database.stringInstrumentDB.getAllStringInstruments();
  }
  return { instruments };
}

// ==================== TUNING PRESETS ====================

async function stringInstrumentGetPresets(app) {
  const presets = app.database.stringInstrumentDB.getTuningPresets();
  return { presets };
}

async function stringInstrumentApplyPreset(app, data) {
  if (!data.preset_key) throw new Error('preset_key is required');

  const preset = app.database.stringInstrumentDB.getTuningPreset(data.preset_key);
  if (!preset) throw new Error(`Unknown preset: ${data.preset_key}`);

  return { preset };
}

async function stringInstrumentCreateFromPreset(app, data) {
  if (!data.device_id) throw new Error('device_id is required');
  if (data.channel === undefined) throw new Error('channel is required');
  if (!data.preset) throw new Error('preset key is required');

  const preset = app.database.stringInstrumentDB.getTuningPreset(data.preset);
  if (!preset) throw new Error(`Unknown preset: ${data.preset}`);

  // Use UPSERT: createStringInstrument already has ON CONFLICT DO UPDATE
  const id = app.database.stringInstrumentDB.createStringInstrument({
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
  if (data.midi_file_id === undefined) throw new Error('midi_file_id is required');
  if (data.string_instrument_id === undefined) throw new Error('string_instrument_id is required');
  if (!Array.isArray(data.tablature_data)) throw new Error('tablature_data must be an array');

  const id = app.database.stringInstrumentDB.saveTablature(
    data.midi_file_id,
    data.channel,
    data.string_instrument_id,
    data.tablature_data
  );
  return { success: true, id };
}

async function tablatureGet(app, data) {
  if (data.midi_file_id === undefined) throw new Error('midi_file_id is required');

  const tablature = app.database.stringInstrumentDB.getTablature(
    data.midi_file_id, data.channel
  );
  return { tablature };
}

async function tablatureGetByFile(app, data) {
  if (data.midi_file_id === undefined) throw new Error('midi_file_id is required');

  const tablatures = app.database.stringInstrumentDB.getTablaturesByFile(data.midi_file_id);
  return { tablatures };
}

async function tablatureDelete(app, data) {
  if (data.midi_file_id === undefined) throw new Error('midi_file_id is required');

  if (data.channel !== undefined) {
    app.database.stringInstrumentDB.deleteTablature(data.midi_file_id, data.channel);
  } else {
    app.database.stringInstrumentDB.deleteTablaturesByFile(data.midi_file_id);
  }
  return { success: true };
}

// ==================== CONVERSION ====================

async function tablatureConvertFromMidi(app, data) {
  if (!data.notes || !Array.isArray(data.notes)) throw new Error('notes array is required');
  if (!data.instrument_config && !data.string_instrument_id) {
    throw new Error('instrument_config or string_instrument_id is required');
  }

  let config = data.instrument_config;
  if (!config && data.string_instrument_id) {
    config = app.database.stringInstrumentDB.getStringInstrumentById(data.string_instrument_id);
    if (!config) throw new Error(`String instrument ${data.string_instrument_id} not found`);
  }

  const converter = new TablatureConverter(config);
  const tabEvents = converter.convertMidiToTablature(data.notes);
  const range = converter.getPlayableRange();

  return { tablature: tabEvents, playable_range: range };
}

async function tablatureConvertToMidi(app, data) {
  if (!data.tab_events || !Array.isArray(data.tab_events)) throw new Error('tab_events array is required');
  if (!data.instrument_config && !data.string_instrument_id) {
    throw new Error('instrument_config or string_instrument_id is required');
  }

  let config = data.instrument_config;
  if (!config && data.string_instrument_id) {
    config = app.database.stringInstrumentDB.getStringInstrumentById(data.string_instrument_id);
    if (!config) throw new Error(`String instrument ${data.string_instrument_id} not found`);
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
