// tests/backup-scheduler-gc-floor.test.js
// Audit A3 MED1: _gcOrphanBlobs must NOT call gcOrphans when the referenced-set
// is empty — an empty set makes gcOrphans treat every blob as an orphan and
// wipe all stored MIDI bytes. Driven via prototype-call with stubs (no SQLite).

import { describe, test, expect, jest } from '@jest/globals';
import BackupScheduler from '../src/persistence/BackupScheduler.js';

function makeScheduler(referencedPaths, gcResult = { scanned: 3, deleted: 0 }) {
  const gcOrphans = jest.fn(() => gcResult);
  const scheduler = Object.create(BackupScheduler.prototype);
  scheduler.logger = { info() {}, warn() {}, debug() {}, error() {} };
  scheduler.blobStore = { gcOrphans };
  scheduler.database = {
    midiDB: { listBlobsForManifest: () => referencedPaths.map((p) => ({ blob_path: p })) }
  };
  return { scheduler, gcOrphans };
}

describe('BackupScheduler._gcOrphanBlobs — empty-set floor (audit A3 MED1)', () => {
  test('skips gcOrphans entirely when nothing is referenced', () => {
    const { scheduler, gcOrphans } = makeScheduler([]);
    scheduler._gcOrphanBlobs();
    expect(gcOrphans).not.toHaveBeenCalled();
  });

  test('runs gcOrphans when at least one blob is referenced', () => {
    const { scheduler, gcOrphans } = makeScheduler(['midi/aa/keep.mid']);
    scheduler._gcOrphanBlobs();
    expect(gcOrphans).toHaveBeenCalledTimes(1);
  });

  test('the predicate distinguishes referenced from orphan blobs', () => {
    const { scheduler, gcOrphans } = makeScheduler(['midi/aa/keep.mid']);
    scheduler._gcOrphanBlobs();
    const isReferenced = gcOrphans.mock.calls[0][0];
    expect(isReferenced('midi/aa/keep.mid')).toBe(true);
    expect(isReferenced('midi/bb/orphan.mid')).toBe(false);
  });
});
