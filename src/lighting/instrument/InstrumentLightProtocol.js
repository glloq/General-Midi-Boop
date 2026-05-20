/**
 * @file src/lighting/instrument/InstrumentLightProtocol.js
 * @description Pure (no I/O) codec for the embedded-instrument lighting
 * protocol: SysEx Block 8 (Lighting Capabilities, request/response) and
 * Block 9 (Lighting Control, command-only), plus the Note/velocity and
 * CC builders for the 4-tier control scheme.
 *
 * Lineage (open-source conventions copied):
 *   - Note On, velocity = colour/brightness  → Novation Launchpad /
 *     Ableton Push / Synthesia LED / Piano LED Visualizer.
 *   - Per-LED RGB over SysEx                  → Launchpad Pro/X
 *     Programmer's Reference (re-homed under the GMB `F0 7D 00` prefix).
 *
 * All multi-byte numbers are 7-bit safe (0-127). RGB is carried as 7-bit
 * (0-127); the instrument firmware scales ×2 back to 0-254.
 */

export const SYSEX_START = 0xF0;
export const SYSEX_END = 0xF7;
export const SYSEX_CUSTOM = 0x7D;   // Educational/Development manufacturer
export const GMB_MFR = 0x00;        // GeneralMidiBoop manufacturer id

export const BLOCK_LIGHT_CAPS = 0x08;   // Block 8 — Lighting Capabilities
export const BLOCK_LIGHT_CTRL = 0x09;   // Block 9 — Lighting Control

export const DIR_REQUEST = 0x00;
export const DIR_RESPONSE = 0x01;

/** Feature-flag bit set in the Block 1 identity reply (bit 6). */
export const FEATURE_LIGHTING = 0x40;

/** Block 8 / Block 9 legacy format version (no message-catalog bitmask). */
export const BLOCK_VERSION = 0x01;
/** Block 8 v2 — adds the 16-bit lighting-message-catalog bitmask. */
export const BLOCK_VERSION_V2 = 0x02;

/** Sentinel meaning "use the instrument's own channel" / "not used". */
export const UNSET = 0x7F;

export const ADDRESSING = Object.freeze({
  GLOBAL: 0, PER_NOTE: 1, STRING_FRET: 2, ZONES: 3, STRIP: 4
});

export const COLOR_MODE = Object.freeze({
  ON_OFF: 0, DIMMABLE: 1, FIXED: 2, PALETTE: 3, RGB: 4
});

export const TRANSPORT = Object.freeze({
  AUTONOMOUS: 0x01, NOTE: 0x02, CC: 0x04, SYSEX: 0x08
});

export const CAP_FLAG = Object.freeze({
  GUIDE: 0x01, PER_TRACK_COLOR: 0x02, IDLE_ANIM: 0x04
});

export const CTRL = Object.freeze({
  SET_LED: 0x01, SET_RANGE: 0x02, SET_ALL: 0x03, CLEAR: 0x04,
  BRIGHTNESS: 0x05, PALETTE_ENTRY: 0x06, BULK_FRAME: 0x07, EFFECT: 0x08
});

/** Default CC numbers (MIDI "undefined" 102-111 range — collision-safe). */
export const DEFAULT_CC = Object.freeze({
  brightness: 102, mode: 103, effect: 104, effectSpeed: 105, guide: 106,
  allOff: 111
});

/**
 * Lighting Message Catalog — stable IDs (0-15) for the standard MIDI
 * messages a lit instrument may implement. Block 8 v2 carries a 16-bit
 * bitmask declaring which catalog entries are supported. Each entry maps
 * to a concrete CC or SysEx Block 9 sub-command (no new wire format).
 */
export const LIGHT_MSG = Object.freeze({
  ALL_OFF:        0,
  BRIGHTNESS:     1,
  LED_ONOFF:      2,
  LED_DIMMABLE:   3,
  LED_PALETTE:    4,
  LED_RGB:        5,
  RANGE_RGB:      6,
  SET_ALL_RGB:    7,
  PALETTE_UPLOAD: 8,
  FX_FADE:        9,
  FX_STROBE:     10,
  FX_CHASE:      11,
  FX_RAINBOW:    12,
  FX_BREATHE:    13,
  GUIDE:         14,
  IDLE_ANIM:     15
});

