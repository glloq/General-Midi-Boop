/**
 * @file tests/lighting/effects-and-profiles.test.js
 * @description L02 — the three remaining pure-logic units of the lighting
 * subsystem: the animated `LightingEffectsEngine`, the `BaseLightingDriver`
 * contract every driver inherits, and the `DmxFixtureProfiles` library.
 * No hardware, no timers left running (fake timers throughout).
 */

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import LightingEffectsEngine from '../../src/lighting/LightingEffectsEngine.js';
import BaseLightingDriver from '../../src/lighting/BaseLightingDriver.js';
import DMX_PROFILES, {
  getProfile,
  listProfiles,
  mapColorToFixture
} from '../../src/lighting/DmxFixtureProfiles.js';
import { makeLogger } from './l02-fakes.js';

const engines = [];
function engine() {
  const e = new LightingEffectsEngine(makeLogger());
  engines.push(e);
  return e;
}

/** Recording driver with the minimum surface the engine touches. */
function recorder(ledCount = 8) {
  const calls = [];
  return {
    device: { led_count: ledCount },
    calls,
    setColor: (...a) => calls.push(['setColor', ...a]),
    setRange: (...a) => calls.push(['setRange', ...a]),
    of: (m) => calls.filter((c) => c[0] === m)
  };
}

afterEach(() => {
  engines.forEach((e) => e.shutdown());
  engines.length = 0;
  jest.useRealTimers();
});

// ==================== effects engine ====================

describe('L02 — LightingEffectsEngine: lifecycle', () => {
  test('starting an effect twice on the same key replaces it (one timer, not two)', () => {
    jest.useFakeTimers();
    const e = engine();
    const d = recorder();
    e.startEffect('k', 'rainbow', d, { led_start: 0, led_end: 7, speed: 500 });
    e.startEffect('k', 'strobe', d, { led_start: 0, led_end: 7, speed: 500 });
    expect(e.activeEffects.size).toBe(1);
    expect(e.isRunning('k')).toBe(true);
    expect(e.getActiveEffects()[0].effectType).toBe('strobe');
  });

  test("stopEffectsForDriver stops only that driver's effects", () => {
    jest.useFakeTimers();
    const e = engine();
    const a = recorder();
    const b = recorder();
    e.startEffect('a', 'rainbow', a, { led_start: 0, led_end: 7 });
    e.startEffect('b', 'rainbow', b, { led_start: 0, led_end: 7 });
    e.stopEffectsForDriver(a);
    expect(e.isRunning('a')).toBe(false);
    expect(e.isRunning('b')).toBe(true);
  });

  test('stopAllEffects / shutdown clear every timer', () => {
    jest.useFakeTimers();
    const e = engine();
    const d = recorder();
    for (const k of ['a', 'b', 'c']) e.startEffect(k, 'fire', d, { led_start: 0, led_end: 7 });
    expect(e.activeEffects.size).toBe(3);
    e.shutdown();
    expect(e.activeEffects.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stopping an unknown key is a no-op', () => {
    const e = engine();
    expect(() => e.stopEffect('nope')).not.toThrow();
  });

  test('an unknown effect type is refused with a warning', () => {
    const logger = makeLogger();
    const e = new LightingEffectsEngine(logger);
    engines.push(e);
    e.startEffect('k', 'disco-inferno', recorder(), { led_start: 0, led_end: 7 });
    expect(e.activeEffects.size).toBe(0);
    expect(logger._rec.warn.join(' ')).toMatch(/Unknown effect type/);
  });

  test('led_end defaults to the whole strip when absent or -1', () => {
    jest.useFakeTimers();
    const e = engine();
    const d = recorder(4);
    e.startEffect('k', 'chase', d, { speed: 400 });
    jest.advanceTimersByTime(400);
    expect(d.of('setColor').length % 4).toBe(0);
    expect(
      d
        .of('setColor')
        .map((c) => c[1])
        .sort()
    ).toContain(3);
  });
});

describe('L02 — LightingEffectsEngine: tempo', () => {
  test('setBpm clamps to 20..300 and getBeatMs follows', () => {
    const e = engine();
    e.setBpm(5000);
    expect(e.getBpm()).toBe(300);
    e.setBpm(1);
    expect(e.getBpm()).toBe(20);
    e.setBpm(120);
    expect(e.getBeatMs()).toBe(500);
  });

  test('tapTempo averages the intervals between taps', () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const e = engine();
    e.tapTempo();
    jest.setSystemTime(500);
    e.tapTempo();
    jest.setSystemTime(1000);
    expect(e.tapTempo()).toBe(120); // 500 ms per beat
  });

  test('tapTempo keeps at most 8 taps and stays inside 20..300', () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const e = engine();
    for (let i = 0; i < 12; i++) {
      jest.setSystemTime(i * 10); // 10 ms → 6000 bpm, must clamp
      e.tapTempo();
    }
    expect(e._tapTimes.length).toBeLessThanOrEqual(8);
    expect(e.getBpm()).toBe(300);
  });
});

