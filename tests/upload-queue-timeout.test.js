// tests/upload-queue-timeout.test.js
// Audit B2 Md2: a never-settling task must time out so it doesn't wedge the
// single-worker chain and reject every later upload with UPLOAD_QUEUE_FULL.

import { describe, test, expect } from '@jest/globals';
import UploadQueue from '../src/files/UploadQueue.js';

describe('UploadQueue — per-task timeout (audit B2 Md2)', () => {
  test('a wedged task times out and later tasks still run', async () => {
    const q = new UploadQueue({ taskTimeoutMs: 40 });
    const hung = q.add('a', () => new Promise(() => {})); // never resolves
    let ranSecond = false;
    const second = q.add('b', async () => {
      ranSecond = true;
      return 'ok';
    });
    await expect(hung).rejects.toThrow(/timed out/i);
    await expect(second).resolves.toBe('ok');
    expect(ranSecond).toBe(true);
    expect(q.pending).toBe(0);
  });

  test('a normal task resolves and byte/count accounting returns to zero', async () => {
    const q = new UploadQueue({ taskTimeoutMs: 1000 });
    const r = await q.add(
      'x',
      async (report) => {
        report('stored');
        return 42;
      },
      100
    );
    expect(r).toBe(42);
    expect(q.pending).toBe(0);
    expect(q.pendingBytes).toBe(0);
  });
});
