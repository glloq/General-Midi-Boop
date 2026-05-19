/**
 * @file src/api/commands/InstrumentLightCommands.js
 * @description WebSocket commands for the embedded-instrument lighting
 * subsystem (LEDs on the instrument, driven by its own microcontroller).
 * Persistence + runtime live in {@link InstrumentLightManager}.
 *
 * Registered commands:
 *   - instrument_light_list                — every lit instrument
 *   - instrument_light_get                 — caps + config for one
 *   - instrument_light_set_capabilities    — manual capability entry
 *   - instrument_light_set_config          — control config
 *   - instrument_light_request_sysex       — trigger Block 8 auto-detect
 *   - instrument_light_test                — flash the LEDs
 *   - instrument_light_all_off             — blackout one instrument
 *
 * Validation: imperative inside each handler.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';
import { requireField } from '../../utils/ValidationUtils.js';

function requireManager(app) {
  if (!app.instrumentLightManager) {
    throw new ConfigurationError('Instrument lighting manager not available');
  }
  return app.instrumentLightManager;
}

function resolveTarget(data) {
  const deviceId = requireField(data, 'deviceId');
  const channel = Number.isInteger(data.channel) ? data.channel : 0;
  if (channel < 0 || channel > 15) {
    throw new ValidationError('channel must be 0-15', 'channel');
  }
  return { deviceId, channel };
}

function instrumentLightList(app) {
  return { success: true, instruments: requireManager(app).listLitInstruments() };
}

function instrumentLightGet(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  return { success: true, instrument: requireManager(app).getInstrument(deviceId, channel) };
}

function instrumentLightSetCapabilities(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  const capabilities = data.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    throw new ValidationError('capabilities object is required', 'capabilities');
  }
  return {
    success: true,
    instrument: requireManager(app).setCapabilities(deviceId, channel, capabilities)
  };
}

function instrumentLightSetConfig(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  const config = data.config;
  if (!config || typeof config !== 'object') {
    throw new ValidationError('config object is required', 'config');
  }
  return {
    success: true,
    instrument: requireManager(app).setConfig(deviceId, channel, config)
  };
}

function instrumentLightRequestSysex(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  requireManager(app).requestSysexCapabilities(deviceId, channel);
  return { success: true };
}

function instrumentLightTest(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  return { success: requireManager(app).test(deviceId, channel) };
}

function instrumentLightAllOff(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  return { success: requireManager(app).allOff(deviceId, channel) };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('instrument_light_list', () => instrumentLightList(app));
  registry.register('instrument_light_get', (data) => instrumentLightGet(app, data));
  registry.register('instrument_light_set_capabilities', (data) => instrumentLightSetCapabilities(app, data));
  registry.register('instrument_light_set_config', (data) => instrumentLightSetConfig(app, data));
  registry.register('instrument_light_request_sysex', (data) => instrumentLightRequestSysex(app, data));
  registry.register('instrument_light_test', (data) => instrumentLightTest(app, data));
  registry.register('instrument_light_all_off', (data) => instrumentLightAllOff(app, data));
}
