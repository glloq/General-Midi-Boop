-- Arrangements: ordered collections of loop blocks across multiple tracks.
-- An arrangement has N tracks; each track has M blocks placed at bar positions.
CREATE TABLE IF NOT EXISTS loop_arrangements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    global_tempo REAL    NOT NULL DEFAULT 120,
    total_bars   INTEGER NOT NULL DEFAULT 16,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loop_arrangement_tracks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    arrangement_id   INTEGER NOT NULL REFERENCES loop_arrangements(id) ON DELETE CASCADE,
    track_index      INTEGER NOT NULL,
    label            TEXT    NOT NULL DEFAULT '',
    midi_channel     INTEGER NOT NULL DEFAULT 1,
    UNIQUE(arrangement_id, track_index)
);

CREATE TABLE IF NOT EXISTS loop_arrangement_blocks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id     INTEGER NOT NULL REFERENCES loop_arrangement_tracks(id) ON DELETE CASCADE,
    loop_id      INTEGER NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    position_bar INTEGER NOT NULL DEFAULT 0,
    repetitions  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_arr_tracks_arrangement ON loop_arrangement_tracks(arrangement_id);
CREATE INDEX IF NOT EXISTS idx_arr_blocks_track       ON loop_arrangement_blocks(track_id);
