/**
 * @file src/persistence/DatabaseLifecycle.js
 * @description Connection bootstrap helpers extracted from
 * `Database.js`. Opens the SQLite file with the required pragmas
 * (WAL, foreign_keys) and applies schema migrations.
 *
 * Pure helpers — no class state — so the same code can be reused by
 * one-shot scripts under `scripts/`.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Open and return a configured SQLite database connection. Runs
 * migrations automatically and ensures the schema is up to date.
 *
 * @param {string} dbPath - Path to the SQLite database file
 * @param {Object} logger - Logger instance
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbPath, logger) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  logger.info(`Connected to database: ${dbPath}`);

  runMigrations(db, logger);
  return db;
}

/**
 * Run all pending SQL migrations in order. Baseline (001) creates
 * `schema_version`; every migration records itself there.
 */
export function runMigrations(db, logger) {
  const migrationsDir = path.join(__dirname, '../../migrations');
  if (!fs.existsSync(migrationsDir)) return;

  // Sort by the NUMERIC version prefix, not lexicographically: a string sort
  // is correct only while every prefix is zero-padded to the same width. A
  // future 4-digit ("1000_") or unpadded ("99_") prefix would otherwise apply
  // out of order and could run a migration before the table it depends on.
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b));

  for (const file of migrationFiles) {
    const version = parseInt(file.split('_')[0], 10);
    if (!Number.isFinite(version)) continue;
    if (hasMigration(db, version)) continue;
    runSingleMigration(db, logger, version, file, migrationsDir);
  }

  logger.info(`Migrations up to date (current version: ${getCurrentVersion(db)})`);
}

function getCurrentVersion(db) {
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

function hasMigration(db, version) {
  try {
    return Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version));
  } catch {
    return false;
  }
}

function runSingleMigration(db, logger, version, filename, migrationsDir) {
  const filePath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(filePath, 'utf8');

  logger.info(`Running migration ${version}: ${filename}`);

  // Fast path: execute the whole file in one transaction. This is the
  // ONLY path that correctly handles compound statements such as
  // `CREATE TRIGGER ... BEGIN ... END;` (001_baseline defines 15 of
  // them). The statement-splitter fallback below would break those
  // apart on the inner `;`.
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
      version,
      filename
    );
    db.exec('COMMIT');
    logger.info(`Migration ${version} completed`);
    return;
  } catch (error) {
    // Guard the rollback: if SQLite already auto-aborted the transaction, a bare
    // ROLLBACK throws "no transaction is active" and masks the real migration
    // error (audit A3 N2).
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction already rolled back */
    }
    if (!/duplicate column name/i.test(error.message)) {
      logger.error(`Migration ${version} failed: ${error.message}`);
      throw error;
    }
    logger.warn(
      `Migration ${version} (${filename}): a column already exists, retrying statement-by-statement`
    );
  }

  // Fallback: a differently-numbered copy of this migration already
  // added one of its columns (see 006_omni_mode.sql). Re-run each
  // top-level statement in isolation, tolerating `duplicate column
  // name` so the remaining DDL still applies. Migrations that reach
  // this path are plain ALTER/CREATE INDEX files — none use compound
  // triggers, so the naive splitter is safe here.
  try {
    db.exec('BEGIN TRANSACTION');
    for (const stmt of splitSqlStatements(sql)) {
      try {
        db.exec(stmt);
      } catch (error) {
        if (/duplicate column name/i.test(error.message)) {
          logger.warn(
            `Migration ${version} (${filename}): column already present, skipping statement`
          );
          continue;
        }
        throw error;
      }
    }
    db.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
      version,
      `${filename} (column already present)`
    );
    db.exec('COMMIT');
    logger.info(`Migration ${version} completed`);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction already rolled back */
    }
    logger.error(`Migration ${version} failed: ${error.message}`);
    throw error;
  }
}

/**
 * Split a migration SQL file into top-level statements for the
 * duplicate-column fallback path only. Strips `--` line and block
 * comments, then splits on `;`, tracking single/double quoted string
 * literals so semicolons inside them do not split. Does NOT understand
 * compound `BEGIN ... END` bodies — callers must run trigger-bearing
 * migrations through the whole-file fast path first.
 *
 * @param {string} sql
 * @returns {string[]} Trimmed statements ready for `db.exec()`.
 */
export function splitSqlStatements(sql) {
  const statements = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (!inSingle && !inDouble && c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (!inSingle && !inDouble && c === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      buf += c;
      i++;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      buf += c;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && c === ';') {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}
