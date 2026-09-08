/**
 * @file tests/audit/r6-offline-first.test.js
 * @description Wave 2 / R6 — F-14, F-87, F-119: the offline-first boot.
 *
 * The defect was a three-link chain, and every link on its own was enough to
 * recreate the outage:
 *
 *   1. `vite.config.js` never copied `public/lib/` into `dist/`, so the
 *      vendored WebAudioFont player was missing from EVERY production install
 *      (Install.sh runs `npm run build`, the systemd unit sets
 *      NODE_ENV=production, HttpServer then serves `dist/`).
 *   2. A missing static asset answered `200 text/html` + the 615 KB SPA shell
 *      instead of 404, so `typeof WebAudioFontPlayer === 'undefined'` was
 *      unconditionally true (that link is covered by
 *      `r6-static-asset-404.test.js`).
 *   3. `public/index.html` then ran a `document.write` of a CDN <script>,
 *      which is parser-blocking: measured 8000 ms of injected network latency
 *      => 8421 ms of blocked parsing, with 174 of the 191 <script> tags
 *      sitting behind it — on a device whose headline feature is running
 *      offline. And the wait bought nothing: the global stayed undefined.
 *
 * This suite locks links 1 and 3. It is NOT a characterisation test: every
 * assertion below describes the behaviour we want to keep.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const indexHtml = readFileSync(join(ROOT, 'public/index.html'), 'utf8');

describe('R6 / F-14 · public/index.html no longer reaches for a CDN', () => {
  test('no document.write anywhere in the page', () => {
    // A parser-blocking write is the whole mechanism of F-87. Ban the call,
    // not just the one URL it used to point at.
    expect(indexHtml).not.toMatch(/document\s*\.\s*write/);
  });

  test('no script, style or link loads from an external origin', () => {
    const externals = indexHtml.match(/(?:src|href)\s*=\s*"(?:https?:)?\/\/[^"]*"/g) || [];
    expect(externals).toEqual([]);
  });

  test('surikov.github.io is gone from the page', () => {
    expect(indexHtml).not.toContain('surikov.github.io');
  });

  test('the vendored player is still loaded, from a relative local path', () => {
    expect(indexHtml).toContain('<script src="lib/WebAudioFontPlayer.js"></script>');
  });

  test('its absence degrades explicitly instead of blocking', () => {
    // The guard stays — what changed is what it does. It must set a flag a
    // diagnostic view can read and tell the operator what to run, with no
    // network call and nothing that suspends the parser.
    expect(indexHtml).toMatch(/typeof WebAudioFontPlayer === 'undefined'/);
    expect(indexHtml).toContain('__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__');
    expect(indexHtml).toMatch(/console\.warn\('\[GMBoop\] '/);
    expect(indexHtml).toContain('npm run install-default-sf2');
  });

  test('the 194 script tags are all local and none is behind a network call', () => {
    const srcs = [...indexHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    // 191 at R6; +2 in wave 3 / R12 (the live-routing modal and its launcher);
    // +1 in wave 4 / R20 (features/transport/PlaybackResync.js) — all relative
    // paths. The count is deliberately exact so that adding a script is a
    // conscious edit here; the invariant being protected is the loop below —
    // no tag may point at a remote origin.
    expect(srcs.length).toBe(194);
    for (const s of srcs) {
      expect(s).not.toMatch(/^(?:https?:)?\/\//);
    }
  });
});

describe('R6 / F-14 · a Vite build carries lib/ into dist/', () => {
  const viteBin = join(ROOT, 'node_modules/vite/bin/vite.js');
  const libDir = join(ROOT, 'public/lib');
  // Deliberately NOT named WebAudioFontPlayer.js: the real artefact is
  // downloaded by the postinstall and this suite must never leave a stub
  // behind that the app (or a parallel E2E run) could pick up as the player.
  const probeName = '.r6-vite-copy-probe';
  const probePath = join(libDir, probeName);

  let outDir = null;
  let createdLibDir = false;
  let built = false;
  let buildError = null;

  beforeAll(() => {
    if (!existsSync(viteBin)) return; // devDependency absent — tests below skip
    if (!existsSync(libDir)) {
      mkdirSync(libDir, { recursive: true });
      createdLibDir = true;
    }
    writeFileSync(probePath, 'r6\n');
    outDir = mkdtempSync(join(tmpdir(), 'gmboop-r6-dist-'));
    try {
      execFileSync(
        process.execPath,
        [viteBin, 'build', '--outDir', outDir, '--logLevel', 'error'],
        {
          cwd: ROOT,
          stdio: 'pipe',
          timeout: 180000
        }
      );
      built = true;
    } catch (err) {
      buildError = err;
    }
  }, 200000);

  afterAll(() => {
    try {
      rmSync(probePath, { force: true });
    } catch {
      /* best effort */
    }
    if (createdLibDir) {
      try {
        rmSync(libDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  const maybe = existsSync(viteBin) ? test : test.skip;

  maybe('the build succeeds', () => {
    if (!built) {
      throw new Error(
        `vite build failed: ${buildError?.stderr?.toString?.() || buildError?.message}`
      );
    }
  });

  maybe('the lib/ tree lands in the build output', () => {
    expect(built).toBe(true);
    expect(existsSync(join(outDir, 'lib', probeName))).toBe(true);
  });

  maybe('the build drops none of the scripts index.html references', () => {
    expect(built).toBe(true);
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/src="((?:js|lib)\/[^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(150);
    expect(refs).toContain('lib/WebAudioFontPlayer.js');
    // The invariant is "dist/ mirrors public/", so only files public/ actually
    // holds can be required. WebAudioFontPlayer.js is fetched by the
    // postinstall and is legitimately absent from a `--ignore-scripts`
    // checkout; when it IS there, it must reach the build — that is F-14.
    const shouldExist = refs.filter((r) => existsSync(join(ROOT, 'public', r)));
    const missing = shouldExist.filter((r) => !existsSync(join(outDir, r)));
    expect(missing).toEqual([]);
  });

  maybe('the built index.html carries no external origin either', () => {
    expect(built).toBe(true);
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).not.toContain('surikov.github.io');
    expect(html).not.toMatch(/document\s*\.\s*write/);
  });
});

describe('R6 / F-14 · the copy list itself', () => {
  test("copyStaticTree still copies 'lib'", () => {
    // The regression is invisible in dev (which serves public/ directly) and
    // only surfaces on a production box, so guard the list in source.
    const viteConfig = readFileSync(join(ROOT, 'vite.config.js'), 'utf8');
    const m = viteConfig.match(/const dirs = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const dirs = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(dirs).toContain('lib');
  });
});
