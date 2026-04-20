-- ============================================================================
-- Migration 002: Sound-bank effect overrides
-- ============================================================================
--
-- Adds `bank_effects`: one row per WebAudioFont sound bank that the user
-- has customised (reverb + echo/delay levels). Absence of a row for a
-- given bank means the built-in defaults from
-- `public/js/audio/MidiSynthesizerConstants.js` (SOUND_BANKS[].reverbMix)
-- apply.
--
-- Effects are browser-side only (Web Audio API). They do not affect
-- hardware MIDI output — the DB value is the single source of truth
-- that gets pushed to the synthesizer on bank switch and on each
-- slider move.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_effects (
    bank_id        TEXT PRIMARY KEY NOT NULL,
    reverb_mix     REAL NOT NULL DEFAULT 0.12,    -- 0.0–1.0 wet gain
    reverb_decay_s REAL NOT NULL DEFAULT 1.2,     -- 0.3–3.0 seconds (IR length)
    echo_mix       REAL NOT NULL DEFAULT 0.0,     -- 0.0–1.0 wet gain
    echo_time_ms   INTEGER NOT NULL DEFAULT 250,  -- 50–1000 ms delay time
    echo_feedback  REAL NOT NULL DEFAULT 0.3,     -- 0.0–0.9 feedback amount
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_bank_effects_update
AFTER UPDATE ON bank_effects
BEGIN
    UPDATE bank_effects SET updated_at = datetime('now') WHERE bank_id = NEW.bank_id;
END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (2, 'Add bank_effects table (per-sound-bank reverb + echo overrides)');
