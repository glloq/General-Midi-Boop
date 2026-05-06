# Advanced Topics

Deeper dives into specialised subsystems.

## String Instruments and Tablature

Driving real acoustic strings via solenoids and servos through MIDI CC. The tablature editor offers bidirectional MIDI ↔ tab conversion with **19 tuning presets** spanning guitar, bass, violin, ukulele, mandolin, and more.

Full reference: [`docs/STRING_HAND_POSITION.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/STRING_HAND_POSITION.md).

![Tab editor](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/edit%20tab.png?raw=true)

Highlights:

- Per-string fret-range constraints
- Custom tuning entry alongside presets
- Auto-arrangement chooses the most playable fingering for a given note sequence
- WebSocket commands: `string_get_presets`, `string_set_tuning`, `string_arrange`

## Hand-Position Control

For motorised keyboards or automated pianos, the system plans hand placement before sending notes:

- Per-instrument `hands_config` with **pitch-split** or **track-based** modes.
- Hand position transmitted via reserved CCs (typically CC 23 / 24 — full reservation list in [`docs/MIDI_CC_INSTRUMENT_CONTROLS.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/MIDI_CC_INSTRUMENT_CONTROLS.md)).
- Safety clamps prevent commanding the hardware outside its physical envelope.
- Planning runs ahead of the playback cursor (lookahead) so positioning completes before the next note.

## Microphone-Based Latency Calibration

Source: [`src/audio/DelayCalibrator.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/audio/DelayCalibrator.js).

![Calibration modal](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/microphone/micro%20calibration%20global.png?raw=true)

How it works:

1. The system sends a probe note to the device.
2. ALSA records the audio response on the configured input.
3. Onset detection finds the first peak above a threshold.
4. The round-trip delay = (audio onset timestamp) − (note send timestamp).
5. Steps 1–4 repeat N times; the **median** is taken with a confidence score derived from the spread.
6. The result is written to the device's `latency` field; playback compensation kicks in immediately.

The calibration modal groups all steps in one place:

- **ALSA device selector** — auto-selects the first detected USB microphone; any ALSA capture device is available in the dropdown.
- **VU-meter + threshold slider** — real-time input level bar with an inline draggable threshold so you can verify the mic picks up the instrument before measuring.
- **Per-instrument "Measure" button** — triggers a measurement run for each connected instrument independently; status indicators show `idle` / `running` / `success` / `error`.
- **Canvas chart** — plots round-trip delay and confidence score for each measurement run.
- **"Apply delays" button** — appears once at least one measurement succeeds; writes all pending latency values to the device settings in one step.

Tunables:

- Number of measurements
- Detection threshold (dBFS)
- Probe note (default A4)
- Recalibration reminder interval

## Chromatic Tuner

Accessible via the **"Open Tuner"** banner at the top of the calibration modal (or directly from the device panel). Audio is captured by ALSA on the Raspberry Pi and pitch detection runs server-side using the **MPM algorithm**; the frontend subscribes to `tuner:pitch` WebSocket events.

Three operating modes:

| Mode | Description |
|------|-------------|
| **Auto** | No target — shows the nearest chromatic note to the detected frequency with cents deviation. |
| **Note** | User picks a target from a chromatic strip (E1–C6); display shows up/down guidance and a needle against the chosen pitch. |
| **Instrument** | User selects a connected MIDI instrument or a generic preset. For stringed instruments with a configured tuning the picker exposes the open-string notes; for melodic instruments it falls back to the chromatic row. |

### Auto mode (free tuning)

![Tuner — auto mode](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/microphone/tuner%20free.png?raw=true)

Play any note; the display locks onto the closest pitch and shows the deviation in cents.

### Note / Instrument mode (target tuning)

![Tuner — target mode](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/microphone/tuner%20target.png?raw=true)

Select a target note or open string. The needle and colour indicator guide you to the exact pitch.

Built-in instrument presets (open strings in standard tuning):

| Preset | Strings |
|--------|---------|
| Guitar | E2 A2 D3 G3 B3 E4 |
| Bass | E1 A1 D2 G2 |
| Violin | G3 D4 A4 E5 |
| Viola | C3 G3 D4 A4 |
| Cello | C2 G2 D3 A3 |
| Ukulele | G4 C4 E4 A4 |

Note names are displayed in the locale format chosen in Settings (US, FR/solfège, or raw MIDI number). Reference pitch is A4 = 440 Hz.

## Reserved MIDI CC Ranges

The project reserves several Control Change numbers for instrument-specific behaviour (hand position, articulation hints, custom hardware). The authoritative list is in [`docs/MIDI_CC_INSTRUMENT_CONTROLS.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/MIDI_CC_INSTRUMENT_CONTROLS.md). Avoid these CC numbers when authoring generic MIDI files.

## Internationalisation (i18n)

The UI ships with **28 language files** under [`public/locales/`](https://github.com/glloq/General-Midi-Boop/tree/main/public/locales): English, French, Spanish, German, Italian, Portuguese, Dutch, Polish, Russian, Chinese, Japanese, Korean, Turkish, Hindi, Bengali, Thai, Vietnamese, Czech, Danish, Finnish, Greek, Hungarian, Indonesian, Norwegian, Swedish, Ukrainian, Esperanto, Tagalog.

GM instrument names are localised in every supported language.

To add a language:

1. Copy `public/locales/en.json` to `public/locales/<code>.json`.
2. Translate the values, leaving keys untouched.
3. Add the language to the locale picker in the settings view.
4. Run `npm run test:frontend` to make sure no key is missing.

## Content-Addressable Blob Store

MIDI files are stored by SHA-256 hash in [`src/files/BlobStore.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/files/BlobStore.js). Identical files dedupe automatically; renames and moves only update metadata rows. Use this when designing tooling that mass-imports files — uploading the same content twice is cheap.
