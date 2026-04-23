/**
 * @file src/api/commands/InstrumentVoiceCommands.js
 * @description WebSocket commands for the secondary GM voices attached
 * to an instrument (device_id + channel). The primary voice lives on
 * `instruments_latency.gm_program` and is handled by
 * {@link InstrumentSettingsCommands}; this module handles only the
 * additional alternatives stored in `instrument_voices`.
 *
 * Registered commands:
 *   - `instrument_voice_list`    — list secondary voices for (deviceId, channel)
 *   - `instrument_voice_create`  — add one voice
 *   - `instrument_voice_update`  — patch a voice by id
 *   - `instrument_voice_delete`  — remove a voice by id
 *   - `instrument_voice_replace` — atomic bulk replace for (deviceId, channel)
 *
 * Playback semantics: voices are ALTERNATIVES. The playback engine picks
 * one per note based on context (see roadmap Phase 8).
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

function _validateIdentity(data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  if (data.channel === undefined || data.channel === null) {
    throw new ValidationError('channel is required', 'channel');
  }
  const channel = parseInt(data.channel, 10);
  if (!Number.isFinite(channel) || channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }
  return { deviceId: data.deviceId, channel };
}

function _validateVoicePayload(v) {
  const payload = {};
  if (v.gm_program !== undefined && v.gm_program !== null) {
    const p = parseInt(v.gm_program, 10);
    if (!Number.isFinite(p) || p < 0 || p > 255) {
      // allow encoded drum-kit values (128+program) up to 255
      throw new ValidationError('gm_program must be between 0 and 255', 'gm_program');
    }
    payload.gm_program = p;
  } else {
    payload.gm_program = null;
  }
  const num = (val, key, min, max) => {
    if (val === undefined || val === null || val === '') return null;
    const n = parseInt(val, 10);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new ValidationError(`${key} must be between ${min} and ${max}`, key);
    }
    return n;
  };
  payload.min_note_interval = num(v.min_note_interval, 'min_note_interval', 0, 5000);
  payload.min_note_duration = num(v.min_note_duration, 'min_note_duration', 0, 5000);
  if (Array.isArray(v.supported_ccs)) {
    payload.supported_ccs = v.supported_ccs
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
  } else if (typeof v.supported_ccs === 'string') {
    payload.supported_ccs = v.supported_ccs
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
  } else {
    payload.supported_ccs = null;
  }
  if (v.display_order !== undefined) {
    const o = parseInt(v.display_order, 10);
    if (Number.isFinite(o)) payload.display_order = o;
  }
  return payload;
}

async function instrumentVoiceList(app, data) {
  if (!app.instrumentRepository) throw new ConfigurationError('Repository unavailable');
  const { deviceId, channel } = _validateIdentity(data);
  const voices = app.instrumentRepository.listVoices(deviceId, channel);
  return { success: true, voices };
}

async function instrumentVoiceCreate(app, data) {
  if (!app.instrumentRepository) throw new ConfigurationError('Repository unavailable');
  const { deviceId, channel } = _validateIdentity(data);
  const payload = _validateVoicePayload(data);
  const id = app.instrumentRepository.createVoice(deviceId, channel, payload);
  return { success: true, id };
}

async function instrumentVoiceUpdate(app, data) {
  if (!app.instrumentRepository) throw new ConfigurationError('Repository unavailable');
  if (data.id === undefined || data.id === null) {
    throw new ValidationError('id is required', 'id');
  }
  const id = parseInt(data.id, 10);
  if (!Number.isFinite(id)) throw new ValidationError('id must be numeric', 'id');
  const payload = _validateVoicePayload(data);
  app.instrumentRepository.updateVoice(id, payload);
  return { success: true };
}

async function instrumentVoiceDelete(app, data) {
  if (!app.instrumentRepository) throw new ConfigurationError('Repository unavailable');
  if (data.id === undefined || data.id === null) {
    throw new ValidationError('id is required', 'id');
  }
  const id = parseInt(data.id, 10);
  if (!Number.isFinite(id)) throw new ValidationError('id must be numeric', 'id');
  const changes = app.instrumentRepository.deleteVoice(id);
  return { success: true, deleted: changes };
}

async function instrumentVoiceReplace(app, data) {
  if (!app.instrumentRepository) throw new ConfigurationError('Repository unavailable');
  const { deviceId, channel } = _validateIdentity(data);
  const list = Array.isArray(data.voices) ? data.voices : [];
  const normalized = list.map((v) => _validateVoicePayload(v));
  const ids = app.instrumentRepository.replaceVoices(deviceId, channel, normalized);
  return { success: true, ids };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('instrument_voice_list', (d) => instrumentVoiceList(app, d));
  registry.register('instrument_voice_create', (d) => instrumentVoiceCreate(app, d));
  registry.register('instrument_voice_update', (d) => instrumentVoiceUpdate(app, d));
  registry.register('instrument_voice_delete', (d) => instrumentVoiceDelete(app, d));
  registry.register('instrument_voice_replace', (d) => instrumentVoiceReplace(app, d));
}
