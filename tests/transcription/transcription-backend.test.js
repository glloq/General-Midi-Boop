/**
 * @file tests/transcription/transcription-backend.test.js
 * @description The abstract backend contract (§6): what a subclass must
 * implement, what it gets for free, and that the optional installation hooks
 * fail as typed errors rather than as `undefined is not a function`.
 */
import { describe, test, expect } from '@jest/globals';
import TranscriptionBackend from '../../src/transcription/TranscriptionBackend.js';
import { BACKEND_STATUS } from '../../src/transcription/TranscriptionCapabilities.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

class MinimalBackend extends TranscriptionBackend {
  getMetadata() {
    return {
      id: 'minimal',
      name: 'Minimal',
      version: '0.1.0',
      capabilities: { polyphonic: true, progress: true },
      runtime: { python: true, raspberryPiSuitable: true },
      licensing: { codeLicense: 'MIT', modelLicense: 'MIT', commercialUse: true }
    };
  }

  async checkAvailability() {
    return { status: BACKEND_STATUS.AVAILABLE, version: '0.1.0' };
  }

  async transcribe() {
    return { tracks: [] };
  }
}

describe('TranscriptionBackend (abstract)', () => {
  test('the three mandatory methods throw until implemented', async () => {
    const bare = new TranscriptionBackend();
    expect(() => bare.getMetadata()).toThrow(/must implement getMetadata/);
    await expect(bare.checkAvailability()).rejects.toThrow(/must implement checkAvailability/);
    await expect(bare.transcribe('/tmp/a.wav', {}, {})).rejects.toThrow(
      /must implement transcribe/
    );
  });

  test('names the concrete subclass in the "not implemented" message', () => {
    class HalfBackend extends TranscriptionBackend {}
    expect(() => new HalfBackend().getMetadata()).toThrow(/HalfBackend must implement/);
  });

  test('exposes the metadata id and works without an injected logger', () => {
    const backend = new MinimalBackend();
    expect(backend.id).toBe('minimal');
    expect(() => backend.logger.info('no-op')).not.toThrow();
  });

  test('keeps deps for late resolution instead of capturing services eagerly', () => {
    const deps = { logger: { info() {} } };
    const backend = new MinimalBackend(deps);
    expect(backend._deps).toBe(deps);
    // A service registered after construction is still reachable.
    deps.transcriptionJobManager = { id: 'later' };
    expect(backend._deps.transcriptionJobManager.id).toBe('later');
  });

  test('installation is opt-out by default and refuses with a typed error', async () => {
    const backend = new MinimalBackend();
    expect(backend.supportsInstall()).toBe(false);
    await expect(backend.install()).rejects.toBeInstanceOf(TranscriptionError);
    await expect(backend.install()).rejects.toMatchObject({
      reason: 'BACKEND_NOT_INSTALLED',
      backendId: 'minimal'
    });
    await expect(backend.uninstall()).rejects.toBeInstanceOf(TranscriptionError);
  });

  test('describe() merges normalised metadata with a probe report', () => {
    const backend = new MinimalBackend();
    const described = backend.describe({
      status: BACKEND_STATUS.AVAILABLE,
      version: '0.1.0',
      modelVersion: 'weights-3',
      detail: null,
      checkedAt: 1234
    });
    expect(described).toMatchObject({
      id: 'minimal',
      name: 'Minimal',
      status: BACKEND_STATUS.AVAILABLE,
      available: true,
      installed: true,
      installedVersion: '0.1.0',
      modelVersion: 'weights-3',
      checkedAt: 1234
    });
    expect(described.capabilities.polyphonic).toBe(true);
    expect(described.capabilities.drums).toBe(false);
  });

  test('describe() without a probe reports not_installed, never available', () => {
    const described = new MinimalBackend().describe();
    expect(described.status).toBe(BACKEND_STATUS.NOT_INSTALLED);
    expect(described.available).toBe(false);
    expect(described.installed).toBe(false);
    expect(described.checkedAt).toBeNull();
  });

  test('a broken engine counts as installed — it is on disk, it just fails', () => {
    const described = new MinimalBackend().describe({
      status: BACKEND_STATUS.BROKEN,
      detail: 'venv missing'
    });
    expect(described.installed).toBe(true);
    expect(described.available).toBe(false);
    expect(described.detail).toBe('venv missing');
  });

  test('destroy() is a no-op on the base class', () => {
    expect(() => new MinimalBackend().destroy()).not.toThrow();
  });
});
