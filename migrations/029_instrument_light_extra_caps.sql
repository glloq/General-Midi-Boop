-- ============================================================================
-- Migration 029: per-CC capability details (CC110 mode + CC111 effects)
-- ============================================================================
--
-- Extends `instrument_light_state` with two extra capability fields that
-- are edited exclusively from the instrument settings modal:
--
--   brightness_mode   — how the firmware interprets CC 110:
--                         0 = on/off relay (only 0 or 127 are meaningful)
--                         1 = dimmable    (0-127 maps to a brightness level)
--   supported_effects — 10-bit mask of supported CC 111 effect indices:
--                         bit 0 static · bit 1 fade · bit 2 pulse ·
--                         bit 3 blink · bit 4 rainbow · bit 5 reactive_note ·
--                         bit 6 reactive_velocity · bit 7 sparkle ·
--                         bit 8 fire · bit 9 scanner
--
-- Defaults keep existing behaviour: dimmable + all 10 effects supported.
-- ============================================================================

ALTER TABLE instrument_light_state
    ADD COLUMN brightness_mode INTEGER NOT NULL DEFAULT 1
        CHECK (brightness_mode IN (0, 1));

ALTER TABLE instrument_light_state
    ADD COLUMN supported_effects INTEGER NOT NULL DEFAULT 1023
        CHECK (supported_effects BETWEEN 0 AND 1023);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (29, 'Add brightness_mode + supported_effects to instrument_light_state');
