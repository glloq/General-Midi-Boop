# Audit tooling

Offline, hardware-free analysis tools written for the 2026-08-22 audit
(`docs/audit/2026-08-22/`). All are standalone Node ESM scripts with no dependencies
beyond what the project already installs, and all are safe to run in CI.

## Prerequisites

```bash
npm install --ignore-scripts
npm rebuild better-sqlite3 --build-from-source   # else 10 persistence suites silently skip
```

## `command-inventory.mjs` — §U, §BD

Cross-references every WebSocket command against its schema, frontend call sites, tests
and `docs/API.md`.

```bash
node scripts/audit/command-inventory.mjs           # summary
node scripts/audit/command-inventory.mjs --json    # full per-command matrix
```

The registered-command list comes from **actually loading `CommandRegistry`** and its
auto-discovered modules, not from grepping, so it cannot drift from runtime behaviour.

Reports: schema coverage, commands never called by the frontend, commands with no test,
undocumented commands, orphan schemas, phantom frontend calls, unwired schema files.

**Suggested CI use:** fail the build if schema coverage drops below its current value
(a ratchet).

## `xss-sinks.mjs` — §AI

Finds every `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` sink in
`public/js`, follows the assigned expression across multi-line template literals, and
classifies each interpolation.

```bash
node scripts/audit/xss-sinks.mjs
node scripts/audit/xss-sinks.mjs --only=RISKY --json
```

Verdicts: `CLEAN` (static), `T_UNSAFE` (unescaped `t()` with params into HTML),
`RISKY` (user-controlled-looking value with no escaper), `DYNAMIC` (needs judgement).

It knows about this codebase's conventions: the `tHtml`/`escapeHtml`/`esc` escapers, and
the local `const t = (key, fallback) => …` shadowing helper that would otherwise produce
false `T_UNSAFE` hits.

> Heuristic, not proof. Every `RISKY` hit needs a human look — in the 2026-08-22 run all
> 27 were false positives.

## `dead-modules.mjs` — §A01, §A04

Finds modules nothing imports.

```bash
node scripts/audit/dead-modules.mjs
```

Matches on resolved paths, so an identifier that merely contains a filename
(`handleMidiMessage` vs `MidiMessage.js`) cannot make dead code look alive. Accounts for
both of this project's non-static loading conventions: `src/api/commands/*.js`
(auto-discovered by `CommandRegistry`) and the lighting `DRIVER_MODULES` dynamic-import
map.

## `live-probe.mjs` — §T, §V, §AK, §AH, §AJ

Black-box probe against a running server: HTTP routes, security headers, path traversal,
WebSocket envelope contract, auth fail-closed behaviour, prototype pollution, command
bursts and oversized frames.

```bash
GMBOOP_SERVER_PORT=8099 node server.js &
GMBOOP_API_TOKEN=$(grep '^GMBOOP_API_TOKEN=' .env | cut -d= -f2-) \
  node scripts/audit/live-probe.mjs http://127.0.0.1:8099
```

A non-browser client sends no `Origin`, so it never hits the same-origin bypass and
must present the token — pass `GMBOOP_API_TOKEN` or the WebSocket checks will (correctly)
be refused with 401.

Prints `PASS`/`FAIL` plus the observed value for each check.

## `licenses.mjs` — §BS, F-158

Inventories the licences of everything the project redistributes, and generates the
notice file the MIT/Apache/BSD licences of those packages oblige us to convey.

```bash
node scripts/audit/licenses.mjs            # summary by licence
node scripts/audit/licenses.mjs --json     # per-package matrix
node scripts/audit/licenses.mjs --emit     # (re)write THIRD-PARTY-NOTICES.md
node scripts/audit/licenses.mjs --assets   # shipped-asset registration report
node scripts/audit/licenses.mjs --check    # CI gate, exit 1 on a problem
```

The runtime closure comes from `package-lock.json` — every entry npm has **not**
flagged `"dev": true`, i.e. exactly what `npm ci --omit=dev` installs — so it cannot
drift from what actually ships. `node_modules/` is read only for licence texts, so run
`npm install --ignore-scripts` first or every package reports `NOT-INSTALLED`.

A licence is never guessed: declared field, then the deprecated `{type}`/array forms,
then detection from the licence text (reported as `source = file`), then `UNKNOWN` —
which fails the gate rather than being assumed permissive.

`--check` fails when a runtime dependency is copyleft, when one has no establishable
licence, when `THIRD-PARTY-NOTICES.md` is stale, or when a shipped asset is missing
from `assets/ASSET-LICENSES.md`. That last check is what keeps the asset inventory
alive: a new icon cannot ship without someone recording where it came from.

**Suggested CI use:** a `licenses` job running `--check`.

## Related test suites

- `tests/audit/midi-core-conformance.test.js` — §D01–D05, BK
- `tests/audit/midi-file-robustness.test.js` — §E01, E03 (includes a seeded fuzz pass)

Both run under the normal `npm test`.
