# Usage Guide

A walkthrough of the web interface. Screenshots come from [`docs/images/`](https://github.com/glloq/General-Midi-Boop/tree/main/docs/images).

## Home / Dashboard

![Dashboard](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/accueil.png?raw=true)

Top-level access to playback, files, devices, lighting, settings, and the debug console.

## Devices

![Instruments](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/instruments.png?raw=true)

USB devices appear automatically. Bluetooth and serial devices need the corresponding subsystem enabled (see [[Hardware-Integration]]). Each device exposes:

- Custom display name
- Latency compensation (manual or auto-calibrated)
- Instrument type, note range, polyphony
- Per-channel registered instrument(s)
- Enable/disable toggle

## File Library

![Files](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/playlist.png?raw=true)

- Drag-and-drop or upload `.mid` files
- Organise into folders, multi-select for batch actions
- Search and filter by duration, tempo, track count, instrument type, channel count, compatibility
- Save filter presets, sort by any column

## Channel Routing

Each MIDI channel (1–16) can be routed to a different connected device, with per-route velocity scaling, transposition, and note-range mapping. Use [[Auto-Assignment]] to bootstrap routing automatically.

## Playback

Standard transport (play / pause / stop / seek), tempo override, lookahead window for tight timing, and per-instrument latency compensation applied automatically.

## MIDI Editor

![Editor](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/editeur.png?raw=true)

Four modes share a transport, channel panel and undo/redo stack:

- **Piano Roll** — add / move / resize / re-channel notes, snap grid 1/1 → 1/16
- **Tablature** — string instruments, 19 tuning presets, bidirectional MIDI ↔ tab
- **Drums** — grid editor mapped to GM drums (notes 35–81)
- **Wind** — articulation & breath dynamics

Detailed shortcuts and CC editing in [[MIDI-Editor]].

## Lighting

![Lighting](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/lumiere.png?raw=true)

Configure drivers (GPIO LED strips, ArtNet, sACN, OSC, HTTP, MQTT), build effects, and synchronise them with playback. See [[Lighting]].

## Virtual Keyboard

![Virtual keyboard — base](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20base.png?raw=true)

Test devices from the browser using mouse drag or computer keyboard (AZERTY/QWERTY). Adjustable octave and velocity.

The display adapts to the instrument type assigned to the selected channel:

**Piano — two-hands overlay (piano keys)**

![Virtual keyboard — 2 hands piano keys](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%202%20mains%20touches%20piano.png?raw=true)

Left-hand and right-hand finger assignments are shown directly on the standard piano keys.

**Drums**

![Virtual keyboard — drums](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20drums.png?raw=true)

GM drum map: each pad shows the instrument name; click to trigger the corresponding MIDI note.

**Guitar / string — hand on strings (horizontal)**

![Virtual keyboard — guitar hand strings](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20guitare%20main%20cordes.png?raw=true)

Fretboard view with the fretting hand overlaid on the strings.

**Guitar / string — motor per string**

![Virtual keyboard — guitar motor per string](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20guitare%20moteur%20par%20corde.png?raw=true)

For automated string instruments: shows the actuator position per string.

**String instrument — hand vertical + all frets & strings**

![Virtual keyboard — string hand vertical](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20cordes%20main%20verti.png?raw=true)

![Virtual keyboard — all frets and strings](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20cordes%20toutes%20frettes%20et%20cordes.png?raw=true)

Full fret grid showing all reachable notes across every string; active notes are highlighted.

## Debug Console

![Debug](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/debug.png?raw=true)

Live MIDI events, log stream, and command playground. Useful when wiring up a new device.

## Settings

- Theme: Light / Dark / Coloured
- Virtual keyboard octave count (1–4)
- Language (28 supported, see [[Advanced-Topics]])
- Persisted under `localStorage["gmboop_settings"]`
