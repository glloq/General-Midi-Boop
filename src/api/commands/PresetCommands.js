/**
 * @file src/api/commands/PresetCommands.js
 * @description WebSocket commands managing reusable configuration
 * presets (routing snapshots, instrument settings, etc). The preset
 * `data` field is opaque JSON serialised at save time and returned
 * verbatim by `_load`/`_export`.
 *
 * Registered commands:
 *   - `preset_save` / `_load` / `_list` / `_delete` / `_rename` / `_export`
 */
import { NotFoundError } from '../../core/errors/index.js';

/**
 * @param {Object} app
 * @param {{name:string, description?:string, type?:string, data:Object}} data -
 *   `type` defaults to `"routing"`.
 * @returns {Promise<{presetId:(string|number)}>}
 */
async function presetSave(app, data) {
  const presetId = app.presetRepository.save({
    name: data.name,
    description: data.description,
    type: data.type || 'routing',
    data: JSON.stringify(data.data)
  });
  return { presetId: presetId };
}

/**
 * @param {Object} app
 * @param {{presetId:(string|number)}} data
 * @returns {Promise<{preset:Object}>}
 * @throws {NotFoundError}
 */
async function presetLoad(app, data) {
  const preset = app.presetRepository.findById(data.presetId);
  if (!preset) {
    throw new NotFoundError('Preset', data.presetId);
  }
  return { preset: preset };
}

/**
 * @param {Object} app
 * @param {{type:string}} data
 * @returns {Promise<{presets:Object[]}>}
 */
async function presetList(app, data) {
  const presets = app.presetRepository.findByType(data.type);
  return { presets: presets };
}

/**
 * @param {Object} app
 * @param {{presetId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 */
async function presetDelete(app, data) {
  app.presetRepository.delete(data.presetId);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{presetId:(string|number), newName:string}} data
 * @returns {Promise<{success:true}>}
 */
async function presetRename(app, data) {
  app.presetRepository.update(data.presetId, {
    name: data.newName
  });
  return { success: true };
}

/**
 * Identical payload to {@link presetLoad}; named distinctly so the
 * frontend can distinguish "load into UI" from "download as file".
 *
 * @param {Object} app
 * @param {{presetId:(string|number)}} data
 * @returns {Promise<{preset:Object}>}
 * @throws {NotFoundError}
 */
async function presetExport(app, data) {
  const preset = app.presetRepository.findById(data.presetId);
  if (!preset) {
    throw new NotFoundError('Preset', data.presetId);
  }
  return { preset: preset };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('preset_save', (data) => presetSave(app, data));
  registry.register('preset_load', (data) => presetLoad(app, data));
  registry.register('preset_list', (data) => presetList(app, data));
  registry.register('preset_delete', (data) => presetDelete(app, data));
  registry.register('preset_rename', (data) => presetRename(app, data));
  registry.register('preset_export', (data) => presetExport(app, data));
}
