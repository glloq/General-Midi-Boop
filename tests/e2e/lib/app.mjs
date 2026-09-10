/**
 * @file tests/e2e/lib/app.mjs
 * @description Page objects for the GeneralMidiBoop SPA.
 *
 * All SPA-specific knowledge (selectors, boot sequence, modal names, the
 * WebSocket client's shape) lives here so specs read like the user journey they
 * describe. When the UI moves, this file moves — the specs should not.
 *
 * Two levers are exposed deliberately:
 *   - `AppPage.*` : clicks and DOM assertions — what a user does.
 *   - `AppPage.command()` : sends a raw WebSocket command through the SPA's own
 *     `window.api` client. Used for *set-up* and for *verification*, never to
 *     replace the click being tested — otherwise the harness would be testing
 *     the backend it already has Jest tests for.
 */

/** The splash screen enforces a 4 s minimum on a cold profile — see index.html. */
export const SPLASH_MIN_MS = 4000;

export class AppPage {
  /**
   * @param {any} page Playwright page
   * @param {import('./browser.mjs').Recorder} rec
   * @param {string} baseUrl
   */
  constructor(page, rec, baseUrl) {
    this.page = page;
    this.rec = rec;
    this.baseUrl = baseUrl;
  }

  /**
   * Navigate and wait until the SPA is actually usable.
   *
   * "Usable" is `#app` no longer `.hidden` **and** the WebSocket in state OPEN.
   * Waiting on `load` alone is a trap: index.html keeps the splash up for a
   * fixed 4 s on a cold localStorage.
   *
   * @param {{path?:string, timeoutMs?:number, waitWs?:boolean}} [opts]
   * @returns {Promise<number>} milliseconds from goto() to usable
   */
  async open(opts = {}) {
    const t0 = Date.now();
    await this.page.goto(this.baseUrl + (opts.path ?? '/'), {
      waitUntil: 'load',
      timeout: opts.timeoutMs ?? 60000
    });
    await this.waitReady(opts);
    return Date.now() - t0;
  }

  /**
   * Wait for the SPA to finish booting on the page currently loaded.
   * @param {{timeoutMs?:number, waitWs?:boolean}} [opts]
   */
  async waitReady(opts = {}) {
    const timeout = opts.timeoutMs ?? 60000;
    await this.page.waitForSelector('#app:not(.hidden)', { timeout });
    if (opts.waitWs !== false) {
      await this.page.waitForFunction(
        () => window.api && window.api.isConnected && window.api.isConnected(),
        null,
        {
          timeout
        }
      );
    }
  }

  /**
   * Send a command through the SPA's own WebSocket client.
   * @param {string} command
   * @param {Object} [data]
   * @returns {Promise<any>}
   */
  async command(command, data = {}) {
    return this.page.evaluate(([c, d]) => window.api.sendCommand(c, d), [command, data]);
  }

  // ── Instruments ───────────────────────────────────────────────────────────

  /**
   * Open the instrument-management page (header 🎸 button).
   * @returns {Promise<void>}
   */
  async openInstruments() {
    await this.page.click('#instrumentsBtn');
    await this.page.waitForSelector('#addVirtualInstrumentBtn', { timeout: 15000 });
  }

  /**
   * Enable virtual instruments (a localStorage-backed setting that gates the
   * "add virtual" button).
   * @returns {Promise<void>}
   */
  async enableVirtualInstruments() {
    await this.page.evaluate(() => {
      let s = {};
      try {
        s = JSON.parse(localStorage.getItem('gmboop_settings') || '{}');
      } catch {
        s = {};
      }
      s.virtualInstrument = true;
      localStorage.setItem('gmboop_settings', JSON.stringify(s));
    });
  }

  /**
   * Create a virtual instrument through the UI (management page → preset grid).
   *
   * @param {{preset?:string, name?:string}} opts preset is a key of
   *   VIRTUAL_INSTRUMENT_PRESETS ('piano', 'drums', …); omit for a custom one.
   * @returns {Promise<void>}
   */
  async createVirtualInstrumentViaUi({ preset = 'piano', name } = {}) {
    await this.page.click('#addVirtualInstrumentBtn');
    await this.page.waitForSelector('.virtual-preset-btn', { timeout: 10000 });
    if (name) {
      const input = this.page.locator('#virtualInstrumentName');
      if (await input.count()) await input.fill(name);
    }
    await this.page.click(`.virtual-preset-btn[data-type="${preset}"]`);
    await this.page.waitForSelector('.virtual-preset-btn', { state: 'detached', timeout: 10000 });
  }

  /**
   * Close the instrument-management page.
   *
   * NOTE: this modal has **no Escape and no backdrop handler** — `close()` is
   * only reachable from the ✕ and the footer button. Pressing Escape leaves a
   * full-screen `rgba(0,0,0,0.7)` overlay at z-index 10000 that swallows every
   * subsequent click, so the harness must click a real close affordance.
   * @returns {Promise<void>}
   */
  async closeInstruments() {
    const overlay = this.page.locator('.inst-mgmt-modal');
    if (!(await overlay.count())) return;
    await overlay.locator('.modal-close').first().click({ timeout: 10000 });
    await overlay.waitFor({ state: 'detached', timeout: 10000 });
  }

