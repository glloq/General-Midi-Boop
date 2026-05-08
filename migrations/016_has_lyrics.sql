-- ============================================================================
-- Migration 016: Add has_lyrics flag to midi_files
-- Denormalised boolean for fast filtering without joining midi_file_text_events.
-- Backfilled from existing lyrics rows in that table.
-- ============================================================================

ALTER TABLE midi_files ADD COLUMN has_lyrics INTEGER NOT NULL DEFAULT 0;

-- Backfill: mark files that already have at least one lyrics text event
UPDATE midi_files
SET has_lyrics = 1
WHERE id IN (
    SELECT DISTINCT midi_file_id
    FROM midi_file_text_events
    WHERE event_type = 'lyrics'
);

CREATE INDEX IF NOT EXISTS idx_midi_files_has_lyrics ON midi_files(has_lyrics);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (16, 'Add has_lyrics flag to midi_files');
