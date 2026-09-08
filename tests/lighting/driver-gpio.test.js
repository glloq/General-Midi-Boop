/**
 * @file tests/lighting/driver-gpio.test.js
 * @description L02 / AB02 — the two Raspberry-Pi drivers exercised with their
 * native modules REPLACED by in-process fakes (`jest.unstable_mockModule`).
 * This covers the pin/channel validation, the virtual-index mapping and the
 * render batching that are unreachable on a host without `pigpio` /
 * `rpi-ws281x-native` bindings — no Pi, no LED strip.
 *
 * What this can NOT prove is left to L15: real WS281x timing, real PWM levels,
 * real current draw, DMA contention.
 */

import { jest } from '@jest/globals';

const pwmWrites = [];
class FakeGpio {
  static OUTPUT = 1;
  constructor(pin) {
    if (pin === 999) throw new Error('bad pin');
    this.pin = pin;
  }
  pwmWrite(v) {
    if (this.pin === 666) throw new Error('pwm fault');
    pwmWrites.push([this.pin, v]);
  }
}
jest.unstable_mockModule('pigpio', () => ({ default: { Gpio: FakeGpio } }));

const ws281x = {
  WS2812_STRIP: 0x00081000,
  initCalls: [],
  renders: 0,
  finalized: 0,
  init(cfg) {
    ws281x.initCalls.push(cfg);
  },
  render() {
    ws281x.renders++;
  },
  finalize() {
    ws281x.finalized++;
  }
};
jest.unstable_mockModule('rpi-ws281x-native', () => ({ default: ws281x }));

const { describe, test, expect, beforeEach } = await import('@jest/globals');
const { default: GpioLedDriver } = await import('../../src/lighting/GpioLedDriver.js');
const { default: GpioStripDriver } = await import('../../src/lighting/GpioStripDriver.js');
const { makeLogger, tick } = await import('./l02-fakes.js');

const device = (over = {}) => ({
  id: 1,
  name: 'pi',
  type: 'gpio',
  led_count: 4,
  enabled: true,
  connection_config: {},
  ...over
});

beforeEach(() => {
  pwmWrites.length = 0;
  ws281x.initCalls.length = 0;
  ws281x.renders = 0;
  ws281x.finalized = 0;
});

describe('L02 AB02 — GpioLedDriver (pigpio faked)', () => {
  test('a single-LED config defaults to pins 17/27/22', async () => {
    const d = new GpioLedDriver(device(), makeLogger());
    await d.connect();
    expect(d.isConnected()).toBe(true);
    expect(d.gpioInstances.length).toBe(1);
    expect([d.gpioInstances[0].r.pin, d.gpioInstances[0].g.pin, d.gpioInstances[0].b.pin]).toEqual([
      17, 27, 22
    ]);
  });

  test('a multi-LED config claims one RGB triple per LED', async () => {
    const d = new GpioLedDriver(
      device({
        connection_config: {
          leds: [
            { r: 1, g: 2, b: 3 },
            { r: 4, g: 5, b: 6 }
          ]
        }
      }),
      makeLogger()
    );
    await d.connect();
    expect(d.gpioInstances.length).toBe(2);
  });

  test('an LED whose pin cannot be claimed is dropped, the others still work', async () => {
    const logger = makeLogger();
    const d = new GpioLedDriver(
      device({
        connection_config: {
          leds: [
            { r: 999, g: 2, b: 3 },
            { r: 4, g: 5, b: 6 }
          ]
        }
      }),
      logger
    );
    await d.connect();
    expect(d.gpioInstances.length).toBe(1);
    expect(logger._rec.error.join(' ')).toMatch(/Failed to init GPIO LED 0/);
  });

  test('connect() refuses when NO LED could be initialised', async () => {
    const d = new GpioLedDriver(
      device({ connection_config: { leds: [{ r: 999, g: 2, b: 3 }] } }),
      makeLogger()
    );
    await expect(d.connect()).rejects.toThrow(/No GPIO LEDs could be initialized/);
    expect(d.isConnected()).toBe(false);
  });

  test('setColor writes brightness-scaled PWM values on the three pins', async () => {
    const d = new GpioLedDriver(device(), makeLogger());
    await d.connect();
    d.setColor(0, 200, 100, 0, 128);
    expect(pwmWrites).toEqual([
      [17, Math.round((200 * 128) / 255)],
      [27, Math.round((100 * 128) / 255)],
      [22, 0]
    ]);
  });

  test('an out-of-range LED index is ignored', async () => {
    const d = new GpioLedDriver(device(), makeLogger());
    await d.connect();
    d.setColor(7, 255, 255, 255, 255);
    expect(pwmWrites.length).toBe(0);
  });

  test('a pwmWrite fault is logged, not propagated', async () => {
    const logger = makeLogger();
    const d = new GpioLedDriver(
      device({ connection_config: { leds: [{ r: 666, g: 2, b: 3 }] } }),
      logger
    );
    await d.connect();
    expect(() => d.setColor(0, 1, 2, 3, 255)).not.toThrow();
    expect(logger._rec.warn.join(' ')).toMatch(/GPIO pwmWrite failed for LED 0/);
  });

  test('allOff drives every pin to 0 and disconnect releases the instances', async () => {
    const d = new GpioLedDriver(
      device({
        connection_config: {
          leds: [
            { r: 1, g: 2, b: 3 },
            { r: 4, g: 5, b: 6 }
          ]
        }
      }),
      makeLogger()
    );
    await d.connect();
    pwmWrites.length = 0;
    d.allOff();
    expect(pwmWrites.map((w) => w[1]).every((v) => v === 0)).toBe(true);
    expect(pwmWrites.length).toBe(6);

    await d.disconnect();
    expect(d.gpioInstances).toEqual([]);
    expect(d.isConnected()).toBe(false);
  });
});

