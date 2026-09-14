# Transcription backends

Concrete transcription engines live here, one file per engine. The directory
is scanned at boot by
[`TranscriptionBackendRegistry.loadBuiltinBackends()`](../TranscriptionBackendRegistry.js)
— there is no registration list to edit.

A module must export **either** a factory or a default class:

```js
export function createBackend(deps) {
  return new MyBackend(deps);
}
// or
export default class MyBackend extends TranscriptionBackend { … }
```

and implement the contract in
[`TranscriptionBackend`](../TranscriptionBackend.js):

| Method | Required | Notes |
| --- | --- | --- |
| `getMetadata()` | yes | Cheap, side-effect free. Validated at registration. |
| `checkAvailability()` | yes | Must never throw; answer `broken` instead. |
| `transcribe(inputPath, options, context)` | yes | Honour `context.signal`. |
| `supportsInstall()` / `install()` / `uninstall()` | no | PR 11. |
| `destroy()` | no | Release warm processes / caches. |

Rules that are not negotiable:

- **Nothing is bundled.** No model weights in this repository. Weights are
  downloaded on explicit user action, into `data/transcription/models/`.
- **Licensing is declared, code and model separately** (`metadata.licensing`).
  When the model licence restricts commercial use or redistribution,
  `commercialUse` / `redistribution` stay `false` and `requiresConsent` is
  `true`; the UI shows the notice before anything is installed.
- **A missing runtime is not an error.** No Python, no FFmpeg, no model ⇒ the
  backend reports `not_installed` / `unsupported_platform` and GMB carries on.
- **Never decode user audio here.** The preprocessor hands over a file already
  converted to `metadata.audioFormat`.
- **Declare only what you do.** A backend without drum detection leaves
  `capabilities.drums` false rather than guessing percussion.

The first engine (Basic Pitch, positioned as *solo / lightweight
polyphonic* transcription) lands in PR 7.
