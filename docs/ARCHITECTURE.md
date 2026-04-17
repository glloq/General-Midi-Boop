# Architecture - Ma-est-tro v5.0.0

## Overview

Ma-est-tro is a real-time MIDI orchestration system for Raspberry Pi. It manages MIDI devices, routes MIDI messages, plays MIDI files, and provides a web-based control interface.

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
│  │ MIDI Layer  │  │ Managers     │  │ Storage Layer    │   │
│  │ DeviceManager│  │ Bluetooth    │  │ Database (SQLite)│   │
│  │ MidiRouter  │  │ Network      │  │ FileManager      │   │
│  │ MidiPlayer  │  │ Lighting     │  │ BackupScheduler  │   │
│  │ AutoAssigner│  │ Serial       │  │ MidiDatabase     │   │
│  │ Latency     │  │              │  │ InstrumentDB     │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
Ma-est-tro/
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
│   ├── midi/                  # MIDI domain
│   │   ├── DeviceManager.js   # Device discovery & management
│   │   ├── MidiRouter.js      # Message routing
│   │   ├── MidiPlayer.js      # File playback
│   │   ├── AutoAssigner.js    # Instrument auto-assignment
│   │   ├── ChannelAnalyzer.js # MIDI channel analysis
│   │   ├── InstrumentMatcher.js # Scoring & matching
│   │   ├── DrumNoteMapper.js  # Drum note mapping
│   │   ├── MidiTransposer.js  # Note transposition
│   │   ├── TablatureConverter.js # MIDI ↔ tablature conversion
│   │   ├── LatencyCompensator.js
│   │   ├── ScoringConfig.js   # Assignment scoring weights
│   │   └── AnalysisCache.js   # LRU analysis cache
│   ├── storage/               # Persistence layer
│   │   ├── Database.js        # Main facade (SQLite + migrations)
│   │   ├── MidiDatabase.js    # MIDI file queries
│   │   ├── InstrumentDatabase.js
│   │   ├── LightingDatabase.js
│   │   ├── StringInstrumentDatabase.js
│   │   ├── FileManager.js     # MIDI file I/O
│   │   ├── BackupScheduler.js # Automated backups
│   │   └── dbHelpers.js       # Shared query builders
│   ├── managers/              # Optional service managers
│   │   ├── BluetoothManager.js  # BLE MIDI
│   │   ├── NetworkManager.js    # RTP-MIDI
│   │   ├── SerialMidiManager.js # GPIO UART MIDI
│   │   └── LightingManager.js  # Lighting orchestration
│   ├── lighting/              # Lighting drivers
│   │   ├── LightingEffectsEngine.js
│   │   ├── GpioStripDriver.js # GPIO LED strips
│   │   ├── ArtNetDriver.js    # DMX via ArtNet
│   │   ├── SacnDriver.js      # sACN/E1.31
│   │   ├── OscLightDriver.js  # OSC control
│   │   ├── HttpLightDriver.js # HTTP webhooks
│   │   └── MqttLightDriver.js # MQTT
│   ├── audio/
│   │   └── DelayCalibrator.js # Microphone-based latency calibration
│   ├── config/
│   │   └── Config.js          # Config with env-var overrides
│   └── utils/
│       └── JsonValidator.js   # Message validation
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
├── migrations/                # SQL migration files (40 numbered)
├── tests/                     # Jest + Vitest test suites
└── docs/                      # Feature documentation
```

Feature-specific docs:
[`MIDI_EDITOR.md`](MIDI_EDITOR.md) — MIDI editor modal architecture ·
[`TABLATURE_IMPLEMENTATION.md`](TABLATURE_IMPLEMENTATION.md) — string-instrument pipeline ·
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
- **Migrations**: 29 numbered SQL files, auto-run at startup in transactions
- **Backup**: Automated daily via BackupScheduler (node-schedule)
- **Sub-modules**: MidiDatabase, InstrumentDatabase, LightingDatabase, StringInstrumentDatabase

## Configuration

Configuration follows a layered approach:
1. `config.json` (defaults, committed)
2. `.env` file (local overrides via dotenv)
3. Environment variables (`MAESTRO_*` prefix)

See `.env.example` for all supported variables.

## Security

- **Helmet.js** for HTTP security headers
- **Optional token auth** via `MAESTRO_API_TOKEN` (HTTP Bearer + WS query param)
- Health check (`/api/health`) always public

## CI/CD

- **GitHub Actions**: lint + test on push/PR to main
- **Pre-commit hooks**: Husky + lint-staged (ESLint + Prettier)
