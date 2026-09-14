/**
 * @file tests/transcription/transcription-http-route.test.js
 * @description `POST /api/transcription` — the upload path a browser really
 * uses, because an audio file does not fit in a WebSocket frame.
 *
 * Boots the real Express app on an ephemeral port (same pattern as
 * `tests/audit/l01-http-contract.test.js`) with a stubbed transcription
 * service, so the route, its body cap, its query parsing and its error
 * mapping are exercised for real without FFmpeg or a model.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import HttpServer from '../../src/api/HttpServer.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let server;
let baseUrl;
let service;
let previousToken;

beforeAll(async () => {
  previousToken = process.env.GMBOOP_API_TOKEN;
  delete process.env.GMBOOP_API_TOKEN;

  service = {
    calls: [],
    nextError: null,
    createJob: async (request) => {
      service.calls.push(request);
      if (service.nextError) throw service.nextError;
      return { id: 'job-abcdef0123456789', status: 'queued', sourceName: request.filename };
    }
  };

  const deps = {
    logger: noopLogger,
    config: {
      server: { port: 0, host: '127.0.0.1' },
      get: (key, fallback) => (key.startsWith('transcription.') ? undefined : fallback)
    },
    getCapabilityStatus: () => ({ overall: 'ok', capabilities: {} }),
    deviceManager: { getDeviceList: () => [] },
    midiRouter: { getRouteList: () => [] },
    database: { getFiles: () => [], getFileInfo: () => null },
    wsServer: { getStats: () => ({ clients: 0 }) },
    audioTranscriptionService: service
  };

  server = new HttpServer(deps);
  await server.start();
  baseUrl = `http://127.0.0.1:${server.server.address().port}`;
});

afterAll(async () => {
  await server?.close();
  if (previousToken === undefined) delete process.env.GMBOOP_API_TOKEN;
  else process.env.GMBOOP_API_TOKEN = previousToken;
});

/** POST raw bytes to the transcription endpoint. */
async function upload(query, body = Buffer.from('fake audio')) {
  const search = new URLSearchParams(query).toString();
  return fetch(`${baseUrl}/api/transcription?${search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body
  });
}

describe('POST /api/transcription', () => {
  test('queues a job and answers 202 — the work has not happened yet', async () => {
    service.calls.length = 0;
    const response = await upload({ filename: 'song.mp3' });
    expect(response.status).toBe(202);

    const payload = await response.json();
    expect(payload.job).toMatchObject({ id: 'job-abcdef0123456789', status: 'queued' });
    expect(service.calls[0].filename).toBe('song.mp3');
    expect(Buffer.isBuffer(service.calls[0].buffer)).toBe(true);
    expect(service.calls[0].folder).toBe('/');
  });

  test('forwards the documented query options', async () => {
    service.calls.length = 0;
    await upload({
      filename: 'song.mp3',
      folder: '/imports',
      backendId: 'mock-engine',
      quality: 'maximum',
      preset: 'clean',
      detectDrums: '1',
      preserveDynamics: 'false'
    });
    expect(service.calls[0]).toMatchObject({
      folder: '/imports',
      backendId: 'mock-engine',
      quality: 'maximum',
      preset: 'clean'
    });
    expect(service.calls[0].options).toEqual({ detectDrums: true, preserveDynamics: false });
  });

  test('reads only the documented flags from the query string', async () => {
    service.calls.length = 0;
    await upload({ filename: 'song.mp3', evilFlag: '1', __proto__: 'x' });
    expect(service.calls[0].options).toEqual({});
  });

  test('refuses an empty body', async () => {
    const response = await upload({ filename: 'song.mp3' }, Buffer.alloc(0));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Empty body/);
  });

  test('refuses a relative folder', async () => {
    const response = await upload({ filename: 'song.mp3', folder: 'imports' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/folder must start/);
  });

  test('maps a typed refusal to its own status and reason', async () => {
    service.nextError = new TranscriptionError(
      'UNSUPPORTED_FORMAT',
      'Unsupported file type ".exe"',
      { extension: '.exe' }
    );
    try {
      const response = await upload({ filename: 'payload.exe' });
      expect(response.status).toBe(415);
      const payload = await response.json();
      expect(payload).toMatchObject({
        code: 'ERR_TRANSCRIPTION_UNSUPPORTED_FORMAT',
        reason: 'UNSUPPORTED_FORMAT'
      });
    } finally {
      service.nextError = null;
    }
  });

  test('an unexpected failure never leaks its message', async () => {
    service.nextError = new Error('/home/pi/secret/path exploded');
    try {
      const response = await upload({ filename: 'song.mp3' });
      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload.error).toBe('Internal server error.');
      expect(JSON.stringify(payload)).not.toMatch(/secret/);
    } finally {
      service.nextError = null;
    }
  });
});

describe('route guard without the feature', () => {
  test('a server with no transcription service answers 503', async () => {
    const bare = new HttpServer({
      logger: noopLogger,
      config: { server: { port: 0, host: '127.0.0.1' }, get: (_k, fallback) => fallback },
      getCapabilityStatus: () => ({ overall: 'ok', capabilities: {} }),
      deviceManager: { getDeviceList: () => [] },
      midiRouter: { getRouteList: () => [] },
      database: { getFiles: () => [], getFileInfo: () => null },
      wsServer: { getStats: () => ({ clients: 0 }) }
    });
    await bare.start();
    try {
      const port = bare.server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/transcription?filename=a.wav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('bytes')
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatch(/not available/i);
    } finally {
      await bare.close();
    }
  });
});
