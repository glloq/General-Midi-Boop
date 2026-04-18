/**
 * @file src/files/BlobStore.js
 * @description Content-addressable storage for MIDI binary payloads.
 *
 * Layout: `<baseDir>/midi/<hash[0..1]>/<hash>.mid`
 *   - 2-char sharding avoids one-directory-with-10k-files pathology.
 *   - Hash is SHA-256 hex (64 chars).
 *
 * Blobs are written once and never mutated. Deletion is deferred
 * ("marked for GC") so concurrent readers see a stable file.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

class BlobStore {
  /**
   * @param {Object} opts
   * @param {string} opts.baseDir - Base directory (typically data/).
   * @param {Object} [opts.logger] - Optional logger.
   */
  constructor({ baseDir, logger } = {}) {
    if (!baseDir) throw new Error('BlobStore: baseDir is required');
    this.baseDir = baseDir;
    this.midiDir = path.join(baseDir, 'midi');
    this.tmpDir = path.join(baseDir, 'tmp');
    this.logger = logger || { info() {}, warn() {}, error() {} };
    fs.mkdirSync(this.midiDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  /** SHA-256 hex of a Buffer. */
  static hash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /** Relative blob path under baseDir, for storage in `midi_files.blob_path`. */
  relativePathFor(hash) {
    return path.join('midi', hash.slice(0, 2), `${hash}.mid`).split(path.sep).join('/');
  }

  /** Absolute path of a blob identified by its hash. */
  absolutePathFor(hash) {
    return path.join(this.midiDir, hash.slice(0, 2), `${hash}.mid`);
  }

  /**
   * Write a buffer to the store. Idempotent: if the blob already exists
   * (same hash), returns the existing path without rewriting.
   *
   * @param {Buffer} buffer
   * @returns {{ hash: string, relativePath: string, absolutePath: string, size: number, deduplicated: boolean }}
   */
  write(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('BlobStore.write expects a Buffer');
    }
    const hash = BlobStore.hash(buffer);
    const relativePath = this.relativePathFor(hash);
    const absolutePath = this.absolutePathFor(hash);
    const dir = path.dirname(absolutePath);

    if (fs.existsSync(absolutePath)) {
      return {
        hash,
        relativePath,
        absolutePath,
        size: buffer.length,
        deduplicated: true
      };
    }

    fs.mkdirSync(dir, { recursive: true });

    // Atomic write: stage in tmp then rename into place.
    const tmpPath = path.join(this.tmpDir, `${hash}.part-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, absolutePath);

    return {
      hash,
      relativePath,
      absolutePath,
      size: buffer.length,
      deduplicated: false
    };
  }

  /**
   * Resolve a stored relative path into an absolute one and verify it
   * exists. Throws when the blob is missing (DB + filesystem diverged).
   *
   * @param {string} relativePath
   * @returns {string} absolute path
   */
  resolve(relativePath) {
    const abs = path.join(this.baseDir, relativePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`BlobStore: blob missing on disk: ${relativePath}`);
    }
    return abs;
  }

  /**
   * Read a blob's bytes as a Buffer.
   * @param {string} relativePath
   * @returns {Buffer}
   */
  read(relativePath) {
    return fs.readFileSync(this.resolve(relativePath));
  }

  /**
   * Open a read stream for a blob (used by HTTP GET /api/files/:id/blob).
   * @param {string} relativePath
   * @returns {fs.ReadStream}
   */
  readStream(relativePath) {
    return fs.createReadStream(this.resolve(relativePath));
  }

  /**
   * Delete a blob by relative path. Returns true if a file was removed.
   * No-op if the file is missing (idempotent).
   *
   * @param {string} relativePath
   * @returns {boolean}
   */
  delete(relativePath) {
    const abs = path.join(this.baseDir, relativePath);
    try {
      fs.unlinkSync(abs);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      this.logger.warn(`BlobStore: delete failed for ${relativePath}: ${err.message}`);
      return false;
    }
  }

  /**
   * Remove blobs that no DB row references anymore. Called by a
   * periodic housekeeping job. `isReferenced(relativePath)` must
   * return true for every blob still known to the DB.
   *
   * @param {(relativePath: string) => boolean} isReferenced
   * @returns {{ scanned: number, deleted: number }}
   */
  gcOrphans(isReferenced) {
    let scanned = 0;
    let deleted = 0;
    if (!fs.existsSync(this.midiDir)) return { scanned, deleted };

    for (const shard of fs.readdirSync(this.midiDir)) {
      const shardDir = path.join(this.midiDir, shard);
      if (!fs.statSync(shardDir).isDirectory()) continue;
      for (const name of fs.readdirSync(shardDir)) {
        scanned++;
        const rel = path.join('midi', shard, name).split(path.sep).join('/');
        if (!isReferenced(rel)) {
          try {
            fs.unlinkSync(path.join(shardDir, name));
            deleted++;
          } catch (err) {
            this.logger.warn(`BlobStore.gc: cannot remove ${rel}: ${err.message}`);
          }
        }
      }
    }
    return { scanned, deleted };
  }
}

export default BlobStore;