describe('L02 — LightingEffectsEngine: what each effect actually draws', () => {
  const run = (type, cfg = {}, ticks = 1, ledCount = 4) => {
    jest.useFakeTimers();
    const e = engine();
    const d = recorder(ledCount);
    e.startEffect('k', type, d, { led_start: 0, led_end: ledCount - 1, speed: 480, ...cfg });
    const period = e.activeEffects.get('k') ? 1 : 0;
    expect(period).toBe(1);
    jest.advanceTimersByTime(500 * ticks);
    return d;
  };

  test('strobe alternates the full range between colour and black', () => {
    const d = run('strobe', { color: '#00FF00' }, 1);
    const ranges = d.of('setRange');
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    const lit = ranges.filter((r) => r[3] + r[4] + r[5] > 0);
    const dark = ranges.filter((r) => r[3] + r[4] + r[5] === 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(dark.length).toBeGreaterThan(0);
    expect(lit[0].slice(3, 6)).toEqual([0, 255, 0]);
  });

  test('rainbow paints every LED with a distinct hue', () => {
    const d = run('rainbow', {}, 1, 4);
    const first = d.of('setColor').slice(0, 4);
    expect(first.length).toBe(4);
    const hues = new Set(first.map((c) => `${c[2]},${c[3]},${c[4]}`));
    expect(hues.size).toBe(4);
  });

  test('chase lights exactly one LED at a time and advances', () => {
    const d = run('chase', { color: '#FF0000' }, 1, 4);
    const frames = [];
    for (let i = 0; i + 4 <= d.of('setColor').length; i += 4) {
      frames.push(d.of('setColor').slice(i, i + 4));
    }
    for (const f of frames) {
      expect(f.filter((c) => c[2] + c[3] + c[4] > 0).length).toBe(1);
    }
    const positions = frames.map((f) => f.findIndex((c) => c[2] + c[3] + c[4] > 0));
    expect(new Set(positions).size).toBeGreaterThan(1);
  });

  test('chase with color2 paints the background instead of black', () => {
    const d = run('chase', { color: '#FF0000', color2: '#0000FF' }, 1, 4);
    const bg = d.of('setColor').filter((c) => c[4] === 255 && c[2] === 0);
    expect(bg.length).toBeGreaterThan(0);
  });

  test('fire stays in the warm half of the spectrum (r >= g >= b)', () => {
    const d = run('fire', {}, 1, 4);
    for (const c of d.of('setColor')) {
      const [, , r, g, b] = c;
      expect(r).toBeGreaterThanOrEqual(g);
      expect(g).toBeGreaterThanOrEqual(b);
    }
  });

  test('breathe modulates brightness while holding the colour', () => {
    const d = run('breathe', { color: '#FFFFFF' }, 2, 4);
    const bris = d.of('setRange').map((r) => r[6]);
    expect(new Set(bris).size).toBeGreaterThan(2);
    expect(Math.max(...bris)).toBeLessThanOrEqual(255);
    expect(Math.min(...bris)).toBeGreaterThanOrEqual(0);
  });

  test('sparkle with density 1 lights every LED', () => {
    const all = run('sparkle', { density: 1, color: '#FFFFFF' }, 1, 4);
    expect(all.of('setColor').every((c) => c[2] + c[3] + c[4] > 0)).toBe(true);
  });

  test('density 0 is unreachable: `config.density || 0.1` turns it into 10 %', () => {
    // Minor: `0` is falsy, so "never sparkle" cannot be expressed. Documented
    // rather than fixed — it is a UI-range question, not a defect.
    const none = run('sparkle', { density: 0, color: '#FFFFFF' }, 6, 8);
    const lit = none.of('setColor').filter((c) => c[2] + c[3] + c[4] > 0);
    expect(lit.length).toBeGreaterThan(0);
  });

  test('color_cycle writes one uniform colour per tick and moves through the wheel', () => {
    const d = run('color_cycle', {}, 2, 4);
    const colours = d.of('setRange').map((r) => `${r[3]},${r[4]},${r[5]}`);
    expect(new Set(colours).size).toBeGreaterThan(1);
  });

  test('wave interpolates between color and color2 along the strip', () => {
    const d = run('wave', { color: '#FFFFFF', color2: '#000000' }, 1, 4);
    const frame = d.of('setColor').slice(0, 4);
    expect(new Set(frame.map((c) => c[2])).size).toBeGreaterThan(1);
  });

  test('a driver that throws inside a tick stops that effect instead of recurring', () => {
    jest.useFakeTimers();
    const logger = makeLogger();
    const e = new LightingEffectsEngine(logger);
    engines.push(e);
    e.startEffect(
      'boom',
      'color_cycle',
      {
        device: { led_count: 4 },
        setColor: () => {},
        setRange: () => {
          throw new Error('driver fault');
        }
      },
      { led_start: 0, led_end: 3, speed: 480 }
    );
    jest.advanceTimersByTime(500);
    expect(e.activeEffects.size).toBe(0);
    expect(logger._rec.warn.join(' ')).toMatch(/failed, stopping it/);
  });
});

// ==================== BaseLightingDriver contract ====================

describe('L02 — BaseLightingDriver: the contract every driver inherits', () => {
  class Minimal extends BaseLightingDriver {
    constructor(ledCount = 4) {
      super({ id: 1, name: 'm', led_count: ledCount }, makeLogger());
      this.writes = [];
    }
    async connect() {
      this.connected = true;
    }
    setColor(i, r, g, b, bri = 255) {
      this.writes.push([i, r, g, b, bri]);
    }
  }

  test('validate() accepts a driver implementing connect + setColor', () => {
    expect(() => BaseLightingDriver.validate(new Minimal())).not.toThrow();
  });

  test('validate() names every missing method', () => {
    const broken = { constructor: { name: 'BrokenDriver' } };
    expect(() => BaseLightingDriver.validate(broken)).toThrow(
      /BrokenDriver.*missing required method\(s\): connect, setColor/
    );
  });

  test('the abstract stubs throw with the concrete class name', async () => {
    class Empty extends BaseLightingDriver {}
    const e = new Empty({ led_count: 1 }, makeLogger());
    await expect(e.connect()).rejects.toThrow(/Empty\.connect\(\) must be implemented/);
    expect(() => e.setColor(0, 0, 0, 0)).toThrow(/Empty\.setColor\(\) must be implemented/);
  });

  test('the default setRange loops setColor, and -1 means "to the end"', () => {
    const d = new Minimal(3);
    d.setRange(0, -1, 1, 2, 3, 200);
    expect(d.writes).toEqual([
      [0, 1, 2, 3, 200],
      [1, 1, 2, 3, 200],
      [2, 1, 2, 3, 200]
    ]);
  });

  test('the default allOff paints the whole strip black', () => {
    const d = new Minimal(2);
    d.allOff();
    expect(d.writes).toEqual([
      [0, 0, 0, 0, 0],
      [1, 0, 0, 0, 0]
    ]);
  });

  test('disconnect() is a template method: _doDisconnect, then state, then event', async () => {
    const order = [];
    class D extends Minimal {
      async _doDisconnect() {
        order.push(`doDisconnect:${this.connected}`);
      }
    }
    const d = new D();
    await d.connect();
    d.on('disconnected', () => order.push(`event:${d.connected}`));
    await d.disconnect();
    expect(order).toEqual(['doDisconnect:true', 'event:false']);
    expect(d.isConnected()).toBe(false);
  });

  test('_applyBrightness clamps BOTH inputs into 0..255', () => {
    const d = new Minimal();
    expect(d._applyBrightness(1000, 255)).toBe(255);
    expect(d._applyBrightness(-20, 255)).toBe(0);
    expect(d._applyBrightness(255, 1000)).toBe(255);
    expect(d._applyBrightness(255, -5)).toBe(0);
    expect(d._applyBrightness(200, 128)).toBe(100);
    expect(d._adjustColor(255, 128, 0, 128)).toEqual({ r: 128, g: 64, b: 0 });
  });

  test('_scheduleRender coalesces N calls into ONE _doRender', async () => {
    let renders = 0;
    class D extends Minimal {
      _doRender() {
        renders++;
      }
    }
    const d = new D();
    for (let i = 0; i < 10; i++) d._scheduleRender();
    await new Promise((r) => setTimeout(r, 0));
    expect(renders).toBe(1);
    d._scheduleRender();
    await new Promise((r) => setTimeout(r, 0));
    expect(renders).toBe(2);
  });

  test('a throw inside _doRender is absorbed, never an uncaughtException', async () => {
    const logger = makeLogger();
    class D extends BaseLightingDriver {
      constructor() {
        super({ led_count: 1 }, logger);
      }
      async connect() {}
      setColor() {}
      _doRender() {
        throw new Error('socket gone');
      }
    }
    const d = new D();
    d._scheduleRender();
    await new Promise((r) => setTimeout(r, 0));
    expect(logger._rec.warn.join(' ')).toMatch(/\[D\] render failed: socket gone/);
  });

  test('_drainSocket resolves on the next event-loop turn', async () => {
    const d = new Minimal();
    await expect(d._drainSocket()).resolves.toBeUndefined();
  });
});

// ==================== DMX fixture profiles ====================

describe('L02 — DmxFixtureProfiles', () => {
  test('every profile declares a channel count consistent with its map', () => {
    for (const [key, p] of Object.entries(DMX_PROFILES)) {
      expect(typeof p.name).toBe('string');
      expect(p.channels).toBeGreaterThan(0);
      const offsets = Object.values(p.map);
      expect(new Set(offsets).size).toBe(offsets.length); // no collision
      expect(Math.max(...offsets)).toBeLessThan(p.channels);
      expect(key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test('getProfile returns the profile or null', () => {
    expect(getProfile('generic_rgb')).toMatchObject({ channels: 3, map: { r: 0, g: 1, b: 2 } });
    expect(getProfile('no_such_fixture')).toBeNull();
  });

  test('listProfiles exposes key/name/channels for every entry', () => {
    const list = listProfiles();
    expect(list.length).toBe(Object.keys(DMX_PROFILES).length);
    expect(list.every((p) => p.key && p.name && p.channels > 0)).toBe(true);
    expect(list.map((p) => p.key)).toContain('generic_rgb');
  });

  test('mapColorToFixture places RGB at the declared offsets', () => {
    expect(mapColorToFixture('generic_rgb', 10, 20, 30)).toEqual([
      [0, 10],
      [1, 20],
      [2, 30]
    ]);
  });

  test('a dimmer channel receives the brightness, white/amber/uv default to 0', () => {
    const out = new Map(mapColorToFixture('generic_rgbwau', 1, 2, 3, 200));
    expect(out.get(3)).toBe(0); // white
    expect(out.get(4)).toBe(0); // amber
    expect(out.get(5)).toBe(0); // uv
    const par = new Map(mapColorToFixture('par_rgb_7ch', 1, 2, 3, 200));
    expect(par.get(0)).toBe(200); // dimmer
    expect(par.get(1)).toBe(1);
  });

  test('extras override the defaults, and pan/tilt centre at 128', () => {
    const wash = new Map(mapColorToFixture('wash_rgbw_6ch', 1, 2, 3, 255));
    expect(wash.get(0)).toBe(128); // pan centred
    expect(wash.get(1)).toBe(128); // tilt centred
    const moved = new Map(mapColorToFixture('wash_rgbw_6ch', 1, 2, 3, 255, { pan: 0, tilt: 255 }));
    expect(moved.get(0)).toBe(0);
    expect(moved.get(1)).toBe(255);
    const par = new Map(mapColorToFixture('par_rgb_7ch', 1, 2, 3, 255, { strobe: 42 }));
    expect(par.get(4)).toBe(42); // par_rgb_7ch declares `strobe` at offset 4
  });

  test('an unknown profile maps to an empty channel list, not an exception', () => {
    expect(mapColorToFixture('nope', 1, 2, 3)).toEqual([]);
  });

  test('a fixture with no colour channels (fog, laser) yields only its own controls', () => {
    expect(mapColorToFixture('fog_basic_2ch', 255, 255, 255, 255)).toEqual([]);
    expect(mapColorToFixture('generic_dimmer', 0, 0, 0, 180)).toEqual([[0, 180]]);
  });

  test('F-34b: profiles addressing more than RGB are unusable — `speed`, `mode`, `pattern`, `output`, `fan` are never emitted', () => {
    // `mapColorToFixture` only knows r/g/b/dimmer/w/a/uv/strobe/pan/tilt. Every
    // other declared attribute of the catalogue is silently dropped, so a fog
    // machine, a laser or a strobe cannot be driven through it at all.
    const unreachable = new Set();
    for (const [key, p] of Object.entries(DMX_PROFILES)) {
      const emitted = new Set(mapColorToFixture(key, 1, 2, 3, 4).map(([ch]) => ch));
      for (const [attr, ch] of Object.entries(p.map)) {
        if (!emitted.has(ch)) unreachable.add(attr);
      }
    }
    for (const attr of ['speed', 'mode', 'pattern', 'output', 'fan', 'gobo', 'prism', 'focus']) {
      expect([...unreachable]).toContain(attr);
    }
    // A fog machine and a laser end up with NO addressable channel at all.
    expect(mapColorToFixture('fog_basic_2ch', 1, 2, 3, 4)).toEqual([]);
    expect(mapColorToFixture('laser_basic_3ch', 1, 2, 3, 4)).toEqual([]);
  });
});
