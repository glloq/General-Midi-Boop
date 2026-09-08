/**
 * @file tests/audit/r11-waf-proxy-pinning.test.js
 * @description Wave 2 / R11 — F-109 (runtime half): `/api/waf/:filename`
 * replayed third-party JavaScript from OUR origin with no integrity check.
 *
 * Why that is worse than it sounds. The proxy exists to defeat CORB/ORB, and
 * it works — but ORB *was* the boundary. Once the file comes back through
 * `/api/waf/…`, the browser sees a same-origin script, so a
 * `script-src 'self'` CSP cannot see it at all: `/api/waf/…` IS `'self'`.
 * The frontend script-tags the result (`MidiSynthesizer.js` ~line 899) on
 * every legacy-bank preset load, for the life of the box — a box whose
 * WebSocket exposes `system_update`. Before this change, whatever the CDN
 * returned was executed, and cached for 30 days.
 *
 * The route is now fail-closed. This suite covers the three answers that
 * matter and proves the refusals happen WITHOUT an outbound request.
 */
import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import { createServer } from 'http';
import express from 'express';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createWafProxyRouter, _internal } from '../../src/api/wafProxyRoutes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Boot an express app carrying the proxy under /api/waf, on an ephemeral port. */
async function boot(options) {
  const app = express();
  app.use('/api/waf', createWafProxyRouter({ logger: noopLogger }, options));
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r))
  };
}

/**
 * An upstream that must never be reached in the refusal cases. Calling it is
 * itself the failure: `calls` is asserted to stay at 0.
 */
function spyUpstream(body) {
  const state = { calls: 0 };
  return [
    async (filename) => {
      state.calls++;
      state.last = filename;
      return { status: 200, body: Buffer.from(body) };
    },
    state
  ];
}

const servers = [];
async function open(options) {
  const s = await boot(options);
  servers.push(s);
  return s;
}

beforeEach(() => {
  // The in-memory cache is module-level and shared between routers.
  _internal.cache.clear();
});

afterAll(async () => {
  for (const s of servers) await s.close();
});

