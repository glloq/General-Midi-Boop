/**
 * @file src/api/commands/LightingCommands.js
 * @description WebSocket commands for the lighting subsystem (GPIO LEDs,
 * WS281x strips, DMX fixtures via the optional LightingManager).
 *
 * Responsibility split:
 *   - Persistence (devices, rules, presets, groups, scenes) is delegated
 *     to `lightingRepository`.
 *   - Runtime control (effects engine, BPM, MIDI-learn, scene apply,
 *     master dimmer, blackout) is delegated to `lightingManager` and
 *     guarded by {@link requireLightingManager}.
 *
 * Registered commands (grouped):
 *   - Devices: list, add, update, delete, test, scan
 *   - Rules: list, add, update, delete, test
 *   - Presets: list, save, load, delete
 *   - Effects: start, stop, list
 *   - Master controls: all_off, master_dimmer, blackout
 *   - Groups: create, delete, list, color, off
 *   - Rules import/export
 *   - Scenes: save, apply
 *   - MIDI-learn: start
 *   - BPM: set, tap, get
 *   - LED broadcast toggle, DMX profile list
 *
 * Validation: imperative inside each handler, using `requireField` /
 * `validateMidiRange` from ValidationUtils.
 */

import { ValidationError, NotFoundError, ConfigurationError } from '../../core/errors/index.js';
import { hexToRgb } from '../../utils/ColorUtils.js';
import { requireField, validateMidiRange } from '../../utils/ValidationUtils.js';

/**
 * Resolve and return the lighting manager, or throw a structured error
 * when it is not loaded (missing `pigpio`/`rpi-ws281x-native` deps).
 *
 * @param {Object} app
 * @returns {Object} The live LightingManager instance.
 * @throws {ConfigurationError}
 */
function requireLightingManager(app) {
  if (!app.lightingManager) throw new ConfigurationError('Lighting manager not available');
  return app.lightingManager;
}

/**
 * List every persisted lighting device, enriched with a live
 * `connected` flag from the manager (false when the manager is absent).
 *
 * @param {Object} app
 * @returns {{success:true, devices:Object[]}}
 */
function lightingDeviceList(app) {
  const devices = app.lightingRepository.findAllDevices();
  const statuses = app.lightingManager?.getDeviceStatus() || [];
  const statusMap = new Map(statuses.map(s => [s.id, s.connected]));

  return {
    success: true,
    devices: devices.map(d => ({
      ...d,
      connected: statusMap.get(d.id) || false
    }))
  };
}

/**
 * Persist a new lighting device row, then ask the manager to reload its
 * driver list so the device becomes immediately controllable.
 *
 * @param {Object} app
 * @param {{name:string, type?:string, connection_config?:Object,
 *   led_count?:number, enabled?:boolean}} data
 * @returns {Promise<{success:true, id:(string|number)}>}
 * @throws {ValidationError}
 */
async function lightingDeviceAdd(app, data) {
  requireField(data, 'name');

  const id = app.lightingRepository.saveDevice({
    name: data.name,
    type: data.type || 'gpio',
    connection_config: data.connection_config || {},
    led_count: data.led_count || 1,
    enabled: data.enabled !== false
  });

  // Reload drivers
  await app.lightingManager?.reloadDevices();

  return { success: true, id };
}

/**
 * Update an existing lighting device row + reload drivers.
 *
 * @param {Object} app
 * @param {Object} data - Must include `id`; remaining fields are
 *   forwarded to `lightingRepository.updateDevice`.
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function lightingDeviceUpdate(app, data) {
  requireField(data, 'id');
  app.lightingRepository.updateDevice(data.id, data);
  await app.lightingManager?.reloadDevices();
  return { success: true };
}

/**
 * Delete a lighting device, disconnect it from the manager, and refresh
 * the rule cache (rules referencing the device become orphaned).
 *
 * @param {Object} app
 * @param {{id:(string|number)}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function lightingDeviceDelete(app, data) {
  requireField(data, 'id');
  app.lightingRepository.deleteDevice(data.id);
  await app.lightingManager?.disconnectDevice(data.id);
  app.lightingManager?.reloadRules();
  return { success: true };
}

/**
 * Trigger a hardware self-test on a device (color cycle / chase pattern).
 *
 * @param {Object} app
 * @param {{id:(string|number)}} data
 * @returns {Promise<Object>}
 * @throws {ValidationError|ConfigurationError}
 */
