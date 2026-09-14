/**
 * @file tests/transcription/basic-pitch-backend.test.js
 * @description The first real engine (§7), tested without Python, without
 * TensorFlow and without a model: the process boundary is injected, so what
 * is exercised here is exactly the part GMB owns — the availability ladder,
 * the argv it builds, the JSON Lines it parses, and the mapping onto the
 * pivot format.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  BasicPitchBackend,
  normalizeRunnerOutput,
  pythonEnv,
  lastJsonLine,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_SCRIPT,
  REQUIREMENTS_FILE
} from '../../src/transcription/backends/BasicPitchBackend.js';
import {
  BACKEND_STATUS,
  normalizeBackendMetadata
} from '../../src/transcription/TranscriptionCapabilities.js';
import { createTranscriptionResult } from '../../src/transcription/TranscriptionResult.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** ProcessRunner double driven by a queue. */
function makeRunner(results = []) {
  const calls = [];
  const queue = [...results];
  return {
    calls,
    run: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      const next = queue.shift();
      if (typeof next === 'function') return next({ command, args, options });
      if (next instanceof Error) throw next;
      return { code: 0, stdout: '', stderr: '', durationMs: 1, ...(next || {}) };
    }
  };
}

/** A self-check answer as the runner prints it. */
function selfCheckLine(overrides = {}) {
  return `${JSON.stringify({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    ok: true,
    version: '0.4.0',
    modelVersion: 'ICASSP_2022',
    ...overrides
  })}\n`;
}

let dataDir;

/** A backend whose venv lives in a real (empty) temp directory. */
function makeBackend(runnerResults = [], extra = {}) {
  const runner = makeRunner(runnerResults);
  const backend = new BasicPitchBackend({
    logger: silentLogger,
    config: { transcription: { dataDir } },
    processRunner: runner,
    ...extra
  });
  return { backend, runner };
}

