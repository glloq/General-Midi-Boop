// tests/schema-file-write.test.js
// Validation for the `file_write` WS command. The body is serialised straight
// to bytes and stored, so a malformed or oversized payload must be rejected at
// the edge rather than reaching writeMidi/BlobStore unchecked (audit P2).

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const ok = (result) => expect(result).toEqual({ valid: true, errors: [] });
const errs = (result, expected) => {
  expect(result.valid).toBe(false);
  for (const fragment of expected) {
    expect(result.errors.join(' | ')).toContain(fragment);
  }
};

describe('file_write', () => {
  test('valid minimal payload', () => {
    ok(JsonValidator.validateByCommand('file_write', {
      fileId: 3,
      midiData: { header: { format: 1, ticksPerBeat: 480 }, tracks: [[]] }
    }));
  });

  test('missing fileId rejected', () => {
    errs(JsonValidator.validateByCommand('file_write', {
      midiData: { header: {}, tracks: [[]] }
    }), ['fileId is required']);
  });

  test('non-positive fileId rejected', () => {
    errs(JsonValidator.validateByCommand('file_write', {
      fileId: -2, midiData: { header: {}, tracks: [[]] }
    }), ['fileId must be a positive number']);
  });

  test('non-object midiData rejected', () => {
    errs(JsonValidator.validateByCommand('file_write', {
      fileId: 1, midiData: 'nope'
    }), ['midiData must be an object']);
  });

  test('missing header / non-array tracks rejected', () => {
    errs(JsonValidator.validateByCommand('file_write', {
      fileId: 1, midiData: { tracks: 'x' }
    }), ['midiData.header must be an object', 'midiData.tracks must be an array']);
  });

  test('too many tracks rejected', () => {
    const tracks = Array.from({ length: 257 }, () => []);
    errs(JsonValidator.validateByCommand('file_write', {
      fileId: 1, midiData: { header: {}, tracks }
    }), ['exceeds 256 tracks']);
  });
});
