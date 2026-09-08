/**
 * @file tests/lighting/driver-http.test.js
 * @description L02 / AB06 — `HttpLightDriver` (WLED `/json`, Philips Hue REST,
 * generic) driven against a local `node:http` stub server. No controller on the
 * LAN: the stub IS the WLED box.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import HttpLightDriver from '../../src/lighting/HttpLightDriver.js';
import { makeLogger, startHttpServer } from './l02-fakes.js';

let open = [];
afterEach(async () => {
  for (const o of open) {
    try {
      await o.close?.();
    } catch {
      /* already closed */
    }
  }
  open = [];
});
const track = (x) => (open.push(x), x);

const device = (over = {}) => ({
  id: 1,
  name: 'wled',
  type: 'http',
  led_count: 3,
  enabled: true,
  connection_config: {},
  ...over
});

async function driverFor(srv, cfg = {}, ledCount = 3) {
  const logger = makeLogger();
  const d = new HttpLightDriver(
    device({
      led_count: ledCount,
      connection_config: { base_url: srv.baseUrl, batch_delay_ms: 5, ...cfg }
    }),
    logger
  );
  track({ close: () => d.disconnect().catch(() => {}) });
  return { d, logger };
}

describe('L02 AB06 — connection handling', () => {
  test('a WLED controller answering /json/info connects', async () => {
    const srv = track(
      await startHttpServer({ 'GET /json/info': { status: 200, body: { name: 'w' } } })
    );
    const { d } = await driverFor(srv, { firmware: 'wled' });
    await d.connect();
    expect(d.isConnected()).toBe(true);
    expect(srv.requests[0]).toMatchObject({ method: 'GET', path: '/json/info' });
  });

  test('a WLED controller answering 404 refuses the connection', async () => {
    const srv = track(await startHttpServer({ '*': { status: 404, body: '{}' } }));
    const { d, logger } = await driverFor(srv, { firmware: 'wled' });
    await expect(d.connect()).rejects.toThrow(/HTTP test failed: 404/);
    expect(d.isConnected()).toBe(false);
    expect(logger._rec.error.join(' ')).toMatch(/connect failed/);
  });

  test('firmware "generic" connects even on a 404 (documented tolerance)', async () => {
    const srv = track(await startHttpServer({ '*': { status: 404, body: '{}' } }));
    const { d } = await driverFor(srv, {});
    await d.connect();
    expect(d.isConnected()).toBe(true);
  });

  test('a refused TCP connection surfaces as a connect failure', async () => {
    const srv = track(await startHttpServer());
    const url = srv.baseUrl;
    await srv.close();
    open = [];
    const logger = makeLogger();
    const d = new HttpLightDriver(device({ connection_config: { base_url: url } }), logger);
    await expect(d.connect()).rejects.toThrow();
    expect(d.isConnected()).toBe(false);
  });

  test('an api_key is turned into an Authorization header', async () => {
    const srv = track(await startHttpServer());
    const { d } = await driverFor(srv, { api_key: 's3cret' });
    await d.connect();
    expect(srv.requests[0].headers.authorization).toBe('Bearer s3cret');
  });

  test('an unresponsive controller times out after 5 s instead of hanging forever', async () => {
    const srv = track(await startHttpServer({}, { hang: true }));
    const { d } = await driverFor(srv, { firmware: 'wled' });
    const t0 = Date.now();
    await expect(d.connect()).rejects.toThrow();
    const ms = Date.now() - t0;
    process.stdout.write(`\n[L02 AB06] hung controller: connect() gave up after ${ms} ms\n`);
    expect(ms).toBeGreaterThan(4000);
    expect(ms).toBeLessThan(9000);
  }, 15000);
});

