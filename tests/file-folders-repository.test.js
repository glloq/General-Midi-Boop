// tests/file-folders-repository.test.js
// Unit coverage for FileFoldersRepository (T2.2) — the settings-KV backing for
// the file-manager folder structure. Uses a fake db handle so it runs without
// any native SQLite binding.

import { describe, test, expect } from '@jest/globals';
import FileFoldersRepository from '../src/repositories/FileFoldersRepository.js';

function makeFakeDb(initial) {
  const store = new Map();
  if (initial !== undefined) store.set('file_folders', initial);
  return {
    _store: store,
    prepare(sql) {
      if (/SELECT value FROM settings/.test(sql)) {
        return { get: (key) => (store.has(key) ? { value: store.get(key) } : undefined) };
      }
      if (/INSERT INTO settings/.test(sql)) {
        return { run: (key, value) => store.set(key, value) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }
  };
}

describe('FileFoldersRepository', () => {
  test('get() returns {} when nothing is stored', () => {
    const repo = new FileFoldersRepository(makeFakeDb());
    expect(repo.get()).toEqual({});
  });

  test('set() then get() round-trips the structure', () => {
    const db = makeFakeDb();
    const repo = new FileFoldersRepository(db);
    const structure = { Jazz: { files: ['1', '2'] }, Empty: { files: [] } };
    repo.set(structure);
    expect(repo.get()).toEqual(structure);
    // Stored as JSON under the shared key.
    expect(JSON.parse(db._store.get('file_folders'))).toEqual(structure);
  });

  test('set() sanitizes non-object input to {}', () => {
    const repo = new FileFoldersRepository(makeFakeDb());
    expect(repo.set(null)).toEqual({});
    expect(repo.set([1, 2, 3])).toEqual({});
    expect(repo.get()).toEqual({});
  });

  test('get() tolerates a corrupt stored value', () => {
    const repo = new FileFoldersRepository(makeFakeDb('{not valid json'));
    expect(repo.get()).toEqual({});
  });

  test('accepts a facade exposing .db as well as a raw handle', () => {
    const raw = makeFakeDb();
    const repo = new FileFoldersRepository({ db: raw });
    repo.set({ A: { files: [] } });
    expect(repo.get()).toEqual({ A: { files: [] } });
  });
});
