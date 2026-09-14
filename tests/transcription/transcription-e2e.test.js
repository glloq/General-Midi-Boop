/**
 * @file tests/transcription/transcription-e2e.test.js
 * @description The end-to-end proof required by §43: a real WAV fixture goes
 * through the real preprocessor (with FFmpeg faked at the process boundary),
 * a mock backend, the real post-processor and the real encoder, and lands in
 * `FileManager.handleUpload()` — whose result is checked with GMB's own MIDI
 * parser.
 *
 * Nothing heavy runs: no model, no FFmpeg binary, no SQLite. The point is
 * that every seam between the stages is exercised, which is where pipelines
 * actually break.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseMidi } from 'midi-file';
import {
  AudioTranscriptionService,
  buildLibraryFilename
} from '../../src/transcription/AudioTranscriptionService.js';
import {
  TranscriptionJobManager,
  JOB_STATUS,
  TERMINAL_STATUSES
} from '../../src/transcription/TranscriptionJobManager.js';
import { TranscriptionBackendRegistry } from '../../src/transcription/TranscriptionBackendRegistry.js';
import TranscriptionBackend from '../../src/transcription/TranscriptionBackend.js';
import { BACKEND_STATUS } from '../../src/transcription/TranscriptionCapabilities.js';
import MidiFileValidator from '../../src/files/MidiFileValidator.js';
import { makeSineWav } from '../helpers/audioFixtures.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A backend that returns a fixed two-note result, without a model. */
class MockBackend extends TranscriptionBackend {
  constructor(options = {}) {
    super({ logger: silentLogger });
    this.options = options;
    this.calls = [];
  }

  getMetadata() {
    return {
      id: 'mock-engine',
      name: 'Mock Engine',
      version: '0.0.1',
      capabilities: { polyphonic: true, dynamics: true, progress: true, drums: true },
      runtime: { python: false, raspberryPiSuitable: true },
      audioFormat: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 },
      licensing: { codeLicense: 'MIT', modelLicense: 'MIT', commercialUse: true }
    };
  }

  async checkAvailability() {
    return { status: BACKEND_STATUS.AVAILABLE, version: '0.0.1' };
  }

  async transcribe(inputPath, options, context) {
    this.calls.push({ inputPath, options });
    context.onProgress?.({ stage: 'transcribing', progress: 0.5 });
    if (this.options.throwOnTranscribe) throw this.options.throwOnTranscribe;
    if (this.options.hang) {
      return new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return (
      this.options.result || {
        tracks: [
          {
            id: 'track-1',
            instrument: { family: 'piano', label: 'Piano', confidence: 0.96, gmProgram: 0 },
            notes: [
              { start: 0.0, end: 0.5, pitch: 60, velocity: 90, confidence: 0.94 },
              { start: 0.5, end: 1.0, pitch: 64, velocity: 85, confidence: 0.88 },
              // A ghost note the `balanced` preset must remove.
              { start: 0.52, end: 0.525, pitch: 90, velocity: 20, confidence: 0.1 }
            ]
          }
        ],
        warnings: ['engine warning']
      }
    );
  }
}

/** FileManager stand-in: records what it was handed, parses it for real. */
function makeFileManager() {
  const uploads = [];
  return {
    uploads,
    handleUpload: async (filename, buffer, options) => {
      uploads.push({ filename, buffer, options });
      const midi = parseMidi(buffer);
      return {
        fileId: 101 + uploads.length,
        filename,
        status: 'created',
        size: buffer.length,
        tracks: midi.tracks.length
      };
    }
  };
}

/** ProcessRunner stand-in: answers ffprobe with JSON, ffmpeg by copying. */
function makeRunner(sourceWav) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args });
      if (command.includes('ffprobe')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '22050', channels: 1 }
            ],
            format: { duration: '1.0', format_name: 'wav', size: String(sourceWav.length) }
          }),
          stderr: ''
        };
      }
      if (command.includes('ffmpeg')) {
        // The last argument is the output path.
        await fs.writeFile(args[args.length - 1], sourceWav);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
  };
}