async function lightingDeviceTest(app, data) {
  requireField(data, 'id');
  const lm = requireLightingManager(app);
  return await lm.testDevice(data.id);
}

/**
 * List rules, optionally scoped to a single device.
 *
 * @param {Object} app
 * @param {?{device_id?:(string|number)}} data
 * @returns {{success:true, rules:Object[]}}
 */
function lightingRuleList(app, data) {
  let rules;
  if (data?.device_id) {
    rules = app.lightingRepository.findRulesByDevice(data.device_id);
  } else {
    rules = app.lightingRepository.findAllRules();
  }
  return { success: true, rules };
}

/**
 * Persist a new rule (condition → action). Validates the MIDI-range
 * fields up front so invalid bounds never reach the engine.
 *
 * @param {Object} app
 * @param {Object} data - `{device_id, instrument_id?, name?, priority?,
 *   enabled?, condition_config?, action_config?}`.
 * @returns {{success:true, id:(string|number)}}
 * @throws {ValidationError|NotFoundError}
 */
function lightingRuleAdd(app, data) {
  requireField(data, 'device_id');

  // Validate condition ranges
  const cond = data.condition_config || {};
  for (const field of ['velocity_min', 'velocity_max', 'note_min', 'note_max', 'cc_value_min', 'cc_value_max']) {
    validateMidiRange(cond[field], field);
  }

  // Validate device exists
  const device = app.lightingRepository.findDeviceById(data.device_id);
  if (!device) throw new NotFoundError('LightingDevice', data.device_id);

  const id = app.lightingRepository.saveRule({
    name: data.name || '',
    device_id: data.device_id,
    instrument_id: data.instrument_id || null,
    priority: data.priority || 0,
    enabled: data.enabled !== false,
    condition_config: data.condition_config || {},
    action_config: data.action_config || {}
  });

  app.lightingManager?.reloadRules();
  return { success: true, id };
}

/**
 * @param {Object} app
 * @param {Object} data - Must include `id`.
 * @returns {{success:true}}
 * @throws {ValidationError}
 */
function lightingRuleUpdate(app, data) {
  requireField(data, 'id');
  app.lightingRepository.updateRule(data.id, data);
  app.lightingManager?.reloadRules();
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{id:(string|number)}} data
 * @returns {{success:true}}
 * @throws {ValidationError}
 */
function lightingRuleDelete(app, data) {
  requireField(data, 'id');
  app.lightingRepository.deleteRule(data.id);
  app.lightingManager?.reloadRules();
  return { success: true };
}

/**
 * Trigger a one-shot test fire of a single rule (without waiting for a
 * matching MIDI event).
 *
 * @param {Object} app
 * @param {{id:(string|number)}} data
 * @returns {Object}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingRuleTest(app, data) {
  requireField(data, 'id');
  const lm = requireLightingManager(app);
  return lm.testRule(data.id);
}

/**
 * @param {Object} app
 * @returns {{success:true, presets:Object[]}}
 */
function lightingPresetList(app) {
  const presets = app.lightingRepository.findAllPresets();
  return { success: true, presets };
}

/**
 * Snapshot the current rule set as a named preset.
 *
 * @param {Object} app
 * @param {{name:string}} data
 * @returns {{success:true, id:(string|number)}}
 * @throws {ValidationError}
 */
function lightingPresetSave(app, data) {
  requireField(data, 'name');

  // Snapshot current rules
  const rules = app.lightingRepository.findAllRules();
  const id = app.lightingRepository.savePreset({
    name: data.name,
    rules_snapshot: rules
  });

  return { success: true, id };
}

/**
 * Replace every active rule with the contents of a saved preset.
 * Existing rules are deleted first so the replay is exact, not additive.
 * Scene-style presets (whose snapshot is an object, not an array) are
 * rejected — callers must use `lighting_scene_apply` for those.
 *
 * @param {Object} app
 * @param {{id:(string|number)}} data
 * @returns {{success:true, rules_loaded:number}}
 * @throws {ValidationError|NotFoundError}
 */
function lightingPresetLoad(app, data) {
  requireField(data, 'id');

  const presets = app.lightingRepository.findAllPresets();
  const preset = presets.find(p => p.id === data.id);
  if (!preset) throw new NotFoundError('LightingPreset', data.id);

  // Guard: only load if rules_snapshot is an array of rules (not a scene object)
  if (!Array.isArray(preset.rules_snapshot)) {
    throw new ValidationError('This preset is a scene snapshot, not a rules preset. Use scene_apply instead.', 'rules_snapshot');
  }

  // Delete existing rules and recreate from snapshot
  const existingRules = app.lightingRepository.findAllRules();
  for (const rule of existingRules) {
    app.lightingRepository.deleteRule(rule.id);
  }

  for (const rule of preset.rules_snapshot) {
    app.lightingRepository.saveRule(rule);
  }

  app.lightingManager?.reloadRules();
  return { success: true, rules_loaded: preset.rules_snapshot.length };
}

