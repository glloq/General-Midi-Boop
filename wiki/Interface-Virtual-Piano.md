# Interface — Virtual Piano (Keyboard Modal)

The virtual piano lets you play and test connected instruments directly from the browser — no physical keyboard needed. It adapts its display to the type of instrument assigned to the selected channel.

Source: [`public/js/features/KeyboardModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/KeyboardModal.js) and mixins in [`public/js/features/keyboard/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/js/features/keyboard).

> The virtual keyboard runs both as a stand-alone modal and as an embedded panel inside other modals (Loop Manager → Keyboard tab, Loop Editor → Piano tab). All controls described below are available in both contexts.

## Display Modes

The view is selected automatically based on the instrument type of the active channel, but can also be changed manually with the **View** toggle (🎹) in the header.

### Standard Piano Keys

![Virtual piano — base](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20base.png?raw=true)

Classic black-and-white keyboard. Each note is colour-coded chromatically (C = red, C# = orange, …, B = violet) to help with orientation across octaves.

- **Drag** left/right to slide the visible octave range.
- **Scroll** to zoom in/out (1–8 octaves visible simultaneously).
- **Minimap** at the top shows the full MIDI range (0–127); the yellow box is the current viewport.

### Piano — Two-Hands Overlay

![Virtual piano — 2 hands piano keys](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%202%20mains%20touches%20piano.png?raw=true)

When a piano instrument has hand-position planning enabled, the left-hand and right-hand finger assignments are drawn directly on the keys. Blue dots indicate playable notes within the current hand window; red chevrons mark notes outside reach. See [[Interface-Hand-Management]] for the planning configuration.

### Drums

![Virtual piano — drums](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20drums.png?raw=true)

For percussion channels (GM channel 10 / type `drums` / `drum`): the keyboard is replaced by a GM drum pad grid. Each pad shows the instrument name (Kick, Snare, Hi-Hat, …). Click or press the mapped key to trigger the note.

Drum-kit detection is broad: any instrument whose `instrument_type` is `drum` or `drums`, plus standard GM drum programs ≥ 128 (used to encode the kit number in routings) trigger the drum pad view. The selected kit is preserved across instrument-picker reopenings.

### Guitar / String — Hand on Strings (Horizontal)

![Virtual piano — guitar hand on strings](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20guitare%20main%20cordes.png?raw=true)

Fretboard view. The fretting-hand position is overlaid horizontally on the strings. Notes within the hand window are highlighted; out-of-reach notes are flagged.

### Guitar / String — Motor per String

![Virtual piano — guitar motor per string](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20guitare%20moteur%20par%20corde.png?raw=true)

For automated string instruments with one actuator per string (sliding-finger model). Shows the actuator position along each string independently.

### String — Vertical Hand View

![Virtual piano — string hand vertical](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20cordes%20main%20verti.png?raw=true)

Vertical fretboard layout. Useful for instruments held vertically (cello, double bass, violin). The hand band moves up and down the neck.

### String — All Frets & Strings

![Virtual piano — all frets and strings](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20cordes%20toutes%20frettes%20et%20cordes.png?raw=true)

Full fret grid: every string on every fret is shown at once. Active notes are highlighted. Good for overview and debugging string assignment logic.

### Wind — Articulation Panel

![Virtual piano — wind articulation](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20wind.png?raw=true)

> Image to capture.

When a wind GM program is selected (flute, sax, trumpet, …) a dedicated panel surfaces above the keyboard:

- **Articulation** buttons: `● Normal`, `∪ Legato`, `· Staccato`, `> Accent` — each remaps velocity and note length to match the playing style.
- **CC#2 Breath** slider for dynamic breath control.
- The instrument's effective range is displayed next to its name; out-of-range keys are dimmed.

### Wind — Piano Slider

![Virtual piano — wind slider](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20wind%20slider.png?raw=true)

> Image to capture.

Equal-width key strips with pitch-bend on horizontal drag. Best for portamento / glissando phrasing on wind instruments. Toggle with the `⟺` button in the header.

### List View

![Virtual piano — list view](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20list.png?raw=true)

> Image to capture.

A compact list-style layout (`☰`) where:

- **Vertical drag (Y)** controls velocity, or any user-chosen CC via the `Y → CC` dropdown.
- **Horizontal drag (X)** sends pitch bend (toggleable via the `Pitch X` button).
- Multiple notes can be touched in parallel; each finger keeps its own Y / X mapping.

Useful on tablets where expressive control matters more than visual layout.

---

## Pitch-bend on Strings

For string instruments a dedicated **Pitch bend** mode (`〜` button in the header) lets you simulate bends without a separate wheel:

- Click a fret position to start the note.
- Drag along the string to bend the pitch — the offset is computed against the instrument's geometric fret spacing so a one-fret slide always lands exactly one semitone away, even on long necks.
- Releasing returns to the fretted pitch (or the next struck note if you continue gliding).
- When hand-position planning is active, the hand follows the bend so the on-screen reach window stays consistent with the produced pitch.

The geometric mapping makes the bend behave the same regardless of where on the neck you start — the visual fret spacing is no longer a lie.

---

## Controls

### Channel Selector

A dropdown at the top selects which MIDI channel / instrument receives the played notes. Switching channel changes the display mode and the outgoing MIDI target. Drum kits route to channel 10 automatically.

### Velocity

A vertical slider sets the velocity (1–127) for all notes sent by the virtual keyboard. Default: 100.

### Modulation Wheel

Sends CC#1 (Modulation). Drag upward to increase modulation depth.

### Pitch Bend

A dedicated wheel sends 14-bit pitch bend (±8191). Returns to centre on release. The wheel is hidden when the active instrument does not declare `pitch_bend_enabled`.

### Octave Navigation

| Control | Action |
|---------|--------|
| **◄ / ►** buttons | Shift the visible range one octave left or right |
| **Zoom slider** | Change how many octaves are visible (1–8) |
| **Minimap click** | Jump to any octave instantly |

### Header Toggles

| Button | Tooltip | What it does |
|--------|---------|--------------|
| 🎹 View | `Toggle view` | Switches between the available display modes for the current instrument |
| 〜 Pitch bend | `Mode pitch bend` | String instruments only — turns horizontal drag into a pitch bend |
| ⟺ Slider | `Slider mode` | Wind instruments — equal-width keys + pitch bend |
| ☰ List | `List view` | Compact list-style layout |
| Y → CC | — | List view: pick which CC the vertical drag controls |
| ↔ Pitch X | — | List view: enable/disable pitch bend on horizontal drag |
| 🎨 Colors | `Toggle note colors` | Adds chromatic colouring to fret diagrams |
| US / FR / MIDI | `Notation` | Note labels: English (C/D/E), Solfège (Do/Ré/Mi), or raw MIDI numbers |

---

## Computer Keyboard Mapping

The virtual keyboard maps computer keys to MIDI notes. Two layouts are supported:

| Layout | White keys | Black keys |
|--------|-----------|-----------|
| **QWERTY** | `A S D F G H J K L` | `W E T Y U O P` |
| **AZERTY** | `Q S D F G H J K L M` | `Z E T Y U I O` |

The layout is detected from the browser locale. The active row plays the middle octave; use the octave shift buttons to reach higher or lower notes. Multiple keys can be held simultaneously for chords.

## Touch Support

On tablets and touch screens the virtual keyboard accepts multi-finger input. Each finger is tracked independently, allowing full chords without "ghost" or "lifted" note artefacts.

## Embedded Use

The same component is mounted in:

- **Loop Manager → Keyboard tab** — solo / jam over running loops without leaving the manager (see [[Interface-Loop-Manager]]).
- **Loop Editor → Piano tab** — record into the active loop. The drum-kit selection is reconciled back to the loop on save / preview so the kit number never desyncs.

## Related Pages

- [[Interface-Loop-Manager]] — performance / arrangement workstation that embeds this keyboard
- [[Interface-Hand-Management]] — configure how hand position is planned and displayed
- [[Interface-Instrument-Creation]] — set the instrument type that drives the display mode
- [[MIDI-Editor]] — edit MIDI files instead of playing live

## Screenshots to capture

Pending additions in `docs/images/virtual keyboard/`:

| Filename | Subsection |
|----------|------------|
| `piano virtuel wind.png` | Wind — Articulation Panel |
| `piano virtuel wind slider.png` | Wind — Piano Slider |
| `piano virtuel list.png` | List View |
| `piano virtuel pitch-bend strings.png` | Pitch-bend on Strings (animation frame) |
