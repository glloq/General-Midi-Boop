/**
 * @file tests/e2e/lib/playwright.mjs
 * @description Locates a usable Playwright installation.
 *
 * The E2E harness deliberately depends only on the `playwright` *library*
 * (browser automation), never on `@playwright/test` (the runner) — see
 * `tests/e2e/lib/runner.mjs` for the tiny runner used instead. That keeps the
 * harness runnable with `node tests/e2e/run.mjs` from a checkout that has no
 * Playwright in `node_modules`, as long as one is installed globally
 * (which is the case in the audit/CI image).
 *
 * Resolution order:
 *   1. `import('playwright')`            — local devDependency (preferred)
 *   2. `$PLAYWRIGHT_MODULE`              — explicit absolute path override
 *   3. `npm root -g`/known global prefixes — globally installed CLI
 *
 * The browser binaries themselves are located by Playwright via
 * `PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers` in the audit image).
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Candidate global npm roots probed when `playwright` is not a local dep. */
const GLOBAL_HINTS = [
  '/opt/node22/lib/node_modules',
  '/usr/lib/node_modules',
  '/usr/local/lib/node_modules',
  '/usr/local/share/npm/lib/node_modules'
];

/** @returns {string[]} absolute directories that may contain `playwright/`. */
function globalRoots() {
  const roots = [];
  if (process.env.NPM_CONFIG_PREFIX) {
    roots.push(path.join(process.env.NPM_CONFIG_PREFIX, 'lib', 'node_modules'));
  }
  try {
    const out = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (out.trim()) roots.push(out.trim());
  } catch {
    /* npm not on PATH — fall back to the static hints below */
  }
  return [...roots, ...GLOBAL_HINTS];
}

/**
 * Resolve the Playwright module.
 *
 * @returns {Promise<{chromium: any, source: string}>}
 * @throws {Error} with actionable instructions when nothing is found.
 */
export async function loadPlaywright() {
  // 1. Local dependency.
  try {
    const mod = await import('playwright');
    return { chromium: mod.chromium, source: 'node_modules/playwright' };
  } catch {
    /* not installed locally — continue */
  }

  // 2. Explicit override.
  const override = process.env.PLAYWRIGHT_MODULE;
  if (override) {
    const entry =
      override.endsWith('.mjs') || override.endsWith('.js')
        ? override
        : path.join(override, 'index.mjs');
    if (!existsSync(entry)) {
      throw new Error(`PLAYWRIGHT_MODULE points at "${entry}" which does not exist`);
    }
    const mod = await import(entry);
    return { chromium: mod.chromium, source: entry };
  }

  // 3. Global install. NOTE: ESM ignores NODE_PATH, so the absolute path of the
  //    package entry point must be imported directly.
  for (const root of globalRoots()) {
    const entry = path.join(root, 'playwright', 'index.mjs');
    if (existsSync(entry)) {
      const mod = await import(entry);
      return { chromium: mod.chromium, source: entry };
    }
  }

  throw new Error(
    'Playwright not found.\n' +
      '  · local:  npm i -D playwright && npx playwright install chromium\n' +
      '  · global: npm i -g playwright  (then set PLAYWRIGHT_BROWSERS_PATH)\n' +
      '  · or set PLAYWRIGHT_MODULE=/abs/path/to/node_modules/playwright'
  );
}
