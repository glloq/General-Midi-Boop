/**
 * @file src/api/commands/schemas/preset.schemas.js
 * @description Declarative validation schemas for `preset_*` WebSocket
 * commands (PR 3, ROADMAP_DI_2026-05-21).
 *
 * Presets are reusable configuration snapshots (routing, instrument
 * settings, …). `data` is stored opaquely as JSON, so we only require
 * that — when present — it be a plain object.
 * See `src/api/commands/PresetCommands.js`.
 */

const requirePresetId = {
  fields: {
    presetId: { type: 'id', required: true }
  }
};

export const preset_load = requirePresetId;
export const preset_delete = requirePresetId;
// preset_export aliases preset_load on the handler side; same schema.
export const preset_export = requirePresetId;

export const preset_save = {
  fields: {
    name: { type: 'string', required: true, minLength: 1 },
    description: { type: 'string' },
    type: { type: 'string', minLength: 1 },
    data: { type: 'object', required: true }
  }
};

export const preset_list = {
  fields: {
    type: { type: 'string', required: true, minLength: 1 }
  }
};

export const preset_rename = {
  fields: {
    presetId: { type: 'id', required: true },
    newName: { type: 'string', required: true, minLength: 1 }
  }
};

const schemas = {
  preset_save,
  preset_load,
  preset_list,
  preset_delete,
  preset_rename,
  preset_export
};

export default schemas;