/**
 * @param {Object} app
 * @param {{id:(string|number)}} data
 * @returns {{success:true}}
 * @throws {ValidationError}
 */
function lightingPresetDelete(app, data) {
  requireField(data, 'id');
  app.lightingRepository.deletePreset(data.id);
  return { success: true };
}

/**
 * Force every device to dark state. No-op when the manager is absent.
 *
 * @param {Object} app
 * @returns {{success:true}}
 */
function lightingAllOff(app) {
  if (app.lightingManager) {
    app.lightingManager.allOff();
  }
  return { success: true };
}

// ==================== EFFECTS API ====================

/**
 * Start a runtime effect (chase, pulse, sparkle, etc.) on a slice of
 * one device's LED strip. Returns the effect key the caller needs to
 * later stop it.
 *
 * @param {Object} app
 * @param {{device_id:(string|number), effect_type:string, led_start?:number,
 *   led_end?:number, speed?:number, brightness?:number, color?:string,
 *   color2?:?string, density?:number}} data - `led_end:-1` means
 *   "to the end of the strip"; `color`/`color2` accept hex strings.
 * @returns {Object}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingEffectStart(app, data) {
  requireField(data, 'device_id');
  requireField(data, 'effect_type');
  const lm = requireLightingManager(app);

  return lm.startEffect(data.device_id, data.effect_type, {
    led_start: data.led_start || 0,
    led_end: data.led_end !== undefined ? data.led_end : -1,
    speed: data.speed || 500,
    brightness: data.brightness !== undefined ? data.brightness : 255,
    color: data.color || '#FF0000',
    color2: data.color2 || null,
    density: data.density || 0.1
  });
}

/**
 * @param {Object} app
 * @param {{effect_key:string}} data
 * @returns {Object}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingEffectStop(app, data) {
  requireField(data, 'effect_key');
  const lm = requireLightingManager(app);
  return lm.stopEffect(data.effect_key);
}

/**
 * @param {Object} app
 * @returns {{success:true, effects:Object[]}}
 */
function lightingEffectList(app) {
  if (!app.lightingManager) return { success: true, effects: [] };
  return { success: true, effects: app.lightingManager.getActiveEffects() };
}

// ==================== MASTER DIMMER API ====================

/**
 * Setter when `data.value` is provided, getter otherwise.
 *
 * @param {Object} app
 * @param {?{value?:number}} data - `value` in 0..255.
 * @returns {Object} Manager response.
 * @throws {ConfigurationError}
 */
function lightingMasterDimmer(app, data) {
  const lm = requireLightingManager(app);
  if (data?.value !== undefined) {
    return lm.setMasterDimmer(data.value);
  }
  return { success: true, masterDimmer: lm.getMasterDimmer() };
}

/**
 * Instant blackout — every device goes dark, every effect stops.
 *
 * @param {Object} app
 * @returns {Object}
 * @throws {ConfigurationError}
 */
function lightingBlackout(app) {
  const lm = requireLightingManager(app);
  return lm.blackout();
}

// ==================== DEVICE GROUPS API ====================

/**
 * Create a named device group so subsequent commands can target several
 * devices at once.
 *
 * @param {Object} app
 * @param {{name:string, device_ids:(string|number)[]}} data
 * @returns {Object}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingGroupCreate(app, data) {
  requireField(data, 'name');
  if (!data.device_ids || !Array.isArray(data.device_ids)) throw new ValidationError('device_ids array is required', 'device_ids');
  const lm = requireLightingManager(app);
  return lm.createGroup(data.name, data.device_ids);
}

/**
 * @param {Object} app
 * @param {{name:string}} data
 * @returns {Object}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingGroupDelete(app, data) {
  requireField(data, 'name');
  const lm = requireLightingManager(app);
  return lm.deleteGroup(data.name);
}

/**
 * @param {Object} app
 * @returns {{success:true, groups:Object}}
 */
function lightingGroupList(app) {
  if (!app.lightingManager) return { success: true, groups: {} };
  return { success: true, groups: app.lightingManager.getGroups() };
}

