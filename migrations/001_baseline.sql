-- ============================================================================
-- Ma-est-tro consolidated baseline schema
-- Version: 6.0.0 (fresh-install baseline)
-- ============================================================================
--
-- Replaces legacy migrations 001..040 with a single, clean schema:
--   - midi_files: content-addressable (sha256), no base64/BLOB column (blob
--     stored on filesystem under data/midi/<hash[0..1]>/<hash>.mid)
--   - midi_file_channels: per-channel analysis cache
--   - midi_file_tempo_map: persisted tempo map (skips re-parse on seek)
--   - midi_instrument_routings: channel-based with split-mode support
--   - instruments_latency: kept name, stripped deprecated columns (no
--     compensation_offset, no auto-sync trigger)
--   - FKs declared everywhere (PRAGMA foreign_keys=ON is enabled at connect)
--
-- Dropped from legacy:
--   - midi_history table (moved to data/logs/midi_history.jsonl)
--   - files table (legacy duplicate of midi_files)
--   - instrument_latency singular (dead duplicate from old mig 008)
--   - Views active_instruments, instruments_needing_calibration,
--     calibration_stats (unused)
--   - Trigger trg_instruments_latency_compensation (synced deprecated col)
--   - adaptation_metadata column on midi_files (already dropped mig 040)
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Migration tracking (unified single table)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- Settings (key-value)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY NOT NULL,
    value       TEXT NOT NULL DEFAULT '',
    type        TEXT NOT NULL DEFAULT 'string'
                CHECK(type IN ('string', 'int', 'float', 'bool', 'json', 'number')),
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);

CREATE TRIGGER IF NOT EXISTS trg_settings_update
AFTER UPDATE ON settings
BEGIN
    UPDATE settings SET updated_at = datetime('now') WHERE key = NEW.key;
END;

INSERT OR IGNORE INTO settings (key, value, type, description) VALUES
('api_port', '8080', 'int', 'WebSocket API server port'),
('log_level', 'INFO', 'string', 'Logging level (DEBUG, INFO, WARNING, ERROR)'),
('midi_clock_bpm', '120', 'int', 'MIDI clock BPM'),
('auto_save_enabled', 'true', 'bool', 'Auto-save configuration'),
('hot_plug_enabled', 'true', 'bool', 'Enable hot-plug device detection'),
('status_broadcast_interval', '5000', 'int', 'Status broadcast interval (ms)');

-- ----------------------------------------------------------------------------
-- Presets
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS presets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'routing'
                CHECK(category IN ('routing', 'processing', 'playback', 'system')),
    description TEXT,
    data        TEXT NOT NULL CHECK(json_valid(data)),
    tags        TEXT CHECK(tags IS NULL OR json_valid(tags)),
    is_favorite BOOLEAN DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_presets_name     ON presets(name);
