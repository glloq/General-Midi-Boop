/**
 * @file tests/transcription/audio-preprocessor.test.js
 * @description The funnel every user file goes through (§4/§5/§40): cheap
 * rejections first, ffprobe as the only authority on what a file contains,
 * and an FFmpeg command line that cannot be turned into shell syntax.
 * FFmpeg and ffprobe are never executed — the ProcessRunner is faked.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  AudioPreprocessor,
  buildFfmpegArgs,
  makeFfmpegProgressParser,
  SUPPORTED_EXTENSIONS
} from '../../src/transcription/AudioPreprocessor.js';
import {
  AudioProbe,
  summarizeProbe,
  parseVersion
} from '../../src/transcription/utils/AudioProbe.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';
import { DEFAULT_AUDIO_FORMAT } from '../../src/transcription/TranscriptionCapabilities.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Minimal 44-byte RIFF/WAVE header — enough for the magic-byte check. */
function wavBytes(payloadSize = 16) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + payloadSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(payloadSize, 40);
  return Buffer.concat([header, Buffer.alloc(payloadSize)]);
}

/** ProcessRunner stand-in driven by a queue of results. */
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

/** ffprobe JSON for a plain mono MP3. */
function probeJson(overrides = {}) {
  return JSON.stringify({
    streams: [
      {
        codec_type: 'audio',
        codec_name: 'mp3',
        sample_rate: '44100',
        channels: 2,
        ...overrides.audio
      }
    ],
    format: {
      duration: '12.5',
      format_name: 'mp3',
      bit_rate: '128000',
      size: '200000',
      ...overrides.format
    }
  });
}

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-audio-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('descriptor validation (cheap rejections first)', () => {
  const settings = { maxAudioFileBytes: 1000, maxAudioDurationSeconds: 60 };

  test('accepts every documented extension, case-insensitively', () => {
    const pre = new AudioPreprocessor({ logger: silentLogger, settings });
    for (const extension of SUPPORTED_EXTENSIONS) {
      expect(pre.validateDescriptor({ filename: `song${extension.toUpperCase()}` })).toMatchObject({
        extension
      });
    }
  });

  test('flags video containers so the audio track gets extracted', () => {
    const pre = new AudioPreprocessor({ logger: silentLogger, settings });
    expect(pre.validateDescriptor({ filename: 'clip.mkv' }).isVideo).toBe(true);
    expect(pre.validateDescriptor({ filename: 'song.flac' }).isVideo).toBe(false);
  });

  test('refuses an unsupported extension with the accepted list', () => {
    const pre = new AudioPreprocessor({ logger: silentLogger, settings });
    const error = (() => {
      try {
        pre.validateDescriptor({ filename: 'payload.exe' });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.reason).toBe('UNSUPPORTED_FORMAT');
    expect(error.message).toMatch(/\.wav/);
  });

  test('refuses an oversized file before reading a single byte', () => {
    const pre = new AudioPreprocessor({ logger: silentLogger, settings });
    expect(() => pre.validateDescriptor({ filename: 'a.wav', sizeBytes: 5000 })).toThrow(
      /the limit is/
    );
  });
});

describe('container sniffing (§40 — MIME spoofing)', () => {
  test('accepts real container signatures', async () => {
    const pre = new AudioPreprocessor({ logger: silentLogger });
    const file = path.join(dir, 'a.wav');
    await fs.writeFile(file, wavBytes());
    await expect(pre.assertKnownContainer(file)).resolves.toBe('riff');

    const mp3 = path.join(dir, 'b.mp3');
    await fs.writeFile(mp3, Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]));
    await expect(pre.assertKnownContainer(mp3)).resolves.toBe('id3');

    const bareMpeg = path.join(dir, 'c.mp3');
    await fs.writeFile(bareMpeg, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await expect(pre.assertKnownContainer(bareMpeg)).resolves.toBe('mpeg');

    const mp4 = path.join(dir, 'd.m4a');
    await fs.writeFile(mp4, Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]));
    await expect(pre.assertKnownContainer(mp4)).resolves.toBe('mp4');
  });

  test('refuses an executable renamed to .mp3', async () => {
    const pre = new AudioPreprocessor({ logger: silentLogger });
    const file = path.join(dir, 'evil.mp3');
    await fs.writeFile(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
    await expect(pre.assertKnownContainer(file)).rejects.toMatchObject({
      reason: 'UNSUPPORTED_FORMAT'
    });
  });

  test('refuses an empty file', async () => {
    const pre = new AudioPreprocessor({ logger: silentLogger });
    const file = path.join(dir, 'empty.wav');
    await fs.writeFile(file, Buffer.alloc(0));
    await expect(pre.assertKnownContainer(file)).rejects.toBeInstanceOf(TranscriptionError);
  });
});

