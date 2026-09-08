# Installation Guide

Complete installation and configuration guide for Général Midi Boop.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Starting the Server](#starting-the-server)
- [Accessing the Interface](#accessing-the-interface)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Bluetooth LE MIDI Setup](#bluetooth-le-midi-setup)
- [Network MIDI (RTP-MIDI) Setup](#network-midi-rtp-midi-setup)
- [Docker Deployment](#docker-deployment)
- [Service Management](#service-management)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## Prerequisites

### Hardware
- Raspberry Pi 3B+, 4, or 5
- 2GB RAM minimum (4GB recommended)
- SD card with Raspberry Pi OS (Lite or Desktop)
- Network connection (Ethernet or WiFi)

### Software
- Raspberry Pi OS (Bookworm or newer recommended)
- Node.js >= 20.0.0
- Internet connection for installation

---

## Installation

### Automatic Installation (Recommended)

```bash
# Clone the repository
git clone https://github.com/glloq/General-Midi-Boop.git
cd General-Midi-Boop

# Run the installation script
chmod +x scripts/Install.sh
./scripts/Install.sh
```

The script automatically installs:
- Node.js 20 LTS
- System dependencies (ALSA, Bluetooth, build tools)
- PM2 process manager
- SQLite database
- Bluetooth configuration
- Systemd service for automatic startup

### Manual Installation

If you prefer manual installation:

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install system dependencies
sudo apt-get install -y libasound2-dev bluetooth bluez libbluetooth-dev

# Install npm dependencies
npm install

# Install PM2 globally
sudo npm install -g pm2
```

---

## Starting the Server

### Development Mode

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

### With PM2 (Recommended)

```bash
# Start
npm run pm2:start

# View logs
npm run pm2:logs

# Stop
npm run pm2:stop

# Restart
npm run pm2:restart
```

---

## Accessing the Interface

### Local Access

```
http://localhost:8080
```

### Network Access

```
http://<Raspberry-Pi-IP>:8080
```

Find your IP address:
```bash
hostname -I
```

---

## Configuration

### config.json

Edit `config.json` to customize settings:

```json
{
  "server": { "port": 8080, "wsPort": 8080, "staticPath": "./public" },
  "midi": { "bufferSize": 1024, "sampleRate": 44100, "defaultLatency": 10 },
  "database": { "path": "./data/gmboop.db" },
  "logging": { "level": "info", "file": "./logs/gmboop.log", "console": true },
  "playback": { "defaultTempo": 120, "defaultVolume": 100, "lookahead": 100 },
  "latency": { "defaultIterations": 5, "recalibrationDays": 7 },
  "ble": { "enabled": false, "scanDuration": 10000 },
  "serial": { "enabled": false, "autoDetect": true, "baudRate": 31250, "ports": [] }
}
```

### Server Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `server.port` | 8080 | HTTP server port |
| `server.wsPort` | 8080 | WebSocket server port |
| `server.staticPath` | ./public | Path to static frontend files |

### MIDI Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `midi.bufferSize` | 1024 | MIDI buffer size |
| `midi.sampleRate` | 44100 | Audio sample rate |
| `midi.defaultLatency` | 10 | Default latency compensation in ms |

### Playback Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `playback.defaultTempo` | 120 | Default playback tempo (BPM) |
| `playback.defaultVolume` | 100 | Default playback volume (0-127) |
| `playback.lookahead` | 100 | Playback lookahead in ms |

### Latency Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `latency.defaultIterations` | 5 | Number of iterations for latency calibration |
| `latency.recalibrationDays` | 7 | Days before recalibration is suggested |

### Database Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `database.path` | ./data/gmboop.db | Path to SQLite database file |

### Logging

| Setting | Default | Description |
|---------|---------|-------------|
| `logging.level` | info | Log level: debug, info, warn, error |
| `logging.file` | ./logs/gmboop.log | Log file path |
| `logging.console` | true | Enable console logging |

### BLE (Bluetooth Low Energy)

| Setting | Default | Description |
|---------|---------|-------------|
| `ble.enabled` | false | Enable Bluetooth LE MIDI scanning |
| `ble.scanDuration` | 10000 | BLE scan duration in ms |

### Serial MIDI

| Setting | Default | Description |
|---------|---------|-------------|
| `serial.enabled` | false | Enable serial MIDI support |
| `serial.autoDetect` | true | Auto-detect serial MIDI devices |
| `serial.baudRate` | 31250 | Serial baud rate (MIDI standard: 31250) |
| `serial.ports` | [] | Manually specified serial ports |

---

## Environment Variables

All configuration values can be overridden with environment variables. Create a `.env` file in the project root (see `.env.example` for a template).

| Variable | Default | Description |
|----------|---------|-------------|
| `GMBOOP_SERVER_PORT` | 8080 | HTTP server port |
| `GMBOOP_SERVER_WS_PORT` | 8080 | WebSocket server port |
| `GMBOOP_DATABASE_PATH` | ./data/gmboop.db | Path to SQLite database |
| `GMBOOP_LOG_LEVEL` | info | Log level: debug, info, warn, error |
| `GMBOOP_LOG_FILE` | ./logs/gmboop.log | Log file path |
| `GMBOOP_BLE_ENABLED` | false | Enable Bluetooth LE MIDI |
| `GMBOOP_SERIAL_ENABLED` | false | Enable serial MIDI |
| `GMBOOP_SERIAL_BAUD_RATE` | 31250 | Serial baud rate |
| `GMBOOP_API_TOKEN` | *(none)* | Optional API authentication token |
| `PORT` | 8080 | Legacy alias for `GMBOOP_SERVER_PORT` |

Example `.env` file:

```bash
GMBOOP_SERVER_PORT=3000
GMBOOP_LOG_LEVEL=debug
GMBOOP_BLE_ENABLED=true
GMBOOP_API_TOKEN=my-secret-token
```

Environment variables take precedence over values in `config.json`.

---

## Bluetooth LE MIDI Setup

Général Midi Boop supports Bluetooth Low Energy (BLE) MIDI devices using the BLE MIDI Service UUID `03b80e5a-ede8-4b33-a751-6ce34ec4c700`. The integration uses node-ble, which communicates with Bluez via D-Bus.

### Prerequisites

- Bluetooth hardware (built-in on Raspberry Pi 3B+ and later)
- The `bluez` package (installed automatically by the installation script)

### Configuration

Enable BLE MIDI in `config.json`:

```json
{
  "ble": {
    "enabled": true,
    "scanDuration": 10000
  }
}
```

Or via environment variable:

```bash
GMBOOP_BLE_ENABLED=true
```

### User Permissions

Your user must be a member of the `bluetooth` group:

```bash
sudo usermod -a -G bluetooth $USER
```

Log out and log back in for the group change to take effect.

### Scanning and Pairing

Once BLE is enabled, scan for and pair Bluetooth MIDI devices directly from the Général Midi Boop web interface. The interface will discover nearby BLE MIDI instruments and allow you to connect to them.

---

## Network MIDI (RTP-MIDI) Setup

Général Midi Boop supports RTP-MIDI, a session-based protocol for sending MIDI data over a network connection.

### How It Works

RTP-MIDI uses `RtpMidiSession` for connection management, allowing you to connect to MIDI instruments and controllers on your local network.

### Usage

From the Général Midi Boop web interface, you can scan the local network for available RTP-MIDI instruments. Discovered instruments can be connected and used just like locally attached MIDI devices.

No additional configuration is required beyond having network connectivity between Général Midi Boop and the target instruments.

---

## Docker Deployment

Docker gives you the web UI, file management, playback over the network and
the network-based lighting drivers, in an isolated container. It does **not**
give you hardware MIDI — see [Limitations](#docker-limitations) before you
choose it over a native install.

> **Verify before you trust it.** `scripts/verify-docker.sh` builds the image,
> starts it, waits for `/api/health` and checks that the health payload is
> honest. Run it after any change to `Dockerfile`, `docker-compose.yml` or
> `.dockerignore` — the packaging was silently broken for months precisely
> because nothing ever built the image.

### Quick start

```bash
docker compose up -d
docker compose logs -f
curl http://localhost:8080/api/health
```

`docker compose up` builds from the `Dockerfile` in the project root. First
build takes about a minute (it downloads the base image, installs production
dependencies and fetches the ~30 MB default soundfont); rebuilds after a code
change take a couple of seconds.

### Build options

Both are `--build-arg`s on the `Dockerfile` and Compose variables in
`docker-compose.yml`:

| Variable | Default | What it does |
|---|---|---|
| `NODE_IMAGE` | `node:20-slim` | Base image. Pin a digest (`node:20.20.2-slim@sha256:…`) for a reproducible build, or point at a mirror / CA-augmented base if you build behind a TLS-inspecting proxy. |
| `WITH_RUNTIME_ASSETS` | `1` | Fetch the default soundfont and the vendored `WebAudioFontPlayer.js` at build time so the browser synth works offline. Set to `0` for a ~30 MB smaller image with no audio preview. |

```bash
WITH_RUNTIME_ASSETS=0 docker compose build
# or, without Compose:
docker build --build-arg WITH_RUNTIME_ASSETS=0 -t gmboop .
```

The asset download is **non-fatal**: a build on a machine with no egress still
produces a working image, it just logs a warning and ships without the audio
preview. Set `GMBOOP_SF2_URL` / `GMBOOP_WAF_PLAYER_URL` to reach an internal
mirror.

### Runtime configuration

`docker-compose.yml` reads these from the host `.env` (Compose loads it
automatically) or from your shell:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Host port. The container always listens on 8080. |
| `NODE_HEAP_MB` | `320` | V8 heap cap, in MiB. |
| `MEMORY_LIMIT` | `512M` | Container memory limit. |
| `GMBOOP_LOG_LEVEL` | `info` | |
| `GMBOOP_SECURITY_MODE` | `trusted-lan` | `secure` demands a bearer token on every request; the SPA cannot present one, so `secure` is API-access-only today. |
| `GMBOOP_API_TOKEN` | *(empty)* | See [API token](#docker-api-token). |

**`NODE_HEAP_MB` and `MEMORY_LIMIT` move together.** Resident memory is the V8
heap *plus* the native heap (better-sqlite3 page cache, WebSocket send
buffers, zlib), plus code and stacks. Setting the heap cap equal to the
container limit — as this file used to — means the OOM killer fires before V8
ever reaches the pressure that triggers its final GC. Keep the heap cap at
roughly 60-65 % of the limit.

### Data persistence

Three **named volumes**, created and managed by Compose:

| Volume | Mounted at | Contents |
|---|---|---|
| `gmboop-data` | `/app/data` | `gmboop.db` (SQLite + WAL), uploaded MIDI files, imported soundfonts |
| `gmboop-logs` | `/app/logs` | Application logs |
| `gmboop-backups` | `/app/backups` | Automatic daily database backups |

`gmboop-data` is the one that matters: destroy it and you destroy every
instrument, route, playlist and setting.

```bash
docker compose down       # stops the container, KEEPS the volumes
docker compose down -v    # stops the container and DELETES the volumes
```

<a id="docker-api-token"></a>
### API token

If `GMBOOP_API_TOKEN` is unset, the server mints a random token at startup and
writes it to `/app/.env` **inside the container's writable layer**, which any
recreation (`docker compose up --force-recreate`, an image rebuild, an upgrade)
throws away — a new token is minted and every stored client credential stops
working. Two ways to make it stable:

1. Put `GMBOOP_API_TOKEN=<value>` in the host `.env`. Compose interpolates it
   into the container's environment; the server then leaves it alone. This is
   the recommended option, and it is what an installation that has already run
   `scripts/Install.sh` gets for free.
2. Uncomment the `./.env:/app/.env` bind mount in `docker-compose.yml` (create
   an empty `./.env` first) so the generated token survives on the host.

<a id="docker-limitations"></a>
### Limitations

**No hardware MIDI.** The image maps no `/dev/snd`, passes through no serial
device and shares no D-Bus socket, so USB MIDI, BLE MIDI and GPIO/serial MIDI
are structurally out of reach. `/api/health` says so plainly:

```json
"usb":    { "status": "failed",   "detail": "Native MIDI library unavailable (easymidi/ALSA bindings missing) — USB MIDI ports cannot be opened" },
"ble":    { "status": "failed",   "detail": "D-Bus system bus not available" },
"serial": { "status": "disabled", "detail": "Serial MIDI disabled in configuration" }
```

That is the truth, not a defect — but it does mean **Docker is not the way to
run the box that drives your instruments**. Install natively on the Pi
(`scripts/Install.sh`) for that. To build a container that *does* drive USB
MIDI, the Dockerfile header lists the four changes required (compile the
native `midi` module, reinstate `libasound2`, map `/dev/snd`, join the `audio`
group).

**No in-place update.** `system_update` (which shells out to
`scripts/update.sh`: `git pull`, `npm install`, restart a systemd/PM2 service)
is meaningless inside a container. Update by rebuilding the image:

```bash
git pull && docker compose up -d --build
```

**Architecture.** `docker compose build` builds for the platform of the Docker
daemon that runs it. An image built on an x86_64 laptop will **not** run on a
Raspberry Pi: `npm rebuild better-sqlite3` downloads a prebuilt binding for the
*build* platform. Cross-build with buildx + QEMU:

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64   # once per host
docker buildx build --platform linux/arm64 -t gmboop:arm64 --load .
```

### Image size

About 450 MB on disk (≈ 330 MB of layers), of which 219 MB is the
`node:20-slim` base and 30 MB the default soundfont. `WITH_RUNTIME_ASSETS=0`
brings it to about 390 MB.

---

## Service Management

### With PM2

```bash
npm run pm2:start     # Start the server
npm run pm2:stop      # Stop the server
npm run pm2:restart   # Restart the server
npm run pm2:logs      # View real-time logs
npm run pm2:status    # Check status
```

### With systemd

```bash
sudo systemctl start gmboop     # Start
sudo systemctl stop gmboop      # Stop
sudo systemctl restart gmboop   # Restart
sudo systemctl status gmboop    # Check status
sudo systemctl enable gmboop    # Enable on boot
sudo systemctl disable gmboop   # Disable on boot
```

### View Logs

```bash
# PM2 logs
npm run pm2:logs

# Systemd logs
sudo journalctl -u gmboop -f

# Application logs
tail -f logs/gmboop.log
```

---

## Updating

### Automatic Update

```bash
cd ~/General-Midi-Boop
./scripts/update.sh
```

The script:
- Pulls latest code from git
- Updates npm dependencies
- Runs database migrations
- Restarts the server

### Manual Update

```bash
cd ~/General-Midi-Boop
git pull origin main
npm install
npm run pm2:restart
```

---

## Troubleshooting

### MIDI Devices Not Detected

```bash
# List MIDI connections
aconnect -l

# List MIDI hardware
amidi -l

# Check ALSA
aplay -l
```

### Bluetooth Issues

```bash
# Check Bluetooth status
sudo systemctl status bluetooth

# Restart Bluetooth
sudo systemctl restart bluetooth

# Scan for devices manually
bluetoothctl
> power on
> scan on
```

### Server Won't Start

```bash
# Check if port is in use
sudo lsof -i :8080

# Check PM2 status
pm2 status

# View error logs
npm run pm2:logs
```

### Permission Issues

```bash
# Add user to required groups
sudo usermod -a -G audio,bluetooth $USER

# Logout and login again for changes to take effect
```

---

## Project Structure

```
General-Midi-Boop/
├── server.js                  # Entry point
├── config.json                # Default configuration
├── .env.example               # Environment variable template
├── Dockerfile                 # Docker image
├── docker-compose.yml         # Docker composition
├── ecosystem.config.cjs       # PM2 config
├── src/
│   ├── core/                  # Application framework (EventBus, Logger, DI, Config)
│   ├── api/                   # HTTP server, WebSocket, commands
│   ├── midi/                  # MIDI (devices/, routing/, playback/, adaptation/, …)
│   ├── persistence/           # SQLite database + per-table managers
│   ├── repositories/          # Business-named wrappers over persistence
│   ├── files/                 # MIDI file parsing, blob store, upload queue
│   ├── transports/            # Bluetooth, Network (RTP-MIDI), Serial
│   ├── lighting/              # Lighting manager + drivers (LED/DMX/ArtNet/OSC…)
│   ├── audio/                 # Delay calibration
│   ├── types/                 # Ambient TypeScript type definitions
│   └── utils/                 # Shared helpers
├── public/                    # Frontend (Web SPA)
│   ├── js/                    # JavaScript components
│   ├── locales/               # Translations (28 languages)
│   └── styles/                # CSS stylesheets
├── docs/                      # Documentation
├── migrations/                # SQLite migrations (consolidated baseline)
├── tests/                     # Test suites
├── scripts/                   # Installation/update scripts
├── data/                      # SQLite database (runtime)
├── uploads/                   # MIDI files (runtime)
└── logs/                      # Application logs (runtime)
```
