/**
 * @file tests/audit/r1-ws-security-mode.test.js
 * @description Wave 1 / R1 — F-108: `security.mode` must cover the WebSocket.
 *
 * Before this fix `securityMode` was read in `HttpServer.js` and nowhere else.
 * The WebSocket — 270 commands, `system_update` and `system_shutdown`
 * included — ignored it completely and accepted a client that presented no
 * token and merely forged `Origin` and `Host`. Reproduced live on
 * 2026-09-07 (docs/audit/2026-09-07/10_SECURITY.md §3): with
 * `GMBOOP_SECURITY_MODE=secure`, HTTP answered 401 while the WebSocket
 * answered `WS OPEN` and served `system_info` / `system_status`.
 *
 * The tests below drive a REAL `WebSocketServer` attached to a REAL
 * `HttpServer` and connect with a real `ws` client, exactly like the audit
 * did. Two properties are pinned:
 *   1. `secure` refuses the forged client (and accepts the token holder);
 *   2. `trusted-lan` (the default) still accepts it, so nobody's rig breaks.
 */
import { WebSocket } from 'ws';
import { createServer } from 'http';
import HttpServer from '../../src/api/HttpServer.js';
import WebSocketServer from '../../src/api/WebSocketServer.js';
import {
  resolveSecurityMode,
  isSecureMode,
  isLoopbackAddress,
  isPrivateAddress
} from '../../src/api/securityPolicy.js';

const PORT = 8201;
const TOKEN = 'r1-audit-token-0123456789abcdef';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Boot the real HTTP + WebSocket pair on {@link PORT}.
 * @param {{mode?:string, token?:?string}} opts
 */
async function boot({ mode, token = TOKEN } = {}) {
  const savedMode = process.env.GMBOOP_SECURITY_MODE;
  const savedToken = process.env.GMBOOP_API_TOKEN;
  if (mode === undefined) delete process.env.GMBOOP_SECURITY_MODE;
  else process.env.GMBOOP_SECURITY_MODE = mode;
  if (token === null) delete process.env.GMBOOP_API_TOKEN;
  else process.env.GMBOOP_API_TOKEN = token;

  const deps = {
    logger: noopLogger,
    config: { server: { port: PORT, host: '127.0.0.1' } },
    getCapabilityStatus: () => ({ overall: 'ok', capabilities: {} }),
    deviceManager: { getDeviceList: () => [] },
    midiRouter: { getRouteList: () => [] },
    database: { getFiles: () => [], getFileInfo: () => null },
    wsServer: { getStats: () => ({ clients: 0 }) },
    // Minimal dispatcher: echoes the command so an accepted socket can be
    // shown to actually reach the command surface.
    commandHandler: {
      handle: async (message, ws) => {
        ws.send(JSON.stringify({ id: message.id, type: 'response', command: message.command }));
      }
    }
  };

  const http = new HttpServer(deps);
  await http.start();
  const ws = new WebSocketServer(deps, http.server);
  ws.start();

  return {
    http,
    ws,
    base: `http://127.0.0.1:${PORT}`,
    async close() {
      ws.close();
      await new Promise((r) => http.server.close(r));
      if (savedMode === undefined) delete process.env.GMBOOP_SECURITY_MODE;
      else process.env.GMBOOP_SECURITY_MODE = savedMode;
      if (savedToken === undefined) delete process.env.GMBOOP_API_TOKEN;
      else process.env.GMBOOP_API_TOKEN = savedToken;
    }
  };
}

/**
 * Connect exactly like the audit's proof-of-concept: no token, `Origin` and
 * `Host` fabricated by hand (a browser would never let JS do this).
 * @param {string} [query]
 * @returns {Promise<{opened:boolean, status:?number}>}
 */
function forgedConnect(query = '') {
  return new Promise((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`, {
      headers: {
        Origin: `http://127.0.0.1:${PORT}`,
        Host: `127.0.0.1:${PORT}`
      }
    });
    const settle = (result) => {
      try {
        client.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    client.on('open', () => settle({ opened: true, status: null }));
    client.on('unexpected-response', (_req, res) =>
      settle({ opened: false, status: res.statusCode })
    );
    client.on('error', () => settle({ opened: false, status: null }));
  });
}

