-- ============================================================================
-- File: migrations/024_string_instruments.sql
-- Description: Dedicated table for string instrument configuration
--              Stores tuning, number of strings/frets, and fretless flag
--              Used by the tablature editor and CC20/CC21 generation
-- ============================================================================

CREATE TABLE IF NOT EXISTS string_instruments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    instrument_name TEXT NOT NULL DEFAULT 'Guitar',
    num_strings INTEGER NOT NULL DEFAULT 6
        CHECK(num_strings >= 1 AND num_strings <= 6),
    num_frets INTEGER NOT NULL DEFAULT 24
        CHECK(num_frets >= 0 AND num_frets <= 36),
    tuning TEXT NOT NULL DEFAULT '[40,45,50,55,59,64]'
        CHECK(json_valid(tuning)),
    is_fretless INTEGER NOT NULL DEFAULT 0,
    capo_fret INTEGER NOT NULL DEFAULT 0
        CHECK(capo_fret >= 0 AND capo_fret <= 36),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(device_id, channel)
);

-- Index for fast lookup by device + channel
CREATE INDEX IF NOT EXISTS idx_string_instruments_device_channel
    ON string_instruments(device_id, channel);

-- Auto-update timestamp trigger
CREATE TRIGGER IF NOT EXISTS string_instruments_updated_at
AFTER UPDATE ON string_instruments
BEGIN
    UPDATE string_instruments SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- TABLE: string_instrument_tablatures
-- Description: Stores tablature data per MIDI file + channel
--              Each entry is a JSON array of tab events
-- ============================================================================

CREATE TABLE IF NOT EXISTS string_instrument_tablatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    midi_file_id INTEGER NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    string_instrument_id INTEGER NOT NULL,
    tablature_data TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(tablature_data)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(midi_file_id, channel),
    FOREIGN KEY (string_instrument_id) REFERENCES string_instruments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tablatures_file_channel
    ON string_instrument_tablatures(midi_file_id, channel);

CREATE TRIGGER IF NOT EXISTS tablatures_updated_at
AFTER UPDATE ON string_instrument_tablatures
BEGIN
    UPDATE string_instrument_tablatures SET updated_at = datetime('now') WHERE id = NEW.id;
END;
