-- ============================================================================
-- Migration 034: Pitch-bend enable flag on instrument rows
--
-- Adds `instruments_latency.pitch_bend_enabled` (BOOLEAN 0/1). When enabled,
-- the virtual keyboard shows its pitch-bend wheel and the slider mode for the
-- instrument.
--
-- Before this migration the "Pitch Bend" toggle in the instrument-settings
-- modal was sent on save but had no column or handler anywhere, so it never
-- persisted and the keyboard's pitch-bend wheel (which gates on
-- `caps.pitch_bend_enabled`) could never be enabled from the UI. The column is
-- read back into both the settings response (SELECT *) and the capabilities
-- response, so a single flag drives the modal toggle and the keyboard wheel.
--
-- Semantics:
--   * pitch_bend_enabled = 0 (default): no pitch-bend wheel / slider mode.
--   * pitch_bend_enabled = 1: pitch-bend wheel and equal-keys slider mode
--     are available in the virtual keyboard for this instrument.
-- ============================================================================

ALTER TABLE instruments_latency ADD COLUMN pitch_bend_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (pitch_bend_enabled IN (0, 1));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (34, 'Add pitch_bend_enabled flag to instruments_latency');
