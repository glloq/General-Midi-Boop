# Changelog

All notable changes to Général Midi Boop are documented in this file.

## [Unreleased]

### Added — Hand-position control (Phase 1: keyboards)

- New per-instrument `hands_config` (optional JSON column on
  `instruments_latency`) that describes each hand's physical constraints
  and the CC number to control its position. Absence = feature disabled;
  byte-identical behavior for every existing instrument.
- `HandAssigner` tags each note with `left` / `right` using either an
  explicit track→hand map, a pitch split (with hysteresis to avoid
  chattering around the split note), or an `auto` mode that promotes to
  track-based when the source MIDI has multiple tracks and falls back to
  pitch split otherwise. Warnings are surfaced for ambiguous cases.
- `HandPositionPlanner` emits CC events (e.g. CC23 for left, CC24 for
  right) whose value is the MIDI note of the lowest note of the current
  hand window. CCs are scheduled as early as possible — right after the
  last note-on of the previous window — so the mechanical hand has the
  maximum travel time.
- Feasibility report (non-blocking): `move_too_fast`,
  `overpolyphony_hand`, `finger_interval_violated`, `out_of_range`,
  `chord_span_exceeded`, plus assignment warnings. Broadcast over the
  WebSocket as `playback_hand_position_warnings` for the UI to display.
- Migration `004_instrument_hands_config.sql`.
- "Mains" section in the instrument settings modal, visible only for
  keyboard-family instruments (Phase 2 will unify string instruments).

## [0.7.0] - 2026-04-18

### Changed — Project rebrand
- **Renamed** project from `Ma-est-tro` / `MidiMind` to **Général Midi Boop**.
- **[breaking]** npm package `midimind` → `gmboop`.
- **[breaking]** Environment variables: `MAESTRO_*` → `GMBOOP_*`
  (`GMBOOP_SERVER_PORT`, `GMBOOP_DATABASE_PATH`, `GMBOOP_LOG_LEVEL`,
  `GMBOOP_BLE_ENABLED`, `GMBOOP_SERIAL_ENABLED`, `GMBOOP_API_TOKEN`, etc.).
- **[breaking]** localStorage keys: `maestro_settings` → `gmboop_settings`,
  `maestro_filter_sections` → `gmboop_filter_sections`,
  `maestro_locale` → `gmboop_locale`,
  `midimind_update_completed` → `gmboop_update_completed`.
- **[breaking]** Prometheus metrics: `maestro_*` → `gmboop_*`
  (`gmboop_uptime_seconds`, `gmboop_websocket_clients`,
  `gmboop_memory_heap_used_bytes`, `gmboop_memory_rss_bytes`, `gmboop_info`).
- **[breaking]** Default runtime paths: `data/midimind.db` → `data/gmboop.db`,
  `logs/midimind.log` → `logs/gmboop.log`.
- **[breaking]** systemd unit `midimind.service` → `gmboop.service`;
  PM2 app name `midimind` → `gmboop`.
- **[breaking]** Docker service `maestro` → `gmboop`, volumes `maestro-*` → `gmboop-*`.
- **[breaking]** MQTT default topics: `wled/maestro` → `wled/gmboop`,
  `maestro/light` → `gmboop/light`.
- **[breaking]** RTP-MIDI / network manufacturer label: `MidiMind` →
  `GeneralMidiBoop`; SysEx manufacturer label `MidiMind Manufacturer` →
  `GMB Manufacturer` (binary ID `0x00` unchanged — hardware compatibility
  preserved).
- **[breaking]** GitHub repository: `glloq/Ma-est-tro` → `glloq/General-Midi-Boop`.

### Added
- `scripts/rename-project.js` — automated rebrand tool (one-shot).
- `scripts/migrate-from-v5.sh` — helper for v5.x deployments: stops legacy
  PM2/systemd services, rewrites `.env` prefixes, renames runtime artifacts.
- `public/js/migrateLegacy.js` — one-shot frontend migration copying
  `maestro_*` / `midimind_*` localStorage values into `gmboop_*` keys on
  first boot; scheduled for removal in 0.8.0.
- `Application#_migrateLegacyArtifacts()` — one-shot backend step that
  renames `data/midimind.db` and `logs/midimind.log` to their `gmboop.*`
  equivalents on first boot; scheduled for removal in 0.8.0.

### Migration guide
Existing v5.x operators should:
1. `bash scripts/migrate-from-v5.sh` (stops legacy service, rewrites `.env`).
2. `npm install` (regenerates `package-lock.json` under the new name).
3. `scripts/Install.sh` to register the new `gmboop.service` / PM2 app.
4. Old Prometheus dashboards querying `maestro_*` need to be updated to
   `gmboop_*` — no transitional alias is exported (clean-rename policy).

## Previous history (as Ma-est-tro / MidiMind)

## [Unreleased]

### Added (v6 storage refactor)
- **`migrations/001_baseline.sql`** — single consolidated baseline schema
  (20 tables, 47 indexes, 14 declared FKs) replacing the 34 incremental
  migrations 001..040. Fresh installs only.
- **`src/files/BlobStore.js`** — content-addressable filesystem storage
  for MIDI bytes under `data/midi/<sha256[0..1]>/<sha256>.mid`. Atomic
  writes via tmp+rename, free deduplication on identical content,
  `gcOrphans` helper, no SQLite BLOB pressure on the WAL.
