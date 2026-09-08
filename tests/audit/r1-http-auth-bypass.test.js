/**
 * @file tests/audit/r1-http-auth-bypass.test.js
 * @description Wave 1 / R1 — F-114: the two forgeable HTTP auth bypasses.
 *
 * `src/api/HttpServer.js` used to open three gates before `_checkBearer`:
 *   1. `Sec-Fetch-Site: same-origin`      — forgeable by any non-browser client
 *   2. `Origin ∈ {localhost, 127.0.0.1, req.hostname}` — likewise (`req.hostname`
 *      comes from the `Host` header, which the attacker also controls)
 *   3. `isPrivateClient(req)`             — source address, NOT forgeable
 *
 * Measured on 2026-09-07 (10_SECURITY.md §9): `curl -H "Sec-Fetch-Site:
 * same-origin"` and `curl -H "Origin: http://127.0.0.1:8110"` both returned
 * 200 with no token, and a WRONG token returned 200 too, because the gates
 * were evaluated before the comparator was ever reached.
 *
 * Gates 1 and 2 are gone; gate 3 remains and is what `trusted-lan` means. To
 * prove that from a loopback test runner, the express app is mounted behind a
 * plain HTTP server that rewrites the peer address — the only value the old
 * gates ignored and the new one depends on.
 */
import { createServer } from 'http';
import HttpServer from '../../src/api/HttpServer.js';

const TOKEN = 'r1-http-token-0123456789abcdef';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Boot the real express app behind a socket whose `remoteAddress` we control.
 * @param {{mode?:string, remoteAddress?:string}} opts
 */
async function boot({ mode, remoteAddress = '127.0.0.1' } = {}) {
  const savedMode = process.env.GMBOOP_SECURITY_MODE;
  const savedToken = process.env.GMBOOP_API_TOKEN;
  if (mode === undefined) delete process.env.GMBOOP_SECURITY_MODE;
  else process.env.GMBOOP_SECURITY_MODE = mode;
  process.env.GMBOOP_API_TOKEN = TOKEN;

  const app = new HttpServer({
    logger: noopLogger,
    config: { server: { port: 0, host: '127.0.0.1' } },
    getCapabilityStatus: () => ({ overall: 'ok', capabilities: {} }),
    deviceManager: { getDeviceList: () => [] },
    midiRouter: { getRouteList: () => [] },
    database: { getFiles: () => [], getFileInfo: () => null },
    wsServer: { getStats: () => ({ clients: 0 }) }
  });

  const front = createServer((req, res) => {
    // `req.socket === req.connection`; express resolves `req.ip` from it via
    // proxy-addr. Overriding it here is exactly what a direct WAN client would
    // present, and what a forged header can never change.
    Object.defineProperty(req.socket, 'remoteAddress', {
      value: remoteAddress,
      configurable: true
    });
    app.expressApp(req, res);
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const { port } = front.address();

  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => front.close(r));
      if (savedMode === undefined) delete process.env.GMBOOP_SECURITY_MODE;
      else process.env.GMBOOP_SECURITY_MODE = savedMode;
      if (savedToken === undefined) delete process.env.GMBOOP_API_TOKEN;
      else process.env.GMBOOP_API_TOKEN = savedToken;
    }
  };
}

describe('R1 / F-114 — forged browser headers no longer bypass the token', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('a public-address client is refused despite Sec-Fetch-Site: same-origin', async () => {
    app = await boot({ remoteAddress: '203.0.113.7' });
    const res = await fetch(`${app.base}/api/status`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' }
    });
    expect(res.status).toBe(401);
  });

  it('a public-address client is refused despite a forged loopback Origin', async () => {
    app = await boot({ remoteAddress: '203.0.113.7' });
    const res = await fetch(`${app.base}/api/status`, {
      headers: { Origin: 'http://127.0.0.1:8080' }
    });
    expect(res.status).toBe(401);
  });

  it('a WRONG bearer token from a public address is refused (the comparator IS reached)', async () => {
    app = await boot({ remoteAddress: '203.0.113.7' });
    const res = await fetch(`${app.base}/api/status`, {
      headers: { Authorization: 'Bearer WRONG', 'Sec-Fetch-Site': 'same-origin' }
    });
    expect(res.status).toBe(401);
  });

  it('the RIGHT bearer token from a public address is accepted', async () => {
    app = await boot({ remoteAddress: '203.0.113.7' });
    const res = await fetch(`${app.base}/api/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    expect(res.status).toBe(200);
  });

  it('trusted-lan still lets a LAN browser through with no token — nobody is broken', async () => {
    app = await boot({ remoteAddress: '192.168.1.55' });
    const res = await fetch(`${app.base}/api/status`);
    expect(res.status).toBe(200);
  });

  it('trusted-lan still lets the loopback SPA through with no token', async () => {
    app = await boot({ remoteAddress: '127.0.0.1' });
    const res = await fetch(`${app.base}/api/status`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' }
    });
    expect(res.status).toBe(200);
  });

  it('secure mode refuses even the LAN client', async () => {
    app = await boot({ mode: 'secure', remoteAddress: '192.168.1.55' });
    const res = await fetch(`${app.base}/api/status`);
    expect(res.status).toBe(401);
  });

  it('the always-public endpoints stay public in both modes', async () => {
    app = await boot({ mode: 'secure', remoteAddress: '203.0.113.7' });
    for (const path of ['/api/health', '/api/update-status', '/api/capabilities']) {
      const res = await fetch(`${app.base}${path}`);
      expect(res.status).toBe(200);
    }
  });
});
