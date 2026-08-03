// tests/database-restore-reopen.test.js
// Regression guard (audit P3): restoreFromBackup used to close the connection
// and null `this.db` without reopening, leaving every sub-module holding a
// closed handle — the next DB access threw "database connection is not open".
// It must reopen and rebuild the sub-modules so the manager is usable again.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import Database from '../src/persistence/Database.js';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const silent = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

describe('Database.restoreFromBackup — reopens and rebuilds sub-modules', () => {
  let tempDir;
  let db;
  const DEV = 'restore-dev';

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gmboop-restore-test-'));
  });

  afterAll(() => {
    try {
      db?.close?.();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('the manager is fully usable after a restore (no closed-handle error)', () => {
    const dbPath = join(tempDir, 'live.db');
    db = new Database({ logger: silent(), config: { database: { path: dbPath } } });
    db.ensureDevice(DEV, DEV, 'output');

    // Build a clean backup: a second fully-migrated DB file, closed so it is a
    // consistent single-file snapshot.
    const backupPath = join(tempDir, 'backup.db');
    const src = new Database({ logger: silent(), config: { database: { path: backupPath } } });
    src.close();
    // Copy so the original backup file survives the restore (which overwrites live).
    const backupCopy = join(tempDir, 'backup-copy.db');
    copyFileSync(backupPath, backupCopy);

    db.restoreFromBackup(backupCopy);

    // Before the fix this threw "The database connection is not open".
    expect(() => db.ensureDevice(DEV, DEV, 'output')).not.toThrow();
    expect(() => db.getAllInstrumentCapabilities()).not.toThrow();
  });
});
