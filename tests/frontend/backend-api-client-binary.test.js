// tests/frontend/backend-api-client-binary.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import codec from '../../shared/BinaryFrameCodec.js';

const clientSource = readFileSync(
  resolve(__dirname, '../../public/js/api/BackendAPIClient.js'),
  'utf8'
);

/**
 * Loads BackendAPIClient into the jsdom global, stubs the WebSocket
 * constructor so we can pump frames manually, and returns the API
 * client instance + the stub socket.
 */
function setup() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  // Stub WebSocket
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
  // Mirror static OPEN constant used in BackendAPIClient.connected check.
  FakeWebSocket.OPEN = 1;
  globalThis.WebSocket = FakeWebSocket;

  // Execute the client source in current context. The source uses
  // top-level `class BackendAPIClient` (no module wrapper) so we attach
  // it to global by evaluating in a Function scope and returning the ref.
  const factory = new Function(clientSource + '; return BackendAPIClient;');
  const Client = factory();
  return { Client, sockets };
}

describe('BackendAPIClient — binary frame decoding', () => {
  let setupCtx;
  beforeEach(() => {
    setupCtx = setup();
  });

  it('sets binaryType=arraybuffer when connecting', async () => {
    const { Client, sockets } = setupCtx;
    const client = new Client('ws://test');
    const connectPromise = client.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].binaryType).toBe('arraybuffer');
    sockets[0]._open();
    await connectPromise;
  });

  it('decodes playback_position binary frame and emits to subscribers', async () => {
    const { Client, sockets } = setupCtx;
    const client = new Client('ws://test');
    const seen = [];
    client.on('playback_position', (p) => seen.push(p));
    const connectPromise = client.connect();
    sockets[0]._open();
    await connectPromise;

    const buf = codec.encodePlaybackPosition(12.5, 33.3);
    sockets[0]._message(buf);

    expect(seen).toHaveLength(1);
    expect(seen[0].position).toBeCloseTo(12.5, 5);
    expect(seen[0].percentage).toBeCloseTo(33.3, 3);
  });

  it('decodes tuner:pitch binary frame', async () => {
    const { Client, sockets } = setupCtx;
    const client = new Client('ws://test');
    const seen = [];
    client.on('tuner:pitch', (p) => seen.push(p));
    const cp = client.connect();
    sockets[0]._open();
    await cp;

    const buf = codec.encodeTunerPitch(442.0, 7.5, 69);
    sockets[0]._message(buf);

    expect(seen).toHaveLength(1);
    expect(seen[0].freqHz).toBeCloseTo(442.0, 2);
    expect(seen[0].cents).toBeCloseTo(7.5, 2);
    expect(seen[0].noteMidi).toBe(69);
  });

  it('decodes system_lag binary frame', async () => {
    const { Client, sockets } = setupCtx;
    const client = new Client('ws://test');
    const seen = [];
    client.on('system_lag', (p) => seen.push(p));
    const cp = client.connect();
    sockets[0]._open();
    await cp;

    const buf = codec.encodeSystemLag(42, 50);
    sockets[0]._message(buf);

    expect(seen).toEqual([{ lagMs: 42, thresholdMs: 50 }]);
  });

  it('falls back to JSON path for text frames', async () => {
    const { Client, sockets } = setupCtx;
    const client = new Client('ws://test');
    const seen = [];
    client.on('device_connected', (p) => seen.push(p));
    const cp = client.connect();
    sockets[0]._open();
    await cp;

    sockets[0]._message(
      JSON.stringify({
        type: 'event',
        event: 'device_connected',
        data: { id: 'foo' },
        timestamp: Date.now()
      })
    );

    expect(seen).toEqual([{ id: 'foo' }]);
  });

  it('logs and ignores malformed binary frames without crashing', async () => {
    const { Client, sockets } = setupCtx;
    const client = new Client('ws://test');
    const cp = client.connect();
    sockets[0]._open();
    await cp;

    const badBuf = new ArrayBuffer(2); // way too short
    expect(() => sockets[0]._message(badBuf)).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it('logs and ignores binary frame with unknown event code', async () => {
    const { Client, sockets } = setupCtx;
    const client = new Client('ws://test');
    const cp = client.connect();
    sockets[0]._open();
    await cp;

    const view = new DataView(new ArrayBuffer(8));
    view.setUint8(0, 0xb0); // magic
    view.setUint8(1, 0xff); // unknown code
    view.setUint16(2, 4, true);
    expect(() => sockets[0]._message(view.buffer)).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });
});
