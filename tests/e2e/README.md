# Browser E2E harness

Drives a real Chromium against a real, disposable GeneralMidiBoop server and
asserts on what the **browser** sees — clicks that land (or are swallowed by a
forgotten overlay), silent exceptions, listeners that pile up, a WebSocket that
drops mid-playback, a boot that stalls on an unreachable CDN.

It is deliberately independent of Jest and Vitest: those cover units and jsdom,
this covers the assembled product.

```bash
node tests/e2e/run.mjs              # everything
node tests/e2e/run.mjs 02           # only specs whose filename contains "02"
E2E_HEADED=1 node tests/e2e/run.mjs # watch it happen in a real window
```

Exit code = number of failed tests, so CI can gate on it without parsing output.

---

## Requirements

| Need | How it is satisfied |
|---|---|
| `playwright` (library only, **not** `@playwright/test`) | resolved from `node_modules`, else `$PLAYWRIGHT_MODULE`, else a global npm install — see `lib/playwright.mjs` |
| A Chromium build | located by Playwright via `PLAYWRIGHT_BROWSERS_PATH` |
| A working `better-sqlite3` | the server needs it to boot; `npm rebuild better-sqlite3 --build-from-source` if missing |

No MIDI hardware, no ALSA headers, no audio device. The scenarios use the
application's own **virtual instruments**, which is what makes browser E2E
possible on a bare CI box.

To install locally:

```bash
npm i -D playwright && npx playwright install chromium
```

In the audit/CI image Playwright is already global and the browsers live under
`/opt/pw-browsers`, so:

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/e2e/run.mjs
```

---

## What the harness does for you

`run.mjs` owns the whole lifecycle:

1. **Boots a disposable server** (`lib/server.mjs`) on port `8108` (override with
   `E2E_PORT`), with its own database, log file and upload directory under
   `tests/e2e/artifacts/workspace/`. The workspace is **wiped on every run**, so
   specs always start from an empty database.
   `GMBOOP_API_TOKEN` is set explicitly — without it `ApiTokenManager` writes a
   generated token into the repository's `.env`, which a test run must never do.
2. **Waits for `/api/health`** rather than sleeping.
3. **Launches one Chromium**, and gives every test a fresh browser context.
4. **Records, per page** (`lib/browser.mjs`): every console message, every
   uncaught `pageerror`, every failed request, every response ≥ 400, and every
   WebSocket open/close. Specs assert on these *after* the fact, so they catch
   errors nobody predicted.
5. **Writes artifacts** to `tests/e2e/artifacts/`: screenshots plus a machine
   readable `report.json` (every test, every step, every piece of evidence).
6. **Always stops the server**, including on Ctrl-C.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `E2E_PORT` | `8108` | HTTP/WS port for the disposable server |
| `E2E_HEADED` | unset | `1` runs a visible browser |
| `E2E_MODAL_CYCLES` | `50` | open/close cycles in the leak spec |
| `E2E_CDN_STALL_MS` | `8000` | how long the offline-boot spec stalls the CDN request |
| `E2E_SERVER_STDOUT` | unset | `1` streams the server's stdout into the run |
| `E2E_LOG_LEVEL` | `info` | server log level |
| `PLAYWRIGHT_MODULE` | unset | absolute path to a `playwright` package |

---

## Layout

```
tests/e2e/
  run.mjs                  entry point: server + browser + specs + report
  lib/
    playwright.mjs         finds a usable Playwright (local → env → global)
    server.mjs             AppServer: spawn, wait-for-health, stop, fresh db
    browser.mjs            instrumented pages, CDP heap metrics, screenshots
    runner.mjs             ~150-line runner: suite/test/step/expect
    app.mjs                page objects — all SPA selectors live here
  fixtures/
    make-midi.mjs          generates the MIDI files, using the app's own midi-file
  specs/
    01-boot.spec.mjs       boot, console cleanliness, offline boot (F-14)
    02-canonical.spec.mjs  the full user journey, one recorded step per stage
    03-modal-memory.spec.mjs  50 open/close cycles per heavy modal, heap + listeners
    04-resilience.spec.mjs WebSocket cut mid-playback, reload mid-playback
  artifacts/               screenshots, report.json, workspace/ (all generated)
```

---

## Adding a scenario

Create `specs/NN-name.spec.mjs`:

```js
import { suite, test, expect } from '../lib/runner.mjs';
import { newInstrumentedPage, shoot } from '../lib/browser.mjs';
import { AppPage } from '../lib/app.mjs';

suite('05 · playlists', () => {
  test('a playlist survives a reload', async (ctx, deps) => {
    const { page, rec } = await newInstrumentedPage(deps.browser);
    const app = new AppPage(page, rec, deps.server.baseUrl);
    try {
      await ctx.step('boot', () => app.open());
      await ctx.step('create it', async () => {
        // …clicks…
      });
      ctx.evidenceAdd('screenshot', await shoot(page, deps.artifactsDir, '05-playlist'));
      await ctx.step('it is still there after a reload', async () => {
        await app.open();
        expect(await page.locator('.playlist-row').count()).toBeGreaterThan(0);
      });
    } finally {
      await page.context().close();
    }
  });
});
```

`deps` carries `{ server, browser, artifactsDir }`. Specs register themselves on
import; `run.mjs` picks up any `*.spec.mjs` in `specs/`.

### House rules

- **One `ctx.step()` per meaningful stage.** A step that fails still leaves every
  earlier step marked PASS in `report.json`, which is what turns "the test is
  red" into "the journey breaks precisely here".
- **`ctx.evidenceAdd(label, value)` for anything a human will want to read** —
  measurements, DOM dumps, screenshot paths. It all lands in `report.json`.
- **Use real clicks** (`page.click`, `locator.click`), never
  `page.evaluate(() => el.click())`. A dispatched DOM click ignores hit-testing
  and will happily "succeed" through an invisible overlay — precisely the class
  of bug this harness exists to catch.
- **Put selectors in `lib/app.mjs`, not in specs.** When the UI moves, one file
  moves.
- **Never mutate shared state on the developer's machine.** Everything the run
  writes belongs under `tests/e2e/artifacts/`.
- **Do not weaken an assertion to get green.** If a stage genuinely cannot pass,
  let it fail and say so — a `ctx.softStep()` (recorded as WARN, non-blocking)
  exists only for observations that must not stop a longer journey, and the
  underlying defect then gets its own failing test.

---

## Known-failing tests

Some tests in this suite fail **because the application is broken**, not because
the harness is. They are kept red on purpose; see
`docs/audit/2026-09-07/08_E2E.md` for each one's finding number. Do not "fix"
them by relaxing the assertion.

---

## CI

The harness needs a Chromium and roughly four minutes. Suggested job (see the
audit report for the exact proposed diff):

```yaml
e2e:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: npx playwright install --with-deps chromium
    - run: npm run test:e2e
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: e2e-artifacts
        path: tests/e2e/artifacts/
```

Uploading `tests/e2e/artifacts/` matters: the screenshots and `report.json` are
how a failure gets diagnosed without reproducing it locally.
