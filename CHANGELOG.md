# Changelog

All notable changes to Ma-est-tro are documented in this file.

## [Unreleased]

### Added
- `docs/MIDI_EDITOR.md` — technical documentation for the MIDI editor modal
  (architecture, module map, public API, state model, load/save data flow,
  MIDI value validation, keyboard shortcuts, event bus contract, extension
  points, logging convention, known limitations).
- Expanded README "MIDI Editor" section with feature table, CC list,
  keyboard shortcuts, and preferences reference.
- Cross-links from `docs/ARCHITECTURE.md` to the new editor documentation.
- `tests/frontend/midi-editor-clamp.test.js` — 10 Vitest cases that pin the
  save-time MIDI clamping contract (note/channel/velocity/CC/pitch-bend
  ranges, tempo-map emission, drum-channel programChange skip).
- `common.on` / `common.off` translation keys across the 28 locale files, so
  the touch-mode / keyboard-playback / drag-playback toggle labels can be
  localised.

### Changed
- Migration 040 drops the unused `adaptation_metadata` column on `midi_files`
  (the JSON it carried was never read; the per-channel transposition data it
  duplicated is already stored on `midi_instrument_routings`).
- MIDI editor toggle labels (Touch mode, Keyboard playback, Drag playback)
  now go through `this.t('common.on') / this.t('common.off')` instead of the
  hard-coded English literals `'ON'` / `'OFF'`.
- File headers and inline comments across the MIDI editor modules
  (`public/js/views/components/MidiEditorModal.js` and the 19 files in
  `public/js/views/components/midi-editor/`) were translated from French to
  English, including JSDoc blocks, section separators, and HTML comments in
  template literals. About 300 comment lines touched; no executable code
  altered.

### Fixed
- Clamp out-of-range MIDI values in `convertSequenceToMidi` (note 0–127,
  channel 0–15, velocity 1–127, CC 0–127, pitch bend −8192…8191) so a corrupt
  in-memory sequence can no longer silently produce an invalid `.mid`.
- `file_routing_sync` now skips routings targeting channels absent from
  `midi_file_channels`, preventing orphan routings after a file edit that
  removed a channel.
- Deterministic tempo event ids (`tempo_<ticks>_<index>`) replace the previous
  `Date.now() + Math.random()` scheme so external references survive a reload.

### Removed
- Dead `MidiEditorState.js` (441 l.) and `MidiEditorFileOps.js` (798 l.)
  classes (loaded but never instantiated; their methods had been
  re-implemented as mixins).
- Orphan `copySequence` on `MidiEditorModal`, unused
  `_autoActivateTablature` stub, and redundant `localStorage` preference
  helpers (folded into `_getPreference` / `_setPreference`).
- File operations (`saveMidiFile`, `saveAsFile`, `showSaveAsDialog`,
  `showRenameDialog`, `convertSequenceToMidi`, …) moved out of
  `MidiEditorCCPicker.js` into a dedicated `MidiEditorFileOpsMixin.js`.
- `MidiTransposer.generateAdaptationMetadata()` (unused after migration 040).
- Deprecated CC wrapper methods `updateCCChannelSelector` and
  `attachCCChannelListeners` (both the mixin copies in `MidiEditorCC.js`
  and the class copies in `MidiEditorCCPanel.js`); callers now use
  `updateEditorChannelSelector` / `attachEditorChannelListeners` directly.
- Redundant API commands `file_load` and `file_save` (never called by any
  client; superseded by `file_read` / `file_write` which carry the same
  semantics with an explicit `midiData` payload). Handlers, registry
  entries, validators, and the corresponding rows in `docs/API.md` were
  all removed.

## [5.0.0] - 2026-03-24

### Added
- ESLint configuration with backend/frontend/test overrides
- Prettier and EditorConfig for consistent formatting
- Husky + lint-staged pre-commit hooks
- GitHub Actions CI workflow (lint + test + coverage)
- Environment variable overrides in Config.js (dotenv support)
- `.env.example` template with all supported variables
- Optional token authentication for HTTP and WebSocket (`MAESTRO_API_TOKEN`)
- Helmet.js security headers
- Log file rotation (10 MB max, 5 rotated files)
- Structured JSON logging format option (`logging.jsonFormat`)
- Test coverage reporting (`npm run test:coverage`)
- Unit tests for ServiceContainer, EventBus, Config, Logger, dbHelpers, errors (68 new tests)
- Dockerfile and docker-compose.yml for containerization
- Automated database backup scheduler (daily, 7-day retention)
- Structured error hierarchy (ApplicationError, ValidationError, NotFoundError, etc.)
- `buildDynamicUpdate` helper to reduce DRY violations in database code
- Prometheus-compatible `/api/metrics` endpoint
- Down migration support with `npm run migrate:rollback`
- Architecture overview document (ARCHITECTURE.md)
- API reference document (docs/API.md) covering 146 commands
- Contributing guide (CONTRIBUTING.md)

### Fixed
- `device` variable scoping bug in BluetoothManager.js catch block

### Security
- npm audit fix for ajv and flatted vulnerabilities
