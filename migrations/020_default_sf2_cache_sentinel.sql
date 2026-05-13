-- Sentinel `custom_sf2` row for the built-in default SF2.
--
-- The `sf2_preset_cache` table has a FK to `custom_sf2(id)`, which previously
-- meant the default SF2 could not benefit from the persistent L2 cache:
-- every cold load had to re-parse the 30 MB RIFF + re-convert the preset
-- (~975 ms wasted). Inserting a sentinel row keyed at id=0 lets the default
-- soundfont share the same cache path as user uploads.
--
-- The HTTP routes that mutate `custom_sf2` (DELETE, PATCH) reject id <= 0
-- and the special string 'default', so this row cannot be deleted via the
-- API. The blob_path is a recognisable placeholder; the real on-disk path
-- for the default SF2 is resolved separately in SF2PresetService.

INSERT OR IGNORE INTO custom_sf2 (id, filename, blob_path, content_hash, size, label)
VALUES (0, '__builtin_default__', '__builtin__', '__builtin__', 0, 'Built-in default SF2');
