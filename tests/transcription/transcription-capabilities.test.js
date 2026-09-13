/**
 * @file tests/transcription/transcription-capabilities.test.js
 * @description Backend descriptors are what the Settings UI shows a user
 * before they install a model, so the safe defaults of §6/§9 are pinned
 * here: nothing is capable unless claimed, nothing is permissive unless
 * verified, and a missing engine never reports as a health failure (§23).
 */
import { describe, test, expect } from '@jest/globals';
import {
  BACKEND_STATUS,
  DEFAULT_AUDIO_FORMAT,
  QUALITY_PROFILE,
  normalizeCapabilities,
  normalizeRuntime,
  normalizeAudioFormat,
  normalizeLicensing,
  normalizeBackendMetadata,
  isBackendUsable,
  backendStatusToHealth
} from '../../src/transcription/TranscriptionCapabilities.js';

describe('capability normalisation', () => {
  test('every capability defaults to false — nothing is inherited', () => {
    expect(normalizeCapabilities(undefined)).toEqual({
      polyphonic: false,
      multiInstrument: false,
      drums: false,
      pitchBend: false,
      dynamics: false,
      instrumentRecognition: false,
      tempoDetection: false,
      progress: false
    });
  });

  test('only literal true counts as a claimed capability', () => {
    const caps = normalizeCapabilities({ polyphonic: true, drums: 'yes', pitchBend: 1 });
    expect(caps.polyphonic).toBe(true);
    expect(caps.drums).toBe(false);
    expect(caps.pitchBend).toBe(false);
  });

  test('unknown keys are dropped so a typo never becomes a capability', () => {
    const caps = normalizeCapabilities({ polyphonics: true });
    expect(caps).not.toHaveProperty('polyphonics');
    expect(caps.polyphonic).toBe(false);
  });

  test('runtime requirements default to the conservative answer', () => {
    expect(normalizeRuntime(null)).toEqual({
      python: false,
      gpu: false,
      raspberryPiSuitable: false,
      minimumRamMb: null
    });
    expect(normalizeRuntime({ minimumRamMb: 2048 }).minimumRamMb).toBe(2048);
  });
});

describe('audio format', () => {
  test('defaults to the canonical mono PCM WAV the preprocessor produces', () => {
    expect(normalizeAudioFormat(undefined)).toEqual(DEFAULT_AUDIO_FORMAT);
  });

  test('accepts a backend-declared rate and clamps the channel count', () => {
    expect(normalizeAudioFormat({ sampleRate: 44100, channels: 2 })).toMatchObject({
      sampleRate: 44100,
      channels: 2
    });
    expect(normalizeAudioFormat({ channels: 7 }).channels).toBe(1);
    expect(normalizeAudioFormat({ sampleRate: -1 }).sampleRate).toBe(
      DEFAULT_AUDIO_FORMAT.sampleRate
    );
  });
});

describe('licensing', () => {
  test('an undeclared licence is restrictive, never permissive', () => {
    const licence = normalizeLicensing(undefined);
    expect(licence.commercialUse).toBe(false);
    expect(licence.redistribution).toBe(false);
    expect(licence.bundled).toBe(false);
    expect(licence.modelLicense).toBeNull();
    expect(licence.requiresConsent).toBe(true);
  });

  test('weights that may not be redistributed can never be marked as bundled', () => {
    const licence = normalizeLicensing({
      codeLicense: 'Apache-2.0',
      modelLicense: 'CC-BY-NC-4.0',
      commercialUse: false,
      redistribution: false,
      bundled: true
    });
    expect(licence.bundled).toBe(false);
    expect(licence.requiresConsent).toBe(true);
  });

  test('a fully permissive backend may opt out of the consent prompt', () => {
    const licence = normalizeLicensing({
      codeLicense: 'Apache-2.0',
      modelLicense: 'Apache-2.0',
      commercialUse: true,
      redistribution: true,
      requiresConsent: false
    });
    expect(licence.requiresConsent).toBe(false);
    expect(licence.bundled).toBe(false);
  });

  test('consent stays mandatory when commercial use is not granted', () => {
    const licence = normalizeLicensing({ commercialUse: false, requiresConsent: false });
    expect(licence.requiresConsent).toBe(true);
  });
});

describe('backend metadata', () => {
  const valid = { id: 'basic-pitch', name: 'Basic Pitch' };

  test('fills every section and keeps the declared id/name', () => {
    const meta = normalizeBackendMetadata(valid);
    expect(meta.id).toBe('basic-pitch');
    expect(meta.name).toBe('Basic Pitch');
    expect(meta.capabilities.polyphonic).toBe(false);
    expect(meta.licensing.commercialUse).toBe(false);
    expect(meta.audioFormat).toEqual(DEFAULT_AUDIO_FORMAT);
    expect(meta.qualityProfiles).toEqual([QUALITY_PROFILE.BALANCED]);
    expect(meta.priority).toBe(0);
    expect(Object.isFrozen(meta)).toBe(true);
  });

  test('rejects an id that cannot be used in a path or a URL', () => {
    for (const id of ['', 'Basic Pitch', '../etc', 'a', 'UPPER', 'x'.repeat(65), 42, null]) {
      expect(() => normalizeBackendMetadata({ ...valid, id })).toThrow(/Backend id/);
    }
  });

  test('rejects a missing name and a non-object descriptor', () => {
    expect(() => normalizeBackendMetadata({ id: 'ok-id' })).toThrow(/non-empty name/);
    expect(() => normalizeBackendMetadata({ id: 'ok-id', name: '   ' })).toThrow(/non-empty name/);
    expect(() => normalizeBackendMetadata(null)).toThrow(/must be an object/);
  });

  test('keeps only known quality profiles', () => {
    const meta = normalizeBackendMetadata({
      ...valid,
      qualityProfiles: ['fast', 'ludicrous', 'maximum']
    });
    expect(meta.qualityProfiles).toEqual(['fast', 'maximum']);
  });
});

describe('status vocabulary', () => {
  test('only "available" means the engine can run now', () => {
    expect(isBackendUsable(BACKEND_STATUS.AVAILABLE)).toBe(true);
    for (const status of Object.values(BACKEND_STATUS)) {
      if (status !== BACKEND_STATUS.AVAILABLE) expect(isBackendUsable(status)).toBe(false);
    }
  });

  test('a missing engine is "disabled", not a health failure', () => {
    expect(backendStatusToHealth(BACKEND_STATUS.AVAILABLE)).toBe('ready');
    expect(backendStatusToHealth(BACKEND_STATUS.NOT_INSTALLED)).toBe('disabled');
    expect(backendStatusToHealth(BACKEND_STATUS.INSTALLABLE)).toBe('disabled');
    expect(backendStatusToHealth(BACKEND_STATUS.LICENSE_RESTRICTED)).toBe('disabled');
    expect(backendStatusToHealth(BACKEND_STATUS.UNSUPPORTED_PLATFORM)).toBe('disabled');
    // Installed but unusable IS a failure: the user was told it would work.
    expect(backendStatusToHealth(BACKEND_STATUS.BROKEN)).toBe('failed');
  });
});
