/**
 * @file tests/e2e/specs/05-live-routing.spec.mjs
 * @description Audit R12 — proof that F-138 is closed.
 *
 * F-138 (P1): "the live MIDI routing is entirely unreachable from the UI".
 * Fifteen `route_*` / `filter_*` / `channel_map` commands were registered,
 * validated, tested and documented — and no code path in the SPA called any of
 * them, so an operator plugging in a BLE or USB keyboard could not create a
 * single source → destination route.
 *
 * A unit test can only prove that a component exists. **Only a browser can
 * prove the feature is reachable**: this scenario clicks the header button a
 * user would click, creates a route through the two selects, then reloads the
 * page and re-opens the modal to prove the route was persisted — the same
 * round trip `MidiRouter.loadRoutesFromDB()` performs at boot.
 *
 * It uses the app's own virtual instruments, so it needs no MIDI hardware.
 */
import { suite, test, expect } from '../lib/runner.mjs';
import { newInstrumentedPage, shoot } from '../lib/browser.mjs';
import { AppPage } from '../lib/app.mjs';

suite('05 · live MIDI routing (F-138)', () => {
  test('a route created from the UI reaches the router and survives a reload', async (ctx, deps) => {
    const { page, rec } = await newInstrumentedPage(deps.browser);
    const app = new AppPage(page, rec, deps.server.baseUrl);
    // window.confirm gates the delete; accept it the way a user would.
    page.on('dialog', (d) => d.accept().catch(() => {}));

    try {
      // ── 1. boot ───────────────────────────────────────────────────────────
      await ctx.step('1 · boot the SPA', async () => {
        await app.open();
        await app.enableVirtualInstruments();
        await app.open();
      });

      // ── 2. two destinations to route between ──────────────────────────────
      await ctx.step('2 · create two virtual instruments through the UI', async () => {
        await app.openInstruments();
        await app.createVirtualInstrumentViaUi({ preset: 'piano' });
        await page.waitForTimeout(1200);
        await app.createVirtualInstrumentViaUi({ preset: 'organ' });
        await page.waitForTimeout(1200);
        await app.closeInstruments();

        const devices = await app.listDevices();
        ctx.evidenceAdd(
          'devices',
          devices.map((d) => `${d.id} · ${d.name} · ${d.type}`)
        );
        const virtuals = devices.filter((d) => d.type === 'virtual');
        expect(virtuals.length).toBeGreaterThan(1);
        ctx.state.sourceId = virtuals[0].id;
        ctx.state.destinationId = virtuals[1].id;
      });

      // ── 3. the F-138 baseline ─────────────────────────────────────────────
      await ctx.step('3 · the router starts with no route at all', async () => {
        const routes = await app.backendRoutes();
        ctx.evidenceAdd('route_list before', routes);
        expect(routes.length).toBe(0);
      });

      // ── 4. the affordance that F-138 said did not exist ───────────────────
      await ctx.step('4 · the header carries a live-routing button', async () => {
        const btn = page.locator('#liveRoutingBtn');
        expect(await btn.count()).toBe(1);
        expect(await btn.isVisible()).toBeTruthy('the button is actually visible');
        const name = await btn.getAttribute('aria-label');
        ctx.evidenceAdd('button accessible name', name);
        expect(!!name).toBeTruthy('the icon button has an accessible name (F-104)');
      });

      await ctx.step('5 · a real click opens the routing modal', async () => {
        await app.openLiveRouting();
        const overlay = page.locator('#live-routing-modal-overlay');
        expect(await overlay.getAttribute('role')).toBe('dialog');
        expect(await overlay.getAttribute('aria-modal')).toBe('true');
        const options = await app.routingSelectOptions('source');
        ctx.evidenceAdd('source options', options);
        expect(options.length).toBeGreaterThan(1);
      });
      ctx.evidenceAdd(
        'screenshot · routing modal',
        await shoot(page, deps.artifactsDir, '05-01-modal')
      );

      // ── 6. create the route ───────────────────────────────────────────────
      await ctx.step('6 · create a route from the two selects', async () => {
        const rows = await app.createRouteViaUi(ctx.state.sourceId, ctx.state.destinationId);
        expect(rows).toBe(1);
        const rendered = await app.routeRows();
        ctx.evidenceAdd('rows rendered by the modal', rendered);
        expect(rendered[0].enabled).toBeTruthy('a fresh route is enabled');
      });

      await ctx.step('7 · the backend router really holds it', async () => {
        const routes = await app.backendRoutes();
        ctx.evidenceAdd('route_list after create', routes);
        expect(routes.length).toBe(1);
        expect(routes[0].source).toBe(ctx.state.sourceId);
        expect(routes[0].destination).toBe(ctx.state.destinationId);
        expect(routes[0].enabled).toBe(true);
        ctx.state.routeId = routes[0].id;
      });
      ctx.evidenceAdd(
        'screenshot · route created',
        await shoot(page, deps.artifactsDir, '05-02-created')
      );

      // ── 8. persistence — the actual claim ─────────────────────────────────
      await ctx.step('8 · Escape closes the modal without leaving an overlay', async () => {
        await app.closeLiveRouting();
        expect(await page.locator('#live-routing-modal-overlay').count()).toBe(0);
      });

      await ctx.step('9 · after a full reload the route is still there', async () => {
        await app.open();
        const routes = await app.backendRoutes();
        ctx.evidenceAdd('route_list after reload', routes);
        expect(routes.length).toBe(1);
        expect(routes[0].id).toBe(ctx.state.routeId);

        await app.openLiveRouting();
        const rendered = await app.routeRows();
        ctx.evidenceAdd('rows after reload', rendered);
        expect(rendered.length).toBe(1);
        expect(rendered[0].id).toBe(ctx.state.routeId);
      });
      ctx.evidenceAdd(
        'screenshot · after reload',
        await shoot(page, deps.artifactsDir, '05-03-after-reload')
      );

      // ── 9. the rest of the lifecycle ──────────────────────────────────────
      await ctx.step('10 · disabling it from the UI reaches route_enable', async () => {
        await page.uncheck('#lrt-routes .lrt-enabled', { timeout: 10000 });
        await page.waitForFunction(
          () => !!document.querySelector('#lrt-status')?.textContent.trim(),
          null,
          { timeout: 10000 }
        );
        const routes = await app.backendRoutes();
        ctx.evidenceAdd('route_list after disable', routes);
        expect(routes[0].enabled).toBe(false);
      });

      await ctx.step('11 · the settings panel edits the channel map', async () => {
        await page.click('#lrt-routes [data-lrt-action="edit"]', { timeout: 10000 });
        await page.waitForSelector('#lrt-chmap select', { timeout: 10000 });
        // Match on the option VALUE (the 0-based channel), not its label: a
        // bare string would also match the label "9", which belongs to the
        // option whose value is 8.
        await page.selectOption('#lrt-chmap-0', { value: '9' });
        await page.click('#lrt-chmap-save', { timeout: 10000 });
        await page.waitForFunction(
          () => {
            const el = document.querySelector('#lrt-status');
            return !!el && el.textContent.trim().length > 0;
          },
          null,
          { timeout: 10000 }
        );
        const routes = await app.backendRoutes();
        ctx.evidenceAdd('channelMap after save', routes[0].channelMap);
        expect(JSON.stringify(routes[0].channelMap)).toContain('9');
      });

      await ctx.step('12 · deleting it from the UI empties the router', async () => {
        await page.click('#lrt-routes [data-lrt-action="delete"]', { timeout: 10000 });
        await page.waitForSelector('#lrt-routes .lrt-empty', { timeout: 15000 });
        const routes = await app.backendRoutes();
        ctx.evidenceAdd('route_list after delete', routes);
        expect(routes.length).toBe(0);
      });

      // ── 10. nothing broke on the way ──────────────────────────────────────
      await ctx.step('13 · no uncaught page error during the journey', async () => {
        const errors = rec.pageErrors.map((e) => e.message || String(e));
        ctx.evidenceAdd('page errors', errors);
        expect(errors.length).toBe(0);
      });
    } finally {
      await page.context().close();
    }
  });
});