- **`src/files/UploadQueue.js`** — in-process FIFO queue (concurrency 1)
  for upload post-processing, with optional `onProgress` callback used
  to broadcast `file_upload_progress` over WebSocket.
- **`POST /api/files`** + **`GET /api/files/:id/blob`** — HTTP upload /
  download endpoints replacing the WS `file_upload` command.
- `midi_files.content_hash` (UNIQUE, SHA-256), `blob_path`,
  `midi_file_tempo_map` table for persisted tempo-map cache.
- BackupScheduler now writes a `*.manifest.json` sidecar listing every
  blob and whether it exists on disk — restore operators can identify
  which MIDI files lost their bytes.
- Same-origin auth bypass on `/api/*` for the SPA (mirrors the WS
  `verifyClient` rule).
- `tests/helpers/createTestFile.js` — shared fixture builder for the
  v6 `midi_files` shape.

### Changed (v6 storage refactor)
- **WS `file_upload` removed.** SPA now POSTs raw bytes to `/api/files`.
- `file_export` returns `{url, contentHash, ...}` instead of an inline
  base64 payload.
- `file_read` no longer ships the full `convertMidiToJSON` over the WS;
  the editor is expected to fetch bytes via `GET /api/files/:id/blob`.
- WS `MAX_PAYLOAD_BYTES` lowered from 16 MB to 1 MB now that binary
  uploads go through HTTP.
- `AnalysisCache` rewritten to a size-bounded LRU (default 32 MB / 500
  entries) with EventBus-driven invalidation on `file_write` /
  `file_delete` / `file_uploaded`. The 10-min TTL eviction is gone.
- `MidiPlayer.loadFile` reads bytes via `BlobStore.read(blob_path)`
  instead of the legacy `file.data` BLOB / base64 path.
- `LatencyCompensator` persistence quarantined: `loadProfilesFromDB`,
  `setLatency` save, and `deleteProfile` save are now no-ops with
  `@deprecated` notes. Profiles live in memory only until a real
  `instruments_latency`-backed read/write path is wired.

### Removed (v6 storage refactor)
- 34 legacy migrations (`001_initial.sql` .. `040_drop_adaptation_metadata.sql`).
- Phantom tables: `instruments` (CRUD methods deleted), `instrument_latency`
  (singular, latency-profile methods deleted), `files` (legacy duplicate
  of `midi_files`); unused calibration views (`active_instruments`,
  `instruments_needing_calibration`, `calibration_stats`).
- `midi_history` table (moved to `data/logs/midi_history.jsonl`).
- Columns dropped: `midi_files.data` (base64), `midi_files.data_blob`
  (BLOB), `midi_files.midi_json`, `midi_files.metadata`,
  `midi_files.duration_ms`, `midi_files.adaptation_metadata`,
  `instruments_latency.compensation_offset` (deprecated µs offset).
- `scripts/rollback-db.js` + `migrate:rollback` npm script (no longer
  applicable to a single-baseline workflow).
- Frontend orphan helpers `arrayBufferToBase64` / `base64ToArrayBuffer`.

### Fixed (v6 storage refactor)
- `PlaybackAssignmentCommands`, `PlaybackRoutingCommands`,
  `PlaybackAnalysisCommands` no longer crash on missing `file.data`;
  they read via `app.blobStore.read(file.blob_path)`.
- Preset CRUD targets the actual `presets.category` column (was using
  the non-existent `type` column); the `type` API field is preserved
  for the SPA via mapping in `InstrumentDatabase.insertPreset` /
  `updatePreset`.
- Two test suites realigned with the v6 schema
  (`tests/repositories/routing-integration.test.js`,
  `tests/midi-filter.test.js`).

### Fixed (post-v6 audit)
- **`routes` table aligned with the runtime model.** The baseline had
  `from_device/to_device/from_channel/to_channel` (INTEGER PK) but
  every caller wrote `source_device/destination_device/channel_mapping/
  filter` (TEXT PK). All CRUD on static device routes was crashing on
  unknown columns; column shape now matches MidiRouter.addRoute.
- **`midi_instrument_routings.target_channel` added** as a typed
  INTEGER column (CHECK 0..15). Replaces the dead `track_id` reference
  that RoutingPersistenceDB still wrote to.
- **`instruments_latency.gm_program` and `polyphony` columns added**;
  every InstrumentSettings/InstrumentCapabilities save was crashing on
  unknown columns.
- **`InstrumentRepository.findById` / `update` restored** (regression
  introduced by the dead-code cleanup commit), branched at
  `instruments_latency` rather than the phantom `instruments` table.
  Unblocks `PlaybackAssignmentCommands.{getInstrumentDefaults,
  updateInstrumentCapabilities}`.
- **LatencyCompensator persistence wired to `instruments_latency`.**
  Profiles are now stored on each device's channel-0 row
  (`sync_delay`, `avg_latency`, `min_latency`, `max_latency`,
  `measurement_count`, `last_calibration`) and reloaded at every boot.
  The v6 quarantine is over.
- **5 missing WS event listeners wired in `index.html`**:
  `file_list_updated` / `file_uploaded` / `file_delete` / `file_write`
  refresh the file library across tabs, `file_upload_progress` logs
  big-file stages, `latency_calibration_complete` surfaces calibration
  outcomes.

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
- Optional token authentication for HTTP and WebSocket (`GMBOOP_API_TOKEN`)
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