describe('R1 / F-108 — secure mode must cover the WebSocket', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('trusted-lan (default) still accepts the forged client — nobody is broken', async () => {
    app = await boot({ mode: undefined });
    const { opened } = await forgedConnect();
    expect(opened).toBe(true);
  }, 20000);

  it('secure refuses the forged client with 401', async () => {
    app = await boot({ mode: 'secure' });
    const { opened, status } = await forgedConnect();
    expect(opened).toBe(false);
    expect(status).toBe(401);
  }, 20000);

  it('secure still accepts the token holder', async () => {
    app = await boot({ mode: 'secure' });
    const { opened } = await forgedConnect(`?token=${TOKEN}`);
    expect(opened).toBe(true);
  }, 20000);

  it('secure refuses a WRONG token as well as a missing one', async () => {
    app = await boot({ mode: 'secure' });
    const wrong = await forgedConnect('?token=not-the-token');
    expect(wrong.opened).toBe(false);
    expect(wrong.status).toBe(401);
  }, 20000);

  it('secure closes HTTP and WS with the SAME answer (the audit found them divergent)', async () => {
    app = await boot({ mode: 'secure' });
    // HTTP was already closed before this fix...
    const http = await fetch(`${app.base}/api/status`, {
      headers: { 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${PORT}` }
    });
    expect(http.status).toBe(401);
    // ...the WebSocket was not.
    const { opened, status } = await forgedConnect();
    expect(opened).toBe(false);
    expect(status).toBe(401);
  }, 20000);

  it('secure mode is announced in the log so an operator can verify it', async () => {
    const lines = [];
    const savedMode = process.env.GMBOOP_SECURITY_MODE;
    process.env.GMBOOP_SECURITY_MODE = 'secure';
    process.env.GMBOOP_API_TOKEN = TOKEN;
    const deps = {
      logger: { ...noopLogger, info: (m) => lines.push(m) },
      config: { server: { port: PORT } },
      commandHandler: { handle: async () => {} }
    };
    const server = new WebSocketServer(deps, createServer());
    server.start();
    server.close();
    if (savedMode === undefined) delete process.env.GMBOOP_SECURITY_MODE;
    else process.env.GMBOOP_SECURITY_MODE = savedMode;
    expect(lines).toContain('WebSocket security mode: secure');
  });
});

describe('R1 / F-108 — the loopback shortcut is anchored on the source address', () => {
  /**
   * Drive `verifyClient` directly with a synthetic upgrade request: it is the
   * only way to present a peer address that is NOT loopback while the test
   * itself runs on loopback.
   */
  function verify({ remoteAddress, origin, host, url = '/' }) {
    const savedMode = process.env.GMBOOP_SECURITY_MODE;
    delete process.env.GMBOOP_SECURITY_MODE; // trusted-lan
    process.env.GMBOOP_API_TOKEN = TOKEN;
    const server = new WebSocketServer(
      {
        logger: noopLogger,
        config: { server: { port: PORT } },
        commandHandler: { handle: async () => {} }
      },
      createServer()
    );
    server.start();
    const verifyClient = server.wss.options.verifyClient;
    let accepted = null;
    verifyClient({ req: { url, headers: { origin, host }, socket: { remoteAddress } } }, (ok) => {
      accepted = ok;
    });
    server.close();
    if (savedMode === undefined) delete process.env.GMBOOP_SECURITY_MODE;
    else process.env.GMBOOP_SECURITY_MODE = savedMode;
    return accepted;
  }

  it('accepts a genuine loopback client that claims a loopback Origin', () => {
    expect(
      verify({
        remoteAddress: '127.0.0.1',
        origin: `http://127.0.0.1:${PORT}`,
        host: `127.0.0.1:${PORT}`
      })
    ).toBe(true);
  });

  it('refuses a LAN client that claims to be loopback and matches nothing else', () => {
    // Origin says 127.0.0.1, Host says the LAN IP: the two do not match, so the
    // same-origin gate cannot fire and only the (now anchored) loopback
    // shortcut could have let it through.
    expect(
      verify({
        remoteAddress: '192.168.1.55',
        origin: `http://127.0.0.1:${PORT}`,
        host: `192.168.1.42:${PORT}`
      })
    ).toBe(false);
  });

  it('still accepts an IPv6 loopback client (::1)', () => {
    expect(
      verify({
        remoteAddress: '::1',
        origin: `http://[::1]:${PORT}`,
        host: `[::1]:${PORT}`
      })
    ).toBe(true);
  });
});

describe('R1 — one shared resolver for the security mode (HTTP and WS cannot drift)', () => {
  const saved = process.env.GMBOOP_SECURITY_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GMBOOP_SECURITY_MODE;
    else process.env.GMBOOP_SECURITY_MODE = saved;
  });

  it('defaults to trusted-lan', () => {
    delete process.env.GMBOOP_SECURITY_MODE;
    expect(resolveSecurityMode(null)).toBe('trusted-lan');
    expect(resolveSecurityMode({ security: {} })).toBe('trusted-lan');
  });

  it('reads config.security.mode and lets the env var win', () => {
    delete process.env.GMBOOP_SECURITY_MODE;
    expect(isSecureMode({ security: { mode: 'secure' } })).toBe(true);
    expect(isSecureMode({ security: { mode: 'SeCuRe' } })).toBe(true);
    process.env.GMBOOP_SECURITY_MODE = 'secure';
    expect(isSecureMode({ security: { mode: 'trusted-lan' } })).toBe(true);
    process.env.GMBOOP_SECURITY_MODE = 'trusted-lan';
    expect(isSecureMode({ security: { mode: 'secure' } })).toBe(false);
  });

  it('treats an unknown mode as the documented default, never as secure', () => {
    process.env.GMBOOP_SECURITY_MODE = 'paranoid';
    expect(resolveSecurityMode(null)).toBe('trusted-lan');
  });
});

describe('R1 / F-114 — address predicates (headers are forgeable, peer addresses are not)', () => {
  it('recognises loopback in both families', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(ip)).toBe(true);
    }
    for (const ip of ['192.168.1.4', '10.0.0.1', '203.0.113.9', '', null, undefined]) {
      expect(isLoopbackAddress(ip)).toBe(false);
    }
  });

  it('recognises every private range, and refuses public addresses', () => {
    for (const ip of [
      '10.0.0.1',
      '192.168.1.42',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.1.1',
      '::ffff:192.168.1.42',
      'fd00::1',
      'fe80::1%eth0'
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});