describe('L02 AB02 — GpioStripDriver (rpi-ws281x-native faked)', () => {
  const strip = (over = {}) =>
    device({
      type: 'gpio_strip',
      connection_config: { strips: [{ channel: 0, gpio: 18, led_count: 4 }], ...over }
    });

  test('a valid single-strip config initialises the library with the right channel', async () => {
    const d = new GpioStripDriver(strip(), makeLogger());
    await d.connect();
    expect(d.isConnected()).toBe(true);
    expect(ws281x.initCalls[0]).toMatchObject({ freq: 800000, dma: 10 });
    expect(ws281x.initCalls[0].channels[0]).toMatchObject({ count: 4, gpio: 18 });
    expect(d._totalLeds).toBe(4);
  });

  test('two strips are concatenated into one virtual index space', async () => {
    const d = new GpioStripDriver(
      strip({
        strips: [
          { channel: 0, gpio: 18, led_count: 3 },
          { channel: 1, gpio: 13, led_count: 2 }
        ]
      }),
      makeLogger()
    );
    await d.connect();
    expect(d._totalLeds).toBe(5);
    d.setColor(4, 255, 0, 0, 255); // last LED of the second strip
    expect(d.pixelBuffers[1][1]).toBe(0xff0000);
    expect(d.pixelBuffers[0].every((v) => v === 0)).toBe(true);
  });

  test.each([
    ['no strip configured', { strips: [] }, /No strips configured/],
    [
      'more than 3 strips',
      { strips: [0, 1, 2, 3].map((i) => ({ channel: i, gpio: 18, led_count: 1 })) },
      /Maximum 3 strips/
    ],
    [
      'duplicate hardware channel',
      {
        strips: [
          { channel: 0, gpio: 18, led_count: 1 },
          { channel: 0, gpio: 12, led_count: 1 }
        ]
      },
      /Duplicate hardware channel/
    ],
    ['unknown channel', { strips: [{ channel: 9, gpio: 18, led_count: 1 }] }, /Invalid channel 9/],
    [
      'GPIO not wired to that channel',
      { strips: [{ channel: 0, gpio: 13, led_count: 1 }] },
      /GPIO 13 is not valid for channel 0/
    ]
  ])('rejects an impossible wiring: %s', async (_label, cfg, re) => {
    const d = new GpioStripDriver(strip(cfg), makeLogger());
    await expect(d.connect()).rejects.toThrow(re);
    expect(d.isConnected()).toBe(false);
  });

  test('colours are packed 0x00RRGGBB with brightness applied', async () => {
    const d = new GpioStripDriver(strip(), makeLogger());
    await d.connect();
    d.setColor(0, 255, 128, 0, 128);
    const expected =
      (Math.round((255 * 128) / 255) << 16) | (Math.round((128 * 128) / 255) << 8) | 0;
    expect(d.pixelBuffers[0][0]).toBe(expected);
  });

  test('several writes in one tick produce ONE render (microtask batching)', async () => {
    const d = new GpioStripDriver(strip(), makeLogger());
    await d.connect();
    ws281x.renders = 0;
    d.setColor(0, 1, 1, 1, 255);
    d.setColor(1, 2, 2, 2, 255);
    d.setRange(0, 3, 3, 3, 3, 255);
    await tick();
    expect(ws281x.renders).toBe(1);
  });

  test('setRange(-1) covers the whole virtual strip', async () => {
    const d = new GpioStripDriver(strip(), makeLogger());
    await d.connect();
    d.setRange(0, -1, 255, 255, 255, 255);
    expect([...d.pixelBuffers[0]]).toEqual([0xffffff, 0xffffff, 0xffffff, 0xffffff]);
  });

  test('named segments resolve and paint only their slice', async () => {
    const d = new GpioStripDriver(
      strip({
        strips: [{ channel: 0, gpio: 18, led_count: 4 }],
        segments: [{ name: 'left', start: 0, end: 1 }]
      }),
      makeLogger()
    );
    await d.connect();
    expect(d.getSegment('left')).toEqual({ name: 'left', start: 0, end: 1 });
    expect(d.getSegment('missing')).toBeNull();
    d.setSegmentColor('left', 255, 0, 0, 255);
    expect([...d.pixelBuffers[0]]).toEqual([0xff0000, 0xff0000, 0, 0]);
    d.setSegmentColor('missing', 0, 255, 0, 255); // no-op, no throw
    expect([...d.pixelBuffers[0]]).toEqual([0xff0000, 0xff0000, 0, 0]);
  });

  test('a render fault is logged, not propagated', async () => {
    const logger = makeLogger();
    const d = new GpioStripDriver(strip(), logger);
    await d.connect();
    ws281x.render = () => {
      throw new Error('DMA busy');
    };
    expect(() => d.allOff()).not.toThrow();
    expect(logger._rec.warn.join(' ')).toMatch(/GPIO Strip render failed/);
    ws281x.render = () => ws281x.renders++;
  });

  test('disconnect blacks the strip out and finalizes the library exactly once', async () => {
    const d = new GpioStripDriver(strip(), makeLogger());
    await d.connect();
    d.setRange(0, -1, 255, 255, 255, 255);
    await d.disconnect();
    expect([...d.pixelBuffers]).toEqual([]);
    expect(ws281x.finalized).toBe(1);
    expect(d.isConnected()).toBe(false);
  });
});
