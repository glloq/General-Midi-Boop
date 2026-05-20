// tests/instrument-light-protocol.test.js
// Round-trip + builder tests for the embedded-instrument lighting codec
// (SysEx Block 8 / Block 9, Note & CC builders).

import { describe, test, expect } from '@jest/globals';
import * as P from '../src/lighting/instrument/InstrumentLightProtocol.js';

describe('Block 8 — Lighting Capabilities', () => {
  test('request is 7 bytes and well-formed', () => {
    const req = P.buildCapabilitiesRequest(3);
    expect(req).toEqual([0xF0, 0x7D, 0x00, 0x08, 0x00, 3, 0xF7]);
  });

  test('response round-trips through build → parse', () => {
    const caps = {
      channel: 2,
      light_led_count: 200,
      light_addressing: P.ADDRESSING.PER_NOTE,
      light_note_base: 21,
      light_note_count: 88,
      light_color_mode: P.COLOR_MODE.RGB,
      light_palette_size: 0,
      light_transports: P.TRANSPORT.NOTE | P.TRANSPORT.SYSEX,
      light_channel: P.UNSET,
      light_cc_brightness: 102,
      light_cc_mode: P.UNSET,
      light_cc_effect: 104,
      light_cc_effect_speed: 105,
      light_cc_guide: P.UNSET,
      light_local_effects: 0,
      light_flags: P.CAP_FLAG.GUIDE,
      light_min_interval_ms: 5
    };
    const bytes = P.buildCapabilitiesResponse(caps, { version: P.BLOCK_VERSION });
    expect(bytes.length).toBe(25);
    expect(bytes[0]).toBe(0xF0);
    expect(bytes[bytes.length - 1]).toBe(0xF7);

    const parsed = P.parseCapabilitiesResponse(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed.channel).toBe(2);
    expect(parsed.light_led_count).toBe(200);
    expect(parsed.light_color_mode).toBe(P.COLOR_MODE.RGB);
    expect(parsed.light_transports).toBe(P.TRANSPORT.NOTE | P.TRANSPORT.SYSEX);
    expect(parsed.light_cc_brightness).toBe(102);
    expect(parsed.light_flags).toBe(P.CAP_FLAG.GUIDE);
    expect(parsed.light_min_interval_ms).toBe(5);
  });

  test('rejects malformed payloads', () => {
    expect(P.parseCapabilitiesResponse([0xF0, 0x7D, 0x00, 0x01, 0x01])).toBeNull();
    expect(P.parseCapabilitiesResponse([])).toBeNull();
    expect(P.parseCapabilitiesResponse(null)).toBeNull();
  });

  test('14-bit LED count survives split/join', () => {
    const caps = P.buildCapabilitiesResponse({ light_led_count: 12345 });
    expect(P.parseCapabilitiesResponse(caps).light_led_count).toBe(12345);
  });
});

