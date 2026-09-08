/**
 * @file tests/e2e/lib/browser.mjs
 * @description Browser fixture: console/network capture, CDP heap metrics,
 * screenshot-on-failure.
 *
 * The point of an E2E harness for this project is not only "does the click
 * work" — it is **what does the browser see that no Node test can**: silent
 * exceptions, 404s on assets, listeners that are never removed, a WebSocket
 * that drops mid-playback. Every page created here therefore records:
 *
 *   - every `console` message (with type), every uncaught `pageerror`
 *   - every failed request and every response with status >= 400
 *   - every WebSocket open/close (Playwright `websocket` events)
 *
 * so a spec can assert on them after the fact instead of having to predict
 * them up front.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadPlaywright } from './playwright.mjs';

/** Console types that count as an error for the "clean console" assertion. */
const ERROR_TYPES = new Set(['error']);

/**
 * A page plus everything the browser told us about it.
 */
export class Recorder {
  constructor() {
    /** @type {Array<{type:string,text:string,at:number,location?:string}>} */
    this.console = [];
    /** @type {Array<{message:string,stack:string,at:number}>} */
    this.pageErrors = [];
    /** @type {Array<{url:string,error:string,at:number}>} */
    this.requestFailures = [];
    /** @type {Array<{url:string,status:number,at:number}>} */
    this.httpErrors = [];
    /** @type {Array<{url:string,event:string,at:number}>} */
    this.websockets = [];
  }

  /** @returns {Array} console entries whose type is an error, plus page errors. */
  errors() {
    return [
      ...this.console.filter((c) => ERROR_TYPES.has(c.type)),
      ...this.pageErrors.map((e) => ({ type: 'pageerror', text: e.message, at: e.at }))
    ];
  }

  /** @returns {Array} console entries of type warning. */
  warnings() {
    return this.console.filter((c) => c.type === 'warning' || c.type === 'warn');
  }

  /** Drop everything recorded so far (use between phases of a long test). */
  clear() {
    this.console.length = 0;
    this.pageErrors.length = 0;
    this.requestFailures.length = 0;
    this.httpErrors.length = 0;
  }

  /** @returns {string} a compact human-readable dump for the report. */
  summary(limit = 40) {
    const lines = [];
    for (const e of this.errors().slice(0, limit))
      lines.push(`  [${e.type}] ${e.text.slice(0, 300)}`);
    for (const f of this.requestFailures.slice(0, limit))
      lines.push(`  [netfail] ${f.url} :: ${f.error}`);
    for (const h of this.httpErrors.slice(0, limit)) lines.push(`  [http ${h.status}] ${h.url}`);
    return lines.join('\n');
  }
}

/**
 * Launch Chromium once per run.
 *
 * @param {{headless?:boolean, slowMo?:number}} [opts]
 * @returns {Promise<{browser:any, source:string}>}
 */
export async function launchBrowser(opts = {}) {
  const { chromium, source } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: opts.headless !== false,
    slowMo: opts.slowMo ?? 0,
    // --no-sandbox: the audit/CI image runs as root in a container.
    // --autoplay-policy: the SPA creates an AudioContext on boot.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      // Needed by the heap-growth spec (window.gc / precise metrics).
      '--js-flags=--expose-gc'
    ]
  });
  return { browser, source };
}

/**
 * Create an instrumented page.
 *
 * @param {any} browser
 * @param {{viewport?:{width:number,height:number}, artifactsDir?:string, offline?:boolean}} [opts]
 * @returns {Promise<{page:any, context:any, rec:Recorder, cdp:any}>}
 */
export async function newInstrumentedPage(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1600, height: 1000 },
    // A stable, non-localised UA locale keeps i18n assertions deterministic.
    locale: opts.locale ?? 'en-US'
  });
  const page = await context.newPage();
  const rec = new Recorder();

  page.on('console', (m) => {
    let loc = '';
    try {
      const l = m.location();
      loc = l && l.url ? `${l.url}:${l.lineNumber}` : '';
    } catch {
      /* location() can throw on detached frames */
    }
    rec.console.push({ type: m.type(), text: m.text(), at: Date.now(), location: loc });
  });
  page.on('pageerror', (e) =>
    rec.pageErrors.push({ message: e.message, stack: e.stack || '', at: Date.now() })
  );
  page.on('requestfailed', (r) =>
    rec.requestFailures.push({
      url: r.url(),
      error: r.failure()?.errorText || 'unknown',
      at: Date.now()
    })
  );
  page.on('response', (r) => {
    if (r.status() >= 400)
      rec.httpErrors.push({ url: r.url(), status: r.status(), at: Date.now() });
  });
  page.on('websocket', (ws) => {
    rec.websockets.push({ url: ws.url(), event: 'open', at: Date.now() });
    ws.on('close', () => rec.websockets.push({ url: ws.url(), event: 'close', at: Date.now() }));
    ws.on('socketerror', (err) =>
      rec.websockets.push({ url: ws.url(), event: `error:${err}`, at: Date.now() })
    );
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable').catch(() => {});

  return { page, context, rec, cdp };
}

/**
 * Read the renderer's JS heap through CDP.
 *
 * `Runtime.getHeapUsage` is the honest number for "did this leak": it is the
 * live heap after the isolate's own accounting, not the process RSS.
 *
 * @param {any} cdp
 * @returns {Promise<{usedMB:number, totalMB:number, jsEventListeners:number, nodes:number, documents:number}>}
 */
export async function heapSnapshotMetrics(cdp) {
  const usage = await cdp.send('Runtime.getHeapUsage');
  const perf = await cdp.send('Performance.getMetrics');
  const byName = Object.fromEntries(perf.metrics.map((m) => [m.name, m.value]));
  return {
    usedMB: +(usage.usedSize / 1048576).toFixed(2),
    totalMB: +(usage.totalSize / 1048576).toFixed(2),
    jsEventListeners: byName.JSEventListeners ?? -1,
    nodes: byName.Nodes ?? -1,
    documents: byName.Documents ?? -1
  };
}

/**
 * Ask V8 to collect, so a heap reading reflects retained (leaked) memory
 * rather than uncollected garbage. Best-effort: three passes with a pause.
 * @param {any} cdp
 */
export async function forceGc(cdp) {
  for (let i = 0; i < 3; i++) {
    await cdp.send('HeapProfiler.enable').catch(() => {});
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Screenshot helper used by the harness on failure.
 * @param {any} page
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<string|null>} written path
 */
export async function shoot(page, dir, name) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name.replace(/[^a-z0-9._-]+/gi, '_')}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}
