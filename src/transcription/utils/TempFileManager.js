/**
 * @file src/transcription/utils/TempFileManager.js
 * @description Per-job scratch space under `data/transcription/tmp/<job-id>/`
 * (§21), with the two properties that matter on an appliance: nothing escapes
 * the root, and nothing survives a crash.
 *
 * Every path a job uses is built here and checked against the root, so a
 * job id or a filename coming from a user can never reach outside the
 * scratch tree (§40 — path traversal, symlink attacks). Directories from a
 * previous run that was killed mid-job are swept at startup.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { TranscriptionError, TRANSCRIPTION_REASONS } from '../TranscriptionError.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** Scratch directories older than this are considered abandoned. */
export const STALE_AGE_MS = 6 * 60 * 60 * 1000;

/** A job id must be a single, boring path segment. */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** So must every file created inside a job directory. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Validate a job id before it becomes a directory name.
 * @param {string} jobId
 * @returns {string} The same id.
 * @throws {TypeError} When it could escape the scratch root.
 */
export function assertSafeJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new TypeError(`Unsafe transcription job id: ${JSON.stringify(jobId)}`);
  }
  return jobId;
}

/**
 * Validate a file name before it is joined to a job directory.
 * @param {string} name
 * @returns {string} The same name.
 * @throws {TypeError} When it contains a separator or a traversal segment.
 */
