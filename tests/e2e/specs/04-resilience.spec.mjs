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

        // Showing the state is half of R20; the other half is that the
        // restored controls are wired to the playback that is actually
        // running. Both are asserted from the *reloaded* page only.
        await ctx.step('the reloaded UI shows where the piece is, not 0:00', () => {
          expect(st.playing).toBeTruthy('precondition: the backend is still playing');
          expect(header.time).toMatch(/\d+:\d{2}\s*\/\s*\d+:\d{2}/);
          const total = (header.time.split('/')[1] || '').trim();
          expect(total === '0:00' || total === '').toBeFalsy(
            `the header must show the piece duration, got "${header.time}"`
          );
          expect(header.playDisabled).toBeFalsy('Pause must be reachable too');
        });

        await ctx.step(
          'Stop, clicked in the reloaded page, really stops the orchestra',
          async () => {
            await app.clickStop();
            await page.waitForTimeout(2000);
            const after = await app.playbackStatus();
            ctx.evidenceAdd('backend playback_status after clicking Stop', after);
            expect(after.playing).toBeFalsy(
              'the reloaded UI must be able to silence the instruments'
            );
          }
        );

        await ctx.step('and the button goes back to inert once it has stopped', async () => {
          const idle = await app.transportState();
          ctx.evidenceAdd('header transport after the Stop click', idle);
          expect(idle.stopDisabled).toBeTruthy();
        });
        ctx.evidenceAdd(
          'screenshot after stopping from the reloaded page',
          await shoot(page, deps.artifactsDir, '04-reload-stopped')
        );

        await app.command('playback_stop', {}).catch(() => {});
      } finally {
        await page.context().close();
      }
    },
    { timeoutMs: 300000 }
  );

  test(
    'a browser that never started the playback still gets a working Stop',
    async (ctx, deps) => {
      // The reload case above can legitimately name the file: the same browser
      // started it. This one is the stage reality the first one cannot cover —
      // the tablet died and someone opens the SPA on a *fresh* profile while
      // the orchestra is playing. The name may be unknown; the control may not.
      const { page, rec } = await newInstrumentedPage(deps.browser);
      const app = new AppPage(page, rec, deps.server.baseUrl);
      let second = null;
      try {
        await ctx.step('prepare a routed, playable file', () => prepare(page, app, deps));
        await ctx.step('start playback', async () => {
          await app.fileAction(FILENAME, 'play');
          await page.waitForTimeout(1200);
          expect((await app.playbackStatus()).playing).toBeTruthy();
        });

        // A brand-new context: no localStorage, no memory of the file, exactly
        // like a second operator's tablet.
        second = await newInstrumentedPage(deps.browser);
        const other = new AppPage(second.page, second.rec, deps.server.baseUrl);
        await ctx.step('open the SPA in a fresh browser profile', () => other.open());

        const header = await other.transportState();
        ctx.evidenceAdd('header transport on the fresh profile', header);
        ctx.evidenceAdd(
          'screenshot of the fresh profile',
          await shoot(second.page, deps.artifactsDir, '04-second-client')
        );

        await ctx.step('the fresh profile offers Stop for a playback it did not start', () => {
          expect(header.stopDisabled).toBeFalsy();
        });

        await ctx.step('and clicking it stops the orchestra', async () => {
          await other.clickStop();
          await second.page.waitForTimeout(2000);
          const after = await other.playbackStatus();
          ctx.evidenceAdd('backend playback_status after the fresh profile stopped it', after);
          expect(after.playing).toBeFalsy();
        });
      } finally {
        if (second) await second.page.context().close();
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
