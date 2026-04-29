-- ============================================================================
-- Migration 011: Strip legacy V1.5 longitudinal opt-in fields
-- ============================================================================
--
-- The first iteration of the longitudinal anchored planner exposed three
-- user-facing config blocks under `hands_config`:
--
--   - `hands[0].fingers[]`   — per-finger offset bands
--   - `anchor.*`             — anchor lifecycle tunables
--   - `cc_sample_rate_hz`    — dense CC stream rate
--
-- These were promoted as opt-in ("Mode longitudinal ancré (V2)") and
-- written by an inline panel in the Mains tab of the instrument
-- settings modal. We have now simplified the model to be always-on with
-- automatic finger derivation (one finger per string, offset bands
-- `[0, hand_span_mm]`) and no exposed anchor knobs. The planner ignores
-- those legacy fields on read; this migration drops them from persisted
-- rows so the JSON matches the documented schema and the UI never
-- re-emits them.
--
-- Semitones-mode rows (keyboards) are left untouched: they never carried
-- these fields.
-- ============================================================================

UPDATE instruments_latency
SET hands_config = json_remove(
    hands_config,
    '$.cc_sample_rate_hz',
    '$.anchor',
    '$.hands[0].fingers'
)
WHERE hands_config IS NOT NULL
  AND json_valid(hands_config)
  AND json_extract(hands_config, '$.mode') = 'frets';

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (11, 'Strip legacy longitudinal fields (fingers[], anchor, cc_sample_rate_hz)');