/**
 * Catalog metadata, consumed by the UI to render the supported-messages
 * checklist. The `key` is the i18n suffix (instrumentSettings.lightMsg.N).
 * `category`: 'control' | 'color' | 'effect' | 'mode'.
 * @returns {Array<{id:number, key:string, label:string, transport:string,
 *                  category:string}>}
 */
export function messageCatalog() {
  return [
    { id: 0,  key: 'lightMsg.allOff',       label: 'All Off',           transport: 'CC 111 = 0',                       category: 'control' },
    { id: 1,  key: 'lightMsg.brightness',   label: 'Master Brightness', transport: 'CC 102 = 0-127',                   category: 'control' },
    { id: 2,  key: 'lightMsg.ledOnOff',     label: 'LED On/Off',        transport: 'Note On (vel>0 / 0)',              category: 'color'   },
    { id: 3,  key: 'lightMsg.ledDimmable',  label: 'LED Dimmable',      transport: 'Note On vel=brightness',           category: 'color'   },
    { id: 4,  key: 'lightMsg.ledPalette',   label: 'LED Palette',       transport: 'Note On vel=palette idx',          category: 'color'   },
    { id: 5,  key: 'lightMsg.ledRgb',       label: 'LED RGB',           transport: 'SysEx 0x09/01 led rgb',            category: 'color'   },
    { id: 6,  key: 'lightMsg.rangeRgb',     label: 'Range RGB',         transport: 'SysEx 0x09/02 range rgb',          category: 'color'   },
    { id: 7,  key: 'lightMsg.setAllRgb',    label: 'Set All RGB',       transport: 'SysEx 0x09/03 rgb',                category: 'color'   },
    { id: 8,  key: 'lightMsg.paletteUpload', label: 'Palette Upload',   transport: 'SysEx 0x09/06 idx rgb',            category: 'color'   },
    { id: 9,  key: 'lightMsg.fxFade',       label: 'Effect: Fade',      transport: 'CC 104 = 1 (+ CC 105 speed)',      category: 'effect'  },
    { id: 10, key: 'lightMsg.fxStrobe',     label: 'Effect: Strobe',    transport: 'CC 104 = 2',                       category: 'effect'  },
    { id: 11, key: 'lightMsg.fxChase',      label: 'Effect: Chase',     transport: 'CC 104 = 3',                       category: 'effect'  },
    { id: 12, key: 'lightMsg.fxRainbow',    label: 'Effect: Rainbow',   transport: 'CC 104 = 4',                       category: 'effect'  },
    { id: 13, key: 'lightMsg.fxBreathe',    label: 'Effect: Breathe',   transport: 'CC 104 = 5',                       category: 'effect'  },
    { id: 14, key: 'lightMsg.guide',        label: 'Guide Mode',        transport: 'CC 106 = 0 / 127',                 category: 'mode'    },
    { id: 15, key: 'lightMsg.idleAnim',     label: 'Idle Animation',    transport: 'CC 104 = 7',                       category: 'mode'    }
  ];
}

/**
 * Derive the catalog bitmask from the legacy capability fields (Block 8
 * v1 firmwares). v2 firmwares transmit their own; this is the fallback.
 * @param {Object} caps
 * @returns {number} 16-bit bitmask
 */
