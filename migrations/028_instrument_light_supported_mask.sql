-- ============================================================================
-- Migration 028: per-instrument "which CCs does this device understand?" mask
-- ============================================================================
--
-- The Lighting modal "Par instrument" tab now lists each instrument as a
-- compact row with five small toggles, one per CC (110-114). A CC is only
-- transmitted when its bit is set in `supported_mask` — so the user
-- declares once what the firmware understands, and the matching inline
-- control becomes visible.
--
-- Bit layout (low → high):
--   0x01 = CC 110 (brightness)
--   0x02 = CC 111 (effect)
--   0x04 = CC 112 (hue)
--   0x08 = CC 113 (speed)
--   0x10 = CC 114 (intensity)
--
-- Default 0 = nothing declared yet (no CC sent until the user activates it).
-- ============================================================================

ALTER TABLE instrument_light_state
    ADD COLUMN supported_mask INTEGER NOT NULL DEFAULT 0
        CHECK (supported_mask BETWEEN 0 AND 31);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (28, 'Add supported_mask (CC 110-114 bitmask) to instrument_light_state');
