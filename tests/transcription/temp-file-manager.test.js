/**
 * @file tests/transcription/temp-file-manager.test.js
 * @description Scratch-space containment and cleanup (§21/§40). Uses a real
 * directory under the OS temp dir — the logic under test IS filesystem
 * behaviour, so faking it would test nothing.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  TempFileManager,
  assertSafeJobId,
  assertSafeFileName,
  directorySize
} from '../../src/transcription/utils/TempFileManager.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

let root;
let manager;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-tmp-'));
  manager = new TempFileManager({ root, logger: silentLogger });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('identifier validation', () => {
  test('accepts the ids the job manager generates', () => {
    expect(assertSafeJobId('job-1a2b3c4d')).toBe('job-1a2b3c4d');
    expect(assertSafeFileName('result.json')).toBe('result.json');
  });

  test('refuses anything that could leave the directory', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '/abs', '.hidden', null, 42]) {
      expect(() => assertSafeJobId(bad)).toThrow(TypeError);
    }
    for (const bad of ['../escape.json', 'sub/dir.json', '..', '', '/etc/passwd']) {
      expect(() => assertSafeFileName(bad)).toThrow(TypeError);
    }
  });
});

describe('containment', () => {
  test('accepts paths inside the root and refuses everything else', () => {
    expect(manager.assertContained(path.join(root, 'job-1'))).toBe(path.join(root, 'job-1'));
    expect(() => manager.assertContained(path.join(root, '..', 'elsewhere'))).toThrow(
      /escapes the transcription scratch root/
    );
    expect(() => manager.assertContained('/etc/passwd')).toThrow(/escapes/);
  });

  test('resolves symlinks before deciding — a planted link cannot escape', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-outside-'));
    try {
      const link = path.join(root, 'sneaky');
      await fs.symlink(outside, link, 'dir');
      expect(() => manager.assertContained(link)).toThrow(/escapes/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('a root that is not absolute is refused at construction', () => {
    expect(() => new TempFileManager({ root: './relative' })).toThrow(/absolute root/);
  });
});

describe('workspaces', () => {
  test('creates a job directory and hands out contained paths', async () => {
    const workspace = await manager.createJobDir('job-abc');
    expect(workspace.dir).toBe(path.join(root, 'job-abc'));
    await expect(fs.stat(workspace.dir)).resolves.toBeDefined();
    expect(workspace.file('audio.wav')).toBe(path.join(workspace.dir, 'audio.wav'));
    expect(() => workspace.file('../escape.wav')).toThrow(TypeError);
  });

  test('cleanup removes the directory and is idempotent', async () => {
    const workspace = await manager.createJobDir('job-abc');
    await fs.writeFile(workspace.file('audio.wav'), 'x'.repeat(1024));
    expect(await workspace.sizeBytes()).toBe(1024);

    await workspace.cleanup();
    await expect(fs.stat(workspace.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(workspace.cleanup()).resolves.toBeUndefined();
  });

  test('keepTempFiles leaves the workspace in place for debugging', async () => {
    const keeper = new TempFileManager({ root, logger: silentLogger, keepFiles: true });
    const workspace = await keeper.createJobDir('job-keep');
    await fs.writeFile(workspace.file('audio.wav'), 'x');
    await workspace.cleanup();
    await expect(fs.stat(workspace.dir)).resolves.toBeDefined();
  });

  test('a cleanup failure is logged, never thrown', async () => {
    const warnings = [];
    const noisy = new TempFileManager({
      root,
      logger: { ...silentLogger, warn: (m) => warnings.push(m) }
    });
    await expect(noisy.removeJobDir('never-created')).resolves.toBe(true);
    expect(warnings).toEqual([]);
  });

  test('refuses a new job when the scratch budget is already spent', async () => {
    const bounded = new TempFileManager({ root, logger: silentLogger, maxTotalBytes: 512 });
    const first = await bounded.createJobDir('job-1');
    await fs.writeFile(first.file('audio.wav'), 'x'.repeat(1024));

    const error = await bounded.createJobDir('job-2').catch((e) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.reason).toBe('DISK_FULL');
    expect(error.details.limitBytes).toBe(512);
  });
});

describe('stale sweep', () => {
  test('removes abandoned workspaces and keeps recent ones', async () => {
    const old = await manager.createJobDir('job-old');
    await fs.writeFile(old.file('audio.wav'), 'x'.repeat(2048));
    const recent = await manager.createJobDir('job-recent');
    await fs.writeFile(recent.file('audio.wav'), 'y');

    // Backdate the abandoned one by a day.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await fs.utimes(old.dir, past, past);

    const result = await manager.cleanupStale({ maxAgeMs: 60 * 60 * 1000 });
    expect(result.removed).toBe(1);
    expect(result.reclaimedBytes).toBe(2048);
    await expect(fs.stat(old.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(recent.dir)).resolves.toBeDefined();
  });

  test('a missing root is not an error at startup', async () => {
    const absent = new TempFileManager({
      root: path.join(root, 'not-created-yet'),
      logger: silentLogger
    });
    await expect(absent.cleanupStale()).resolves.toEqual({ removed: 0, reclaimedBytes: 0 });
  });

  test('ignores loose files, only sweeps directories', async () => {
    await fs.writeFile(path.join(root, 'stray.txt'), 'x');
    const result = await manager.cleanupStale({ maxAgeMs: 0 });
    expect(result.removed).toBe(0);
    await expect(fs.stat(path.join(root, 'stray.txt'))).resolves.toBeDefined();
  });
});

describe('usage accounting', () => {
  test('sums nested files and survives a concurrent removal', async () => {
    const workspace = await manager.createJobDir('job-usage');
    await fs.mkdir(path.join(workspace.dir, 'nested'));
    await fs.writeFile(workspace.file('a.wav'), 'x'.repeat(100));
    await fs.writeFile(path.join(workspace.dir, 'nested', 'b.json'), 'y'.repeat(50));

    expect(await manager.usageBytes()).toBe(150);
    expect(await directorySize(path.join(root, 'does-not-exist'))).toBe(0);
  });

  test('does not follow symlinks when measuring', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-big-'));
    try {
      await fs.writeFile(path.join(outside, 'huge.bin'), 'z'.repeat(4096));
      const workspace = await manager.createJobDir('job-link');
      await fs.symlink(path.join(outside, 'huge.bin'), workspace.file('link.bin'));
      expect(await manager.usageBytes()).toBe(0);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
