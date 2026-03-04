# Ma-est-tro

> **MIDI Orchestration System for Raspberry Pi with Modern Web Interface**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi-3B%2B%2F4%2F5-red)](https://www.raspberrypi.org/)

Ma-est-tro is a MIDI management system that allows you to manage your MIDI devices, edit and play MIDI files with latency compensation, all from a modern web interface. It can automatically adapt MIDI files to the capabilities of your connected instruments.

![Main Interface](docs/images/main-interface.png)

## Installation

```bash
git clone https://github.com/glloq/Ma-est-tro.git
cd Ma-est-tro
chmod +x scripts/Install.sh
./scripts/Install.sh
```

Access the interface: `http://<Raspberry-Pi-IP>:8080`

See [docs/INSTALLATION.md](./docs/INSTALLATION.md) for detailed configuration.

## Features

### MIDI Devices

Support for multiple connection types:
- **USB MIDI** - Automatic detection and hot-plug
- **Bluetooth LE MIDI** - Scan and pair wireless instruments
- **Network MIDI (RTP-MIDI)** - Connect over WiFi/Ethernet
- **Serial MIDI (GPIO UART)** - Connect instruments via Raspberry Pi GPIO pins at 31250 baud. Supports multiple hardware UARTs (up to 6 on Pi 4 with device tree overlays), hot-plug monitoring, and full MIDI protocol including Running Status and SysEx. See [docs/GPIO_MIDI_WIRING.md](./docs/GPIO_MIDI_WIRING.md) for wiring details.

Configure each device with custom name, latency compensation, instrument type, note range, and polyphony.

### Auto-Adaptation of MIDI Files

Ma-est-tro can automatically analyze a MIDI file and assign each channel to the best-suited connected instrument:
- **Channel analysis** - Detects instrument type (drums, melody, bass, harmony), note ranges, and polyphony per channel
- **Instrument matching** - Evaluates connected instruments capabilities and generates compatibility scores (0-100)
- **Intelligent drum mapping** - Remaps General MIDI drum notes (35-81) to available instrument notes with priority-based substitution (kick → snare → hi-hat → crash → toms)
- **Octave wrapping** - Option to extend note range by wrapping notes into available octaves
- **Audio preview** - Listen to assignments before committing

See [docs/MIDI_ASSIGNMENT_ADAPTATION_GUIDE.md](./docs/MIDI_ASSIGNMENT_ADAPTATION_GUIDE.md) for details.

### MIDI Files

- Upload and organize MIDI files in folders
- Drag-and-drop support
- Play, edit, or route files to devices
- **File management** - Rename, duplicate, move between folders, export/save as
- **Multi-select & batch operations** - Select multiple files for batch actions
- **Search & filtering** - Search by name, filter by duration, tempo, track count, instrument type, channel count, compatibility, and more
- **Filter presets** - Save and load custom filter combinations
- **Sorting** - Sort files by any criteria with ascending/descending order

### MIDI Editor

![MIDI Editor](docs/images/editor.png)

Built-in Piano Roll editor:
- Add, move, delete notes
- Snap grid (1/1 to 1/16)
- 16 channels with distinct colors
- CC & Pitchbend editing
- Built-in synthesizer for preview
- **Tempo automation** - Tempo curve editor with visual automation
- **Instrument selector** - Display playable note range for connected instruments
- **Ctrl+A** to select all notes
- **Cursor repositioning** during playback pause

### Virtual Keyboard

![Virtual Keyboard](docs/images/virtual-keyboard.png)

Test devices from your browser:
- Mouse click and drag
- Computer keyboard support (AZERTY/QWERTY)
- Adjustable octave and velocity

### Channel Routing

Route each MIDI channel (1-16) to a different device for multi-instrument playback, with instrument type display.

### Microphone-Based Delay Calibration

Automatically measure the real latency of your instruments using a microphone:
- Sends MIDI notes and detects the audio response via ALSA
- Multiple measurements for statistical accuracy (median-based)
- Confidence scoring based on measurement consistency
- Configurable threshold and measurement count

### Instrument Management

Dedicated instrument management page:
- Define instrument capabilities (note range, polyphony, instrument type)
- Validation system to ensure all instruments are properly configured
- Enable/disable devices

### Settings

- Theme: Light, Dark, Colored
- Virtual keyboard octaves (1-4)
- Language selection

## Languages

Available in 28 languages: English, French, Spanish, German, Italian, Portuguese, Dutch, Polish, Russian, Chinese, Japanese, Korean, Turkish, Hindi, Bengali, Thai, Vietnamese, Czech, Danish, Finnish, Greek, Hungarian, Indonesian, Norwegian, Swedish, Ukrainian, Esperanto, Tagalog.

MIDI instrument names are translated in all supported languages.

## Documentation

- [Installation Guide](./docs/INSTALLATION.md)
- [Installation Verification](./docs/INSTALLATION_VERIFICATION.md)
- [GPIO MIDI Wiring Guide](./docs/GPIO_MIDI_WIRING.md)
- [MIDI Auto-Assignment & Adaptation Guide](./docs/MIDI_ASSIGNMENT_ADAPTATION_GUIDE.md)
- [Drum Note Mapping Guide](./docs/DRUMS_ASSIGNMENT_GUIDE.md)
- [SysEx Identity](./docs/SYSEX_IDENTITY.md)

## License

MIT License - see [LICENSE](LICENSE)
