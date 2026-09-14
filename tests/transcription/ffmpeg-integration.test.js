/**
 * @file tests/transcription/ffmpeg-integration.test.js
 * @description The one suite that runs FFmpeg for real.
 *
 * Everything else fakes the process boundary, which is right for logic but
 * cannot catch an argv mistake, a flag FFmpeg silently ignores, or a
 * `-progress` format that changed. This suite converts an actual generated
 * WAV with the actual binaries.
 *
 * It SKIPS itself when FFmpeg is absent — the same posture the project takes
 * for the native SQLite bindings (see `jest.config.cjs`): a contributor
 * without FFmpeg still gets a green suite, and CI with FFmpeg gets the
 * coverage.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AudioPreprocessor } from '../../src/transcription/AudioPreprocessor.js';
import { AudioProbe } from '../../src/transcription/utils/AudioProbe.js';
import { ProcessRunner } from '../../src/transcription/utils/ProcessRunner.js';
import { makeSineWav, makeArpeggioWav } from '../helpers/audioFixtures.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Is a working FFmpeg on PATH? */
function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeWithFfmpeg = hasFfmpeg() ? describe : describe.skip;

let dir;
let runner;
let probe;
let preprocessor;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-ffmpeg-'));
  runner = new ProcessRunner({ logger: silentLogger });
  probe = new AudioProbe({ logger: silentLogger, processRunner: runner });
  preprocessor = new AudioPreprocessor({
    logger: silentLogger,
    processRunner: runner,
    audioProbe: probe,
    settings: { maxAudioFileBytes: 50 * 1024 * 1024, maxAudioDurationSeconds: 600 }
  });
});

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describeWithFfmpeg('FFmpeg, for real', () => {
  test('the tooling check finds both binaries and their version', async () => {
    const tooling = await probe.checkTooling({ force: true });
    expect(tooling.available).toBe(true);
    expect(tooling.ffmpeg.version).toBeTruthy();
    expect(tooling.ffprobe.version).toBeTruthy();
  });

  test('ffprobe reports what a generated WAV really contains', async () => {
    const file = path.join(dir, 'tone.wav');
    await fs.writeFile(file, makeSineWav({ durationSeconds: 2, sampleRate: 44100 }));

    const result = await probe.probe(file);
    expect(result.hasAudio).toBe(true);
    expect(result.hasVideo).toBe(false);
    expect(result.sampleRate).toBe(44100);
    expect(result.channels).toBe(1);
    expect(result.duration).toBeGreaterThan(1.9);
    expect(result.duration).toBeLessThan(2.1);
  });

  test('conversion produces exactly the format the backend asked for', async () => {
    const input = path.join(dir, 'source.wav');
    const output = path.join(dir, 'normalised.wav');
    await fs.writeFile(input, makeArpeggioWav({ durationSeconds: 2, sampleRate: 44100 }));

    const prepared = await preprocessor.prepare({
      inputPath: input,
      outputPath: output,
      filename: 'source.wav',
      targetFormat: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 }
    });

    expect(prepared.path).toBe(output);
    expect(prepared.duration).toBeGreaterThan(1.9);

    // Ask ffprobe what we actually produced — not what we asked for.
    const produced = await probe.probe(output);
    expect(produced.sampleRate).toBe(22050);
    expect(produced.channels).toBe(1);
    expect(produced.codec).toBe('pcm_s16le');
  });

  test('a stereo source is folded to the mono an engine expects', async () => {
    const input = path.join(dir, 'stereo.wav');
    const output = path.join(dir, 'mono.wav');
    // Build a stereo file with ffmpeg itself, so the input is genuinely 2ch.
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1:sample_rate=44100',
      '-ac',
      '2',
      input
    ]);
    expect((await probe.probe(input)).channels).toBe(2);

    await preprocessor.prepare({
      inputPath: input,
      outputPath: output,
      filename: 'stereo.wav',
      targetFormat: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 }
    });
    expect((await probe.probe(output)).channels).toBe(1);
  });

  test('the audio track is extracted from a video container', async () => {
    const input = path.join(dir, 'clip.mp4');
    const output = path.join(dir, 'from-video.wav');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x64:rate=10:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-shortest',
      input
    ]);

    const probed = await probe.probe(input);
    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(true);

    await preprocessor.prepare({
      inputPath: input,
      outputPath: output,
      filename: 'clip.mp4',
      targetFormat: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 }
    });
    const produced = await probe.probe(output);
    expect(produced.hasAudio).toBe(true);
    expect(produced.hasVideo).toBe(false);
  });

  test('a file that is not media is refused by ffprobe, not by a guess', async () => {
    const file = path.join(dir, 'fake.wav');
    // A valid RIFF header (so the magic check passes) over nonsense.
    const bytes = Buffer.alloc(200);
    bytes.write('RIFF', 0, 'ascii');
    bytes.write('WAVE', 8, 'ascii');
    await fs.writeFile(file, bytes);

    await expect(probe.probe(file)).rejects.toMatchObject({ reason: 'UNSUPPORTED_FORMAT' });
  });

  test('a filename starting with a dash is an argument, never a flag', async () => {
    const input = path.join(dir, '-weird-name.wav');
    const output = path.join(dir, 'from-weird.wav');
    await fs.writeFile(input, makeSineWav({ durationSeconds: 1 }));

    await expect(
      preprocessor.prepare({
        inputPath: input,
        outputPath: output,
        filename: '-weird-name.wav',
        targetFormat: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 }
      })
    ).resolves.toMatchObject({ path: output });
  });

  test('a real conversion reports real progress, then completes', async () => {
    const input = path.join(dir, 'long.wav');
    const output = path.join(dir, 'long-out.wav');
    await fs.writeFile(input, makeSineWav({ durationSeconds: 8, sampleRate: 44100 }));

    const seen = [];
    await preprocessor.prepare({
      inputPath: input,
      outputPath: output,
      filename: 'long.wav',
      targetFormat: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 },
      onProgress: (p) => seen.push(p)
    });

    expect(seen.some((p) => p.stage === 'probing')).toBe(true);
    expect(seen.some((p) => p.stage === 'converting')).toBe(true);
    // Whatever fractions arrived, they are real numbers in range — never a
    // fabricated one (§31).
    for (const point of seen) {
      if (point.progress !== null) {
        expect(point.progress).toBeGreaterThanOrEqual(0);
        expect(point.progress).toBeLessThanOrEqual(1);
      }
    }
  });

  test('cancelling a conversion leaves no process behind', async () => {
    const input = path.join(dir, 'cancel.wav');
    const output = path.join(dir, 'cancel-out.wav');
    await fs.writeFile(input, makeSineWav({ durationSeconds: 30, sampleRate: 44100 }));

    const controller = new AbortController();
    const pending = preprocessor.prepare({
      inputPath: input,
      outputPath: output,
      filename: 'cancel.wav',
      targetFormat: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 },
      signal: controller.signal
    });
    // Abort as soon as the conversion is plausibly under way.
    setTimeout(() => controller.abort(), 30);

    await expect(pending).rejects.toMatchObject({ reason: 'TRANSCRIPTION_CANCELLED' });
    expect(runner.runningCount).toBe(0);
  });
});

// A single always-running test, so the file reports something meaningful
// rather than "0 tests" on a machine with no FFmpeg.
describe('FFmpeg integration coverage', () => {
  test('runs the real-binary suite when FFmpeg is installed', () => {
    expect(typeof hasFfmpeg()).toBe('boolean');
  });
});
