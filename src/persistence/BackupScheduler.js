/**
 * @file src/persistence/BackupScheduler.js
 * @description Periodic SQLite backup scheduler. Uses `node-schedule`
 * cron expressions to snapshot the database file into `backups/` and
 * prune older backups beyond a configurable retention count. Started
 * by `Application#start` and registered as `backupScheduler` in the
 * DI container.
 *
 * Failure modes are logged but never thrown — backup failures should
 * never crash the running application.
 */
import schedule from 'node-schedule';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BACKUP_DIR = path.join(__dirname, '../../backups');
/** Default retention count — older backups are pruned by mtime. */
const DEFAULT_MAX_BACKUPS = 7;
/** Default cron — daily at 03:00 server time. */
const DEFAULT_CRON = '0 3 * * *';

class BackupScheduler {
  /**
   * @param {Object} deps - Needs `logger`, `database`.
   * @param {Object} [options] - Override defaults: `{backupDir,
   *   maxBackups, cron}`.
   */
  constructor(deps, options = {}) {
    this.logger = deps.logger;
    this.database = deps.database;
    this.backupDir = options.backupDir || DEFAULT_BACKUP_DIR;
    this.maxBackups = options.maxBackups || DEFAULT_MAX_BACKUPS;
    this.cronExpression = options.cron || DEFAULT_CRON;
    this.job = null;
    this._running = false;

    // Ensure backup directory exists
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Schedule the cron job. Idempotent only if `stop()` is called first.
   * @returns {void}
   */
  start() {
    this.job = schedule.scheduleJob(this.cronExpression, async () => {
      await this.runBackup();
    });
    this.logger.info(
      `Backup scheduler started (cron: ${this.cronExpression}, keep: ${this.maxBackups})`
    );
  }

  /**
   * Take a single backup snapshot. Concurrency-guarded by `_running`
   * so two overlapping cron firings cannot collide on disk.
   * @returns {Promise<void>}
   */
  async runBackup() {
    if (this._running) {
      this.logger.warn('Backup already in progress, skipping');
      return;
    }
    this._running = true;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `midimind-${timestamp}.db`);

    try {
      await this.database.backup(backupPath);
      this.logger.info(`Scheduled backup completed: ${backupPath}`);
      this._pruneOldBackups();
    } catch (error) {
      this.logger.error(`Scheduled backup failed: ${error.message}`);
    } finally {
      this._running = false;
    }
  }

  /**
   * Delete backup files beyond `maxBackups`, keeping the newest by
   * mtime. Failures (file already deleted, permission error) are
   * logged and skipped.
   * @returns {void}
   * @private
   */
  _pruneOldBackups() {
    try {
      const files = [];
      for (const name of fs.readdirSync(this.backupDir)) {
        if (!name.startsWith('midimind-') || !name.endsWith('.db')) continue;
        const filePath = path.join(this.backupDir, name);
        try {
          const stat = fs.statSync(filePath);
          files.push({ name, path: filePath, mtime: stat.mtimeMs });
        } catch {
          // File may have been deleted between readdir and stat
        }
      }

      files.sort((a, b) => b.mtime - a.mtime);

      if (files.length > this.maxBackups) {
        for (const file of files.slice(this.maxBackups)) {
          try {
            fs.unlinkSync(file.path);
            this.logger.info(`Pruned old backup: ${file.name}`);
          } catch {
            // File may already be deleted
          }
        }
      }
    } catch (error) {
      this.logger.error(`Backup pruning failed: ${error.message}`);
    }
  }

  /**
   * Cancel the scheduled job. Safe to call when not running.
   * @returns {void}
   */
  stop() {
    if (this.job) {
      this.job.cancel();
      this.job = null;
      this.logger.info('Backup scheduler stopped');
    }
  }
}

export default BackupScheduler;
