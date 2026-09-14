#!/usr/bin/env node
/**
 * @file scripts/transcription-benchmark.mjs
 * @description Measures the audio → MIDI pipeline on the machine it runs on
 * (§14 / §22) — written to be run ON a Raspberry Pi, where the numbers that
 * matter are not the ones a laptop produces.
 *
 * It reports each stage separately, because they fail for different reasons:
 * FFmpeg is I/O-bound and predictable, the engine is CPU- and RAM-bound and
 * is what actually decides whether a Pi is usable, and encoding is noise.
 *
 * Usage:
 *
 *   node scripts/transcription-benchmark.mjs [audio-file] [--quality=balanced]
 *
 * With no file it synthesises a 30-second tone, so the script is runnable on
 * a fresh install with nothing to hand. Requires FFmpeg, and an installed
 * engine for the transcription stage — without one it measures what it can
 * and says what it skipped.
 *
 * Nothing here is part of the server: it imports the same modules the server
 * does and runs them once.
 */
/* eslint-disable no-console -- a CLI report IS this file's output; the
   server-side logging rule does not apply to an operator-run script. */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from 'process';
import Config from '../src/core/Config.js';
import { AudioPreprocessor } from '../src/transcription/AudioPreprocessor.js';
import { AudioProbe } from '../src/transcription/utils/AudioProbe.js';
import { ProcessRunner } from '../src/transcription/utils/ProcessRunner.js';
import { MidiPostProcessor } from '../src/transcription/MidiPostProcessor.js';
import { MidiEncoder } from '../src/transcription/MidiEncoder.js';
import { TranscriptionBackendRegistry } from '../src/transcription/TranscriptionBackendRegistry.js';
import { createTranscriptionResult } from '../src/transcription/TranscriptionResult.js';
import { resolveTranscriptionConfig } from '../src/transcription/TranscriptionConfig.js';
import { wrapWav } from '../tests/helpers/audioFixtures.js';

const logger = {
  debug() {},
  info: (message) => console.log(`  ${message}`),
  warn: (message) => console.warn(`  ! ${message}`),
  error: (message) => console.error(`  ✗ ${message}`)
};

/** @returns {{rssMb: number, heapMb: number}} */
function memory() {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapMb: Math.round(usage.heapUsed / 1024 / 1024)
  };
}

/**
 * Run `fn`, timing it and reporting peak RSS around it.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<{label: string, ms: number, rssMb: number, value: T}>}
 */
async function stage(label, fn) {
  const before = Date.now();
  const value = await fn();
  const ms = Date.now() - before;
  const { rssMb } = memory();
  console.log(`  ${label.padEnd(22)} ${String(ms).padStart(7)} ms   RSS ${rssMb} MB`);
  return { label, ms, rssMb, value };
}

/** A 30-second sine, so the script works with no audio to hand. */
async function synthesiseFixture(target) {
  const sampleRate = 44100;
  const seconds = 30;
  const pcm = Buffer.alloc(sampleRate * seconds * 2);
  for (let i = 0; i < sampleRate * seconds; i++) {
    // A slow arpeggio, so the engine has something real to find.
    const step = Math.floor(i / (sampleRate / 2)) % 4;
    const frequency = [261.63, 329.63, 392.0, 523.25][step];
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.4;
    pcm.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  await fs.writeFile(target, wrapWav(pcm, sampleRate, 1));
  return target;
}

async function main() {
  const args = process.argv.slice(2);
  const quality = (args.find((a) => a.startsWith('--quality=')) || '--quality=balanced').split(
    '='
  )[1];
  const inputArg = args.find((a) => !a.startsWith('--'));

  console.log('Audio → MIDI benchmark');
  console.log('======================');
  console.log(`  host      ${os.type()} ${os.release()} ${os.arch()}`);
  console.log(`  cpus      ${os.cpus().length} × ${os.cpus()[0]?.model?.trim() ?? 'unknown'}`);
  console.log(`  memory    ${Math.round(os.totalmem() / 1024 / 1024)} MB total`);
  console.log(`  node      ${process.version}`);
  console.log(`  quality   ${quality}`);
  console.log('');

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-bench-'));
  try {
    const config = new Config();
    const settings = resolveTranscriptionConfig(config);
    const processRunner = new ProcessRunner({ logger });
    const audioProbe = new AudioProbe({ logger, processRunner });

    const tooling = await audioProbe.checkTooling({ force: true });
    if (!tooling.available) {
      console.error('FFmpeg is required for this benchmark. Install it and try again.');
      process.exitCode = 1;
      return;
    }
    console.log(`  ffmpeg    ${tooling.ffmpeg.version ?? 'present'}`);

    const input = inputArg
      ? path.resolve(inputArg)
      : await synthesiseFixture(path.join(workDir, 'fixture.wav'));
    console.log(`  input     ${input}`);
    console.log('');

    const registry = new TranscriptionBackendRegistry({ logger, config });
    await registry.loadBuiltinBackends();
    const available = await registry.detectAvailable({ force: true });

    console.log('Stages');
    console.log('------');

    const preprocessor = new AudioPreprocessor({
      logger,
      processRunner,
      audioProbe,
      settings
    });
    const target = available[0]?.audioFormat ?? undefined;
    const prepared = await stage('preprocess (ffmpeg)', () =>
      preprocessor.prepare({
        inputPath: input,
        outputPath: path.join(workDir, 'audio.wav'),
        targetFormat: target
      })
    );

    if (available.length === 0) {
      console.log('');
      console.log('No engine is installed — the transcription stage was skipped.');
      console.log('See docs/AUDIO_TRANSCRIPTION.md to install one.');
      return;
    }

    const backend = registry.get(available[0].id);
    console.log(`  engine    ${available[0].name} (${available[0].id})`);

    const raw = await stage('transcribe (engine)', () =>
      backend.transcribe(
        prepared.value.path,
        { quality, duration: prepared.value.duration },
        { workDir, logger }
      )
    );

    const result = createTranscriptionResult({
      ...raw.value,
      source: { filename: path.basename(input), duration: prepared.value.duration }
    });
    const processed = await stage('post-process', async () =>
      new MidiPostProcessor({ logger }).process(result, { preset: settings.postProcessingPreset })
    );
    const encoded = await stage('encode (SMF)', async () =>
      new MidiEncoder({ logger }).encode(processed.value.result)
    );

    const totalMs = prepared.ms + raw.ms + processed.ms + encoded.ms;
    const realtime = prepared.value.duration > 0 ? totalMs / 1000 / prepared.value.duration : 0;

    console.log('');
    console.log('Result');
    console.log('------');
    console.log(`  audio         ${prepared.value.duration.toFixed(1)} s`);
    console.log(`  total         ${(totalMs / 1000).toFixed(1)} s`);
    console.log(`  ratio         ${realtime.toFixed(2)}× real time`);
    console.log(`  notes         ${processed.value.stats.notesOut}`);
    console.log(`  midi          ${encoded.value.buffer.length} bytes`);
    console.log(`  peak RSS      ${memory().rssMb} MB`);
    console.log('');
    console.log(
      `  A ratio above 1.0 means a ${Math.ceil(realtime)}-minute wait per minute of audio;`
    );
    console.log('  tune transcription.maxAudioDurationSeconds accordingly.');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
