-- ============================================================================
-- Migration 010: Hand mechanism discriminator for frets-mode hands_config
-- ============================================================================
--
-- Adds an explicit `mechanism` field to every existing frets-mode
-- `hands_config` JSON payload so the planner's behaviour is selected
-- by an explicit discriminator rather than implicit defaults. Three
-- mechanisms are defined for V1 (the third reserved for V2):
--
--   - `string_sliding_fingers`  (V1)  — current behaviour: each finger
--      is fixed to a string and slides along it within the hand width.
--      Backfilled here so existing rows preserve their pre-migration
--      semantics exactly.
--   - `fret_sliding_fingers`    (V1)  — each finger is anchored at a
--      fret offset of the hand and selects the string by sliding
--      sideways. New, only set via the modal.
--   - `independent_fingers`     (V2)  — humanoid 4-finger system, not
--      yet implemented (rejected at save time).
--
-- The validator now requires `mechanism` for any new write to a
-- frets-mode hands_config; this migration ensures every existing row
-- already has it, so no user action is required after upgrading.
--
-- Legacy fret-fallback fields (`hand_span_frets`,
-- `hand_move_frets_per_sec`) are intentionally preserved here. The new
-- modal only writes mm-based fields, but downstream consumers
-- (InstrumentMatcher, FretboardHandPreview, TablatureEditor) still
-- read them as advisory summary values. They will be cleaned up in a
-- follow-up migration once those consumers are converted to read mm.
--
-- Semitones-mode rows (keyboards) are left untouched.
-- ============================================================================

UPDATE instruments_latency
SET hands_config = json_set(
    hands_config,
    '$.mechanism',
    'string_sliding_fingers'
)
WHERE hands_config IS NOT NULL
  AND json_valid(hands_config)
  AND json_extract(hands_config, '$.mode') = 'frets'
  AND json_extract(hands_config, '$.mechanism') IS NULL;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (10, 'Backfill mechanism = string_sliding_fingers on frets-mode hands_config');
