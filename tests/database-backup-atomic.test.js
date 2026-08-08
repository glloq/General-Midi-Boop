// tests/database-backup-atomic.test.js
// Audit A3 M2: Database.backup() must write to a temp path and rename into
// place only on success, so a mid-backup failure never leaves a partial file
// at the canonical name (which would pass restore validation and evict good
// backups via retention). Driven via prototype-call with a fake `this.db` so
// no real SQLite connection is required (native binding absent here).

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import DatabaseManager from '../src/persistence/Database.js';

const runBackup = (ctx, p) => DatabaseManager.prototype.backup.call(ctx, p);
const makeCtx = (backupImpl) => ({
  db: { backup: backupImpl },
  logger: { info() {}, warn() {}, error() {} }
});

describe('Database.backup — atomic temp+rename (audit A3 M2)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gmboop-bk-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('backs up to a temp path (not the final one) then renames on success', async () => {
    const finalPath = join(dir, 'gmboop-x.db');
    let destSeen = null;
    const ctx = makeCtx(async (dest) => {
      destSeen = dest;
      writeFileSync(dest, 'SNAPSHOT');
    });
    await runBackup(ctx, finalPath);
    expect(destSeen).toBe(`${finalPath}.tmp`); // wrote to temp, not final
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(finalPath, 'utf8')).toBe('SNAPSHOT');
    expect(existsSync(`${finalPath}.tmp`)).toBe(false); // temp renamed away
  });

  test('a failed backup leaves NO file at the final path and cleans the temp', async () => {
    const finalPath = join(dir, 'gmboop-y.db');
    const ctx = makeCtx(async (dest) => {
      writeFileSync(dest, 'PARTIAL'); // simulate a partial write to the temp...
      throw new Error('disk full'); // ...then fail
    });
    await expect(runBackup(ctx, finalPath)).rejects.toThrow('disk full');
    expect(existsSync(finalPath)).toBe(false); // no partial at the canonical name
    expect(existsSync(`${finalPath}.tmp`)).toBe(false); // temp cleaned up
  });
});
