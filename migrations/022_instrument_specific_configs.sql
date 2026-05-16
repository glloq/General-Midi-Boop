-- ============================================================================
-- Migration 022: Instrument-specific play configs (bagpipe / accordion)
-- ============================================================================
--
-- Adds two optional JSON columns to `instruments_latency`, mirroring the
-- `hands_config` precedent (migration 004). NULL means "use the view's
-- idiomatic default" — behaviour is unchanged for every instrument that
-- does not set them.
--
-- bagpipe_config shape (validation in InstrumentSettingsCommands.js):
--   { "drones": [45, 45, 33], "enabled": true }
--     drones  : MIDI note numbers, one per sounding drone (0-127)
--     enabled : whether the drones sound automatically on view mount
--
-- accordion_config shape (per-side play possibilities — both sides are
-- always present, this never hides a side):
--   { "bass_system": "stradella" | "chromatic" | "free",
--     "right_display": "buttons" | "keyboard" }
--
-- Consumed by KeyboardModal.getBagpipeConfig() / getAccordionConfig()
-- (BagpipeView / AccordionView). Absence → previous behaviour.
-- ============================================================================

ALTER TABLE instruments_latency
    ADD COLUMN bagpipe_config TEXT
    CHECK (bagpipe_config IS NULL OR json_valid(bagpipe_config));

ALTER TABLE instruments_latency
    ADD COLUMN accordion_config TEXT
    CHECK (accordion_config IS NULL OR json_valid(accordion_config));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (22, 'Add bagpipe_config / accordion_config JSON columns to instruments_latency');
