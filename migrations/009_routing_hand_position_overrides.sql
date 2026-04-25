-- ============================================================================
-- Migration 009: Persist hand-position overrides on routings
-- ============================================================================
--
-- Adds `hand_position_overrides` JSON column to
-- `midi_instrument_routings`. Stores user-authored adjustments that the
-- HandsPreviewPanel (Feature E) lets the operator make before playback:
--
--   { "hand_anchors":   [ {tick, handId, anchor}, ... ],
--     "disabled_notes": [ {tick, note, reason}, ... ],
--     "version": 1 }
--
-- The column is nullable; rows from before this migration carry NULL
-- and the simulation falls back to the planner's default behaviour.
-- Applying an override is the future MidiPlayer's job (out of scope
-- for E.6.1 — see Feature E.8 limitations); for now persistence is
-- enough so the UI round-trips the user's edits.
--
-- Same pattern as migration 008 (hand_position_feasibility) — JSON
-- text + json_valid CHECK so a bad write fails fast at INSERT time
-- rather than corrupting the row silently.
-- ============================================================================

ALTER TABLE midi_instrument_routings
    ADD COLUMN hand_position_overrides TEXT
    CHECK (hand_position_overrides IS NULL OR json_valid(hand_position_overrides));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (9, 'Add hand_position_overrides JSON to midi_instrument_routings');