/**
 * Set a uniform color across a group. Accepts either a hex string
 * (`color`) or explicit RGB components (`r`, `g`, `b`).
 *
 * @param {Object} app
 * @param {{name:string, color?:string, r?:number, g?:number, b?:number,
 *   brightness?:number}} data - `brightness` 0..255.
 * @returns {Object}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingGroupColor(app, data) {
  requireField(data, 'name');
  const lm = requireLightingManager(app);
  const color = data.color ? hexToRgb(data.color) : { r: data.r || 0, g: data.g || 0, b: data.b || 0 };
  return lm.setGroupColor(data.name, color.r, color.g, color.b, data.brightness || 255);
}

/**
 * @param {Object} app
 * @param {{name:string}} data
 * @returns {Object}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingGroupOff(app, data) {
  requireField(data, 'name');
  const lm = requireLightingManager(app);
  return lm.groupAllOff(data.name);
}

// ==================== RULE IMPORT/EXPORT API ====================

/**
 * Export rules (optionally scoped to a single device) plus referenced
 * device metadata as a portable JSON document.
 *
 * @param {Object} app
 * @param {?{device_id?:(string|number)}} data
 * @returns {{success:true, export_data:Object}}
 */
function lightingRulesExport(app, data) {
  let rules;
  if (data?.device_id) {
    rules = app.lightingRepository.findRulesByDevice(data.device_id);
  } else {
    rules = app.lightingRepository.findAllRules();
  }
  const devices = app.lightingRepository.findAllDevices();

  return {
    success: true,
    export_data: {
      version: 1,
      exported_at: new Date().toISOString(),
      devices: devices.map(d => ({ name: d.name, type: d.type, led_count: d.led_count, connection_config: d.connection_config })),
      rules: rules.map(r => ({
        name: r.name,
        device_name: devices.find(d => d.id === r.device_id)?.name || null,
        instrument_id: r.instrument_id,
        priority: r.priority,
        enabled: r.enabled,
        condition_config: r.condition_config,
        action_config: r.action_config
      }))
    }
  };
}

/**
 * Import rules from an exported JSON document. Devices are matched by
 * `device_name`; unmatched rules either fall back to
 * `default_device_id` (if provided) or are skipped.
 *
 * @param {Object} app
 * @param {{import_data:(string|Object), default_device_id?:(string|number)}} data
 * @returns {{success:true, imported:number, skipped:number}}
 * @throws {ValidationError}
 */
function lightingRulesImport(app, data) {
  requireField(data, 'import_data');
  const importData = typeof data.import_data === 'string' ? JSON.parse(data.import_data) : data.import_data;

  if (!importData.rules || !Array.isArray(importData.rules)) throw new ValidationError('Invalid import data: missing rules array', 'import_data');

  const devices = app.lightingRepository.findAllDevices();
  let imported = 0;
  let skipped = 0;

  for (const rule of importData.rules) {
    // Try to match device by name
    let deviceId = null;
    if (rule.device_name) {
      const device = devices.find(d => d.name === rule.device_name);
      if (device) deviceId = device.id;
    }
    if (!deviceId && data.default_device_id) {
      deviceId = data.default_device_id;
    }
    if (!deviceId) {
      skipped++;
      continue;
    }

    app.lightingRepository.saveRule({
      name: rule.name || '',
      device_id: deviceId,
      instrument_id: rule.instrument_id || null,
      priority: rule.priority || 0,
      enabled: rule.enabled !== false,
      condition_config: rule.condition_config || {},
      action_config: rule.action_config || {}
    });
    imported++;
  }

  app.lightingManager?.reloadRules();
  return { success: true, imported, skipped };
}

// ==================== DEVICE SCAN/DISCOVER API ====================

/**
 * Discover lighting devices on the local network via HTTP probing
 * (WLED) and well-known discovery URLs (Hue). Probes are batched to
 * avoid overwhelming the LAN.
 *
 * @param {Object} app
 * @param {?{type?:('all'|'wled'|'hue'), subnet?:string}} data - `subnet`
 *   defaults to `"192.168.1"`; the handler probes `<subnet>.1` to
 *   `<subnet>.254`.
 * @returns {Promise<{success:true, discovered:Object[]}>}
 */
