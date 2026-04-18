// tests/midi-filter.test.js
// Comprehensive tests for the MIDI file filter system
// Split into sections: DB filters, FileCommands handler, FilterManager client

import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createHash } from 'crypto';

let Database;
let betterSqliteAvailable = false;
try {
  Database = (await import('better-sqlite3')).default;
  betterSqliteAvailable = true;
} catch {
  // Native bindings not available — DB tests will be skipped
}

const describeIfSqlite = betterSqliteAvailable ? describe : describe.skip;
import MidiDatabase from '../src/persistence/tables/MidiDatabase.js';

// ============================================================
// Test helpers
// ============================================================

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

function createTestDb() {
  const db = new Database(':memory:');

  // Schema mirrors migrations/001_baseline.sql for the tables this
  // suite touches. Kept inline (rather than reading the SQL file) so
  // the test stays self-contained, but the column shape MUST stay in
  // sync with the baseline (content_hash UNIQUE NOT NULL, blob_path
  // NOT NULL, no `data` column).
  db.exec(`
    CREATE TABLE midi_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT '/',
      blob_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      tracks INTEGER NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      tempo REAL NOT NULL DEFAULT 120,
      ppq INTEGER NOT NULL DEFAULT 480,
      channel_count INTEGER NOT NULL DEFAULT 0,
      note_range_min INTEGER,
      note_range_max INTEGER,
      instrument_types TEXT NOT NULL DEFAULT '[]',
      has_drums BOOLEAN NOT NULL DEFAULT 0,
      has_melody BOOLEAN NOT NULL DEFAULT 0,
      has_bass BOOLEAN NOT NULL DEFAULT 0,
      is_original BOOLEAN NOT NULL DEFAULT 1,
      parent_file_id INTEGER,
      uploaded_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE midi_file_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      midi_file_id INTEGER NOT NULL,
      channel INTEGER NOT NULL,
      primary_program INTEGER,
      gm_instrument_name TEXT,
      gm_category TEXT,
      estimated_type TEXT,
      type_confidence INTEGER DEFAULT 0,
      note_range_min INTEGER,
      note_range_max INTEGER,
      total_notes INTEGER DEFAULT 0,
      polyphony_max INTEGER DEFAULT 0,
      polyphony_avg REAL DEFAULT 0,
      density REAL DEFAULT 0,
      track_names TEXT DEFAULT '[]',
      FOREIGN KEY (midi_file_id) REFERENCES midi_files(id) ON DELETE CASCADE,
      UNIQUE(midi_file_id, channel)
    );

    CREATE TABLE midi_instrument_routings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      midi_file_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      instrument_name TEXT,
      device_id TEXT,
      channel INTEGER,
      enabled BOOLEAN DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      compatibility_score REAL,
      transposition_applied INTEGER DEFAULT 0,
      auto_assigned BOOLEAN DEFAULT 0,
      assignment_reason TEXT,
      note_remapping TEXT,
      FOREIGN KEY (midi_file_id) REFERENCES midi_files(id) ON DELETE CASCADE
    );

    CREATE TABLE instruments_latency (
      id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      channel INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT 'Unnamed',
      latency_ms INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT 1,
      note_range_min INTEGER,
      note_range_max INTEGER,
      instrument_type TEXT DEFAULT 'unknown',
      instrument_subtype TEXT,
      note_selection_mode TEXT DEFAULT 'range',
      selected_notes TEXT,
      gm_program INTEGER,
      polyphony INTEGER DEFAULT 16
    );
  `);

  return db;
}

