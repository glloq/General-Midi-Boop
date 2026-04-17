// src/repositories/DeviceSettingsRepository.js
// Repository wrapper over device-settings CRUD via Database facade (ADR-002 option B).

export default class DeviceSettingsRepository {
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
