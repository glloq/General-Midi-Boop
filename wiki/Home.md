# Général Midi Boop Wiki

**MIDI Orchestration System for Raspberry Pi with a Modern Web Interface.**

Général Midi Boop manages MIDI devices, edits and plays MIDI files with per-instrument latency compensation, and synchronises stage lighting — all from a browser. It can automatically adapt MIDI files to the capabilities of your connected instruments.

> **Status:** beta (v0.7.0). The interface is becoming stable; minor bugs are still being ironed out.

![Main Interface](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/accueil.png?raw=true)

## Quick Start

```bash
git clone https://github.com/glloq/General-Midi-Boop.git
cd General-Midi-Boop
chmod +x scripts/Install.sh
./scripts/Install.sh
```

Then open `http://<Raspberry-Pi-IP>:8080`. Full instructions in [[Installation]].

## What's Inside

| Area | Page |
|------|------|
| Set up a Pi from scratch | [[Installation]] |
| Tour the web UI | [[Usage-Guide]] |
| Understand the codebase | [[Architecture]] |
| Edit MIDI (piano roll, tab, drums, wind) | [[MIDI-Editor]] |
| Auto-assign channels to instruments | [[Auto-Assignment]] |
| Drive 146 WebSocket commands | [[API-Reference]] |
| Wire USB / BLE / RTP-MIDI / GPIO UART | [[Hardware-Integration]] |
| Control lights (DMX, sACN, OSC, MQTT…) | [[Lighting]] |
| Tablature, hand-position, calibration | [[Advanced-Topics]] |
| Run in production | [[Deployment]] |
| Hack on the project | [[Contributing]] |
| Fix common problems | [[Troubleshooting]] |

## Key Features

- **MIDI transports**: USB, Bluetooth LE, Network (RTP-MIDI / RFC 6295), Serial UART (up to 6 ports on Pi 4 at 31250 baud).
- **Multi-mode editor**: piano roll, tablature (19 tunings), drum grid (GM map), wind articulation, with CC automation, pitch-bend and tempo curves.
- **Auto-adaptation**: per-channel analysis, instrument compatibility scoring (0–100), intelligent drum remapping, octave wrapping, audible preview.
- **Lighting**: GPIO LED strips, ArtNet, sACN/E1.31, OSC, HTTP, MQTT, with effects engine and DMX fixture profiles.
- **Latency compensation**: microphone-based calibration with median statistics and confidence scoring.
- **Internationalisation**: 28 UI languages, including translated GM instrument names.

## Project Resources

- Repository: [glloq/General-Midi-Boop](https://github.com/glloq/General-Midi-Boop)
- Issues: [GitHub Issues](https://github.com/glloq/General-Midi-Boop/issues)
- Changelog: [CHANGELOG.md](https://github.com/glloq/General-Midi-Boop/blob/main/CHANGELOG.md)
- Roadmap: [TODO.md](https://github.com/glloq/General-Midi-Boop/blob/main/TODO.md)
- License: [MIT](https://github.com/glloq/General-Midi-Boop/blob/main/LICENSE)

## About This Wiki

The wiki is the navigable, top-level entry point for the project. The deep technical material lives in [`docs/`](https://github.com/glloq/General-Midi-Boop/tree/main/docs) and each wiki page links to the relevant source. Wiki sources are tracked in the main repo under `wiki/` and synchronised on every push to `main`.
