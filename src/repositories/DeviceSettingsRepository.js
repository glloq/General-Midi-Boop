/**
 * @file src/repositories/DeviceSettingsRepository.js
 * @description Thin business-named wrapper over the per-device settings
 * methods on {@link Database}/{@link DeviceSettingsDB}
 * (ADR-002 option B). Surface is intentionally tiny — one row per
 * device, no joins.
 */

export default class DeviceSettingsRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  findByDeviceId(deviceId) {
    return this.database.getDeviceSettings(deviceId);
  }

  ensureDevice(deviceId, deviceName, type) {
    return this.database.ensureDevice(deviceId, deviceName, type);
  }

  update(deviceId, fields) {
    return this.database.updateDeviceSettings(deviceId, fields);
  }
}
