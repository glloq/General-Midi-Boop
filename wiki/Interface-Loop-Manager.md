# Interface — Loop Manager & Loop Editor

The Loop Manager turns Général Midi Boop into a full performance / arrangement workstation: record short MIDI phrases, trigger them from a pad grid, perform on top of running loops, and assemble entire songs on a multi-track timeline.

Two modals are involved:

- **Loop Manager** — top-level modal with five tabs (Library, Pad, Live, Keyboard, Arranger). Source: [`public/js/features/LoopCreatorModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/LoopCreatorModal.js).
- **Loop Editor** — opens on top of the manager to create or edit a single loop. Source: [`public/js/features/LoopEditorModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/LoopEditorModal.js).

Shared helpers (GM family map, quantization, schema utilities) live in [`public/js/features/loop/LoopUtils.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/loop/LoopUtils.js).

> Most images on this page are placeholders — see [Screenshots to capture](#screenshots-to-capture) at the bottom for the list of captures still to add.

---

## Loop Manager — Tabs Overview

![Loop Manager — header and tabs](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-manager-header.png?raw=true)

The header carries the modal title, the five tab buttons (🗂 Library, ◻ Pad, ⚡ Live, 🎹 Keyboard, ∞ Arranger) and a shared transport / output strip. Switching tab preserves your selection and unsaved Arranger changes.

### 1. Library

![Loop Manager — Library tab](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-manager-library.png?raw=true)

Searchable, sortable grid of every saved loop.

- **Search** by name, **filter** by GM instrument, **sort** by name / tempo / duration / instrument.
- Each card shows name, tempo, bars, time signature, instrument program, and a mini preview.
- Actions: `▶ Preview`, `✎ Edit` (opens the Loop Editor), `⎘ Duplicate`, `🗑 Delete`.
- `+ New Loop` opens an empty Loop Editor pre-populated with the manager's current tempo / time signature.

### 2. Pad

![Loop Manager — Pad tab](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-manager-pad.png?raw=true)

A configurable trigger grid (4 × 4 by default, resizable up to 8 × 8) for live triggering.

- **Click**: play / stop the loop assigned to that pad.
- **Right-click** or **long-press**: assign a loop, clear the pad, or change its play mode.
- **Drag-and-drop** loops directly from the Library tab onto a pad.
- **Play modes** per pad: `Loop` (repeats), `One-shot` (plays once), `Hold` (plays while held).
- **Quantize**: `Off / Beat / Bar` — pads wait for the next beat or bar before starting.
- **MIDI-In mapping**: bind a MIDI note from a controller to each pad for hands-on triggering.

### 3. Live

![Loop Manager — Live tab](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-manager-live.png?raw=true)

Loops grouped by GM family (Piano, Strings, Brass, Drums, …) for quick performance.

- One column per family, one card per loop, currently-playing loops are highlighted.
- `Stop All` cuts every running loop at once.
- Each card exposes a per-loop output toggle (Synth ↔ routed device) when the routing allows it.

### 4. Keyboard

![Loop Manager — Keyboard tab](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-manager-keyboard.png?raw=true)

Embeds the [virtual keyboard panel](Interface-Virtual-Piano) inside the Loop Manager so you can solo or jam over the loops that are currently playing.

- The keyboard's output device is picked independently of the loops.
- A `Silence` button mutes the keyboard output without closing the panel.
- All keyboard features work exactly as in the stand-alone modal, including every dedicated instrument view (accordion, harmonica, bagpipe, harp, mallets, music box, kalimba, steel drum, …) — see [Dedicated Instrument Views](Interface-Virtual-Piano#dedicated-instrument-views).
- The instrument-selection button is full-height so it stays readable with long instrument lists.

### 5. Arranger

![Loop Manager — Arranger timeline](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-manager-arranger.png?raw=true)

Multi-track timeline for assembling loops into a full piece.

- Each **track** has its own name, mute / solo, optional locked MIDI channel.
- **Blocks** = loop instances dropped on the timeline. Drag to move, drag the right edge to change repetitions, right-click for `Duplicate / Copy / Reps ± / Delete`.
- **Ruler** click jumps the playhead to that bar; the **minimap** above gives a full overview and supports click-to-navigate.
- **Properties**: tempo, bars, time signature; **Structure**: add / remove tracks.
- **History**: per-arrangement undo / redo (50-step ring buffer).
- **Transport**: play / pause / stop, count-in toggle, loop-playback toggle.
- **Zoom**: horizontal and vertical, independently.
- Saves include a `local changes` indicator — the manager won't drop edits silently when you switch arrangement.

#### Channel allocation

The Arranger allocates MIDI channels to each distinct loop program at playback time. Drum loops are pinned to channel 10 (GM convention). Up to 16 distinct programs can be voiced simultaneously; an explicit error is raised when an arrangement asks for more, with the offending count reported in the toast.

---

## Loop Editor

![Loop Editor — overview](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-editor-overview.png?raw=true)

Opens on top of the manager when you create or edit a loop. Two tabs share a single underlying sequence:

| Tab | What it does |
|-----|--------------|
| **🎹 Piano** | Play / record the loop using the embedded virtual keyboard (adapts to the chosen instrument — piano, drum pad, fretboard, wind panel, …) |
| **✎ Editor** | Edit the recorded notes on a piano-roll grid with quantize, selection, copy/paste, velocity tools |

### Piano tab — record & jam

![Loop Editor — Piano tab](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-editor-piano.png?raw=true)

- **Instrument picker** at the top (full-height button): choose the GM program (or a drum kit). The view auto-switches to the matching dedicated layout (piano, fretboard, drum pad, wind slider, accordion, harmonica, bagpipe, harp, mallets, …); drum kits are routed to channel 9 (GM channel 10) automatically. Drum kits in this tab now use the correct percussion samples (a regression that made every pad sound like a bell has been fixed).
- **Pitch-bend mode** is offered for string instruments — see [Pitch-bend on strings](Interface-Virtual-Piano#pitch-bend-on-strings).
- **MIDI In** dropdown: record from a connected hardware controller. The monitor session is lifecycle-bound to the modal — closing during a record stops the input cleanly.
- **Metronome** 🎼 and **Count-in** ⏱ toggles (1 bar of pre-roll for tight recording starts).
- **Live envelopes** ring out naturally when you release a key on the embedded synth.

### Editor tab — piano roll

![Loop Editor — piano roll](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-editor-pianoroll.png?raw=true)

- Standard piano-roll editing: drag to add, click to select, shift-click to range-select, drag edges to resize.
- **Quantize selection** to the active grid (1/1 → 1/32, including triplets).
- **Velocity tools**: apply a fixed velocity to the selection, or open the per-note velocity lane.
- **Zoom**: horizontal (time) and vertical (pitch) independent.
- **History**: undo / redo bounded per loop.
- **Drum-kit aware**: when editing a drum-kit loop the row labels switch to GM drum names (Kick, Snare, …) and out-of-kit notes are dimmed.

### Output & preview

![Loop Editor — output panel](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/loop/loop-editor-output.png?raw=true)

- **Output target**: `Synth` (built-in SoundFont preview) or `Device` (any routed MIDI port + channel).
- **Note range**: `outputNoteMin / outputNoteMax` clamp the preview to your hardware's playable range.
- **Preview length** uses the longest note's tail (note-on + duration + safety margin) so trailing notes are never cut off.

### Save behaviour

- `Save` updates the current loop; `Save as new loop` creates a copy.
- Closing with unsaved changes triggers a guarded confirm.
- Drum-kit selection is reconciled with the embedded `KeyboardModal` at save / preview time so a change in the instrument picker is never lost.

---

## Keyboard Shortcuts

| Key | Action (Loop Editor) |
|-----|---------------------|
| `Space` | Play / pause preview |
| `R` | Toggle record |
| `Q` | Quantize selection |
| `Ctrl/Cmd + Z / Y` | Undo / redo |
| `Ctrl/Cmd + C / V` | Copy / paste notes |
| `Ctrl/Cmd + A` | Select all |
| `Delete` | Delete selection |
| `Esc` | Close dialog |

The Arranger adds:

| Key | Action |
|-----|--------|
| `Ctrl/Cmd + Z / Y` | Undo / redo arrangement |
| `Delete` | Delete selected blocks |
| `Ctrl/Cmd + D` | Duplicate selected blocks |

---

## Persistence

- Loops live in `loops` (migration `017_loops.sql`), arrangements in `loop_arrangements` (migration `018_loop_arrangements.sql`).
- Pad assignments, manager tab, last-opened arrangement and zoom are persisted in `localStorage` under `gmboop_settings`.
- All WebSocket commands are namespaced `loop_*` and `arrangement_*`. See [[API-Reference]] for the contract.
- The Loop Manager / Loop Editor UI strings are fully localized — the recent translation pass extended coverage to es, de, it, pt, zh-CN, ja, ko, ru, bn, th, tl and eo on top of the existing languages.

---

## Related Pages

- [[Interface-Virtual-Piano]] — the keyboard shared by the Live tab, Keyboard tab and Loop Editor Piano tab
- [[MIDI-Editor]] — full multi-track editor for `.mid` files (the Loop Editor is the single-loop counterpart)
- [[Interface-Playlist]] — schedule loops / arrangements alongside `.mid` files
- [[API-Reference]] — `loop_*` and `arrangement_*` WebSocket commands

---

## Screenshots to capture

Tracked under `docs/images/loop/` — see also [`images-a-faire/README.md`](https://github.com/glloq/General-Midi-Boop/blob/main/images-a-faire/README.md). Each image should be ≤ 1280 px wide, PNG, captured at the default theme.

| Filename | Subsection | What to show |
|----------|------------|--------------|
| `loop-manager-header.png` | Tabs overview | Header strip with all five tab buttons visible |
| `loop-manager-library.png` | Library | Grid with ≥ 6 loops of different instruments, one card hovered |
| `loop-manager-pad.png` | Pad | 4 × 4 grid with 2–3 pads assigned, one playing (highlighted), context menu open on another |
| `loop-manager-live.png` | Live | At least 3 GM family columns visible, one loop playing |
| `loop-manager-keyboard.png` | Keyboard | Embedded keyboard panel + a couple of loops playing in the background |
| `loop-manager-arranger.png` | Arranger | 3+ tracks, a few blocks, playhead in the middle, minimap visible |
| `loop-editor-overview.png` | Loop Editor | Full modal with tabs and transport strip |
| `loop-editor-piano.png` | Piano tab | Embedded keyboard mid-record (red ●), metronome on |
| `loop-editor-pianoroll.png` | Editor tab | Several notes, one selection highlighted, velocity lane open |
| `loop-editor-output.png` | Output | Output panel with device selected, range sliders visible |
