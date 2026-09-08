/**
 * @file tests/audit/l01-ws-limiter.test.js
 * @description Audit L01 — WebSocket rate-limiter contract (F-06, F-07).
 *
 * Both defects were reproduced live on 2026-09-07 against a server on port
 * 8101 (see docs/audit/2026-09-07/01_API_CONTRACT.md §4):
 *   F-06 — the throttle notice carries no `id`, so the client's pending map
 *          cannot resolve it and the call hangs for its full 10 s timeout
 *          (measured: 40/100 commands hung 9 999-10 000 ms).
 *   F-07 — the limiter runs on the raw frame, so panic / all-notes-off /
 *          playback_stop are dropped like any other frame (measured: 13 of 19
 *          panic attempts silently dropped under a 200 msg/s flood).
 */
import WebSocketServer from '../../src/api/WebSocketServer.js';

const RATE_LIMIT_MAX_MESSAGES = 60;

function makeFakeWs() {
  const listeners = new Map();
  return {
    readyState: 1,
    sent: [],
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    emit(ev, ...args) {
      for (const fn of listeners.get(ev) ?? []) fn(...args);
    },
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
    close() {},
    ping() {},
    terminate() {}
  };
}

function makeServer(handled) {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const deps = {
    logger,
    config: { server: { port: 8101 } },
    commandHandler: {
      handle: async (msg, ws) => {
        handled.push(msg.command);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ id: msg.id, type: 'response', command: msg.command }));
        }
      }
    }
  };
  return new WebSocketServer(deps, null);
}

/** Drive `n` frames through the connection's message listener. */
async function flood(ws, frames) {
  for (const f of frames) ws.emit('message', Buffer.from(f));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('L01 / F-06 — the rate-limit error frame must be correlatable', () => {
  it('echoes the request id of the throttled frame', async () => {
    const handled = [];
    const server = makeServer(handled);
    const ws = makeFakeWs();
    server.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' } });
    ws.sent.length = 0; // drop the welcome frame

    const frames = [];
    for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES + 5; i++) {
      frames.push(JSON.stringify({ id: i + 1, command: 'device_list', data: {} }));
    }
    await flood(ws, frames);

    const throttled = ws.sent.filter((m) => m.error === 'Rate limit exceeded');
    expect(throttled.length).toBeGreaterThan(0);
    // Every throttle notice must carry the id of the frame it rejected, so the
    // client can settle that exact promise instead of waiting out its timeout.
    for (const m of throttled) {
      expect(m.id).toBeDefined();
    }
    expect(throttled.map((m) => m.id)).toEqual([61, 62, 63, 64, 65]);
    // and a machine-readable code, like every other error frame.
    expect(throttled[0].code).toBe('ERR_RATE_LIMITED');
  });

  it('omits the id rather than guessing when it is not the first key', async () => {
    const handled = [];
    const server = makeServer(handled);
    const ws = makeFakeWs();
    server.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' } });
    ws.sent.length = 0;

    const frames = [];
    for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
      frames.push(JSON.stringify({ id: i + 1, command: 'device_list' }));
    }
    // A nested "id" must never be mistaken for the envelope id.
    frames.push('{"data":{"id":"NESTED"},"command":"device_list"}');
    await flood(ws, frames);

    const throttled = ws.sent.filter((m) => m.error === 'Rate limit exceeded');
    expect(throttled).toHaveLength(1);
    expect(throttled[0].id).toBeUndefined();
  });
});

describe('L01 / F-07 — silencing commands must survive the limiter', () => {
  const PANIC = ['midi_panic', 'midi_all_notes_off', 'midi_reset', 'playback_stop'];

  it('dispatches panic-class commands even when the window budget is spent', async () => {
    const handled = [];
    const server = makeServer(handled);
    const ws = makeFakeWs();
    server.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' } });
    ws.sent.length = 0;

    const frames = [];
    for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES + 40; i++) {
      frames.push(JSON.stringify({ id: 'n' + i, command: 'midi_send_note', data: {} }));
    }
    for (const cmd of PANIC) frames.push(JSON.stringify({ id: cmd, command: cmd, data: {} }));
    await flood(ws, frames);

    for (const cmd of PANIC) {
      expect(handled).toContain(cmd);
    }
  });

  it('does not let the exemption become a rate-limit bypass', async () => {
    const handled = [];
    const server = makeServer(handled);
    const ws = makeFakeWs();
    server.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' } });
    ws.sent.length = 0;

    const frames = [];
    for (let i = 0; i < 500; i++) {
      frames.push(JSON.stringify({ id: 'p' + i, command: 'midi_panic', data: {} }));
    }
    await flood(ws, frames);

    const panics = handled.filter((c) => c === 'midi_panic').length;
    expect(panics).toBeGreaterThan(0);
    // The priority budget is small and separate — a panic flood must not be
    // able to push more work through than the normal budget allows.
    expect(panics).toBeLessThanOrEqual(RATE_LIMIT_MAX_MESSAGES + 10);
  });
});
