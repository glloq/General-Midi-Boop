-- Sample loops created by the Loop Creator modal.
-- midi_data stores a JSON array of note objects compatible with webaudio-pianoroll
-- format: [{t, n, v, l}, ...] where t=tick, n=note, v=velocity, l=length in ticks.
CREATE TABLE IF NOT EXISTS loops (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    tempo            REAL    NOT NULL DEFAULT 120,
    time_sig_num     INTEGER NOT NULL DEFAULT 4,
    time_sig_den     INTEGER NOT NULL DEFAULT 4,
    bars             INTEGER NOT NULL DEFAULT 2,
    ppq              INTEGER NOT NULL DEFAULT 480,
    instrument_program INTEGER,
    midi_data        TEXT    NOT NULL DEFAULT '[]',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loops_updated_at ON loops(updated_at DESC);
