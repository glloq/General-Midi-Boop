/**
 * @file src/persistence/BackupScheduler.js
 * @description Periodic SQLite backup scheduler. Uses `node-schedule`
 * cron expressions to snapshot the database file into `backups/` and
 * prune older backups beyond a configurable retention count. Started
 * by `Application#start` and registered as `backupScheduler` in the
 * DI container.
 *
 * Each snapshot is paired with a `*.manifest.json` sidecar listing every
 * blob the DB references (`content_hash`, `blob_path`, on-disk size,
 * `exists` flag). Bytes themselves live under `data/midi/` and are NOT
 * copied — backups stay small. The manifest lets a restore operator
 * spot which MIDI files have lost their bytes (because the operator
 * restored only the DB, or because a blob was orphaned and GC'd) and
 * re-upload them deliberately.
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
   * @param {Object} deps - Needs `logger`, `database`. `blobStore` is
   *   optional but required for the manifest sidecar.
   * @param {Object} [options] - Override defaults: `{backupDir,
   *   maxBackups, cron}`.
   */
  constructor(deps, options = {}) {
    this.logger = deps.logger;
    this.database = deps.database;
    this.blobStore = deps.blobStore || null;
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
    const backupPath = path.join(this.backupDir, `gmboop-${timestamp}.db`);
    const manifestPath = path.join(this.backupDir, `gmboop-${timestamp}.manifest.json`);

    try {
      await this.database.backup(backupPath);
      this.logger.info(`Scheduled backup completed: ${backupPath}`);
      this._writeManifest(manifestPath, backupPath);
      this._pruneOldBackups();
      this._gcOrphanBlobs();
    } catch (error) {
      this.logger.error(`Scheduled backup failed: ${error.message}`);
    } finally {
      this._running = false;
    }
  }

  /**
   * Sweep blob files no DB row references anymore. Runs inside the scheduled
   * backup — the intended quiescent maintenance window per BlobStore.gcOrphans'
   * race note — so it never contends with live uploads. Without this the
   * orphan GC was never scheduled and deleted/replaced-file blobs accumulated
   * forever (audit P2). Best-effort: failures are logged, not thrown.
   * @returns {void}
   * @private
   */
  _gcOrphanBlobs() {
    if (
      !this.blobStore ||
      typeof this.blobStore.gcOrphans !== 'function' ||
      !this.database?.midiDB
    ) {
      return;
    }
    try {
      const referenced = new Set(
        this.database.midiDB.listBlobsForManifest().map((r) => r.blob_path)
      );
      // Safety floor: an empty referenced set makes gcOrphans treat EVERY blob
      // as an orphan. A transient/partial query result must never trigger a mass
      // wipe of every stored MIDI file, so skip GC when nothing is referenced —
      // a genuinely file-free install has no blobs worth collecting anyway, and
      // any real orphans are swept on the next run once ≥1 file exists (audit
      // A3 MED1).
      if (referenced.size === 0) {
        this.logger.warn('Blob GC skipped: 0 referenced blobs (guard against mass deletion)');
        return;
      }
      const { scanned, deleted } = this.blobStore.gcOrphans((rel) => referenced.has(rel));
      if (deleted > 0) {
        this.logger.info(`Blob GC: removed ${deleted} orphaned blob(s) of ${scanned} scanned`);
      } else {
        this.logger.debug(`Blob GC: no orphans (${scanned} scanned)`);
      }
    } catch (err) {
      this.logger.warn(`Blob GC failed: ${err.message}`);
    }
  }

  /**
   * Walk the file table and stat each blob on disk; write a JSON
   * sidecar so a restore operator knows exactly which bytes are
   * missing. Failures are non-fatal — the DB snapshot is the truth,
   * the manifest is just an aid.
   *
   * @param {string} manifestPath
   * @param {string} backupPath - DB snapshot path, embedded for context.
   * @returns {void}
   * @private
   */
  _writeManifest(manifestPath, backupPath) {
    if (!this.blobStore || !this.database || !this.database.midiDB) {
      this.logger.debug('Skipping backup manifest: blobStore or midiDB unavailable');
      return;
    }
    try {
      const rows = this.database.midiDB.listBlobsForManifest();
      const blobs = [];
      const missing = [];
      let dbSize = 0;
      try {
        dbSize = fs.statSync(backupPath).size;
      } catch {
        /* ignore */
      }

      for (const row of rows) {
        let exists = false;
        let onDiskSize = null;
        try {
          const abs = path.join(this.blobStore.baseDir, row.blob_path);
          const stat = fs.statSync(abs);
          exists = true;
          onDiskSize = stat.size;
        } catch {
          /* blob missing */
        }

        const entry = {
          fileId: row.id,
          filename: row.filename,
          contentHash: row.content_hash,
          blobPath: row.blob_path,
          dbSize: row.size,
          onDiskSize,
          exists
        };
        blobs.push(entry);
        if (!exists) missing.push({ fileId: row.id, blobPath: row.blob_path });
      }

      const manifest = {
        timestamp: new Date().toISOString(),
        dbBackup: path.basename(backupPath),
        dbSize,
        blobCount: blobs.length,
        missingCount: missing.length,
        blobs,
        missingBlobs: missing
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      this.logger.info(
        `Backup manifest written: ${manifestPath} (${blobs.length} blobs, ${missing.length} missing)`
      );
    } catch (error) {
      this.logger.error(`Backup manifest failed: ${error.message}`);
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
        if (!name.startsWith('gmboop-') || !name.endsWith('.db')) continue;
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
          // Best-effort delete of the matching manifest sidecar.
          const manifestPath = file.path.replace(/\.db$/, '.manifest.json');
          try {
            fs.unlinkSync(manifestPath);
          } catch {
            // Manifest may not exist or already pruned.
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
