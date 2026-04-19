# Architecture - Général Midi Boop

## Overview

Général Midi Boop is a real-time MIDI orchestration system for Raspberry Pi. It manages MIDI devices, routes MIDI messages, plays MIDI files, and provides a web-based control interface.

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (SPA)                           │
│  BaseView / BaseModal / AppRegistry                         │
│  BackendAPIClient (WebSocket)                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ WebSocket (JSON)
┌──────────────────────────┼──────────────────────────────────┐
│  Node.js Backend         │                                  │
│                          ▼                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ HttpServer   │  │ WebSocket    │  │ CommandHandler   │   │
│  │ (Express)    │  │ Server       │──│ + CommandRegistry│   │
│  │ + Helmet     │  │ + Auth       │  │ (15 modules)     │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│         │                                     │             │
│         ▼                                     ▼             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ EventBus    │  │ ServiceCont. │  │ Application      │   │
│  │ (Observer)  │  │ (DI)         │  │ (Composition Root│   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│         │                                     │             │
│  ┌──────┴──────────────────┬──────────────────┤             │
│  ▼                         ▼                  ▼             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ MIDI Layer  │  │ Transports   │  │ Persistence Layer│   │
│  │ DeviceManager│  │ Bluetooth    │  │ Database (SQLite)│   │
│  │ MidiRouter  │  │ Network      │  │ BackupScheduler  │   │
│  │ MidiPlayer  │  │ Serial       │  │ Table managers   │   │
│  │ AutoAssigner│  │ Lighting     │  │ Repositories     │   │
│  │ Latency     │  │              │  │ FileManager      │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
General-Midi-Boop/
├── server.js                  # Entry point
├── config.json                # Default configuration
├── ecosystem.config.cjs       # PM2 process manager config
├── src/
│   ├── core/                  # Framework-level code
│   │   ├── Application.js     # Composition root & lifecycle
│   │   ├── EventBus.js        # Pub/sub event system
│   │   ├── Logger.js          # Logging with rotation + JSON
│   │   ├── ServiceContainer.js# DI container
│   │   └── errors/            # Structured error hierarchy
│   ├── api/                   # HTTP & WebSocket layer
│   │   ├── HttpServer.js      # Express + Helmet + auth
│   │   ├── WebSocketServer.js # WS server + heartbeat
│   │   ├── CommandHandler.js  # Command dispatch
│   │   ├── CommandRegistry.js # Auto-discovery of commands
│   │   └── commands/          # 15 command modules
│   ├── midi/                  # MIDI domain (split into sub-modules)
│   │   ├── devices/           # Device discovery & management
│   │   ├── routing/           # Router, channel analysis, splitters
│   │   ├── playback/          # Player, playback commands, analysis cache
│   │   ├── adaptation/        # Auto-assigner, matcher, transposer, drums
│   │   ├── messages/          # MIDI message constructors/parsers
│   │   └── files/             # MIDI file parsing helpers
│   ├── persistence/           # SQLite layer
│   │   ├── Database.js        # Main facade + lifecycle
│   │   ├── DatabaseLifecycle.js
│   │   ├── BackupScheduler.js # Automated backups
│   │   ├── dbHelpers.js       # Shared query builders
│   │   └── tables/            # Per-table managers
│   ├── repositories/          # Thin business-named wrappers over Database
│   │   ├── FileRepository.js
│   │   ├── RoutingRepository.js
│   │   ├── InstrumentRepository.js
│   │   └── …                   # one per domain entity
│   ├── files/                 # MIDI file I/O
│   │   ├── FileManager.js
│   │   ├── BlobStore.js       # On-disk blob storage
│   │   ├── MidiFileParser.js
│   │   ├── MidiFileValidator.js
│   │   ├── JsonMidiConverter.js
│   │   └── UploadQueue.js
│   ├── transports/            # Optional service managers (renamed from managers/)
│   │   ├── BluetoothManager.js  # BLE MIDI
│   │   ├── NetworkManager.js    # RTP-MIDI
│   │   ├── SerialMidiManager.js # GPIO UART MIDI
│   │   └── RtpMidiSession.js
│   ├── lighting/              # Lighting manager + drivers (co-located)
│   │   ├── LightingManager.js
│   │   ├── LightingEffectsEngine.js
│   │   ├── GpioStripDriver.js # GPIO LED strips
│   │   ├── ArtNetDriver.js    # DMX via ArtNet
│   │   ├── SacnDriver.js      # sACN/E1.31
│   │   ├── OscLightDriver.js  # OSC control
│   │   ├── HttpLightDriver.js # HTTP webhooks
│   │   └── MqttLightDriver.js # MQTT
│   ├── audio/
│   │   └── DelayCalibrator.js # Microphone-based latency calibration
│   ├── core/                  # Application framework (incl. Config)
│   │   └── Config.js          # Consolidated config with env-var overrides
│   ├── types/                 # Ambient TypeScript type definitions
│   └── utils/                 # Cross-cutting helpers (JsonValidator, …)
├── public/                    # Frontend SPA
│   ├── js/
│   │   ├── core/              # BaseView, BaseModal, EventBus, etc.
│   │   ├── views/components/  # 35+ UI components
│   │   │   └── midi-editor/   # MIDI editor modal (20 files — see docs/MIDI_EDITOR.md)
│   │   ├── api/               # BackendAPIClient (WebSocket)
│   │   ├── audio/             # Synthesizer modules
│   │   └── utils/             # Helpers
│   ├── locales/               # i18n translation files (28 languages)
│   └── styles/                # CSS stylesheets
├── migrations/                # SQL migrations (consolidated baseline + incrementals)
├── tests/                     # Jest + Vitest test suites
└── docs/                      # Feature documentation
```

Feature-specific docs:
[`MIDI_EDITOR.md`](MIDI_EDITOR.md) — MIDI editor modal architecture ·
[`AUTO_ASSIGNMENT.md`](AUTO_ASSIGNMENT.md) — channel-to-instrument auto-assignment ·
[`MIDI_CC_INSTRUMENT_CONTROLS.md`](MIDI_CC_INSTRUMENT_CONTROLS.md) — reserved CC ranges ·
[`API.md`](API.md) — WebSocket command reference.

## Key Design Patterns

### Command Pattern
All client-server communication flows through the Command pattern:
1. Client sends JSON via WebSocket: `{ command: "getDevices", id: "abc123" }`
2. `CommandRegistry` auto-discovers modules in `src/api/commands/`
3. Each module exports `{ commands: { commandName: handler } }`
4. Response sent back with matching `id` for correlation

### Observer Pattern (EventBus)
Internal decoupling via `EventBus`:
- `midi_message`, `device_connected`, `device_disconnected`
- `playback_started`, `playback_stopped`
- `file_uploaded`, `error`

### Dependency Injection
`ServiceContainer` provides lazy factory-based DI with circular dependency detection.
Services are registered in `Application.js` (composition root).

## Data Flow

```
MIDI Device → DeviceManager → EventBus → MidiRouter → Output Device
                                  │
                                  ├→ WebSocket broadcast to UI
                                  └→ Logger
```

## Database

- **Engine**: SQLite (better-sqlite3) with WAL mode
- **Migrations**: `001_baseline.sql` consolidates the historical chain; later
  migrations land as additional numbered files and are applied at startup
  inside a single transaction.
- **Backup**: Automated daily via BackupScheduler (node-schedule)
- **Sub-modules**: `src/persistence/tables/*` (MidiDatabase, InstrumentDatabase,
  LightingDatabase, StringInstrumentDatabase, …)

## Configuration

Configuration follows a layered approach:
1. `config.json` (defaults, committed)
2. `.env` file (local overrides via dotenv)
3. Environment variables (`GMBOOP_*` prefix)

See `.env.example` for all supported variables.

## Security

- **Helmet.js** for HTTP security headers
- **Optional token auth** via `GMBOOP_API_TOKEN` (HTTP Bearer + WS query param)
- Health check (`/api/health`) always public

## CI/CD

- **GitHub Actions**: lint + test on push/PR to main
- **Pre-commit hooks**: Husky + lint-staged (ESLint + Prettier)
