-- ============================================================================
-- Migration 008: Persist hand-position feasibility on routings
-- ============================================================================
--
-- Adds `hand_position_feasibility` JSON column to
-- `midi_instrument_routings` so the auto-assignment apply step can
-- record the heuristic level (level / qualityScore / summary /
-- message) at the moment the routing was committed. This unlocks two
-- things without re-running the planner on every UI render:
--
--   * The routing-summary table can show the "main" badge from the
--     persisted value, even after a server restart, instead of
--     recomputing from `allInstruments + channelAnalyses`.
--   * Bulk views (Playlist, Files inspector) can filter / sort by
--     feasibility level.
--
-- The column is nullable: existing rows keep working (they appear
-- with `level: 'unknown'` to consumers, which the UI already handles).
-- Persistence happens at apply time via PlaybackAssignmentCommands;
-- the value is purely advisory and does not block the apply if the
-- planner classification fails.
-- ============================================================================

ALTER TABLE midi_instrument_routings
    ADD COLUMN hand_position_feasibility TEXT
    CHECK (hand_position_feasibility IS NULL OR json_valid(hand_position_feasibility));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (8, 'Add hand_position_feasibility JSON to midi_instrument_routings');
