# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Général Midi Boop is a real-time MIDI orchestration system that runs standalone
on a Raspberry Pi (offline-first). It connects DIY/off-the-shelf MIDI
instruments (USB, BLE, RTP-MIDI, GPIO UART), auto-routes and auto-adapts
standard MIDI files to each instrument's capabilities, and is driven from a
browser SPA over WebSocket. Node.js >= 20, ES modules (`"type": "module"`).

## Commands

- `npm run dev` — backend with hot reload (nodemon); serves the SPA at `http://localhost:8080`
- `npm start` — production server
- `npm test` — backend tests (Jest, `tests/**/*.test.js` excluding `tests/frontend/`)
- `npm run test:frontend` — frontend tests (Vitest, jsdom, `tests/frontend/**/*.test.js`)
- `npm run lint` / `npm run lint:fix` — ESLint over `src/ public/js/ tests/`
- `npm run format` — Prettier (write)
- `npm run typecheck` — `tsc --noEmit` (JS checked via JSDoc + `src/types/` ambient defs)
- `npm run build` — Vite production build of the frontend
- `npm run migrate` — apply SQL migrations manually (also auto-applied at startup)

Run a single test:

- Backend: `npm test -- tests/event-bus.test.js` or `npm test -- -t "pattern"`
- Frontend: `npx vitest run tests/frontend/path/to.test.js`

## Native dependencies / dev environment

`better-sqlite3` and `midi` (pulled in via `easymidi`) are native modules. The
`midi` build needs ALSA dev headers (`libasound2-dev`) and a toolchain, which
are often absent in containers/CI. To get the JS tooling working without the
native builds:

```
npm install --ignore-scripts
```

`jest.config.cjs` probes for working `better-sqlite3` bindings at startup and
**automatically skips** SQLite-dependent suites when they're missing, so the
backend test command still runs the pure-JS suites. Vitest (frontend) and
ESLint/Prettier/tsc do not need native modules. `postinstall` runs
`scripts/install-default-sf2.js` (skipped by `--ignore-scripts`).

## Architecture

### Backend composition

`server.js` → `src/core/Application.js` is the single composition root. Its
`initialize()` constructs every long-lived service and registers each one in a
`ServiceContainer` (DI). Lifecycle is `constructor → initialize() → start() →
stop()`; `setupShutdownHandlers()` routes SIGINT/SIGTERM through `stop()` once.

Services receive an **app-facade Proxy** (`deps`) that resolves names from the
container, falling back to the `Application` instance. **Registration order in
`initialize()` is a hard contract**: a service that captures `deps.foo` into
`this.foo` in its constructor freezes that reference, so `foo` must be
registered _before_ its consumer. Genuinely late-bound services (`wsServer`,
`eventLoopMonitor`, `backupScheduler`) must be accessed via `this._deps.X` or a
getter, never an eager capture. Optional transports/lighting
(Bluetooth/Network/Serial/Lighting) load inside `try/catch` and are silently
absent on hosts lacking native deps — always access them with `?.`.

### Command pattern (client ↔ server)

All client/server traffic is JSON over WebSocket: `{ id, command, version?, data? }`.
`CommandRegistry` (`src/api/`) auto-discovers every `*.js` in
`src/api/commands/`; each module exports `register(registry, app)` and binds
named handlers. Dispatch pipeline: envelope validation → per-command payload
validation via `JsonValidator.validateByCommand` (precompiled from
`src/api/commands/schemas/*.schemas.js`) → versioned-handler lookup → async
handler → response correlated by `id`. `ApplicationError` subclasses
(`src/core/errors/`) surface to the client verbatim; any other throw is masked
as "Internal server error".

**To add a command:** add a handler to (or create) a module in
`src/api/commands/` and add its payload schema to the matching
`schemas/*.schemas.js`. No central registration map to edit.

### Other patterns

- **EventBus** (`src/core/EventBus.js`) — observer pub/sub for internal
  decoupling (`midi_message`, `device_connected`, `playback_started`,
  `file_uploaded`, …); also drives WS broadcasts to the UI.
- **Repositories** (`src/repositories/`) — thin business-named wrappers over
  `Database` (`src/persistence/Database.js`), which delegates to per-table
  managers in `src/persistence/tables/`. New persistence code goes through a
  repository, not raw SQL in handlers.
- **MIDI domain** (`src/midi/`) split into `devices/`, `routing/`,
  `playback/`, `adaptation/` (auto-assigner, transposer, drum remap),
  `messages/`, `files/`, `instrument/`, `compensation/`.

### Database & migrations

SQLite via `better-sqlite3` (WAL). `migrations/001_baseline.sql` consolidates
the historical chain; later changes are added as new numbered
`migrations/NNN_*.sql` files applied at startup in numeric order, each in its
own transaction (a failure at file N keeps 1..N-1 committed and retries from N).
Automated daily backups via `BackupScheduler`.

### Configuration

Layered: `config.json` (committed defaults) → `.env` (dotenv) →
`GMBOOP_*` environment variables. See `.env.example`. Optional token auth via
`GMBOOP_API_TOKEN` (HTTP Bearer + WS query param); `/api/health` and
`/api/update-status` are always public (the latter so the dashboard can poll
during an in-place update). HTTP auth is also bypassed for same-origin
requests and RFC1918/loopback clients (`isPrivateClient` in
`src/api/HttpServer.js`); avoid exposing the box behind a tunnel that
rewrites the source IP into a private range without enforcing the token.

### Frontend

Vanilla-JS SPA under `public/js/` — no framework. Shared base classes in
`public/js/core/` (BaseView, BaseModal, EventBus);
`public/js/api/` holds the WebSocket `BackendAPIClient`. Feature modules live
under `public/js/features/<feature>/` (keyboard, midi-editor, loop, auto-assign,
lighting, settings, …). i18n in `public/locales/` (28 languages). The MIDI
editor (`public/js/features/midi-editor/`) is a large multi-view modal — see
`docs/MIDI_EDITOR.md`.

## Conventions

- ESLint extends `eslint:recommended`; unused args allowed with `_` prefix;
  `no-console` is a warning (backend logging goes through `src/core/Logger.js`).
- Husky pre-commit runs lint-staged: `eslint --max-warnings 5` + `prettier --check`
  on staged `*.js`. Keep new warnings near zero.
- `docs/` holds feature docs and ADRs (`docs/adr/`); `docs/ARCHITECTURE.md`
  predates the `managers/`→`transports/` and `views/components/`→`features/`
  renames — trust the actual tree and this file over it.
