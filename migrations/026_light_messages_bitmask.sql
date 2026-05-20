-- ============================================================================
-- Migration 026: Lighting message catalog bitmask
-- ============================================================================
--
-- Adds the explicit "lighting message catalog" support bitmask to each
-- per-instrument lighting row. Bit i = 1 means the instrument supports
-- catalog message id i (see Block 8 v2 in docs/SYSEX_IDENTITY.md and the
-- LIGHT_MSG enum in src/lighting/instrument/InstrumentLightProtocol.js).
--
-- Block 8 v1 firmwares do not transmit this bitmask; GM Boop derives it
-- on the fly from the existing capability fields (color_mode, transports,
-- local_effects, flags). Block 8 v2 firmwares transmit it directly and
-- the value is persisted here as the authoritative source.
-- ============================================================================

ALTER TABLE instrument_light_config
    ADD COLUMN light_messages_bitmask INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (26, 'Add light_messages_bitmask to instrument_light_config');
