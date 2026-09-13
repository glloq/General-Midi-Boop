/**
 * @file tests/transcription/transcription-config.test.js
 * @description Resource guards (§22) only protect a Raspberry Pi if a bad
 * value degrades to the default instead of disabling the limit, and if the
 * derived paths are absolute (the traversal checks in PR 2 depend on it).
 */
import { describe, test, expect } from '@jest/globals';
import path from 'path';
import Config from '../../src/core/Config.js';
import {
  TRANSCRIPTION_DEFAULTS,
  POST_PROCESSING_PRESETS,
  resolveTranscriptionConfig,
  transcriptionPaths
} from '../../src/transcription/TranscriptionConfig.js';

describe('resolveTranscriptionConfig', () => {
  test('returns the documented defaults for an absent section', () => {
    expect(resolveTranscriptionConfig(undefined)).toEqual(TRANSCRIPTION_DEFAULTS);
    expect(resolveTranscriptionConfig({})).toEqual(TRANSCRIPTION_DEFAULTS);
    expect(Object.isFrozen(resolveTranscriptionConfig({}))).toBe(true);
  });

  test('the shipped defaults are the Pi-safe ones', () => {
    expect(TRANSCRIPTION_DEFAULTS.maxParallelJobs).toBe(1);
    expect(TRANSCRIPTION_DEFAULTS.keepOriginalAudio).toBe(false);
    expect(TRANSCRIPTION_DEFAULTS.keepTempFiles).toBe(false);
    expect(TRANSCRIPTION_DEFAULTS.postProcessingPreset).toBe('balanced');
  });

  test('reads a plain object, a nested section, and a Config instance alike', () => {
    expect(resolveTranscriptionConfig({ maxParallelJobs: 3 }).maxParallelJobs).toBe(3);
    expect(
      resolveTranscriptionConfig({ transcription: { maxParallelJobs: 3 } }).maxParallelJobs
    ).toBe(3);

    const config = new Config('/nonexistent/path.json');
    config.set('transcription.maxParallelJobs', 2);
    expect(resolveTranscriptionConfig(config).maxParallelJobs).toBe(2);
  });

  test('the real config.json seeds a usable, in-range configuration', () => {
    const settings = resolveTranscriptionConfig(new Config());
    expect(settings.enabled).toBe(true);
    expect(settings.maxParallelJobs).toBe(1);
    expect(POST_PROCESSING_PRESETS).toContain(settings.postProcessingPreset);
  });

  test('clamps out-of-range numbers to survivable bounds', () => {
    const tooBig = resolveTranscriptionConfig({
      maxParallelJobs: 999,
      maxAudioDurationSeconds: 10 ** 9,
      jobTimeoutMs: Number.MAX_SAFE_INTEGER
    });
    expect(tooBig.maxParallelJobs).toBe(8);
    expect(tooBig.maxAudioDurationSeconds).toBe(4 * 60 * 60);
    expect(tooBig.jobTimeoutMs).toBe(6 * 60 * 60 * 1000);

    const tooSmall = resolveTranscriptionConfig({
      maxParallelJobs: 0,
      maxAudioFileBytes: 1,
      jobTimeoutMs: -5
    });
    expect(tooSmall.maxParallelJobs).toBe(1);
    expect(tooSmall.maxAudioFileBytes).toBe(1024 * 1024);
    expect(tooSmall.jobTimeoutMs).toBe(10 * 1000);
  });

  test('an unparseable limit falls back to the default — never to "no limit"', () => {
    const settings = resolveTranscriptionConfig({
      maxAudioFileBytes: 'unlimited',
      maxAudioDurationSeconds: null,
      maxTempDiskBytes: {}
    });
    expect(settings.maxAudioFileBytes).toBe(TRANSCRIPTION_DEFAULTS.maxAudioFileBytes);
    expect(settings.maxAudioDurationSeconds).toBe(TRANSCRIPTION_DEFAULTS.maxAudioDurationSeconds);
    expect(settings.maxTempDiskBytes).toBe(TRANSCRIPTION_DEFAULTS.maxTempDiskBytes);
  });

  test('accepts the boolean spellings the SPA and .env produce', () => {
    expect(resolveTranscriptionConfig({ enabled: 'false' }).enabled).toBe(false);
    expect(resolveTranscriptionConfig({ enabled: 0 }).enabled).toBe(false);
    expect(resolveTranscriptionConfig({ keepOriginalAudio: 'true' }).keepOriginalAudio).toBe(true);
    expect(resolveTranscriptionConfig({ keepTempFiles: 1 }).keepTempFiles).toBe(true);
    expect(resolveTranscriptionConfig({ enabled: 'maybe' }).enabled).toBe(true);
  });

  test('an unknown post-processing preset falls back to balanced', () => {
    expect(resolveTranscriptionConfig({ postProcessingPreset: 'clean' }).postProcessingPreset).toBe(
      'clean'
    );
    expect(
      resolveTranscriptionConfig({ postProcessingPreset: 'destructive' }).postProcessingPreset
    ).toBe('balanced');
  });

  test('a blank data directory falls back to the default', () => {
    expect(resolveTranscriptionConfig({ dataDir: '   ' }).dataDir).toBe(
      TRANSCRIPTION_DEFAULTS.dataDir
    );
    expect(resolveTranscriptionConfig({ dataDir: './custom/dir' }).dataDir).toBe('./custom/dir');
  });
});

describe('transcriptionPaths', () => {
  test('derives the documented layout under one root', () => {
    const paths = transcriptionPaths({ dataDir: './data/transcription' });
    expect(paths.root).toBe(path.resolve('./data/transcription'));
    expect(paths.tmpDir).toBe(path.join(paths.root, 'tmp'));
    expect(paths.venvsDir).toBe(path.join(paths.root, 'venvs'));
    expect(paths.modelsDir).toBe(path.join(paths.root, 'models'));
    expect(paths.cacheDir).toBe(path.join(paths.root, 'cache'));
    expect(paths.audioDir).toBe(path.join(paths.root, 'audio'));
  });

  test('every path is absolute so prefix containment checks are meaningful', () => {
    const paths = transcriptionPaths({ dataDir: 'relative/dir' });
    for (const value of Object.values(paths)) {
      expect(path.isAbsolute(value)).toBe(true);
    }
    expect(Object.isFrozen(paths)).toBe(true);
  });

  test('falls back to the default root when given nothing', () => {
    expect(transcriptionPaths(undefined).root).toBe(path.resolve(TRANSCRIPTION_DEFAULTS.dataDir));
  });
});

describe('Config integration', () => {
  test('exposes a transcription section getter', () => {
    const config = new Config('/nonexistent/path.json');
    expect(config.transcription.enabled).toBe(true);
    expect(config.get('transcription.maxParallelJobs')).toBe(1);
  });

  test('rejects operator values that make no sense at all', () => {
    const config = new Config('/nonexistent/path.json');
    expect(() => config.set('transcription.maxParallelJobs', 0)).toThrow();
    expect(() => config.set('transcription.maxAudioFileBytes', -1)).toThrow();
    expect(() => config.set('transcription.postProcessingPreset', 'nope')).toThrow();
    expect(() => config.set('transcription.dataDir', '../../etc')).toThrow();
    expect(() => config.set('transcription.enabled', 'yes')).toThrow();
  });
});
