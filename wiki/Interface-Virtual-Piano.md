# Interface — Virtual Piano (Keyboard Modal)

The virtual piano lets you play and test connected instruments directly from the browser — no physical keyboard needed. It adapts its display to the type of instrument assigned to the selected channel.

Source: [`public/js/features/KeyboardModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/KeyboardModal.js) and mixins in [`public/js/features/keyboard/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/js/features/keyboard).

> The virtual keyboard runs both as a stand-alone modal and as an embedded panel inside other modals (Loop Manager → Keyboard tab, Loop Editor → Piano tab). All controls described below are available in both contexts.

## Display Modes

The keyboard is built on an **instrument-view registry** ([`public/js/features/keyboard/views/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/js/features/keyboard/views)): 15 built-in views, each a realistic layout for a family of instruments. The view is **selected automatically** from the active channel's GM program (and `instrument_type`), but can be changed manually with the **View** toggle (🎹) in the header.

The detection chain (first match wins) lives in [`registerBuiltins.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/keyboard/views/registerBuiltins.js) and is kept in lock-step with the production detector by a parity test. Summary of the GM-program → view mapping:

| GM program / condition | View |
|------------------------|------|
| Channel 10, drum type, or program ≥ 128 | Drum pad |
| `instrument_type = theremin` | Theremin |
| 21, 23 | Accordion |
| 22 | Harmonica |
| 9 (Glockenspiel), 11 (Vibraphone), 12–15 | Mallet |
| 10 | Music Box |
| 24–45, 104–107, 110, type `string` | Fretboard |
| 46 | Harp |
| 56–79, 111 (Shanai) | Wind — Piano Slider |
| 108 | Kalimba |
| 109 | Bagpipe |
| 112–113, 115–119, 120–127 | Percussion Pad |
| 114 | Steel Drum |
| everything else (incl. Celesta 8, Timpani 47, organs) | Standard Piano |

> The **Organs** GM family is now merged into **Keyboards** and renders on the standard piano keyboard.

Continuous **glissando** (press-and-drag across the surface) now works on *every* dedicated view, not just the piano and fretboard.

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

For percussion channels (GM channel 10 / type `drums` / `drum`): the keyboard is replaced by a GM drum pad grid. Each pad is labelled by its GM instrument name only (Kick, Snare, Hi-Hat, …) — the raw MIDI-number badge has been removed for a cleaner grid. Click or press the mapped key to trigger the note.

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

## Dedicated Instrument Views

Beyond the generic piano / fretboard / drum / wind / list layouts, a set of **family-specific views** render each instrument the way it actually looks and plays. They are picked automatically from the GM program (see the mapping table above) and can still be overridden with the 🎹 toggle. Source: [`public/js/features/keyboard/views/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/js/features/keyboard/views).

| View | Instruments (GM) | What it renders |
|------|------------------|-----------------|
| **Accordion** | Accordion, Tango Accordion (21, 23) | Realistic 5-row C-griff chromatic treble manual, configurable Stradella / free-bass left-hand board, vertical front-view orientation, glissando. Pressing a note lights every duplicate of that note (twin-key / same-note highlighting); only actually-pressed buttons highlight. The left-hand board, free-bass range and C-system are set in the instrument settings — see [[Interface-Instrument-Creation]]. |
| **Harmonica** | Harmonica (22) | Blow / draw hole layout with polished curved chrome covers, external blow/draw labels, and a chromatic-slide button. Diatonic vs. chromatic and the hole count come from the instrument settings. |
| **Bagpipe** | Bagpipe (109) | Melody chanter plus the configured drone tubes shown on a single line. Drones have per-drone toggles and a master toggle (configured in the instrument settings); active notes give visual struck feedback. |
| **Harp** | Orchestral Harp (46) | Vertical strings — every configured string is drawn — with glissando on hover and US / FR / MIDI note labels. The string set follows the note selection made in the instrument settings. |
| **Mallet** | Glockenspiel (9), Vibraphone (11), Marimba/Xylophone/etc. (12–15) | Bar-type percussion with material-realistic bar colours per instrument (metal vs. wood) and a struck-bar active feedback animation. |
| **Music Box** | Music Box (10) | Rotating roller with a rising comb; note names are engraved on each tine and the comb scales to width so every configured note stays visible. |
| **Kalimba** | Kalimba (108) | Thumb-piano layout on a wooden body; all configured tines are shown, reaching the top of the body. |
| **Steel Drum** | Steel Drums (114) | Brushed-chrome pan with uniformly sized pockets. |
| **Percussion Pad** | Agogo/Woodblock/Taiko/etc. (112–119) and Sound-FX (120–127) | Trigger-pad grid for non-melodic percussion and sound effects. |
| **Theremin** | `instrument_type = theremin` | Continuous-pitch control surface (no discrete keys). |

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

Every `(device, channel)` pair is now surfaced individually, so multi-instrument devices expose each of their virtual instruments separately. Virtual instruments without a name are labelled by their GM program so they are still recognisable. The selector layout adapts to large instrument counts without overflowing the header.

When the instrument's note-selection mode is **diatonic** or **pentatonic**, the keyboard now genuinely restricts the playable notes to that scale (out-of-scale keys are not playable), instead of only relabelling them.

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

All dedicated instrument views (accordion, harmonica, bagpipe, harp, mallets, …) are available in these embedded contexts exactly as in the stand-alone modal.

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
| `piano virtuel accordion.png` | Dedicated views — Accordion |
| `piano virtuel harmonica.png` | Dedicated views — Harmonica |
| `piano virtuel bagpipe.png` | Dedicated views — Bagpipe |
| `piano virtuel harp.png` | Dedicated views — Harp |
| `piano virtuel mallet.png` | Dedicated views — Mallet |
| `piano virtuel music box.png` | Dedicated views — Music Box |
| `piano virtuel kalimba.png` | Dedicated views — Kalimba |
| `piano virtuel steel drum.png` | Dedicated views — Steel Drum |
