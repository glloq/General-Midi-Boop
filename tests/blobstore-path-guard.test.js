// tests/blobstore-path-guard.test.js
// Audit A2 N4: BlobStore.resolve()/delete() joined a relative path onto baseDir
// with no containment check. Blob paths are always server-generated from the
// content hash today, but a future caller passing a traversing path must never
// be able to read/delete outside baseDir. _safeResolve enforces that.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import BlobStore from '../src/files/BlobStore.js';

describe('BlobStore path-containment guard (audit A2 N4)', () => {
  let baseDir;
  let store;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'gmboop-blob-'));
    store = new BlobStore({ baseDir });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test('a legitimate hash-relative path resolves inside baseDir', () => {
    const rel = store.relativePathFor('a'.repeat(64));
    const abs = store._safeResolve(rel);
    expect(abs.startsWith(baseDir)).toBe(true);
  });

  test('resolve() throws on a traversing path', () => {
    expect(() => store.resolve('../../etc/passwd')).toThrow(/escapes base dir/);
    expect(() => store.resolve('..')).toThrow(/escapes base dir/);
  });

  test('delete() throws on a traversing path instead of unlinking it', () => {
    // Create a file OUTSIDE baseDir that a traversal would target.
    const outside = join(baseDir, '..', `gmboop-victim-${process.pid}.txt`);
    writeFileSync(outside, 'do not delete', 'utf8');
    try {
      expect(() => store.delete(`../${'gmboop-victim-' + process.pid}.txt`)).toThrow(
        /escapes base dir/
      );
      expect(existsSync(outside)).toBe(true); // untouched
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('a real blob under baseDir still reads back', () => {
    const buf = Buffer.from('MThd fake midi');
    const { relativePath } = store.write(buf);
    expect(store.read(relativePath).equals(buf)).toBe(true);
  });

  test('a nested-but-contained path is allowed', () => {
    const sub = join(baseDir, 'midi', 'zz');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'x.mid'), 'y', 'utf8');
    expect(() => store.resolve('midi/zz/x.mid')).not.toThrow();
  });
});
