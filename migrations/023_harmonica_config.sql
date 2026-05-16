-- ============================================================================
-- Migration 023: Harmonica play config (diatonic / chromatic)
-- ============================================================================
--
-- Adds one optional JSON column to `instruments_latency`, mirroring the
-- bagpipe_config / accordion_config precedent (migration 022). NULL means
-- "use the view's idiomatic default" — a diatonic C harmonica behaves
-- exactly as before for every instrument that does not set this.
--
-- harmonica_config shape (validation in InstrumentSettingsCommands.js):
--   { "type": "diatonic" | "chromatic", "key": "C" | "C#" | ... | "B" }
--     type : "diatonic" (Richter) or "chromatic" (solo tuning + slide)
--     key  : musical key root, one of the 12 pitch classes (default "C")
--
-- The chromatic flag lives ONLY here — never set keyboard_type for a
-- harmonica or GM22 would be diverted to the equal-width keyboard-list view.
-- Hole count follows the instrument's configured note range.
--
-- Consumed by KeyboardModal.getHarmonicaConfig() (HarmonicaView).
-- Absence → previous behaviour (diatonic C).
-- ============================================================================

ALTER TABLE instruments_latency
    ADD COLUMN harmonica_config TEXT
    CHECK (harmonica_config IS NULL OR json_valid(harmonica_config));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (23, 'Add harmonica_config JSON column to instruments_latency');