export function deriveMessagesBitmask(caps) {
  const tr = caps.light_transports || 0;
  const cm = caps.light_color_mode || 0;
  const fx = caps.light_local_effects || 0;
  const fl = caps.light_flags || 0;
  const hasCC = (tr & TRANSPORT.CC) !== 0;
  const hasSysEx = (tr & TRANSPORT.SYSEX) !== 0;
  const hasNote = (tr & TRANSPORT.NOTE) !== 0;
  const ccSet = (n) => n !== undefined && n !== null && n !== UNSET;
  const set = (bit) => (1 << bit);
  let mask = 0;
  if ((hasCC && ccSet(caps.light_cc_brightness)) || hasSysEx) mask |= set(LIGHT_MSG.ALL_OFF) | set(LIGHT_MSG.BRIGHTNESS);
  if (hasNote && cm >= COLOR_MODE.ON_OFF)    mask |= set(LIGHT_MSG.LED_ONOFF);
  if (hasNote && cm >= COLOR_MODE.DIMMABLE)  mask |= set(LIGHT_MSG.LED_DIMMABLE);
  if (hasNote && cm === COLOR_MODE.PALETTE && (caps.light_palette_size || 0) > 0)
    mask |= set(LIGHT_MSG.LED_PALETTE);
  if (hasSysEx && cm === COLOR_MODE.RGB)
    mask |= set(LIGHT_MSG.LED_RGB) | set(LIGHT_MSG.RANGE_RGB) | set(LIGHT_MSG.SET_ALL_RGB);
  if (hasSysEx && cm === COLOR_MODE.PALETTE) mask |= set(LIGHT_MSG.PALETTE_UPLOAD);
  const fxAvailable = hasSysEx || (hasCC && ccSet(caps.light_cc_effect));
  if (fxAvailable) {
    if (fx & 0x01) mask |= set(LIGHT_MSG.FX_FADE);
    if (fx & 0x02) mask |= set(LIGHT_MSG.FX_STROBE);
    if (fx & 0x04) mask |= set(LIGHT_MSG.FX_CHASE);
    if (fx & 0x08) mask |= set(LIGHT_MSG.FX_RAINBOW);
    if (fx & 0x10) mask |= set(LIGHT_MSG.FX_BREATHE);
  }
  if ((fl & CAP_FLAG.GUIDE) && (hasSysEx || (hasCC && ccSet(caps.light_cc_guide))))
    mask |= set(LIGHT_MSG.GUIDE);
  if (fl & CAP_FLAG.IDLE_ANIM) mask |= set(LIGHT_MSG.IDLE_ANIM);
  return mask & 0xFFFF;
}

const clamp7 = (v) => Math.max(0, Math.min(127, v | 0));
const clamp14 = (v) => Math.max(0, Math.min(16383, v | 0));

/** Scale an 8-bit (0-255) channel down to 7-bit (0-127) for SysEx. */
export function to7bit(v) {
  return clamp7(Math.round(Math.max(0, Math.min(255, v)) / 2));
}

/** Split a 14-bit value into [lsb, msb] (7 bits each). */
export function split14(v) {
  const x = clamp14(v);
  return [x & 0x7F, (x >> 7) & 0x7F];
}

/** Recombine [lsb, msb] into a 14-bit number. */
export function join14(lsb, msb) {
  return (clamp7(lsb)) | (clamp7(msb) << 7);
}

/** Split a 21-bit value into [b0, b1, b2] (7 bits each). */
export function split21(v) {
  const x = Math.max(0, Math.min(0x1FFFFF, v | 0));
  return [x & 0x7F, (x >> 7) & 0x7F, (x >> 14) & 0x7F];
}

/** Recombine [b0, b1, b2] into a 21-bit number. */
export function join21(b0, b1, b2) {
  return clamp7(b0) | (clamp7(b1) << 7) | (clamp7(b2) << 14);
}

// ---------------------------------------------------------------------------
// Block 8 — Lighting Capabilities
// ---------------------------------------------------------------------------

/**
 * Build the Block 8 capabilities request for a channel.
 * `F0 7D 00 08 00 <channel> F7`
 * @param {number} channel 0-15
 * @returns {number[]}
 */
export function buildCapabilitiesRequest(channel) {
  return [
    SYSEX_START, SYSEX_CUSTOM, GMB_MFR, BLOCK_LIGHT_CAPS, DIR_REQUEST,
    clamp7(channel), SYSEX_END
  ];
}

/**
 * Parse a Block 8 capabilities reply. Returns null when `bytes` is not a
 * well-formed Block 8 response.
 * @param {number[]} bytes
 * @returns {?Object} capability fields (snake_case, ready for InstrumentLightDB)
 */
