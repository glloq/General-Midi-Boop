# Interface — Main Page

The main page is the entry point of the Général Midi Boop web interface. It provides an at-a-glance overview of the system state and quick access to every major feature.

![Main Interface](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/accueil.png?raw=true)

## Layout

The page is divided into functional zones:

| Zone | Description |
|------|-------------|
| **Top navigation bar** | Application title, global status indicator, settings shortcut |
| **Transport controls** | Play / Pause / Stop / Seek, tempo override, current file name |
| **Device status strip** | Compact list of connected instruments with enable/disable toggle |
| **Section cards** | Shortcut tiles to every main page and modal |
| **Debug console link** | Opens the live MIDI event log |

## Section Cards

Each tile links to a dedicated area:

| Tile | Destination |
|------|-------------|
| Instruments | [[Interface-Instrument-Creation]] — manage and configure devices |
| Virtual keyboard | [[Interface-Virtual-Piano]] — play notes from the browser |
| Playlist | [[Interface-Playlist]] — upload and organise MIDI files |
| Lighting | [[Interface-Lighting-Control]] — configure stage lighting |
| Microphone | [[Interface-Microphone]] — latency calibration and tuner |
| Settings | [[Interface-Settings]] — theme, language, preferences |
| MIDI Editor | [[MIDI-Editor]] — piano roll, tablature, drums, wind |
| Auto-assign | [[Auto-Assignment]] — intelligent channel routing |

## Transport Controls

The transport bar is always visible. Controls:

- **Play / Pause** — start or suspend MIDI file playback.
- **Stop** — stop playback and rewind to the start.
- **Seek bar** — drag to jump to any position in the file.
- **Tempo** — override the file's BPM (empty = use file tempo).
- **File name display** — shows the currently loaded MIDI file; click to open the playlist.

Latency compensation is applied automatically per instrument during playback — no manual adjustment is needed once calibration is done (see [[Interface-Microphone]]).

## Device Status Strip

Each connected instrument appears as a compact card showing:

- Display name
- Transport type icon (USB, Bluetooth, RTP-MIDI, Serial)
- Enable / disable toggle
- Compatibility badge (score 0–100 from the last auto-assignment run)

A red indicator means the device is unreachable or misconfigured. Click any card to open the [[Interface-Instrument-Creation|instrument settings]] for that device.

## Debug Console

![Debug Console](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/debug.png?raw=true)

The debug panel streams:

- Live MIDI events (Note On/Off, CC, SysEx, …) with timestamps
- Backend log messages
- WebSocket command playground — type any command from [[API-Reference]] and inspect the response

Useful when wiring a new device or diagnosing timing issues.

## Related Pages

- [[Installation]] — first-time setup
- [[Hardware-Integration]] — connecting USB, Bluetooth, RTP-MIDI, and serial devices
- [[Auto-Assignment]] — automatic channel-to-instrument routing
- [[Advanced-Topics]] — deep dives into calibration, hand position, i18n
