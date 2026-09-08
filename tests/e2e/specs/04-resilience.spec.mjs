/**
 * @file tests/e2e/specs/04-resilience.spec.mjs
 * @description What the user sees when the link to the Pi breaks, and what
 * survives a reload in the middle of a piece.
 *
 * Answers the plan's §AN/§BW questions that only a browser can answer:
 *   - the WebSocket drops during playback: is there feedback? does it recover?
 *   - the page is reloaded during playback: does the backend keep playing, and
 *     does the reloaded UI re-attach to that playback or lose it?
 */
import { suite, test, expect } from '../lib/runner.mjs';
import { newInstrumentedPage, shoot } from '../lib/browser.mjs';
import { AppPage } from '../lib/app.mjs';
import { writeFixtures } from '../fixtures/make-midi.mjs';

const FILENAME = 'e2e-two-channel.mid';

suite('04 · resilience', () => {
  test(
    'the WebSocket drops mid-playback: the UI reacts and the client reconnects',
    async (ctx, deps) => {
      const { page, rec } = await newInstrumentedPage(deps.browser);
      const app = new AppPage(page, rec, deps.server.baseUrl);
      try {
        await ctx.step('prepare a routed, playable file', () => prepare(page, app, deps));

        // Record the client's own connection lifecycle events so the assertion is
        // about the documented contract (`disconnected` / `reconnecting` /
        // `reconnect_exhausted` / `connected`), not about a spinner's CSS.
        await page.evaluate(() => {
          window.__wsEvents = [];
          for (const e of ['disconnected', 'reconnecting', 'reconnect_exhausted', 'connected']) {
            window.api.on(e, (d) => window.__wsEvents.push({ e, d, at: Date.now() }));
          }
        });

        await ctx.step('start playback', async () => {
          await app.fileAction(FILENAME, 'play');
          await page.waitForTimeout(1200);
          const st = await app.playbackStatus();
          expect(st.playing).toBeTruthy('playback started before the cut');
        });

        // The client's first retry fires after only 1 s, so a single DOM sample
        // taken "after the cut" routinely lands *after* recovery and reports a
        // banner that was in fact shown. Poll instead, and keep the maximum.
        await ctx.step('sever the WebSocket while watching the DOM', async () => {
          await page.evaluate(() => {
            window.__offlineWording = [];
            window.__poll = setInterval(() => {
              const m = document.body.innerText.match(
                /reconnect|reconnexion|connexion perdue|connection lost|hors ligne|offline|d\u00e9connect/gi
              );
              if (m) window.__offlineWording.push(...m);
            }, 100);
          });
          await app.killWebSocket();
          await page.waitForTimeout(3000);
          await page.evaluate(() => clearInterval(window.__poll));
        });

        const seen = await page.evaluate(() => window.__wsEvents.map((x) => x.e));
        ctx.evidenceAdd(
          'reconnect timings (ms from cut)',
          await page.evaluate(() => {
            const t0 = window.__wsEvents[0]?.at || 0;
            return window.__wsEvents.map((x) => `${x.e} +${x.at - t0}ms`);
          })
        );
        ctx.evidenceAdd('client events after the cut', seen);
        ctx.evidenceAdd('visible feedback after the cut', await app.toasts());
        ctx.evidenceAdd(
          'screenshot right after the cut',
          await shoot(page, deps.artifactsDir, '04-ws-cut')
        );

        await ctx.step('the client reports the disconnection', () => {
          expect(seen).toContain('disconnected');
        });

        await ctx.step('the user is told something is wrong', async () => {
          const seenWords = await page.evaluate(() => window.__offlineWording || []);
          ctx.evidenceAdd(
            'on-screen wording observed while disconnected',
            [...new Set(seenWords)].slice(0, 10)
          );
          expect(seenWords.length).toBeGreaterThan(0);
        });

        await ctx.step('the client reconnects on its own within 20 s', async () => {
          await page.waitForFunction(
            () => window.api && window.api.isConnected && window.api.isConnected(),
            null,
            {
              timeout: 20000
            }
          );
          const after = await page.evaluate(() => window.__wsEvents.map((x) => x.e));
          ctx.evidenceAdd('client events after recovery', after);
          expect(await app.wsReadyState()).toBe(1);
        });

        await ctx.step('the UI is usable again after reconnection', async () => {
          const devices = await app.listDevices();
          ctx.evidenceAdd('device_list after reconnection', devices.length);
          expect(devices.length).toBeGreaterThan(0);
        });
        ctx.evidenceAdd(
          'screenshot after reconnection',
          await shoot(page, deps.artifactsDir, '04-ws-recovered')
        );
      } finally {
        await page.context().close();
      }
    },
    { timeoutMs: 300000 }
  );

  test(
    'the page is reloaded mid-playback',
    async (ctx, deps) => {
      const { page, rec } = await newInstrumentedPage(deps.browser);
      const app = new AppPage(page, rec, deps.server.baseUrl);
      try {
        await ctx.step('prepare a routed, playable file', () => prepare(page, app, deps));

        await ctx.step('start playback', async () => {
          await app.fileAction(FILENAME, 'play');
          await page.waitForTimeout(1200);
          expect((await app.playbackStatus()).playing).toBeTruthy();
        });

        await ctx.step('reload while it is playing', async () => {
          await page.reload({ waitUntil: 'load' });
          await app.waitReady();
        });

        const st = await app.playbackStatus();
        ctx.evidenceAdd('backend playback_status after the reload', st);
        const header = await app.transportState();
        ctx.evidenceAdd('header transport after the reload', header);
        ctx.evidenceAdd(
          'screenshot after the reload',
          await shoot(page, deps.artifactsDir, '04-reload-midplay')
        );

        // The honest assertion is about *coherence*, not about a particular
        // policy: whatever the backend is doing, the header must say the same.
        await ctx.step('the reloaded UI agrees with the backend about what is playing', () => {
          if (st.playing) {
            expect(header.stopDisabled).toBeFalsy(
              'the backend is still playing, so the header must offer Stop'
            );
            expect(header.file).toContain(FILENAME);
          } else {
            expect(header.stopDisabled).toBeTruthy(
              'nothing is playing, so the header must not offer Stop'
            );
          }
        });

        await app.command('playback_stop', {}).catch(() => {});
      } finally {
        await page.context().close();
      }
    },
    { timeoutMs: 300000 }
  );
});

