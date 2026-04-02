// src/api/commands/PresetCommands.js
import { NotFoundError } from '../../core/errors/index.js';

async function presetSave(app, data) {
  const presetId = app.database.insertPreset({
    name: data.name,
    description: data.description,
    type: data.type || 'routing',
    data: JSON.stringify(data.data)
  });
  return { presetId: presetId };
}

async function presetLoad(app, data) {
  const preset = app.database.getPreset(data.presetId);
  if (!preset) {
    throw new NotFoundError('Preset', data.presetId);
  }
  return { preset: preset };
}

async function presetList(app, data) {
  const presets = app.database.getPresets(data.type);
  return { presets: presets };
}

async function presetDelete(app, data) {
  app.database.deletePreset(data.presetId);
  return { success: true };
}

async function presetRename(app, data) {
  app.database.updatePreset(data.presetId, {
    name: data.newName
  });
  return { success: true };
}

async function presetExport(app, data) {
  const preset = app.database.getPreset(data.presetId);
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
