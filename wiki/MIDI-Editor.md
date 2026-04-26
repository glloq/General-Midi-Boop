# MIDI Editor

Built-in editor with four specialised modes sharing a transport, channel panel, undo/redo stack, and backend persistence. Architecture and extension points live in [`docs/MIDI_EDITOR.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/MIDI_EDITOR.md).

![Editor](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/editeur.png?raw=true)

## Modes

| Mode | What it edits | Source |
|---|---|---|
| **Piano Roll** | Notes on 16 channels, velocity, snap grid 1/1 → 1/16 | [`public/js/features/midi-editor/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/js/features/midi-editor) |
| **Tablature** | String instruments (19 tunings), bidirectional MIDI ↔ tab | See [[Advanced-Topics]] |
| **Drums** | Grid, GM drum map (notes 35–81) | Drum grid renderer |
| **Wind** | Articulation, breath dynamics | Wind melody renderer |

![Tablature](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/edit%20tab.png?raw=true)
![Wind](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/edit%20wind.png?raw=true)

## Toolbar

Save, Save As, rename, undo / redo, copy / paste / delete, select-all, snap grid, horizontal & vertical zoom, transport (play / pause / stop), auto-assign routing, channel-settings popover, preview-source toggle (GM ↔ routed devices).

## CC and Automation

Editable controllers: **CC 1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91, 93**. Plus pitch bend, channel & poly aftertouch, velocity curves, and tempo automation. Curve drawing tools cover linear, exponential, logarithmic and sine shapes.

Reserved CC ranges (e.g. hand position on CC 23/24) are documented in [`docs/MIDI_CC_INSTRUMENT_CONTROLS.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/MIDI_CC_INSTRUMENT_CONTROLS.md).

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl/Cmd + S` | Save |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Y` or `Ctrl + Shift + Z` | Redo |
| `Ctrl/Cmd + C` / `V` | Copy / paste selected notes |
| `Ctrl/Cmd + A` | Select all |
| `Delete` / `Backspace` | Delete selected notes (or CC / velocity points if that section is open) |
| `Space` | Play / pause |
| `Escape` | Close dialog or editor |

## Common Features

- Built-in synthesizer preview with **7 soundfonts**.
- Per-channel routing to connected devices, with playable-note highlighting (notes outside an instrument's range are dimmed).
- Cursor repositioning during playback pause.
- **Touch mode** for tablets — separate Move / Add / Resize buttons replace gesture overloads.

## User Preferences

Persisted in `localStorage` under `gmboop_settings`:

- `touchMode`
- `keyboardPlaybackFeedback`
- `dragPlaybackFeedback`

## Extending the Editor

The editor uses a renderer-per-mode design. To add a mode, register a renderer in the editor entry point and provide:

- A converter (model ↔ visual representation)
- Toolbar actions
- Keyboard shortcuts (via the shared shortcut registry)
- Optional touch-mode controls

See the architecture and extension points in [`docs/MIDI_EDITOR.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/MIDI_EDITOR.md).
