// src/api/commands/PresetCommands.js
import { NotFoundError } from '../../core/errors/index.js';

async function presetSave(app, data) {
  const presetId = app.presetRepository.save({
    name: data.name,
    description: data.description,
    type: data.type || 'routing',
    data: JSON.stringify(data.data)
  });
  return { presetId: presetId };
}

async function presetLoad(app, data) {
  const preset = app.presetRepository.findById(data.presetId);
  if (!preset) {
    throw new NotFoundError('Preset', data.presetId);
  }
  return { preset: preset };
}

async function presetList(app, data) {
  const presets = app.presetRepository.findByType(data.type);
  return { presets: presets };
}

async function presetDelete(app, data) {
  app.presetRepository.delete(data.presetId);
  return { success: true };
}

async function presetRename(app, data) {
  app.presetRepository.update(data.presetId, {
    name: data.newName
  });
  return { success: true };
}

async function presetExport(app, data) {
  const preset = app.presetRepository.findById(data.presetId);
  if (!preset) {
    throw new NotFoundError('Preset', data.presetId);
  }
  return { preset: preset };
}

export function register(registry, app) {
  registry.register('preset_save', (data) => presetSave(app, data));
  registry.register('preset_load', (data) => presetLoad(app, data));
  registry.register('preset_list', (data) => presetList(app, data));
  registry.register('preset_delete', (data) => presetDelete(app, data));
  registry.register('preset_rename', (data) => presetRename(app, data));
  registry.register('preset_export', (data) => presetExport(app, data));
}