CREATE INDEX IF NOT EXISTS idx_presets_category ON presets(category);
CREATE INDEX IF NOT EXISTS idx_presets_favorite ON presets(is_favorite);
CREATE INDEX IF NOT EXISTS idx_presets_updated  ON presets(updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_presets_update
AFTER UPDATE ON presets
BEGIN
    UPDATE presets SET updated_at = datetime('now') WHERE id = NEW.id;
END;

INSERT OR IGNORE INTO presets (name, category, description, data) VALUES
('Default Routing', 'routing', 'Default routing configuration',
 '{"routes": [], "channels": [], "filters": []}');

-- ----------------------------------------------------------------------------
-- Sessions
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    data        TEXT NOT NULL CHECK(json_valid(data)),
    duration    INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_name        ON sessions(name);
CREATE INDEX IF NOT EXISTS idx_sessions_last_opened ON sessions(last_opened DESC);

CREATE TRIGGER IF NOT EXISTS trg_sessions_update
AFTER UPDATE ON sessions
BEGIN
    UPDATE sessions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Devices (MIDI hardware + virtual endpoints)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS devices (
    id                  TEXT PRIMARY KEY NOT NULL,
    name                TEXT NOT NULL,
    type                TEXT NOT NULL CHECK(type IN ('input', 'output', 'virtual')),
    port_id             INTEGER,
    manufacturer        TEXT,
    version             TEXT,
    enabled             BOOLEAN DEFAULT 1,
    custom_name         TEXT,
    midi_clock_enabled  BOOLEAN DEFAULT 0,
    message_rate_limit  INTEGER DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_devices_type    ON devices(type);
CREATE INDEX IF NOT EXISTS idx_devices_enabled ON devices(enabled);

CREATE TRIGGER IF NOT EXISTS trg_devices_update
AFTER UPDATE ON devices
BEGIN
    UPDATE devices SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Static routes (input device -> output device, channel mapping)
-- ----------------------------------------------------------------------------

-- Routes carry runtime-generated string IDs (MidiRouter assigns them) and
-- store both a per-channel mapping (source channel → destination channel)
-- and an arbitrary filter object as JSON. Names match the runtime model
-- in `MidiRouter.addRoute` so persistence is a direct passthrough.
CREATE TABLE IF NOT EXISTS routes (
    id                  TEXT PRIMARY KEY NOT NULL,
    name                TEXT NOT NULL DEFAULT 'Route',
    source_device       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    destination_device  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    channel_mapping     TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(channel_mapping)),
    filter              TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(filter)),
    enabled             BOOLEAN DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routes_source       ON routes(source_device);
CREATE INDEX IF NOT EXISTS idx_routes_destination  ON routes(destination_device);
CREATE INDEX IF NOT EXISTS idx_routes_enabled      ON routes(enabled);

CREATE TRIGGER IF NOT EXISTS trg_routes_update
AFTER UPDATE ON routes
BEGIN
    UPDATE routes SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- midi_files: user library (content-addressable; blob on filesystem)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS midi_files (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identity
    content_hash     TEXT NOT NULL UNIQUE,            -- SHA-256 hex (64 chars)
    filename         TEXT NOT NULL,                   -- display only; not unique
    folder           TEXT NOT NULL DEFAULT '/',

    -- Blob location (relative to data dir); computed from content_hash
    blob_path        TEXT NOT NULL,
    size             INTEGER NOT NULL,                -- bytes

    -- Extracted metadata
    tracks           INTEGER NOT NULL DEFAULT 0,      -- SMF track count
    duration         REAL NOT NULL DEFAULT 0,         -- seconds
    tempo            REAL NOT NULL DEFAULT 120,       -- initial BPM
    ppq              INTEGER NOT NULL DEFAULT 480,

    -- Filter / search denormalisation
    channel_count    INTEGER NOT NULL DEFAULT 0,
    note_range_min   INTEGER CHECK(note_range_min IS NULL OR note_range_min BETWEEN 0 AND 127),
    note_range_max   INTEGER CHECK(note_range_max IS NULL OR note_range_max BETWEEN 0 AND 127),
    instrument_types TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(instrument_types)),
    has_drums        BOOLEAN NOT NULL DEFAULT 0,
    has_melody       BOOLEAN NOT NULL DEFAULT 0,
    has_bass         BOOLEAN NOT NULL DEFAULT 0,

    -- Derivation
    is_original      BOOLEAN NOT NULL DEFAULT 1,
    parent_file_id   INTEGER REFERENCES midi_files(id) ON DELETE CASCADE,

    -- Timestamps
    uploaded_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_midi_files_filename         ON midi_files(filename);
CREATE INDEX IF NOT EXISTS idx_midi_files_folder           ON midi_files(folder);
CREATE INDEX IF NOT EXISTS idx_midi_files_uploaded         ON midi_files(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_midi_files_parent           ON midi_files(parent_file_id);
CREATE INDEX IF NOT EXISTS idx_midi_files_is_original      ON midi_files(is_original);
CREATE INDEX IF NOT EXISTS idx_midi_files_channel_count    ON midi_files(channel_count);
CREATE INDEX IF NOT EXISTS idx_midi_files_duration_tempo   ON midi_files(duration, tempo);
CREATE INDEX IF NOT EXISTS idx_midi_files_folder_date      ON midi_files(folder, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_midi_files_has_drums        ON midi_files(has_drums);
CREATE INDEX IF NOT EXISTS idx_midi_files_has_melody       ON midi_files(has_melody);
CREATE INDEX IF NOT EXISTS idx_midi_files_has_bass         ON midi_files(has_bass);

CREATE TRIGGER IF NOT EXISTS trg_midi_files_update
AFTER UPDATE ON midi_files
BEGIN
    UPDATE midi_files SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- midi_file_channels: per-channel instrument analysis cache
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS midi_file_channels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    midi_file_id        INTEGER NOT NULL REFERENCES midi_files(id) ON DELETE CASCADE,
    channel             INTEGER NOT NULL CHECK(channel BETWEEN 0 AND 15),
    primary_program     INTEGER,
    gm_instrument_name  TEXT,
    gm_category         TEXT,
    estimated_type      TEXT,
    type_confidence     INTEGER DEFAULT 0,
    note_range_min      INTEGER,
    note_range_max      INTEGER,
    total_notes         INTEGER DEFAULT 0,
    polyphony_max       INTEGER DEFAULT 0,
    polyphony_avg       REAL DEFAULT 0,
    density             REAL DEFAULT 0,
    track_names         TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(track_names)),
    UNIQUE(midi_file_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_mfc_file        ON midi_file_channels(midi_file_id);
CREATE INDEX IF NOT EXISTS idx_mfc_program     ON midi_file_channels(primary_program);
CREATE INDEX IF NOT EXISTS idx_mfc_category    ON midi_file_channels(gm_category);
CREATE INDEX IF NOT EXISTS idx_mfc_instrument  ON midi_file_channels(gm_instrument_name);
CREATE INDEX IF NOT EXISTS idx_mfc_type        ON midi_file_channels(estimated_type);

-- ----------------------------------------------------------------------------
-- midi_file_tempo_map: persisted tempo map so seek/playback skips re-parse
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS midi_file_tempo_map (
    midi_file_id INTEGER NOT NULL REFERENCES midi_files(id) ON DELETE CASCADE,
    tick         INTEGER NOT NULL,
    bpm          REAL NOT NULL,
    PRIMARY KEY (midi_file_id, tick)
);

-- ----------------------------------------------------------------------------
-- midi_instrument_routings: channel-based with split-mode support
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS midi_instrument_routings (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    midi_file_id            INTEGER NOT NULL REFERENCES midi_files(id) ON DELETE CASCADE,
    channel                 INTEGER NOT NULL CHECK(channel BETWEEN 0 AND 15),
    -- Optional remap to a different channel on the destination device
    -- (used by playback to address e.g. drum channel 9 vs melody channel 0
    -- on a multi-timbral synth). Defaults to `channel` when NULL.
    target_channel          INTEGER CHECK(target_channel IS NULL OR target_channel BETWEEN 0 AND 15),
    device_id               TEXT REFERENCES devices(id) ON DELETE SET NULL,
    instrument_name         TEXT,
    enabled                 BOOLEAN NOT NULL DEFAULT 1,

    -- Auto-assignment metadata
    compatibility_score     REAL,
    transposition_applied   INTEGER DEFAULT 0,
    auto_assigned           BOOLEAN NOT NULL DEFAULT 0,
    assignment_reason       TEXT,
    note_remapping          TEXT CHECK(note_remapping IS NULL OR json_valid(note_remapping)),

    -- Split routing
    split_mode              TEXT CHECK(split_mode IS NULL OR split_mode IN ('range', 'polyphony', 'mixed')),
    split_note_min          INTEGER CHECK(split_note_min IS NULL OR split_note_min BETWEEN 0 AND 127),
    split_note_max          INTEGER CHECK(split_note_max IS NULL OR split_note_max BETWEEN 0 AND 127),
    split_polyphony_share   INTEGER CHECK(split_polyphony_share IS NULL OR split_polyphony_share > 0),

    -- Overlap / multi-instrument behaviour
    overlap_strategy        TEXT,
    behavior_mode           TEXT,

    created_at              INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- One routing per (file, channel) when no split
CREATE UNIQUE INDEX IF NOT EXISTS idx_midi_routings_file_channel_nosplit
    ON midi_instrument_routings(midi_file_id, channel)
    WHERE split_mode IS NULL;

-- Multiple routings per (file, channel) when split (disambiguated by note range)
CREATE UNIQUE INDEX IF NOT EXISTS idx_midi_routings_file_channel_split
    ON midi_instrument_routings(midi_file_id, channel, split_note_min)
    WHERE split_note_min IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_midi_routings_file ON midi_instrument_routings(midi_file_id);

-- ----------------------------------------------------------------------------
-- Playlists
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    loop        INTEGER NOT NULL DEFAULT 0,
    gap_seconds INTEGER NOT NULL DEFAULT 0,
    shuffle     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_playlists_updated ON playlists(updated_at DESC);

CREATE TABLE IF NOT EXISTS playlist_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    midi_id     INTEGER NOT NULL REFERENCES midi_files(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id, position);

-- ----------------------------------------------------------------------------
-- instruments_latency: per-channel instrument profile
-- (name kept for backward compatibility; `compensation_offset` dropped)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instruments_latency (
    id                       TEXT PRIMARY KEY NOT NULL,
    device_id                TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    channel                  INTEGER NOT NULL CHECK(channel BETWEEN 0 AND 15),

    -- Identity
    name                     TEXT NOT NULL DEFAULT 'Unnamed Instrument',
    custom_name              TEXT,
    instrument_type          TEXT DEFAULT 'unknown',
    instrument_subtype       TEXT,
    mac_address              TEXT,
    usb_serial_number        TEXT,

    -- Sync (ms; positive = delay, negative = advance). Replaces legacy
    -- compensation_offset (microseconds) entirely.
    sync_delay               INTEGER DEFAULT 0,

    -- Latency stats (microseconds, measurement only, not applied to scheduling)
    avg_latency              INTEGER DEFAULT 0 CHECK(avg_latency BETWEEN 0 AND 1000000),
    min_latency              INTEGER DEFAULT 0 CHECK(min_latency >= 0),
    max_latency              INTEGER DEFAULT 0 CHECK(max_latency >= 0),
    jitter                   REAL DEFAULT 0.0,
    std_deviation            REAL DEFAULT 0.0,
    measurement_count        INTEGER DEFAULT 0,
    measurement_history      TEXT CHECK(measurement_history IS NULL OR json_valid(measurement_history)),
    calibration_confidence   REAL DEFAULT 0.0 CHECK(calibration_confidence BETWEEN 0.0 AND 1.0),
    calibration_method       TEXT DEFAULT 'manual' CHECK(calibration_method IN ('manual', 'sysex')),
    last_calibration         TEXT,

    -- SysEx identity
    sysex_manufacturer_id    TEXT,
    sysex_family             TEXT,
    sysex_model              TEXT,
    sysex_version            TEXT,
    sysex_device_id          TEXT,
    sysex_raw_response       TEXT,
    sysex_last_request       TEXT,

    -- Capabilities
    note_range_min           INTEGER CHECK(note_range_min IS NULL OR note_range_min BETWEEN 0 AND 127),
    note_range_max           INTEGER CHECK(note_range_max IS NULL OR note_range_max BETWEEN 0 AND 127),
    supported_ccs            TEXT CHECK(supported_ccs IS NULL OR json_valid(supported_ccs)),
    note_selection_mode      TEXT DEFAULT 'range' CHECK(note_selection_mode IN ('range', 'discrete')),
    selected_notes           TEXT CHECK(selected_notes IS NULL OR json_valid(selected_notes)),
    capabilities_source      TEXT DEFAULT 'manual' CHECK(capabilities_source IN ('manual', 'sysex', 'auto')),
    capabilities_updated_at  TEXT,

    -- General MIDI program assignment + max polyphony hint, used by
    -- the auto-assignment scoring engine and the editor UI.
    gm_program               INTEGER,
    polyphony                INTEGER DEFAULT 16,

    -- Behaviour
    octave_mode              TEXT DEFAULT 'chromatic',
    comm_timeout             INTEGER DEFAULT 5000,
    midi_clock_enabled       BOOLEAN DEFAULT 0,
    min_note_interval        INTEGER,
    min_note_duration        INTEGER,

    enabled                  BOOLEAN NOT NULL DEFAULT 1,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_instruments_device            ON instruments_latency(device_id);
CREATE INDEX IF NOT EXISTS idx_instruments_device_channel    ON instruments_latency(device_id, channel);
CREATE INDEX IF NOT EXISTS idx_instruments_channel           ON instruments_latency(channel);
CREATE INDEX IF NOT EXISTS idx_instruments_enabled           ON instruments_latency(enabled) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_instruments_confidence        ON instruments_latency(calibration_confidence DESC);
CREATE INDEX IF NOT EXISTS idx_instruments_last_calibration  ON instruments_latency(last_calibration DESC);
CREATE INDEX IF NOT EXISTS idx_instruments_latency_mac       ON instruments_latency(mac_address);
CREATE INDEX IF NOT EXISTS idx_instruments_latency_usb_serial ON instruments_latency(usb_serial_number);
CREATE INDEX IF NOT EXISTS idx_instruments_type              ON instruments_latency(instrument_type);
CREATE INDEX IF NOT EXISTS idx_instruments_type_subtype      ON instruments_latency(instrument_type, instrument_subtype);

CREATE TRIGGER IF NOT EXISTS trg_instruments_latency_update
AFTER UPDATE ON instruments_latency
FOR EACH ROW
BEGIN
    UPDATE instruments_latency SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_instruments_latency_confidence
AFTER UPDATE OF measurement_count ON instruments_latency
FOR EACH ROW
WHEN NEW.measurement_count > OLD.measurement_count
BEGIN
    UPDATE instruments_latency
    SET calibration_confidence = CASE
        WHEN NEW.measurement_count * 0.05 > 1.0 THEN 1.0
        ELSE NEW.measurement_count * 0.05
    END
    WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- String instruments (tuning, frets, CC mapping)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS string_instruments (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id          TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    channel            INTEGER NOT NULL DEFAULT 0 CHECK(channel BETWEEN 0 AND 15),
    instrument_name    TEXT NOT NULL DEFAULT 'Guitar',
    num_strings        INTEGER NOT NULL DEFAULT 6 CHECK(num_strings BETWEEN 1 AND 12),
    num_frets          INTEGER NOT NULL DEFAULT 24 CHECK(num_frets BETWEEN 0 AND 36),
    tuning             TEXT NOT NULL DEFAULT '[40,45,50,55,59,64]' CHECK(json_valid(tuning)),
    is_fretless        INTEGER NOT NULL DEFAULT 0,
    capo_fret          INTEGER NOT NULL DEFAULT 0 CHECK(capo_fret BETWEEN 0 AND 36),
    cc_enabled         INTEGER NOT NULL DEFAULT 1,
    tab_algorithm      TEXT NOT NULL DEFAULT 'min_movement',
    cc_string_number   INTEGER NOT NULL DEFAULT 20,
    cc_string_min      INTEGER NOT NULL DEFAULT 1,
    cc_string_max      INTEGER NOT NULL DEFAULT 12,
    cc_string_offset   INTEGER NOT NULL DEFAULT 0,
    cc_fret_number     INTEGER NOT NULL DEFAULT 21,
    cc_fret_min        INTEGER NOT NULL DEFAULT 0,
    cc_fret_max        INTEGER NOT NULL DEFAULT 36,
    cc_fret_offset     INTEGER NOT NULL DEFAULT 0,
    frets_per_string   TEXT CHECK(frets_per_string IS NULL OR json_valid(frets_per_string)),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(device_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_string_instruments_device_channel
    ON string_instruments(device_id, channel);

CREATE TRIGGER IF NOT EXISTS string_instruments_updated_at
AFTER UPDATE ON string_instruments
BEGIN
    UPDATE string_instruments SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS string_instrument_tablatures (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    midi_file_id         INTEGER NOT NULL REFERENCES midi_files(id) ON DELETE CASCADE,
    channel              INTEGER NOT NULL DEFAULT 0 CHECK(channel BETWEEN 0 AND 15),
    string_instrument_id INTEGER NOT NULL REFERENCES string_instruments(id) ON DELETE CASCADE,
    tablature_data       TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tablature_data)),
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(midi_file_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_tablatures_file_channel
    ON string_instrument_tablatures(midi_file_id, channel);

CREATE TRIGGER IF NOT EXISTS tablatures_updated_at
AFTER UPDATE ON string_instrument_tablatures
BEGIN
    UPDATE string_instrument_tablatures SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Lighting system
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lighting_devices (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    type               TEXT NOT NULL DEFAULT 'gpio'
                       CHECK(type IN ('gpio', 'gpio_strip', 'serial', 'artnet', 'sacn', 'mqtt', 'http', 'osc', 'midi')),
    connection_config  TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(connection_config)),
    led_count          INTEGER NOT NULL DEFAULT 1,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS lighting_devices_updated_at
AFTER UPDATE ON lighting_devices
BEGIN
    UPDATE lighting_devices SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS lighting_rules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL DEFAULT '',
    device_id        INTEGER NOT NULL REFERENCES lighting_devices(id) ON DELETE CASCADE,
    instrument_id    TEXT,
    priority         INTEGER NOT NULL DEFAULT 0,
    enabled          INTEGER NOT NULL DEFAULT 1,
    condition_config TEXT NOT NULL CHECK(json_valid(condition_config)),
    action_config    TEXT NOT NULL CHECK(json_valid(action_config)),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lighting_rules_device     ON lighting_rules(device_id);
CREATE INDEX IF NOT EXISTS idx_lighting_rules_instrument ON lighting_rules(instrument_id);

CREATE TRIGGER IF NOT EXISTS lighting_rules_updated_at
AFTER UPDATE ON lighting_rules
BEGIN
    UPDATE lighting_rules SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS lighting_presets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    rules_snapshot TEXT NOT NULL CHECK(json_valid(rules_snapshot)),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lighting_effects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    effect_type TEXT NOT NULL CHECK(effect_type IN ('strobe', 'rainbow', 'chase', 'fire', 'breathe', 'sparkle', 'color_cycle', 'wave')),
    config      TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config)),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lighting_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    device_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(device_ids)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- Register baseline
-- ----------------------------------------------------------------------------

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (1, 'Baseline schema v6.0 (consolidates legacy migrations 001-040)');
