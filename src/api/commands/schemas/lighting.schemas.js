/**
 * @file src/api/commands/schemas/lighting.schemas.js
 * @description Validation schemas for the dangerous `lighting_*` WebSocket
 * commands. The lighting surface previously had NO schema, so numeric/array
 * inputs reached the manager and drivers unvalidated — enabling brightness
 * poisoning, runaway effect timers, unbounded blobs and OOM-sized LED buffers
 * (audit B1). These schemas bound the fields that flow into hardware/DB/timers;
 * purely string/id commands keep their imperative `requireField` checks.
 */

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

const schemas = {
  lighting_device_add,
  lighting_device_update,
  lighting_master_dimmer,
  lighting_effect_start,
  lighting_group_create,
  lighting_group_color,
  lighting_bpm_set
};

export default schemas;
