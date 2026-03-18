-- ============================================================================
-- File: migrations/023_lighting_multi_drivers.sql
-- Description: Add new lighting device types: sacn, http, osc
--              and extend action types with effects support
-- ============================================================================

-- SQLite does not support ALTER TABLE to modify CHECK constraints,
-- so we recreate the table with the updated constraint.

CREATE TABLE IF NOT EXISTS lighting_devices_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'gpio'
        CHECK(type IN ('gpio', 'gpio_strip', 'serial', 'artnet', 'sacn', 'mqtt', 'http', 'osc', 'midi')),
    connection_config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(connection_config)),
    led_count INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO lighting_devices_new SELECT * FROM lighting_devices;
DROP TABLE lighting_devices;
ALTER TABLE lighting_devices_new RENAME TO lighting_devices;

-- Recreate index used by rules foreign key
CREATE INDEX IF NOT EXISTS idx_lighting_devices_id ON lighting_devices(id);

-- Recreate updated_at trigger
CREATE TRIGGER IF NOT EXISTS lighting_devices_updated_at
AFTER UPDATE ON lighting_devices
BEGIN
    UPDATE lighting_devices SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- TABLE: lighting_effects
-- Description: Saved effect configurations for quick application
-- ============================================================================

CREATE TABLE IF NOT EXISTS lighting_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    effect_type TEXT NOT NULL CHECK(effect_type IN ('strobe', 'rainbow', 'chase', 'fire', 'breathe', 'sparkle', 'color_cycle', 'wave')),
    config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
