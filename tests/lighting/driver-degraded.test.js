/**
 * @file tests/lighting/driver-degraded.test.js
 * @description L02 / AB02 + AB07 — the drivers whose transport is NOT available
 * on this host (no MQTT broker library, no WS281x binding, no serial adapter).
 * The contract under test is graceful degradation: `connect()` must fail
 * cleanly — a logged error, `connected === false`, no zombie client, no crash —
 * and every write on the un-connected driver must be an inert no-op.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import MqttLightDriver from '../../src/lighting/MqttLightDriver.js';
import SerialLedDriver from '../../src/lighting/SerialLedDriver.js';
import GpioLedDriver from '../../src/lighting/GpioLedDriver.js';
import GpioStripDriver from '../../src/lighting/GpioStripDriver.js';
import { makeLogger } from './l02-fakes.js';

const device = (over = {}) => ({
  id: 1,
  name: 'x',
  type: 'x',
  led_count: 4,
  enabled: true,
  connection_config: {},
  ...over
});

// R8 / F-156 — these two tests were the witnesses of a dead capability: `mqtt`
// was imported by the driver and declared nowhere, so MQTT lighting could not
// work on any installation while the README, the wiki and the UI promised it.
// The dependency is now declared, so the tests are INVERTED rather than
// deleted: they lock the fix instead of the defect.
describe('L02 F-34 / R8 — MqttLightDriver: `mqtt` is declared and the driver degrades cleanly', () => {
  test('R8 — `mqtt` is declared as an optional dependency and resolves', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    // Optional, like the other hardware-adjacent modules (pigpio,
    // rpi-ws281x-native): an installation without it must still boot.
    expect(pkg.optionalDependencies).toHaveProperty('mqtt');
    const mod = await import('mqtt');
    expect(typeof (mod.default?.connect ?? mod.connect)).toBe('function');
  });

  test('connect() against an unreachable broker fails cleanly and leaves no zombie client', async () => {
    const logger = makeLogger();
    const d = new MqttLightDriver(
      // Port 1 is reserved and never listening: ECONNREFUSED, no 10 s timeout.
      device({ type: 'mqtt', connection_config: { broker_url: 'mqtt://127.0.0.1:1' } }),
      logger
    );
    await expect(d.connect()).rejects.toThrow();
    expect(d.isConnected()).toBe(false);
    // The property that actually matters: a failed connect must not leave a
    // live client holding a socket and a reconnectPeriod=5000 timer, because
    // _initDriver discards an unregistered driver without calling disconnect().
    expect(d.client).toBeNull();
    expect(logger._rec.error.join(' ')).toMatch(/MQTT Light driver connect failed/);
  });

  test('a device of type "mqtt" configured in the DB degrades WITHOUT touching the MIDI path', async () => {
    // End-to-end through LightingManager._initDriver: the dynamic import()
    // failure must be caught there (like the optional transports), not escape
    // to the caller and not reach the MIDI dispatch. (L14 hand-off.)
    const { default: LightingManager } = await import('../../src/lighting/LightingManager.js');
    const { default: EventBus } = await import('../../src/core/EventBus.js');
    const logger = makeLogger();
    const bus = new EventBus(logger);
    const broadcasts = [];
    const m = new LightingManager({
      logger,
      database: {
        getLightingDevices: () => [
          {
            id: 1,
            name: 'Barre MQTT',
            type: 'mqtt',
            enabled: true,
            led_count: 30,
            connection_config: { broker_url: 'mqtt://127.0.0.1:1883' }
          }
        ],
        getAllEnabledLightingRules: () => [
          {
            id: 1,
            device_id: 1,
            instrument_id: null,
            enabled: true,
            priority: 0,
            condition_config: { trigger: 'any' },
            action_config: { type: 'static', color: '#FF0000' }
          }
        ],
        getLightingGroups: () => []
      },
      eventBus: bus,
      wsServer: { broadcast: (ev, d) => broadcasts.push([ev, d]) }
    });

    // _initDriver is async and fire-and-forget from loadDevices(); let it settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(m.drivers.size).toBe(0);
    expect(logger._rec.warn.join(' ')).toMatch(/Failed to connect lighting device "Barre MQTT"/);
    expect(broadcasts).toContainEqual([
      'lighting_device_status',
      expect.objectContaining({ deviceId: 1, connected: false })
    ]);

    // The only `error` line is the driver's own connect failure, logged once
    // during initialisation — nothing is logged per MIDI message afterwards.
    expect(logger._rec.error.length).toBe(1);
    expect(logger._rec.error[0]).toMatch(/MQTT Light driver connect failed/);

    // The MIDI path is untouched: the rule points at a device with no driver.
    const errorsBefore = logger._rec.error.length;
    for (let i = 0; i < 50; i++) {
      expect(() =>
        bus.emit('midi_message', {
          type: 'noteon',
          data: { channel: 0, note: 60 + i, velocity: 100 }
        })
      ).not.toThrow();
    }
    expect(logger._rec.error.length).toBe(errorsBefore);

    await m.shutdown();
  });

  test('every write on the failed driver is an inert no-op', async () => {
    const d = new MqttLightDriver(device({ type: 'mqtt' }), makeLogger());
    await d.connect().catch(() => {});
    expect(() => {
      d.setColor(0, 255, 0, 0, 255);
      d.setRange(0, 3, 255, 0, 0, 255);
      d.allOff();
    }).not.toThrow();
  });
});

describe('L02 AB07 — MQTT payload formats (client injected, no broker)', () => {
  function withFakeClient(firmware, ledCount = 3) {
    const published = [];
    const d = new MqttLightDriver(device({ type: 'mqtt', led_count: ledCount }), makeLogger());
    d.client = {
      connected: true,
      publish: (topic, message, opts) => published.push({ topic, message, opts })
    };
    d.baseTopic = 'gmboop/light';
    d.firmware = firmware;
    d.qos = 1;
    d.retain = true;
    d._currentColors = new Array(ledCount).fill(null).map(() => ({ r: 0, g: 0, b: 0 }));
    return { d, published };
  }

  test('wled: per-LED writes use the JSON API, ranges use the segment form', () => {
    const { d, published } = withFakeClient('wled');
    d.setColor(1, 255, 0, 0, 255);
    expect(published[0].topic).toBe('gmboop/light/api');
    expect(JSON.parse(published[0].message).seg[0].i).toEqual([1, [255, 0, 0]]);
    expect(published[0].opts).toEqual({ qos: 1, retain: true });

    published.length = 0;
    d.setRange(0, 2, 0, 255, 0, 255);
    expect(published.length).toBe(1); // one segment message, not 3
    expect(JSON.parse(published[0].message).seg[0].i).toEqual([0, 3, [0, 255, 0]]);
  });

  test('tasmota: Color1 hex + Dimmer percentage', () => {
    const { d, published } = withFakeClient('tasmota');
    d.setColor(0, 255, 10, 0, 128);
    expect(published.map((p) => [p.topic, p.message])).toEqual([
      ['gmboop/light/cmnd/Color1', '800500'],
      ['gmboop/light/cmnd/Dimmer', '50']
    ]);
  });

  test('esphome and generic use their documented topics', () => {
    const e = withFakeClient('esphome');
    e.d.setColor(2, 1, 2, 3, 255);
    expect(e.published[0].topic).toBe('gmboop/light/light/2/command');
    expect(JSON.parse(e.published[0].message)).toEqual({
      state: 'ON',
      color: { r: 1, g: 2, b: 3 },
      brightness: 255
    });

    const g = withFakeClient('generic');
    g.d.setColor(2, 1, 2, 3, 255);
    expect(g.published[0].topic).toBe('gmboop/light/set');
    expect(JSON.parse(g.published[0].message).led).toBe(2);
  });

  test('allOff publishes the firmware-specific off command and clears the colour cache', () => {
    for (const [fw, topic] of [
      ['wled', 'gmboop/light/api'],
      ['tasmota', 'gmboop/light/cmnd/Power'],
      ['esphome', 'gmboop/light/light/command'],
      ['generic', 'gmboop/light/set']
    ]) {
      const { d, published } = withFakeClient(fw);
      d.setColor(0, 255, 255, 255, 255);
      published.length = 0;
      d.allOff();
      expect(published[0].topic).toBe(topic);
      expect(d._currentColors[0]).toEqual({ r: 0, g: 0, b: 0 });
    }
  });

  test('nothing is published while the broker link is down', () => {
    const { d, published } = withFakeClient('generic');
    d.client.connected = false;
    d.setColor(0, 255, 0, 0, 255);
    expect(published.length).toBe(0);
  });
});

describe('L02 AB02 — SerialLedDriver without an adapter', () => {
  test('opening a non-existent port fails cleanly', async () => {
    const logger = makeLogger();
    const d = new SerialLedDriver(
      device({ type: 'serial', connection_config: { port: '/dev/ttyGMBOOP-absent' } }),
      logger
    );
    await expect(d.connect()).rejects.toThrow();
    expect(d.isConnected()).toBe(false);
    expect(logger._rec.error.join(' ')).toMatch(/Serial LED driver connect failed/);
  });

  test('writes on a driver with no open port are no-ops', () => {
    const d = new SerialLedDriver(device({ type: 'serial' }), makeLogger());
    expect(() => {
      d.setColor(0, 255, 0, 0, 255);
      d.allOff();
    }).not.toThrow();
  });

  test('the wire protocol is [0xAA, idx_lo, idx_hi, r, g, b, 0x55]', () => {
    const written = [];
    const d = new SerialLedDriver(device({ type: 'serial' }), makeLogger());
    d.port = { isOpen: true, write: (b) => written.push([...b]) };
    d.setColor(300, 200, 100, 50, 128);
    expect(written[0]).toEqual([0xaa, 300 & 0xff, (300 >> 8) & 0xff, 100, 50, 25, 0x55]);
    d.allOff();
    expect(written[1]).toEqual([0xaa, 0xff, 0xff, 0, 0, 0, 0x55]);
  });

  test('a synchronous write fault (ERR_STREAM_DESTROYED) is absorbed, not propagated', () => {
    const logger = makeLogger();
    const d = new SerialLedDriver(device({ type: 'serial' }), logger);
    d.port = {
      isOpen: true,
      write: () => {
        throw new Error('ERR_STREAM_DESTROYED');
      }
    };
    expect(() => d.setColor(0, 1, 2, 3, 255)).not.toThrow();
    expect(logger._rec.warn.join(' ')).toMatch(/Serial LED write failed/);
  });

  test('disconnect closes the port and drops the handle', async () => {
    let closed = false;
    const d = new SerialLedDriver(device({ type: 'serial' }), makeLogger());
    d.connected = true;
    d.port = {
      isOpen: true,
      write: () => {},
      close: (cb) => {
        closed = true;
        cb();
      }
    };
    await d.disconnect();
    expect(closed).toBe(true);
    expect(d.port).toBeNull();
    expect(d.isConnected()).toBe(false);
  });
});

describe('L02 AB02 — GPIO drivers on a host that is not a Raspberry Pi', () => {
  test('GpioLedDriver.connect() fails cleanly when no pin can be claimed', async () => {
    const logger = makeLogger();
    const d = new GpioLedDriver(
      device({ type: 'gpio', connection_config: { pins: { r: 17, g: 27, b: 22 } } }),
      logger
    );
    await expect(d.connect()).rejects.toThrow();
    expect(d.isConnected()).toBe(false);
    expect(logger._rec.error.join(' ')).toMatch(/GPIO LED driver connect failed/);
  });

  test('GpioStripDriver.connect() fails cleanly with no rpi-ws281x-native binding', async () => {
    const logger = makeLogger();
    const d = new GpioStripDriver(
      device({
        type: 'gpio_strip',
        connection_config: { strips: [{ channel: 0, gpio: 18, led_count: 8 }] }
      }),
      logger
    );
    await expect(d.connect()).rejects.toThrow();
    expect(d.isConnected()).toBe(false);
    expect(logger._rec.error.join(' ')).toMatch(/GPIO Strip driver connect failed/);
  });

  test('writes on the un-connected GPIO drivers are inert (no crash, no output)', async () => {
    const led = new GpioLedDriver(device({ type: 'gpio' }), makeLogger());
    const strip = new GpioStripDriver(device({ type: 'gpio_strip' }), makeLogger());
    await led.connect().catch(() => {});
    await strip.connect().catch(() => {});
    expect(() => {
      led.setColor(0, 255, 0, 0, 255);
      led.allOff();
      strip.setColor(0, 255, 0, 0, 255);
      strip.setRange(0, 3, 255, 0, 0, 255);
      strip.allOff();
      strip.getSegment('nope');
      strip.setSegmentColor('nope', 1, 2, 3);
    }).not.toThrow();
  });

  test('the manager tolerates a device type with no driver at all', async () => {
    // DRIVER_MAP lookup miss — e.g. a row hand-edited in the DB.
    const { default: LightingManager } = await import('../../src/lighting/LightingManager.js');
    const { default: EventBus } = await import('../../src/core/EventBus.js');
    const logger = makeLogger();
    const m = new LightingManager({
      logger,
      database: {
        getLightingDevices: () => [{ id: 1, name: 'x', type: 'laser', enabled: true }],
        getAllEnabledLightingRules: () => [],
        getLightingGroups: () => []
      },
      eventBus: new EventBus(logger),
      wsServer: null
    });
    expect(logger._rec.warn.join(' ')).toMatch(/No driver for lighting device type: laser/);
    expect(m.drivers.size).toBe(0);
    await m.shutdown();
  });
});
