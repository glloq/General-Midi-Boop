// tests/instrument-light-protocol.test.js
// Pure-function tests for the CC-based instrument lighting helpers.

import { describe, test, expect } from '@jest/globals';
import * as CC from '../src/lighting/instrument/InstrumentLightCC.js';

describe('InstrumentLightCC — constants', () => {
  test('CC numbers are 110-114', () => {
    expect(CC.CC.MASTER).toBe(110);
    expect(CC.CC.EFFECT).toBe(111);
    expect(CC.CC.HUE).toBe(112);
    expect(CC.CC.SPEED).toBe(113);
    expect(CC.CC.INTENSITY).toBe(114);
  });

  test('EFFECTS lists the 10 specified effects in order', () => {
    expect(CC.EFFECTS).toEqual([
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
    expect(CC.effectName(0)).toBe('static');
    expect(CC.effectName(9)).toBe('scanner');
    expect(CC.effectName(99)).toBe('static');
  });
});

describe('InstrumentLightCC — state', () => {
  test('defaultState is OFF + speed/intensity 64', () => {
    expect(CC.defaultState()).toEqual({
      brightness: 0,
      effect: 0,
      hue: 0,
      speed: 64,
      intensity: 64
    });
  });

  test('normalizeState clamps every field to 0-127', () => {
    const s = CC.normalizeState({
      brightness: -5,
      effect: 200,
      hue: 64,
      speed: 999,
      intensity: 'x'
    });
    expect(s.brightness).toBe(0);
    expect(s.effect).toBe(127);
    expect(s.hue).toBe(64);
    expect(s.speed).toBe(127);
    expect(s.intensity).toBe(0);
  });

  test('normalizeState fills missing fields with defaults', () => {
    expect(CC.normalizeState({ brightness: 50 })).toEqual({
      brightness: 50,
      effect: 0,
      hue: 0,
      speed: 64,
      intensity: 64
    });
  });
});

describe('InstrumentLightCC — message builders', () => {
  test('ccMessage targets the right MIDI channel and clamps the value', () => {
    expect(CC.ccMessage(2, 110, 64)).toEqual({
      type: 'cc',
      data: { channel: 2, controller: 110, value: 64 }
    });
    expect(CC.ccMessage(99, 110, 999).data.channel).toBe(99 & 0x0f);
    expect(CC.ccMessage(0, 110, 999).data.value).toBe(127);
  });

  test('messagesFor returns the 5 CCs in order 110..114 when mask = ALL', () => {
    const msgs = CC.messagesFor(3, { brightness: 1, effect: 2, hue: 3, speed: 4, intensity: 5 });
    expect(msgs.map((m) => m.data.controller)).toEqual([110, 111, 112, 113, 114]);
    expect(msgs.map((m) => m.data.value)).toEqual([1, 2, 3, 4, 5]);
    for (const m of msgs) expect(m.data.channel).toBe(3);
  });

  test('messagesForDiff only emits changed fields when mask = ALL', () => {
    const prev = CC.defaultState();
    const next = { ...prev, hue: 64, intensity: 100 };
    const diff = CC.messagesForDiff(0, prev, next);
    expect(diff.map((m) => m.data.controller).sort()).toEqual([112, 114]);
    expect(diff.find((m) => m.data.controller === 112).data.value).toBe(64);
  });

  test('messagesForDiff returns nothing when state is identical', () => {
    const s = { brightness: 64, effect: 1, hue: 32, speed: 80, intensity: 90 };
    expect(CC.messagesForDiff(0, s, s)).toEqual([]);
  });
});

describe('InstrumentLightCC — supported_mask filtering', () => {
  test('CC_BIT exposes the per-CC bit positions', () => {
    expect(CC.CC_BIT.brightness).toBe(0x01);
    expect(CC.CC_BIT.effect).toBe(0x02);
    expect(CC.CC_BIT.hue).toBe(0x04);
    expect(CC.CC_BIT.speed).toBe(0x08);
    expect(CC.CC_BIT.intensity).toBe(0x10);
    expect(CC.MASK_ALL).toBe(0x1f);
  });

  test('isSupported reflects the mask bits', () => {
    expect(CC.isSupported(0x05, 'brightness')).toBe(true);
    expect(CC.isSupported(0x05, 'hue')).toBe(true);
    expect(CC.isSupported(0x05, 'effect')).toBe(false);
    expect(CC.isSupported(0, 'brightness')).toBe(false);
    expect(CC.isSupported(undefined, 'hue')).toBe(false);
  });

  test('messagesFor drops CCs whose bit is unset', () => {
    const st = { brightness: 1, effect: 2, hue: 3, speed: 4, intensity: 5 };
    const onlyHue = CC.messagesFor(0, st, CC.CC_BIT.hue);
    expect(onlyHue.length).toBe(1);
    expect(onlyHue[0].data.controller).toBe(112);
    expect(CC.messagesFor(0, st, 0)).toEqual([]);
  });

  test('messagesForDiff respects both the diff and the mask', () => {
    const prev = CC.defaultState();
    const next = { ...prev, brightness: 64, effect: 3, hue: 80 };
    // mask covers brightness + effect — hue change is silently dropped.
    const out = CC.messagesForDiff(0, prev, next, CC.CC_BIT.brightness | CC.CC_BIT.effect);
    expect(out.map((m) => m.data.controller).sort()).toEqual([110, 111]);
  });
});

describe('InstrumentLightCC — hueToRgb', () => {
  test('primary hues land on the expected RGB channels', () => {
    // hue 0 → exact red, hue 64 → exact cyan (h = 3.0 boundary).
    expect(CC.hueToRgb(0)).toEqual({ r: 255, g: 0, b: 0 });
    expect(CC.hueToRgb(64)).toEqual({ r: 0, g: 255, b: 255 });
    // Near-green (h ≈ 2): g dominates, r/b ~ 0.
    const green = CC.hueToRgb(43);
    expect(green.g).toBeGreaterThanOrEqual(250);
    expect(green.r).toBeLessThan(10);
    expect(green.b).toBeLessThan(10);
    // Near-blue (h ≈ 4): b dominates.
    const blue = CC.hueToRgb(85);
    expect(blue.b).toBe(255);
    expect(blue.r).toBeLessThan(10);
  });

  test('hue values out of range are clamped/wrapped safely', () => {
    expect(() => CC.hueToRgb(-1)).not.toThrow();
    expect(() => CC.hueToRgb(999)).not.toThrow();
    const rgb = CC.hueToRgb(64);
    for (const v of [rgb.r, rgb.g, rgb.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});
