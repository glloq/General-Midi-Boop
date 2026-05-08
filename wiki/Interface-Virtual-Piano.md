# Interface — Virtual Piano (Keyboard Modal)

The virtual piano lets you play and test connected instruments directly from the browser — no physical keyboard needed. It adapts its display to the type of instrument assigned to the selected channel.

Source: [`public/js/features/KeyboardModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/KeyboardModal.js) and mixins in [`public/js/features/keyboard/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/js/features/keyboard).

## Display Modes

The view is selected automatically based on the instrument type of the active channel, but can also be changed manually.

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

For percussion channels (GM channel 10 / type `drums`): the keyboard is replaced by a GM drum pad grid. Each pad shows the instrument name (Kick, Snare, Hi-Hat, …). Click or press the mapped key to trigger the note.

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

## Controls

### Channel Selector

A dropdown at the top selects which MIDI channel / instrument receives the played notes. Switching channel changes the display mode and the outgoing MIDI target.

### Velocity

A vertical slider sets the velocity (1–127) for all notes sent by the virtual keyboard. Default: 100.

### Modulation Wheel

Sends CC#1 (Modulation). Drag upward to increase modulation depth.

### Pitch Bend

A dedicated wheel sends 14-bit pitch bend (±8191). Returns to centre on release.

### Octave Navigation

| Control | Action |
|---------|--------|
| **◄ / ►** buttons | Shift the visible range one octave left or right |
| **Zoom slider** | Change how many octaves are visible (1–8) |
| **Minimap click** | Jump to any octave instantly |

## Computer Keyboard Mapping

The virtual keyboard maps computer keys to MIDI notes. Two layouts are supported:

| Layout | White keys | Black keys |
|--------|-----------|-----------|
| **QWERTY** | `A S D F G H J K L` | `W E T Y U O P` |
| **AZERTY** | `Q S D F G H J K L M` | `Z E T Y U I O` |

The layout is detected from the browser locale. The active row plays the middle octave; use the octave shift buttons to reach higher or lower notes. Multiple keys can be held simultaneously for chords.

## Touch Support

On tablets and touch screens the virtual keyboard accepts multi-finger input. Each finger is tracked independently, allowing full chords without "ghost" or "lifted" note artefacts.

## Related Pages

- [[Interface-Hand-Management]] — configure how hand position is planned and displayed
- [[Interface-Instrument-Creation]] — set the instrument type that drives the display mode
- [[MIDI-Editor]] — edit MIDI files instead of playing live
