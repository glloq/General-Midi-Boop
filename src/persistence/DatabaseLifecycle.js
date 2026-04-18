/**
 * @file src/persistence/DatabaseLifecycle.js
 * @description Connection bootstrap helpers extracted from
 * `Database.js`. Owns the dance of opening the SQLite file with the
 * right pragmas (WAL, foreign keys), applying schema migrations, and
 * running the periodic backup / vacuum maintenance jobs.
 *
 * Pure helpers — no class state — so the same code can be reused by
 * one-shot scripts under `scripts/` (migrate, rollback, ...).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Open and return a configured SQLite database connection.
 * Runs migrations automatically and ensures the schema is up to date.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {Object} logger - Logger instance
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbPath, logger) {
  // Ensure data directory exists
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
 * Run all pending SQL migrations in order.
 */
export function runMigrations(db, logger) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      executed_at TEXT NOT NULL
    )
  `);

  const currentVersion = getCurrentVersion(db);
  logger.info(`Current database version: ${currentVersion}`);

  const migrationsDir = path.join(__dirname, '../../migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const version = parseInt(file.split('_')[0]);
    if (version > currentVersion) {
      runSingleMigration(db, logger, version, file, migrationsDir);
    }
  }

  logger.info('Migrations completed');
}

function getCurrentVersion(db) {
  try {
    const result = db.prepare('SELECT MAX(version) as version FROM migrations').get();
    return result.version || 0;
  } catch {
    return 0;
  }
}

function runSingleMigration(db, logger, version, filename, migrationsDir) {
  const filePath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(filePath, 'utf8');

  try {
    logger.info(`Running migration ${version}: ${filename}`);
    db.exec('BEGIN TRANSACTION');
    db.exec(sql);
    db.prepare('INSERT INTO migrations (version, name, executed_at) VALUES (?, ?, ?)')
      .run(version, filename, new Date().toISOString());
    db.exec('COMMIT');
    logger.info(`Migration ${version} completed`);
  } catch (error) {
    db.exec('ROLLBACK');
    logger.error(`Migration ${version} failed: ${error.message}`);
    throw error;
  }
}

/**
 * Rollback the last N migrations using down scripts.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} logger
 * @param {number} steps
 */
export function rollbackMigrations(db, logger, steps = 1) {
  const migrationsDir = path.join(__dirname, '../../migrations');
  const downDir = path.join(migrationsDir, 'down');

  if (!fs.existsSync(downDir)) {
    throw new Error('No down migrations directory found');
  }

  const applied = db
    .prepare('SELECT version, name FROM migrations ORDER BY version DESC LIMIT ?')
    .all(steps);

  if (applied.length === 0) {
    logger.info('No migrations to rollback');
    return;
  }

  // Pre-check: ensure ALL down migration files exist
  for (const migration of applied) {
    const downFile = path.join(downDir, migration.name);
    if (!fs.existsSync(downFile)) {
      throw new Error(`Down migration not found for ${migration.name}. Cannot rollback.`);
    }
  }

  for (const migration of applied) {
    const downFile = path.join(downDir, migration.name);
    const sql = fs.readFileSync(downFile, 'utf8');
    try {
      logger.info(`Rolling back migration ${migration.version}: ${migration.name}`);
      db.exec('BEGIN TRANSACTION');
      db.exec(sql);
      db.prepare('DELETE FROM migrations WHERE version = ?').run(migration.version);
      db.exec('COMMIT');
      logger.info(`Rollback of migration ${migration.version} completed`);
    } catch (error) {
      db.exec('ROLLBACK');
      logger.error(`Rollback of migration ${migration.version} failed: ${error.message}`);
      throw error;
    }
  }
}
