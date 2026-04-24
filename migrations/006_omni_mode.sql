-- ============================================================================
-- Migration 006: Omni mode flag on instrument rows
--
-- Originally shipped as `004_omni_mode.sql`, but a second PR concurrently
-- added `004_instrument_hands_config.sql`. Alphabetical sort ran hands_config
-- first and marked version 4 as applied, which silently skipped this file
-- on every install that went through both merges — the `omni_mode` column
-- was never created, and saves tripped "no such column: omni_mode".
-- Renumbering to 006 forces it to apply; the runner tolerates the
-- duplicate-column error for the edge case of an install that ran the
-- original 004_omni_mode.sql before the collision.
-- ============================================================================
--
-- Adds `instruments_latency.omni_mode` (BOOLEAN). When enabled, the instrument
-- is declared to accept notes on ANY MIDI channel. This is useful when a
-- physical device hosts a single instrument and the user doesn't want to care
-- about matching the incoming channel number to the configured channel.
--
-- Semantics:
--   * omni_mode = 0 (default): instrument is bound to its `channel` column.
--   * omni_mode = 1: instrument accepts any incoming MIDI channel. During
--     playback, the routing layer uses this row as a fallback for channels
--     that have no explicit routing entry in `midi_instrument_routings`.
--
-- The instrument's `channel` column is still stored (and is still unique per
-- device) so saving/loading the modal UI keeps working; `channel` simply
-- becomes advisory when omni_mode is on.
-- ============================================================================

ALTER TABLE instruments_latency ADD COLUMN omni_mode INTEGER NOT NULL DEFAULT 0
    CHECK (omni_mode IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_instruments_omni
    ON instruments_latency(omni_mode) WHERE omni_mode = 1;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (6, 'Add omni_mode flag to instruments_latency');
