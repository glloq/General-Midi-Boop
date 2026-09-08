/**
 * @file tests/e2e/specs/01-boot.spec.mjs
 * @description Boot of the SPA: how long, how clean, and what happens on a Pi
 * with no internet.
 *
 * Covers plan sections §AM (UI inventory), §AU (frontend perf) and holds the
 * browser-side measurement of finding F-14 (the CDN `document.write` that used
 * to sit in `public/index.html`).
 *
 * F-14/F-87/F-119 were fixed by wave 2 / R6. The measurement below stays — it
 * is what turns "we removed it" into a number — but the assertions now read the
 * other way round: the CDN must NEVER be requested, and parsing must never wait
 * on it. Baseline before the fix, same harness, 8000 ms injected latency:
 * DOMContentLoaded 8388 ms, CDN requested once.
 */
import { suite, test, expect } from '../lib/runner.mjs';
import { newInstrumentedPage, shoot } from '../lib/browser.mjs';
import { AppPage } from '../lib/app.mjs';

/** The CDN `index.html` used to fall back to when the vendored player was missing. */
const CDN_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';

suite('01 · boot', () => {
  test('the SPA boots, connects, and reaches an interactive state', async (ctx, deps) => {
    const { page, rec } = await newInstrumentedPage(deps.browser);
    const app = new AppPage(page, rec, deps.server.baseUrl);
    try {
      const ms = await ctx.step('navigate and wait for #app + WebSocket', () => app.open());
      ctx.evidenceAdd('time to interactive (ms)', ms);

      await ctx.step('the splash is gone and the file panel is present', async () => {
        expect(await page.locator('#app:not(.hidden)').count()).toBe(1);
        expect(await page.locator('#fileList').count()).toBe(1);
      });

      await ctx.step('the WebSocket is OPEN', async () => {
        expect(await app.wsReadyState()).toBe(1);
      });

      ctx.evidenceAdd('screenshot', await shoot(page, deps.artifactsDir, '01-boot-home'));

      // The console is recorded, not asserted clean: the point of the harness is
      // to *report* what the browser saw. The assertion below is deliberately
      // limited to "nothing threw an uncaught exception in application code".
      const errs = rec.errors();
      ctx.evidenceAdd(
        'console errors at boot',
        errs.map((e) => `[${e.type}] ${e.text.slice(0, 220)}`)
      );
      ctx.evidenceAdd(
        'failed requests at boot',
        rec.requestFailures.map((f) => `${f.url} :: ${f.error}`)
      );
      ctx.evidenceAdd(
        'http >=400 at boot',
        rec.httpErrors.map((h) => `${h.status} ${h.url}`)
      );

      await ctx.softStep('no uncaught page exception during boot', () => {
        const pe = rec.pageErrors.map((e) => e.message);
        if (pe.length) throw new Error(`uncaught: ${pe.join(' | ')}`);
      });
    } finally {
      await page.context().close();
    }
  });

  test('a missing static asset is a 404, not the SPA shell (F-119)', async (ctx, deps) => {
    const res = await fetch(`${deps.server.baseUrl}/lib/WebAudioFontPlayer.js`);
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    ctx.evidenceAdd('GET /lib/WebAudioFontPlayer.js', `${res.status} ${ct} ${body.length} bytes`);

    // Before R6 this answered `200 text/html` with 613 826 bytes of index.html
    // under the identity of a .js file — a missing file turned into a silent
    // failure that never showed up in the logs. Two outcomes are legitimate now
    // and nothing else is: the player is installed and served as JavaScript, or
    // it is absent and the server says 404.
    const isJs = ct.includes('javascript') || ct.includes('ecmascript');
    if (res.status === 200) {
      expect(isJs).toBeTruthy(`200 must mean JavaScript, got content-type "${ct}"`);
    } else {
      expect(res.status).toBe(404);
      expect(ct.includes('text/html')).toBeFalsy(
        `a missing asset must never be answered with the SPA shell (got "${ct}")`
      );
      expect(body.length).toBeLessThan(1000);
    }
  });

  test('boot with the CDN unreachable — measures the real blocking time (F-14)', async (ctx, deps) => {
    const stallMs = Number(process.env.E2E_CDN_STALL_MS || 8000);
    const { page, rec } = await newInstrumentedPage(deps.browser);
    const app = new AppPage(page, rec, deps.server.baseUrl);
    try {
      // A Pi with no route to the internet does not get a fast refusal: the
      // request hangs until DNS/TCP times out. Emulate that with a stall, so
      // the measurement reflects an offline Pi rather than this container's
      // proxy answering ERR_TUNNEL_CONNECTION_FAILED in ~30 ms.
      let cdnRequested = 0;
      await page.route(CDN_URL, async (route) => {
        cdnRequested++;
        await new Promise((r) => setTimeout(r, stallMs));
        await route.abort('connectionfailed');
      });

      const t0 = Date.now();
      await page.goto(deps.server.baseUrl + '/', { waitUntil: 'commit', timeout: 90000 });

      // When does the *document* finish parsing? `document.write` of a
      // parser-blocking script suspends the parser until the script settles, so
      // DOMContentLoaded is the honest measure of the user-visible stall.
      const domContentLoadedMs = await page
        .waitForFunction(() => document.readyState !== 'loading', null, { timeout: 90000 })
        .then(() => Date.now() - t0);

      const readyMs = await app
        .waitReady({ timeoutMs: 90000 })
        .then(() => Date.now() - t0)
        .catch((e) => `NOT READY: ${e.message}`);

      ctx.evidenceAdd('CDN stall injected (ms)', stallMs);
      ctx.evidenceAdd('CDN request intercepted', cdnRequested);
      ctx.evidenceAdd('DOMContentLoaded (ms)', domContentLoadedMs);
      ctx.evidenceAdd('time to interactive (ms)', readyMs);
      ctx.evidenceAdd('screenshot', await shoot(page, deps.artifactsDir, '01-boot-offline'));

      // Inverted by R6: the fallback is gone, so the request must never be
      // made. Before the fix this was `expect(cdnRequested).toBeGreaterThan(0)`
      // and it passed — that is what made the boot hostage to the network.
      await ctx.step('the CDN is never requested at all', () => {
        expect(cdnRequested).toBe(0);
      });

      await ctx.step('the audio preview degrades explicitly instead', async () => {
        const t = await page.evaluate(() => typeof window.WebAudioFontPlayer);
        ctx.evidenceAdd('typeof WebAudioFontPlayer', t);
        if (t === 'undefined') {
          // No vendored player in this checkout: the page must say so rather
          // than reach for a CDN it cannot use.
          const flag = await page.evaluate(
            () => window.__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__ || null
          );
          ctx.evidenceAdd('degradation notice', flag);
          expect(typeof flag).toBe('string');
        }
      });

      // The finding, measured: parsing used to be blocked for exactly as long
      // as the CDN took to fail. It must now be independent of it — well under
      // the injected stall, not merely below it.
      await ctx.step(
        `document parsing is not blocked by the unreachable CDN (< ${stallMs}ms)`,
        () => {
          expect(domContentLoadedMs).toBeLessThan(stallMs);
        }
      );

      // "Below the stall" alone would still pass at 7999 ms. Parsing must be
      // decoupled from the network, not merely faster than it.
      await ctx.step(`and it is decoupled from it, not merely faster (< ${stallMs / 2}ms)`, () => {
        expect(domContentLoadedMs).toBeLessThan(stallMs / 2);
      });
    } finally {
      await page.context().close();
    }
  });
});
