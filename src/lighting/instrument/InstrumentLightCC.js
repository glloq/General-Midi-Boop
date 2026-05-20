/**
 * @file src/lighting/instrument/InstrumentLightCC.js
 * @description Pure helpers for the generic CC-based lighting control of
 * a MIDI instrument's on-board lights. Five Control Change numbers cover
 * every device class (single LED, RGB, RGBW, WS2812 strip, relay, local
 * effects):
 *
 *   CC 110 — master brightness (0 = OFF, 1-127 = brightness)
 *   CC 111 — effect / behaviour (index in EFFECTS, 0-127 firmware-side)
 *   CC 112 — colour hue (HSV hue 0-127)
 *   CC 113 — animation speed
 *   CC 114 — intensity / variation
 *
 * No SysEx, no capability discovery, no per-device dialect — just MIDI
 * CCs on the instrument's own channel. The instrument firmware decides
 * how to interpret each value for its hardware.
 */

export const CC = Object.freeze({
  MASTER:    110,
  EFFECT:    111,
  HUE:       112,
  SPEED:     113,
  INTENSITY: 114
});

/** Effect catalogue. Index = value sent on CC 111. */
export const EFFECTS = Object.freeze([
  'static',
  'fade',
  'pulse',
  'blink',
  'rainbow',
  'reactive_note',
  'reactive_velocity',
  'sparkle',
  'fire',
  'scanner'
]);

const FIELDS = Object.freeze(['brightness', 'effect', 'hue', 'speed', 'intensity']);

const CC_OF = Object.freeze({
  brightness: CC.MASTER,
  effect:     CC.EFFECT,
  hue:        CC.HUE,
  speed:      CC.SPEED,
  intensity:  CC.INTENSITY
});

/** Bit position in `supported_mask`, one per CC field. */
export const CC_BIT = Object.freeze({
  brightness: 0x01,
  effect:     0x02,
  hue:        0x04,
  speed:      0x08,
  intensity:  0x10
});

export const MASK_ALL = 0x1F;

/** Returns true when the field's CC is declared supported by the device. */
export function isSupported(mask, field) {
  if (mask === undefined || mask === null) return false;
  const bit = CC_BIT[field];
  return bit !== undefined && ((mask & bit) !== 0);
}

const clamp7 = (v) => Math.max(0, Math.min(127, v | 0));

/** Whitelisted state shape, ready for persistence + transmission. */
export function defaultState() {
  return { brightness: 0, effect: 0, hue: 0, speed: 64, intensity: 64 };
}

/** Coerce + clamp every field of an arbitrary `state` to a valid value. */
export function normalizeState(state) {
  const out = defaultState();
  if (state && typeof state === 'object') {
    for (const f of FIELDS) {
      if (state[f] !== undefined && state[f] !== null) {
        out[f] = clamp7(state[f]);
      }
    }
  }
  return out;
}

/** Build one CC message in the easymidi envelope used by DeviceManager. */
export function ccMessage(channel, controller, value) {
  return {
    type: 'cc',
    data: {
      channel: clamp7(channel) & 0x0F,
      controller: clamp7(controller),
      value: clamp7(value)
    }
  };
}

/**
 * Build CC messages for every field whose bit is set in `mask`.
 * When `mask` is omitted, every field is emitted.
 */
export function messagesFor(channel, state, mask = MASK_ALL) {
  const s = normalizeState(state);
  return FIELDS
    .filter((f) => isSupported(mask, f))
    .map((f) => ccMessage(channel, CC_OF[f], s[f]));
}

/**
 * Only the CC messages whose value changed between `prev` and `next`, and
 * whose bit is set in `mask`.
 */
export function messagesForDiff(channel, prev, next, mask = MASK_ALL) {
  const p = normalizeState(prev);
  const n = normalizeState(next);
  return FIELDS
    .filter((f) => isSupported(mask, f) && p[f] !== n[f])
    .map((f) => ccMessage(channel, CC_OF[f], n[f]));
}

/** Effect index → display key. Unknown indexes fall back to 'static'. */
export function effectName(index) {
  const i = clamp7(index);
  return i < EFFECTS.length ? EFFECTS[i] : 'static';
}

/**
 * HSV hue 0-127 → RGB (0-255). Used by the UI for the live colour
 * preview swatch. `sat` and `val` default to 1 because the firmware
 * already applies brightness via CC 110.
 * @param {number} hue127
 * @param {number} [sat=1]
 * @param {number} [val=1]
 * @returns {{r:number,g:number,b:number}}
 */
export function hueToRgb(hue127, sat = 1, val = 1) {
  const h = ((clamp7(hue127) / 128) * 6) % 6;
  const c = val * sat;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = val - c;
  let r = 0, g = 0, b = 0;
  if (h < 1) { r = c; g = x; }
  else if (h < 2) { r = x; g = c; }
  else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; }
  else if (h < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}
