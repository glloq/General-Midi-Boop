-- ============================================================================
-- File: migrations/025_string_instruments_max_strings.sql
-- Description: Extend num_strings limit from 6 to 12 to support instruments
--              like 12-string guitar, harp guitar, Chapman stick, etc.
--              SQLite requires table recreation to modify CHECK constraints.
-- ============================================================================

-- Recreate string_instruments with updated CHECK constraint
CREATE TABLE IF NOT EXISTS string_instruments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    instrument_name TEXT NOT NULL DEFAULT 'Guitar',
    num_strings INTEGER NOT NULL DEFAULT 6
        CHECK(num_strings >= 1 AND num_strings <= 12),
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

-- Copy existing data
INSERT OR IGNORE INTO string_instruments_new
    SELECT * FROM string_instruments;

-- Drop old table and rename
DROP TABLE IF EXISTS string_instruments;
ALTER TABLE string_instruments_new RENAME TO string_instruments;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_string_instruments_device_channel
    ON string_instruments(device_id, channel);

-- Recreate trigger
DROP TRIGGER IF EXISTS string_instruments_updated_at;
CREATE TRIGGER IF NOT EXISTS string_instruments_updated_at
AFTER UPDATE ON string_instruments
BEGIN
    UPDATE string_instruments SET updated_at = datetime('now') WHERE id = NEW.id;
END;
