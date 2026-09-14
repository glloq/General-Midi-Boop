/**
 * @file tests/transcription/transcription-commands.test.js
 * @description The WebSocket surface of §24: what each command answers, what
 * it refuses, and — the part that matters on a fail-closed server — that
 * every payload-taking command is covered by a schema that actually rejects
 * hostile input.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { register, MAX_INLINE_AUDIO_BYTES } from '../../src/api/commands/TranscriptionCommands.js';
import schemas from '../../src/api/commands/schemas/transcription.schemas.js';
import { compileSchema } from '../../src/utils/SchemaCompiler.js';
import JsonValidator from '../../src/utils/JsonValidator.js';
import { NotFoundError, ValidationError } from '../../src/core/errors/index.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

/** Collect the handlers a module registers, like CommandRegistry does. */
function collect(app) {
  const handlers = {};
  register({ register: (name, handler) => (handlers[name] = handler) }, app);
  return handlers;
}

/** A stand-in app facade with the transcription services present. */
function makeApp(overrides = {}) {
  const jobs = new Map();
  const app = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    audioTranscriptionService: {
      created: [],
      getAvailability: async (options) => ({ status: 'ready', probed: options?.force === true }),
      createJob: async (request) => {
        app.audioTranscriptionService.created.push(request);
        const job = { id: 'job-abcdef0123456789', status: 'queued' };
        jobs.set(job.id, job);
        return job;
      }
    },
    transcriptionJobManager: {
      get: (id) => jobs.get(id) ?? null,
      list: () => [...jobs.values()],
      cancel: (id) => {
        const job = jobs.get(id);
        if (!job) return false;
        job.status = 'cancelled';
        return true;
      },
      delete: (id) => jobs.delete(id),
      getResult: (id) => jobs.get(id)?.result ?? null
    },
    transcriptionBackendRegistry: {
      refreshed: false,
      detected: false,
      list: () => [{ id: 'mock-engine', name: 'Mock', status: 'available', available: true }],
      detectAvailable: async () => {
        app.transcriptionBackendRegistry.detected = true;
        return [];
      },
      refresh: async () => {
        app.transcriptionBackendRegistry.refreshed = true;
        return [];
      }
    },
    ...overrides
  };
  return { app, jobs };
}

let app;
let jobs;
let handlers;

beforeEach(() => {
  ({ app, jobs } = makeApp());
  handlers = collect(app);
});

describe('registration', () => {
  test('registers exactly the documented commands', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'transcription_backends',
      'transcription_cancel',
      'transcription_capabilities',
      'transcription_create',
      'transcription_delete',
      'transcription_result',
      'transcription_status'
    ]);
  });

  test('every registered command carries a schema (fail-closed policy)', () => {
    for (const name of Object.keys(handlers)) {
      const validation = JsonValidator.validateByCommand(name, {});
      // A command with no schema is refused with the "no schema" message;
      // anything else means a schema was found and applied.
      expect(validation.errors.join(' ')).not.toMatch(/no payload schema is declared/);
    }
  });
});

describe('transcription_capabilities', () => {
  test('reports availability, and can force a re-probe', async () => {
    expect(await handlers.transcription_capabilities({})).toMatchObject({
      status: 'ready',
      probed: false
    });
    expect(await handlers.transcription_capabilities({ refresh: true })).toMatchObject({
      probed: true
    });
  });

  test('answers "disabled" on a server without the feature instead of failing', async () => {
    const { app: bare } = makeApp({ audioTranscriptionService: null });
    const bareHandlers = collect(bare);
    const answer = await bareHandlers.transcription_capabilities({});
    expect(answer.status).toBe('disabled');
    expect(answer.backends).toEqual([]);
  });
});

describe('transcription_backends', () => {
  test('lists engines after a cached detection', async () => {
    const answer = await handlers.transcription_backends({});
    expect(answer.backends[0]).toMatchObject({ id: 'mock-engine' });
    expect(app.transcriptionBackendRegistry.detected).toBe(true);
    expect(app.transcriptionBackendRegistry.refreshed).toBe(false);
  });

  test('refresh forces a fresh probe', async () => {
    await handlers.transcription_backends({ refresh: true });
    expect(app.transcriptionBackendRegistry.refreshed).toBe(true);
  });

  test('answers an empty list when there is no registry at all', async () => {
    const { app: bare } = makeApp({ transcriptionBackendRegistry: null });
    expect(await collect(bare).transcription_backends({})).toEqual({ backends: [] });
  });
});

