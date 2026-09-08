#!/usr/bin/env node
/**
 * @file tests/e2e/run.mjs
 * @description Entry point of the browser E2E harness.
 *
 *   node tests/e2e/run.mjs                 # every spec
 *   node tests/e2e/run.mjs 02 04           # only specs whose file name matches
 *   E2E_HEADED=1 node tests/e2e/run.mjs    # watch it happen
 *   E2E_PORT=8109 node tests/e2e/run.mjs   # another port
 *
 * It owns the whole lifecycle: it boots a disposable server on a dedicated port
 * with a **fresh database**, launches one Chromium, runs every spec against a
 * brand-new browser context, writes screenshots + a JSON report under
 * `tests/e2e/artifacts/`, and always stops the server — including on SIGINT.
 *
 * Exit code is the number of failed tests (0 = all green), so CI can gate on it
 * without parsing output.
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppServer, DEFAULT_PORT } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { run } from './lib/runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = path.join(HERE, 'specs');
const ARTIFACTS = path.join(HERE, 'artifacts');

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/** @param {string} l */
const log = (l) => process.stdout.write(l + '\n');

let server = null;
let browser = null;
let stopping = false;

/** Best-effort teardown. Idempotent — signal handlers and the happy path share it. */
async function teardown() {
  if (stopping) return;
  stopping = true;
  try {
    if (browser) await browser.close();
  } catch {
    /* the browser may already be gone */
  }
  try {
    if (server) await server.stop();
  } catch {
    /* stop() is best-effort */
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await teardown();
    process.exit(130);
  });
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });

  const specs = readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.spec.mjs'))
    .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
    .sort();

  if (!specs.length) {
    log(`no spec matched ${JSON.stringify(filters)} in ${SPECS_DIR}`);
    return 1;
  }

  log(`GeneralMidiBoop · browser E2E`);
  log(`  specs      : ${specs.join(', ')}`);

  server = new AppServer({ port: Number(process.env.E2E_PORT || DEFAULT_PORT) });
  log(`  server     : ${server.baseUrl} (workspace ${server.workspace})`);
  const bootT0 = Date.now();
  await server.start();
  log(`  server up  : ${Date.now() - bootT0} ms`);

  const launched = await launchBrowser({ headless: process.env.E2E_HEADED !== '1' });
  browser = launched.browser;
  log(`  playwright : ${launched.source}`);
  log(`  chromium   : ${browser.version()}`);

  // Specs register themselves into the runner's registry on import.
  for (const s of specs) {
    await import(pathToFileURL(path.join(SPECS_DIR, s)).href);
  }

  const deps = { server, browser, artifactsDir: ARTIFACTS };
  const { results, failed, passed } = await run(deps, log);

  const health = await server.health();
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: server.baseUrl,
    playwright: launched.source,
    chromium: browser.version(),
    node: process.version,
    health,
    summary: { passed, failed, total: results.length },
    results
  };
  const reportPath = path.join(ARTIFACTS, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  log('');
  log(`  ${passed} passed · ${failed} failed · report ${reportPath}`);
  log(`  server log: ${server.logPath}`);
  return failed;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  log(`\nHARNESS ERROR: ${err && err.stack ? err.stack : err}`);
  code = 1;
} finally {
  await teardown();
}
process.exit(code);
