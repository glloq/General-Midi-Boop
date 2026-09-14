#!/usr/bin/env python3
"""Basic Pitch runner for Général Midi Boop.

Node spawns this script inside an isolated virtual environment and reads
JSON Lines from stdout (protocol v1, see BasicPitchBackend.js):

    {"type":"progress","stage":"loading","progress":0.05}
    {"type":"progress","stage":"transcribing","progress":0.42}
    {"type":"complete","output":"/path/result.json"}

stderr carries diagnostics only — never the payload.

Two modes:

    runner.py --self-check
        Print one JSON object describing the environment and exit 0. Used by
        the availability probe; it must not need audio, a model download or
        a network connection beyond what the package already cached.

    runner.py --input AUDIO --output RESULT.json --options OPTIONS.json
        Transcribe and write the result. Options come through a FILE so no
        user-influenced value ever reaches argv.

The output format is deliberately flat and engine-specific; mapping it onto
GMB's rich intermediate representation is Node's job (normalizeRunnerOutput),
so this file stays a thin, replaceable adapter.
"""

import argparse
import json
import math
import sys
import traceback

PROTOCOL_VERSION = 1


def emit(payload):
    """Print one JSON Lines frame on stdout and flush it immediately."""
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def progress(stage, value=None):
    """Report a stage, with a fraction when one is actually known."""
    emit({"type": "progress", "stage": stage, "progress": value})


def package_version():
    """The installed basic-pitch version, however it can be found.

    The package exposes no `__version__` attribute, so reading one always
    answered "unknown" and the engine's version was never shown anywhere.
    The distribution metadata is the reliable source; the attribute is kept
    as a fallback in case a future release adds one.
    """
    try:
        from importlib.metadata import version

        return version("basic-pitch")
    except Exception:  # noqa: BLE001 - a missing version is not a failure
        try:
            import basic_pitch

            return getattr(basic_pitch, "__version__", "unknown")
        except Exception:  # noqa: BLE001
            return "unknown"


def self_check():
    """Describe the environment: version, model presence, protocol."""
    report = {"protocolVersion": PROTOCOL_VERSION, "ok": False}
    try:
        import basic_pitch  # noqa: F401
        from basic_pitch import ICASSP_2022_MODEL_PATH  # noqa: F401

        report["version"] = package_version()
        report["modelVersion"] = "ICASSP_2022"
        report["ok"] = True
    except Exception as exc:  # noqa: BLE001 - any import failure is an answer
        report["error"] = f"{type(exc).__name__}: {exc}"
    emit(report)
    return 0


def velocity_from_amplitude(amplitude):
    """Map Basic Pitch's 0..1 amplitude onto a MIDI velocity (1..127).

    A linear map crushes quiet notes into inaudibility, so the curve is
    slightly expanded; the floor of 1 matters because velocity 0 is a Note
    Off in MIDI, not a silent note.
    """
    if amplitude is None or not math.isfinite(amplitude):
        return 64
    scaled = max(0.0, min(1.0, float(amplitude))) ** 0.6
    return max(1, min(127, int(round(20 + scaled * 107))))


def transcribe(input_path, output_path, options):
    """Run the model and write the flat result document."""
    progress("loading", 0.02)

    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH

    progress("transcribing", 0.10)

    # `predict` returns (model_output, midi_data, note_events). Only the note
    # events are used: the MIDI object it builds is thrown away on purpose —
    # GMB does its own post-processing, channel allocation and encoding.
    _model_output, _midi_data, note_events = predict(
        input_path,
        ICASSP_2022_MODEL_PATH,
        onset_threshold=options.get("onsetThreshold", 0.5),
        frame_threshold=options.get("frameThreshold", 0.3),
        minimum_note_length=options.get("minNoteLengthMs", 58),
        melodia_trick=True,
        multiple_pitch_bends=bool(options.get("includePitchBends", True)),
    )

    progress("collecting", 0.85)

    notes = []
    duration = 0.0
    for event in note_events:
        # (start, end, pitch, amplitude, pitch_bends) — pitch_bends may be None.
        start, end, pitch, amplitude = event[0], event[1], event[2], event[3]
        bends = event[4] if len(event) > 4 else None

        if not (math.isfinite(start) and math.isfinite(end)) or end <= start:
            continue
        duration = max(duration, float(end))

        note = {
            "start": float(start),
            "end": float(end),
            "pitch": int(pitch),
            "velocity": velocity_from_amplitude(amplitude),
            "confidence": round(float(amplitude), 4) if amplitude is not None else None,
        }
        if bends:
            # Basic Pitch reports bends in bins of 1/3 semitone.
            note["pitchBends"] = [round(float(b) / 3.0, 4) for b in bends]
        notes.append(note)

    notes.sort(key=lambda n: (n["start"], n["pitch"]))

    document = {
        "protocolVersion": PROTOCOL_VERSION,
        "notes": notes,
        "duration": duration,
        "sampleRate": options.get("sampleRate", 22050),
        "warnings": [] if notes else ["The engine detected no notes in this audio"],
    }

    progress("writing", 0.95)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, separators=(",", ":"))

    emit({"type": "complete", "output": output_path, "notes": len(notes)})
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description="Basic Pitch runner for Général Midi Boop")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--options")
    args = parser.parse_args(argv)

    if args.self_check:
        return self_check()

    if not args.input or not args.output:
        emit({"type": "error", "error": "--input and --output are required"})
        return 2

    options = {}
    if args.options:
        try:
            with open(args.options, "r", encoding="utf-8") as handle:
                options = json.load(handle)
        except Exception as exc:  # noqa: BLE001
            emit({"type": "error", "error": f"unreadable options file: {exc}"})
            return 2
        if options.get("protocolVersion") != PROTOCOL_VERSION:
            emit({"type": "error", "error": "protocol version mismatch"})
            return 3

    try:
        return transcribe(args.input, args.output, options)
    except MemoryError:
        # Named explicitly: this is the failure a Raspberry Pi actually hits,
        # and Node turns it into a message about file length, not a crash.
        emit({"type": "error", "error": "MemoryError"})
        print("MemoryError while transcribing", file=sys.stderr)
        return 4
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
