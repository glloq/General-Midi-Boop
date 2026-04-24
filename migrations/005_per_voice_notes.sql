-- ============================================================================
-- Migration 005: Per-voice note capabilities + shared-notes flag
-- ============================================================================
--
-- Adds columns to `instrument_voices` so each secondary GM voice can declare
-- its own playable-note capabilities (range or discrete selection, per-voice
-- octave mode). Previously every secondary voice inherited the primary voice's
-- capabilities stored on `instruments_latency`.
--
-- Adds `instruments_latency.voices_share_notes` (BOOLEAN, default 1). When the
-- flag is set (default), every GM voice on the channel uses the primary's
-- note capabilities — the per-voice columns are ignored. When cleared, the
-- UI exposes a per-voice editor so the user can declare different playable
-- notes for each GM voice (e.g. a thumb-piano variant that only covers part
-- of the keyboard).
-- ============================================================================

ALTER TABLE instrument_voices ADD COLUMN note_selection_mode TEXT;
ALTER TABLE instrument_voices ADD COLUMN note_range_min      INTEGER;
ALTER TABLE instrument_voices ADD COLUMN note_range_max      INTEGER;
ALTER TABLE instrument_voices ADD COLUMN selected_notes      TEXT;     -- JSON array
ALTER TABLE instrument_voices ADD COLUMN octave_mode         TEXT;

ALTER TABLE instruments_latency ADD COLUMN voices_share_notes INTEGER NOT NULL DEFAULT 1
    CHECK (voices_share_notes IN (0, 1));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (5, 'Per-voice note capabilities + voices_share_notes flag');