let dataDir;
let wav;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-e2e-'));
  wav = makeSineWav({ durationSeconds: 1, frequency: 440 });
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Wire the whole domain together around a mock backend. */
function buildStack({
  backend = new MockBackend(),
  settings = {},
  fileManager = makeFileManager()
} = {}) {
  const events = [];
  const deps = {
    logger: silentLogger,
    eventBus: { emit: (name, payload) => events.push({ name, payload }) },
    config: {
      transcription: {
        dataDir,
        availabilityCacheMs: 0,
        maxAudioFileBytes: 10 * 1024 * 1024,
        maxAudioDurationSeconds: 600,
        ...settings
      }
    },
    fileManager
  };

  const registry = new TranscriptionBackendRegistry(deps);
  registry.register(backend);
  deps.transcriptionBackendRegistry = registry;

  const jobManager = new TranscriptionJobManager({
    ...deps,
    settings: { maxParallelJobs: 1, progressThrottleMs: 0, jobTimeoutMs: 30000 }
  });
  deps.transcriptionJobManager = jobManager;

  const service = new AudioTranscriptionService({ ...deps, processRunner: makeRunner(wav) });
  return { service, registry, jobManager, fileManager, events, deps };
}

/** Wait for a job to reach a terminal state. */
async function settled(jobManager, jobId, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const job = jobManager.get(jobId);
    if (job && TERMINAL_STATUSES.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`job never settled: ${jobManager.get(jobId)?.status}`);
}

