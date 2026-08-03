// tests/filemanager-adapted-persist.test.js
// Guards the adaptation write-path regression: an adapted MIDI file must be
// persisted to disk via BlobStore with a fresh content_hash, NOT handed to
// the DB layer as a base64 `data` field (which its column whitelist silently
// dropped, so the adapted transpose/remap/compress never reached playback).
//
// Exercises the two FileManager primitives the apply flow now uses:
//   - replaceFileBytes  → overwrite an existing file's bytes in place
//   - createDerivedFile → store a new child (adapted) file linked to its parent

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { writeMidi } from 'midi-file';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import DatabaseManager from '../src/persistence/Database.js';
import BlobStore from '../src/files/BlobStore.js';
import FileManager from '../src/files/FileManager.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Minimal valid SMF with one note on the given channel/pitch.
function midiBuffer(channel, note) {
  return Buffer.from(
    writeMidi({
      header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
      tracks: [
        [
          { deltaTime: 0, type: 'noteOn', channel, noteNumber: note, velocity: 100 },
          { deltaTime: 480, type: 'noteOff', channel, noteNumber: note, velocity: 0 },
          { deltaTime: 0, meta: true, type: 'endOfTrack' }
        ]
      ]
    })
  );
}

describe('FileManager — adapted file persistence (real SQLite + BlobStore)', () => {
  let tempDir;
  let database;
  let blobStore;
  let fm;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gmboop-adapted-'));
    database = new DatabaseManager({
      logger: silentLogger,
      config: { database: { path: join(tempDir, 'gmboop.db') } }
    });
    blobStore = new BlobStore({ baseDir: tempDir, logger: silentLogger });
    fm = new FileManager({
      logger: silentLogger,
      database,
      blobStore,
      eventBus: { emit: () => {} }
    });
  });

  afterAll(() => {
    try {
      database.close?.();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('replaceFileBytes writes new bytes to disk and updates content_hash', async () => {
    const original = midiBuffer(0, 60);
    const up = await fm.handleUpload('song.mid', original, { folder: '/' });
    const fileId = up.fileId;
    const beforeHash = database.getFile(fileId).content_hash;

    // "Adapt" the file (different bytes → different hash).
    const adapted = midiBuffer(0, 67);
    await fm.replaceFileBytes(fileId, adapted);

    const row = database.getFile(fileId);
    expect(row.content_hash).not.toBe(beforeHash); // hash actually changed
    expect(row.blob_path).toBeTruthy();

    // The bytes on disk must be the ADAPTED bytes, not the original.
    const stored = blobStore.read(row.blob_path);
    expect(Buffer.compare(stored, adapted)).toBe(0);
  });

  test('createDerivedFile stores a new child linked to its parent', async () => {
    const original = midiBuffer(9, 38);
    const up = await fm.handleUpload('drums.mid', original, { folder: '/' });
    const parentId = up.fileId;

    const adapted = midiBuffer(9, 40); // remapped drum note
    const created = await fm.createDerivedFile('drums_adapted.mid', adapted, {
      folder: '/',
      parentFileId: parentId
    });

    expect(created.status).toBe('created');
    const row = database.getFile(created.fileId);
    expect(row.is_original).toBe(0);
    expect(row.parent_file_id).toBe(parentId);

    const stored = blobStore.read(row.blob_path);
    expect(Buffer.compare(stored, adapted)).toBe(0);
  });

  test('createDerivedFile dedups identical bytes instead of inserting twice', async () => {
    const original = midiBuffer(1, 50);
    const up = await fm.handleUpload('mel.mid', original, { folder: '/' });
    const parentId = up.fileId;

    const adapted = midiBuffer(1, 55);
    const first = await fm.createDerivedFile('mel_adapted.mid', adapted, {
      folder: '/',
      parentFileId: parentId
    });
    const second = await fm.createDerivedFile('mel_adapted.mid', adapted, {
      folder: '/',
      parentFileId: parentId
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');
    expect(second.fileId).toBe(first.fileId);
  });
});
