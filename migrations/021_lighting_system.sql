-- ============================================================================
-- File: migrations/021_lighting_system.sql
-- Description: Lighting control system tables
-- ============================================================================

-- ============================================================================
-- TABLE: lighting_devices
-- Description: Physical or virtual lighting endpoints (LED strips, GPIO LEDs, etc.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS lighting_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'gpio'
        CHECK(type IN ('gpio', 'serial', 'artnet', 'mqtt', 'midi')),
    connection_config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(connection_config)),
    led_count INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- TABLE: lighting_rules
-- Description: Links MIDI conditions to lighting actions
-- ============================================================================

CREATE TABLE IF NOT EXISTS lighting_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    device_id INTEGER NOT NULL REFERENCES lighting_devices(id) ON DELETE CASCADE,
    instrument_id TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    condition_config TEXT NOT NULL CHECK(json_valid(condition_config)),
    action_config TEXT NOT NULL CHECK(json_valid(action_config)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lighting_rules_device ON lighting_rules(device_id);
CREATE INDEX IF NOT EXISTS idx_lighting_rules_instrument ON lighting_rules(instrument_id);

-- ============================================================================
-- TABLE: lighting_presets
-- Description: Saved collections of rules for quick switching
-- ============================================================================

CREATE TABLE IF NOT EXISTS lighting_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rules_snapshot TEXT NOT NULL CHECK(json_valid(rules_snapshot)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- TRIGGERS: Auto-update updated_at timestamps
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS lighting_devices_updated_at
AFTER UPDATE ON lighting_devices
BEGIN
    UPDATE lighting_devices SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS lighting_rules_updated_at
AFTER UPDATE ON lighting_rules
BEGIN
    UPDATE lighting_rules SET updated_at = datetime('now') WHERE id = NEW.id;
END;