export function parseCapabilitiesResponse(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 25) return null;
  if (bytes[0] !== SYSEX_START || bytes[1] !== SYSEX_CUSTOM) return null;
  if (bytes[2] !== GMB_MFR || bytes[3] !== BLOCK_LIGHT_CAPS) return null;
  if (bytes[4] !== DIR_RESPONSE) return null;
  if (bytes[bytes.length - 1] !== SYSEX_END) return null;

  let p = 5;
  const blockVersion = bytes[p++];
  const channel = bytes[p++];
  const ledCount = join14(bytes[p], bytes[p + 1]); p += 2;
  const addressing = bytes[p++];
  const noteBase = bytes[p++];
  const noteCount = bytes[p++];
  const colorMode = bytes[p++];
  const paletteSize = bytes[p++];
  const transports = bytes[p++];
  const lightChannel = bytes[p++];
  const ccBrightness = bytes[p++];
  const ccMode = bytes[p++];
  const ccEffect = bytes[p++];
  const ccEffectSpeed = bytes[p++];
  const ccGuide = bytes[p++];
  const localEffects = bytes[p++];
  const flags = bytes[p++];
  const minIntervalMs = bytes[p++];

  const caps = {
    blockVersion,
    channel,
    light_led_count: ledCount,
    light_addressing: addressing,
    light_note_base: noteBase,
    light_note_count: noteCount,
    light_color_mode: colorMode,
    light_palette_size: paletteSize,
    light_transports: transports,
    light_channel: lightChannel,
    light_cc_brightness: ccBrightness,
    light_cc_mode: ccMode,
    light_cc_effect: ccEffect,
    light_cc_effect_speed: ccEffectSpeed,
    light_cc_guide: ccGuide,
    light_local_effects: localEffects,
    light_flags: flags,
    light_min_interval_ms: minIntervalMs
  };

  // v2 appends a 21-bit catalog bitmask (3 SysEx-safe bytes) before F7.
  // v1 firmwares omit it; we derive it from the legacy fields so the UI
  // can render a uniform supported-messages checklist either way.
  if (blockVersion >= BLOCK_VERSION_V2 && bytes.length >= 28 && p + 3 <= bytes.length - 1) {
    caps.light_messages_bitmask = join21(bytes[p], bytes[p + 1], bytes[p + 2]) & 0xFFFF;
  } else {
    caps.light_messages_bitmask = deriveMessagesBitmask(caps);
  }
  return caps;
}

/**
 * Serialize capability fields back into a Block 8 response (used by the
 * round-trip tests and the firmware reference doc generator).
 * @param {Object} caps
 * @returns {number[]}
 */
export function buildCapabilitiesResponse(caps, opts = {}) {
  const v2 = opts.version !== BLOCK_VERSION;
  const version = v2 ? BLOCK_VERSION_V2 : BLOCK_VERSION;
  const [lcL, lcM] = split14(caps.light_led_count || 0);
  const out = [
    SYSEX_START, SYSEX_CUSTOM, GMB_MFR, BLOCK_LIGHT_CAPS, DIR_RESPONSE,
    version,
    clamp7(caps.channel || 0),
    lcL, lcM,
    clamp7(caps.light_addressing ?? ADDRESSING.PER_NOTE),
    clamp7(caps.light_note_base ?? 0),
    clamp7(caps.light_note_count ?? 0),
    clamp7(caps.light_color_mode ?? COLOR_MODE.ON_OFF),
    clamp7(caps.light_palette_size ?? 0),
    clamp7(caps.light_transports ?? TRANSPORT.NOTE),
    clamp7(caps.light_channel ?? UNSET),
    clamp7(caps.light_cc_brightness ?? UNSET),
    clamp7(caps.light_cc_mode ?? UNSET),
    clamp7(caps.light_cc_effect ?? UNSET),
    clamp7(caps.light_cc_effect_speed ?? UNSET),
    clamp7(caps.light_cc_guide ?? UNSET),
    clamp7(caps.light_local_effects ?? 0),
    clamp7(caps.light_flags ?? 0),
    clamp7(caps.light_min_interval_ms ?? 0)
  ];
  if (v2) {
    const mask = (caps.light_messages_bitmask ?? deriveMessagesBitmask(caps)) & 0xFFFF;
    const [b0, b1, b2] = split21(mask);
    out.push(b0, b1, b2);
  }
  out.push(SYSEX_END);
  return out;
}

// ---------------------------------------------------------------------------
// Tier 1 — Note / velocity (Launchpad / Synthesia convention)
// ---------------------------------------------------------------------------

/**
 * Build a Note message addressing one LED.
 * @param {number} channel 0-15 lighting channel
 * @param {number} ledNote 0-127 (= MIDI note for per-note instruments)
 * @param {number} velocity 0-127 (0 = off; brightness or palette index)
 * @returns {{type:string,data:Object}}
 */
