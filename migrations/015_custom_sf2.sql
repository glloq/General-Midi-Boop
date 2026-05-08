-- Custom SF2 soundfonts uploaded by the user.
-- blob_path is relative to data/sf2/.
CREATE TABLE IF NOT EXISTS custom_sf2 (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filename     TEXT NOT NULL,
    blob_path    TEXT NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    size         INTEGER NOT NULL,
    label        TEXT NOT NULL,
    reverb_mix   REAL NOT NULL DEFAULT 0.12,
    uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persistent preset cache: WAF-compatible zones JSON compressed with zlib.
-- Keyed by (sf2_id, preset_type, program, kit, note).
-- For melodic presets: program=GM program, kit=0, note=0.
-- For drum presets: program=0, kit=GM kit program, note=MIDI note.
CREATE TABLE IF NOT EXISTS sf2_preset_cache (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sf2_id       INTEGER NOT NULL REFERENCES custom_sf2(id) ON DELETE CASCADE,
    preset_type  TEXT NOT NULL CHECK(preset_type IN ('melodic','drum')),
    program      INTEGER NOT NULL DEFAULT 0,
    kit          INTEGER NOT NULL DEFAULT 0,
    note         INTEGER NOT NULL DEFAULT 0,
    preset_json  BLOB NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sf2_id, preset_type, program, kit, note)
);

CREATE INDEX IF NOT EXISTS idx_sf2_preset_cache_lookup
    ON sf2_preset_cache(sf2_id, preset_type, program, kit, note);
