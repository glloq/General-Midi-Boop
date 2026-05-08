/**
 * @file src/api/commands/LoopCommands.js
 * @description WebSocket commands for Loop Creator CRUD.
 *
 * Registered commands:
 *   - loop_create   — create a new loop (returns loopId)
 *   - loop_list     — list all loops (without midi_data for bandwidth)
 *   - loop_get      — fetch one loop including midi_data
 *   - loop_update   — update any mutable field (name, tempo, bars, midi_data…)
 *   - loop_delete   — delete a loop by id
 */

import { ValidationError, NotFoundError } from '../../core/errors/index.js';

async function loopCreate(app, data) {
  if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
    throw new ValidationError('name is required', 'name');
  }
  const loopId = app.loopRepository.save({
    name: data.name.trim(),
    tempo: data.tempo,
    time_sig_num: data.time_sig_num,
    time_sig_den: data.time_sig_den,
    bars: data.bars,
    ppq: data.ppq,
    instrument_program: data.instrument_program ?? null,
    midi_data: data.midi_data ?? []
  });
  return { loopId };
}

async function loopList(app) {
  const loops = app.loopRepository.findAll();
  return { loops };
}

async function loopGet(app, data) {
  if (!data.loopId) {
    throw new ValidationError('loopId is required', 'loopId');
  }
  const loop = app.loopRepository.findById(data.loopId);
  if (!loop) {
    throw new NotFoundError('Loop', data.loopId);
  }
  return { loop };
}

async function loopUpdate(app, data) {
  if (!data.loopId) {
    throw new ValidationError('loopId is required', 'loopId');
  }
  const loop = app.loopRepository.findById(data.loopId);
  if (!loop) {
    throw new NotFoundError('Loop', data.loopId);
  }

  const fields = {};
  const allowed = ['name', 'tempo', 'time_sig_num', 'time_sig_den', 'bars', 'ppq', 'instrument_program', 'midi_data'];
  for (const key of allowed) {
    if (key in data) fields[key] = data[key];
  }

  if (fields.name !== undefined) {
    fields.name = String(fields.name).trim();
    if (!fields.name) throw new ValidationError('name cannot be empty', 'name');
  }

  app.loopRepository.update(data.loopId, fields);
  return { success: true };
}

async function loopDelete(app, data) {
  if (!data.loopId) {
    throw new ValidationError('loopId is required', 'loopId');
  }
  app.loopRepository.delete(data.loopId);
  return { success: true };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 */
export function register(registry, app) {
  registry.register('loop_create', (data) => loopCreate(app, data));
  registry.register('loop_list', () => loopList(app));
  registry.register('loop_get', (data) => loopGet(app, data));
  registry.register('loop_update', (data) => loopUpdate(app, data));
  registry.register('loop_delete', (data) => loopDelete(app, data));
}