export function noteColorMessage(channel, ledNote, velocity) {
  const v = clamp7(velocity);
  return {
    type: v > 0 ? 'noteon' : 'noteoff',
    data: { channel: clamp7(channel) & 0x0F, note: clamp7(ledNote), velocity: v }
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — CC global controls
// ---------------------------------------------------------------------------

/**
 * Build a Control Change message.
 * @param {number} channel 0-15
 * @param {number} controller 0-127
 * @param {number} value 0-127
 * @returns {{type:string,data:Object}}
 */
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

// ---------------------------------------------------------------------------
// Tier 3 — SysEx RGB (Block 9, command-only)
// ---------------------------------------------------------------------------

function ctrl(sub, payload) {
  return [
    SYSEX_START, SYSEX_CUSTOM, GMB_MFR, BLOCK_LIGHT_CTRL, DIR_REQUEST,
    sub, ...payload, SYSEX_END
  ];
}

/** Set one LED to an 8-bit RGB colour. */
export function sysexSetLed(channel, ledIndex, r, g, b) {
  const [lsb, msb] = split14(ledIndex);
  return ctrl(CTRL.SET_LED, [
    clamp7(channel), lsb, msb, to7bit(r), to7bit(g), to7bit(b)
  ]);
}

/** Set an inclusive LED range to an 8-bit RGB colour. */
export function sysexSetRange(channel, startLed, endLed, r, g, b) {
  const [sL, sM] = split14(startLed);
  const [eL, eM] = split14(endLed);
  return ctrl(CTRL.SET_RANGE, [
    clamp7(channel), sL, sM, eL, eM, to7bit(r), to7bit(g), to7bit(b)
  ]);
}

/** Set every LED to one colour. */
export function sysexSetAll(channel, r, g, b) {
  return ctrl(CTRL.SET_ALL, [clamp7(channel), to7bit(r), to7bit(g), to7bit(b)]);
}

/** Turn every LED off. */
export function sysexClear(channel) {
  return ctrl(CTRL.CLEAR, [clamp7(channel)]);
}

/** Set the master brightness (0-255 → 7-bit). */
export function sysexBrightness(channel, brightness) {
  return ctrl(CTRL.BRIGHTNESS, [clamp7(channel), to7bit(brightness)]);
}

/** Upload one palette entry. */
export function sysexPaletteEntry(index, r, g, b) {
  return ctrl(CTRL.PALETTE_ENTRY, [
    clamp7(index), to7bit(r), to7bit(g), to7bit(b)
  ]);
}

/**
 * Build one or more bulk-frame messages from a list of
 * `{ led, r, g, b }` entries, chunked so each SysEx stays well under
 * `maxBytes`.
 * @param {number} channel
 * @param {Array<{led:number,r:number,g:number,b:number}>} entries
 * @param {number} [maxBytes=256]
 * @returns {number[][]} one byte array per chunk
 */
export function sysexBulkFrames(channel, entries, maxBytes = 256) {
  const perEntry = 5;            // led_lsb led_msb r g b
  const overhead = 8;            // header(5) + sub + count + F7
  const maxEntries = Math.max(1, Math.floor((maxBytes - overhead) / perEntry));
  const out = [];
  for (let i = 0; i < entries.length; i += maxEntries) {
    const slice = entries.slice(i, i + maxEntries);
    const payload = [clamp7(channel), clamp7(slice.length)];
    for (const e of slice) {
      const [lsb, msb] = split14(e.led);
      payload.push(lsb, msb, to7bit(e.r), to7bit(e.g), to7bit(e.b));
    }
    out.push(ctrl(CTRL.BULK_FRAME, payload));
  }
  return out;
}

/** Trigger a firmware-side effect. */
export function sysexEffect(channel, effectId, speed, r, g, b) {
  return ctrl(CTRL.EFFECT, [
    clamp7(channel), clamp7(effectId), clamp7(speed),
    to7bit(r), to7bit(g), to7bit(b)
  ]);
}

/** Parse "#RRGGBB" → {r,g,b} (0-255). Tolerates missing '#'. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xFF, g: (n >> 8) & 0xFF, b: n & 0xFF };
}