describe('transcription_create', () => {
  test('decodes the payload and forwards the request', async () => {
    const audio = Buffer.from('fake audio bytes').toString('base64');
    const answer = await handlers.transcription_create({
      filename: 'song.mp3',
      audio,
      quality: 'fast',
      preset: 'clean',
      folder: '/imports',
      options: { detectDrums: true }
    });

    expect(answer.job.id).toBe('job-abcdef0123456789');
    const request = app.audioTranscriptionService.created[0];
    expect(request.filename).toBe('song.mp3');
    expect(Buffer.isBuffer(request.buffer)).toBe(true);
    expect(request.buffer.toString()).toBe('fake audio bytes');
    expect(request).toMatchObject({ quality: 'fast', preset: 'clean', folder: '/imports' });
    expect(request.options).toEqual({ detectDrums: true });
  });

  test('refuses an empty payload', async () => {
    await expect(
      handlers.transcription_create({ filename: 'x.wav', audio: '' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('points oversized uploads at the HTTP route instead of truncating them', async () => {
    const audio = Buffer.alloc(MAX_INLINE_AUDIO_BYTES + 1).toString('base64');
    const error = await handlers
      .transcription_create({ filename: 'big.wav', audio })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.reason).toBe('FILE_TOO_LARGE');
    expect(error.message).toMatch(/POST \/api\/transcription/);
  });

  test('fails with a user-readable message when the feature is absent', async () => {
    const { app: bare } = makeApp({ audioTranscriptionService: null });
    const error = await collect(bare)
      .transcription_create({ filename: 'x.wav', audio: 'AAAA' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.reason).toBe('BACKEND_NOT_INSTALLED');
  });
});

describe('transcription_status / result / cancel / delete', () => {
  beforeEach(() => {
    jobs.set('job-abcdef0123456789', {
      id: 'job-abcdef0123456789',
      status: 'complete',
      result: { tracks: [] }
    });
  });

  test('status without an id lists every job', async () => {
    expect(await handlers.transcription_status({})).toMatchObject({ jobs: expect.any(Array) });
  });

  test('status with an id returns that job', async () => {
    const answer = await handlers.transcription_status({ jobId: 'job-abcdef0123456789' });
    expect(answer.job.status).toBe('complete');
  });

  test('an unknown job is a NotFoundError, not a masked internal error', async () => {
    await expect(handlers.transcription_status({ jobId: 'job-00000000' })).rejects.toBeInstanceOf(
      NotFoundError
    );
    await expect(handlers.transcription_cancel({ jobId: 'job-00000000' })).rejects.toBeInstanceOf(
      NotFoundError
    );
    await expect(handlers.transcription_result({ jobId: 'job-00000000' })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  test('cancel reports what happened and returns the updated job', async () => {
    const answer = await handlers.transcription_cancel({ jobId: 'job-abcdef0123456789' });
    expect(answer.cancelled).toBe(true);
    expect(answer.job.status).toBe('cancelled');
  });

  test('result returns the rich structure', async () => {
    const answer = await handlers.transcription_result({ jobId: 'job-abcdef0123456789' });
    expect(answer.result).toEqual({ tracks: [] });
  });

  test('an expired result says so rather than returning null', async () => {
    jobs.get('job-abcdef0123456789').result = null;
    await expect(
      handlers.transcription_result({ jobId: 'job-abcdef0123456789' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('delete forgets the job', async () => {
    expect(await handlers.transcription_delete({ jobId: 'job-abcdef0123456789' })).toEqual({
      deleted: true
    });
    expect(await handlers.transcription_delete({ jobId: 'job-abcdef0123456789' })).toEqual({
      deleted: false
    });
  });
});

describe('payload schemas', () => {
  const validate = (name, payload) => compileSchema(schemas[name])(payload);

  test('a job id must look like a job id', () => {
    expect(validate('transcription_cancel', { jobId: 'job-abcdef0123456789' })).toEqual([]);
    expect(validate('transcription_cancel', {})).toEqual(['jobId is required']);
    for (const bad of ['../../etc', 'x'.repeat(5000), 42, { id: 1 }, 'job-ZZZZ']) {
      expect(validate('transcription_cancel', { jobId: bad })).not.toEqual([]);
    }
  });

  test('status accepts no id (list mode) but still rejects a bad one', () => {
    expect(validate('transcription_status', {})).toEqual([]);
    expect(validate('transcription_status', { jobId: 'nope' })).not.toEqual([]);
  });

  test('create requires a filename and a plausible base64 payload', () => {
    expect(validate('transcription_create', { filename: 'a.wav', audio: 'AAAA' })).toEqual([]);
    expect(validate('transcription_create', { audio: 'AAAA' })).toEqual(['filename is required']);
    expect(validate('transcription_create', { filename: 'a.wav' })).toEqual(['audio is required']);
    expect(
      validate('transcription_create', { filename: 'a.wav', audio: 'not base64 !!' })
    ).not.toEqual([]);
    expect(
      validate('transcription_create', { filename: 'a.wav', audio: 'A'.repeat(13 * 1024 * 1024) })
    ).not.toEqual([]);
  });

  test('create constrains quality, preset and folder', () => {
    expect(
      validate('transcription_create', { filename: 'a.wav', audio: 'AA', quality: 'ludicrous' })
    ).not.toEqual([]);
    expect(
      validate('transcription_create', { filename: 'a.wav', audio: 'AA', preset: 'destroy' })
    ).not.toEqual([]);
    expect(
      validate('transcription_create', { filename: 'a.wav', audio: 'AA', folder: 'relative' })
    ).not.toEqual([]);
    expect(
      validate('transcription_create', { filename: 'a.wav', audio: 'AA', folder: '/ok' })
    ).toEqual([]);
  });

  test('the options bag refuses arrays, deep nesting and absurd width', () => {
    const base = { filename: 'a.wav', audio: 'AA' };
    expect(validate('transcription_create', { ...base, options: { detectDrums: true } })).toEqual(
      []
    );
    expect(
      validate('transcription_create', {
        ...base,
        options: { postProcessing: { minConfidence: 0.4 } }
      })
    ).toEqual([]);
    expect(validate('transcription_create', { ...base, options: [1, 2] })).not.toEqual([]);
    expect(
      validate('transcription_create', { ...base, options: { a: { b: { c: 1 } } } })
    ).not.toEqual([]);
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, true]));
    expect(validate('transcription_create', { ...base, options: wide })).not.toEqual([]);
  });

  test('refresh must be a real boolean', () => {
    expect(validate('transcription_backends', { refresh: true })).toEqual([]);
    expect(validate('transcription_backends', { refresh: 'yes' })).not.toEqual([]);
    expect(validate('transcription_capabilities', {})).toEqual([]);
  });
});