/** Create the venv layout so the availability ladder reaches the self-check. */
async function installFakeVenv() {
  const binDir = path.join(dataDir, 'venvs', 'basic-pitch', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'python'), '#!/bin/sh\n');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-bp-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('metadata', () => {
  test('is a valid backend descriptor', () => {
    const { backend } = makeBackend();
    expect(() => normalizeBackendMetadata(backend.getMetadata())).not.toThrow();
    expect(backend.id).toBe('basic-pitch');
  });

  test('claims only what Basic Pitch actually does', () => {
    const { capabilities } = normalizeBackendMetadata(makeBackend().backend.getMetadata());
    expect(capabilities.polyphonic).toBe(true);
    expect(capabilities.pitchBend).toBe(true);
    expect(capabilities.dynamics).toBe(true);
    expect(capabilities.progress).toBe(true);
    // The three it must NOT claim — the UI disables those options because of
    // exactly these flags (§7/§30).
    expect(capabilities.multiInstrument).toBe(false);
    expect(capabilities.drums).toBe(false);
    expect(capabilities.instrumentRecognition).toBe(false);
    expect(capabilities.tempoDetection).toBe(false);
  });

  test('is declared Pi-suitable, CPU-only, and asks for the format it wants', () => {
    const metadata = normalizeBackendMetadata(makeBackend().backend.getMetadata());
    expect(metadata.runtime).toMatchObject({ python: true, gpu: false, raspberryPiSuitable: true });
    expect(metadata.audioFormat).toEqual({
      container: 'wav',
      encoding: 'pcm_s16le',
      sampleRate: 22050,
      channels: 1
    });
  });

  test('declares a permissive licence and still ships nothing', () => {
    const { licensing } = normalizeBackendMetadata(makeBackend().backend.getMetadata());
    expect(licensing.codeLicense).toBe('Apache-2.0');
    expect(licensing.modelLicense).toBe('Apache-2.0');
    expect(licensing.commercialUse).toBe(true);
    // §47.15: no model weights inside the repository, permissive or not.
    expect(licensing.bundled).toBe(false);
    expect(licensing.licenseUrl).toMatch(/^https:\/\//);
  });

  test('offers all three quality profiles', () => {
    const metadata = normalizeBackendMetadata(makeBackend().backend.getMetadata());
    expect(metadata.qualityProfiles).toEqual(['fast', 'balanced', 'maximum']);
  });
});

describe('availability ladder', () => {
  test('reports installable — not broken — when the venv is absent', async () => {
    const { backend, runner } = makeBackend();
    const report = await backend.checkAvailability();
    expect(report.status).toBe(BACKEND_STATUS.INSTALLABLE);
    expect(report.detail).toMatch(/Not installed/);
    // Nothing was spawned: there is no interpreter to spawn.
    expect(runner.calls).toHaveLength(0);
  });

  test('runs the self-check once the venv exists, and reports the version', async () => {
    await installFakeVenv();
    const { backend, runner } = makeBackend([{ code: 0, stdout: selfCheckLine() }]);
    const report = await backend.checkAvailability();

    expect(report).toMatchObject({
      status: BACKEND_STATUS.AVAILABLE,
      version: '0.4.0',
      modelVersion: 'ICASSP_2022'
    });
    expect(runner.calls[0].command).toBe(backend.pythonPath);
    expect(runner.calls[0].args).toEqual([RUNNER_SCRIPT, '--self-check']);
  });

  test('caches the answer, and force re-probes', async () => {
    await installFakeVenv();
    const { backend, runner } = makeBackend([
      { code: 0, stdout: selfCheckLine() },
      { code: 0, stdout: selfCheckLine({ version: '0.4.1' }) }
    ]);
    await backend.checkAvailability();
    await backend.checkAvailability();
    expect(runner.calls).toHaveLength(1);

    const refreshed = await backend.checkAvailability({ force: true });
    expect(refreshed.version).toBe('0.4.1');
  });

  test('an environment that does not import is broken, with the reason', async () => {
    await installFakeVenv();
    const { backend } = makeBackend([
      { code: 0, stdout: selfCheckLine({ ok: false, error: "ModuleNotFoundError: 'basic_pitch'" }) }
    ]);
    const report = await backend.checkAvailability();
    expect(report.status).toBe(BACKEND_STATUS.BROKEN);
    expect(report.detail).toMatch(/ModuleNotFoundError/);
  });

  test('a protocol mismatch is broken, and says to reinstall', async () => {
    await installFakeVenv();
    const { backend } = makeBackend([{ code: 0, stdout: selfCheckLine({ protocolVersion: 99 }) }]);
    const report = await backend.checkAvailability();
    expect(report.status).toBe(BACKEND_STATUS.BROKEN);
    expect(report.detail).toMatch(/protocol 99/);
  });

  test('a crashing interpreter is broken, never an exception', async () => {
    await installFakeVenv();
    const { backend } = makeBackend([{ code: 1, stderr: 'Segmentation fault\n' }]);
    await expect(backend.checkAvailability()).resolves.toMatchObject({
      status: BACKEND_STATUS.BROKEN,
      detail: expect.stringContaining('Segmentation fault')
    });
  });

  test('unparseable output is broken, never a throw', async () => {
    await installFakeVenv();
    const { backend } = makeBackend([{ code: 0, stdout: 'Using TensorFlow backend.\n' }]);
    await expect(backend.checkAvailability()).resolves.toMatchObject({
      status: BACKEND_STATUS.BROKEN
    });
  });

  test('a spawn failure is an answer too', async () => {
    await installFakeVenv();
    const { backend } = makeBackend([new Error('EACCES')]);
    await expect(backend.checkAvailability()).resolves.toMatchObject({
      status: BACKEND_STATUS.BROKEN,
      detail: 'EACCES'
    });
  });
});

describe('transcribe', () => {
  /** Set up an installed engine with a result file ready to be read. */
  async function readyBackend(document, { runnerResult } = {}) {
    await installFakeVenv();
    const workDir = path.join(dataDir, 'job');
    await fs.mkdir(workDir, { recursive: true });

    const { backend, runner } = makeBackend([
      { code: 0, stdout: selfCheckLine() },
      async ({ args }) => {
        const outputPath = args[args.indexOf('--output') + 1];
        if (document) await fs.writeFile(outputPath, JSON.stringify(document));
        return { code: 0, stdout: '', stderr: '', ...(runnerResult || {}) };
      }
    ]);
    return { backend, runner, workDir };
  }

  test('refuses to run when the engine is not installed', async () => {
    const { backend } = makeBackend();
    const error = await backend.transcribe('/tmp/audio.wav', {}, {}).catch((e) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.reason).toBe('BACKEND_NOT_INSTALLED');
  });

  test('builds a fixed argv and passes options through a FILE, not the command line', async () => {
    const { backend, runner, workDir } = await readyBackend({ notes: [], duration: 0 });
    await backend.transcribe(path.join(workDir, 'audio.wav'), { quality: 'fast' }, { workDir });

    const call = runner.calls[1];
    expect(call.args[0]).toBe(RUNNER_SCRIPT);
    expect(call.args).toContain('--input');
    expect(call.args).toContain('--output');
    expect(call.args).toContain('--options');
    // Only paths we built ourselves reach argv.
    expect(call.args.every((arg) => typeof arg === 'string')).toBe(true);

    const optionsPath = call.args[call.args.indexOf('--options') + 1];
    const options = JSON.parse(await fs.readFile(optionsPath, 'utf8'));
    expect(options).toMatchObject({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      onsetThreshold: 0.6,
      sampleRate: 22050
    });
  });

  test('maps quality onto the engine thresholds', async () => {
    const { backend, runner, workDir } = await readyBackend({ notes: [], duration: 0 });
    await backend.transcribe(path.join(workDir, 'audio.wav'), { quality: 'maximum' }, { workDir });
    const call = runner.calls[1];
    const options = JSON.parse(
      await fs.readFile(call.args[call.args.indexOf('--options') + 1], 'utf8')
    );
    expect(options.onsetThreshold).toBe(0.4);
    expect(options.minNoteLengthMs).toBe(30);
  });

  test('asks for pitch bends only when the job wants them', async () => {
    const { backend, runner, workDir } = await readyBackend({ notes: [], duration: 0 });
    await backend.transcribe(
      path.join(workDir, 'audio.wav'),
      { preservePitchBends: false },
      { workDir }
    );
    const options = JSON.parse(
      await fs.readFile(runner.calls[1].args[runner.calls[1].args.indexOf('--options') + 1], 'utf8')
    );
    expect(options.includePitchBends).toBe(false);
  });

  test('forwards progress frames and ignores anything that is not JSON', async () => {
    await installFakeVenv();
    const workDir = path.join(dataDir, 'job');
    await fs.mkdir(workDir, { recursive: true });

    const progress = [];
    const { backend } = makeBackend([
      { code: 0, stdout: selfCheckLine() },
      async ({ args, options }) => {
        options.onStdoutLine('2026-09-14 TensorFlow noise on stdout');
        options.onStdoutLine('{"type":"progress","stage":"loading","progress":0.05}');
        options.onStdoutLine('{"type":"log","message":"model loaded"}');
        options.onStdoutLine('{"type":"progress","stage":"transcribing","progress":0.5}');
        options.onStdoutLine('{ not json at all');
        await fs.writeFile(args[args.indexOf('--output') + 1], JSON.stringify({ notes: [] }));
        return { code: 0 };
      }
    ]);

    await backend.transcribe(
      path.join(workDir, 'audio.wav'),
      {},
      { workDir, onProgress: (p) => progress.push(p) }
    );
    expect(progress).toEqual([
      { stage: 'loading', progress: 0.05 },
      { stage: 'transcribing', progress: 0.5 }
    ]);
  });

  test('forwards the cancellation signal to the subprocess', async () => {
    const controller = new AbortController();
    const { backend, runner, workDir } = await readyBackend({ notes: [] });
    await backend.transcribe(
      path.join(workDir, 'audio.wav'),
      {},
      { workDir, signal: controller.signal }
    );
    expect(runner.calls[1].options.signal).toBe(controller.signal);
  });

  test('turns a Python MemoryError into OUT_OF_MEMORY, not a generic failure', async () => {
    const { backend, workDir } = await readyBackend(null, {
      runnerResult: { code: 4, stderr: 'MemoryError while transcribing\n' }
    });
    const error = await backend
      .transcribe(path.join(workDir, 'audio.wav'), {}, { workDir })
      .catch((e) => e);
    expect(error.reason).toBe('OUT_OF_MEMORY');
    expect(error.message).toMatch(/shorter file/);
  });

  test('surfaces any other failure with the tail of stderr', async () => {
    const { backend, workDir } = await readyBackend(null, {
      runnerResult: { code: 1, stderr: 'Traceback...\nValueError: bad audio\n' }
    });
    const error = await backend
      .transcribe(path.join(workDir, 'audio.wav'), {}, { workDir })
      .catch((e) => e);
    expect(error.reason).toBe('BACKEND_FAILED');
    expect(error.message).toMatch(/ValueError: bad audio/);
  });

  test('a zero exit with no result file is still a failure', async () => {
    const { backend, workDir } = await readyBackend(null);
    const error = await backend
      .transcribe(path.join(workDir, 'audio.wav'), {}, { workDir })
      .catch((e) => e);
    expect(error.reason).toBe('BACKEND_FAILED');
    expect(error.message).toMatch(/no readable result/);
  });

  test('returns a structure the pivot format accepts', async () => {
    const { backend, workDir } = await readyBackend({
      notes: [
        { start: 0.5, end: 1.2, pitch: 60, velocity: 90, confidence: 0.91 },
        { start: 1.3, end: 1.9, pitch: 64, velocity: 80, confidence: 0.77 }
      ],
      duration: 2,
      sampleRate: 22050
    });

    const raw = await backend.transcribe(path.join(workDir, 'audio.wav'), {}, { workDir });
    const result = createTranscriptionResult(raw);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].notes).toHaveLength(2);
    expect(result.backend).toMatchObject({ id: 'basic-pitch', version: '0.4.0' });
  });
});