describe('audio → MIDI → library', () => {
  test('a WAV fixture ends up as a parseable MIDI file in the library', async () => {
    const { service, jobManager, fileManager, events } = buildStack();

    const created = await service.createJob({ filename: 'melody.wav', buffer: wav });
    expect(created.status).toBe(JOB_STATUS.QUEUED);

    const job = await settled(jobManager, created.id);
    expect(job.status).toBe(JOB_STATUS.COMPLETE);
    expect(job.error).toBeNull();

    // FileManager received real MIDI bytes under the documented name.
    expect(fileManager.uploads).toHaveLength(1);
    const upload = fileManager.uploads[0];
    expect(upload.filename).toBe('melody [Transcribed].mid');
    expect(upload.options.folder).toBe('/');
    expect(upload.buffer.subarray(0, 4).toString('ascii')).toBe('MThd');

    const midi = parseMidi(upload.buffer);
    expect(new MidiFileValidator(silentLogger).validate(midi).valid).toBe(true);
    const notes = midi.tracks.flat().filter((e) => e.type === 'noteOn');
    // The ghost note is gone: 3 detected, 2 kept by the `balanced` preset.
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.noteNumber)).toEqual([60, 64]);

    // The job carries the digest the result screen needs (§32).
    expect(job.fileId).toBe(102);
    expect(job.summary).toMatchObject({
      trackCount: 1,
      noteCount: 2,
      backendId: 'mock-engine',
      preset: 'balanced',
      duplicate: false
    });
    expect(job.summary.instruments[0]).toMatchObject({ label: 'Piano', confidence: 0.96 });
    expect(job.warnings.join(' ')).toMatch(/engine warning/);

    // The full lifecycle reached the event bus (§25).
    const names = events.map((e) => e.name);
    expect(names).toContain('transcription_created');
    expect(names).toContain('transcription_progress');
    expect(names).toContain('transcription_complete');
  });

  test('each stage is reported in order', async () => {
    const { service, jobManager, events } = buildStack();
    const created = await service.createJob({ filename: 'melody.wav', buffer: wav });
    await settled(jobManager, created.id);

    const stages = events
      .filter((e) => e.name === 'transcription_progress')
      .map((e) => e.payload.stage);
    expect([...new Set(stages)]).toEqual([
      JOB_STATUS.PREPROCESSING,
      JOB_STATUS.TRANSCRIBING,
      JOB_STATUS.POSTPROCESSING,
      JOB_STATUS.GENERATING_MIDI,
      JOB_STATUS.IMPORTING
    ]);
  });

  test('the backend is handed the normalised audio, not the user file', async () => {
    const backend = new MockBackend();
    const { service, jobManager } = buildStack({ backend });
    const created = await service.createJob({ filename: 'melody.wav', buffer: wav });
    await settled(jobManager, created.id);

    expect(backend.calls).toHaveLength(1);
    expect(path.basename(backend.calls[0].inputPath)).toBe('audio.wav');
    expect(backend.calls[0].options).toMatchObject({ quality: 'balanced', duration: 1 });
  });

  test('the scratch workspace is always removed', async () => {
    const { service, jobManager } = buildStack();
    const created = await service.createJob({ filename: 'melody.wav', buffer: wav });
    await settled(jobManager, created.id);
    const entries = await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []);
    expect(entries).toEqual([]);
  });

  test('the workspace is removed even when the engine fails', async () => {
    const backend = new MockBackend({ throwOnTranscribe: new Error('model exploded') });
    const { service, jobManager } = buildStack({ backend });
    const created = await service.createJob({ filename: 'melody.wav', buffer: wav });
    const job = await settled(jobManager, created.id);

    expect(job.status).toBe(JOB_STATUS.FAILED);
    expect(job.error.reason).toBe('BACKEND_FAILED');
    const entries = await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []);
    expect(entries).toEqual([]);
  });

  test('cancelling mid-transcription stops the job and leaves nothing behind', async () => {
    const backend = new MockBackend({ hang: true });
    const { service, jobManager, fileManager } = buildStack({ backend });
    const created = await service.createJob({ filename: 'melody.wav', buffer: wav });

    // Wait until the engine is actually running before cancelling.
    for (let i = 0; i < 100 && backend.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    jobManager.cancel(created.id);

    const job = await settled(jobManager, created.id);
    expect(job.status).toBe(JOB_STATUS.CANCELLED);
    expect(fileManager.uploads).toHaveLength(0);
    const entries = await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []);
    expect(entries).toEqual([]);
  });

  test('a failing library import is reported as MIDI_IMPORT_FAILED', async () => {
    const fileManager = {
      handleUpload: async () => {
        throw new Error('database is locked');
      }
    };
    const { service, jobManager } = buildStack({ fileManager });
    const created = await service.createJob({ filename: 'melody.wav', buffer: wav });
    const job = await settled(jobManager, created.id);
    expect(job.error.reason).toBe('MIDI_IMPORT_FAILED');
    expect(job.error.message).toMatch(/database is locked/);
  });

  test('a silent transcription fails cleanly instead of writing an empty file', async () => {
    const backend = new MockBackend({ result: { tracks: [] } });
    const { service, jobManager, fileManager } = buildStack({ backend });
    const created = await service.createJob({ filename: 'silence.wav', buffer: wav });
    const job = await settled(jobManager, created.id);
    expect(job.error.reason).toBe('MIDI_GENERATION_FAILED');
    expect(fileManager.uploads).toHaveLength(0);
  });

  test('a drum transcription lands on channel 10 with mapped notes', async () => {
    const backend = new MockBackend({
      result: {
        tracks: [
          {
            id: 'drums',
            instrument: { family: 'drums', label: 'Drums', isDrums: true },
            notes: [
              { start: 0, end: 0.2, pitch: 1, velocity: 100, label: 'kick' },
              { start: 0.5, end: 0.7, pitch: 2, velocity: 90, label: 'snare' }
            ]
          }
        ]
      }
    });
    const { service, jobManager, fileManager } = buildStack({ backend });
    const created = await service.createJob({ filename: 'beat.wav', buffer: wav });
    await settled(jobManager, created.id);

    const midi = parseMidi(fileManager.uploads[0].buffer);
    const notes = midi.tracks.flat().filter((e) => e.type === 'noteOn');
    expect(notes.map((n) => n.channel)).toEqual([9, 9]);
    expect(notes.map((n) => n.noteNumber)).toEqual([36, 38]);
  });
});

