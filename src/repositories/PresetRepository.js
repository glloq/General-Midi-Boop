// src/repositories/PresetRepository.js
// Repository wrapper over preset CRUD via Database facade (ADR-002 option B).

export default class PresetRepository {
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
