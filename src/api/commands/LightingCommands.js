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

// ==================== MASTER DIMMER API ====================

function lightingMasterDimmer(app, data) {
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  if (data?.value !== undefined) {
    return app.lightingManager.setMasterDimmer(data.value);
  }
  return { success: true, masterDimmer: app.lightingManager.getMasterDimmer() };
}

function lightingBlackout(app) {
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  return app.lightingManager.blackout();
}

// ==================== DEVICE GROUPS API ====================

function lightingGroupCreate(app, data) {
  if (!data.name) throw new Error('name is required');
  if (!data.device_ids || !Array.isArray(data.device_ids)) throw new Error('device_ids array is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  return app.lightingManager.createGroup(data.name, data.device_ids);
}

function lightingGroupDelete(app, data) {
  if (!data.name) throw new Error('name is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  return app.lightingManager.deleteGroup(data.name);
}

function lightingGroupList(app) {
  if (!app.lightingManager) return { success: true, groups: {} };
  return { success: true, groups: app.lightingManager.getGroups() };
}

function lightingGroupColor(app, data) {
  if (!data.name) throw new Error('name is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  const color = data.color ? hexToRgb(data.color) : { r: data.r || 0, g: data.g || 0, b: data.b || 0 };
  return app.lightingManager.setGroupColor(data.name, color.r, color.g, color.b, data.brightness || 255);
}

function lightingGroupOff(app, data) {
  if (!data.name) throw new Error('name is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');
  return app.lightingManager.groupAllOff(data.name);
}

// ==================== RULE IMPORT/EXPORT API ====================

function lightingRulesExport(app, data) {
  let rules;
  if (data?.device_id) {
    rules = app.database.getLightingRulesForDevice(data.device_id);
  } else {
    rules = app.database.getAllLightingRules();
  }
  const devices = app.database.getLightingDevices();

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

function lightingRulesImport(app, data) {
  if (!data.import_data) throw new Error('import_data is required');
  const importData = typeof data.import_data === 'string' ? JSON.parse(data.import_data) : data.import_data;

  if (!importData.rules || !Array.isArray(importData.rules)) throw new Error('Invalid import data: missing rules array');

  const devices = app.database.getLightingDevices();
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

    app.database.insertLightingRule({
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

async function lightingDeviceScan(app, data) {
  const scanType = data?.type || 'all';
  const discovered = [];

  // Scan for WLED devices via mDNS-like HTTP probe on common ranges
  if (scanType === 'all' || scanType === 'wled') {
    const subnet = data?.subnet || '192.168.1';
    const scanPromises = [];

    // Probe common addresses
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
    } catch (e) { /* ignore */ }
  }

  return { success: true, discovered };
}

// ==================== SCENES API ====================

function lightingSceneSave(app, data) {
  if (!data.name) throw new Error('name is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');

  // Capture current state of all devices
  const scene = {
    name: data.name,
    masterDimmer: app.lightingManager.getMasterDimmer(),
    devices: [],
    effects: app.lightingManager.getActiveEffects()
  };

  // Store device state (what rules are active, what effects are running)
  const devices = app.database.getLightingDevices();
  for (const device of devices) {
    const driver = app.lightingManager.drivers.get(device.id);
    scene.devices.push({
      id: device.id,
      name: device.name,
      connected: driver ? driver.isConnected() : false,
      color: data.device_colors?.[device.id] || null
    });
  }

  // Store as a preset with scene type
  const id = app.database.insertLightingPreset({
    name: `[scene] ${data.name}`,
    rules_snapshot: scene
  });

  return { success: true, id };
}

function lightingSceneApply(app, data) {
  if (!data.scene) throw new Error('scene data is required');
  if (!app.lightingManager) throw new Error('Lighting manager not available');

  const scene = data.scene;

  // Restore master dimmer
  if (scene.masterDimmer !== undefined) {
    app.lightingManager.setMasterDimmer(scene.masterDimmer);
  }

  // Apply device colors
  if (scene.devices) {
    for (const devState of scene.devices) {
      if (devState.color) {
        const driver = app.lightingManager.drivers.get(devState.id);
        if (driver && driver.isConnected()) {
          const c = hexToRgb(devState.color);
          driver.setRange(0, -1, c.r, c.g, c.b, 255);
        }
      }
    }
  }

  // Restart effects
  if (scene.effects) {
    for (const effect of scene.effects) {
      const driver = app.lightingManager.drivers.get(parseInt(effect.key.split('device_')[1]));
      if (driver && driver.isConnected()) {
        app.lightingManager.effectsEngine.startEffect(effect.key, effect.effectType, driver, effect.config);
      }
    }
  }

  return { success: true };
}

// ==================== MIDI LEARN ====================

function lightingMidiLearnStart(app, data) {
  if (!app.lightingManager) throw new Error('Lighting manager not available');

  // Set up a one-shot MIDI listener that captures the next MIDI event
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      app.eventBus.removeListener('midi_message', handler);
      resolve({ success: false, error: 'timeout', message: 'No MIDI event received within 10 seconds' });
    }, 10000);

    const handler = (event) => {
      clearTimeout(timeout);
      app.eventBus.removeListener('midi_message', handler);

      const data = event.data || event;
      resolve({
        success: true,
        learned: {
          type: event.type || data.type,
          channel: data.channel,
          note: data.note,
          velocity: data.velocity,
          controller: data.controller,
          value: data.value
        }
      });
    };

    app.eventBus.on('midi_message', handler);
  });
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 };
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
    if (!app.lightingManager) throw new Error('Lighting manager not available');
    app.lightingManager.effectsEngine.setBpm(data.bpm);
    return { success: true, bpm: app.lightingManager.effectsEngine.getBpm() };
  });
  registry.register('lighting_bpm_tap', () => {
    if (!app.lightingManager) throw new Error('Lighting manager not available');
    const bpm = app.lightingManager.effectsEngine.tapTempo();
    return { success: true, bpm };
  });
  registry.register('lighting_led_broadcast', (data) => {
    if (!app.lightingManager) throw new Error('Lighting manager not available');
    return app.lightingManager.enableLedBroadcast(data?.enabled !== false);
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
