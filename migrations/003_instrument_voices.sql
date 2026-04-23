-- ============================================================================
-- Migration 003: Multi-GM voices per instrument
-- ============================================================================
--
-- Adds `instrument_voices`: zero or more SECONDARY GM voices attached to an
-- instrument (device_id + channel). The PRIMARY voice still lives on
-- `instruments_latency.gm_program` for backward compatibility with all the
-- existing consumers that expect a single GM program per channel.
--
-- Semantics (decided in the v7 instrument modal refactor):
--   Voices are ALTERNATIVES, not layers. Each secondary voice represents a
--   different actuator/technique on the SAME physical instrument (e.g. a
--   bass playing fingerstyle vs slap vs tapping, or a string instrument
--   playing arco vs pizzicato). At playback time the engine picks ONE
--   voice per note based on context; simultaneous layering is NOT intended.
--
-- Per-voice fields:
--   * gm_program          — GM program (0-127) or ≥128 for encoded drum kits.
--   * min_note_interval   — Minimum delay between two note-ons (ms).
--   * min_note_duration   — Minimum active-note duration (ms).
--   * supported_ccs       — JSON array of CC numbers supported by this voice.
--   * display_order       — Integer for stable ordering in the UI.
--
-- Shared across voices (still on `instruments_latency` / capabilities):
--   custom_name, note_range_min/max, octave_mode, polyphony, sync_delay,
--   mac_address. These describe the physical instrument, not the actuator.
--
-- Downstream integration (matcher, playback engine, MIDI editor) is tracked
-- in INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md (Phase 8).
-- ============================================================================

CREATE TABLE IF NOT EXISTS instrument_voices (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id          TEXT    NOT NULL,
    channel            INTEGER NOT NULL CHECK (channel BETWEEN 0 AND 15),
    gm_program         INTEGER,
    min_note_interval  INTEGER,
    min_note_duration  INTEGER,
    supported_ccs      TEXT,        -- JSON array, e.g. "[1,7,11]"
    display_order      INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_instrument_voices_device_channel
    ON instrument_voices(device_id, channel, display_order);

CREATE TRIGGER IF NOT EXISTS trg_instrument_voices_update
AFTER UPDATE ON instrument_voices
BEGIN
    UPDATE instrument_voices SET updated_at = datetime('now') WHERE id = NEW.id;
END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (3, 'Add instrument_voices table (secondary GM voices per instrument channel)');
