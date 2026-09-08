/**
 * @file src/api/commands/schemas/lighting.schemas.js
 * @description Validation schemas for the dangerous `lighting_*` WebSocket
 * commands. The lighting surface previously had NO schema, so numeric/array
 * inputs reached the manager and drivers unvalidated — enabling brightness
 * poisoning, runaway effect timers, unbounded blobs and OOM-sized LED buffers
 * (audit B1). These schemas bound the fields that flow into hardware/DB/timers;
 * purely string/id commands keep their imperative `requireField` checks.
 */
import {
  fieldRules,
  isIdLike,
  isIntLike,
  isBoolLike,
  isStr,
  isNonEmptyStr,
  isPlainObject,
  MAX_NAME_LEN
} from './helpers.js';

const DEVICE_TYPES = new Set([
  'gpio',
  'gpio_strip',
  'serial',
  'artnet',
  'sacn',
  'mqtt',
  'http',
  'osc'
]);
const MAX_LED_COUNT = 4096; // generous ceiling; guards GPIO strip buffer alloc
const MAX_STRIPS = 16;
const MAX_GROUP_DEVICES = 256;

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function validateColorField(data, key, errors) {
  if (data[key] !== undefined && !isIntIn(data[key], 0, 255)) {
    errors.push(`${key} must be an integer 0-255`);
  }
}

function validateDevice(data, errors, { requireName }) {
  if (requireName) {
    if (typeof data.name !== 'string' || data.name.trim().length === 0) {
      errors.push('name is required');
    }
  } else if (data.name !== undefined && typeof data.name !== 'string') {
    errors.push('name must be a string');
  }
  if (data.type !== undefined && !DEVICE_TYPES.has(data.type)) {
    errors.push(`type must be one of: ${[...DEVICE_TYPES].join(', ')}`);
  }
  if (data.led_count !== undefined && !isIntIn(data.led_count, 0, MAX_LED_COUNT)) {
    errors.push(`led_count must be an integer 0-${MAX_LED_COUNT}`);
  }
  const cc = data.connection_config;
  if (cc !== undefined) {
    if (typeof cc !== 'object' || cc === null || Array.isArray(cc)) {
      errors.push('connection_config must be an object');
    } else {
      if (cc.port !== undefined && !isIntIn(cc.port, 1, 65535)) {
        errors.push('connection_config.port must be an integer 1-65535');
      }
      if (cc.strips !== undefined) {
        if (!Array.isArray(cc.strips)) {
          errors.push('connection_config.strips must be an array');
        } else if (cc.strips.length > MAX_STRIPS) {
          errors.push(`too many strips (max ${MAX_STRIPS})`);
        } else if (
          cc.strips.some(
            (s) => s && s.led_count !== undefined && !isIntIn(s.led_count, 0, MAX_LED_COUNT)
          )
        ) {
          errors.push(`each strip led_count must be an integer 0-${MAX_LED_COUNT}`);
        }
      }
    }
  }
}

export const lighting_device_add = {
  custom: (data) => {
    const errors = [];
    validateDevice(data, errors, { requireName: true });
    return errors;
  }
};

export const lighting_device_update = {
  custom: (data) => {
    const errors = [];
    validateDevice(data, errors, { requireName: false });
    return errors;
  }
};

export const lighting_master_dimmer = {
  custom: (data) => {
    const errors = [];
    if (data.value !== undefined && !isIntIn(data.value, 0, 255)) {
      errors.push('value must be an integer 0-255');
    }
    return errors;
  }
};

export const lighting_effect_start = {
  custom: (data) => {
    const errors = [];
    if (data.device_id === undefined || data.device_id === null || data.device_id === '') {
      errors.push('device_id is required');
    }
    if (typeof data.effect_type !== 'string' || data.effect_type.length === 0) {
      errors.push('effect_type is required');
    }
    for (const k of ['led_start', 'led_end']) {
      if (data[k] !== undefined && !Number.isInteger(data[k]))
        errors.push(`${k} must be an integer`);
    }
    for (const k of ['speed', 'brightness', 'density']) {
      if (data[k] !== undefined && !isFiniteNum(data[k])) errors.push(`${k} must be a number`);
    }
    return errors;
  }
};

export const lighting_group_create = {
  custom: (data) => {
    const errors = [];
    if (typeof data.name !== 'string' || data.name.trim().length === 0) {
      errors.push('name is required');
    }
    if (data.device_ids !== undefined) {
      if (!Array.isArray(data.device_ids)) errors.push('device_ids must be an array');
      else if (data.device_ids.length > MAX_GROUP_DEVICES) {
        errors.push(`too many device_ids (max ${MAX_GROUP_DEVICES})`);
      }
    }
    return errors;
  }
};

export const lighting_group_color = {
  custom: (data) => {
    const errors = [];
    // The hex `color` path is clamped by hexToRgb; the r/g/b fallback reaches
    // the drivers directly, so bound it here.
    for (const k of ['r', 'g', 'b', 'brightness']) validateColorField(data, k, errors);
    return errors;
  }
};

export const lighting_bpm_set = {
  custom: (data) => {
    const errors = [];
    if (data.bpm !== undefined && !isFiniteNum(data.bpm)) errors.push('bpm must be a number');
    return errors;
  }
};

// ── F-19 / F-37 backfill: the 21 remaining payload-taking commands ──
// Measured: `LightingCommands` accepted 122 of 203 hostile frames, the largest
// count in the project, on a surface that drives GPIO, DMX/Art-Net, sACN, MQTT
// and a rules engine evaluated synchronously on every MIDI message
// (02_LIGHTING.md §F-37, 01_API_CONTRACT.md §3.3).

/** A saved scene replays one effect per entry; bound the list. */
const MAX_SCENE_ENTRIES = 512;

