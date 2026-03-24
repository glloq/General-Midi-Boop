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
    this._running = false;

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
    if (this._running) {
      this.app.logger.warn('Backup already in progress, skipping');
      return;
    }
    this._running = true;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `midimind-${timestamp}.db`);

    try {
      await this.app.database.backup(backupPath);
      this.app.logger.info(`Scheduled backup completed: ${backupPath}`);
      this._pruneOldBackups();
    } catch (error) {
      this.app.logger.error(`Scheduled backup failed: ${error.message}`);
    } finally {
      this._running = false;
    }
  }

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
            this.app.logger.info(`Pruned old backup: ${file.name}`);
          } catch {
            // File may already be deleted
          }
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
