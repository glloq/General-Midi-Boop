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

Général Midi Boop can be deployed using Docker for simplified setup and isolation.

### Quick Start

```bash
docker-compose up -d
```

This uses the provided `Dockerfile` and `docker-compose.yml` in the project root.

### Data Persistence

The Docker Compose configuration includes volume mounts to persist data between container restarts:

- `./data` - SQLite database
- `./uploads` - Uploaded MIDI files
- `./logs` - Application logs

To stop the container:

```bash
docker-compose down
```

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
