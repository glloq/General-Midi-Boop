-- ============================================================================
-- Migration 024: Per-instrument lighting toggle
-- ============================================================================
--
-- Adds one boolean column to `instruments_latency`, mirroring the
-- omni_mode precedent. 0 means "no lighting control for this instrument"
-- (previous behaviour for every existing row).
--
-- When set to 1, a "Lumière" tab appears in the instrument settings UI,
-- letting the user attach lighting rules (lighting_rules.instrument_id)
-- that react to this instrument's MIDI. The lighting rules themselves
-- already have an instrument_id column (migration 001) — this flag only
-- gates the UI and is independent of whether any rule exists yet.
-- ============================================================================

ALTER TABLE instruments_latency
    ADD COLUMN lighting_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (lighting_enabled IN (0, 1));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (24, 'Add lighting_enabled flag to instruments_latency');
