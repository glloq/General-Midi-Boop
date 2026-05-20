/**
 * @file src/api/commands/InstrumentLightCommands.js
 * @description WebSocket commands for the CC-based instrument lighting
 * subsystem. Persistence + runtime live in {@link InstrumentLightManager}.
 *
 * Registered commands:
 *   - instrument_light_get            — current 5-CC state for one instrument
 *   - instrument_light_set            — patch the CC values (supported_mask is ignored)
 *   - instrument_light_set_supported  — edit the supported-CC catalogue (instrument settings only)
 *   - instrument_light_list           — every persisted state
 *   - instrument_light_test           — briefly flash the LEDs
 *   - instrument_light_all_off        — send CC 110 = 0
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

function instrumentLightGet(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  return { success: true, state: requireManager(app).getState(deviceId, channel) };
}

function instrumentLightSet(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  const patch = data.state;
  if (!patch || typeof patch !== 'object') {
    throw new ValidationError('state object is required', 'state');
  }
  return {
    success: true,
    state: requireManager(app).setState(deviceId, channel, patch)
  };
}

function instrumentLightSetSupported(app, data) {
  const { deviceId, channel } = resolveTarget(data);
  if (!Number.isInteger(data.supported_mask)) {
    throw new ValidationError('supported_mask must be an integer 0-31', 'supported_mask');
  }
  if (data.supported_mask < 0 || data.supported_mask > 31) {
    throw new ValidationError('supported_mask must be 0-31', 'supported_mask');
  }
  return {
    success: true,
    state: requireManager(app).setSupported(deviceId, channel, data.supported_mask)
  };
}

function instrumentLightList(app) {
  return { success: true, instruments: requireManager(app).listStates() };
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
  registry.register('instrument_light_get', (data) => instrumentLightGet(app, data));
  registry.register('instrument_light_set', (data) => instrumentLightSet(app, data));
  registry.register('instrument_light_set_supported', (data) => instrumentLightSetSupported(app, data));
  registry.register('instrument_light_list', () => instrumentLightList(app));
  registry.register('instrument_light_test', (data) => instrumentLightTest(app, data));
  registry.register('instrument_light_all_off', (data) => instrumentLightAllOff(app, data));
}
