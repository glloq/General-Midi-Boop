/**
 * @file tests/lighting/l02-fakes.js
 * @description Shared hardware-free doubles for the L02 (lighting) audit
 * suites. No native module, no socket, no GPIO: every driver here is a plain
 * object implementing the {@link BaseLightingDriver} contract.
 *
 * Not a `*.test.js` file — Jest's `testMatch` ignores it; it is imported by the
 * `tests/lighting/*.test.js` suites.
 */

import BaseLightingDriver from '../../src/lighting/BaseLightingDriver.js';

/** Silent logger with recording buffers, so tests can assert on warnings. */
export function makeLogger() {
  const rec = { info: [], warn: [], error: [], debug: [] };
  return {
    _rec: rec,
    info: (m) => rec.info.push(String(m)),
    warn: (m) => rec.warn.push(String(m)),
    error: (m) => rec.error.push(String(m)),
    debug: (m) => rec.debug.push(String(m))
  };
}

/**
 * A configurable lighting driver double.
 *
 * Behaviours (all optional, all hardware-free):
 *  - `blockMs`   : busy-wait synchronously inside every write (slow driver)
 *  - `throwOn`   : Set of method names that throw (faulty driver)
 *  - `hang`      : write returns a promise that never settles (hung transport)
 *  - `connected` : reported by isConnected()
 */
export class FakeLightingDriver extends BaseLightingDriver {
  constructor(device = { id: 1, name: 'fake', type: 'fake', led_count: 8 }, logger = makeLogger()) {
    super(device, logger);
    this.connected = true;
    this.calls = [];
    this.blockMs = 0;
    this.throwOn = new Set();
    this.hang = false;
    this.disconnectCalls = 0;
    this.connectCalls = 0;
  }

  _maybeMisbehave(method) {
    if (this.throwOn.has(method)) {
      throw new Error(`FakeLightingDriver.${method} fault`);
    }
    if (this.blockMs > 0) {
      const until = Date.now() + this.blockMs;
      // Deliberate synchronous busy-wait: models a driver that does real work
      // (packet build, serial write, GPIO batch) on the caller's stack.
      while (Date.now() < until) {
        /* spin */
      }
    }
    if (this.hang) {
      return new Promise(() => {});
    }
    return undefined;
  }

  async connect() {
    this.connectCalls++;
    this.connected = true;
  }

  async _doDisconnect() {
    this.disconnectCalls++;
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    this.calls.push({ m: 'setColor', ledIndex, r, g, b, brightness });
    return this._maybeMisbehave('setColor');
  }

  setRange(startLed, endLed, r, g, b, brightness = 255) {
    this.calls.push({ m: 'setRange', startLed, endLed, r, g, b, brightness });
    return this._maybeMisbehave('setRange');
  }

  allOff() {
    this.calls.push({ m: 'allOff' });
    return this._maybeMisbehave('allOff');
  }

  /** Calls of a given method name. */
  of(method) {
    return this.calls.filter((c) => c.m === method);
  }

  reset() {
    this.calls = [];
  }
}

/** In-memory stand-in for the lighting slice of `Database`. */
export function makeDatabase({ devices = [], rules = [], groups = [] } = {}) {
  const state = { devices: [...devices], rules: [...rules], groups: [...groups] };
  return {
    _state: state,
    getLightingDevices: () => state.devices,
    getLightingDevice: (id) => state.devices.find((d) => d.id === id) || null,
    getAllEnabledLightingRules: () => state.rules.filter((r) => r.enabled !== false),
    getLightingRule: (id) => state.rules.find((r) => r.id === id) || null,
    getLightingGroups: () => state.groups,
    insertLightingGroup: (name, ids) => {
      state.groups.push({ name, device_ids: ids });
      return state.groups.length;
    },
    deleteLightingGroup: (name) => {
      state.groups = state.groups.filter((g) => g.name !== name);
    }
  };
}

/** Minimal rule factory matching the shape returned by LightingDatabase. */
export function rule(overrides = {}) {
  return {
    id: 1,
    name: 'r',
    device_id: 1,
    instrument_id: null,
    priority: 0,
    enabled: true,
    condition_config: {},
    action_config: { type: 'static', color: '#FF0000' },
    ...overrides
  };
}

/** Canonical `midi_message` envelope as emitted by DeviceManager. */
export function midiMessage(type, data, extra = {}) {
  return { device: 'fake-in', type, data, timestamp: Date.now(), ...extra };
}

/** Free the health-check interval a LightingManager starts in its constructor. */
export function hardStop(manager) {
  if (manager._healthCheckInterval) {
    clearInterval(manager._healthCheckInterval);
    manager._healthCheckInterval = null;
  }
  try {
    manager.effectsEngine.stopAllEffects();
  } catch {
    /* best effort */
  }
  for (const [, fade] of manager.activeFades) clearInterval(fade.interval);
  manager.activeFades.clear();
  if (manager._ledBatchTimers) {
    for (const t of manager._ledBatchTimers.values()) clearTimeout(t);
    manager._ledBatchTimers.clear();
  }
}

// ==================== local stub servers (no hardware, no LAN) ====================

import dgram from 'dgram';
import http from 'http';

/**
 * UDP sink on 127.0.0.1. Used as an Art-Net / sACN / OSC receiver.
 * @param {number} [port=0] 0 = ephemeral.
 */
export async function startUdpServer(port = 0) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const packets = [];
  const waiters = [];
  sock.on('message', (msg, rinfo) => {
    packets.push({ msg, rinfo });
    while (waiters.length && packets.length >= waiters[0].n) waiters.shift().resolve();
  });
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, '127.0.0.1', resolve);
  });
  return {
    port: sock.address().port,
    packets,
    /** Resolve once at least `n` packets have arrived (or reject after `ms`). */
    async waitFor(n, ms = 2000) {
      if (packets.length >= n) return;
      await new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`only ${packets.length}/${n} UDP packets after ${ms} ms`)),
          ms
        );
        waiters.push({
          n,
          resolve: () => {
            clearTimeout(t);
            resolve();
          }
        });
      });
    },
    close: () => new Promise((r) => sock.close(r))
  };
}

/**
 * HTTP stub on 127.0.0.1. `routes` maps `"METHOD /path"` to
 * `{ status, body }` or to a function `(req, body) => ({status, body})`.
 */
export async function startHttpServer(routes = {}, opts = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      requests.push({ method: req.method, path, body, headers: req.headers });
      if (opts.hang) return; // never answer: models an unresponsive controller
      const key = `${req.method} ${path}`;
      let route = routes[key] ?? routes['*'] ?? { status: 200, body: '{}' };
      if (typeof route === 'function') route = route(req, body);
      res.writeHead(route.status, { 'Content-Type': 'application/json' });
      res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    async waitFor(n, ms = 2000) {
      const deadline = Date.now() + ms;
      while (requests.length < n) {
        if (Date.now() > deadline)
          throw new Error(`only ${requests.length}/${n} HTTP requests after ${ms} ms`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      })
  };
}

/** Yield to the macrotask queue so `queueMicrotask`-batched renders flush. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
