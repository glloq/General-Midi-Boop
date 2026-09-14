# Python runners

One directory per engine, each holding the CLI runner Node spawns and the
pinned requirements that define its environment.

Nothing here is imported by Node: the boundary is a subprocess speaking JSON
Lines on stdout (protocol version in both the runner and its backend — bump
them together). That keeps Python out of the Node process entirely, so a
model that segfaults takes its own subprocess down and nothing else.

| Engine | Runner | Environment |
| --- | --- | --- |
| Basic Pitch | `basic-pitch/runner.py` | `data/transcription/venvs/basic-pitch/` |

Rules:

- **Never install into the system Python.** Every engine gets its own venv
  under `data/transcription/venvs/`, which is outside the repository and
  disposable.
- **Pin every version** (`requirements.txt`). An engine whose version drifts
  produces different transcriptions from the same audio.
- **Print only JSON Lines on stdout.** Anything human-readable goes to
  stderr; Node ignores lines that are not JSON, but the payload must be
  machine-readable.
- **Keep the runner thin.** Mapping an engine's output onto GMB's
  intermediate representation happens in JavaScript, where it is unit-tested
  without Python.
