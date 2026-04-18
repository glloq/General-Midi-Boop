/**
 * @file src/repositories/LightingRepository.js
 * @description Thin business-named wrapper over lighting CRUD on
 * {@link Database}/{@link LightingDatabase} (ADR-002 option B). Three
 * concept families: devices, rules (condition→action), presets
 * (snapshot of the rule set).
 */

export default class LightingRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  // Devices
  findAllDevices() {
    return this.database.getLightingDevices();
  }

  findDeviceById(id) {
    return this.database.getLightingDevice(id);
  }

  saveDevice(device) {
    return this.database.insertLightingDevice(device);
  }

  updateDevice(id, fields) {
    return this.database.updateLightingDevice(id, fields);
  }

  deleteDevice(id) {
    return this.database.deleteLightingDevice(id);
  }

  // Rules
  findAllRules() {
    return this.database.getAllLightingRules();
  }

  findRulesByDevice(deviceId) {
    return this.database.getLightingRulesForDevice(deviceId);
  }

  saveRule(rule) {
    return this.database.insertLightingRule(rule);
  }

  updateRule(id, fields) {
    return this.database.updateLightingRule(id, fields);
  }

  deleteRule(id) {
    return this.database.deleteLightingRule(id);
  }

  // Presets
  findAllPresets() {
    return this.database.getLightingPresets();
  }

  savePreset(preset) {
    return this.database.insertLightingPreset(preset);
  }

  deletePreset(id) {
    return this.database.deleteLightingPreset(id);
  }
}