describe('L02 AB06 — write batching and payload shape', () => {
  test('a burst of per-LED writes coalesces into ONE WLED request', async () => {
    const srv = track(await startHttpServer({ 'GET /json/info': { status: 200, body: {} } }));
    const { d } = await driverFor(srv, { firmware: 'wled' });
    await d.connect();
    srv.requests.length = 0;

    d.setColor(0, 255, 0, 0, 255);
    d.setColor(1, 0, 255, 0, 255);
    d.setColor(2, 0, 0, 255, 255);
    await srv.waitFor(1);
    await new Promise((r) => setTimeout(r, 40));

    expect(srv.requests.length).toBe(1);
    const body = JSON.parse(srv.requests[0].body);
    expect(srv.requests[0].path).toBe('/json/state');
    expect(body.on).toBe(true);
    expect(body.seg[0].i).toEqual([0, [255, 0, 0], 1, [0, 255, 0], 2, [0, 0, 255]]);
  });

  test('the same LED written twice in a batch keeps only the last value', async () => {
    const srv = track(await startHttpServer({ 'GET /json/info': { status: 200, body: {} } }));
    const { d } = await driverFor(srv, { firmware: 'wled' });
    await d.connect();
    srv.requests.length = 0;
    d.setColor(0, 255, 0, 0, 255);
    d.setColor(0, 0, 0, 255, 255);
    await srv.waitFor(1);
    expect(JSON.parse(srv.requests[0].body).seg[0].i).toEqual([0, [0, 0, 255]]);
  });

  test('generic firmware posts /set with an explicit LED array', async () => {
    const srv = track(await startHttpServer());
    const { d } = await driverFor(srv);
    await d.connect();
    srv.requests.length = 0;
    d.setRange(0, 2, 10, 20, 30, 255);
    await srv.waitFor(1);
    expect(srv.requests[0].path).toBe('/set');
    expect(JSON.parse(srv.requests[0].body).leds).toEqual([
      { index: 0, r: 10, g: 20, b: 30, brightness: 255 },
      { index: 1, r: 10, g: 20, b: 30, brightness: 255 },
      { index: 2, r: 10, g: 20, b: 30, brightness: 255 }
    ]);
  });

  test('hue firmware issues one PUT per light with HSV values', async () => {
    const srv = track(await startHttpServer({ '*': { status: 200, body: '[]' } }));
    const { d } = await driverFor(srv, { firmware: 'hue', api_key: 'K' }, 2);
    await d.connect();
    srv.requests.length = 0;
    d.setColor(0, 255, 0, 0, 255);
    await srv.waitFor(1);
    expect(srv.requests[0]).toMatchObject({ method: 'PUT', path: '/api/K/lights/1/state' });
    const body = JSON.parse(srv.requests[0].body);
    expect(body).toMatchObject({ on: true, hue: 0 });
    expect(body.sat).toBe(254);
  });

  test('brightness is applied before the value leaves the process', async () => {
    const srv = track(await startHttpServer());
    const { d } = await driverFor(srv);
    await d.connect();
    srv.requests.length = 0;
    d.setColor(0, 200, 200, 200, 128);
    await srv.waitFor(1);
    expect(JSON.parse(srv.requests[0].body).leds[0]).toMatchObject({ r: 100, g: 100, b: 100 });
  });

  test('a 500 from the controller is swallowed and logged, never thrown', async () => {
    const srv = track(await startHttpServer({ '*': { status: 500, body: 'boom' } }));
    const { d, logger } = await driverFor(srv);
    await d.connect();
    d.setColor(0, 1, 2, 3, 255);
    await srv.waitFor(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(logger._rec.warn.filter((w) => /request failed/.test(w)).length).toBe(0); // 500 is a valid answer
  });

  test('a controller that disappears mid-session only logs a warning', async () => {
    const srv = track(await startHttpServer());
    const { d, logger } = await driverFor(srv);
    await d.connect();
    await srv.close();
    open = open.filter((o) => o !== srv);
    d.setColor(0, 1, 2, 3, 255);
    await new Promise((r) => setTimeout(r, 200));
    expect(logger._rec.warn.join(' ')).toMatch(/HTTP Light request failed/);
    expect(d.isConnected()).toBe(true); // no automatic reconnection/health state
  });
});

describe('L02 F-30b — the shutdown "off" request must actually be sent', () => {
  test('disconnect() only resolves after the off request reached the controller', async () => {
    const srv = track(await startHttpServer({ 'GET /json/info': { status: 200, body: {} } }));
    const { d } = await driverFor(srv, { firmware: 'wled' });
    await d.connect();
    srv.requests.length = 0;

    await d.disconnect();

    // No sleep, no polling: the request is already recorded when disconnect()
    // resolves. Before the fix `allOff()` was fire-and-forget and the process
    // could exit with the request still in flight.
    const off = srv.requests.find((r) => r.path === '/json/state');
    expect(off).toBeDefined();
    expect(JSON.parse(off.body)).toEqual({ on: false });
    expect(d.isConnected()).toBe(false);
  });

  test('hue disconnect turns every light off before resolving', async () => {
    const srv = track(await startHttpServer({ '*': { status: 200, body: '[]' } }));
    const { d } = await driverFor(srv, { firmware: 'hue', api_key: 'K' }, 3);
    await d.connect();
    srv.requests.length = 0;
    await d.disconnect();
    const offs = srv.requests.filter((r) => r.method === 'PUT');
    expect(offs.length).toBe(3);
    expect(JSON.parse(offs[0].body)).toEqual({ on: false });
  });

  test('the pending batch timer is cancelled on disconnect', async () => {
    const srv = track(await startHttpServer());
    const { d } = await driverFor(srv, { batch_delay_ms: 1000 });
    await d.connect();
    d.setColor(0, 1, 2, 3, 255);
    expect(d._batchTimer).not.toBeNull();
    await d.disconnect();
    expect(d._batchTimer).toBeNull();
    expect(d._pendingUpdates.size).toBe(0);
  });
});
