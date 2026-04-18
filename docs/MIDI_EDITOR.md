# MIDI Editor — Technical Documentation

> Scope: the browser-side MIDI editor modal (`MidiEditorModal`) and its surrounding
> modules under `public/js/views/components/midi-editor/`.

![MIDI Editor](images/editeur.png)

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Module map](#module-map)
- [Public API](#public-api)
- [State model](#state-model)
- [Data flow](#data-flow)
- [Backend commands consumed](#backend-commands-consumed)
- [MIDI value validation](#midi-value-validation)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [User preferences](#user-preferences)
- [Event bus](#event-bus)
- [Extension points](#extension-points)
- [Known limitations and future work](#known-limitations-and-future-work)

---

## Overview

The MIDI editor is the most complex frontend feature of Ma-est-tro (~11 000 lines across
20 files, 215 `midiEditor.*` i18n keys). It is a single modal that hosts **four
editing modes** sharing a common transport, channel panel, and backend persistence:

| Mode | Primary view | Use case |
|------|--------------|----------|
| Piano roll | `webaudio-pianoroll` library | Add / move / resize / re-channel / velocity notes |
| Tablature  | `TablatureEditor` sub-component | String instruments (guitar, bass, violin…), with bidirectional MIDI ↔ tab conversion |
| Drums      | `DrumPatternEditor` sub-component | Grid-based pattern editor (GM drum map) |
| Wind       | `WindInstrumentEditor` sub-component | Articulations and breath dynamics for wind instruments |

The modal is instantiated **exactly once**, lazily, from
[`public/index.html:8906`](../public/index.html):

```javascript
midiEditorModal = new MidiEditorModal(window.eventBus, api);
await midiEditorModal.show(fileId, filename);
```

See [`docs/AUTO_ASSIGNMENT.md`](AUTO_ASSIGNMENT.md) for the
auto-assignment flow reachable from the toolbar.

---

## Architecture

The editor combines a main class with classical **prototype-level mixins**: each module
registers its functions on `MidiEditorModal.prototype` at load time, so from the caller's
point of view every editor method is a plain instance method.

```
                         ┌───────────────────────────────┐
                         │       MidiEditorModal         │  ← class (constructor + show)
                         │  (public/js/views/components) │
                         └───────┬───────────────┬───────┘
                                 │  composes     │  prototype extended by
               ┌─────────────────┼───────┐       │  12 mixin modules
               ▼                 ▼       ▼       ▼
     ┌─────────────────┐  ┌──────────────┐  ┌──────────────────┐
     │ MidiEditorChannel│  │MidiEditorCC  │  │ MidiEditor       │
     │     Panel       │  │    Panel     │  │  Playback        │
     │ (class, 16 ch.) │  │(class, CC UI)│  │(class, synth+bar)│
     └─────────────────┘  └──────────────┘  └──────────────────┘

     ┌─────────────────┐  ┌──────────────┐  ┌──────────────────┐
     │ TablatureEditor │  │DrumPattern   │  │ WindInstrument   │
     │  (sub-editor)   │  │  Editor      │  │   Editor         │
     └─────────────────┘  └──────────────┘  └──────────────────┘

               ▲
               │
     ┌─────────┴────────────────────────────────────────────────┐
     │ webaudio-pianoroll (vendored library, note canvas)       │
     └──────────────────────────────────────────────────────────┘
```

### Load order

Scripts are loaded in sequence in `public/index.html` (no ES modules):

1. **Helper class files** (`SoundBankLoadingIndicator.js`, `MidiEditorToolbar.js`,
   `MidiEditorChannelPanel.js`, `MidiEditorCCPanel.js`, `MidiEditorPlayback.js`).
2. **Mixin modules** (`MidiEditorConstants.js`, `MidiEditorSequence.js`,
   `MidiEditorCC.js`, `MidiEditorDrawSettings.js`, `MidiEditorCCPicker.js`,
   `MidiEditorFileOpsMixin.js`, `MidiEditorRenderer.js`, `MidiEditorRouting.js`,
   `MidiEditorEditActions.js`, `MidiEditorDialogs.js`, `MidiEditorEvents.js`,
   `MidiEditorTablature.js`, `MidiEditorLifecycle.js`).
3. **Main class** (`MidiEditorModal.js`), which assembles mixins:

```javascript
// MidiEditorModal.js — the mixin assembly
const _mixins = [
    typeof MidiEditorSequenceMixin !== 'undefined' ? MidiEditorSequenceMixin : null,
    typeof MidiEditorCCMixin !== 'undefined' ? MidiEditorCCMixin : null,
    // … 10 more …
];
_mixins.forEach(mixin => {
    if (mixin) Object.keys(mixin).forEach(key => {
        MidiEditorModal.prototype[key] = mixin[key];
    });
});
```

Each mixin file wraps its definitions in an IIFE and exposes a single
`window.<Name>Mixin` object that the main class picks up.

---

## Module map

Files live under `public/js/views/components/midi-editor/` unless noted.

| File | Lines | Kind | Responsibility |
|------|-------|------|----------------|
| `MidiEditorModal.js` *(parent dir)* | 364 | class | Constructor, `show`, `loadMidiFile`, playback facades, preference helpers, mixin assembly |
| `MidiEditorConstants.js` | 86 | constants | Snap values, GM instrument list, channel colors |
| `MidiEditorDrawSettings.js` | 114 | mixin | Draw-density popover (CC drawing) |
| `MidiEditorDialogs.js` | 239 | mixin | Unsaved-changes confirmation, error/notification modals |
| `MidiEditorRenderer.js` | 244 | mixin | Modal HTML template |
| `MidiEditorSequence.js` | 338 | mixin | `convertMidiToSequence`, tempo-map extraction, fullSequence/sequence sync |
| `MidiEditorLifecycle.js` | 386 | mixin | `initPianoRoll`, close, `beforeunload` guard |
| `MidiEditorChannelPanel.js` | 406 | class | 16-channel strip (device selector, instrument, TAB buttons) |
| `MidiEditorToolbar.js` | 478 | class | Toolbar (modes, snap, zoom, transport, tempo display) |
| `MidiEditorPlayback.js` | 578 | class | Synthesizer + timeline playhead |
| `MidiEditorFileOpsMixin.js` | 592 | mixin | `saveMidiFile`, `saveAsFile`, `showSaveAsDialog`, `showRenameDialog`, `showAutoAssignModal`, `convertSequenceToMidi` |
| `MidiEditorCC.js` | 716 | mixin | CC type buttons, CC name tables, extraction from MIDI |
| `MidiEditorCCPicker.js` | 769 | mixin | CC picker modal, `initCCEditor`, `syncCCEventsFromEditor` |
| `MidiEditorRouting.js` | 913 | mixin | Device list, per-channel routing, playable-notes highlights, `fileRoutingSync` |
| `MidiEditorEvents.js` | 968 | mixin | Click dispatcher (~80 `data-action`s), mouse handlers, resize |
| `MidiEditorEditActions.js` | 1 115 | mixin | Undo/redo, copy/paste, delete, select-all, **keyboard shortcuts** |
| `MidiEditorTablature.js` | 1 307 | mixin | Bridges for TAB / wind / drum sub-editors |
| `MidiEditorCCPanel.js` | 1 343 | class | CC/velocity/tempo panel UI (buttons, editor init, channel selector) |
| `SoundBankLoadingIndicator.js` | 96 | class | Loading UI component |

Total ≈ 11 050 lines.

---

## Public API

The modal exposes a small, stable entry surface; everything else is an implementation
detail of the mixins.

### Constructor

```javascript
new MidiEditorModal(eventBus, apiClient)
```

- `eventBus` — shared `EventBus` instance (`window.eventBus`)
- `apiClient` — `BackendAPIClient` (WebSocket)

### Lifecycle

| Method | Location | Purpose |
|--------|----------|---------|
| `show(fileId, filename?)` | `MidiEditorModal.js:149` | Open the modal and load the file. No-op if already open. |
| `close()` | `MidiEditorLifecycle.js` | Close with dirty-check confirmation dialog if `isDirty` is true. |
| `loadMidiFile(fileId)` | `MidiEditorModal.js:216` | Fetch from backend and hydrate state. Called internally by `show`. |

### File operations (from `MidiEditorFileOpsMixin`)

| Method | Purpose |
|--------|---------|
| `saveMidiFile()` | Save the current file (sequence → MIDI → `file_write`) |
| `showSaveAsDialog()` | Prompt for a new filename |
| `saveAsFile(newFilename)` | Save a copy (`file_save_as`) |
| `showRenameDialog()` | Prompt and rename the current file (`file_rename`) |
| `showAutoAssignModal()` | Open `RoutingSummaryPage` for channel-to-device auto-assignment |
| `convertSequenceToMidi()` | Serialise the full sequence + CC + tempo map into a `midi-file` payload, with MIDI value clamping |

### Editing (from `MidiEditorEditActions`)

`undo()`, `redo()`, `copy()`, `paste()`, `deleteSelectedNotes()`, `selectAllNotes()`,
`changeChannel()`, `applyInstrument()`, `cycleSnap()`, `toggleTouchMode()`,
`toggleKeyboardPlayback()`, `toggleDragPlayback()`.

### Playback (facades on `MidiEditorModal`, implemented by `MidiEditorPlayback`)

`playbackPlay()`, `playbackPause()`, `playbackStop()`, `togglePlayback()`,
`handleNoteFeedback(prev)`, `playNoteFeedback(note, velocity, channel)`,
`disposeSynthesizer()`.

### Routing (from `MidiEditorRouting`)

`loadConnectedDevices()`, `setChannelRouting(channel, deviceValue)`,
`togglePreviewSource()`, `_syncRoutingToDB()`.

---

## State model

All state lives on the `MidiEditorModal` instance (see constructor at
`MidiEditorModal.js:8-111`). The most important properties:

| Property | Type | Role |
|----------|------|------|
| `currentFile` | string | Backend file id |
| `currentFilename` | string | Display name |
| `isDirty` | boolean | Tracks unsaved edits, powers the close-confirmation dialog |
| `midiData` | object \| null | Raw `midi-file` payload |
| `sequence` | `Note[]` | Notes currently visible to the piano roll (active channels) |
| `fullSequence` | `Note[]` | **All** notes across every channel (source of truth for save) |
| `activeChannels` | `Set<number>` | Visible channels (0-15) |
| `channels` | `ChannelInfo[]` | Per-channel metadata (program, note count, colour) |
| `ccEvents` | `CCEvent[]` | Controllers, pitch bend, aftertouch, poly aftertouch |
| `tempoEvents` | `TempoEvent[]` | Tempo map with deterministic ids `tempo_<ticks>_<index>` |
| `channelRouting` | `Map<number, string>` | Channel → `deviceId[::targetChannel]` |
| `channelDisabled` | `Set<number>` | Muted channels |
| `channelPlayableHighlights` | `Map<number, Set<number>>` | Playable-note highlights per channel |
| `previewSource` | `'gm'` \| `'routed'` | Which instrument bank drives the built-in synth |
| `clipboard` | `Note[]` | Copy/paste buffer |
| `editMode` | `'select'` \| `'drag-notes'` \| `'drag-view'` \| `'edit'` | Pointer behaviour in the piano roll |
| `pianoRoll` | `HTMLElement` \| null | The `webaudio-pianoroll` custom element |
| `synthesizer` | object \| null | Built-in soundfont synthesiser |
| `ccEditor` / `velocityEditor` / `tempoEditor` | editors | Separate canvas editors that sync back to `ccEvents` / `tempoEvents` |

`Note` shape: `{ t: ticks, g: gate, n: noteNumber, c: channel, v: velocity }`.

---

## Data flow

### Load

```
MidiEditorModal.show(fileId, filename)
  └─ loadMidiFile(fileId)
       ├─ api.readMidiFile(fileId)                         ── WS 'file_read'
       │    (returns { midiData })
       ├─ convertMidiToSequence()                          MidiEditorSequence.js:21
       │    ├─ parse tracks → fullSequence (all channels)
       │    ├─ extract tempo events → tempoEvents
       │    └─ identify channel programs → channels
       └─ eventBus.emit('midi_editor:opened')

  └─ render()                                              MidiEditorRenderer.js
  └─ initPianoRoll()                                       MidiEditorLifecycle.js
       ├─ attach webaudio-pianoroll
       ├─ ccPanel.extractCCAndPitchbend() → ccEvents
       └─ _refreshStringInstrumentChannels() (TAB buttons visibility)

  └─ _loadSavedRoutings()                                  MidiEditorRouting.js
       └─ api.sendCommand('get_file_routings', { fileId })
```

### Save

```
MidiEditorModal.saveMidiFile()                             MidiEditorFileOpsMixin.js:228
  ├─ syncFullSequenceFromPianoRoll()  ← pull note edits
  ├─ syncCCEventsFromEditor()          ← pull CC/pitchbend edits (no-op if picker never opened)
  ├─ syncTempoEventsFromEditor()       ← pull tempo edits
  ├─ updateChannelsFromSequence()      ← rebuild channel list
  ├─ convertSequenceToMidi()          ← clamp MIDI values, build midi-file payload
  ├─ api.writeMidiFile(fileId, midiData)                   ── WS 'file_write'
  ├─ isDirty = false
  └─ eventBus.emit('midi_editor:saved', { filePath })
```

The `save-as` variant (`saveAsFile`) differs only by the final WebSocket call
(`file_save_as`), the filename prompt, and the emitted event
(`midi_editor:saved_as`).

---

## Backend commands consumed

| Command | Source file | Purpose |
|---------|-------------|---------|
| `file_read` | `FileCommands.js` | Load `midiData` for the open file |
| `file_write` | `FileCommands.js` | Save the edited file in place |
| `file_save_as` | `FileCommands.js` | Save a copy under a new name |
| `file_rename` | `FileCommands.js` | Rename the current file |
| `device_list` | `DeviceCommands.js` | Populate the routing device selector |
| `get_file_routings` | `PlaybackCommands.js` | Load saved per-channel routing |
| `file_routing_sync` | `RoutingCommands.js:139` | Persist manual routing edits; validates against `midi_file_channels` |
| `apply_assignments` | `PlaybackCommands.js` | Apply auto-assignment (from the `Auto-Assign` toolbar button) |
| `generate_assignment_suggestions` | `PlaybackCommands.js` | Compute candidate assignments |

See [`docs/API.md`](API.md) for the WebSocket contract of each command.

---

## MIDI value validation

`convertSequenceToMidi()` clamps every value that goes into the binary MIDI stream, so a
corrupt in-memory sequence can never silently produce an invalid `.mid`:

- Note number: `0–127`
- Channel: `0–15`
- Velocity: `1–127` for `noteOn`, always `0` for `noteOff`
- CC value: `0–127`
- Pitch bend: `-8192 … 8191` (signed 14-bit)
- Ticks & gate: `≥ 0`, gate `≥ 1`

If any value is out of range, it is clamped and a summary is logged at `warn` level:

```
Clamped 3 out-of-range MIDI values: {"note":0,"channel":1,"velocity":2,"cc":0,"pitchBend":0,"ticks":0}
```

See `MidiEditorFileOpsMixin.js:17` for the implementation.

---

## Keyboard shortcuts

Handlers are registered in `MidiEditorEditActions.js:951` (ignored while focus is inside
an `<input>` / `<textarea>`).

| Key | Action |
|-----|--------|
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl/Cmd + C` | Copy selected notes |
| `Ctrl/Cmd + V` | Paste |
| `Ctrl/Cmd + A` | Select all notes |
| `Delete` / `Backspace` | Delete selected notes (or CC/velocity points when the CC section is open) |
| `Space` | Play / pause |
| `Escape` | Close dialogs; close the modal if no dialog is focused |
| `Ctrl/Cmd + S` | Save (via the toolbar shortcut, bound in `MidiEditorEvents.js`) |

---

## User preferences

Three boolean preferences are persisted in the `maestro_settings` key of `localStorage`,
read and written through the generic helpers `MidiEditorModal.prototype._getPreference`
and `_setPreference` (`MidiEditorModal.js:289-314`):

| Key | Default | Effect |
|-----|---------|--------|
| `midiEditorTouchMode` | `false` | Splits the unified edit button into discrete Move / Add / Resize buttons — useful on touch screens |
| `midiEditorKeyboardPlayback` | `true` | Play a sound when a note is created or edited via the keyboard |
| `midiEditorDragPlayback` | `true` | Play notes under the pointer while dragging (capped to 6 simultaneous notes) |

---

## Event bus

The modal participates in the global `EventBus`. Backend components and other frontend
views can react to editor changes without coupling to the modal directly.

### Emitted

| Event | Payload | When |
|-------|---------|------|
| `midi_editor:opened` | `{ fileId, filename }` | After `render()` succeeds in `show()` |
| `midi_editor:saved` | `{ filePath }` | After `saveMidiFile()` succeeds |
| `midi_editor:saved_as` | `{ originalFile, newFile, newFilename }` | After `saveAsFile()` succeeds |
| `midi_editor:file_renamed` | `{ fileId, oldFilename, newFilename }` | After `showRenameDialog()` confirms |
| `routing:changed` | `{ fileId, … }` | From `showAutoAssignModal()` if the user applied assignments |

### Subscribed

| Event | Handler | Reason |
|-------|---------|--------|
| `routing:changed` | reloads saved routings | Keep the channel panel in sync when another view (auto-assign modal) changes routings |

---

## Extension points

### Adding a new mixin

1. Create `MidiEditorMyFeature.js` alongside the others:
   ```javascript
   (function () {
       'use strict';
       const MidiEditorMyFeatureMixin = {};

       MidiEditorMyFeatureMixin.doSomething = function () {
           // `this` is the MidiEditorModal instance
       };

       if (typeof window !== 'undefined') {
           window.MidiEditorMyFeatureMixin = MidiEditorMyFeatureMixin;
       }
   })();
   ```
2. Add a `<script>` tag in `public/index.html` **before** the `MidiEditorModal.js`
   tag.
3. Add an entry to the `_mixins` array in `MidiEditorModal.js` so the prototype
   picks the new methods up at load time.

### Adding a new CC type

CC types are enumerated in `MidiEditorCC.js` (`CC_NAMES`, `CC_CATEGORIES`). Add the
controller number, a short English label, and a category; the picker UI picks it up
automatically.

### Adding a new sub-editor (tablature-style)

- Instantiate the new editor in `MidiEditorModal.js` constructor (next to
  `tablatureEditor`, `drumPatternEditor`, `windInstrumentEditor`).
- Add a bridge in `MidiEditorTablature.js` following the same pattern as the existing
  three (show/hide sync, sequence synchronisation, playhead update hook).
- Add toolbar/channel-panel buttons to open it.
- Add i18n keys under `midiEditor.*`.

---

## Logging convention

`this.log(level, message, …details)` is the single entry point used by every
module. The levels in use follow a simple four-step scale:

| Level | When to use | Example |
|-------|-------------|---------|
| `debug` | Verbose traces useful while investigating a bug. Off in production. | `First 3 notes: …`, `Layout attempt 3, height=220` |
| `info` | High-level lifecycle milestones. | `Opening MIDI editor for song.mid`, `Saved 412 notes across 4 channels` |
| `warn` | Recoverable misuse or unexpected-but-handled state. | `Modal already open`, `Clamped 3 out-of-range MIDI values: …` |
| `error` | Genuine failure of a user-visible operation. | `Failed to save file: …`, `Cannot save: no file or piano roll` |

Shortcuts like `console.log(…)` / `console.error(…)` should not appear inside
the editor modules — go through `this.log` so the logs can be routed, filtered,
or rotated uniformly by the host app.

---

## Known limitations and future work

These are tracked here rather than fixed ad hoc, so the editor evolves cleanly.

- **Four modules over 900 lines** still mix several concerns and would benefit
  from being split further:
  - `MidiEditorCCPanel.js` (1 343 l.) — CC toolbar, channel selector, velocity /
    tempo editor initialisation.
  - `MidiEditorTablature.js` (1 307 l.) — tab / wind / drum bridges in one
    file.
  - `MidiEditorEditActions.js` (1 115 l.) — undo/redo, clipboard, keyboard
    shortcuts, preference toggles.
  - `MidiEditorEvents.js` (968 l.) — a single click dispatcher with ~80
    `data-action` branches.
- **`channelAftertouch` / `polyAftertouch` fields are dropped** on the second
  pass of `convertSequenceToMidi` (`MidiEditorFileOpsMixin.js:182-203`). The
  events are created with the right payload (`amount`, `pressure`,
  `noteNumber`) but the map-into-deltaTime step does not copy those fields
  across, so aftertouch data does not survive a save. The clamping on the
  values themselves is correct; only the field forwarding is missing.
- **CC events are not persisted in the database** — they are serialised into
  the MIDI file at save time. That is an intentional design choice (the MIDI
  file is the canonical representation), but it means queries like "which
  files use CC 7" still require parsing the file.
- **Frontend test surface is still small.** `tests/frontend/midi-editor-clamp.test.js`
  covers the save-time clamping logic (10 cases) but the rest of the editor —
  lifecycle, undo/redo stack, routing persistence, CC sync — has no coverage
  yet.

See `git log --follow docs/MIDI_EDITOR.md` for the incremental cleanup history.