describe('request validation happens before a job exists', () => {
  test('an unsupported extension is refused by the command, not by a failed job', async () => {
    const { service, jobManager } = buildStack();
    await expect(service.createJob({ filename: 'payload.exe', buffer: wav })).rejects.toMatchObject(
      { reason: 'UNSUPPORTED_FORMAT' }
    );
    expect(jobManager.list()).toHaveLength(0);
  });

  test('an oversized file is refused up front', async () => {
    // 1 MB is the lowest value the config resolver accepts — anything
    // smaller is clamped back up, precisely so a typo cannot make the guard
    // reject every file.
    const { service, jobManager } = buildStack({ settings: { maxAudioFileBytes: 1024 * 1024 } });
    const big = makeSineWav({ durationSeconds: 30 });
    expect(big.length).toBeGreaterThan(1024 * 1024);
    await expect(service.createJob({ filename: 'big.wav', buffer: big })).rejects.toMatchObject({
      reason: 'FILE_TOO_LARGE'
    });
    expect(jobManager.list()).toHaveLength(0);
  });

  test('no audio at all is refused', async () => {
    const { service } = buildStack();
    await expect(service.createJob({ filename: 'x.wav' })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_FORMAT'
    });
  });

  test('an unknown engine is refused by name', async () => {
    const { service } = buildStack();
    await expect(
      service.createJob({ filename: 'melody.wav', buffer: wav, backendId: 'not-here' })
    ).rejects.toMatchObject({ reason: 'BACKEND_NOT_INSTALLED' });
  });

  test('with no engine at all, the error says so', async () => {
    const { service, registry } = buildStack();
    registry.unregister('mock-engine');
    await expect(service.createJob({ filename: 'melody.wav', buffer: wav })).rejects.toMatchObject({
      reason: 'BACKEND_NOT_INSTALLED'
    });
  });

  test('the feature can be switched off entirely', async () => {
    const { service } = buildStack({ settings: { enabled: false } });
    await expect(service.createJob({ filename: 'melody.wav', buffer: wav })).rejects.toMatchObject({
      reason: 'BACKEND_NOT_INSTALLED'
    });
  });
});

describe('availability reporting (§23)', () => {
  test('ready when FFmpeg and an engine are both there', async () => {
    const { service } = buildStack();
    const availability = await service.getAvailability();
    expect(availability.status).toBe('ready');
    expect(availability.ffmpeg.available).toBe(true);
    expect(availability.backends[0]).toMatchObject({ id: 'mock-engine', available: true });
  });

  test('degraded — not failed — when no engine is installed', async () => {
    const { service, registry } = buildStack();
    registry.unregister('mock-engine');
    const availability = await service.getAvailability();
    expect(availability.status).toBe('degraded');
    expect(availability.detail).toMatch(/No transcription engine is installed/);
  });

  test('disabled reports as disabled, without probing anything', async () => {
    const { service } = buildStack({ settings: { enabled: false } });
    const availability = await service.getAvailability();
    expect(availability.status).toBe('disabled');
    expect(availability.backends).toEqual([]);
  });
});

describe('library naming', () => {
  test('marks the file as a transcription and keeps the original stem', () => {
    expect(buildLibraryFilename('My Song.mp3')).toBe('My Song [Transcribed].mid');
    expect(buildLibraryFilename('beat.flac')).toBe('beat [Transcribed].mid');
  });

  test('never lets a name become a path', () => {
    expect(buildLibraryFilename('../../etc/passwd.mp3')).toBe('passwd [Transcribed].mid');
    expect(buildLibraryFilename('a/b/c.wav')).toBe('c [Transcribed].mid');
    expect(buildLibraryFilename('')).toBe('audio [Transcribed].mid');
  });

  test('bounds the length', () => {
    const long = buildLibraryFilename(`${'x'.repeat(400)}.wav`);
    expect(long.length).toBeLessThan(150);
  });
});
