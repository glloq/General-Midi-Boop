/**
 * @file tests/audit/l01-http-contract.test.js
 * @description Audit L01 — HTTP surface contract (F-10).
 *
 * Reproduced live on 2026-09-07 against a server on port 8101:
 *   GET /api/definitely-not-a-route -> 200 text/html, 615 825 bytes (the whole
 *   SPA shell) because the `app.get('*')` fallback catches unmatched /api paths.
 *   An API client cannot tell "no such endpoint" from "here is your page", and
 *   every typo'd path costs 615 KB (110 KB gzipped) instead of ~40 bytes.
 */
import HttpServer from '../../src/api/HttpServer.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Boot the real Express app on an ephemeral port. */
async function boot() {
  const previousToken = process.env.GMBOOP_API_TOKEN;
  delete process.env.GMBOOP_API_TOKEN; // exercise the unauthenticated path
  const deps = {
    logger: noopLogger,
    config: { server: { port: 0, host: '127.0.0.1' } },
    getCapabilityStatus: () => ({ overall: 'ok', capabilities: {} }),
    deviceManager: { getDeviceList: () => [] },
    midiRouter: { getRouteList: () => [] },
    database: { getFiles: () => [], getFileInfo: () => null },
    wsServer: { getStats: () => ({ clients: 0 }) }
  };
  const server = new HttpServer(deps);
  await server.start();
  const { port } = server.server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => server.server.close(r));
      if (previousToken !== undefined) process.env.GMBOOP_API_TOKEN = previousToken;
    }
  };
}

describe('L01 / F-10 — unmatched /api/* must be a JSON 404', () => {
  let app;
  beforeAll(async () => {
    app = await boot();
  }, 20000);
  afterAll(async () => {
    await app.close();
  });

  it('returns 404 JSON, not the SPA shell', async () => {
    const res = await fetch(`${app.base}/api/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'ERR_NOT_FOUND' });
  });

  it('answers an unsupported method on a real route with JSON, not HTML', async () => {
    const res = await fetch(`${app.base}/api/health`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('still serves the SPA shell for non-/api paths', async () => {
    const res = await fetch(`${app.base}/some/spa/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('leaves the real API routes untouched', async () => {
    const health = await fetch(`${app.base}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
    const caps = await fetch(`${app.base}/api/capabilities`);
    expect(caps.status).toBe(200);
  });
});