async function lightingDeviceScan(app, data) {
  const scanType = data?.type || 'all';
  const discovered = [];

  // WLED discovery: each instance exposes /json/info; we probe every IP
  // in the subnet in batches because a single broadcast probe is not
  // available without raw sockets.
  if (scanType === 'all' || scanType === 'wled') {
    const subnet = data?.subnet || '192.168.1';
    const scanPromises = [];

    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      scanPromises.push(
        fetch(`http://${ip}/json/info`, { signal: AbortSignal.timeout(800) })
          .then(async res => {
            if (res.ok) {
              const info = await res.json();
              discovered.push({
                type: 'wled',
                name: info.name || `WLED ${ip}`,
                host: ip,
                led_count: info.leds?.count || 30,
                version: info.ver || 'unknown',
                mac: info.mac || null
              });
            }
          })
          .catch(() => {}) // ignore unreachable
      );
    }

    // Process in batches to avoid overwhelming the network
    const batchSize = 30;
    for (let i = 0; i < scanPromises.length; i += batchSize) {
      await Promise.all(scanPromises.slice(i, i + batchSize));
    }
  }

  // Scan for Philips Hue bridges
  if (scanType === 'all' || scanType === 'hue') {
    try {
      const res = await fetch('https://discovery.meethue.com/', { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const bridges = await res.json();
        for (const bridge of bridges) {
          discovered.push({
            type: 'hue',
            name: `Philips Hue Bridge`,
            host: bridge.internalipaddress,
            id: bridge.id
          });
        }
      }
    } catch (e) { app.logger.debug('Hue bridge discovery skipped', e); }
  }

  return { success: true, discovered };
}

// ==================== SCENES API ====================

/**
 * Snapshot the current live state of every device (master dimmer,
 * effects, group bindings) into a named scene preset.
 *
 * @param {Object} app
 * @param {{name:string}} data
 * @returns {{success:true, id:(string|number)}}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingSceneSave(app, data) {
  requireField(data, 'name');
  const lm = requireLightingManager(app);

  // Capture current state of all devices
  const scene = {
    name: data.name,
    masterDimmer: lm.getMasterDimmer(),
    devices: [],
    effects: lm.getActiveEffects()
  };

  // Store device state (what rules are active, what effects are running)
  const devices = app.lightingRepository.findAllDevices();
  for (const device of devices) {
    const driver = lm.drivers.get(device.id);
    scene.devices.push({
      id: device.id,
      name: device.name,
      connected: driver ? driver.isConnected() : false,
      color: data.device_colors?.[device.id] || null
    });
  }

  // Store as a preset with scene type
  const id = app.lightingRepository.savePreset({
    name: `[scene] ${data.name}`,
    rules_snapshot: scene
  });

  return { success: true, id };
}

/**
 * Apply a scene snapshot: restore master dimmer, paint device colors,
 * relaunch effects. Devices/effects whose drivers are no longer
 * connected are silently skipped so partial restorations succeed.
 *
 * @param {Object} app
 * @param {{scene:Object}} data
 * @returns {{success:true}}
 * @throws {ValidationError|ConfigurationError}
 */
function lightingSceneApply(app, data) {
  requireField(data, 'scene', 'scene data is required');
  const lm = requireLightingManager(app);

  const scene = data.scene;

  // Restore master dimmer
  if (scene.masterDimmer !== undefined) {
    lm.setMasterDimmer(scene.masterDimmer);
  }

  // Apply device colors
  if (scene.devices) {
    for (const devState of scene.devices) {
      if (devState.color) {
        const driver = lm.drivers.get(devState.id);
        if (driver && driver.isConnected()) {
          const c = hexToRgb(devState.color);
          driver.setRange(0, -1, c.r, c.g, c.b, 255);
        }
      }
    }
  }

  // Restart effects
  if (scene.effects && Array.isArray(scene.effects)) {
    for (const effect of scene.effects) {
      if (!effect.key || !effect.effectType) continue;
      const deviceIdStr = effect.key.split('device_')[1];
      if (!deviceIdStr) continue;
      const deviceId = parseInt(deviceIdStr);
      if (isNaN(deviceId)) continue;
      const driver = lm.drivers.get(deviceId);
      if (driver && driver.isConnected()) {
        lm.effectsEngine.startEffect(effect.key, effect.effectType, driver, effect.config || {});
      }
    }
  }

  return { success: true };
}

// ==================== MIDI LEARN ====================

/**
 * One-shot MIDI-learn helper: subscribe to the next `midi_message`
 * event and return its descriptor. Resolves with `success:false` after
 * a 10-second timeout so the UI can offer a retry.
 *
 * @param {Object} app
 * @returns {Promise<{success:boolean, learned?:Object,
 *   error?:string, message?:string}>}
 * @throws {ConfigurationError}
 */
