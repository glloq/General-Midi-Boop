-- Per-instrument SF2 soundfont override.
-- Allows assigning a specific custom SF2 bank to an instrument for cases
-- where the instrument is not covered by General MIDI (e.g. custom tunings,
-- non-standard timbres). NULL = use the global soundbank setting.
ALTER TABLE instruments_latency ADD COLUMN custom_sf2_id INTEGER REFERENCES custom_sf2(id) ON DELETE SET NULL;
