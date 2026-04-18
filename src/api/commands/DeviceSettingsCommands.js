/**
 * @file src/api/commands/DeviceSettingsCommands.js
 * @description WebSocket commands managing per-device persisted settings
 * (custom display name, MIDI Clock enable, outbound rate limit).
 *
 * Registered commands:
 *   - `device_get_settings`     — read settings for one device
 *   - `device_update_settings`  — write subset; emits
 *     `device_settings_changed` on the EventBus so caches refresh
 *
 * Validation: imperative inside each handler.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

/**
 * Read persisted settings for a device. Returns a stub record when no
 * row exists yet so the UI can render defaults without special-casing.
 *
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {{success:true, settings:Object}}
 * @throws {ConfigurationError|ValidationError}
 */
function deviceGetSettings(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required');
  }

  const settings = app.deviceSettingsRepository.findByDeviceId(data.deviceId);
  return {
    success: true,
    settings: settings || { id: data.deviceId, custom_name: null, midi_clock_enabled: 0, message_rate_limit: 0 }
  };
}

/**
 * Upsert per-device settings. Coerces `midi_clock_enabled` to boolean
 * and validates `message_rate_limit` as a non-negative integer.
 * Emits `device_settings_changed` so the DeviceManager / Router can
 * refresh any cached configuration.
 *
 * @param {Object} app
 * @param {{
 *   deviceId:string,
 *   deviceName?:string,
 *   custom_name?:string,
 *   midi_clock_enabled?:boolean|number,
 *   message_rate_limit?:number|string
 * }} data
 * @returns {{success:true}}
 * @throws {ConfigurationError|ValidationError}
 */
function deviceUpdateSettings(app, data) {
  if (!app.database) {
    throw new ConfigurationError('Database not available');
  }
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required');
  }

  // Ensure the device row exists before updating
  app.deviceSettingsRepository.ensureDevice(data.deviceId, data.deviceName || data.deviceId, 'output');

  // Validate fields
  if (data.midi_clock_enabled !== undefined) {
    data.midi_clock_enabled = !!data.midi_clock_enabled;
  }
  if (data.message_rate_limit !== undefined) {
    const limit = parseInt(data.message_rate_limit);
    if (isNaN(limit) || limit < 0) {
      throw new ValidationError('message_rate_limit must be a non-negative integer');
    }
    data.message_rate_limit = limit;
  }

  app.deviceSettingsRepository.update(data.deviceId, {
    custom_name: data.custom_name,
    midi_clock_enabled: data.midi_clock_enabled,
    message_rate_limit: data.message_rate_limit
  });

  // Notify systems to refresh caches
  app.eventBus?.emit('device_settings_changed', {
    deviceId: data.deviceId
  });

  return { success: true };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('device_get_settings', (data) => deviceGetSettings(app, data));
  registry.register('device_update_settings', (data) => deviceUpdateSettings(app, data));
}
