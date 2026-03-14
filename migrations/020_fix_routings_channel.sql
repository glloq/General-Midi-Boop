-- Migration 020: Fix midi_instrument_routings to support channel-based assignment
-- The original table used track_id + UNIQUE(midi_file_id, track_id) which doesn't fit
-- the auto-assignment model that works with MIDI channels.

-- Drop the old unique constraint and add a new one based on channel
-- SQLite doesn't support DROP CONSTRAINT, so we create a new index instead
CREATE UNIQUE INDEX IF NOT EXISTS idx_midi_routings_file_channel
    ON midi_instrument_routings(midi_file_id, channel)
    WHERE channel IS NOT NULL;

-- Ensure track_id allows NULL for new channel-based routings
-- (SQLite columns already allow NULL unless NOT NULL is specified,
--  but existing rows will have track_id set)

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (20, 'Fix routings table for channel-based auto-assignment');
