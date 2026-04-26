# Installation

This page is the wiki-friendly summary. The full reference, including every supported configuration knob, lives in [`docs/INSTALLATION.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/INSTALLATION.md).

## Hardware Requirements

- Raspberry Pi 3B+, 4, or 5
- 2 GB RAM minimum (4 GB recommended)
- SD card with Raspberry Pi OS (Bookworm or newer)
- Network connection (Ethernet or Wi-Fi)

## Software Requirements

- Raspberry Pi OS (Bookworm+) or any Linux with `systemd` and `alsa-utils`
- Node.js ≥ 20.0.0
- Internet access during installation

## Automated Install (recommended)

```bash
git clone https://github.com/glloq/General-Midi-Boop.git
cd General-Midi-Boop
chmod +x scripts/Install.sh
./scripts/Install.sh
```

The installer ([`scripts/Install.sh`](https://github.com/glloq/General-Midi-Boop/blob/main/scripts/Install.sh)) installs Node 20, project dependencies, sets up PM2, and registers a `systemd` unit.

## Manual Install

```bash
git clone https://github.com/glloq/General-Midi-Boop.git
cd General-Midi-Boop
npm install
npm run migrate    # apply SQLite migrations
npm start          # production server
```

## Configuration

Three layered sources, in increasing precedence:

1. **`config.json`** — repo defaults. Server port, WebSocket port, MIDI buffer, default latency, DB path, log level, playback defaults, transport flags.
2. **`.env`** — local overrides loaded by `dotenv`. See [`.env.example`](https://github.com/glloq/General-Midi-Boop/blob/main/.env.example).
3. **Environment variables** — highest priority, useful for systemd / Docker.

Common variables:

| Variable | Purpose |
|---|---|
| `GMBOOP_SERVER_PORT` | HTTP port (default 8080) |
| `GMBOOP_SERVER_WS_PORT` | WebSocket port |
| `GMBOOP_DATABASE_PATH` | SQLite file location |
| `GMBOOP_LOG_LEVEL` | `error` / `warn` / `info` / `debug` |
| `GMBOOP_LOG_FILE` | Path to log file (rotated) |
| `GMBOOP_BLE_ENABLED` | Enable Bluetooth LE MIDI |
| `GMBOOP_SERIAL_ENABLED` | Enable GPIO UART MIDI |
| `GMBOOP_SERIAL_BAUD_RATE` | Serial baud rate (default 31250) |
| `GMBOOP_API_TOKEN` | Bearer token for `/api/*` and WS `?token=` |

## Accessing the Interface

After the server starts:

- Local: `http://localhost:8080`
- LAN: `http://<Raspberry-Pi-IP>:8080`

Find the Pi's IP with `hostname -I` on the Pi itself.

## Optional Subsystems

- **Bluetooth LE MIDI** — needs BlueZ + `node-ble` permissions on D-Bus. Pairing flow detailed in [[Hardware-Integration]].
- **GPIO UART MIDI** — enable UART overlays in `/boot/firmware/config.txt`, wire 5 V → opto-isolated MIDI in/out, see [`docs/GPIO_MIDI_WIRING.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/GPIO_MIDI_WIRING.md).
- **GPIO LED strips** — installs `pigpio` automatically; the user running the service must be in the `gpio` group.
- **Microphone calibration** — requires an ALSA-detectable input. See [[Advanced-Topics]].

## Next Steps

- Walk through the UI in [[Usage-Guide]]
- Run as a service or in Docker — see [[Deployment]]
- Things going wrong? Start with [[Troubleshooting]]
