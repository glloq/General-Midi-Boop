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

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

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
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)')
      .run(version, filename);
    db.exec('COMMIT');
    logger.info(`Migration ${version} completed`);
  } catch (error) {
    db.exec('ROLLBACK');
    logger.error(`Migration ${version} failed: ${error.message}`);
    throw error;
  }
}