describe('prepare()', () => {
  async function makePrepared({ runnerResults, settings, write = true } = {}) {
    const input = path.join(dir, 'song.wav');
    const output = path.join(dir, 'audio.wav');
    if (write) await fs.writeFile(input, wavBytes(128));
    const runner = makeRunner(runnerResults);
    const probe = new AudioProbe({ logger: silentLogger, processRunner: runner });
    const pre = new AudioPreprocessor({
      logger: silentLogger,
      processRunner: runner,
      audioProbe: probe,
      settings: settings || { maxAudioFileBytes: 10 ** 7, maxAudioDurationSeconds: 600 }
    });
    return { pre, runner, input, output };
  }

  test('probes, converts and reports what it produced', async () => {
    const { pre, runner, input, output } = await makePrepared({
      runnerResults: [
        { code: 0, stdout: probeJson() },
        async () => {
          await fs.writeFile(output, wavBytes(64));
          return { code: 0, stdout: '', stderr: '' };
        }
      ]
    });

    const stages = [];
    const result = await pre.prepare({
      inputPath: input,
      outputPath: output,
      filename: 'song.wav',
      onProgress: (p) => stages.push(p.stage)
    });

    expect(result.path).toBe(output);
    expect(result.duration).toBe(12.5);
    expect(result.format).toEqual(DEFAULT_AUDIO_FORMAT);
    expect(result.source.codec).toBe('mp3');
    expect(stages).toEqual(['probing', 'converting']);
    expect(runner.calls[0].command).toBe('ffprobe');
    expect(runner.calls[1].command).toBe('ffmpeg');
  });

  test('converts into the format the BACKEND declared, not a fixed one', async () => {
    const { pre, runner, input, output } = await makePrepared({
      runnerResults: [
        { code: 0, stdout: probeJson() },
        async () => {
          await fs.writeFile(output, wavBytes(64));
          return { code: 0 };
        }
      ]
    });
    await pre.prepare({
      inputPath: input,
      outputPath: output,
      targetFormat: { sampleRate: 16000, channels: 2, encoding: 'pcm_f32le' }
    });
    const args = runner.calls[1].args;
    expect(args).toContain('16000');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
    expect(args[args.indexOf('-acodec') + 1]).toBe('pcm_f32le');
  });

  test('refuses a file whose audio is longer than the limit', async () => {
    const { pre, input, output } = await makePrepared({
      runnerResults: [{ code: 0, stdout: probeJson({ format: { duration: '4000' } }) }],
      settings: { maxAudioFileBytes: 10 ** 7, maxAudioDurationSeconds: 600 }
    });
    const error = await pre.prepare({ inputPath: input, outputPath: output }).catch((e) => e);
    expect(error.reason).toBe('AUDIO_TOO_LONG');
    expect(error.details.limitSeconds).toBe(600);
    expect(error.message).toMatch(/1:06:40/);
  });

  test('refuses a video file with no audio track', async () => {
    const { pre, input, output } = await makePrepared({
      runnerResults: [
        { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }], format: {} }) }
      ]
    });
    await expect(pre.prepare({ inputPath: input, outputPath: output })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_FORMAT'
    });
  });

  test('a missing FFmpeg is reported as FFMPEG_MISSING, not a generic failure', async () => {
    const enoent = new TranscriptionError('BACKEND_FAILED', 'Command not found', {
      code: 'ENOENT'
    });
    const { pre, input, output } = await makePrepared({
      runnerResults: [{ code: 0, stdout: probeJson() }, enoent]
    });
    await expect(pre.prepare({ inputPath: input, outputPath: output })).rejects.toMatchObject({
      reason: 'FFMPEG_MISSING'
    });
  });

  test('a non-zero FFmpeg exit surfaces the tail of its diagnostics', async () => {
    const { pre, input, output } = await makePrepared({
      runnerResults: [
        { code: 0, stdout: probeJson() },
        { code: 1, stderr: 'Invalid data found when processing input\n' }
      ]
    });
    const error = await pre.prepare({ inputPath: input, outputPath: output }).catch((e) => e);
    expect(error.reason).toBe('UNSUPPORTED_FORMAT');
    expect(error.details.detail).toMatch(/Invalid data/);
  });

  test('a zero exit that produced nothing is still a failure', async () => {
    const { pre, input, output } = await makePrepared({
      runnerResults: [{ code: 0, stdout: probeJson() }, { code: 0 }]
    });
    await expect(pre.prepare({ inputPath: input, outputPath: output })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_FORMAT'
    });
  });

  test('an empty output file is a failure too', async () => {
    const { pre, input, output } = await makePrepared({
      runnerResults: [
        { code: 0, stdout: probeJson() },
        async () => {
          await fs.writeFile(output, Buffer.alloc(0));
          return { code: 0 };
        }
      ]
    });
    await expect(pre.prepare({ inputPath: input, outputPath: output })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_FORMAT'
    });
  });

  test('forwards the cancellation signal to both subprocesses', async () => {
    const controller = new AbortController();
    const { pre, runner, input, output } = await makePrepared({
      runnerResults: [
        { code: 0, stdout: probeJson() },
        async () => {
          await fs.writeFile(output, wavBytes(64));
          return { code: 0 };
        }
      ]
    });
    await pre.prepare({ inputPath: input, outputPath: output, signal: controller.signal });
    expect(runner.calls[0].options.signal).toBe(controller.signal);
    expect(runner.calls[1].options.signal).toBe(controller.signal);
  });
});