function lightingMidiLearnStart(app, _data) {
  requireLightingManager(app);

  // Set up a one-shot MIDI listener that captures the next MIDI event.
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      app.eventBus.removeListener('midi_message', handler);
      resolve({ success: false, error: 'timeout', message: 'No MIDI event received within 10 seconds' });
    }, 10000);

    const handler = (event) => {
      clearTimeout(timeout);
      app.eventBus.removeListener('midi_message', handler);

      const midiData = event.data || event;
      resolve({
        success: true,
        learned: {
          type: event.type || midiData.type,
          channel: midiData.channel,
          note: midiData.note,
          velocity: midiData.velocity,
          controller: midiData.controller,
          value: midiData.value
        }
      });
    };

    app.eventBus.on('midi_message', handler);
  });
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('lighting_device_list', () => lightingDeviceList(app));
  registry.register('lighting_device_add', (data) => lightingDeviceAdd(app, data));
  registry.register('lighting_device_update', (data) => lightingDeviceUpdate(app, data));
  registry.register('lighting_device_delete', (data) => lightingDeviceDelete(app, data));
  registry.register('lighting_device_test', (data) => lightingDeviceTest(app, data));
  registry.register('lighting_rule_list', (data) => lightingRuleList(app, data));
  registry.register('lighting_rule_add', (data) => lightingRuleAdd(app, data));
  registry.register('lighting_rule_update', (data) => lightingRuleUpdate(app, data));
  registry.register('lighting_rule_delete', (data) => lightingRuleDelete(app, data));
  registry.register('lighting_rule_test', (data) => lightingRuleTest(app, data));
  registry.register('lighting_preset_list', () => lightingPresetList(app));
  registry.register('lighting_preset_save', (data) => lightingPresetSave(app, data));
  registry.register('lighting_preset_load', (data) => lightingPresetLoad(app, data));
  registry.register('lighting_preset_delete', (data) => lightingPresetDelete(app, data));
  registry.register('lighting_all_off', () => lightingAllOff(app));
  registry.register('lighting_effect_start', (data) => lightingEffectStart(app, data));
  registry.register('lighting_effect_stop', (data) => lightingEffectStop(app, data));
  registry.register('lighting_effect_list', () => lightingEffectList(app));
  registry.register('lighting_master_dimmer', (data) => lightingMasterDimmer(app, data));
  registry.register('lighting_blackout', () => lightingBlackout(app));
  registry.register('lighting_group_create', (data) => lightingGroupCreate(app, data));
  registry.register('lighting_group_delete', (data) => lightingGroupDelete(app, data));
  registry.register('lighting_group_list', () => lightingGroupList(app));
  registry.register('lighting_group_color', (data) => lightingGroupColor(app, data));
  registry.register('lighting_group_off', (data) => lightingGroupOff(app, data));
  registry.register('lighting_rules_export', (data) => lightingRulesExport(app, data));
  registry.register('lighting_rules_import', (data) => lightingRulesImport(app, data));
  registry.register('lighting_device_scan', (data) => lightingDeviceScan(app, data));
  registry.register('lighting_scene_save', (data) => lightingSceneSave(app, data));
  registry.register('lighting_scene_apply', (data) => lightingSceneApply(app, data));
  registry.register('lighting_midi_learn', (data) => lightingMidiLearnStart(app, data));
  registry.register('lighting_bpm_set', (data) => {
    const lm = requireLightingManager(app);
    lm.effectsEngine.setBpm(data.bpm);
    return { success: true, bpm: lm.effectsEngine.getBpm() };
  });
  registry.register('lighting_bpm_tap', () => {
    const lm = requireLightingManager(app);
    const bpm = lm.effectsEngine.tapTempo();
    return { success: true, bpm };
  });
  registry.register('lighting_led_broadcast', (data) => {
    const lm = requireLightingManager(app);
    return lm.enableLedBroadcast(data?.enabled !== false);
  });
  registry.register('lighting_dmx_profiles', async () => {
    const { listProfiles } = await import('../../lighting/DmxFixtureProfiles.js');
    return { success: true, profiles: listProfiles() };
  });
  registry.register('lighting_bpm_get', () => {
    if (!app.lightingManager) return { success: true, bpm: 120 };
    return { success: true, bpm: app.lightingManager.effectsEngine.getBpm() };
  });
}
