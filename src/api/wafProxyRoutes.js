/**
 * @file src/api/wafProxyRoutes.js
 * @description Same-origin proxy for the WebAudioFont CDN
 * (surikov.github.io/webaudiofontdata/sound/).
 *
 * Why this exists: modern browsers' OpaqueResponseBlocking (Firefox) /
 * CORB (Chromium) intermittently refuse cross-origin <script> loads when
 * the Content-Type and request mode disagree. The drum preset files of
 * the WAF CDN trip ORB on several deployments (private networks, no
 * referer, brave-style strict modes). The melodic files often slip through
 * but drums consistently fail — which is why the very first install of a
 * fresh Pi sees instruments work but drums stay silent.
 *
 * Fix: serve every WAF file through our own origin. The backend fetches
 * the file once from the CDN, caches it in memory, and replays it for
 * subsequent requests. The browser only ever sees `/api/waf/...` URLs —
 * no cross-origin script load, no ORB.
 *
 * Falls back gracefully:
 *   - CDN reachable, file exists  → 200 with JS body
 *   - CDN reachable, 404          → 404 (synth fallback chain handles it)
 *   - CDN unreachable             → 502 (synth tries next candidate)
 *
 * The whole frontend reaches surikov.github.io through this proxy now;
 * the public CDN is never script-tagged directly. See MidiSynthesizer.js
 * `_buildDrumPresetEntry`, `createGMInstrumentMap`, and `_legacyJCLiveEntry`.
 */

import { Router } from 'express';
import https from 'https';

const CDN_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';

// Allowlist: only WAF data files. Anything else (relative paths, query
// strings, %-encoded slashes, …) is rejected before we hit the CDN.
const SAFE_FILENAME = /^[A-Za-z0-9_]{1,200}\.js$/;

// In-memory cache. Each WAF file is small (~5 KB melodic, up to ~80 KB
// for a drum note). Worst-case heap is bounded by the file count: 128
// melodic + 47 drums × 9 kits ≈ 600 entries × 80 KB = ~50 MB ceiling.
// We add a hard-cap to stay safe even when other consumers ever land here.
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 1024;
const cache = new Map(); // filename -> { body: Buffer, status: 200|404 }
let cacheBytes = 0;

// Robustness bounds for the upstream fetch. The host is pinned to CDN_BASE so
// this is not SSRF hardening — it stops a stalled TLS connection from pinning
// the client request open indefinitely, and an oversized/misbehaving upstream
// from buffering an unbounded body into memory (audit A2 M4). A real WAF file
// is ≤~80 KB, so 4 MB is a generous ceiling.
const CDN_FETCH_TIMEOUT_MS = 8000;
const MAX_CDN_BODY_BYTES = 4 * 1024 * 1024;

function cacheSet(filename, entry) {
  // Drop oldest entries until we fit. Map iteration is insertion order
  // so this gives us a naive FIFO eviction — good enough for WAF files
  // because they're effectively immutable; an evicted file is just
  // re-fetched on the next request.
  const incomingBytes = entry.body ? entry.body.length : 0;
  while (
    (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + incomingBytes > MAX_CACHE_BYTES) &&
    cache.size > 0
  ) {
    const [oldKey, oldVal] = cache.entries().next().value;
    cacheBytes -= oldVal.body ? oldVal.body.length : 0;
    cache.delete(oldKey);
  }
  cache.set(filename, entry);
  cacheBytes += incomingBytes;
}

function fetchFromCdn(filename) {
  return new Promise((resolve, reject) => {
    const url = CDN_BASE + filename;
    const req = https.get(url, { headers: { 'User-Agent': 'gmboop-waf-proxy/1' } }, (res) => {
      const chunks = [];
      let received = 0;
      res.on('data', (c) => {
        received += c.length;
        if (received > MAX_CDN_BODY_BYTES) {
          // Abort the request; the 'error' handler below rejects the promise.
          req.destroy(new Error('CDN response exceeds max size'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ status: 200, body: Buffer.concat(chunks) });
        } else if (res.statusCode === 404) {
          resolve({ status: 404, body: null });
        } else {
          reject(new Error(`CDN responded HTTP ${res.statusCode}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(CDN_FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`CDN fetch timed out after ${CDN_FETCH_TIMEOUT_MS}ms`));
    });
  });
}

/**
 * @param {{ logger: Object }} app
 * @returns {import('express').Router}
 */
export function createWafProxyRouter(app) {
  const router = Router();

  router.get('/:filename', async (req, res) => {
    const filename = req.params.filename;
    if (!SAFE_FILENAME.test(filename)) {
      return res.status(400).json({ error: 'Invalid WAF filename' });
    }

    const hit = cache.get(filename);
    if (hit) {
      if (hit.status === 404) return res.status(404).end();
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days
      return res.send(hit.body);
    }

    try {
      const result = await fetchFromCdn(filename);
      cacheSet(filename, result);
      if (result.status === 404) return res.status(404).end();
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      return res.send(result.body);
    } catch (err) {
      app.logger?.warn?.(`WAF proxy: CDN fetch failed for ${filename}: ${err.message}`);
      return res.status(502).json({ error: 'Upstream CDN unreachable' });
    }
  });

  return router;
}

// Exposed for unit tests.
export const _internal = { cache, fetchFromCdn, SAFE_FILENAME };
