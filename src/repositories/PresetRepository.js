/**
 * @file src/repositories/PresetRepository.js
 * @description Thin business-named wrapper over preset CRUD on
 * {@link Database} (ADR-002 option B). Presets are typed JSON
 * snapshots (routing, lighting, instrument settings) — the `data`
 * field is stored as-is and returned verbatim by `findById` /
 * `findByType`.
 */

export default class PresetRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  save(preset) {
    return this.database.insertPreset(preset);
  }

  findById(presetId) {
    return this.database.getPreset(presetId);
  }

  findByType(type) {
    return this.database.getPresets(type);
  }

  delete(presetId) {
    return this.database.deletePreset(presetId);
  }

  update(presetId, fields) {
    return this.database.updatePreset(presetId, fields);
  }
}
