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

How it works:

1. The system sends a probe note to the device.
2. ALSA records the audio response on the configured input.
3. Onset detection finds the first peak above a threshold.
4. The round-trip delay = (audio onset timestamp) − (note send timestamp).
5. Steps 1–4 repeat N times; the **median** is taken with a confidence score derived from the spread.
6. The result is written to the device's `latency` field; playback compensation kicks in immediately.

Tunables:

- Number of measurements
- Detection threshold (dBFS)
- Probe note (default A4)
- Recalibration reminder interval

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
