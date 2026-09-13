# Audio → MIDI transcription

> **Status: architecture only (PR 1 of 15).** The contracts described here are
> implemented and tested. No transcription engine, no FFmpeg integration, no
> API command and no UI exist yet — see [Roadmap](#roadmap). GMB behaves
> exactly as before: the feature is inert until a backend is installed.

Turning a recording into a MIDI file GMB can route to real instruments is a
long pipeline with one strict rule: **it ends where the existing MIDI pipeline
begins.** Once a Standard MIDI File has been produced it goes through
`FileManager.handleUpload()` like any other upload — same hashing, same blob
store, same analysis, same database rows, same `file_uploaded` event. There is
no second library, no parallel storage, no duplicated MIDI parsing.

```
audio file
   │
   ├─ validation (format, size, duration)
   ├─ ffprobe                                  ─┐
   ├─ FFmpeg → canonical PCM WAV                │ AudioPreprocessor (PR 2)
   │                                           ─┘
   ├─ backend (interchangeable engine)          → TranscriptionResult
   ├─ MidiPostProcessor (raw | balanced | clean)
   ├─ MidiEncoder → Standard MIDI File
   │
   └─ FileManager.handleUpload()  ← the existing GMB pipeline takes over
```

## Design rules

1. **Engines are optional.** No Python, no FFmpeg, no model, no network: GMB
   starts normally and reports the feature as unavailable. Nothing in
   `src/transcription/` imports a native module or a model at load time.
2. **The core is never coupled to one engine.** Everything goes through the
   `TranscriptionBackend` interface; adding an engine is a new file in
   `src/transcription/backends/`.
3. **Nothing heavy is bundled.** No model weights in this repository. Weights
   are downloaded only on an explicit user action, after the licence has been
   shown.
4. **Information is never invented.** An engine that cannot detect drums,
   tempo or instruments leaves those fields empty; GMB's own adaptation layer
   then does what it always does with an under-specified file.
5. **The Pi comes first.** Every stage has a bound: file size, duration,
   concurrency, temp disk, wall-clock timeout.

## Module map (`src/transcription/`)

| Module | Role | Lands in |
| --- | --- | --- |
| `TranscriptionResult.js` | The pivot format: notes, confidence, expression curves, tempo, instruments | PR 1 |
| `TranscriptionBackend.js` | Abstract engine contract | PR 1 |
| `TranscriptionBackendRegistry.js` | Discovery, availability cache, `auto` selection | PR 1 |
| `TranscriptionCapabilities.js` | Status / capability / licence vocabulary | PR 1 |
| `TranscriptionError.js` | Typed, user-presentable failures | PR 1 |
| `TranscriptionConfig.js` | Resolved + clamped settings, on-disk layout | PR 1 |
| `utils/ProcessRunner.js`, `utils/AudioProbe.js`, `AudioPreprocessor.js`, `utils/TempFileManager.js` | FFmpeg and subprocess plumbing | PR 2 |
| `TranscriptionJobManager.js` | Queue, progress, cancellation, cleanup | PR 3 |
| `MidiPostProcessor.js`, `MidiEncoder.js`, GM/drum mapping | Result → valid SMF | PR 4 |
| `AudioTranscriptionService.js` | Orchestration + import into the library | PR 5 |
| `backends/BasicPitchBackend.js` | First engine (solo / lightweight polyphonic) | PR 7 |

## The intermediate representation

A backend does **not** return MIDI. It returns a structure that keeps
everything the model understood, because that information cannot be recovered
from a `.mid` file afterwards:

```js
{
  version: 1,
  source:   { filename: 'song.mp3', duration: 213.4, sampleRate: null, channels: null },
  backend:  { id: 'basic-pitch', version: '0.4.0', protocolVersion: 1 },
  tempoMap: [{ time: 0, bpm: 118.2 }],          // seconds → BPM, [] when unknown
  timeSignatures: [],
  tracks: [
    {
      id: 'track-1',
      name: null,
      instrument: {
        family: 'piano',       // as heard by the model, NOT a GM family slug
        label: 'Piano',
        confidence: 0.96,
        gmProgram: 0,          // null = unknown; GMB decides, no guessing
        isDrums: false         // true only when really detected
      },
      notes: [
        {
          start: 1.042, end: 1.516,   // seconds
          pitch: 64, velocity: 92,
          confidence: 0.94,           // null when the engine reports none
          expression: {               // null when the engine reports none
            pitchCurve:     [{ t: 1.05, value: 0.12 }],   // value = semitones
            amplitudeCurve: [{ t: 1.05, value: 0.83 }]    // value = 0..1
          }
        }
      ]
    }
  ],
  warnings: [],
  createdAt: '2026-09-13T23:40:00.000Z'
}
```

Times are **seconds**, not ticks: this is not MIDI, and the conversion to
ticks is `MidiEncoder`'s job. Keeping confidence and contours is what makes
manual correction, low-confidence highlighting, MPE / MIDI 2.0 export,
partial re-transcription and engine comparison possible later without a
second pipeline.

`createTranscriptionResult()` normalises whatever an engine produced:

- out-of-range values are **clamped** (`pitch` → 0..127, `velocity` → 1..127,
  `confidence` → 0..1);
- structurally impossible notes (`end <= start`, non-finite times) are
  **dropped and reported in `warnings`** — never silently;
- a malformed *structure* (tracks not an array, absurd note counts) throws a
  typed `BACKEND_FAILED` error;
- notes are sorted by `(start, pitch)` so every downstream stage is
  deterministic.

## Writing a backend

See [`src/transcription/backends/README.md`](../src/transcription/backends/README.md).
The short version:

```js
getMetadata()        // id, name, capabilities, runtime, audioFormat, licensing
checkAvailability()  // → { status, detail, version, modelVersion, modelChecksum }
transcribe(inputPath, options, context)   // → raw result object
```

- `transcribe()` receives audio **already converted** by the preprocessor to
  the format declared in `metadata.audioFormat`; an engine never decodes user
  bytes itself.
- `context.signal` (an `AbortSignal`) must be honoured promptly: kill the
  subprocess, drop temp files, reject.
- Progress is reported through `context.onProgress`, and only when the engine
  declares `capabilities.progress` — the UI shows an indeterminate bar rather
  than a fabricated percentage.

### Status vocabulary

| Status | Meaning |
| --- | --- |
| `available` | Installed and usable right now |
| `not_installed` | Known engine, nothing installed, no automated installer |
| `installable` | Can install itself on this platform |
| `license_restricted` | Installable only after explicit licence acceptance |
| `unsupported_platform` | This architecture / OS cannot run it |
| `broken` | Installed but unusable (missing venv, failed smoke test) |

Mapped to GMB's health vocabulary: `available → ready`, `broken → failed`,
everything else → `disabled`. **A missing engine never degrades
`/api/health`** — the feature is optional by design.

## Licensing

Every backend declares the licence of its **code** and of its **model
weights** separately, because they routinely differ:

```js
licensing: {
  codeLicense: 'Apache-2.0',
  modelLicense: 'CC-BY-NC-4.0',
  commercialUse: false,
  redistribution: false,
  bundled: false,
  licenseUrl: 'https://…',
  notice: 'Model weights are non-commercial; see the licence before installing.',
  requiresConsent: true
}
```

Defaults are deliberately restrictive: an undeclared licence is *not*
permissive. A model that may not be redistributed can never be marked as
bundled — the normaliser forces `bundled: false` — and consent stays mandatory
whenever commercial use is not granted. The installation UI (PR 11) shows this
block before anything is downloaded.

## Configuration

Section `transcription` in `config.json`, overridable through `GMBOOP_*`
environment variables (see `.env.example`). Values are clamped by
`resolveTranscriptionConfig()`: an out-of-range or unparseable setting falls
back to its default, so a typo can never *disable* a guard.

| Key | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the whole feature |
| `dataDir` | `./data/transcription` | Root of everything the feature writes |
| `maxAudioFileBytes` | `104857600` (100 MB) | Largest accepted upload |
| `maxAudioDurationSeconds` | `600` | Longest accepted audio |
| `maxParallelJobs` | `1` | Concurrent transcriptions (1 on a Pi) |
| `maxTempDiskBytes` | `2147483648` (2 GB) | Ceiling for `<dataDir>/tmp` |
| `jobTimeoutMs` | `900000` (15 min) | Wall-clock cap for one job |
| `keepOriginalAudio` | `false` | Keep the source audio after import |
| `keepTempFiles` | `false` | Keep per-job scratch dirs (debugging) |
| `postProcessingPreset` | `balanced` | `raw` \| `balanced` \| `clean` |
| `availabilityCacheMs` | `60000` | How long an availability probe is trusted |
| `autoImportToLibrary` | `true` | Import the generated MIDI automatically |

On-disk layout (nothing is created until a service actually writes):

```
data/transcription/
├── venvs/     isolated Python environments, one per backend
├── models/    downloaded weights — never committed
├── cache/     reusable artefacts
├── tmp/       per-job scratch: tmp/<job-id>/
└── audio/     source audio, only when keepOriginalAudio is on
```

## Errors

Every failure the user can hit is a typed `TranscriptionError` carrying a
`reason` the UI switches on, an `ERR_TRANSCRIPTION_*` code and an HTTP status:

`UNSUPPORTED_FORMAT` · `FILE_TOO_LARGE` · `AUDIO_TOO_LONG` · `FFMPEG_MISSING` ·
`BACKEND_NOT_INSTALLED` · `BACKEND_FAILED` · `BACKEND_TIMEOUT` ·
`OUT_OF_MEMORY` · `DISK_FULL` · `TRANSCRIPTION_CANCELLED` ·
`MIDI_GENERATION_FAILED` · `MIDI_IMPORT_FAILED`

`toJSON()` deliberately omits the underlying `cause`: subprocess output and
filesystem paths stay in the logs, they do not reach the browser.

## Roadmap

| PR | Content | Status |
| --- | --- | --- |
| 1 | Contracts: result format, backend interface, registry, errors, config | ✅ done |
| 2 | `ProcessRunner`, `AudioProbe`, `AudioPreprocessor`, temp files, limits | planned |
| 3 | `TranscriptionJobManager`: queue, progress, cancellation, cleanup | planned |
| 4 | `MidiPostProcessor`, `MidiEncoder`, GM mapping, drum mapping | planned |
| 5 | Import through `FileManager.handleUpload()` | planned |
| 6 | WebSocket commands + schemas | planned |
| 7 | Basic Pitch backend (isolated venv, pinned versions) | planned |
| 8–9 | UI: Convert Audio, engine/quality choice, progress, results | planned |
| 10 | Capability / health / Settings integration | planned |
| 11 | Backend installer (consent, checksum, smoke test, rollback) | planned |
| 12 | Multi-instrument engine, after licence verification | planned |
| 13 | Advanced expression (pitch contours, CC11, simplification) | planned |
| 14 | Raspberry Pi benchmarks and limit tuning | planned |
| 15 | Documentation and hardening | planned |

## Troubleshooting

Nothing to troubleshoot yet — no engine can run. This section is filled in
with PR 7 (Basic Pitch installation) and PR 15.
