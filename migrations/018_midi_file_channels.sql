-- ============================================================================
-- Migration 018: MIDI File Channels - Per-channel instrument detail
-- ============================================================================
--
-- Description:
--   Store detailed per-channel analysis for each MIDI file, including
--   GM program numbers, instrument names, categories, and musical
--   characteristics. Enables searching MIDI files by specific GM
--   instrument or instrument category.
--
-- Author: MidiMind Team
-- Date: 2026-03-13
--
-- ============================================================================

-- ============================================================================
-- TABLE: midi_file_channels
-- Per-channel instrument analysis for each MIDI file
-- ============================================================================

CREATE TABLE IF NOT EXISTS midi_file_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    midi_file_id INTEGER NOT NULL,
    channel INTEGER NOT NULL CHECK(channel BETWEEN 0 AND 15),
    primary_program INTEGER,
    gm_instrument_name TEXT,
    gm_category TEXT,
    estimated_type TEXT,
    type_confidence INTEGER DEFAULT 0,
    note_range_min INTEGER,
    note_range_max INTEGER,
    total_notes INTEGER DEFAULT 0,
    polyphony_max INTEGER DEFAULT 0,
    polyphony_avg REAL DEFAULT 0,
    density REAL DEFAULT 0,
    track_names TEXT DEFAULT '[]',
    FOREIGN KEY (midi_file_id) REFERENCES midi_files(id) ON DELETE CASCADE,
    UNIQUE(midi_file_id, channel)
);

-- ============================================================================
-- CREATE INDEX: Optimize queries for instrument-based searches
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_mfc_file ON midi_file_channels(midi_file_id);
CREATE INDEX IF NOT EXISTS idx_mfc_program ON midi_file_channels(primary_program);
CREATE INDEX IF NOT EXISTS idx_mfc_category ON midi_file_channels(gm_category);
CREATE INDEX IF NOT EXISTS idx_mfc_instrument ON midi_file_channels(gm_instrument_name);
CREATE INDEX IF NOT EXISTS idx_mfc_type ON midi_file_channels(estimated_type);

-- ============================================================================
-- REGISTER MIGRATION
-- ============================================================================

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (18, 'MIDI file channels: per-channel GM instrument detail for instrument-based search');

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT 'Migration 018 completed successfully' as status;
