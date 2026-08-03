// tests/upload-queue.test.js
// UploadQueue is a serial (concurrency-1) FIFO. It must also bound its depth
// so a burst of uploads cannot pin unbounded buffers in memory (audit P2).

import { describe, test, expect } from '@jest/globals';
import UploadQueue from '../src/files/UploadQueue.js';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('UploadQueue', () => {
  test('runs tasks serially in FIFO order', async () => {
    const q = new UploadQueue({ logger: silent });
    const order = [];
    const mk = (n) => () =>
      new Promise((resolve) =>
        setTimeout(() => {
          order.push(n);
          resolve(n);
        }, 5)
      );

    const results = await Promise.all([q.add('a', mk(1)), q.add('b', mk(2)), q.add('c', mk(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('rejects new work with a typed error when the queue is full', async () => {
    const q = new UploadQueue({ logger: silent, maxPending: 2 });
    let release;
    const block = new Promise((r) => {
      release = r;
    });

    // Fill the queue: two slow tasks occupy both slots.
    const p1 = q.add('1', () => block);
    const p2 = q.add('2', () => block);
    expect(q.pending).toBe(2);

    // Third should be rejected immediately with UPLOAD_QUEUE_FULL.
    await expect(q.add('3', () => Promise.resolve())).rejects.toMatchObject({
      code: 'UPLOAD_QUEUE_FULL'
    });

    release();
    await Promise.all([p1, p2]);
    expect(q.pending).toBe(0);

    // Draining frees capacity again.
    await expect(q.add('4', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  test('one failing task does not poison later tasks', async () => {
    const q = new UploadQueue({ logger: silent });
    const bad = q.add('bad', () => Promise.reject(new Error('boom')));
    const good = q.add('good', () => Promise.resolve('fine'));

    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('fine');
  });
});