const idRule = ['id', isIdLike, 'id must be a number or non-empty string', { required: true }];
const optionalDeviceIdRule = [
  'device_id',
  isIdLike,
  'device_id must be a number or non-empty string'
];

/** Rule columns, shared by add (device_id required) and update (id required). */
const ruleColumnRules = [
  ['instrument_id', isIdLike, 'instrument_id must be a number or non-empty string'],
  [
    'name',
    (v) => isStr(v, MAX_NAME_LEN),
    `name must be a string of at most ${MAX_NAME_LEN} characters`
  ],
  [
    'priority',
    (v) => isIntLike(v, -1000, 1000),
    'priority must be an integer between -1000 and 1000'
  ],
  ['enabled', isBoolLike, 'enabled must be a boolean'],
  ['condition_config', isPlainObject, 'condition_config must be an object'],
  ['action_config', isPlainObject, 'action_config must be an object']
];

export const lighting_rule_add = {
  custom: fieldRules([
    ['device_id', isIdLike, 'device_id must be a number or non-empty string', { required: true }],
    ...ruleColumnRules
  ])
};

// `updateRule(data.id, data)` forwards the WHOLE envelope to the repository,
// so every column has to be gated here, not only the ones the UI edits.
export const lighting_rule_update = {
  custom: fieldRules([idRule, optionalDeviceIdRule, ...ruleColumnRules])
};

export const lighting_rule_delete = { custom: fieldRules([idRule]) };
export const lighting_rule_test = { custom: fieldRules([idRule]) };
export const lighting_device_delete = { custom: fieldRules([idRule]) };
export const lighting_device_test = { custom: fieldRules([idRule]) };
export const lighting_preset_load = { custom: fieldRules([idRule]) };
export const lighting_preset_delete = { custom: fieldRules([idRule]) };

export const lighting_rule_list = { custom: fieldRules([optionalDeviceIdRule]) };
export const lighting_rules_export = { custom: fieldRules([optionalDeviceIdRule]) };

export const lighting_rules_import = {
  custom: fieldRules([
    [
      'import_data',
      (v) => isPlainObject(v) || isStr(v, 4 * 1024 * 1024),
      'import_data must be an object or a JSON string',
      { required: true }
    ],
    ['default_device_id', isIdLike, 'default_device_id must be a number or non-empty string']
  ])
};

export const lighting_device_scan = {
  custom: fieldRules([
    ['type', (v) => isNonEmptyStr(v, 32), 'type must be a string'],
    // Format (an IPv4 /24 prefix) is enforced by the handler's SSRF guard.
    ['subnet', (v) => isNonEmptyStr(v, 64), 'subnet must be a string']
  ])
};

export const lighting_preset_save = {
  custom: fieldRules([
    [
      'name',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN),
      `name must be a non-empty string of at most ${MAX_NAME_LEN} characters`,
      { required: true }
    ]
  ])
};

export const lighting_effect_stop = {
  custom: fieldRules([
    [
      'effect_key',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN),
      'effect_key must be a non-empty string',
      { required: true }
    ]
  ])
};

const groupNameSchema = {
  custom: fieldRules([
    [
      'name',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN),
      'name must be a non-empty string',
      { required: true }
    ]
  ])
};
export const lighting_group_delete = groupNameSchema;
export const lighting_group_off = groupNameSchema;

// `lighting_scene_save` accepted deepNest (600 levels), bigArray (50 000) and
// bigString (200 000 chars) as-is; the snapshot is replayed later by
// `_applySceneObject`, which starts one effect per entry.
export const lighting_scene_save = {
  custom: fieldRules([
    [
      'name',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN),
      `name must be a non-empty string of at most ${MAX_NAME_LEN} characters`,
      { required: true }
    ],
    ['device_colors', isPlainObject, 'device_colors must be an object']
  ])
};

export const lighting_scene_apply = {
  custom: fieldRules(
    [['scene', isPlainObject, 'scene data is required', { required: true }]],
    (data, errors) => {
      const effects = data.scene && data.scene.effects;
      if (Array.isArray(effects) && effects.length > MAX_SCENE_ENTRIES) {
        errors.push(`scene.effects must hold at most ${MAX_SCENE_ENTRIES} entries`);
      }
    }
  )
};

// `data?.enabled !== false` means ANY value other than `false` switches these
// on — including `0`, `"no"` and `{}`. Require a real boolean-ish value so the
// caller cannot enable a continuous LED broadcast (or the whole lighting
// system) by accident or by typo.
export const lighting_led_broadcast = {
  custom: fieldRules([['enabled', isBoolLike, 'enabled must be a boolean', { required: true }]])
};

export const lighting_set_enabled = {
  custom: fieldRules([['enabled', isBoolLike, 'enabled must be a boolean', { required: true }]])
};

// `lightingMidiLearnStart(app, _data)` never reads its payload — declared so
// the command counts as covered rather than exempt.
export const lighting_midi_learn = {};

const schemas = {
  lighting_device_add,
  lighting_device_update,
  lighting_master_dimmer,
  lighting_effect_start,
  lighting_group_create,
  lighting_group_color,
  lighting_bpm_set,
  lighting_rule_add,
  lighting_rule_update,
  lighting_rule_delete,
  lighting_rule_test,
  lighting_rule_list,
  lighting_rules_export,
  lighting_rules_import,
  lighting_device_delete,
  lighting_device_test,
  lighting_device_scan,
  lighting_preset_save,
  lighting_preset_load,
  lighting_preset_delete,
  lighting_effect_stop,
  lighting_group_delete,
  lighting_group_off,
  lighting_scene_save,
  lighting_scene_apply,
  lighting_led_broadcast,
  lighting_set_enabled,
  lighting_midi_learn
};

export default schemas;
