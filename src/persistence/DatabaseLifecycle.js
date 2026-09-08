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
 * How long a contended write waits for the lock before giving up with
 * `SQLITE_BUSY`.
 *
 * `better-sqlite3` is **synchronous**: the SQLite busy handler never yields to
 * the Node event loop, so this value is *literally* the worst-case freeze of
 * the whole process — WebSocket I/O and the MIDI scheduler included. Leaving it
 * unset inherits the driver default of 5 000 ms; the audit measured a 5 015 ms
 * event-loop gap (L07 §X05) and a 10 095 ms `/api/health` (L12 F-130, two
 * contended writes back to back).
 *
 * 250 ms is the trade-off: long enough to ride out a normal commit from a
 * second process (a `npm run migrate`, the backup job, an `sqlite3` shell),
 * short enough that a MIDI scheduler tick is late by an audible hiccup rather
 * than by a lost song. Anything longer than a bar at 120 BPM (2 000 ms) is a
 * stage failure, not a slow query. Callers that must survive a longer lock use
 * {@link module:src/persistence/busyRetry.runWithBusyRetry}, which retries
 * across `await` points so the event loop keeps running between attempts.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 250;

/**
 * Apply the pragmas every connection in this process must carry.
 *
 * Kept in one place so the server connection ({@link Database.connect}), the
 * one-shot migration CLI and the test harness cannot drift apart — the audit
 * found `busy_timeout` configured in *neither* of the two open sites.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{busyTimeoutMs?:number}} [options]
 * @returns {number} The busy timeout actually applied, in ms.
 */
export function applyConnectionPragmas(db, { busyTimeoutMs } = {}) {
  const timeout =
    Number.isFinite(busyTimeoutMs) && busyTimeoutMs >= 0
      ? Math.floor(busyTimeoutMs)
      : DEFAULT_BUSY_TIMEOUT_MS;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Explicit contract instead of the driver's implicit 5 s default (F-78/F-130).
  db.pragma(`busy_timeout = ${timeout}`);
  return timeout;
}

/**
 * Open and return a configured SQLite database connection. Runs
 * migrations automatically and ensures the schema is up to date.
 *
 * @param {string} dbPath - Path to the SQLite database file
 * @param {Object} logger - Logger instance
 * @param {{busyTimeoutMs?:number}} [options] - Connection tuning; see
 *   {@link DEFAULT_BUSY_TIMEOUT_MS}.
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbPath, logger, options = {}) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  const timeout = applyConnectionPragmas(db, options);
  logger.info(`Connected to database: ${dbPath} (busy_timeout=${timeout}ms)`);

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

  // Handle the pre-baseline upgrade path before gating on version numbers.
  reconcileLegacySchemaVersion(db, logger);

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

/**
 * Reconcile a pre-baseline database before the version-gated loop runs.
 *
 * `001_baseline.sql` records version 1; the post-baseline files reuse the
 * integer versions 2..N. A database written by the OLD migration chain (which
 * used the same `schema_version` integer table, versions 1..40) would therefore
 * gate out every post-baseline migration — leaving the new feature tables
 * absent and crashing at runtime (audit A3 UPGRADE-M1).
 *
 * Detection is precise and a strict no-op on fresh / new-baseline databases:
 * a new baseline stamps version 1 with a `"Baseline schema …"` description, so
 * we only act when a version-1 row exists whose description is something else
 * (i.e. written by the legacy chain). In that case we drop the stale rows >= 2
 * and let the runner re-apply the post-baseline migrations — they are all
 * `CREATE … IF NOT EXISTS` plus tolerated `ADD COLUMN`, so re-running is
 * idempotent — while leaving version 1 in place (baseline is NOT idempotent and
 * the legacy schema already carries its tables). Version 1's description is
 * rewritten to the baseline marker so this runs exactly once.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} logger
 * @returns {void}
 */
export function reconcileLegacySchemaVersion(db, logger) {
  let row;
  try {
    row = db.prepare('SELECT description FROM schema_version WHERE version = 1').get();
  } catch {
    return; // schema_version doesn't exist yet — fresh DB, baseline will create it
  }
  if (!row) return; // no version-1 row — baseline will insert it
  if (String(row.description || '').startsWith('Baseline schema')) return; // new-baseline DB

  logger.warn(
    'Detected a pre-baseline schema_version table (legacy upgrade path); reconciling by ' +
      're-applying post-baseline migrations idempotently (audit A3 UPGRADE-M1).'
  );
  const reconcile = db.transaction(() => {
    db.prepare('UPDATE schema_version SET description = ? WHERE version = 1').run(
      'Baseline schema (reconciled from a legacy pre-baseline database)'
    );
    db.prepare('DELETE FROM schema_version WHERE version >= 2').run();
  });
  reconcile();
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