describe('FFmpeg command line', () => {
  test('puts -i before the input so a leading dash cannot become a flag', () => {
    const args = buildFfmpegArgs({
      inputPath: '-evil.wav',
      outputPath: '/tmp/out.wav',
      format: DEFAULT_AUDIO_FORMAT
    });
    expect(args[args.indexOf('-evil.wav') - 1]).toBe('-i');
    expect(args[args.length - 1]).toBe('/tmp/out.wav');
  });

  test('drops video, subtitle and data streams', () => {
    const args = buildFfmpegArgs({
      inputPath: 'in.mkv',
      outputPath: 'out.wav',
      format: DEFAULT_AUDIO_FORMAT
    });
    expect(args).toEqual(expect.arrayContaining(['-vn', '-sn', '-dn', '-map', '0:a:0']));
  });

  test('never emits a shell metacharacter as part of an argument', () => {
    const args = buildFfmpegArgs({
      inputPath: '/tmp/a; rm -rf ~.wav',
      outputPath: '/tmp/out.wav',
      format: DEFAULT_AUDIO_FORMAT
    });
    // The dangerous text stays a single, whole argument.
    expect(args.filter((a) => a.includes(';'))).toEqual(['/tmp/a; rm -rf ~.wav']);
  });
});

describe('FFmpeg progress parsing', () => {
  test('turns out_time_ms into a fraction of the known duration', () => {
    const seen = [];
    const parse = makeFfmpegProgressParser(10, (p) => seen.push(p.progress));
    parse('out_time_ms=5000000');
    parse('bitrate=N/A');
    parse('out_time_ms=20000000');
    expect(seen).toEqual([0.5, 1]);
  });

  test('stays indeterminate when the duration is unknown — never a fake bar', () => {
    const seen = [];
    makeFfmpegProgressParser(0, (p) => seen.push(p.progress))('out_time_ms=5000000');
    expect(seen).toEqual([null]);
  });
});

describe('AudioProbe', () => {
  test('summarises the first audio stream and reports a real video track', () => {
    const summary = summarizeProbe({
      streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }
      ],
      format: { duration: '61.2', format_name: 'mov,mp4', size: '900', bit_rate: '256000' }
    });
    expect(summary).toMatchObject({
      duration: 61.2,
      sampleRate: 48000,
      channels: 2,
      codec: 'aac',
      hasAudio: true,
      hasVideo: true,
      audioStreams: 1
    });
  });

  test('cover art is not a video track', () => {
    const summary = summarizeProbe({
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        { codec_type: 'audio', codec_name: 'mp3' }
      ],
      format: {}
    });
    expect(summary.hasVideo).toBe(false);
    expect(summary.hasAudio).toBe(true);
  });

  test('falls back to the stream duration, then to zero', () => {
    expect(
      summarizeProbe({ streams: [{ codec_type: 'audio', duration: '3.5' }], format: {} }).duration
    ).toBe(3.5);
    expect(summarizeProbe({ streams: [], format: {} }).duration).toBe(0);
    expect(summarizeProbe(null).hasAudio).toBe(false);
  });

  test('a missing ffprobe is reported as FFMPEG_MISSING', async () => {
    const enoent = new TranscriptionError('BACKEND_FAILED', 'Command not found', {
      code: 'ENOENT'
    });
    const probe = new AudioProbe({ logger: silentLogger, processRunner: makeRunner([enoent]) });
    await expect(probe.probe('/tmp/x.wav')).rejects.toMatchObject({ reason: 'FFMPEG_MISSING' });
  });

  test('unparseable ffprobe output is an unsupported format, not a crash', async () => {
    const probe = new AudioProbe({
      logger: silentLogger,
      processRunner: makeRunner([{ code: 0, stdout: 'not json' }])
    });
    await expect(probe.probe('/tmp/x.wav')).rejects.toMatchObject({
      reason: 'UNSUPPORTED_FORMAT'
    });
  });

  test('reports tooling availability without throwing, and caches it', async () => {
    const runner = makeRunner([
      { code: 0, stdout: 'ffmpeg version 6.1.1 Copyright' },
      { code: 0, stdout: 'ffprobe version 6.1.1 Copyright' }
    ]);
    const probe = new AudioProbe({ logger: silentLogger, processRunner: runner });
    const first = await probe.checkTooling();
    expect(first).toMatchObject({ available: true });
    expect(first.ffmpeg.version).toBe('6.1.1');

    await probe.checkTooling();
    expect(runner.calls).toHaveLength(2);
  });

  test('a missing binary makes tooling unavailable with a hint', async () => {
    const enoent = new TranscriptionError('BACKEND_FAILED', 'nope', { code: 'ENOENT' });
    const probe = new AudioProbe({
      logger: silentLogger,
      processRunner: makeRunner([enoent, enoent])
    });
    const tooling = await probe.checkTooling();
    expect(tooling.available).toBe(false);
    expect(tooling.detail).toMatch(/FFmpeg tooling not found/);
  });

  test('parses a version string, or reports none', () => {
    expect(parseVersion('ffmpeg version n6.0 Copyright')).toBe('n6.0');
    expect(parseVersion('garbage')).toBeNull();
  });
});
