// tests/instrument-scale-root-db.test.js
// Migration 032 adds `scale_root` (pitch class 0..11) to instruments_latency
// and instrument_voices. Round-trips it through the real SQLite DB for both the
// per-channel settings row and per-GM-voice overrides.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import Database from '../src/persistence/Database.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe('scale_root — DB round-trip (real SQLite)', () => {
  let tempDir;
  let database;
  const DEV = 'kalimba-dev';

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gmboop-scaleroot-test-'));
    database = new Database({
      logger: silentLogger(),
      config: { database: { path: join(tempDir, 'test.db') } }
    });
    database.ensureDevice(DEV, DEV, 'output');
  });

  afterAll(() => {
    try {
      database.close?.();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('settings default scale_root to 0 (C) when unspecified', () => {
    database.updateInstrumentSettings(DEV, 0, { name: DEV, octave_mode: 'diatonic' });
    const row = database.getInstrumentSettings(DEV, 0);
    expect(row.scale_root).toBe(0);
  });

  test('settings persist and read back a non-C root', () => {
    database.updateInstrumentSettings(DEV, 0, { scale_root: 7 }); // G
    const row = database.getInstrumentSettings(DEV, 0);
    expect(row.scale_root).toBe(7);
  });

  test('voices persist their own scale_root', () => {
    database.replaceInstrumentVoices(DEV, 0, [
      { gm_program: 12, octave_mode: 'pentatonic', scale_root: 2 }, // D
      { gm_program: 13, octave_mode: 'diatonic', scale_root: null }
    ]);
    const voices = database.listInstrumentVoices(DEV, 0);
    const byProgram = Object.fromEntries(voices.map((v) => [v.gm_program, v.scale_root]));
    expect(byProgram[12]).toBe(2);
    expect(byProgram[13]).toBeNull();
  });
});