describe('output mapping (§11/§15 — no invented precision)', () => {
  test('leaves instrument, tempo and drums unknown', () => {
    const raw = normalizeRunnerOutput({
      notes: [{ start: 0, end: 1, pitch: 60, velocity: 90, confidence: 0.9 }],
      duration: 1
    });
    expect(raw.tempoMap).toEqual([]);
    expect(raw.timeSignatures).toEqual([]);
    expect(raw.tracks[0].instrument).toEqual({
      family: null,
      label: null,
      confidence: null,
      gmProgram: null,
      isDrums: false
    });
  });

  test('produces no track at all when nothing was detected', () => {
    const raw = normalizeRunnerOutput({ notes: [], duration: 3, warnings: ['no notes'] });
    expect(raw.tracks).toEqual([]);
    expect(raw.warnings).toEqual(['no notes']);
  });

  test('spreads pitch bends across the note as an expression curve', () => {
    const raw = normalizeRunnerOutput({
      notes: [
        { start: 1, end: 2, pitch: 60, velocity: 90, confidence: 0.9, pitchBends: [0, 0.33, 0.66] }
      ]
    });
    const curve = raw.tracks[0].notes[0].expression.pitchCurve;
    expect(curve).toHaveLength(3);
    expect(curve[0].t).toBeCloseTo(1, 5);
    expect(curve[2].t).toBeCloseTo(1 + 2 / 3, 5);
    expect(curve[2].value).toBe(0.66);
  });

  test('a note with no bends carries no expression', () => {
    const raw = normalizeRunnerOutput({ notes: [{ start: 0, end: 1, pitch: 60, velocity: 90 }] });
    expect(raw.tracks[0].notes[0].expression).toBeNull();
  });

  test('survives a malformed document rather than throwing', () => {
    expect(normalizeRunnerOutput(null).tracks).toEqual([]);
    expect(normalizeRunnerOutput({ notes: 'nope' }).tracks).toEqual([]);
    expect(normalizeRunnerOutput({ warnings: [1, 'ok'] }).warnings).toEqual(['ok']);
  });
});

