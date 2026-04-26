# Auto-Assignment

Automatically maps each MIDI channel of a file to the most suitable connected instrument. Full design in [`docs/AUTO_ASSIGNMENT.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/AUTO_ASSIGNMENT.md).

![Auto-Adaptation](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/auto%20assign.png?raw=true)

## Pipeline

```
MIDI file ─► ChannelAnalyzer ─► InstrumentMatcher ─► (Drum remap | Transposer)
                                       │
                                       └─► AudioPreview ─► Apply routing
```

Source code: [`src/midi/adaptation/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/midi/adaptation).

## Stages

### 1. Channel analysis

`ChannelAnalyzer` extracts, per channel:

- **Instrument type**: drums / melody / bass / harmony (heuristics on note range, polyphony, GM program)
- **Note range**: lowest and highest notes used
- **Polyphony**: maximum simultaneous notes
- **Density**: notes per second

### 2. Instrument matching

`InstrumentMatcher` scores each (channel, connected-instrument) pair from **0 to 100** based on:

- Type compatibility (a piano channel matches a polyphonic keyboard better than a monophonic flute)
- Range coverage (penalty for missing notes)
- Polyphony capacity
- User preference weight (favoured instruments get a bonus)

The best match wins, ties broken deterministically.

### 3. Drum remapping

`DrumNoteMapper` substitutes GM drum notes (35–81) onto the actual drum kit available on the target device, with priority chains:

```
kick → snare → hi-hat → crash → toms → percussion
```

Missing pieces fall back to the next priority. Custom mappings can be saved per device.

### 4. Transposition / octave wrapping

`MidiTransposer` shifts whole tracks by octaves to fit them inside the destination instrument's range. Wrapping can be enabled per channel; safety clamps prevent producing notes outside hardware limits.

### 5. Audio preview

Before committing, an audio preview plays the proposed assignment through the GM synth so the operator can sanity-check it. Apply or revert without touching the file.

## Operator Workflow

1. Open the file in the library and click **Auto-Assign**.
2. Review the suggestion grid: one row per source channel, columns for chosen device, score, transposition, drum-map preview.
3. Toggle octave-wrapping per channel if needed.
4. Hit **Preview** — the GM synth plays the result.
5. Click **Apply** to write the routing to the database.

## Programmatic Use

Triggerable via WebSocket commands (subset):

- `auto_assign_suggest` — returns the proposed mapping without persisting.
- `auto_assign_apply` — writes the routing.
- `auto_assign_preview` — kicks off audio preview.

Full command list in [[API-Reference]] and [`docs/API.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/API.md).
