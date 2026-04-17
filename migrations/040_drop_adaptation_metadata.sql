-- ============================================================================
-- File: migrations/040_drop_adaptation_metadata.sql
-- Description: Drop the adaptation_metadata column from midi_files.
--
--   The column was written by PlaybackCommands.applyAssignments but never
--   read anywhere. The information it carried (per-channel semitones,
--   noteRemapping and assignment reason) is already stored on
--   midi_instrument_routings (transposition_applied, note_remapping,
--   assignment_reason) and that is what the UI actually consumes. The
--   remaining unique fields (timestamp, strategy, note-change statistics)
--   had no consumers either, so dropping the column removes dead state
--   and saves bandwidth on every file listing (LIST_COLUMNS).
--
--   Requires SQLite >= 3.35 for DROP COLUMN support.
-- ============================================================================

ALTER TABLE midi_files DROP COLUMN adaptation_metadata;

-- ============================================================================
-- REGISTER MIGRATION
-- ============================================================================

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (40, 'Drop unused adaptation_metadata column from midi_files');
