-- ============================================================================
-- Migration 014: MIDI text events extraction
-- Stores all text-bearing meta events (lyrics, markers, copyright, etc.)
-- and adds title/copyright denormalisation columns on midi_files.
-- ============================================================================

-- Per-event table: one row per text meta event found in the MIDI file.
-- ON DELETE CASCADE keeps it in sync with midi_files automatically.
CREATE TABLE IF NOT EXISTS midi_file_text_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    midi_file_id INTEGER NOT NULL REFERENCES midi_files(id) ON DELETE CASCADE,
    track        INTEGER NOT NULL DEFAULT 0,
    tick         INTEGER NOT NULL DEFAULT 0,
    -- type values: text | copyright | trackName | instrumentName | lyrics |
    --              marker | cuePoint | programName | deviceName
    event_type   TEXT NOT NULL,
    text         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_mfte_file       ON midi_file_text_events(midi_file_id);
CREATE INDEX IF NOT EXISTS idx_mfte_type       ON midi_file_text_events(event_type);
CREATE INDEX IF NOT EXISTS idx_mfte_file_type  ON midi_file_text_events(midi_file_id, event_type);
-- Enables full-text search via LIKE on the text column
CREATE INDEX IF NOT EXISTS idx_mfte_text       ON midi_file_text_events(text);

-- Denormalised columns on midi_files for fast listing queries
ALTER TABLE midi_files ADD COLUMN title     TEXT;
ALTER TABLE midi_files ADD COLUMN copyright TEXT;

CREATE INDEX IF NOT EXISTS idx_midi_files_title ON midi_files(title);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (14, 'Add midi_file_text_events table and title/copyright columns on midi_files');