describe('child environment', () => {
  test('puts the venv first on PATH and keeps stdout unbuffered', () => {
    const env = pythonEnv('/opt/venvs/basic-pitch');
    expect(env.VIRTUAL_ENV).toBe('/opt/venvs/basic-pitch');
    expect(env.PATH.startsWith('/opt/venvs/basic-pitch/bin')).toBe(true);
    // Buffered stdout would deliver every progress frame at the very end.
    expect(env.PYTHONUNBUFFERED).toBe('1');
  });

  test('caps TensorFlow threads so a 4-core Pi keeps serving MIDI', () => {
    const env = pythonEnv('/opt/venv');
    expect(Number(env.OMP_NUM_THREADS)).toBeLessThanOrEqual(2);
    expect(Number(env.TF_NUM_INTRAOP_THREADS)).toBeLessThanOrEqual(2);
  });
});

describe('shipped files', () => {
  test('the runner and its pinned requirements are in the repository', async () => {
    await expect(fs.access(RUNNER_SCRIPT)).resolves.toBeUndefined();
    await expect(fs.access(REQUIREMENTS_FILE)).resolves.toBeUndefined();
  });

  test('every requirement is pinned to an exact version (§35)', async () => {
    const lines = (await fs.readFile(REQUIREMENTS_FILE, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    expect(lines.length).toBeGreaterThan(0);
    const unpinned = lines.filter((line) => !/==\s*[\w.]+/.test(line));
    expect(unpinned).toEqual([]);
  });

  test('the runner speaks the protocol version this backend expects', async () => {
    const source = await fs.readFile(RUNNER_SCRIPT, 'utf8');
    expect(source).toContain(`PROTOCOL_VERSION = ${RUNNER_PROTOCOL_VERSION}`);
  });

  test('no model weights are committed anywhere near it', async () => {
    const entries = await fs.readdir(path.dirname(RUNNER_SCRIPT));
    expect(entries.sort()).toEqual(['requirements.txt', 'runner.py']);
  });
});

describe('lastJsonLine', () => {
  test('picks the final JSON object out of noisy stdout', () => {
    expect(lastJsonLine('noise\n{"a":1}\nmore noise\n{"b":2}\n')).toBe('{"b":2}');
    expect(lastJsonLine('nothing here')).toBe('');
    expect(lastJsonLine('')).toBe('');
  });
});
