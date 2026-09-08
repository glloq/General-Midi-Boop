/**
 * @file tests/audit/r6-static-asset-404.test.js
 * @description Wave 2 / R6 — F-119 / F-88: a missing static asset answered
 * `200 text/html` with the SPA shell instead of 404.
 *
 * Measured before the fix (audit L11, live server on 8111):
 *
 *   GET /lib/WebAudioFontPlayer.js
 *   -> HTTP 200 · Content-Type: text/html; charset=UTF-8 · 615 825 bytes
 *
 * Three consequences, all of them nasty:
 *   - the browser got 615 KB of HTML where it expected JavaScript, refused to
 *     execute it, and the SPA's `typeof … === 'undefined'` guard was therefore
 *     ALWAYS true — which is what made the CDN fallback unconditional (F-14);
 *   - no 404 ever appeared in the logs, so the defect was invisible to
 *     operations;
 *   - 615 KB spent per mistyped asset path.
 *
 * Same class as F-10 (`/api/*` → 200 + SPA), which L01 closed for the API
 * surface. This closes it for static assets. The server is booted for real —
 * the express app of `HttpServer`, not a mock.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createServer } from 'http';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import HttpServer, { ASSET_PATH } from '../../src/api/HttpServer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** Port assigned to this workstream; nothing else in the suite binds it. */
const PORT = Number(process.env.R6_TEST_PORT || 8301);

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let front = null;
let base = '';

beforeAll(async () => {
  const app = new HttpServer({
    logger: noopLogger,
    config: { server: { port: 0, host: '127.0.0.1' } },
    getCapabilityStatus: () => ({ overall: 'ok', capabilities: {} }),
    deviceManager: { getDeviceList: () => [] },
    midiRouter: { getRouteList: () => [] },
    database: { getFiles: () => [], getFileInfo: () => null },
    wsServer: { getStats: () => ({ clients: 0 }) }
  });
  front = createServer(app.expressApp);
  // Bind the workstream's assigned port, but fall back to an ephemeral one so
  // a stray process (or a parallel run) turns into a slightly different port
  // rather than a red suite: nothing here depends on the number.
  await new Promise((done, fail) => {
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE') {
        front.listen(0, '127.0.0.1', done);
        return;
      }
      fail(err);
    };
    front.once('error', onError);
    front.listen(PORT, '127.0.0.1', () => {
      front.removeListener('error', onError);
      done();
    });
  });
  base = `http://127.0.0.1:${front.address().port}`;
});

afterAll(async () => {
  if (front) await new Promise((r) => front.close(r));
});

describe('R6 / F-119 — a missing asset is a 404, never the SPA shell', () => {
  test('the vendored player, when absent, 404s instead of serving index.html', async () => {
    // Skipped only if a real postinstall actually put the file there — then
    // the other direction is asserted below.
    if (existsSync(join(ROOT, 'public/lib/WebAudioFontPlayer.js'))) return;
    const res = await fetch(`${base}/lib/WebAudioFontPlayer.js`);
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') || '').toMatch(/text\/plain/);
    // The old answer was 615 825 bytes of index.html.
    expect(body.length).toBeLessThan(200);
  });

  test('the vendored player, when present, is served as JavaScript', async () => {
    if (!existsSync(join(ROOT, 'public/lib/WebAudioFontPlayer.js'))) return;
    const res = await fetch(`${base}/lib/WebAudioFontPlayer.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toMatch(/javascript|ecmascript/);
  });

  test.each([
    '/lib/WebAudioFontPlayer.js',
    '/js/does-not-exist.js',
    '/styles/nope.css',
    '/locales/zz.json',
    '/assets/missing.svg',
    '/whatever.map'
  ])('%s never answers with the HTML shell', async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') || '').not.toMatch(/text\/html/);
  });

  test('a real static asset is still served', async () => {
    // If this file ever moves, move the guard with it rather than delete it:
    // it is what proves the 404 rule did not swallow the whole static tree.
    const asset = 'styles/accessibility-focus.css';
    expect(existsSync(join(ROOT, 'public', asset))).toBe(true);
    const res = await fetch(`${base}/${asset}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toMatch(/text\/css/);
  });

  test('the SPA fallback still answers extension-less paths', async () => {
    for (const path of ['/', '/settings', '/deep/route/without/extension']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') || '').toMatch(/text\/html/);
    }
  });

  test('an unknown /api path still answers JSON 404 (L01 F-10 stays fixed)', async () => {
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') || '').toMatch(/application\/json/);
  });
});

describe('R6 / F-119 — the asset-path predicate', () => {
  test.each(['/a.js', '/a/b.css', '/x.woff2', '/a.map', '/i.PNG', '/f.webmanifest'])(
    '%s is treated as an asset',
    (p) => {
      expect(ASSET_PATH.test(p)).toBe(true);
    }
  );

  test.each(['/', '/settings', '/a/b/c', '/trailing/'])('%s is treated as an SPA route', (p) => {
    expect(ASSET_PATH.test(p)).toBe(false);
  });
});
