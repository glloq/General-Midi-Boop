// tests/frontend/backend-api-client-events.test.js
//
// Audit C regression tests for BackendAPIClient event plumbing:
//   M1 — 'connected' must fire exactly once per connection. The server sends a
//        welcome frame ({type:'event', event:'connected'}) on open, so emitting
//        it from onopen too fired the event twice per connection.
//   N2 — an uncorrelated error frame ({type:'error', error} with no id/event)
//        must be surfaced as an 'error' event instead of being silently dropped,
//        but a response that carries an id must NOT be (avoids double-reporting a
//        command whose pending request already timed out).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const clientSource = readFileSync(
  resolve(__dirname, '../../public/js/api/BackendAPIClient.js'),
  'utf8'
);

function setup() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'blob';
      this.sent = [];
      sockets.push(this);
    }
    send(d) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({});
    }
    _open() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }
    _message(data) {
      if (this.onmessage) this.onmessage({ data });
    }
  }
  FakeWebSocket.OPEN = 1;
  globalThis.WebSocket = FakeWebSocket;

  const factory = new Function(clientSource + '; return BackendAPIClient;');
  const Client = factory();
  return { Client, sockets };
}

describe('BackendAPIClient — connection / error events (audit C)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits "connected" exactly once per connection (welcome frame is the sole source)', async () => {
    const { Client, sockets } = setup();
    const client = new Client('ws://test');
    const seen = [];
    client.on('connected', (d) => seen.push(d));

    const cp = client.connect();
    sockets[0]._open(); // onopen must NOT emit 'connected' anymore
    await cp;
    expect(seen).toHaveLength(0);

    // The server welcome frame drives the single 'connected', carrying version.
    sockets[0]._message(
      JSON.stringify({ type: 'event', event: 'connected', data: { version: '9.9' } })
    );
    expect(seen).toEqual([{ version: '9.9' }]);

    client.close();
  });

  it('surfaces an uncorrelated error frame (no id / no event) as an "error" event', async () => {
    const { Client, sockets } = setup();
    const client = new Client('ws://test');
    const errors = [];
    client.on('error', (e) => errors.push(e));

    const cp = client.connect();
    sockets[0]._open();
    await cp;

    sockets[0]._message(
      JSON.stringify({ type: 'error', error: 'Rate limit exceeded', timestamp: 1 })
    );
    expect(errors).toEqual([{ message: 'Rate limit exceeded', code: undefined }]);

    client.close();
  });

  it('does NOT surface an error response that carries an id (already-timed-out command)', async () => {
    const { Client, sockets } = setup();
    const client = new Client('ws://test');
    const errors = [];
    client.on('error', (e) => errors.push(e));

    const cp = client.connect();
    sockets[0]._open();
    await cp;

    // id present but no matching pending request → must be ignored, not
    // re-emitted as a spurious global error.
    sockets[0]._message(JSON.stringify({ id: 999, error: 'too late', timestamp: 1 }));
    expect(errors).toEqual([]);

    client.close();
  });
});