function seedTestData(db) {
  // 8 test MIDI files
  const files = [
    // id=1
    {
      filename: 'piano_sonata.mid',
      size: 5000,
      tracks: 4,
      duration: 240,
      tempo: 120,
      ppq: 480,
      uploaded_at: '2026-01-15T10:00:00Z',
      folder: '/classical',
      is_original: 1,
      instrument_types: '["Piano"]',
      channel_count: 3,
      has_drums: 0,
      has_melody: 1,
      has_bass: 0
    },
    // id=2
    {
      filename: 'rock_anthem.mid',
      size: 8000,
      tracks: 6,
      duration: 180,
      tempo: 140,
      ppq: 480,
      uploaded_at: '2026-02-10T10:00:00Z',
      folder: '/rock',
      is_original: 1,
      instrument_types: '["Piano","Drums","Bass","Guitar"]',
      channel_count: 5,
      has_drums: 1,
      has_melody: 1,
      has_bass: 1
    },
    // id=3
    {
      filename: 'jazz_combo.mid',
      size: 6000,
      tracks: 5,
      duration: 300,
      tempo: 100,
      ppq: 480,
      uploaded_at: '2026-03-01T10:00:00Z',
      folder: '/jazz',
      is_original: 1,
      instrument_types: '["Piano","Bass","Drums"]',
      channel_count: 4,
      has_drums: 1,
      has_melody: 1,
      has_bass: 1
    },
    // id=4
    {
      filename: 'simple_melody.mid',
      size: 1000,
      tracks: 2,
      duration: 60,
      tempo: 90,
      ppq: 480,
      uploaded_at: '2026-03-15T10:00:00Z',
      folder: '/pop',
      is_original: 1,
      instrument_types: '["Piano"]',
      channel_count: 1,
      has_drums: 0,
      has_melody: 1,
      has_bass: 0
    },
    // id=5 (adapted copy of rock_anthem)
    {
      filename: 'rock_anthem_adapted.mid',
      size: 8000,
      tracks: 6,
      duration: 180,
      tempo: 140,
      ppq: 480,
      uploaded_at: '2026-02-11T10:00:00Z',
      folder: '/rock',
      is_original: 0,
      parent_file_id: 2,
      instrument_types: '["Piano","Drums","Bass","Guitar"]',
      channel_count: 5,
      has_drums: 1,
      has_melody: 1,
      has_bass: 1
    },
    // id=6
    {
      filename: 'orchestral_suite.mid',
      size: 15000,
      tracks: 10,
      duration: 600,
      tempo: 80,
      ppq: 480,
      uploaded_at: '2026-01-01T10:00:00Z',
      folder: '/classical/baroque',
      is_original: 1,
      instrument_types: '["Strings","Brass","Woodwinds"]',
      channel_count: 8,
      has_drums: 0,
      has_melody: 1,
      has_bass: 1
    },
    // id=7
    {
      filename: 'drum_solo.mid',
      size: 3000,
      tracks: 2,
      duration: 120,
      tempo: 160,
      ppq: 480,
      uploaded_at: '2026-03-20T10:00:00Z',
      folder: '/jazz',
      is_original: 1,
      instrument_types: '["Drums"]',
      channel_count: 1,
      has_drums: 1,
      has_melody: 0,
      has_bass: 0
    },
    // id=8
    {
      filename: 'synth_pad.mid',
      size: 4000,
      tracks: 3,
      duration: 90,
      tempo: 110,
      ppq: 480,
      uploaded_at: '2026-02-20T10:00:00Z',
      folder: '/electronic',
      is_original: 1,
      instrument_types: '["Synth"]',
      channel_count: 2,
      has_drums: 0,
      has_melody: 1,
      has_bass: 0
    }
  ];

  const insertFile = db.prepare(`
    INSERT INTO midi_files (
      content_hash, blob_path, filename, size, tracks, duration, tempo, ppq,
      uploaded_at, folder, is_original, parent_file_id,
      instrument_types, channel_count, has_drums, has_melody, has_bass
    ) VALUES (
      @content_hash, @blob_path, @filename, @size, @tracks, @duration, @tempo, @ppq,
      @uploaded_at, @folder, @is_original, @parent_file_id,
      @instrument_types, @channel_count, @has_drums, @has_melody, @has_bass
    )
  `);

  // Synthesize a unique content_hash + blob_path per row from the
  // filename, so fixtures stay deterministic without needing a real
  // BlobStore.
  for (const f of files) {
    const hash = createHash('sha256').update(f.filename).digest('hex');
    insertFile.run({
      parent_file_id: null,
      content_hash: hash,
      blob_path: `midi/${hash.slice(0, 2)}/${hash}.mid`,
      ...f
    });
  }

  // midi_file_channels
  const insertChannel = db.prepare(`
    INSERT INTO midi_file_channels (midi_file_id, channel, primary_program, gm_instrument_name, gm_category, note_range_min, note_range_max, total_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // File 1: piano only
  insertChannel.run(1, 0, 0, 'Acoustic Grand Piano', 'Piano', 36, 84, 200);
  // File 2: piano + bass + drums + guitar
  insertChannel.run(2, 0, 0, 'Acoustic Grand Piano', 'Piano', 36, 84, 150);
  insertChannel.run(2, 1, 33, 'Electric Bass (finger)', 'Bass', 28, 55, 100);
  insertChannel.run(2, 9, 0, 'Standard Kit', 'Percussion', 35, 81, 300);
  insertChannel.run(2, 3, 25, 'Acoustic Guitar (nylon)', 'Guitar', 40, 76, 120);
  // File 3: piano + bass + drums
  insertChannel.run(3, 0, 0, 'Acoustic Grand Piano', 'Piano', 36, 84, 180);
  insertChannel.run(3, 1, 32, 'Acoustic Bass', 'Bass', 28, 55, 90);
  insertChannel.run(3, 9, 0, 'Standard Kit', 'Percussion', 35, 81, 250);
  // File 4: piano only
  insertChannel.run(4, 0, 0, 'Acoustic Grand Piano', 'Piano', 48, 72, 50);
  // File 5: same as file 2 channels
  insertChannel.run(5, 0, 0, 'Acoustic Grand Piano', 'Piano', 36, 84, 150);
  insertChannel.run(5, 1, 33, 'Electric Bass (finger)', 'Bass', 28, 55, 100);
  insertChannel.run(5, 9, 0, 'Standard Kit', 'Percussion', 35, 81, 300);
  insertChannel.run(5, 3, 25, 'Acoustic Guitar (nylon)', 'Guitar', 40, 76, 120);
  // File 6: strings + brass + woodwinds
  insertChannel.run(6, 0, 48, 'String Ensemble 1', 'Strings', 36, 84, 400);
  insertChannel.run(6, 1, 56, 'Trumpet', 'Brass', 52, 84, 200);
  insertChannel.run(6, 2, 68, 'Oboe', 'Pipe', 58, 91, 150);
  // File 7: drums only
  insertChannel.run(7, 9, 0, 'Standard Kit', 'Percussion', 35, 81, 500);
  // File 8: synth
  insertChannel.run(8, 0, 88, 'Pad 1 (new age)', 'Synth Pad', 36, 72, 80);

  // midi_instrument_routings
  const insertRouting = db.prepare(`
    INSERT INTO midi_instrument_routings (midi_file_id, track_id, instrument_name, device_id, channel, enabled, compatibility_score, auto_assigned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // File 1: NO routings (unrouted)

  // File 2: 5 enabled routings, all score=100 (playable: routedCount=5 >= channelCount=5, minScore=100)
  insertRouting.run(2, 0, 'Piano', 'dev_A', 0, 1, 100, 0);
  insertRouting.run(2, 1, 'Bass', 'dev_B', 1, 1, 100, 0);
  insertRouting.run(2, 2, 'Drums', 'dev_C', 9, 1, 100, 0);
  insertRouting.run(2, 3, 'Guitar', 'dev_D', 3, 1, 100, 0);
  insertRouting.run(2, 4, 'Guitar2', 'dev_E', 4, 1, 100, 0);

  // File 3: 2 enabled routings out of 4 channels (partial)
  insertRouting.run(3, 0, 'Piano', 'dev_A', 0, 1, 100, 0);
  insertRouting.run(3, 1, 'Bass', 'dev_B', 1, 1, 90, 0);

  // File 4: 1 routing, channelCount=1, score=80 (routed_incomplete: routedCount>=channelCount, minScore<100)
  insertRouting.run(4, 0, 'Piano', 'dev_A', 0, 1, 80, 0);

  // File 5: 5 routings, all auto_assigned=1, score=90 (routed_incomplete + auto_assigned)
  insertRouting.run(5, 0, 'Piano', 'dev_A', 0, 1, 90, 1);
  insertRouting.run(5, 1, 'Bass', 'dev_B', 1, 1, 90, 1);
  insertRouting.run(5, 2, 'Drums', 'dev_C', 9, 1, 90, 1);
  insertRouting.run(5, 3, 'Guitar', 'dev_D', 3, 1, 90, 1);
  insertRouting.run(5, 4, 'Guitar2', 'dev_E', 4, 1, 90, 1);

  // File 6: NO routings (unrouted)
  // File 7: 1 routing, channelCount=1, score=100 (playable)
  insertRouting.run(7, 0, 'Drums', 'dev_C', 9, 1, 100, 0);
  // File 8: NO routings (unrouted)

  // instruments_latency
  const insertInstr = db.prepare(`
    INSERT INTO instruments_latency (id, device_id, channel, name, note_range_min, note_range_max)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertInstr.run('inst_1', 'dev_A', 0, 'Piano', 21, 108); // wide piano range
  insertInstr.run('inst_2', 'dev_B', 1, 'Bass', 28, 55); // bass range
}

// ============================================================
// SECTION 1: MidiDatabase.filterFiles — Simple filters
// ============================================================

describeIfSqlite('MidiDatabase.filterFiles', () => {
  let db;
  let midiDb;

  beforeAll(() => {
    db = createTestDb();
    seedTestData(db);
    midiDb = new MidiDatabase(db, mockLogger);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- No filters ---
  test('no filters returns all 8 files', () => {
    const results = midiDb.filterFiles({});
    expect(results).toHaveLength(8);
  });

  // --- Filename ---
  test('filename partial match', () => {
    const results = midiDb.filterFiles({ filename: 'rock' });
    expect(results.map((f) => f.id).sort()).toEqual([2, 5]);
  });

  test('filename case-insensitive (SQLite LIKE is case-insensitive for ASCII)', () => {
    const results = midiDb.filterFiles({ filename: 'PIANO' });
    expect(results.map((f) => f.id)).toEqual([1]);
  });

  // --- Folder ---
  test('folder exact match', () => {
    const results = midiDb.filterFiles({ folder: '/rock' });
    expect(results.map((f) => f.id).sort()).toEqual([2, 5]);
  });

  test('folder with subfolders', () => {
    const results = midiDb.filterFiles({ folder: '/classical', includeSubfolders: true });
    expect(results.map((f) => f.id).sort()).toEqual([1, 6]);
  });

  test('folder without subfolders excludes subfolders', () => {
    const results = midiDb.filterFiles({ folder: '/classical', includeSubfolders: false });
    expect(results.map((f) => f.id)).toEqual([1]);
  });

  // --- Duration ---
  test('durationMin filter', () => {
    const results = midiDb.filterFiles({ durationMin: 200 });
    expect(results.map((f) => f.id).sort()).toEqual([1, 3, 6]);
  });

  test('durationMax filter', () => {
    const results = midiDb.filterFiles({ durationMax: 100 });
    expect(results.map((f) => f.id).sort()).toEqual([4, 8]);
  });

  test('duration range', () => {
    const results = midiDb.filterFiles({ durationMin: 100, durationMax: 200 });
    expect(results.map((f) => f.id).sort()).toEqual([2, 5, 7]);
  });

  // --- Tempo ---
  test('tempoMin filter', () => {
    const results = midiDb.filterFiles({ tempoMin: 140 });
    expect(results.map((f) => f.id).sort()).toEqual([2, 5, 7]);
  });

  test('tempoMax filter', () => {
    const results = midiDb.filterFiles({ tempoMax: 100 });
    expect(results.map((f) => f.id).sort()).toEqual([3, 4, 6]);
  });

  // --- Tracks ---
  test('tracksMin filter', () => {
    const results = midiDb.filterFiles({ tracksMin: 5 });
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 5, 6]);
  });

  test('tracksMax filter', () => {
    const results = midiDb.filterFiles({ tracksMax: 2 });
    expect(results.map((f) => f.id).sort()).toEqual([4, 7]);
  });

  // --- Channel count ---
  test('channel count range', () => {
    const results = midiDb.filterFiles({ channelCountMin: 4, channelCountMax: 5 });
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 5]);
  });

  // --- Upload date ---
  test('uploadedAfter filter', () => {
    const results = midiDb.filterFiles({ uploadedAfter: '2026-03-01T00:00:00Z' });
    expect(results.map((f) => f.id).sort()).toEqual([3, 4, 7]);
  });

  test('uploadedBefore filter', () => {
    const results = midiDb.filterFiles({ uploadedBefore: '2026-01-31T23:59:59Z' });
    expect(results.map((f) => f.id).sort()).toEqual([1, 6]);
  });

  // --- isOriginal ---
  test('isOriginal true', () => {
    const results = midiDb.filterFiles({ isOriginal: true });
    const ids = results.map((f) => f.id).sort();
    expect(ids).toEqual([1, 2, 3, 4, 6, 7, 8]);
  });

  test('isOriginal false', () => {
    const results = midiDb.filterFiles({ isOriginal: false });
    expect(results.map((f) => f.id)).toEqual([5]);
  });

  // --- Boolean quick filters ---
  test('hasDrums true', () => {
    const results = midiDb.filterFiles({ hasDrums: true });
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 5, 7]);
  });

  test('hasDrums false', () => {
    const results = midiDb.filterFiles({ hasDrums: false });
    expect(results.map((f) => f.id).sort()).toEqual([1, 4, 6, 8]);
  });

  test('hasMelody true', () => {
    const results = midiDb.filterFiles({ hasMelody: true });
    expect(results.map((f) => f.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 8]);
  });

  test('hasBass true', () => {
    const results = midiDb.filterFiles({ hasBass: true });
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 5, 6]);
  });

  // --- Instrument types (legacy broad categories) ---
  test('instrumentTypes ANY single', () => {
    const results = midiDb.filterFiles({ instrumentTypes: ['Piano'], instrumentMode: 'ANY' });
    expect(results.map((f) => f.id).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('instrumentTypes ANY multiple', () => {
    const results = midiDb.filterFiles({
      instrumentTypes: ['Piano', 'Drums'],
      instrumentMode: 'ANY'
    });
    expect(results.map((f) => f.id).sort()).toEqual([1, 2, 3, 4, 5, 7]);
  });

  test('instrumentTypes ALL', () => {
    const results = midiDb.filterFiles({
      instrumentTypes: ['Piano', 'Bass'],
      instrumentMode: 'ALL'
    });
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 5]);
  });

  test('instrumentTypes EXACT single', () => {
    const results = midiDb.filterFiles({ instrumentTypes: ['Piano'], instrumentMode: 'EXACT' });
    expect(results.map((f) => f.id).sort()).toEqual([1, 4]);
  });

  test('instrumentTypes EXACT multiple', () => {
    const results = midiDb.filterFiles({
      instrumentTypes: ['Piano', 'Bass', 'Drums'],
      instrumentMode: 'EXACT'
    });
    expect(results.map((f) => f.id)).toEqual([3]);
  });

  // --- GM instrument filters ---
  test('gmInstruments ANY', () => {
    const results = midiDb.filterFiles({ gmInstruments: ['Acoustic Grand Piano'], gmMode: 'ANY' });
    expect(results.map((f) => f.id).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('gmInstruments ALL', () => {
    const results = midiDb.filterFiles({
      gmInstruments: ['Acoustic Grand Piano', 'Electric Bass (finger)'],
      gmMode: 'ALL'
    });
    expect(results.map((f) => f.id).sort()).toEqual([2, 5]);
  });

  test('gmCategories ANY', () => {
    const results = midiDb.filterFiles({ gmCategories: ['Piano', 'Bass'], gmMode: 'ANY' });
    expect(results.map((f) => f.id).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('gmCategories ALL', () => {
    const results = midiDb.filterFiles({ gmCategories: ['Piano', 'Bass'], gmMode: 'ALL' });
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 5]);
  });

  test('gmPrograms ANY', () => {
    const results = midiDb.filterFiles({ gmPrograms: [0], gmMode: 'ANY' });
    // program 0 = piano channels + drums standard kit (also program 0 on ch9)
    const ids = results.map((f) => f.id).sort();
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  test('gmPrograms ALL', () => {
    const results = midiDb.filterFiles({ gmPrograms: [0, 33], gmMode: 'ALL' });
    // program 0 AND program 33: files 2 and 5
    expect(results.map((f) => f.id).sort()).toEqual([2, 5]);
  });

  // --- Sorting ---
  test('default sort is uploaded_at DESC', () => {
    const results = midiDb.filterFiles({});
    const ids = results.map((f) => f.id);
    // Most recent first: 7(Mar20), 4(Mar15), 3(Mar01), 8(Feb20), 5(Feb11), 2(Feb10), 1(Jan15), 6(Jan01)
    expect(ids).toEqual([7, 4, 3, 8, 5, 2, 1, 6]);
  });

  test('sort by filename ASC', () => {
    const results = midiDb.filterFiles({ sortBy: 'filename', sortOrder: 'ASC' });
    const names = results.map((f) => f.filename);
    // Verify each name is <= the next (SQLite binary collation)
    for (let i = 1; i < names.length; i++) {
      expect(names[i] >= names[i - 1]).toBe(true);
    }
  });

  test('sort by duration DESC', () => {
    const results = midiDb.filterFiles({ sortBy: 'duration', sortOrder: 'DESC' });
    const durations = results.map((f) => f.duration);
    expect(durations).toEqual([600, 300, 240, 180, 180, 120, 90, 60]);
  });

  test('invalid sortBy falls back to uploaded_at DESC', () => {
    const results = midiDb.filterFiles({ sortBy: 'DROP TABLE midi_files;--', sortOrder: 'ASC' });
    const defaultResults = midiDb.filterFiles({});
    expect(results.map((f) => f.id)).toEqual(defaultResults.map((f) => f.id));
  });

  test('invalid sortOrder falls back to DESC', () => {
    const results = midiDb.filterFiles({ sortBy: 'filename', sortOrder: 'INVALID' });
    const names = results.map((f) => f.filename);
    // Verify each name is >= the next (DESC, SQLite binary collation)
    for (let i = 1; i < names.length; i++) {
      expect(names[i] <= names[i - 1]).toBe(true);
    }
  });

  // --- Pagination ---
  test('limit only', () => {
    const results = midiDb.filterFiles({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  test('limit + offset', () => {
    const allResults = midiDb.filterFiles({});
    const results = midiDb.filterFiles({ limit: 2, offset: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(allResults[2].id);
    expect(results[1].id).toBe(allResults[3].id);
  });

  // --- Routing status ---
  test('routingStatus unrouted', () => {
    const results = midiDb.filterFiles({ routingStatus: 'unrouted' });
    // Files 1, 6, 8 have no routings
    expect(results.map((f) => f.id).sort()).toEqual([1, 6, 8]);
  });

  test('routingStatus partial', () => {
    const results = midiDb.filterFiles({ routingStatus: 'partial' });
    // File 3: 2 routings out of 4 channels
    expect(results.map((f) => f.id)).toEqual([3]);
  });

  test('routingStatus playable', () => {
    const results = midiDb.filterFiles({ routingStatus: 'playable' });
    // Files 2, 7: all routed with minScore=100
    expect(results.map((f) => f.id).sort()).toEqual([2, 7]);
  });

  test('routingStatus routed_incomplete', () => {
    const results = midiDb.filterFiles({ routingStatus: 'routed_incomplete' });
    // Files 4, 5: all routed but minScore < 100
    expect(results.map((f) => f.id).sort()).toEqual([4, 5]);
  });

  test('routingStatus auto_assigned', () => {
    const results = midiDb.filterFiles({ routingStatus: 'auto_assigned' });
    // File 5: has auto_assigned=1 routings
    expect(results.map((f) => f.id)).toEqual([5]);
  });

  test('multiple routingStatuses', () => {
    const results = midiDb.filterFiles({ routingStatuses: ['unrouted', 'partial'] });
    expect(results.map((f) => f.id).sort()).toEqual([1, 3, 6, 8]);
  });

  test('invalid routing status throws', () => {
    expect(() => midiDb.filterFiles({ routingStatus: 'invalid' })).toThrow('Invalid routingStatus');
  });

  // --- Legacy hasRouting ---
  test('hasRouting true', () => {
    const results = midiDb.filterFiles({ hasRouting: true });
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 4, 5, 7]);
  });

  test('hasRouting false', () => {
    const results = midiDb.filterFiles({ hasRouting: false });
    expect(results.map((f) => f.id).sort()).toEqual([1, 6, 8]);
  });

  // --- minCompatibilityScore ---
  test('minCompatibilityScore with hasRouting', () => {
    const results = midiDb.filterFiles({ hasRouting: true, minCompatibilityScore: 95 });
    // AVG score >= 95: files 2(avg=100), 3(avg=95), 7(avg=100)
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 7]);
  });

  // --- Playable on instruments ---
  test('playableOnInstruments routed mode', () => {
    const results = midiDb.filterFiles({
      playableOnInstruments: ['inst_1'],
      playableMode: 'routed'
    });
    // inst_1 has device_id=dev_A, files with routing to dev_A: 2, 3, 4, 5
    expect(results.map((f) => f.id).sort()).toEqual([2, 3, 4, 5]);
  });

  test('playableOnInstruments compatible mode', () => {
    const results = midiDb.filterFiles({
      playableOnInstruments: ['inst_2'],
      playableMode: 'compatible'
    });
    // inst_2 range 28-55, channels with overlapping ranges exist in files with bass/low notes
    const ids = results.map((f) => f.id);
    expect(ids.length).toBeGreaterThan(0);
    // Files with channels in bass range: 2,3,5 (bass channels 28-55), also 1,4,6 have channels overlapping
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  // --- Combined filters ---
  test('hasDrums + tempoMin combined', () => {
    const results = midiDb.filterFiles({ hasDrums: true, tempoMin: 140 });
    expect(results.map((f) => f.id).sort()).toEqual([2, 5, 7]);
  });

  test('folder + instrumentTypes combined', () => {
    const results = midiDb.filterFiles({
      folder: '/rock',
      instrumentTypes: ['Piano'],
      instrumentMode: 'ANY'
    });
    expect(results.map((f) => f.id).sort()).toEqual([2, 5]);
  });

  test('all simple filters at once', () => {
    const results = midiDb.filterFiles({
      filename: 'rock',
      folder: '/rock',
      durationMin: 100,
      tempoMin: 130,
      hasDrums: true,
      isOriginal: true
    });
    expect(results.map((f) => f.id)).toEqual([2]);
  });

  // --- Edge cases ---
  test('empty results', () => {
    const results = midiDb.filterFiles({ filename: 'nonexistent' });
    expect(results).toEqual([]);
  });

  test('SQL injection via filename is parameterized', () => {
    const results = midiDb.filterFiles({ filename: "'; DROP TABLE midi_files; --" });
    expect(results).toEqual([]);
    // Verify table still exists
    const count = db.prepare('SELECT COUNT(*) as c FROM midi_files').get().c;
    expect(count).toBe(8);
  });

  test('SQL injection via sortBy is sanitized', () => {
    const results = midiDb.filterFiles({ sortBy: 'filename; DROP TABLE midi_files;--' });
    expect(results).toHaveLength(8);
    const count = db.prepare('SELECT COUNT(*) as c FROM midi_files').get().c;
    expect(count).toBe(8);
  });
});

// ============================================================
// SECTION 2: FileCommands.fileFilter handler
// ============================================================

describeIfSqlite('FileCommands.fileFilter (via register)', () => {
  let fileFilterHandler;

  beforeAll(async () => {
    // Capture the handler by mocking the registry
    const mockRegistry = {
      handlers: {},
      register(name, handler) {
        this.handlers[name] = handler;
      }
    };

    // Shared mock function — assertions against `_mockApp.database.filterFiles`
    // still work because it's the exact same jest.fn() aliased to both shapes.
    // After the P0-2.5d repository migration, FileCommands calls
    // `app.fileRepository.filter(filters)` instead of `app.database.filterFiles`.
    const filterMock = jest.fn(() => []);

    const mockApp = {
      database: {
        filterFiles: filterMock,
        searchFiles: jest.fn(() => []),
        getFile: jest.fn(),
        getFiles: jest.fn(() => []),
        getAllFiles: jest.fn(() => []),
        getFileChannels: jest.fn(() => []),
        getDistinctInstruments: jest.fn(() => []),
        getDistinctCategories: jest.fn(() => []),
        getRoutingsByFile: jest.fn(() => [])
      },
      fileRepository: {
        filter: filterMock,
        search: jest.fn(() => []),
        findById: jest.fn(),
        getChannels: jest.fn(() => []),
        countNeedingReanalysis: jest.fn(() => 0),
        getDistinctInstruments: jest.fn(() => []),
        getDistinctCategories: jest.fn(() => [])
      },
      fileManager: {
        reanalyzeAllFiles: jest.fn(async () => ({ processed: 0, errors: 0 })),
        _batchGetRoutingStatus: jest.fn(() => new Map()),
        formatFileSize: jest.fn((n) => `${n}B`),
        formatDuration: jest.fn((n) => `${n}s`)
      }
    };

    const { register } = await import('../src/api/commands/FileCommands.js');
    register(mockRegistry, mockApp);
    fileFilterHandler = mockRegistry.handlers['file_filter'];

    // Store mockApp for later access
    fileFilterHandler._mockApp = mockApp;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fileFilterHandler._mockApp.database.filterFiles.mockReturnValue([]);
  });

  test('handler is registered', () => {
    expect(fileFilterHandler).toBeDefined();
    expect(typeof fileFilterHandler).toBe('function');
  });

  test('passes through all filter fields', async () => {
    const data = {
      filename: 'test',
      folder: '/jazz',
      includeSubfolders: true,
      durationMin: 60,
      durationMax: 300,
      tempoMin: 80,
      tempoMax: 160,
      tracksMin: 2,
      tracksMax: 10,
      uploadedAfter: '2026-01-01T00:00:00Z',
      uploadedBefore: '2026-12-31T23:59:59Z',
      instrumentTypes: ['Piano'],
      instrumentMode: 'ALL',
      channelCountMin: 2,
      channelCountMax: 8,
      hasRouting: true,
      isOriginal: true,
      minCompatibilityScore: 80,
      gmInstruments: ['Acoustic Grand Piano'],
      gmCategories: ['Piano'],
      gmPrograms: [0],
      gmMode: 'ALL',
      routingStatus: 'playable',
      routingStatuses: ['playable', 'partial'],
      playableOnInstruments: ['inst_1'],
      playableMode: 'compatible',
      hasDrums: true,
      hasMelody: false,
      hasBass: true,
      sortBy: 'duration',
      sortOrder: 'ASC',
      limit: 10,
      offset: 5
    };

    await fileFilterHandler(data);

    const mockFn = fileFilterHandler._mockApp.database.filterFiles;
    expect(mockFn).toHaveBeenCalledTimes(1);
    const filters = mockFn.mock.calls[0][0];

    expect(filters.filename).toBe('test');
    expect(filters.folder).toBe('/jazz');
    expect(filters.includeSubfolders).toBe(true);
    expect(filters.durationMin).toBe(60);
    expect(filters.durationMax).toBe(300);
    expect(filters.instrumentTypes).toEqual(['Piano']);
    expect(filters.instrumentMode).toBe('ALL');
    expect(filters.gmInstruments).toEqual(['Acoustic Grand Piano']);
    expect(filters.gmMode).toBe('ALL');
    expect(filters.routingStatus).toBe('playable');
    expect(filters.playableOnInstruments).toEqual(['inst_1']);
    expect(filters.playableMode).toBe('compatible');
    expect(filters.hasDrums).toBe(true);
    expect(filters.hasMelody).toBe(false);
    expect(filters.hasBass).toBe(true);
    expect(filters.sortBy).toBe('duration');
    expect(filters.sortOrder).toBe('ASC');
    expect(filters.limit).toBe(10);
    expect(filters.offset).toBe(5);
  });

  test('cleans undefined/null/empty values', async () => {
    const data = {
      filename: null,
      folder: '',
      instrumentTypes: [],
      tempoMin: undefined
    };

    await fileFilterHandler(data);

    const filters = fileFilterHandler._mockApp.database.filterFiles.mock.calls[0][0];
    expect(filters.filename).toBeUndefined();
    expect(filters.folder).toBeUndefined();
    expect(filters.instrumentTypes).toBeUndefined();
    expect(filters.tempoMin).toBeUndefined();
  });

  test('defaults instrumentMode to ANY', async () => {
    await fileFilterHandler({ instrumentTypes: ['Piano'] });
    const filters = fileFilterHandler._mockApp.database.filterFiles.mock.calls[0][0];
    expect(filters.instrumentMode).toBe('ANY');
  });

  test('defaults gmMode to ANY', async () => {
    await fileFilterHandler({ gmInstruments: ['Acoustic Grand Piano'] });
    const filters = fileFilterHandler._mockApp.database.filterFiles.mock.calls[0][0];
    expect(filters.gmMode).toBe('ANY');
  });

  test('validates limit must be positive integer', async () => {
    await fileFilterHandler({ limit: -1 });
    const filters = fileFilterHandler._mockApp.database.filterFiles.mock.calls[0][0];
    expect(filters.limit).toBeUndefined();
  });

  test('validates limit must be integer', async () => {
    await fileFilterHandler({ limit: 3.5 });
    const filters = fileFilterHandler._mockApp.database.filterFiles.mock.calls[0][0];
    expect(filters.limit).toBeUndefined();
  });

  test('validates offset must be non-negative integer', async () => {
    await fileFilterHandler({ offset: -1 });
    const filters = fileFilterHandler._mockApp.database.filterFiles.mock.calls[0][0];
    expect(filters.offset).toBeUndefined();
  });

  test('returns correct response shape', async () => {
    fileFilterHandler._mockApp.database.filterFiles.mockReturnValue([
      { id: 1, filename: 'a.mid' },
      { id: 2, filename: 'b.mid' }
    ]);

    const result = await fileFilterHandler({});
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(typeof result.filters).toBe('string');
  });

  test('empty filters summary says none', async () => {
    const result = await fileFilterHandler({});
    expect(result.filters).toBe('none');
  });

  test('builds filter summary string correctly', async () => {
    const result = await fileFilterHandler({
      filename: 'test',
      folder: '/jazz',
      durationMin: 60,
      tempoMax: 120
    });
    expect(result.filters).toContain('filename: "test"');
    expect(result.filters).toContain('folder: "/jazz"');
    expect(result.filters).toContain('duration:');
    expect(result.filters).toContain('tempo:');
  });

  test('filter summary with GM instruments', async () => {
    const result = await fileFilterHandler({
      gmInstruments: ['Acoustic Grand Piano'],
      gmMode: 'ALL'
    });
    expect(result.filters).toContain('GM instruments: Acoustic Grand Piano (ALL)');
  });

  test('filter summary with routingStatus', async () => {
    const result = await fileFilterHandler({ routingStatus: 'playable' });
    expect(result.filters).toContain('routing status: playable');
  });

  test('filter summary with playableOnInstruments', async () => {
    const result = await fileFilterHandler({
      playableOnInstruments: ['inst_1', 'inst_2'],
      playableMode: 'compatible'
    });
    expect(result.filters).toContain('playable on:');
    expect(result.filters).toContain('compatible');
  });

  test('sets playableMode only when playableOnInstruments is populated', async () => {
    await fileFilterHandler({ playableMode: 'compatible' });
    const filters = fileFilterHandler._mockApp.database.filterFiles.mock.calls[0][0];
    expect(filters.playableMode).toBeUndefined();
  });

  test('total matches files.length', async () => {
    fileFilterHandler._mockApp.database.filterFiles.mockReturnValue([
      { id: 1 },
      { id: 2 },
      { id: 3 }
    ]);
    const result = await fileFilterHandler({});
    expect(result.total).toBe(3);
    expect(result.total).toBe(result.files.length);
  });
});

// ============================================================
// SECTION 3: FilterManager (client-side)
// ============================================================

describe('FilterManager', () => {
  let FilterManager;
  let fm;
  let mockApi;

  beforeAll(async () => {
    // Setup globals needed by FilterManager
    globalThis.localStorage = {
      store: {},
      getItem: jest.fn((key) => globalThis.localStorage.store[key] || null),
      setItem: jest.fn((key, value) => {
        globalThis.localStorage.store[key] = value;
      }),
      clear: jest.fn(() => {
        globalThis.localStorage.store = {};
      })
    };
    globalThis.window = { i18n: null };

    // FilterManager is a browser script with module.exports guard — load via CJS helper
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const loadFilterManager = require('./helpers/loadFilterManager.cjs');
    FilterManager = loadFilterManager();
  });

  beforeEach(() => {
    globalThis.localStorage.store = {};
    globalThis.localStorage.getItem.mockClear();
    globalThis.localStorage.setItem.mockClear();

    mockApi = { sendCommand: jest.fn() };
    fm = new FilterManager(mockApi);
  });

  // --- Filter state management ---

  describe('filter state management', () => {
    test('getDefaultFilters returns expected shape', () => {
      const defaults = fm.getDefaultFilters();
      expect(defaults).toHaveProperty('filename', '');
      expect(defaults).toHaveProperty('folder', null);
      expect(defaults).toHaveProperty('includeSubfolders', false);
      expect(defaults).toHaveProperty('durationMin', null);
      expect(defaults).toHaveProperty('durationMax', null);
      expect(defaults).toHaveProperty('tempoMin', null);
      expect(defaults).toHaveProperty('tempoMax', null);
      expect(defaults).toHaveProperty('instrumentTypes');
      expect(Array.isArray(defaults.instrumentTypes)).toBe(true);
      expect(defaults).toHaveProperty('instrumentMode', 'ANY');
      expect(defaults).toHaveProperty('gmInstruments');
      expect(defaults).toHaveProperty('gmCategories');
      expect(defaults).toHaveProperty('gmPrograms');
      expect(defaults).toHaveProperty('gmMode', 'ANY');
      expect(defaults).toHaveProperty('sortBy', 'uploaded_at');
      expect(defaults).toHaveProperty('sortOrder', 'DESC');
      expect(defaults).toHaveProperty('routingStatuses');
      expect(defaults).toHaveProperty('playableOnInstruments');
      expect(defaults).toHaveProperty('playableMode', 'routed');
    });

    test('setFilter updates value', () => {
      fm.setFilter('filename', 'test');
      expect(fm.getFilter('filename')).toBe('test');
    });

    test('setFilter invalidates cache', () => {
      fm.cache.set('key1', [{ id: 1 }]);
      expect(fm.cache.size).toBe(1);
      fm.setFilter('filename', 'test');
      expect(fm.cache.size).toBe(0);
    });

    test('setFilter with debounce delays update', async () => {
      fm.setFilter('filename', 'delayed', true);
      expect(fm.getFilter('filename')).toBe(''); // not set immediately
      // Wait for debounce (300ms + margin)
      await new Promise((r) => setTimeout(r, 350));
      expect(fm.getFilter('filename')).toBe('delayed');
    });

    test('resetFilters restores defaults', () => {
      fm.setFilter('filename', 'test');
      fm.setFilter('durationMin', 60);
      fm.resetFilters();
      expect(fm.getFilter('filename')).toBe('');
      expect(fm.getFilter('durationMin')).toBeNull();
    });

    test('resetFilter resets single key', () => {
      fm.setFilter('filename', 'test');
      fm.setFilter('durationMin', 60);
      fm.resetFilter('filename');
      expect(fm.getFilter('filename')).toBe('');
      expect(fm.getFilter('durationMin')).toBe(60);
    });

    test('hasActiveFilters detects active filters', () => {
      expect(fm.hasActiveFilters()).toBe(false);
      fm.setFilter('durationMin', 60);
      expect(fm.hasActiveFilters()).toBe(true);
    });

    test('hasActiveFilters ignores sort/pagination', () => {
      fm.setFilter('sortBy', 'filename');
      fm.setFilter('sortOrder', 'ASC');
      fm.setFilter('limit', 10);
      fm.setFilter('offset', 5);
      expect(fm.hasActiveFilters()).toBe(false);
    });

    test('hasActiveFilters handles arrays', () => {
      fm.setFilter('instrumentTypes', ['Piano']);
      expect(fm.hasActiveFilters()).toBe(true);
      fm.setFilter('instrumentTypes', []);
      expect(fm.hasActiveFilters()).toBe(false);
    });

    test('getActiveFilters returns list', () => {
      fm.setFilter('filename', 'test');
      fm.setFilter('durationMin', 60);
      const active = fm.getActiveFilters();
      expect(active.length).toBe(2);
      expect(active.find((f) => f.key === 'filename')).toBeDefined();
      expect(active.find((f) => f.key === 'durationMin')).toBeDefined();
    });

    test('getFilters returns copy', () => {
      const filters = fm.getFilters();
      filters.filename = 'modified';
      expect(fm.getFilter('filename')).toBe(''); // original unchanged
    });
  });

  // --- needsServerFiltering ---

  describe('needsServerFiltering', () => {
    test('returns false for simple filters only', () => {
      fm.setFilter('filename', 'test');
      fm.setFilter('folder', '/jazz');
      fm.setFilter('durationMin', 60);
      fm.setFilter('tempoMax', 120);
      expect(fm.needsServerFiltering()).toBe(false);
    });

    test('returns true for instrumentTypes', () => {
      fm.setFilter('instrumentTypes', ['Piano']);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for gmInstruments', () => {
      fm.setFilter('gmInstruments', ['Acoustic Grand Piano']);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for gmCategories', () => {
      fm.setFilter('gmCategories', ['Piano']);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for gmPrograms', () => {
      fm.setFilter('gmPrograms', [0]);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for hasRouting', () => {
      fm.setFilter('hasRouting', true);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for routingStatus', () => {
      fm.setFilter('routingStatus', 'playable');
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for routingStatuses array', () => {
      fm.setFilter('routingStatuses', ['unrouted', 'partial']);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for playableOnInstruments', () => {
      fm.setFilter('playableOnInstruments', ['inst_1']);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for minCompatibilityScore', () => {
      fm.setFilter('minCompatibilityScore', 80);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for channelCountMin', () => {
      fm.setFilter('channelCountMin', 2);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for hasDrums', () => {
      fm.setFilter('hasDrums', true);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for hasMelody', () => {
      fm.setFilter('hasMelody', true);
      expect(fm.needsServerFiltering()).toBe(true);
    });

    test('returns true for hasBass', () => {
      fm.setFilter('hasBass', true);
      expect(fm.needsServerFiltering()).toBe(true);
    });
  });

  // --- Client-side filtering ---

  describe('applyClientFilters', () => {
    const testFiles = [
      {
        id: 1,
        filename: 'piano_sonata.mid',
        folder: '/classical',
        duration: 240,
        tempo: 120,
        tracks: 4,
        uploaded_at: '2026-01-15T10:00:00Z',
        is_original: 1
      },
      {
        id: 2,
        filename: 'rock_anthem.mid',
        folder: '/rock',
        duration: 180,
        tempo: 140,
        tracks: 6,
        uploaded_at: '2026-02-10T10:00:00Z',
        is_original: 1
      },
      {
        id: 3,
        filename: 'jazz_combo.mid',
        folder: '/jazz',
        duration: 300,
        tempo: 100,
        tracks: 5,
        uploaded_at: '2026-03-01T10:00:00Z',
        is_original: 1
      },
      {
        id: 4,
        filename: 'simple_melody.mid',
        folder: '/pop',
        duration: 60,
        tempo: 90,
        tracks: 2,
        uploaded_at: '2026-03-15T10:00:00Z',
        is_original: 0
      }
    ];

    test('returns empty for empty input', () => {
      expect(fm.applyClientFilters([])).toEqual([]);
    });

    test('returns empty for null input', () => {
      expect(fm.applyClientFilters(null)).toEqual([]);
    });

    test('filters by filename case-insensitive', () => {
      fm.setFilter('filename', 'PIANO');
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id)).toEqual([1]);
    });

    test('filters by folder exact match', () => {
      fm.setFilter('folder', '/rock');
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id)).toEqual([2]);
    });

    test('filters by folder with subfolders', () => {
      const filesWithSub = [
        ...testFiles,
        {
          id: 5,
          filename: 'baroque.mid',
          folder: '/classical/baroque',
          duration: 600,
          tempo: 80,
          tracks: 10,
          uploaded_at: '2026-01-01T10:00:00Z',
          is_original: 1
        }
      ];
      fm.setFilter('folder', '/classical');
      fm.setFilter('includeSubfolders', true);
      const result = fm.applyClientFilters(filesWithSub);
      expect(result.map((f) => f.id).sort()).toEqual([1, 5]);
    });

    test('filters by duration range', () => {
      fm.setFilter('durationMin', 100);
      fm.setFilter('durationMax', 200);
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id)).toEqual([2]);
    });

    test('filters by tempo range', () => {
      fm.setFilter('tempoMin', 100);
      fm.setFilter('tempoMax', 130);
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id).sort()).toEqual([1, 3]);
    });

    test('filters by track count range', () => {
      fm.setFilter('tracksMin', 5);
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id).sort()).toEqual([2, 3]);
    });

    test('filters by upload date range', () => {
      fm.setFilter('uploadedAfter', '2026-02-01T00:00:00Z');
      fm.setFilter('uploadedBefore', '2026-02-28T23:59:59Z');
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id)).toEqual([2]);
    });

    test('filters by isOriginal', () => {
      fm.setFilter('isOriginal', false);
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id)).toEqual([4]);
    });

    test('combined client filters', () => {
      fm.setFilter('durationMin', 100);
      fm.setFilter('tempoMin', 110);
      fm.setFilter('isOriginal', true);
      const result = fm.applyClientFilters(testFiles);
      expect(result.map((f) => f.id).sort()).toEqual([1, 2]);
    });
  });

  // --- Sorting ---

  describe('sortFiles', () => {
    const files = [
      { id: 1, filename: 'beta.mid', duration: 100, uploaded_at: '2026-01-01T00:00:00Z' },
      { id: 2, filename: 'alpha.mid', duration: 300, uploaded_at: '2026-03-01T00:00:00Z' },
      { id: 3, filename: 'gamma.mid', duration: 200, uploaded_at: '2026-02-01T00:00:00Z' }
    ];

    test('sorts by string field ASC', () => {
      fm.setFilter('sortBy', 'filename');
      fm.setFilter('sortOrder', 'ASC');
      const sorted = fm.sortFiles(files);
      expect(sorted.map((f) => f.filename)).toEqual(['alpha.mid', 'beta.mid', 'gamma.mid']);
    });

    test('sorts by numeric field DESC', () => {
      fm.setFilter('sortBy', 'duration');
      fm.setFilter('sortOrder', 'DESC');
      const sorted = fm.sortFiles(files);
      expect(sorted.map((f) => f.duration)).toEqual([300, 200, 100]);
    });

    test('default sort is uploaded_at DESC', () => {
      const sorted = fm.sortFiles(files);
      expect(sorted.map((f) => f.id)).toEqual([2, 3, 1]);
    });

    test('handles undefined values in sort', () => {
      const filesWithUndef = [
        { id: 1, filename: 'a.mid' },
        { id: 2, filename: 'b.mid', duration: 100 }
      ];
      fm.setFilter('sortBy', 'duration');
      fm.setFilter('sortOrder', 'DESC');
      const sorted = fm.sortFiles(filesWithUndef);
      expect(sorted[0].id).toBe(2); // 100 > 0 (undefined -> 0)
    });
  });

  // --- Cache ---

  describe('cache behavior', () => {
    test('cache invalidated on filter change', () => {
      fm.cache.set('key1', [{ id: 1 }]);
      fm.setFilter('filename', 'test');
      expect(fm.cache.size).toBe(0);
    });

    test('LRU eviction at max size', () => {
      for (let i = 0; i < 21; i++) {
        fm.addToCache(`key_${i}`, [{ id: i }]);
      }
      expect(fm.cache.size).toBe(20);
      expect(fm.cache.has('key_0')).toBe(false); // first evicted
      expect(fm.cache.has('key_20')).toBe(true);
    });

    test('getCacheKey is deterministic', () => {
      fm.setFilter('filename', 'test');
      const key1 = fm.getCacheKey();
      const key2 = fm.getCacheKey();
      expect(key1).toBe(key2);
    });
  });

  // --- Presets ---

  describe('presets', () => {
    test('savePreset stores current filters', () => {
      fm.setFilter('filename', 'test');
      fm.savePreset('myPreset');
      const presets = fm.getPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe('myPreset');
      expect(presets[0].filters.filename).toBe('test');
    });

    test('loadPreset restores filters', () => {
      fm.setFilter('filename', 'test');
      fm.setFilter('durationMin', 60);
      fm.savePreset('myPreset');

      fm.resetFilters();
      expect(fm.getFilter('filename')).toBe('');

      const loaded = fm.loadPreset('myPreset');
      expect(loaded).toBe(true);
      expect(fm.getFilter('filename')).toBe('test');
      expect(fm.getFilter('durationMin')).toBe(60);
    });

    test('loadPreset returns false for unknown name', () => {
      expect(fm.loadPreset('nonexistent')).toBe(false);
    });

    test('deletePreset removes preset', () => {
      fm.savePreset('toDelete');
      expect(fm.getPresets()).toHaveLength(1);
      const deleted = fm.deletePreset('toDelete');
      expect(deleted).toBe(true);
      expect(fm.getPresets()).toHaveLength(0);
    });

    test('deletePreset returns false for unknown', () => {
      expect(fm.deletePreset('nonexistent')).toBe(false);
    });

    test('presets persist to localStorage', () => {
      fm.savePreset('persisted');
      expect(globalThis.localStorage.setItem).toHaveBeenCalledWith(
        'midiFilterPresets',
        expect.any(String)
      );
    });

    test('presets loaded from localStorage on construction', () => {
      const presetData = [{ name: 'loaded', filters: fm.getDefaultFilters() }];
      globalThis.localStorage.store['midiFilterPresets'] = JSON.stringify(presetData);
      const fm2 = new FilterManager(mockApi);
      expect(fm2.getPresets()).toHaveLength(1);
      expect(fm2.getPresets()[0].name).toBe('loaded');
    });

    test('deep copy prevents mutation', () => {
      fm.setFilter('filename', 'original');
      fm.savePreset('safe');
      fm.setFilter('filename', 'changed');
      const preset = fm.getPresets().find((p) => p.name === 'safe');
      expect(preset.filters.filename).toBe('original');
    });
  });

  // --- Quick filters ---

  describe('quick filters', () => {
    test('recent sets uploadedAfter to ~7 days ago', () => {
      fm.applyQuickFilter('recent');
      const val = fm.getFilter('uploadedAfter');
      expect(val).toBeTruthy();
      const date = new Date(val);
      const diff = Date.now() - date.getTime();
      // Should be approximately 7 days (allow 1 minute tolerance)
      expect(diff).toBeGreaterThan(6.99 * 24 * 60 * 60 * 1000);
      expect(diff).toBeLessThan(7.01 * 24 * 60 * 60 * 1000);
    });

    test('short sets durationMax=60', () => {
      fm.applyQuickFilter('short');
      expect(fm.getFilter('durationMax')).toBe(60);
    });

    test('piano sets gmCategories', () => {
      fm.applyQuickFilter('piano');
      expect(fm.getFilter('gmCategories')).toEqual(['Piano']);
    });

    test('routed sets hasRouting=true', () => {
      fm.applyQuickFilter('routed');
      expect(fm.getFilter('hasRouting')).toBe(true);
    });

    test('quick filter resets other filters first', () => {
      fm.setFilter('filename', 'should_be_cleared');
      fm.applyQuickFilter('short');
      expect(fm.getFilter('filename')).toBe('');
      expect(fm.getFilter('durationMax')).toBe(60);
    });

    test('unknown quick filter does not crash', () => {
      expect(() => fm.applyQuickFilter('nonexistent')).not.toThrow();
    });
  });

  // --- Callbacks and lifecycle ---

  describe('callbacks and lifecycle', () => {
    test('onFilterChange called on setFilter', () => {
      const cb = jest.fn();
      fm.onFilterChange = cb;
      fm.setFilter('filename', 'test');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ filename: 'test' }));
    });

    test('onFilterChange called on resetFilters', () => {
      const cb = jest.fn();
      fm.onFilterChange = cb;
      fm.resetFilters();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('onFilterApplied called after client filter', () => {
      const cb = jest.fn();
      fm.onFilterApplied = cb;
      fm.applyClientFilters([
        {
          id: 1,
          filename: 'a.mid',
          folder: '/',
          duration: 60,
          tempo: 120,
          tracks: 1,
          uploaded_at: '2026-01-01',
          is_original: 1
        }
      ]);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('destroy clears timers and cache', () => {
      fm.cache.set('key', []);
      fm.onFilterChange = jest.fn();
      fm.onFilterApplied = jest.fn();
      fm.destroy();
      expect(fm.cache.size).toBe(0);
      expect(fm.onFilterChange).toBeNull();
      expect(fm.onFilterApplied).toBeNull();
    });
  });
});