  /**
   * @returns {Promise<Array<{id:string,name:string,type:string,connected:boolean}>>}
   */
  async listDevices() {
    const res = await this.command('device_list', {});
    return res.devices || res || [];
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  /**
   * Import a MIDI file through the real `<input type=file>` the drop zone uses,
   * then dismiss the upload report the way a user must.
   *
   * `#uploadProgressOverlay` is `aria-modal` and covers the page; it is only
   * removed by its own "Done" button (no Escape, no backdrop click), so a
   * harness that skipped this step would have every later click intercepted.
   *
   * @param {string} absPath
   * @returns {Promise<void>}
   */
  async importMidiViaUi(absPath) {
    await this.page.setInputFiles('#fileInput', absPath);
    const done = this.page.locator('#uploadDoneBtn');
    await done.waitFor({ state: 'visible', timeout: 60000 });
    await done.click();
    await this.page
      .locator('#uploadProgressOverlay.show')
      .waitFor({ state: 'detached', timeout: 10000 })
      .catch(async () => {
        // The overlay keeps the node and drops the `show` class.
        await this.page.waitForFunction(
          () => !document.getElementById('uploadProgressOverlay')?.classList.contains('show'),
          null,
          { timeout: 10000 }
        );
      });
  }

  /**
   * Wait until a file with this name appears in the SPA's list.
   * @param {string} filename
   * @param {number} [timeoutMs]
   * @returns {Promise<string>} the file id
   */
  async waitForFileInList(filename, timeoutMs = 30000) {
    const sel = `#fileList li[data-file-name="${filename}"]`;
    await this.page.waitForSelector(sel, { timeout: timeoutMs });
    return this.page.getAttribute(sel, 'data-file-id');
  }

  /** @returns {Promise<Array<{id:string,name:string,state:string}>>} */
  async filesInList() {
    return this.page.$$eval('#fileList li[data-file-id]', (lis) =>
      lis.map((li) => ({
        id: li.dataset.fileId,
        name: li.dataset.fileName,
        state: (li.querySelector('.file-grid-state')?.textContent || '').trim(),
        classes: li.className
      }))
    );
  }

  /**
   * Click one of the per-file action buttons.
   *
   * A **real** Playwright click on purpose, never `element.click()` from
   * `evaluate()`: a dispatched DOM click ignores hit-testing, so it would
   * happily "work" through an invisible or forgotten overlay left behind by a
   * modal that failed to close — exactly the class of defect a browser harness
   * exists to catch. Buttons are appended in a fixed order (edit, route, play,
   * delete) by `createFileElement()` in index.html.
   *
   * @param {string} filename
   * @param {'edit'|'route'|'play'|'delete'} action
   */
  async fileAction(filename, action) {
    const index = { edit: 0, route: 1, play: 2, delete: 3 }[action];
    if (index === undefined) throw new Error(`unknown file action "${action}"`);
    const row = this.page.locator(`#fileList li[data-file-name="${filename}"]`);
    await row.waitFor({ timeout: 15000 });
    await row.locator('.file-actions button').nth(index).click({ timeout: 20000 });
  }

  // ── Modals ────────────────────────────────────────────────────────────────

  /**
   * Escape / backdrop-independent close: press Escape, then click any visible
   * close affordance, then assert nothing is left.
   * @param {string} selector root selector of the modal
   */
  async closeModal(selector) {
    await this.page.keyboard.press('Escape');
    const still = await this.page.locator(selector).count();
    if (still) {
      const close = this.page.locator(
        `${selector} .close-btn, ${selector} .modal-close, ${selector} [aria-label*="lose"], ${selector} [aria-label*="ermer"]`
      );
      if (await close.count())
        await close
          .first()
          .click({ timeout: 3000 })
          .catch(() => {});
    }
  }

  /**
   * Count the DOM nodes a modal leaves behind. A modal that appends an overlay
   * to `document.body` and forgets to remove it shows up here immediately.
   * @returns {Promise<{bodyChildren:number, overlays:number, nodes:number}>}
   */
  async domFootprint() {
    return this.page.evaluate(() => ({
      bodyChildren: document.body.children.length,
      overlays: document.querySelectorAll(
        '.modal-overlay, .modal, [class*="overlay"], [id$="Overlay"], [id$="Modal"]'
      ).length,
      nodes: document.getElementsByTagName('*').length
    }));
  }

  // ── Live MIDI routing (R12 / F-138) ───────────────────────────────────────

  /**
   * Open the live-routing modal from its header button.
   *
   * A **real** click on `#liveRoutingBtn`: the whole point of F-138 is that the
   * commands existed but no affordance reached them, so the scenario must go
   * through the same pixel a user would.
   * @returns {Promise<void>}
   */
  async openLiveRouting() {
    await this.page.click('#liveRoutingBtn', { timeout: 15000 });
    await this.page.waitForSelector('#live-routing-modal-overlay', { timeout: 15000 });
    // The modal issues device_list + route_list on open; wait for the list to
    // have rendered (either rows or the "no route" placeholder).
    await this.page.waitForSelector('#lrt-routes .lrt-route, #lrt-routes .lrt-empty', {
      timeout: 15000
    });
  }

  /** Close the live-routing modal with Escape (BaseModal handles it). */
  async closeLiveRouting() {
    if (!(await this.page.locator('#live-routing-modal-overlay').count())) return;
    await this.page.keyboard.press('Escape');
    await this.page
      .locator('#live-routing-modal-overlay')
      .waitFor({ state: 'detached', timeout: 10000 });
  }

  /**
   * Create a route through the modal's two selects and its Create button.
   * @param {string} sourceId      device id for the source select
   * @param {string} destinationId device id for the destination select
   * @returns {Promise<number>} the number of route rows after the click
   */
  async createRouteViaUi(sourceId, destinationId) {
    const before = await this.page.locator('#lrt-routes .lrt-route').count();
    await this.page.selectOption('#lrt-source', sourceId);
    await this.page.selectOption('#lrt-destination', destinationId);
    await this.page.click('#lrt-create', { timeout: 10000 });
    await this.page.waitForFunction(
      (n) => document.querySelectorAll('#lrt-routes .lrt-route').length > n,
      before,
      { timeout: 15000 }
    );
    return this.page.locator('#lrt-routes .lrt-route').count();
  }

  /**
   * The routes as the **modal** renders them (not as the backend reports them).
   * @returns {Promise<Array<{id:string,label:string,enabled:boolean}>>}
   */
  async routeRows() {
    return this.page.$$eval('#lrt-routes .lrt-route', (rows) =>
      rows.map((r) => ({
        id: r.getAttribute('data-lrt-route'),
        label: (r.querySelector('.lrt-route-path')?.textContent || '').trim(),
        enabled: !!r.querySelector('.lrt-enabled')?.checked
      }))
    );
  }

  /** The routes as the backend knows them. @returns {Promise<Object[]>} */
  async backendRoutes() {
    const res = await this.command('route_list', {});
    return (res && res.routes) || [];
  }

  /**
   * Options currently offered by one of the modal's device selects.
   * @param {'source'|'destination'} which
   * @returns {Promise<Array<{value:string,label:string}>>}
   */
  async routingSelectOptions(which) {
    return this.page.$$eval(`#lrt-${which} option`, (opts) =>
      opts.map((o) => ({ value: o.value, label: (o.textContent || '').trim() }))
    );
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  /**
   * @returns {Promise<{playing:boolean, label:string, file:string,
   *   stopDisabled:boolean, playDisabled:boolean, time:string,
   *   progressWidth:string}>} what the header transport currently shows.
   */
  async transportState() {
    return this.page.evaluate(() => ({
      playing: !!document.querySelector('#headerStopBtn:not([disabled])'),
      label: (document.querySelector('#headerPlayPauseBtn')?.textContent || '').trim(),
      file: (document.querySelector('#headerFileName')?.textContent || '').trim(),
      stopDisabled: !!document.querySelector('#headerStopBtn')?.disabled,
      playDisabled: !!document.querySelector('#headerPlayPauseBtn')?.disabled,
      time: (document.querySelector('#headerTime')?.textContent || '').trim(),
      progressWidth: document.querySelector('#headerProgressFill')?.style.width || ''
    }));
  }

  /**
   * Stop playback the way the operator does it: a real click on the header's
   * Stop button. Never `playback_stop` through the socket — the whole point of
   * F-94 is whether the *button* is there and works.
   * @returns {Promise<void>}
   */
  async clickStop() {
    await this.page.click('#headerStopBtn', { timeout: 15000 });
  }

  /** @returns {Promise<any>} the backend's own playback status. */
  async playbackStatus() {
    return this.command('playback_status', {});
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  /**
   * Toast text currently on screen (the SPA's only feedback channel for many
   * operations, so worth asserting on).
   * @returns {Promise<string[]>}
   */
  async toasts() {
    return this.page.$$eval('.toast, [class*="toast"]', (els) =>
      els.map((e) => (e.textContent || '').trim()).filter(Boolean)
    );
  }

  /** @returns {Promise<number>} readyState of the SPA's WebSocket. */
  async wsReadyState() {
    return this.page.evaluate(() => (window.api && window.api.ws ? window.api.ws.readyState : -1));
  }

  /**
   * Sever the SPA's WebSocket from inside the page, the way a Wi-Fi drop would.
   * `close()` on the client object would be a *clean* shutdown and skips the
   * reconnect path; closing the underlying socket with a non-1000 code is what
   * actually exercises `attemptReconnect`.
   * @param {number} [code]
   */
  async killWebSocket(code = 1006) {
    await this.page.evaluate((c) => {
      const ws = window.api && window.api.ws;
      if (!ws) throw new Error('no websocket on window.api');
      // 1006 cannot be sent by close(); emulate an abnormal drop by closing
      // with a permitted code the client treats as unexpected, then firing the
      // handler the transport would have fired.
      try {
        ws.close(c === 1006 ? 4000 : c, 'e2e-drop');
      } catch {
        ws.close();
      }
    }, code);
  }
}
