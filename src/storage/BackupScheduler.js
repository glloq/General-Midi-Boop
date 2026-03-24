// src/storage/BackupScheduler.js
import schedule from 'node-schedule';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BACKUP_DIR = path.join(__dirname, '../../backups');
const DEFAULT_MAX_BACKUPS = 7;
const DEFAULT_CRON = '0 3 * * *'; // Daily at 3 AM

class BackupScheduler {
  constructor(app, options = {}) {
    this.app = app;
    this.backupDir = options.backupDir || DEFAULT_BACKUP_DIR;
    this.maxBackups = options.maxBackups || DEFAULT_MAX_BACKUPS;
    this.cronExpression = options.cron || DEFAULT_CRON;
    this.job = null;

    // Ensure backup directory exists
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  start() {
    this.job = schedule.scheduleJob(this.cronExpression, async () => {
      await this.runBackup();
    });
    this.app.logger.info(
      `Backup scheduler started (cron: ${this.cronExpression}, keep: ${this.maxBackups})`
    );
  }

  async runBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `midimind-${timestamp}.db`);

    try {
      await this.app.database.backup(backupPath);
      this.app.logger.info(`Scheduled backup completed: ${backupPath}`);
      this._pruneOldBackups();
    } catch (error) {
      this.app.logger.error(`Scheduled backup failed: ${error.message}`);
    }
  }

  _pruneOldBackups() {
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => f.startsWith('midimind-') && f.endsWith('.db'))
        .map((f) => ({
          name: f,
          path: path.join(this.backupDir, f),
          mtime: fs.statSync(path.join(this.backupDir, f)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > this.maxBackups) {
        const toDelete = files.slice(this.maxBackups);
        for (const file of toDelete) {
          fs.unlinkSync(file.path);
          this.app.logger.info(`Pruned old backup: ${file.name}`);
        }
      }
    } catch (error) {
      this.app.logger.error(`Backup pruning failed: ${error.message}`);
    }
  }

  stop() {
    if (this.job) {
      this.job.cancel();
      this.job = null;
      this.app.logger.info('Backup scheduler stopped');
    }
  }
}

export default BackupScheduler;
