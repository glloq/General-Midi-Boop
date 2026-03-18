-- ============================================================================
-- File: migrations/022_lighting_gpio_strip.sql
-- Description: Add gpio_strip device type for WS2812/NeoPixel addressable LED strips
-- ============================================================================

-- SQLite does not support ALTER TABLE to modify CHECK constraints,
-- so we recreate the table with the updated constraint.

CREATE TABLE IF NOT EXISTS lighting_devices_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'gpio'
        CHECK(type IN ('gpio', 'gpio_strip', 'serial', 'artnet', 'mqtt', 'midi')),
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