describe('Block 8 v2 — Lighting Message Catalog', () => {
  const v2caps = {
    channel: 0,
    light_led_count: 16,
    light_color_mode: P.COLOR_MODE.RGB,
    light_transports: P.TRANSPORT.NOTE | P.TRANSPORT.SYSEX | P.TRANSPORT.CC,
    light_cc_brightness: 102,
    light_cc_effect: 104,
    light_local_effects: 0x01 | 0x02,        // fade + strobe
    light_flags: P.CAP_FLAG.GUIDE,
    light_cc_guide: 106,
    light_messages_bitmask:
      (1 << P.LIGHT_MSG.ALL_OFF) |
      (1 << P.LIGHT_MSG.BRIGHTNESS) |
      (1 << P.LIGHT_MSG.LED_RGB) |
      (1 << P.LIGHT_MSG.FX_FADE) |
      (1 << P.LIGHT_MSG.GUIDE)
  };

  test('v2 round-trip preserves the catalog bitmask', () => {
    const bytes = P.buildCapabilitiesResponse(v2caps);
    expect(bytes.length).toBe(28);
    expect(bytes[5]).toBe(P.BLOCK_VERSION_V2);
    const parsed = P.parseCapabilitiesResponse(bytes);
    expect(parsed.blockVersion).toBe(P.BLOCK_VERSION_V2);
    expect(parsed.light_messages_bitmask).toBe(v2caps.light_messages_bitmask);
  });

  test('v1 reply gets a derived bitmask from legacy fields', () => {
    const v1bytes = P.buildCapabilitiesResponse(v2caps, { version: P.BLOCK_VERSION });
    expect(v1bytes.length).toBe(25);
    expect(v1bytes[5]).toBe(P.BLOCK_VERSION);
    const parsed = P.parseCapabilitiesResponse(v1bytes);
    // RGB + SysEx ⇒ LED_RGB, RANGE_RGB, SET_ALL_RGB
    expect(parsed.light_messages_bitmask & (1 << P.LIGHT_MSG.LED_RGB)).not.toBe(0);
    expect(parsed.light_messages_bitmask & (1 << P.LIGHT_MSG.SET_ALL_RGB)).not.toBe(0);
    // CC effect + fade flag ⇒ FX_FADE
    expect(parsed.light_messages_bitmask & (1 << P.LIGHT_MSG.FX_FADE)).not.toBe(0);
    // Guide flag + cc_guide ⇒ GUIDE
    expect(parsed.light_messages_bitmask & (1 << P.LIGHT_MSG.GUIDE)).not.toBe(0);
  });

  test('messageCatalog() has 16 well-formed entries', () => {
    const cat = P.messageCatalog();
    expect(cat.length).toBe(16);
    for (let i = 0; i < cat.length; i++) {
      expect(cat[i].id).toBe(i);
      expect(typeof cat[i].label).toBe('string');
      expect(['control', 'color', 'effect', 'mode']).toContain(cat[i].category);
    }
  });

  test('21-bit split/join round-trips', () => {
    for (const v of [0, 1, 0x7F, 0x80, 0xFFFF, 0x1FFFFF]) {
      const [a, b, c] = P.split21(v);
      expect(P.join21(a, b, c)).toBe(v);
    }
  });
});

describe('Tier 1 — Note / velocity', () => {
  test('velocity > 0 → noteon, 0 → noteoff', () => {
    const on = P.noteColorMessage(4, 60, 100);
    expect(on.type).toBe('noteon');
    expect(on.data).toEqual({ channel: 4, note: 60, velocity: 100 });

    const off = P.noteColorMessage(4, 60, 0);
    expect(off.type).toBe('noteoff');
    expect(off.data.velocity).toBe(0);
  });
});

describe('Tier 2 — CC', () => {
  test('clamps to 7-bit and masks channel', () => {
    const m = P.ccMessage(20, 102, 300);
    expect(m.type).toBe('cc');
    expect(m.data).toEqual({ channel: 20 & 0x0F, controller: 102, value: 127 });
  });
});

describe('Tier 3 — SysEx control (Block 9)', () => {
  test('set LED encodes 14-bit index and 7-bit RGB', () => {
    const b = P.sysexSetLed(1, 130, 254, 0, 128);
    expect(b[0]).toBe(0xF0);
    expect(b[3]).toBe(0x09);
    expect(b[5]).toBe(P.CTRL.SET_LED);
    expect(b[6]).toBe(1);                 // channel
    expect(P.join14(b[7], b[8])).toBe(130); // led index
    expect(b[9]).toBe(127);               // 254 → 127
    expect(b[10]).toBe(0);
    expect(b[b.length - 1]).toBe(0xF7);
  });

  test('clear / brightness / all are well-formed', () => {
    expect(P.sysexClear(0)).toEqual([0xF0, 0x7D, 0x00, 0x09, 0x00, P.CTRL.CLEAR, 0, 0xF7]);
    const br = P.sysexBrightness(0, 255);
    expect(br[5]).toBe(P.CTRL.BRIGHTNESS);
    expect(br[7]).toBe(127);
  });

  test('bulk frames chunk under the byte budget', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ led: i, r: 10, g: 20, b: 30 }));
    const frames = P.sysexBulkFrames(0, entries, 64);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.length).toBeLessThanOrEqual(64);
      expect(f[0]).toBe(0xF0);
      expect(f[f.length - 1]).toBe(0xF7);
    }
  });
});

describe('hexToRgb', () => {
  test('parses with and without #', () => {
    expect(P.hexToRgb('#FF8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(P.hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(P.hexToRgb('bad')).toEqual({ r: 255, g: 255, b: 255 });
  });
});
