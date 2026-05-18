// tests/migrations-fresh-install.test.js
// Phase 5 — fresh-install smoke test for the migration runner.
//
// Guards the bug CLASS behind the (now-fixed) "two 016_ files share
// version 16, the second is silently skipped" incident: `runMigrations`
// keys applied state by the numeric filename prefix, so any duplicate
// prefix means a migration's SQL never executes on a fresh install.
//
// Strategy: run the REAL runner (DatabaseLifecycle.runMigrations) against
// a brand-new empty SQLite file and assert (a) prefixes are unique,
// (b) every file's version is recorded, (c) idempotent re-run, (d) the
// baseline schema actually materialised.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/persistence/DatabaseLifecycle.js';
import { readdirSync } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../migrations');
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

describe('migration runner — fresh install (real SQLite)', () => {
  let tempDir;
  let db;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gmboop-freshinstall-'));
    db = new BetterSqlite3(join(tempDir, 'fresh.db'));
    db.pragma('foreign_keys = ON');
  });

  afterAll(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('migration files have unique numeric prefixes (collision guard)', () => {
    const prefixes = migrationFiles().map((f) => parseInt(f.split('_')[0], 10));
    for (const p of prefixes) expect(Number.isFinite(p)).toBe(true);
    const dupes = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
    expect(dupes).toEqual([]); // any dupe ⇒ a migration would be silently skipped
  });

  test('fresh empty DB → all migrations applied, version = max file version', () => {
    runMigrations(db, silentLogger);

    const files = migrationFiles();
    const distinctVersions = new Set(files.map((f) => parseInt(f.split('_')[0], 10)));
    const maxFileVersion = Math.max(...distinctVersions);

    const recorded = db.prepare('SELECT version FROM schema_version').all().map((r) => r.version);
    const recordedSet = new Set(recorded);

    // Every file version must be recorded — no silent skip.
    for (const v of distinctVersions) expect(recordedSet.has(v)).toBe(true);
    const maxRecorded = db.prepare('SELECT MAX(version) v FROM schema_version').get().v;
    expect(maxRecorded).toBe(maxFileVersion);
    // 1 schema_version row per distinct migration version.
    expect(recordedSet.size).toBe(distinctVersions.size);
  });

  test('baseline schema materialised (sanity — not just schema_version)', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('schema_version');
    // 001_baseline creates the full app schema — expect a healthy table count.
    expect(tables.length).toBeGreaterThan(5);
  });

  test('runMigrations is idempotent (re-run is a no-op, no throw)', () => {
    const before = db.prepare('SELECT MAX(version) v, COUNT(*) c FROM schema_version').get();
    expect(() => runMigrations(db, silentLogger)).not.toThrow();
    const after = db.prepare('SELECT MAX(version) v, COUNT(*) c FROM schema_version').get();
    expect(after.v).toBe(before.v);
    expect(after.c).toBe(before.c);
  });
});
