// src/api/commands/LightingCommands.js

function lightingDeviceList(app) {
  const devices = app.database.getLightingDevices();
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

function lightingDeviceAdd(app, data) {
  if (!data.name) throw new Error('name is required');

  const id = app.database.insertLightingDevice({
    name: data.name,
    type: data.type || 'gpio',
    connection_config: data.connection_config || {},
    led_count: data.led_count || 1,
    enabled: data.enabled !== false
  });

  // Reload drivers
  app.lightingManager?.reloadDevices();

  return { success: true, id };
}

function lightingDeviceUpdate(app, data) {
  if (!data.id) throw new Error('id is required');
  app.database.updateLightingDevice(data.id, data);
  app.lightingManager?.reloadDevices();
  return { success: true };
}

function lightingDeviceDelete(app, data) {
  if (!data.id) throw new Error('id is required');
  app.database.deleteLightingDevice(data.id);
  app.lightingManager?.disconnectDevice(data.id);
  app.lightingManager?.reloadRules();
  return { success: true };
}

async function lightingDeviceTest(app, data) {
  if (!data.id) throw new Error('id is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  return await app.lightingManager.testDevice(data.id);
}

function lightingRuleList(app, data) {
  let rules;
  if (data?.device_id) {
    rules = app.database.getLightingRulesForDevice(data.device_id);
  } else {
    rules = app.database.getAllLightingRules();
  }
  return { success: true, rules };
}

function lightingRuleAdd(app, data) {
  if (!data.device_id) throw new Error('device_id is required');

  // Validate condition ranges
  const cond = data.condition_config || {};
  if (cond.velocity_min !== undefined && (cond.velocity_min < 0 || cond.velocity_min > 127)) throw new Error('velocity_min must be 0-127');
  if (cond.velocity_max !== undefined && (cond.velocity_max < 0 || cond.velocity_max > 127)) throw new Error('velocity_max must be 0-127');
  if (cond.note_min !== undefined && (cond.note_min < 0 || cond.note_min > 127)) throw new Error('note_min must be 0-127');
  if (cond.note_max !== undefined && (cond.note_max < 0 || cond.note_max > 127)) throw new Error('note_max must be 0-127');
  if (cond.cc_value_min !== undefined && (cond.cc_value_min < 0 || cond.cc_value_min > 127)) throw new Error('cc_value_min must be 0-127');
  if (cond.cc_value_max !== undefined && (cond.cc_value_max < 0 || cond.cc_value_max > 127)) throw new Error('cc_value_max must be 0-127');

  // Validate device exists
  const device = app.database.getLightingDevice(data.device_id);
  if (!device) throw new Error(`Device ${data.device_id} not found`);

  const id = app.database.insertLightingRule({
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

function lightingRuleUpdate(app, data) {
  if (!data.id) throw new Error('id is required');
  app.database.updateLightingRule(data.id, data);
  app.lightingManager?.reloadRules();
  return { success: true };
}

function lightingRuleDelete(app, data) {
  if (!data.id) throw new Error('id is required');
  app.database.deleteLightingRule(data.id);
  app.lightingManager?.reloadRules();
  return { success: true };
}

function lightingRuleTest(app, data) {
  if (!data.id) throw new Error('id is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  return app.lightingManager.testRule(data.id);
}

function lightingPresetList(app) {
  const presets = app.database.getLightingPresets();
  return { success: true, presets };
}

function lightingPresetSave(app, data) {
  if (!data.name) throw new Error('name is required');

  // Snapshot current rules
  const rules = app.database.getAllLightingRules();
  const id = app.database.insertLightingPreset({
    name: data.name,
    rules_snapshot: rules
  });

  return { success: true, id };
}

function lightingPresetLoad(app, data) {
  if (!data.id) throw new Error('id is required');

  const presets = app.database.getLightingPresets();
  const preset = presets.find(p => p.id === data.id);
  if (!preset) throw new Error(`Preset ${data.id} not found`);

  // Delete existing rules and recreate from snapshot
  const existingRules = app.database.getAllLightingRules();
  for (const rule of existingRules) {
    app.database.deleteLightingRule(rule.id);
  }

  for (const rule of preset.rules_snapshot) {
    app.database.insertLightingRule(rule);
  }

  app.lightingManager?.reloadRules();
  return { success: true, rules_loaded: preset.rules_snapshot.length };
}

function lightingPresetDelete(app, data) {
  if (!data.id) throw new Error('id is required');
  app.database.deleteLightingPreset(data.id);
  return { success: true };
}

function lightingAllOff(app) {
  if (app.lightingManager) {
    app.lightingManager.allOff();
  }
  return { success: true };
}

// ==================== EFFECTS API ====================

function lightingEffectStart(app, data) {
  if (!data.device_id) throw new Error('device_id is required');
  if (!data.effect_type) throw new Error('effect_type is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');

  return app.lightingManager.startEffect(data.device_id, data.effect_type, {
    led_start: data.led_start || 0,
    led_end: data.led_end !== undefined ? data.led_end : -1,
    speed: data.speed || 500,
    brightness: data.brightness !== undefined ? data.brightness : 255,
    color: data.color || '#FF0000',
    color2: data.color2 || null,
    density: data.density || 0.1
  });
}

function lightingEffectStop(app, data) {
  if (!data.effect_key) throw new Error('effect_key is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  return app.lightingManager.stopEffect(data.effect_key);
}

function lightingEffectList(app) {
  if (!app.lightingManager) return { success: true, effects: [] };
  return { success: true, effects: app.lightingManager.getActiveEffects() };
}

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
}
