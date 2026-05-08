# Interface — Microphone: Calibration & Tuner

The microphone panel groups two tools that use audio input from an ALSA capture device:

1. **Latency Calibrator** — measures the round-trip delay of each instrument and writes the result directly into that instrument's `sync_delay` field.
2. **Chromatic Tuner** — detects the pitch of any sound and guides you to a target note.

Source: [`public/js/features/CalibrationModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/CalibrationModal.js), [`public/js/features/TunerModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/TunerModal.js), [`src/audio/DelayCalibrator.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/audio/DelayCalibrator.js).

## Latency Calibration

![Calibration modal](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/microphone/micro%20calibration%20global.png?raw=true)

### How It Works

1. Général Midi Boop sends a probe note to the instrument.
2. ALSA records the audio response on the selected input.
3. Onset detection finds the first amplitude peak above the threshold.
4. `round-trip delay = audio onset timestamp − note send timestamp`.
5. Steps 1–4 repeat N times; the **median** is used as the final value.
6. A **confidence score** is derived from the spread of measurements (tight cluster = high confidence).
7. The delay is written to `instrument_settings.sync_delay`; playback compensation applies immediately.

### ALSA Device Selection

| Field | Description |
|-------|-------------|
| **Device** | ALSA capture device (e.g. `hw:1,0`, `default`, `sysdefault`) |
| **Auto-detect** | Picks the first detected USB microphone automatically |

Any device listed by `arecord -l` is available in the dropdown.

### VU Meter & Threshold

A real-time level bar shows the microphone input. An inline draggable **threshold slider** sets the onset detection level (0.01–0.10 of full scale). Verify that:

- The bar rises when the instrument plays.
- The bar stays below the threshold when the instrument is silent.

A threshold set too high will miss soft onsets; too low will trigger on background noise.

### Per-Instrument Measurement

Each connected instrument has its own **"Measure"** button and a status indicator:

| Status | Meaning |
|--------|---------|
| `idle` | No measurement taken yet |
| `running` | Measurement in progress |
| `success` | Valid result, delay and confidence shown |
| `error` | No onset detected or inconsistent results |

Run measurements independently so that instruments with very different latencies are each calibrated correctly.

### Chart

A canvas chart plots the round-trip delay and confidence score across all runs for the selected instrument. Use this to spot outliers or environmental noise spikes.

### Tunables

| Parameter | Default | Description |
|-----------|---------|-------------|
| **Number of measurements** | 5 | Median calculated over N runs |
| **Detection threshold** | 0.05 | Onset amplitude threshold |
| **Probe note** | A4 (69) | MIDI note sent to trigger the instrument |
| **Probe velocity** | 100 | Velocity of the probe note |

### Apply Delays Button

Once at least one measurement succeeds, an **"Apply delays"** button appears. It writes all pending latency values in one operation. Individual instruments can also be applied one at a time.

---

## Chromatic Tuner

![Tuner — auto mode](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/microphone/tuner%20free.png?raw=true)

The tuner is accessible via the **"Open Tuner"** link at the top of the calibration panel (or directly from the device panel). Pitch detection runs server-side using the **MPM algorithm**; the frontend subscribes to `tuner:pitch` WebSocket events.

### Operating Modes

| Mode | Description |
|------|-------------|
| **Auto** | No target — detects the nearest chromatic note and displays the cents deviation |
| **Note** | User selects a target note from a chromatic strip (E1–C6); needle shows up/down guidance |
| **Instrument** | User selects a connected instrument; for strings the open-string notes are shown; for other instruments falls back to the chromatic row |

### Auto Mode

![Tuner — auto mode](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/microphone/tuner%20free.png?raw=true)

Play any note; the display locks onto the closest pitch and shows cents deviation (−50 to +50 cents). Useful for quick intonation checks without a specific target.

### Note / Instrument Mode

![Tuner — target mode](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/microphone/tuner%20target.png?raw=true)

Select a target note or open string. The needle and colour indicator guide you:

- **Green** — within ±5 cents (in tune)
- **Yellow** — 5–20 cents deviation
- **Red** — >20 cents deviation

### Built-In Instrument Presets (Open Strings)

| Preset | Open strings |
|--------|-------------|
| Guitar | E2 A2 D3 G3 B3 E4 |
| Bass | E1 A1 D2 G2 |
| Violin | G3 D4 A4 E5 |
| Viola | C3 G3 D4 A4 |
| Cello | C2 G2 D3 A3 |
| Ukulele | G4 C4 E4 A4 |

Note names follow the locale format set in [[Interface-Settings]] (US notation, solfège, or raw MIDI number). Reference pitch: A4 = 440 Hz.

## Related Pages

- [[Interface-Instrument-Creation]] — latency `sync_delay` is stored per instrument
- [[Interface-Settings]] — select note-name locale (US / solfège / MIDI number)
- [[Advanced-Topics]] — technical background on onset detection and the MPM algorithm
