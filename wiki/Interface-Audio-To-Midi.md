# Interface — Audio → MIDI

Turn a recording into a MIDI file Général Midi Boop can route to real instruments. Drop an audio file on the interface and the conversion opens with that file ready to go; what comes out lands in your library like any other upload, so the editor, the auto-assigner and playback all work on it unchanged.

Source: [`public/js/features/transcription/TranscriptionModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/transcription/TranscriptionModal.js), [`src/transcription/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/transcription). Full reference: [`docs/AUDIO_TRANSCRIPTION.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/AUDIO_TRANSCRIPTION.md).

## Opening It

**There is no button.** Drop an audio file anywhere on the page — on the drop zone or beside it — or pick one through the usual file browser, and the conversion opens with that file already chosen. A `.mid` dropped the same way still goes straight to the library, untouched.

The drop zone's label tells you what *this* server accepts. Until a transcription engine is installed it offers MIDI only; once one is ready it reads "click to add MIDI or audio files" and the file browser starts offering audio formats. That switch happens live — install an engine from Settings and the label changes without reloading the page.

## Before You Start

Two things are needed, and neither ships with GMB:

| Requirement | How to get it | Without it |
|-------------|---------------|------------|
| **FFmpeg** | Already installed by `scripts/Install.sh` | Jobs fail with `FFMPEG_MISSING` |
| **A transcription engine** | Settings → *Audio → MIDI engines* → **Install** | The modal explains what is missing and offers nothing that cannot work |

FFmpeg ships with the normal installation, so on a standard deployment the engine is the only thing left to install — one button, no terminal. On an installation that predates it, re-running `./scripts/Install.sh` adds it.

One engine is supported today: **Basic Pitch** (Spotify, Apache-2.0 for both code and model weights). It is installed into its own Python environment under `data/transcription/venvs/`, never into the system Python, and it needs CPython 3.9–3.11 — the installer checks the interpreter first and refuses immediately rather than failing after a long download.

**Hardware.** The engine peaks at about **725 MB of RAM**. A Pi 4 or better is fine; a Pi 3B+ (1 GB) does not fit and the job is killed by the kernel, reported as `OUT_OF_MEMORY`. Installing takes ~700 MB of disk, mostly TensorFlow.

## Converting a File

| Step | What you choose |
|------|-----------------|
| **1. File** | The audio. `.wav`, `.mp3`, `.flac`, `.ogg`, `.m4a`, `.aac`, `.aiff`, plus the audio track of `.mp4`, `.mkv`, `.webm` |
| **2. Engine** | *Automatic* picks the best installed engine for the file; pick one by hand to override |
| **3. Quality** | Fast / Balanced / Maximum — how hard the engine looks, and how long it takes |
| **Options** | Preserve dynamics, preserve pitch bends, detect tempo changes, detect drums, detect instruments |

Options the chosen engine cannot honour are **greyed out with the reason**. Basic Pitch hears several notes at once but does not separate instruments and does not find drums, so those options are disabled for it rather than offered and quietly ignored.

Progress runs through five stages — preparing audio, transcribing, cleaning notes, generating MIDI, adding to library — and **Cancel** really stops it: the engine process is killed and nothing is left behind.

The result screen shows what was detected, with what confidence, and hands the file back to the rest of GMB: **Open MIDI editor**, **Use file**, or **New conversion**.

## Presets — How Much Tidying

The preset decides how much the raw engine output is cleaned up before it becomes MIDI. It is set in `config.json` (`transcription.postProcessingPreset`), `balanced` by default.

| Preset | What it does | Use it when |
|--------|--------------|-------------|
| **Raw** | Nothing. The engine's output as-is, warts included | You want to see exactly what the engine heard |
| **Balanced** | Drops very short notes and duplicates, repairs overlaps, removes pitch wobble below the engine's own resolution | Most material — the default |
| **Clean** | All of the above, plus a confidence filter, merging of note fragments, and velocity normalisation | Repeated notes, noisy recordings, anything Balanced leaves ragged |

**If the result has far more notes than the music does, try Clean.** See [Repeated notes](#repeated-notes) below.

## What to Expect

Measured against synthetic signals whose notes are known exactly:

- **Pitch and timing are reliable.** An eight-note scale comes back as exactly those eight pitches, with onsets and durations within 10 ms. A held triad comes back with its three notes and the right polyphony.
- **The instrument is not identified.** Basic Pitch does not know what it is listening to, so no GM program is written. Auto-assignment notices this and matches on note range and polyphony instead of guessing a family — which is what you want. Set the instrument yourself in the MIDI editor if it matters.
- **Tempo is not detected** either; the file is written at 120 BPM with no tempo map.

### Repeated notes

The engine does not always hear a repeated note as a new note. Six notes on the same pitch, 300 ms each, come back as one unbroken stream of fragments until the silence between them reaches about **180 ms** — eleven Note Ons for six notes, or for a single sustained note. No quality setting changes this.

That matters more here than in a sequencer: a Note On is a hammer, a solenoid or a bow change at the other end. When it happens the result screen says so, and points at the preset that recovers it — **Clean reconstructs 6 notes out of 6 from about 80 ms of silence upward**.

### Pitch bend

Basic Pitch estimates pitch in steps of a third of a semitone, and on a perfectly in-tune note it reports one step sharp — so left alone, every transcription plays 33 cents high on any instrument that honours pitch bend. Balanced and Clean remove any bend that never leaves that resolution, while keeping real vibrato and slides in full. Raw keeps everything, detune included.

## Where the File Goes

The transcription ends where the normal MIDI pipeline begins. Once a Standard MIDI File exists it goes through the same upload path as any other file — same hashing, same storage, same analysis, same database rows. There is no second library and no parallel storage. It is named `<original name> [Transcribed].mid`.

The source audio is **not** kept by default (`transcription.keepOriginalAudio`).

## Limits and Guards

| Guard | Default | Setting |
|-------|---------|---------|
| File size | 100 MB | `transcription.maxAudioFileBytes` |
| Duration | 10 minutes | `transcription.maxAudioDurationSeconds` |
| Jobs at once | 1 | `transcription.maxParallelJobs` |
| Job timeout | 15 minutes | `transcription.jobTimeoutMs` |
| Scratch space | 2 GB | `transcription.maxTempDiskBytes` |

One job at a time is deliberate on a Pi. Past the duration or size limit the job is refused with a message that names the limit, not a generic error.

On a Pi, note that once the engine has finished, GMB post-processes and encodes the notes on its main thread: roughly half a second for a ten-minute file, during which MIDI playback hitches once. It is a single, bounded pause at the end of a job.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| The drop zone only mentions MIDI | No engine ready on this server | Settings → *Audio → MIDI engines* → Install |
| `FFMPEG_MISSING` | An installation that predates it, or a manual setup | Re-run `./scripts/Install.sh` |
| "This engine needs Python 3.9 – 3.11" | The interpreter has no TensorFlow wheel | Install a supported Python and make it `python3` |
| Install fails on a TLS or DNS error | `pip` cannot reach PyPI | Export the proxy/CA variables to the GMB process, not only to your shell |
| `OUT_OF_MEMORY` | The board is too small | Shorter file, Fast quality, or a bigger Pi |
| `AUDIO_TOO_LONG` / `FILE_TOO_LARGE` | Resource guards | Raise the setting, knowing what it costs |
| The job never leaves *queued* | Another conversion is running | One at a time by design |
| Far more notes than the music has | The engine split sustained or repeated notes | Use the Clean preset |

See also: [[Interface-Settings]] · [[Interface-Main-Page]] · [[MIDI-Editor]] · [[Auto-Assignment]] · [[Troubleshooting]]
