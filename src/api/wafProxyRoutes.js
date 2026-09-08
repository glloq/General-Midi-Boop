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
 *   - pinned file, digest matches  → 200 with JS body
 *   - filename not pinned          → 403, no outbound request (see INTEGRITY)
 *   - digest mismatch              → 502, not cached (see INTEGRITY)
 *   - CDN reachable, 404           → 404 (synth fallback chain handles it)
 *   - CDN unreachable              → 502 (synth tries next candidate)
 * Every refusal reaches the synth as a script load error, i.e. exactly what an
 * offline box already sees; the local SF2 banks are untouched.
 *
 * The whole frontend reaches surikov.github.io through this proxy now;
 * the public CDN is never script-tagged directly. See MidiSynthesizer.js
 * `_buildDrumPresetEntry`, `createGMInstrumentMap`, and `_legacyJCLiveEntry`.
 *
 * ---------------------------------------------------------------------------
 * INTEGRITY (audit L10 F-109) — read before loosening anything here.
 * ---------------------------------------------------------------------------
 * Working around ORB has a price nobody had priced in: this route replays
 * third-party JavaScript **from our own origin**, at runtime, on every preset
 * load, for the whole life of the box. ORB was the boundary; removing it turns
 * a cross-origin script into a same-origin one. A `script-src 'self'` CSP is
 * therefore powerless on this path — `/api/waf/…` *is* `'self'` — on an
 * appliance whose WebSocket exposes `system_update` and `hotspot_enable`.
 *
 * So the proxy is FAIL-CLOSED by default: it only replays bytes whose SHA-256
 * matches a pin committed in `wafChecksums.json`. Anything else is refused,
 * loudly, and never cached.
 *
 * Modes — `GMBOOP_WAF_PROXY`:
 *   `pinned` (default) only pinned filenames are fetched, and the body must
 *                      match the pinned digest. An unpinned name is refused
 *                      without any outbound request at all.
 *   `open`             pre-audit behaviour: replay whatever the CDN returns.
 *                      Logged as a warning at startup. Only for an operator
 *                      who has decided, explicitly, to accept that.
 *   `off`              the route answers 404 and never touches the network.
 *
 * The pin table ships empty on purpose: the digests must come from a download
 * whose provenance a human checked, not from whatever a mirror served during a
 * build. `wafChecksums.json` documents how to fill it. Empty table + default
 * mode = legacy WAF banks unavailable; the built-in `sf2:default` bank and
 * every imported SF2 are unaffected (they never come through here), and a
 * refusal surfaces exactly like an unreachable CDN, which is what an
 * offline-first box sees anyway.
 */

import { Router } from 'express';
import https from 'https';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CDN_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';

/** Where the pinned digests live. Overridable so tests can supply their own. */
const CHECKSUMS_PATH = process.env.GMBOOP_WAF_CHECKSUMS || path.join(__dirname, 'wafChecksums.json');

/** @returns {'pinned'|'open'|'off'} */
function resolveMode() {
  const raw = String(process.env.GMBOOP_WAF_PROXY || '').trim().toLowerCase();
  return raw === 'open' || raw === 'off' ? raw : 'pinned';
}

/**
 * Read the pinned digest table. Keys starting with `_` are documentation, not
 * filenames. A missing or malformed file yields an EMPTY table — which, in the
 * default mode, refuses everything. Failing closed on a broken pin file is the
 * only safe reading of "I could not tell whether these bytes are the right
 * ones".
 *
 * @param {Object} [logger]
 * @param {string} [filePath]
 * @returns {Record<string,string>}
 */
function loadChecksums(logger, filePath = CHECKSUMS_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)) out[k] = v.toLowerCase();
    }
    return out;
  } catch (err) {
    logger?.warn?.(
      `WAF proxy: could not read pinned checksums at ${filePath} (${err.message}) — ` +
        'treating the table as empty, so every file is refused in `pinned` mode.'
    );
    return {};
  }
}

/** @param {Buffer} buf */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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
 * @param {Object} [options] - test seams only (mode, fetchImpl, checksums)
 * @returns {import('express').Router}
 */
export function createWafProxyRouter(app, options = {}) {
  const router = Router();
  // `options` exists so the tests can drive the integrity path without a
  // network round-trip; production callers pass nothing.
  const mode = options.mode || resolveMode();
  const fetchImpl = options.fetchImpl || fetchFromCdn;
  const pins = options.checksums || (mode === 'open' ? {} : loadChecksums(app?.logger));

  if (mode === 'open') {
    app?.logger?.warn?.(
      'WAF proxy: GMBOOP_WAF_PROXY=open — third-party JavaScript is replayed from this ' +
        'origin with NO integrity check. A `script-src \'self\'` CSP does not cover it ' +
        '(audit L10 F-109).'
    );
  } else if (mode === 'pinned' && Object.keys(pins).length === 0) {
    app?.logger?.info?.(
      `WAF proxy: no pinned checksums in ${CHECKSUMS_PATH} — legacy WAF CDN banks are ` +
        'refused. The built-in sf2:default bank and imported SF2 banks are unaffected.'
    );
  }

  router.get('/:filename', async (req, res) => {
    const filename = req.params.filename;
    if (!SAFE_FILENAME.test(filename)) {
      return res.status(400).json({ error: 'Invalid WAF filename' });
    }

    if (mode === 'off') {
      return res.status(404).json({ error: 'WAF proxy disabled' });
    }

    const expected = pins[filename];
    if (mode === 'pinned' && !expected) {
      // Refused BEFORE any outbound request: nothing unpinned is ever fetched,
      // let alone replayed same-origin. Also means an offline box answers
      // instantly instead of hanging for the 8 s CDN timeout.
      app.logger?.warn?.(
        `WAF proxy: refusing ${filename} — no pinned SHA-256 (GMBOOP_WAF_PROXY=pinned).`
      );
      return res.status(403).json({ error: 'WAF file is not pinned' });
    }

    const hit = cache.get(filename);
    if (hit) {
      if (hit.status === 404) return res.status(404).end();
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days
      return res.send(hit.body);
    }

    try {
      const result = await fetchImpl(filename);
      if (result.status === 200 && expected) {
        const digest = sha256(result.body);
        if (digest !== expected) {
          // Loud, and NOT cached: a poisoned response must not become the
          // answer everyone gets for the next 30 days.
          app.logger?.error?.(
            `WAF proxy: SHA-256 mismatch for ${filename} (expected ${expected}, got ${digest}) ` +
              '— refusing to replay it. The upstream CDN served content that is not the ' +
              'pinned artefact.'
          );
          return res.status(502).json({ error: 'Upstream integrity check failed' });
        }
      }
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
export const _internal = {
  cache,
  fetchFromCdn,
  SAFE_FILENAME,
  resolveMode,
  loadChecksums,
  sha256,
  CHECKSUMS_PATH
};
