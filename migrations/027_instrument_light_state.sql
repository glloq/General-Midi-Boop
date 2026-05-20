-- ============================================================================
-- Migration 027: Generic CC-based instrument lighting state
-- ============================================================================
--
-- Replaces the previous (Block 8/9, capabilities) approach with a plain
-- 5-CC scheme. Each row holds the latest CC values pushed to the
-- instrument so they survive a restart:
--
--   CC 110 → brightness (0 = OFF, 1-127 = level)
--   CC 111 → effect index (0 = static, see EFFECTS in InstrumentLightCC.js)
--   CC 112 → HSV hue (0-127)
--   CC 113 → animation speed
--   CC 114 → intensity / variation
--
-- Master on/off remains `instruments_latency.lighting_enabled` (mig. 024).
-- The legacy `instrument_light_config` table (migrations 025/026) is left
-- in place for backward compatibility on already-deployed databases but is
-- no longer read or written by GM Boop.
-- ============================================================================

CREATE TABLE IF NOT EXISTS instrument_light_state (
    id          TEXT PRIMARY KEY,           -- `${device_id}_${channel}`
    device_id   TEXT NOT NULL,
    channel     INTEGER NOT NULL DEFAULT 0,
    brightness  INTEGER NOT NULL DEFAULT 0   CHECK (brightness BETWEEN 0 AND 127),
    effect      INTEGER NOT NULL DEFAULT 0   CHECK (effect     BETWEEN 0 AND 127),
    hue         INTEGER NOT NULL DEFAULT 0   CHECK (hue        BETWEEN 0 AND 127),
    speed       INTEGER NOT NULL DEFAULT 64  CHECK (speed      BETWEEN 0 AND 127),
    intensity   INTEGER NOT NULL DEFAULT 64  CHECK (intensity  BETWEEN 0 AND 127),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (device_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_instrument_light_state_device
    ON instrument_light_state (device_id, channel);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (27, 'Generic CC-based instrument_light_state (CC 110-114)');
