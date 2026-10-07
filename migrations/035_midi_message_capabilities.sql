-- ============================================================================
-- Migration 035: Normalized MIDI message capability declaration
--
-- Stores the runtime semantic MIDI messages declared by a GMB v2 descriptor.
-- This is deliberately JSON rather than one column per MIDI message because the
-- protocol is extensible and because absent / false / true have distinct meanings:
--   absent = unknown / legacy descriptor (GMB remains permissive)
--   false  = explicitly unsupported / no-op
--   true   = the active firmware configuration has a real effect
--
-- `pitch_bend_enabled` (migration 034) remains the compatibility/UI mirror for
-- the existing virtual-keyboard gate. Descriptor application keeps it in sync
-- when pitch-bend support is explicitly declared.
-- ============================================================================

ALTER TABLE instruments_latency ADD COLUMN midi_message_support TEXT
    CHECK (midi_message_support IS NULL OR json_valid(midi_message_support));

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (35, 'Persist normalized per-instrument MIDI message capabilities');
