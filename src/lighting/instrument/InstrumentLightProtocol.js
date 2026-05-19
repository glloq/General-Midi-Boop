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

/** Block 8 / Block 9 format version emitted/accepted by this codec. */
export const BLOCK_VERSION = 0x01;

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

  return {
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
}

/**
 * Serialize capability fields back into a Block 8 response (used by the
 * round-trip tests and the firmware reference doc generator).
 * @param {Object} caps
 * @returns {number[]}
 */
export function buildCapabilitiesResponse(caps) {
  const [lcL, lcM] = split14(caps.light_led_count || 0);
  return [
    SYSEX_START, SYSEX_CUSTOM, GMB_MFR, BLOCK_LIGHT_CAPS, DIR_RESPONSE,
    BLOCK_VERSION,
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
    clamp7(caps.light_min_interval_ms ?? 0),
    SYSEX_END
  ];
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
