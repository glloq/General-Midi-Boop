-- ============================================================================
-- Migration 004: Hand-position control per instrument
-- ============================================================================
--
-- Adds `hands_config` JSON column to `instruments_latency` so a physical
-- instrument can describe how its mechanical hand(s) should be positioned
-- while playing. Absence of the column value (NULL) means the feature is
-- disabled for that instrument and the playback pipeline behaves exactly
-- as before (no extra CC injected, no hand-assignment pass).
--
-- Phase 1 target: keyboards (2 hands). Phase 2 will unify string
-- instruments by reusing the same schema with a single hand. Wind
-- instruments have no hand-position concept and keep `hands_config` NULL.
--
-- Shape of the JSON payload (documented for consumers — validation lives in
-- src/midi/adaptation/InstrumentCapabilitiesValidator.js):
--
-- {
--   "enabled": true,
--   "assignment": {
--     "mode": "auto" | "track" | "pitch_split",
--     "track_map":     { "left": [0,1], "right": [2] },   -- optional
--     "pitch_split_note": 60,                             -- MIDI note, default C4
--     "pitch_split_hysteresis": 2                         -- semitones, default 2
--   },
--   "hands": [
--     {
--       "id": "left" | "right",
--       "cc_position_number": 23,          -- CC sent to command the hand position
--       "note_range_min": 21,              -- lowest note the hand can physically reach
--       "note_range_max": 72,              -- highest note the hand can physically reach
--       "hand_span_semitones": 14,         -- max interval between lowest/highest simultaneous note
--       "polyphony": 5,                    -- fingers available for this hand
--       "finger_min_interval_ms": 40,      -- minimum delay between two notes on the same hand
--       "hand_move_semitones_per_sec": 60  -- mechanical travel speed (used for feasibility warnings)
--     },
--     { "id": "right", "cc_position_number": 24, ... }
--   ]
-- }
--
-- The CC value emitted at runtime is the MIDI note number of the current
-- lowest note of the hand window (0-127, raw, no scaling). The planner
-- emits it as early as possible — just after the last note-on of the
-- previous window — so the mechanical hand has the maximum time to move.
-- ============================================================================

ALTER TABLE instruments_latency
    ADD COLUMN hands_config TEXT
    CHECK (hands_config IS NULL OR json_valid(hands_config));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (4, 'Add hands_config column to instruments_latency (hand-position control)');
