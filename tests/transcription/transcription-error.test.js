/**
 * @file tests/transcription/transcription-error.test.js
 * @description Contract of the transcription error taxonomy (PR 1, §39):
 * every user-facing failure has a typed reason, an `ERR_*` code and an HTTP
 * status, and nothing leaks the underlying cause to the client.
 */
import { describe, test, expect } from '@jest/globals';
import {
  TranscriptionError,
  TRANSCRIPTION_REASONS,
  isCancellation
} from '../../src/transcription/TranscriptionError.js';
import { ApplicationError } from '../../src/core/errors/index.js';

describe('TranscriptionError', () => {
  test('extends ApplicationError so the API layer forwards it verbatim', () => {
    const err = new TranscriptionError(TRANSCRIPTION_REASONS.BACKEND_FAILED, 'boom');
    expect(err).toBeInstanceOf(ApplicationError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TranscriptionError');
  });

  test('every documented reason maps to a distinct ERR_ code and a status', () => {
    const codes = new Set();
    for (const reason of Object.values(TRANSCRIPTION_REASONS)) {
      const err = new TranscriptionError(reason, 'x');
      expect(err.reason).toBe(reason);
      expect(err.code).toMatch(/^ERR_TRANSCRIPTION/);
      expect(err.statusCode).toBeGreaterThanOrEqual(400);
      expect(codes.has(err.code)).toBe(false);
      codes.add(err.code);
    }
    expect(codes.size).toBe(Object.keys(TRANSCRIPTION_REASONS).length);
  });

  test('maps client-actionable reasons to the right status', () => {
    expect(new TranscriptionError(TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT, 'x').statusCode).toBe(
      415
    );
    expect(new TranscriptionError(TRANSCRIPTION_REASONS.FILE_TOO_LARGE, 'x').statusCode).toBe(413);
    expect(new TranscriptionError(TRANSCRIPTION_REASONS.BACKEND_TIMEOUT, 'x').statusCode).toBe(504);
    expect(new TranscriptionError(TRANSCRIPTION_REASONS.DISK_FULL, 'x').statusCode).toBe(507);
  });

  test('an unknown reason degrades to a generic 500 instead of throwing', () => {
    const err = new TranscriptionError('WAT', 'x');
    expect(err.code).toBe('ERR_TRANSCRIPTION');
    expect(err.statusCode).toBe(500);
    expect(err.reason).toBe('WAT');
  });

  test('toJSON exposes reason/details but never the cause', () => {
    const cause = new Error('/home/pi/secret/path exploded');
    const err = new TranscriptionError(
      TRANSCRIPTION_REASONS.AUDIO_TOO_LONG,
      'Audio is too long',
      { duration: 1100, limit: 600 },
      { cause, backendId: 'basic-pitch' }
    );
    const json = err.toJSON();
    expect(json).toEqual({
      error: 'TranscriptionError',
      code: 'ERR_TRANSCRIPTION_AUDIO_TOO_LONG',
      message: 'Audio is too long',
      reason: 'AUDIO_TOO_LONG',
      retryable: false,
      backendId: 'basic-pitch',
      details: { duration: 1100, limit: 600 }
    });
    expect(JSON.stringify(json)).not.toContain('secret');
    // The cause is still attached for the logs.
    expect(err.cause).toBe(cause);
  });

  test('from() preserves an already-typed error and wraps anything else', () => {
    const typed = new TranscriptionError(TRANSCRIPTION_REASONS.BACKEND_TIMEOUT, 'timed out');
    expect(TranscriptionError.from(typed)).toBe(typed);

    const wrapped = TranscriptionError.from(
      new Error('python died'),
      undefined,
      {},
      {
        backendId: 'x'
      }
    );
    expect(wrapped.reason).toBe(TRANSCRIPTION_REASONS.BACKEND_FAILED);
    expect(wrapped.message).toBe('python died');
    expect(wrapped.backendId).toBe('x');
    expect(wrapped.cause).toBeInstanceOf(Error);

    const fromString = TranscriptionError.from('nope');
    expect(fromString.message).toBe('nope');
    expect(fromString.cause).toBeUndefined();
  });

  test('cancellation is recognised from both the typed error and AbortError', () => {
    const cancelled = TranscriptionError.cancelled('job-1');
    expect(cancelled.isCancellation).toBe(true);
    expect(cancelled.details).toEqual({ jobId: 'job-1' });
    expect(isCancellation(cancelled)).toBe(true);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isCancellation(abort)).toBe(true);

    expect(isCancellation(new Error('other'))).toBe(false);
    expect(isCancellation(null)).toBe(false);
  });

  test('retryable distinguishes "try again" from "change something"', () => {
    expect(new TranscriptionError(TRANSCRIPTION_REASONS.BACKEND_TIMEOUT, 'x').retryable).toBe(true);
    expect(new TranscriptionError(TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT, 'x').retryable).toBe(
      false
    );
  });
});
