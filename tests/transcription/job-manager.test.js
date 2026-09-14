/**
 * @file tests/transcription/job-manager.test.js
 * @description Queue, lifecycle, progress throttling, cancellation and
 * retention (§17/§18/§25). The work itself is a plain async function, so
 * none of this needs FFmpeg, a model or a database.
 */
import { describe, test, expect, jest } from '@jest/globals';
import {
  TranscriptionJobManager,
  JOB_STATUS,
  TERMINAL_STATUSES,
  toPublicJob
} from '../../src/transcription/TranscriptionJobManager.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Manager plus the events it emitted. */
function makeManager(settings = {}) {
  const events = [];
  const manager = new TranscriptionJobManager({
    logger: silentLogger,
    eventBus: { emit: (name, payload) => events.push({ name, payload }) },
    settings: { maxParallelJobs: 1, progressThrottleMs: 0, ...settings }
  });
  return { manager, events, names: () => events.map((e) => e.name) };
}

/** A promise plus its resolve/reject handles. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait for a job to reach a terminal state. */
async function settled(manager, jobId, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const job = manager.get(jobId);
    if (job && TERMINAL_STATUSES.has(job.status)) return job;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`job ${jobId} never settled (status=${manager.get(jobId)?.status})`);
}

describe('creation', () => {
  test('returns a queued job immediately and runs it after the caller returns', async () => {
    const { manager, names } = makeManager();
    const job = manager.create({ sourceName: 'song.mp3', run: async () => ({ summary: {} }) });

    expect(job.status).toBe(JOB_STATUS.QUEUED);
    expect(job.id).toMatch(/^job-[a-f0-9]{16}$/);
    expect(job.sourceName).toBe('song.mp3');
    expect(names()).toEqual(['transcription_created']);

    await settled(manager, job.id);
    expect(manager.get(job.id).status).toBe(JOB_STATUS.COMPLETE);
  });

  test('refuses a job without work', () => {
    const { manager } = makeManager();
    expect(() => manager.create({ sourceName: 'x' })).toThrow(TypeError);
  });

  test('refuses new work past the queue depth', () => {
    // Jobs only leave the queue on the next tick, so with a depth of 2 the
    // third synchronous create() is the one refused.
    const { manager } = makeManager({ maxQueued: 2 });
    const blocker = deferred();
    manager.create({ sourceName: 'a', run: () => blocker.promise });
    manager.create({ sourceName: 'b', run: () => blocker.promise });
    const error = (() => {
      try {
        manager.create({ sourceName: 'c', run: async () => ({}) });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.message).toMatch(/already waiting/);
    expect(error.details).toEqual({ queued: 2, limit: 2 });
    blocker.resolve({});
  });

  test('the queue drains as jobs start, making room for more', async () => {
    const { manager } = makeManager({ maxQueued: 2, maxParallelJobs: 1 });
    const blocker = deferred();
    manager.create({ sourceName: 'a', run: () => blocker.promise });
    manager.create({ sourceName: 'b', run: () => blocker.promise });
    await new Promise((r) => setImmediate(r));
    // 'a' is running now, so one slot freed up.
    expect(manager.queuedCount).toBe(1);
    expect(() => manager.create({ sourceName: 'c', run: () => blocker.promise })).not.toThrow();
    blocker.resolve({});
  });
});

describe('queue', () => {
  test('runs one job at a time on a Pi (maxParallelJobs = 1)', async () => {
    const { manager } = makeManager({ maxParallelJobs: 1 });
    const first = deferred();
    let secondStarted = false;

    const a = manager.create({ sourceName: 'a', run: () => first.promise });
    const b = manager.create({
      sourceName: 'b',
      run: async () => {
        secondStarted = true;
        return {};
      }
    });

    await new Promise((r) => setImmediate(r));
    expect(manager.runningCount).toBe(1);
    expect(secondStarted).toBe(false);
    expect(manager.get(b.id).status).toBe(JOB_STATUS.QUEUED);

    first.resolve({});
    await settled(manager, a.id);
    await settled(manager, b.id);
    expect(secondStarted).toBe(true);
  });

  test('honours a higher concurrency when configured', async () => {
    const { manager } = makeManager({ maxParallelJobs: 2 });
    const blocker = deferred();
    manager.create({ sourceName: 'a', run: () => blocker.promise });
    manager.create({ sourceName: 'b', run: () => blocker.promise });
    await new Promise((r) => setImmediate(r));
    expect(manager.runningCount).toBe(2);
    blocker.resolve({});
  });

  test('a failing job does not block the queue', async () => {
    const { manager } = makeManager();
    const bad = manager.create({
      sourceName: 'bad',
      run: async () => {
        throw new Error('kaboom');
      }
    });
    const good = manager.create({ sourceName: 'good', run: async () => ({}) });
    await settled(manager, bad.id);
    await settled(manager, good.id);
    expect(manager.get(bad.id).status).toBe(JOB_STATUS.FAILED);
    expect(manager.get(good.id).status).toBe(JOB_STATUS.COMPLETE);
  });
});

describe('progress', () => {
  test('reports every stage change, whatever the throttle', async () => {
    const { manager, events } = makeManager({ progressThrottleMs: 60000 });
    const job = manager.create({
      sourceName: 'song.mp3',
      run: async (context) => {
        context.setStage(JOB_STATUS.TRANSCRIBING);
        context.setStage(JOB_STATUS.POSTPROCESSING);
        context.setStage(JOB_STATUS.GENERATING_MIDI);
        return {};
      }
    });
    await settled(manager, job.id);
    const stages = events
      .filter((e) => e.name === 'transcription_progress')
      .map((e) => e.payload.stage);
    expect(stages).toEqual([
      JOB_STATUS.PREPROCESSING,
      JOB_STATUS.TRANSCRIBING,
      JOB_STATUS.POSTPROCESSING,
      JOB_STATUS.GENERATING_MIDI
    ]);
  });

  test('throttles progress inside one stage', async () => {
    const { manager, events } = makeManager({ progressThrottleMs: 60000 });
    const job = manager.create({
      sourceName: 'song.mp3',
      run: async (context) => {
        for (let i = 0; i < 100; i++) context.setProgress(i / 100);
        return {};
      }
    });
    await settled(manager, job.id);
    // Only the forced stage entry, none of the 100 updates behind it.
    expect(events.filter((e) => e.name === 'transcription_progress')).toHaveLength(1);
  });

  test('keeps progress indeterminate when the engine reports none', async () => {
    const { manager } = makeManager();
    const job = manager.create({
      sourceName: 'x',
      run: async (context) => {
        context.setProgress(null);
        context.setProgress('not a number');
        expect(manager.get(context.jobId).progress).toBeNull();
        return {};
      }
    });
    await settled(manager, job.id);
  });

  test('clamps a nonsense progress value instead of forwarding it', async () => {
    const { manager } = makeManager();
    const job = manager.create({
      sourceName: 'x',
      run: async (context) => {
        context.setProgress(42);
        expect(manager.get(context.jobId).progress).toBe(1);
        context.setProgress(-3);
        expect(manager.get(context.jobId).progress).toBe(0);
        return {};
      }
    });
    await settled(manager, job.id);
  });

  test('an unknown stage is ignored rather than corrupting the status', async () => {
    const { manager } = makeManager();
    const job = manager.create({
      sourceName: 'x',
      run: async (context) => {
        context.setStage('dancing');
        expect(manager.get(context.jobId).status).toBe(JOB_STATUS.PREPROCESSING);
        return {};
      }
    });
    await settled(manager, job.id);
  });

  test('the progress payload stays minimal (§25)', async () => {
    const { manager, events } = makeManager();
    const job = manager.create({ sourceName: 'x', run: async () => ({}) });
    await settled(manager, job.id);
    const progress = events.find((e) => e.name === 'transcription_progress');
    expect(Object.keys(progress.payload).sort()).toEqual(['jobId', 'progress', 'stage']);
  });
});

describe('completion', () => {
  test('stores the summary and the file id, and emits transcription_complete', async () => {
    const { manager, events } = makeManager();
    const job = manager.create({
      sourceName: 'song.mp3',
      run: async () => ({
        summary: { noteCount: 12 },
        result: { tracks: [] },
        fileId: 77,
        warnings: ['12 low-confidence notes']
      })
    });
    const finished = await settled(manager, job.id);

    expect(finished.status).toBe(JOB_STATUS.COMPLETE);
    expect(finished.progress).toBe(1);
    expect(finished.summary).toEqual({ noteCount: 12 });
    expect(finished.fileId).toBe(77);
    expect(finished.warnings).toEqual(['12 low-confidence notes']);
    expect(finished.hasResult).toBe(true);
    expect(manager.getResult(job.id)).toEqual({ tracks: [] });

    const complete = events.find((e) => e.name === 'transcription_complete');
    expect(complete.payload).toMatchObject({ jobId: job.id, fileId: 77 });
  });

  test('warnings added during the run survive', async () => {
    const { manager } = makeManager();
    const job = manager.create({
      sourceName: 'x',
      run: async (context) => {
        context.addWarning('ffmpeg resampled the audio');
        context.addWarning('');
        return {};
      }
    });
    expect((await settled(manager, job.id)).warnings).toEqual(['ffmpeg resampled the audio']);
  });
});

describe('failure', () => {
  test('records a typed reason and emits transcription_failed', async () => {
    const { manager, events } = makeManager();
    const job = manager.create({
      sourceName: 'x',
      run: async () => {
        throw new TranscriptionError('FFMPEG_MISSING', 'FFmpeg is not installed');
      }
    });
    const finished = await settled(manager, job.id);
    expect(finished.status).toBe(JOB_STATUS.FAILED);
    expect(finished.error).toMatchObject({
      reason: 'FFMPEG_MISSING',
      message: 'FFmpeg is not installed',
      retryable: false
    });
    expect(events.find((e) => e.name === 'transcription_failed').payload.reason).toBe(
      'FFMPEG_MISSING'
    );
  });

  test('wraps an untyped throw as BACKEND_FAILED', async () => {
    const { manager } = makeManager();
    const job = manager.create({
      sourceName: 'x',
      backendId: 'fake',
      run: async () => {
        throw new Error('segfault');
      }
    });
    const finished = await settled(manager, job.id);
    expect(finished.error.reason).toBe('BACKEND_FAILED');
    expect(finished.error.message).toBe('segfault');
  });
});

describe('cancellation (§18)', () => {
  test('cancels a queued job without ever starting it', async () => {
    const { manager, events } = makeManager({ maxParallelJobs: 1 });
    const blocker = deferred();
    const running = manager.create({ sourceName: 'a', run: () => blocker.promise });
    let started = false;
    const queued = manager.create({
      sourceName: 'b',
      run: async () => {
        started = true;
        return {};
      }
    });
    await new Promise((r) => setImmediate(r));

    expect(manager.cancel(queued.id)).toBe(true);
    expect(manager.get(queued.id).status).toBe(JOB_STATUS.CANCELLED);
    expect(events.some((e) => e.name === 'transcription_cancelled')).toBe(true);

    blocker.resolve({});
    await settled(manager, running.id);
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(false);
  });

  test('aborts a running job through its signal', async () => {
    const { manager } = makeManager();
    let sawAbort = false;
    const job = manager.create({
      sourceName: 'x',
      run: (context) =>
        new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
        })
    });
    await new Promise((r) => setImmediate(r));

    expect(manager.cancel(job.id)).toBe(true);
    const finished = await settled(manager, job.id);
    expect(sawAbort).toBe(true);
    expect(finished.status).toBe(JOB_STATUS.CANCELLED);
    expect(finished.error).toBeNull();
  });

  test('a job that finishes after being cancelled is still cancelled, not complete', async () => {
    const { manager } = makeManager();
    const work = deferred();
    const job = manager.create({ sourceName: 'x', run: () => work.promise });
    await new Promise((r) => setImmediate(r));
    manager.cancel(job.id);
    work.resolve({ fileId: 1 });
    const finished = await settled(manager, job.id);
    expect(finished.status).toBe(JOB_STATUS.CANCELLED);
    expect(finished.fileId).toBeNull();
  });

  test('cancelling an unknown or finished job is a no-op', async () => {
    const { manager } = makeManager();
    expect(manager.cancel('job-nope')).toBe(false);
    const job = manager.create({ sourceName: 'x', run: async () => ({}) });
    await settled(manager, job.id);
    expect(manager.cancel(job.id)).toBe(false);
  });
});

