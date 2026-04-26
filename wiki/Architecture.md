# Architecture

A high-level orientation. The full design is in [`docs/ARCHITECTURE.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/ARCHITECTURE.md).

## Layered View

```
┌────────────────────────────────────────────┐
│  Browser SPA (public/)                     │
│  - Vite, BaseView/BaseModal framework      │
│  - WebSocket client (BackendAPIClient)     │
└────────────────────────────────────────────┘
                  │  WebSocket + REST
                  ▼
┌────────────────────────────────────────────┐
│  api/   HttpServer · WebSocketServer       │
│         CommandRegistry · CommandHandler   │
└────────────────────────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────────┐
│  Domain services                           │
│  midi/  devices · routing · playback ·     │
│         adaptation · messages · files · gm │
│  transports/  BLE · RTP-MIDI · Serial      │
│  lighting/    drivers · effects engine     │
│  audio/       DelayCalibrator              │
│  files/       FileManager · BlobStore      │
└────────────────────────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────────┐
│  repositories/ (business-named wrappers)   │
│  persistence/  Database · BackupScheduler  │
│                tables/* · dbHelpers        │
│  SQLite (better-sqlite3, WAL mode)         │
└────────────────────────────────────────────┘
```

## Core Building Blocks

| File | Responsibility |
|---|---|
| [`src/core/Application.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/core/Application.js) | Composition root, lifecycle (start/stop) |
| [`src/core/ServiceContainer.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/core/ServiceContainer.js) | DI container, lazy factories, circular-dep detection |
| [`src/core/EventBus.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/core/EventBus.js) | In-process pub/sub between command handlers and services |
| [`src/core/Logger.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/core/Logger.js) | JSON logging with rotation |
| [`src/core/Config.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/core/Config.js) | Layered config (file → `.env` → env vars) |
| [`src/core/errors/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/core/errors) | Structured error hierarchy |

## Patterns Used

- **Dependency Injection** via `ServiceContainer` — every service is registered explicitly; no service-locator anti-patterns.
- **Command pattern** — every WebSocket message is a named command resolved by [`CommandRegistry`](https://github.com/glloq/General-Midi-Boop/blob/main/src/api/CommandRegistry.js), which auto-discovers modules under [`src/api/commands/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/api/commands).
- **Repository pattern** — domain code talks to `*Repository` classes; the SQLite schema is hidden behind per-table managers in [`src/persistence/tables/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/persistence/tables).
- **Observer / EventBus** — decouples command handlers from real-time fan-out (UI updates, MIDI input echoes, lifecycle hooks).
- **Driver pattern** — lighting backends extend [`BaseLightingDriver`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/BaseLightingDriver.js); transports follow the same shape (`BluetoothManager`, `NetworkManager`, `SerialMidiManager`).

## Request Flow

1. Browser opens WebSocket (auth via `?token=` if `GMBOOP_API_TOKEN` is set).
2. UI sends `{ command, id, ...params }`.
3. `WebSocketServer` → `CommandHandler` → resolves command in `CommandRegistry`.
4. Handler calls one or more services / repositories.
5. Services emit `EventBus` events; the WS layer broadcasts them to subscribed clients.
6. Response `{ type: "response", id, data }` returns to the caller.

## Frontend Architecture

- Custom `BaseView` / `BaseModal` framework (no React/Vue).
- Each feature lives under [`public/js/features/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/js/features) (40+ modules, e.g. `midi-editor/`, `lighting/`, `auto-assign/`).
- `BackendAPIClient` wraps the WebSocket with request correlation, auto-retry, and event subscriptions.
- i18n via JSON dictionaries in [`public/locales/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/locales) (28 languages).

## Persistence

- SQLite via `better-sqlite3` in WAL mode.
- Migrations in [`migrations/`](https://github.com/glloq/General-Midi-Boop/tree/main/migrations) (29 files; `001_baseline.sql` is the consolidated baseline).
- Daily automated backups via [`BackupScheduler`](https://github.com/glloq/General-Midi-Boop/blob/main/src/persistence/BackupScheduler.js).
- File blobs use a content-addressable store (SHA-256 keys) in [`src/files/BlobStore.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/files/BlobStore.js) for deduplication.

## Architecture Decision Records

ADRs are tracked under [`docs/adr/`](https://github.com/glloq/General-Midi-Boop/tree/main/docs/adr) — read these before proposing structural changes.