/**
 * Boot, create a virtual instrument, import and auto-route the fixture so a
 * resilience test starts from a playable state.
 * @param {any} page @param {AppPage} app @param {Object} deps
 */
async function prepare(page, app, deps) {
  const fx = writeFixtures();
  await app.open();
  // Tests in this suite share one server: leave no playback running from the
  // previous one, or clicking Play on an already-playing file toggles pause.
  await app.command('playback_stop', {}).catch(() => {});
  await app.enableVirtualInstruments();
  await app.open();

  const devices = await app.listDevices();
  if (!devices.some((d) => d.type === 'virtual')) {
    await app.openInstruments();
    await app.createVirtualInstrumentViaUi({ preset: 'piano' });
    await page.waitForTimeout(1200);
    await app.closeInstruments();
  }

  const files = await app.filesInList();
  if (!files.some((f) => f.name === FILENAME)) {
    await app.importMidiViaUi(fx.twoChannel);
    await app.waitForFileInList(FILENAME);
  }

  const fileId = await app.waitForFileInList(FILENAME);
  const status = await app
    .command('file_routing_status', { fileId })
    .catch(() => ({ routedCount: 0 }));
  if (!status.routedCount) {
    await app.fileAction(FILENAME, 'route');
    await page.waitForSelector('#routingSummaryModal', { timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.click('#rsAutoRoutingBtn');
    await page.waitForTimeout(3500);
    await page.click('#rsSummaryApply');
    await page.waitForSelector('#routingSummaryModal', { state: 'detached', timeout: 30000 });
    await page.waitForTimeout(2000);
  }
}
