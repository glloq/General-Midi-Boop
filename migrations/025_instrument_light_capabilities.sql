-- ============================================================================
-- Migration 025: Per-instrument embedded-LED lighting capabilities + control
-- ============================================================================
--
-- Adds a dedicated table for lights that are physically on a MIDI
-- instrument and driven by the instrument's own microcontroller (lit
-- keyboard, per-string LED harp, RGB pads, ...). This is independent of
-- the Raspberry-side LightingManager (GPIO/DMX/...): GM Boop sends MIDI
-- (Note/CC/SysEx) back to the instrument so its firmware lights the LEDs.
--
-- Two groups of columns:
--   - capabilities: WHAT the LEDs can do. Filled automatically from the
--     SysEx Block 8 reply (light_caps_source = 'sysex') or entered by the
--     user in the instrument settings modal (light_caps_source = 'manual').
--   - control: HOW GM Boop drives them, configured in the Lighting modal
--     "Par instrument" tab, bounded by the capabilities above.
--
-- The master on/off stays on instruments_latency.lighting_enabled
-- (migration 024). A row here only exists once capabilities are known.
-- Keyed by (device_id, channel) like instruments_latency.
-- ============================================================================

CREATE TABLE IF NOT EXISTS instrument_light_config (
    id                     TEXT PRIMARY KEY,            -- `${device_id}_${channel}`
    device_id              TEXT NOT NULL,
    channel                INTEGER NOT NULL DEFAULT 0,

    -- ---- Capabilities -----------------------------------------------------
    light_caps_source      TEXT,                        -- 'sysex' | 'manual' | NULL
    light_led_count        INTEGER NOT NULL DEFAULT 0,
    light_addressing       INTEGER NOT NULL DEFAULT 1,  -- 0 global,1 per-note,2 string/fret,3 zones,4 strip
    light_note_base        INTEGER NOT NULL DEFAULT 0,  -- per-note base MIDI note (0x7F = follows tessitura)
    light_note_count       INTEGER NOT NULL DEFAULT 0,
    light_color_mode       INTEGER NOT NULL DEFAULT 0,  -- 0 on/off,1 dimmable,2 fixed,3 palette,4 RGB
    light_palette_size     INTEGER NOT NULL DEFAULT 0,
    light_transports       INTEGER NOT NULL DEFAULT 2,  -- bitmask bit0 autonomous,bit1 note,bit2 CC,bit3 SysEx
    light_channel          INTEGER NOT NULL DEFAULT 127,-- 127 = same as instrument channel
    light_cc_brightness    INTEGER NOT NULL DEFAULT 127,-- 127 = unused
    light_cc_mode          INTEGER NOT NULL DEFAULT 127,
    light_cc_effect        INTEGER NOT NULL DEFAULT 127,
    light_cc_effect_speed  INTEGER NOT NULL DEFAULT 127,
    light_cc_guide         INTEGER NOT NULL DEFAULT 127,
    light_local_effects    INTEGER NOT NULL DEFAULT 0,  -- bitmask of firmware-side effects
    light_flags            INTEGER NOT NULL DEFAULT 0,  -- bit0 guide,bit1 per-track color,bit2 idle anim
    light_min_interval_ms  INTEGER NOT NULL DEFAULT 0,  -- throttle hint (serial 31250 baud)

    -- ---- Control configuration -------------------------------------------
    light_mode             TEXT NOT NULL DEFAULT 'managed', -- 'autonomous' | 'managed'
    light_brightness       INTEGER NOT NULL DEFAULT 255,    -- master 0-255
    light_guide_enabled    INTEGER NOT NULL DEFAULT 0 CHECK (light_guide_enabled IN (0, 1)),
    light_palette_json     TEXT,                            -- JSON [{i,r,g,b}]
    light_track_colors_json TEXT,                           -- JSON { trackIndex: "#RRGGBB" }
    light_active_effect    INTEGER NOT NULL DEFAULT 0,
    light_effect_speed     INTEGER NOT NULL DEFAULT 64,

    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE (device_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_instrument_light_device
    ON instrument_light_config (device_id, channel);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (25, 'Add instrument_light_config (embedded-LED capabilities + control)');
