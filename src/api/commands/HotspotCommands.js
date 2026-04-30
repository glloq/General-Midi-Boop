/**
 * @file src/api/commands/HotspotCommands.js
 * @description WebSocket commands controlling the Raspberry Pi WiFi
 * hotspot (AP) mode.
 *
 * Registered commands:
 *   - `hotspot_get_config`     — read persisted SSID/band/channel
 *                                (password is masked, never returned).
 *   - `hotspot_update_config`  — patch any subset of fields.
 *   - `hotspot_status`         — current state via nmcli.
 *   - `hotspot_enable`         — apply persisted config and switch the
 *                                Pi from WiFi-client to AP mode. The
 *                                client browser will lose connectivity
 *                                if it was on the same WiFi.
 *   - `hotspot_disable`        — stop the AP and let WiFi reconnect.
 *
 * Validation lives in `schemas/hotspot.schemas.js`.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

const PASSWORD_PLACEHOLDER = '__unchanged__';

/**
 * @param {Object} app
 * @returns {void}
 * @throws {ConfigurationError}
 */
function _requireDeps(app) {
  if (!app.hotspotManager) {
    throw new ConfigurationError('Hotspot manager not available');
  }
  if (!app.hotspotConfigRepository) {
    throw new ConfigurationError('Hotspot config repository not available');
  }
}

/**
 * Strip the password before sending the config to the client. The UI
 * never sees the stored PSK; on edit it leaves the field blank to keep
 * the existing value or types a new one.
 *
 * @param {Object} cfg
 * @returns {{ssid:string, band:string, channel:number, hasPassword:boolean}}
 * @private
 */
function _publicConfig(cfg) {
  return {
    ssid: cfg.ssid || '',
    band: cfg.band || 'bg',
    channel: cfg.channel || 0,
    hasPassword: Boolean(cfg.password)
  };
}

async function hotspotGetConfig(app) {
  _requireDeps(app);
  const cfg = app.hotspotConfigRepository.get();
  return { success: true, config: _publicConfig(cfg) };
}

async function hotspotUpdateConfig(app, data) {
  _requireDeps(app);

  const patch = {};
  if (data.ssid !== undefined) patch.ssid = String(data.ssid).trim();
  if (data.band !== undefined) patch.band = data.band;
  if (data.channel !== undefined) patch.channel = parseInt(data.channel, 10) || 0;
  if (data.password !== undefined && data.password !== PASSWORD_PLACEHOLDER) {
    patch.password = String(data.password);
  }

  const merged = app.hotspotConfigRepository.update(patch);
  return { success: true, config: _publicConfig(merged) };
}

async function hotspotStatus(app) {
  _requireDeps(app);
  const state = await app.hotspotManager.status();
  return { success: true, ...state };
}

async function hotspotEnable(app) {
  _requireDeps(app);
  const cfg = app.hotspotConfigRepository.get();
  if (!cfg.ssid) throw new ValidationError('hotspot SSID is not configured');
  if (!cfg.password || cfg.password.length < 8) {
    throw new ValidationError('hotspot password is not configured (min 8 characters)');
  }
  const res = await app.hotspotManager.enable(cfg);
  app.eventBus?.emit('hotspot:enabled', { ssid: cfg.ssid });
  return { success: true, ...res };
}

async function hotspotDisable(app) {
  _requireDeps(app);
  const res = await app.hotspotManager.disable();
  app.eventBus?.emit('hotspot:disabled', {});
  return { success: true, ...res };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('hotspot_get_config', () => hotspotGetConfig(app));
  registry.register('hotspot_update_config', (data) => hotspotUpdateConfig(app, data));
  registry.register('hotspot_status', () => hotspotStatus(app));
  registry.register('hotspot_enable', () => hotspotEnable(app));
  registry.register('hotspot_disable', () => hotspotDisable(app));
}