describe('timeout', () => {
  test('a job past the wall clock fails with BACKEND_TIMEOUT, not "cancelled"', async () => {
    jest.useFakeTimers();
    try {
      const { manager } = makeManager({ jobTimeoutMs: 1000 });
      const job = manager.create({
        sourceName: 'x',
        run: (context) =>
          new Promise((_, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(0);

      const finished = manager.get(job.id);
      expect(finished.status).toBe(JOB_STATUS.FAILED);
      expect(finished.error.reason).toBe('BACKEND_TIMEOUT');
      expect(finished.error.retryable).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('retention', () => {
  test('lists newest first and hides internals from the public record', async () => {
    const { manager } = makeManager();
    const a = manager.create({ sourceName: 'a', run: async () => ({}) });
    await settled(manager, a.id);
    const b = manager.create({ sourceName: 'b', run: async () => ({}) });
    await settled(manager, b.id);

    const list = manager.list();
    expect(list[0].sourceName).toBe('b');
    for (const job of list) {
      expect(job).not.toHaveProperty('_controller');
      expect(job).not.toHaveProperty('_run');
      expect(job).not.toHaveProperty('_result');
    }
  });

  test('keeps the full result of only the most recent jobs', async () => {
    const { manager } = makeManager({ maxRetainedResults: 2 });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const job = manager.create({
        sourceName: `s${i}`,
        run: async () => ({ result: { tracks: [{ id: `t${i}` }] } })
      });
      ids.push(job.id);
      await settled(manager, job.id);
    }
    expect(manager.getResult(ids[0])).toBeNull();
    expect(manager.getResult(ids[1])).toBeNull();
    expect(manager.getResult(ids[3])).not.toBeNull();
  });

  test('prunes finished jobs past the retention window', async () => {
    const { manager } = makeManager({ retentionMs: 1 });
    const job = manager.create({ sourceName: 'old', run: async () => ({}) });
    await settled(manager, job.id);
    await new Promise((r) => setTimeout(r, 5));
    manager.create({ sourceName: 'new', run: async () => ({}) });
    expect(manager.get(job.id)).toBeNull();
  });

  test('never holds more than maxJobs records', async () => {
    const { manager } = makeManager({ maxJobs: 3 });
    for (let i = 0; i < 8; i++) {
      const job = manager.create({ sourceName: `s${i}`, run: async () => ({}) });
      await settled(manager, job.id);
    }
    expect(manager.list().length).toBeLessThanOrEqual(3);
  });

  test('delete only removes a finished job', async () => {
    const { manager } = makeManager();
    const blocker = deferred();
    const running = manager.create({ sourceName: 'x', run: () => blocker.promise });
    await new Promise((r) => setImmediate(r));
    expect(manager.delete(running.id)).toBe(false);
    blocker.resolve({});
    await settled(manager, running.id);
    expect(manager.delete(running.id)).toBe(true);
    expect(manager.get(running.id)).toBeNull();
    expect(manager.delete('job-nope')).toBe(false);
  });
});

describe('shutdown', () => {
  test('destroy aborts everything in flight and refuses new work', async () => {
    const { manager } = makeManager();
    let aborted = false;
    const job = manager.create({
      sourceName: 'x',
      run: (context) =>
        new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })
    });
    await new Promise((r) => setImmediate(r));

    manager.destroy();
    expect(aborted).toBe(true);
    await settled(manager, job.id);
    expect(manager.get(job.id).status).toBe(JOB_STATUS.CANCELLED);
    expect(() => manager.create({ sourceName: 'y', run: async () => ({}) })).toThrow(
      /shutting down/
    );
  });
});

describe('toPublicJob', () => {
  test('exposes exactly the documented fields', () => {
    const publicJob = toPublicJob({
      id: 'job-1',
      status: 'queued',
      stage: null,
      progress: null,
      createdAt: 1,
      startedAt: null,
      finishedAt: null,
      backendId: null,
      sourceName: 'x',
      error: null,
      warnings: [],
      summary: null,
      _result: null,
      _fileId: null,
      _controller: new AbortController()
    });
    expect(Object.keys(publicJob).sort()).toEqual([
      'backendId',
      'createdAt',
      'error',
      'fileId',
      'finishedAt',
      'hasResult',
      'id',
      'progress',
      'sourceName',
      'stage',
      'startedAt',
      'status',
      'summary',
      'warnings'
    ]);
  });
});