describe('R11 / F-109 — the WAF proxy only replays pinned bytes', () => {
  test('an unpinned filename is refused, and the CDN is never contacted', async () => {
    const [fetchImpl, spy] = spyUpstream('window.evil=1');
    const s = await open({ mode: 'pinned', checksums: {}, fetchImpl });
    const res = await fetch(`${s.base}/api/waf/0000_FluidR3_GM_sf2_file.js`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not pinned/i);
    // The point of failing closed: no outbound request at all. On an offline
    // box this is also the difference between an instant answer and an 8 s
    // hang on the CDN timeout.
    expect(spy.calls).toBe(0);
  });

  test('a pinned filename whose bytes match is served as JavaScript', async () => {
    const body = 'var _tone_0000_FluidR3_GM_sf2_file = {};';
    const [fetchImpl, spy] = spyUpstream(body);
    const s = await open({
      mode: 'pinned',
      checksums: { 'r11_match_sf2_file.js': sha(Buffer.from(body)) },
      fetchImpl
    });
    const res = await fetch(`${s.base}/api/waf/r11_match_sf2_file.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toBe(body);
    expect(spy.calls).toBe(1);
  });

  test('a pinned filename whose bytes differ is refused with 502 and NOT cached', async () => {
    const pinned = sha(Buffer.from('the artefact we vetted'));
    const [fetchImpl, spy] = spyUpstream('the artefact the mirror served');
    const s = await open({
      mode: 'pinned',
      checksums: { 'r11_mismatch_sf2_file.js': pinned },
      fetchImpl
    });

    const res = await fetch(`${s.base}/api/waf/r11_mismatch_sf2_file.js`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/integrity/i);

    // Caching a poisoned response would make one bad answer the answer
    // everyone gets for the next 30 days.
    expect(_internal.cache.has('r11_mismatch_sf2_file.js')).toBe(false);
    const again = await fetch(`${s.base}/api/waf/r11_mismatch_sf2_file.js`);
    expect(again.status).toBe(502);
    expect(spy.calls).toBe(2);
  });

  test('the mismatch is logged loudly, with both digests', async () => {
    const pinned = sha(Buffer.from('vetted'));
    const [fetchImpl] = spyUpstream('substituted');
    const errors = [];
    const app = express();
    app.use(
      '/api/waf',
      createWafProxyRouter(
        { logger: { ...noopLogger, error: (m) => errors.push(m) } },
        { mode: 'pinned', checksums: { 'r11_loud_sf2_file.js': pinned }, fetchImpl }
      )
    );
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await fetch(`http://127.0.0.1:${server.address().port}/api/waf/r11_loud_sf2_file.js`);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('SHA-256 mismatch');
    expect(errors[0]).toContain(pinned);
  });

  test('`off` answers 404 and never touches the network', async () => {
    const [fetchImpl, spy] = spyUpstream('x');
    const s = await open({ mode: 'off', checksums: {}, fetchImpl });
    const res = await fetch(`${s.base}/api/waf/0000_FluidR3_GM_sf2_file.js`);
    expect(res.status).toBe(404);
    expect(spy.calls).toBe(0);
  });

  test('`open` restores the pre-audit behaviour — deliberately, and it is logged', async () => {
    const warnings = [];
    const body = 'var whatever = 1;';
    const [fetchImpl, spy] = spyUpstream(body);
    const app = express();
    app.use(
      '/api/waf',
      createWafProxyRouter(
        { logger: { ...noopLogger, warn: (m) => warnings.push(m) } },
        { mode: 'open', fetchImpl }
      )
    );
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/waf/r11_open.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(spy.calls).toBe(1);
    expect(warnings.join('\n')).toMatch(/NO integrity check/);
  });

  test('the filename allowlist still runs first', async () => {
    const [fetchImpl, spy] = spyUpstream('x');
    const s = await open({ mode: 'open', fetchImpl });
    const res = await fetch(`${s.base}/api/waf/${encodeURIComponent('../etc/passwd.js')}`);
    expect(res.status).toBe(400);
    expect(spy.calls).toBe(0);
  });
});

describe('R11 / F-109 — mode and pin-table resolution', () => {
  const { resolveMode, loadChecksums } = _internal;

  test('the default mode is the fail-closed one', () => {
    const saved = process.env.GMBOOP_WAF_PROXY;
    try {
      delete process.env.GMBOOP_WAF_PROXY;
      expect(resolveMode()).toBe('pinned');
      process.env.GMBOOP_WAF_PROXY = 'nonsense';
      expect(resolveMode()).toBe('pinned');
      process.env.GMBOOP_WAF_PROXY = 'OPEN';
      expect(resolveMode()).toBe('open');
      process.env.GMBOOP_WAF_PROXY = 'off';
      expect(resolveMode()).toBe('off');
    } finally {
      if (saved === undefined) delete process.env.GMBOOP_WAF_PROXY;
      else process.env.GMBOOP_WAF_PROXY = saved;
    }
  });

  test('a missing or malformed pin table yields an EMPTY table, not a bypass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmboop-r11-'));
    try {
      expect(loadChecksums(noopLogger, join(dir, 'nope.json'))).toEqual({});
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{ not json');
      expect(loadChecksums(noopLogger, bad)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('documentation keys and malformed digests are ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmboop-r11-'));
    try {
      const f = join(dir, 'pins.json');
      const good = 'a'.repeat(64);
      writeFileSync(
        f,
        JSON.stringify({
          _README: ['how to fill this in'],
          'good.js': good.toUpperCase(),
          'short.js': 'abc',
          'notastring.js': 42
        })
      );
      expect(loadChecksums(noopLogger, f)).toEqual({ 'good.js': good });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the shipped pin table parses and carries its own instructions', () => {
    // It ships EMPTY on purpose: a digest must come from a download whose
    // provenance a human checked, never from whatever a mirror served during
    // a build. What must not happen is the file silently disappearing or
    // turning into a bypass.
    const raw = JSON.parse(readFileSync(join(ROOT, 'src/api/wafChecksums.json'), 'utf8'));
    expect(Array.isArray(raw._README)).toBe(true);
    expect(raw._README.join(' ')).toMatch(/sha256sum/);
    expect(loadChecksums(noopLogger, join(ROOT, 'src/api/wafChecksums.json'))).toEqual({});
  });
});
