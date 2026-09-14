# Audio → MIDI transcription

> **Status: usable.** The pipeline runs end to end: drop in audio, watch it
> convert, find the MIDI in your library. One engine (Basic Pitch) is
> supported and installs itself from Settings — see
> [Installing an engine](#installing-an-engine). On a server with no engine,
> or with no FFmpeg, GMB behaves exactly as before and says so plainly. A
> multi-instrument engine waits on licence verification, and the Raspberry Pi
> figures below are estimates until a Pi produces them — see
> [Roadmap](#roadmap).

## Opening it

**There is no button.** Drop an audio file anywhere on the interface, or pick
one through the usual file browser (the drop zone's *click to add* opens it),
and the conversion opens with that file already chosen. A `.mid` dropped the
same way still goes straight to the library, untouched.

That is deliberate: a dedicated button would have to be hidden by default —
the feature needs an engine installed separately — and a hidden button is one
nobody finds. The drop zone was already there, already refusing audio files;
now it does something useful with them instead.

What counts as audio is one list, `TranscriptionModal.AUDIO_EXTENSIONS`, read
by the page for routing and by the file picker for its `accept`. The server
checks the bytes regardless — the list only decides which drop lands where.

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
| `backends/BasicPitchBackend.js` + `python/basic-pitch/` | First engine (solo / lightweight polyphonic) | PR 7 |

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

### Choosing a preset

`postProcessingPreset` decides how much the engine's raw output is tidied
before it becomes MIDI. What each one is for, from measurement rather than
taste:

| Preset | Does | Pick it when |
| --- | --- | --- |
| `raw` | Nothing at all | You want to see exactly what the engine heard, detune included |
| `balanced` | Drops sub-30 ms notes and duplicates, repairs overlaps, removes pitch bend below the engine's own resolution | Most material. The default |
| `clean` | Also filters by confidence, merges note fragments, normalises velocities | Repeated notes, noisy recordings, anything `balanced` leaves ragged |

The one case where the choice really matters: **the engine does not always
re-onset a repeated note.** Six 300 ms notes on the same pitch come back as
one unbroken stream of fragments until the silence between them reaches
about 180 ms. `balanced` keeps every fragment as its own Note On — eleven
strikes for six notes — while `clean` reconstructs 6 out of 6 from about
80 ms upward. No quality setting changes what the engine reports.

| Silence between the notes | Engine | `balanced` | `clean` | Truth |
| --- | --- | --- | --- | --- |
| 50 ms | 11 fragments | 11 | 1 | 6 |
| 80 ms | 11 | 11 | **6** | 6 |
| 120 ms | 12 | 12 | **6** | 6 |
| 180 ms | 6 | **6** | **6** | 6 |

When it happens, the result screen says so and names the preset to try, so
this does not have to be discovered the hard way.

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
| 2 | `ProcessRunner`, `AudioProbe`, `AudioPreprocessor`, temp files, limits | ✅ done |
| 3 | `TranscriptionJobManager`: queue, progress, cancellation, cleanup | ✅ done |
| 4 | `MidiPostProcessor`, `MidiEncoder`, GM mapping, drum mapping | ✅ done |
| 5 | Import through `FileManager.handleUpload()` | ✅ done |
| 6 | WebSocket commands + schemas | ✅ done |
| 7 | Basic Pitch backend (isolated venv, pinned versions) | ✅ done |
| 8–9 | UI: the modal, engine/quality choice, progress, results | ✅ done |
| 10 | Capability / health / Settings integration | ✅ done |
| 11 | Backend installer (consent, smoke test, rollback) | ✅ done |
| 12 | Multi-instrument engine, after licence verification | **not done** — §8 forbids integrating an engine whose licence has not been verified, and none could be |
| 13 | Advanced expression (pitch contours, CC11, simplification) | ✅ done in PR 4 |
| 14 | Raspberry Pi benchmarks and limit tuning | ✅ script shipped (`scripts/transcription-benchmark.mjs`); the numbers need a real Pi |
| 15 | Documentation and hardening | ✅ done |

## Installing an engine

### Prerequisite: FFmpeg — already there

Everything goes through FFmpeg, whichever engine you use, and it brings
`ffprobe` with it. **`scripts/Install.sh` installs it with the rest of the
system packages**, so a normal deployment has it before you ever open the
Settings panel; installing an engine is then the only step left.

If you are on an installation that predates this, or you set GMB up by hand,
re-running the installer adds it:

```bash
./scripts/Install.sh              # idempotent; installs what is missing
sudo apt install ffmpeg           # or just this, on Debian / Raspberry Pi OS
```

Without it the feature reports `degraded` and every conversion fails with
`FFMPEG_MISSING` — nothing else breaks.

> **Why not a button?** Installing a system package needs root, which the
> server does not have and should not be given for a web request. Bundling a
> static build instead would be ~80 MB paid by every user, ours to keep
> patched, and the packages that ship one (`imageio-ffmpeg`, `pyffmpeg`) carry
> no real `ffprobe`, which GMB needs just as much. Putting it in the installer
> costs nothing and means it is simply present.

### Basic Pitch (solo / lightweight polyphonic)

Basic Pitch is Spotify's note-detection model, published under Apache-2.0
**including its weights**. It hears several notes at once and does it well on
a solo instrument or a clean voice. It does **not** separate instruments, does
**not** name them, and does **not** detect drums — the UI disables those
options when it is selected, because its metadata says so.

**From the interface:** Settings → *Audio → MIDI engines* → **Install**. The
server creates the environment, installs the pinned requirements, and only
then re-probes the engine for real — "Ready" means it imports, not that the
installer exited 0. A failed install is rolled back so the next attempt
starts clean.

**Python version.** The pinned TensorFlow publishes wheels for CPython 3.9,
3.10 and 3.11 and nothing newer, so that is the range this engine installs
on. Raspberry Pi OS Bookworm ships 3.11 and needs nothing done. On a newer
distribution, install one of those alongside the system Python; the installer
checks the interpreter first and refuses immediately, naming what it found,
rather than failing after a long download.

**Behind a proxy or a private CA.** The installer passes the usual
`HTTP(S)_PROXY`, `NO_PROXY`, `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE`,
`PIP_CERT` and `PIP_INDEX_URL` settings through to `pip`, so a box that can
already `pip install` from a shell can install an engine. Those settings go
to the package installer alone — transcription itself never reaches the
network, so nothing else in the pipeline receives them.

**By hand**, if you prefer, or to script a deployment — it installs into its
own Python environment, never the system Python:

```bash
cd /path/to/General-Midi-Boop
python3 -m venv data/transcription/venvs/basic-pitch
data/transcription/venvs/basic-pitch/bin/pip install --upgrade pip
data/transcription/venvs/basic-pitch/bin/pip install     -r src/transcription/python/basic-pitch/requirements.txt
```

Then open **Settings → Audio → MIDI engines** and press Refresh: Basic Pitch
should turn from *Can be installed* to *Ready*. The server checks this by
running the engine's own self-check, so "Ready" means the environment really
imports — not merely that a directory exists.

What to expect:

| | Pi 3B+ (1 GB) | Pi 4 (4 GB) | Pi 5 / desktop |
| --- | --- | --- | --- |
| Install size | ~700 MB | ~700 MB | ~700 MB |
| 1 min of audio | very slow, not recommended | ~1–3 min | < 1 min |
| RAM while running | **does not fit** | comfortable | comfortable |

**Measured**, on 30 s of audio: the engine's subprocess peaks at about
**725 MB** of RSS. With Raspberry Pi OS and GMB itself, that does not fit in
a 1 GB board — a Pi 3B+ is killed by the kernel, not merely slow, and the
job then reports `OUT_OF_MEMORY`. Two gigabytes is the realistic floor, which
is what the engine now declares.

One more number worth knowing on a Pi: once the engine has finished, GMB
post-processes and encodes the notes **synchronously**. On a ten-minute file
(≈ 5 000 notes) that is roughly 110 ms on a desktop, so on the order of half
a second on a Pi 4 — during which the MIDI scheduler does not run. If you are
playing a piece while a transcription finishes, expect it to hitch once.

Deliberately left that way: a worker thread was measured and costs *more*
main-thread time than the work it would move (175 ms just to start one, or
463 ms to post the result across), so the only option that would actually
help is slicing the two transforms into async chunks — a real cost for a
one-off hitch at the end of a job you started. See
`docs/audit/AUDIT_TRANSCRIPTION_ALGO_2026-09-14.md` §6.

TensorFlow is the heavy part of that install. The transcription runs at two
threads (`OMP_NUM_THREADS=2`) so the MIDI side of GMB keeps its cores while a
conversion is going on.

To remove it: Settings → *Audio → MIDI engines* → **Uninstall**, or by hand:

```bash
rm -rf data/transcription/venvs/basic-pitch
```

Nothing else is left behind: no system package, no cache outside
`data/transcription/`.

### What the installer guarantees

For every engine, whoever wrote it (§34):

1. **Consent before download.** An engine whose licence requires acceptance
   is never installed until the user has seen that licence and confirmed it —
   and the confirmation names the licence that was displayed, so a page left
   open since before the terms changed cannot consent on their behalf.
2. **One install at a time.** These are hundreds of megabytes and pin the
   CPU; two at once is how a Pi falls over.
3. **Room to land.** Free disk is checked against the engine's own estimate,
   plus headroom, before anything is fetched.
4. **Rollback.** A failure removes what was created, so a retry starts from a
   clean tree rather than on top of a half-built environment.
5. **Verified, not assumed.** The engine is re-probed after the install; if it
   does not start, the install is a failure and is rolled back.

## How Node talks to an engine

A plain subprocess, one job at a time, speaking JSON Lines on stdout
(protocol version 1):

```
{"type":"progress","stage":"loading","progress":0.05}
{"type":"progress","stage":"transcribing","progress":0.42}
{"type":"complete","output":"/…/result.json"}
```

stderr carries diagnostics only. The runner never prints the payload to
stdout; it writes a result file whose path Node chose. Options travel through
a file too, so no user-influenced value ever reaches the command line.

Both sides carry the protocol version and refuse each other on a mismatch —
an environment installed against an older GMB reports `broken` with "reinstall
the environment" rather than producing silently wrong results.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing happens when I drop an audio file | The format is not one GMB offers | See the accepted formats above; the file browser lists them too |
| "FFmpeg is not installed" | An install that predates it, or a manual setup | Re-run `./scripts/Install.sh` |
| Engine shows *Can be installed* | No virtual environment yet | Follow the install steps above |
| Engine shows *Installed but unusable* | The venv exists but does not import | Re-run the `pip install`; the Settings detail line carries the Python error |
| "This engine needs Python 3.9 – 3.11" | The interpreter has no TensorFlow wheel | Install a supported Python and make it `python3` on `PATH` |
| Install fails on a TLS or DNS error | `pip` cannot reach PyPI | Check the proxy/CA variables are exported to the GMB process, not only to your shell |
| Engine shows a protocol mismatch | The environment predates this GMB version | Delete the venv and reinstall |
| `OUT_OF_MEMORY` on a Pi | The model ran out of RAM | Shorter file, or the *Fast* quality setting |
| `AUDIO_TOO_LONG` / `FILE_TOO_LARGE` | Resource guards | Raise `transcription.maxAudioDurationSeconds` / `maxAudioFileBytes`, knowing what it costs |
| The job never leaves *queued* | Another transcription is running | `maxParallelJobs` is 1 by design on a Pi |

Logs: every stage is logged through GMB's own logger (`logs/gmboop.log`).
Subprocess output is never logged verbatim — only the tail of stderr on a
failure (§38).
