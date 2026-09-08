/**
 * @file tests/e2e/specs/03-modal-memory.spec.mjs
 * @description Opens and closes the SPA's heavy modals many times and watches
 * the renderer heap, the live DOM node count and the registered JS listener
 * count through CDP.
 *
 * This is the §AV question ("does the SPA leak?") which no jsdom test can
 * answer: `Performance.getMetrics().JSEventListeners` counts listeners the V8
 * isolate actually holds, and `Runtime.getHeapUsage` reports the live heap
 * after a forced GC. A modal that re-registers a `document`/`window` listener
 * on each open, or appends an overlay it never removes, shows up as a monotone
 * climb in one of the three.
 */
import { suite, test, expect } from '../lib/runner.mjs';
import { newInstrumentedPage, heapSnapshotMetrics, forceGc, shoot } from '../lib/browser.mjs';
import { AppPage } from '../lib/app.mjs';

/** How many open/close cycles per modal. Overridable for a quick smoke run. */
const CYCLES = Number(process.env.E2E_MODAL_CYCLES || 50);

/**
 * The heavy modals, each with the header button that opens it and the selector
 * that proves it is on screen.
 */
const MODALS = [
  // Root selectors are the elements the modal actually appends to <body>,
  // verified live — NOT loose `[class*="…"]` patterns, which happily match the
  // header button that opens the modal and would turn a leak into a false PASS.
  { name: 'KeyboardModal', open: '#openKeyboardBtn', root: 'div.keyboard-modal' },
  { name: 'InstrumentManagementPage', open: '#instrumentsBtn', root: 'div.inst-mgmt-modal' },
  { name: 'SettingsModal', open: '#settingsToggle', root: 'div.settings-modal-overlay' },
  { name: 'LoopCreatorModal', open: '#loopCreatorBtn', root: '#loop-manager-modal-overlay' },
  { name: 'PlaylistPage', open: '#playlistBtn', root: 'div.plpage-overlay' }
];

suite('03 · modal open/close leak', () => {
  for (const m of MODALS) {
    test(
      `${m.name} · ${CYCLES} open/close cycles do not grow the heap monotonically`,
      async (ctx, deps) => {
        const { page, rec } = await newInstrumentedPage(deps.browser);
        const app = new AppPage(page, rec, deps.server.baseUrl);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable').catch(() => {});
        try {
          await ctx.step('boot', async () => {
            await app.open();
            await app.enableVirtualInstruments();
            await app.open();
          });

          // Warm-up: the first open of a modal legitimately allocates (templates,
          // canvases, i18n). Measuring from cycle 0 would report that as a leak.
          const warm = await openClose(page, m, 3);
          if (warm === 0) {
            throw new Error(
              `the modal never opened during warm-up — open="${m.open}" root="${m.root}"`
            );
          }
          await forceGc(cdp);
          const base = await heapSnapshotMetrics(cdp);
          ctx.evidenceAdd('baseline after warm-up', base);

          const samples = [base];
          const stride = Math.max(1, Math.floor(CYCLES / 5));
          let done = 0;
          for (let i = 0; i < CYCLES; i++) {
            done += await openClose(page, m, 1);
            if ((i + 1) % stride === 0) {
              await forceGc(cdp);
              samples.push(await heapSnapshotMetrics(cdp));
            }
          }
          ctx.evidenceAdd('cycles completed', `${done}/${CYCLES}`);
          ctx.evidenceAdd(
            'samples (usedMB · listeners · nodes)',
            samples.map(
              (s) => `${s.usedMB} MB · ${s.jsEventListeners} listeners · ${s.nodes} nodes`
            )
          );

          await forceGc(cdp);
          const end = await heapSnapshotMetrics(cdp);
          const dHeap = +(end.usedMB - base.usedMB).toFixed(2);
          const dListeners = end.jsEventListeners - base.jsEventListeners;
          const dNodes = end.nodes - base.nodes;
          ctx.evidenceAdd('delta over the run', {
            heapMB: dHeap,
            listeners: dListeners,
            nodes: dNodes,
            perCycleListeners: +(dListeners / Math.max(1, done)).toFixed(2),
            perCycleNodes: +(dNodes / Math.max(1, done)).toFixed(1)
          });
          ctx.evidenceAdd('screenshot', await shoot(page, deps.artifactsDir, `03-${m.name}`));

          if (done === 0)
            throw new Error(
              `the modal never opened — selector "${m.open}"/"${m.root}" did not match`
            );

          // A handful of listeners across 50 cycles is noise; a listener retained
          // per cycle is a leak, and so is a DOM subtree left behind each time.
          await ctx.step('listeners do not accumulate per cycle', () => {
            expect(dListeners / done).toBeLessThan(1);
          });
          await ctx.step('DOM nodes do not accumulate per cycle', () => {
            expect(dNodes / done).toBeLessThan(20);
          });
          await ctx.step('the live heap does not grow without bound', () => {
            expect(dHeap).toBeLessThan(Math.max(8, base.usedMB * 0.5));
          });
        } finally {
          await page.context().close();
        }
      },
      { timeoutMs: 420000 }
    );
  }
});

/**
 * Open and close a modal `n` times.
 *
 * Timeouts are deliberately short: a modal whose selector never matches must
 * cost ~1 s per cycle, not 16 s, so a mis-targeted entry degrades into a fast
 * "0/50 cycles" report instead of stalling the whole suite.
 *
 * @returns {Promise<number>} how many cycles actually opened the modal
 */
async function openClose(page, m, n) {
  let opened = 0;
  for (let i = 0; i < n; i++) {
    try {
      await page.click(m.open, { timeout: 4000 });
      await page.waitForSelector(m.root, { timeout: 5000 });
      opened++;
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    // Escape first (the documented affordance), then a real close button —
    // several of this SPA's modals implement only the latter (see F-89).
    await page.keyboard.press('Escape');
    const gone = await page
      .waitForSelector(m.root, { state: 'hidden', timeout: 1200 })
      .then(() => true)
      .catch(() => false);
    if (!gone) {
      const close = page.locator(
        `${m.closeIn || 'body'} .modal-close, ${m.closeIn || 'body'} .close-btn`
      );
      if (await close.count()) {
        await close
          .last()
          .click({ timeout: 2000 })
          .catch(() => {});
        await page.waitForSelector(m.root, { state: 'hidden', timeout: 2000 }).catch(() => {});
      }
    }
    await page.waitForTimeout(50);
  }
  return opened;
}