export function assertSafeFileName(name) {
  if (typeof name !== 'string' || !FILE_NAME_PATTERN.test(name) || name.includes('..')) {
    throw new TypeError(`Unsafe transcription file name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Handle on one job's scratch directory. Every path it hands out is inside
 * the directory, and `cleanup()` is safe to call more than once.
 */
export class JobWorkspace {
  /**
   * @param {Object} options
   * @param {string} options.jobId
   * @param {string} options.dir - Absolute path, already created.
   * @param {TempFileManager} options.manager
   */
  constructor({ jobId, dir, manager }) {
    this.jobId = jobId;
    this.dir = dir;
    this._manager = manager;
    this._cleaned = false;
  }

  /**
   * Absolute path of a file inside this workspace.
   * @param {string} name - Plain file name, no separators.
   * @returns {string}
   */
  file(name) {
    return path.join(this.dir, assertSafeFileName(name));
  }

  /**
   * Total bytes currently held by this workspace.
   * @returns {Promise<number>}
   */
  async sizeBytes() {
    return directorySize(this.dir);
  }

  /**
   * Remove the workspace. Honours `keepFiles` (debugging) by leaving the
   * directory in place and saying so in the log.
   * @returns {Promise<void>}
   */
  async cleanup() {
    if (this._cleaned) return;
    this._cleaned = true;
    await this._manager.removeJobDir(this.jobId);
  }
}

/** Owns the scratch tree for transcription jobs. */
export class TempFileManager {
  /**
   * @param {Object} options
   * @param {string} options.root - Absolute `<dataDir>/tmp`.
   * @param {Object} [options.logger]
   * @param {boolean} [options.keepFiles=false] - Keep workspaces after a job.
   * @param {number} [options.maxTotalBytes=0] - Refuse a new job past this
   *   much scratch usage; 0 disables the check.
   */
  constructor({ root, logger, keepFiles = false, maxTotalBytes = 0 } = {}) {
    if (!root || !path.isAbsolute(root)) {
      throw new Error('TempFileManager: an absolute root is required');
    }
    this.root = path.resolve(root);
    this.logger = logger || NULL_LOGGER;
    this.keepFiles = !!keepFiles;
    this.maxTotalBytes = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : 0;
  }

  /**
   * Assert that `candidate` resolves inside the scratch root. The guard is
   * on the RESOLVED path, so `..` segments and absolute paths are both
   * caught, and symlinks are resolved when the entry exists.
   *
   * @param {string} candidate
   * @returns {string} The resolved, contained path.
   * @throws {TypeError} When the path escapes the root.
   */
  assertContained(candidate) {
    const resolved = path.resolve(candidate);
    const real = realPathIfExists(resolved);
    const rootReal = realPathIfExists(this.root);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new TypeError(`Path escapes the transcription scratch root: ${candidate}`);
    }
    return resolved;
  }

  /**
   * Create (or reuse) the workspace of one job.
   *
   * @param {string} jobId
   * @returns {Promise<JobWorkspace>}
   * @throws {TranscriptionError} `DISK_FULL` when the scratch budget is
   *   already exhausted, so a job fails fast instead of filling the SD card.
   */
  async createJobDir(jobId) {
    assertSafeJobId(jobId);
    await fs.mkdir(this.root, { recursive: true });

    if (this.maxTotalBytes > 0) {
      const used = await this.usageBytes();
      if (used >= this.maxTotalBytes) {
        throw new TranscriptionError(
          TRANSCRIPTION_REASONS.DISK_FULL,
          `Transcription scratch space is full (${formatMb(used)} of ${formatMb(this.maxTotalBytes)} used)`,
          { usedBytes: used, limitBytes: this.maxTotalBytes }
        );
      }
    }

    const dir = this.assertContained(path.join(this.root, jobId));
    await fs.mkdir(dir, { recursive: true });
    this.logger.debug?.(`TempFileManager: workspace ready for job ${jobId}`);
    return new JobWorkspace({ jobId, dir, manager: this });
  }

  /**
   * Delete one job's workspace. Never throws: cleanup failures are logged,
   * because losing a scratch directory must not fail an otherwise good job.
   *
   * @param {string} jobId
   * @returns {Promise<boolean>} True when the directory was removed.
   */
  async removeJobDir(jobId) {
    assertSafeJobId(jobId);
    if (this.keepFiles) {
      this.logger.info(
        `TempFileManager: keeping workspace of job ${jobId} (transcription.keepTempFiles)`
      );
      return false;
    }
    try {
      const dir = this.assertContained(path.join(this.root, jobId));
      await fs.rm(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      this.logger.warn(`TempFileManager: could not remove workspace ${jobId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Sweep workspaces left behind by a previous run (a crash, a power cut).
   * Called once at startup (§21).
   *
   * @param {{maxAgeMs?: number}} [options]
   * @returns {Promise<{removed: number, reclaimedBytes: number}>}
   */
  async cleanupStale({ maxAgeMs = STALE_AGE_MS } = {}) {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`TempFileManager: cannot list ${this.root}: ${error.message}`);
      }
      return { removed: 0, reclaimedBytes: 0 };
    }

    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    let reclaimedBytes = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      try {
        const stat = await fs.stat(dir);
        if (stat.mtimeMs > cutoff) continue;
        reclaimedBytes += await directorySize(dir);
        await fs.rm(dir, { recursive: true, force: true });
        removed++;
      } catch (error) {
        this.logger.warn(`TempFileManager: stale sweep skipped ${entry.name}: ${error.message}`);
      }
    }

    if (removed > 0) {
      this.logger.info(
        `TempFileManager: removed ${removed} stale workspace(s), reclaimed ${formatMb(reclaimedBytes)}`
      );
    }
    return { removed, reclaimedBytes };
  }

  /**
   * @returns {Promise<number>} Bytes currently used by the scratch tree.
   */
  async usageBytes() {
    return directorySize(this.root);
  }
}

/**
 * Recursive size of a directory. Missing entries count as zero — the tree is
 * being mutated by live jobs while this walks it.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await directorySize(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        total += stat.size;
      }
      // Symlinks are deliberately not followed: a link planted in the
      // scratch tree must not make us walk (or later delete) the real tree.
    } catch {
      /* entry vanished mid-walk */
    }
  }
  return total;
}

/**
 * `fs.realpathSync` when the path exists, the resolved path otherwise — so
 * containment checks work for paths that are about to be created.
 * @param {string} p
 * @returns {string}
 */
function realPathIfExists(p) {
  try {
    return fsSync.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default TempFileManager;
