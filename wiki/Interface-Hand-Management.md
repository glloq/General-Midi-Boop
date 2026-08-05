# Interface — Hand Position Management

For motorised instruments that physically move to play notes — automated pianos, robotic guitar rigs, solenoid-driven string instruments — Général Midi Boop must plan where the mechanical hand or actuator needs to be *before* each note arrives. The hand-management editors let you visualise, tune, and override these position plans.

Two independent editors exist, one per instrument family:

| Editor | For |
|--------|-----|
| **Keyboard Hand Position Editor** | Piano, chromatic keyboards, chromatic percussion |
| **String Hand Position Editor** | Guitar, bass, violin, cello, ukulele, and all fretted/bowed string instruments |

Source files:
- [`public/js/features/auto-assign/KeyboardHandPositionEditorModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/auto-assign/KeyboardHandPositionEditorModal.js)
- [`public/js/features/auto-assign/HandPositionEditorModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/auto-assign/HandPositionEditorModal.js)
- Backend planner: [`src/midi/adaptation/HandPositionPlanner.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/midi/adaptation/HandPositionPlanner.js)

---

## Keyboard Hand Position Editor

![Virtual piano — 2 hands piano keys](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%202%20mains%20touches%20piano.png?raw=true)

### Core Concepts

The piano keyboard is divided into **hand windows**. Each hand window is a contiguous band of keys that one mechanical hand can reach without moving. When a note falls outside the window, the planner schedules a **hand shift** sufficiently early (lookahead) so the mechanism arrives before the note must play.

| Concept | Description |
|---------|-------------|
| **Hand anchor** | The leftmost white key of the hand's reachable window |
| **Hand span** | Width of the window — in keys (count of white keys) or in mm (physical) |
| **Lookahead** | How many chords ahead the planner looks to pre-position the hand |
| **CC position** | The CC number sent to the hardware to command the hand position |

### Visual Feedback

On the keyboard display:

- **Blue dots** — notes in the current hand window (reachable, will be played).
- **Red chevrons (▲ / ▼)** — notes outside the window (unplayable without a shift). They are parked at the edge of the band to signal the constraint.
- **Coloured band** — the extent of the hand window, drawn behind the keys.

### Multi-Hand Support

Up to four independent hands are supported (`h1`, `h2`, `h3`, `h4`). This covers:

- Left hand / right hand split on a single keyboard.
- Two separate keyboards played by two independent robots.

Each hand has its own colour and its own CC channel. The **pitch-split mode** assigns notes below a dividing pitch to hand 1 and notes at or above it to hand 2. The **track-based mode** assigns MIDI tracks to hands explicitly.

### Controls

| Control | Action |
|---------|--------|
| Drag the hand band | Move the anchor interactively |
| Span slider | Adjust the physical reach of the hand |
| Hand selector tabs | Switch between h1 / h2 / h3 / h4 |
| Undo / Redo | 50-entry history |
| Lookahead slider | 1–8 chords of forward planning |
| "Pin anchor" | Lock the hand to the current position for a specific time range |

### Timeline & Minimap

A **sticky top preview** shows the hand position across the full MIDI timeline as a scrollable horizontal strip. The **minimap** compresses the entire timeline into a navigation bar; click to jump to any position.

The **lookahead window** is visualised as a semi-transparent overlay showing where the hand will be at each upcoming chord. Overlaps with the next-chord notes are highlighted to reveal potential timing conflicts.

### Hand Span Configuration

| Mode | Unit | Notes |
|------|------|-------|
| **Key count** | White keys | Fast — span of 5 = a comfortable five-note reach |
| **Physical (mm)** | Millimetres | Accurate for real hardware; requires scale_length_mm configured on the instrument |

---

## String Instrument Hand Position Editor

![Virtual piano — guitar hand on strings](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20guitare%20main%20cordes.png?raw=true)

### Core Concepts

String instruments use a **fret-window model**: the fretting hand covers a band of consecutive frets. The window moves up or down the neck when a note outside the current range is required.

| Concept | Description |
|---------|-------------|
| **Anchor fret** | The lowest fret in the hand's reachable window |
| **Hand span (frets)** | How many consecutive frets the hand covers |
| **Hand span (mm)** | Physical distance — mapped to frets via the instrument's scale length |
| **String assignment** | Which string plays each note (one note per string at a time — monophonic strings) |
| **Finger backoff** | Real-world finger placement is ~10 mm behind the fret wire; factored into CC values |

### Hand Mechanisms

Three mechanisms are available per instrument:

| Mechanism | Description |
|-----------|-------------|
| `single_hand` | One hand window moves as a unit; all fingers shift together |
| `fret_sliding_fingers` | Fingers can slide individually within the window while the window anchor stays fixed |
| `string_sliding_fingers` | One independent sliding finger per string (longitudinal model — see below) |

### Longitudinal (Motor-per-String) Model

For instruments where each string has its own independent actuator (e.g. a solenoid or servo per string):

- Each finger slides freely along its own string.
- **Anchoring**: a finger stays in place while the corresponding note is sustained.
- **Anti-jitter**: hysteresis and lookahead prevent unnecessary small movements.
- Optional **dense CC trajectory** (configurable sample rate in Hz) sends smooth position curves for servo-driven robots.

![Virtual piano — guitar motor per string](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20guitare%20moteur%20par%20corde.png?raw=true)

### Visual Feedback

| Display | Meaning |
|---------|---------|
| Coloured band on the fretboard | Current hand window |
| Blue dots | Notes within reach |
| Red chevrons | Notes outside the hand window or exceeding polyphony |
| Per-string position line | Actuator position in longitudinal mode |

#### Fretboard Views

- **Horizontal** — guitar-style, low strings at the bottom. Default for guitar/bass.
- **Vertical** — viola/cello/double bass style, neck goes downward.
- **Full grid** — all strings × all frets simultaneously.

![Virtual piano — string hand vertical](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20cordes%20main%20verti.png?raw=true)

![Virtual piano — all frets and strings](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/virtual%20keyboard/piano%20virtuel%20cordes%20toutes%20frettes%20et%20cordes.png?raw=true)

### Operator Overrides

The planner's automatic decisions can be overridden for any note or time range:

| Override type | Effect |
|--------------|--------|
| **Pin hand anchor** | Lock the anchor fret at a specific value for a time range |
| **Pin note → string** | Force a specific note to play on a specific string |

Overrides are stored alongside the MIDI file and survive re-analysis.

---

## Enabling Hand Position

Hand position is disabled by default. To activate it:

1. Open [[Interface-Instrument-Creation]] for the target instrument.
2. Scroll to the **"Hand position"** section.
3. Enable the subsystem and select the mechanism.
4. Set the hand span and assign the CC numbers that command the hardware.
5. Save — the planner will run before the next playback start.

### CC Numbers

The CC numbers assigned to hand position control follow the reservation table in [`docs/MIDI_CC_INSTRUMENT_CONTROLS.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/MIDI_CC_INSTRUMENT_CONTROLS.md). Default assignments:

| Signal | Default CC |
|--------|-----------|
| Hand position (keyboard) | CC 23 / CC 24 (left / right hand) |
| String selection | CC 20 |
| Fret position | CC 21 |
| Longitudinal finger (per string) | CC 22+ |

Avoid these CC numbers in MIDI file automation unless you intend to control the hardware directly.

---

## Related Pages

- [[Interface-Instrument-Creation]] — where the hand position subsystem is enabled and configured
- [[Interface-Virtual-Piano]] — live preview of hand position on the virtual keyboard
- [[Advanced-Topics]] — deeper technical details: fret-window geometry, longitudinal model, feasibility simulator
- [[Instrument-Developer-Guide]] — how to declare CC-based string/fret selection in the descriptor's `physical` block so GMBoop can auto-configure the CC wiring
