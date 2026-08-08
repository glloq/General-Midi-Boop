// tests/schema-file-save-as.test.js
// Audit A2 M1: `file_save_as` shipped with NO schema, so it reached
// FileManager.saveFileAs — which serialises `midiData` via `writeMidi` BEFORE
// any size check — completely unvalidated (DoS), and persisted `newFilename`
// without the sanitizer `file_rename` uses. This mirrors the `file_write` caps
// plus the filename check.

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const ok = (result) => expect(result).toEqual({ valid: true, errors: [] });
const errs = (result, expected) => {
  expect(result.valid).toBe(false);
  for (const fragment of expected) {
    expect(result.errors.join(' | ')).toContain(fragment);
  }
};

const validMidi = { header: { format: 1, ticksPerBeat: 480 }, tracks: [[]] };

describe('file_save_as schema (audit A2 M1)', () => {
  test('the command now HAS a schema (not the permissive default)', () => {
    // A bad payload must be rejected — proving a schema is actually registered.
    const r = JsonValidator.validateByCommand('file_save_as', {});
    expect(r.valid).toBe(false);
  });

  test('valid payload passes', () => {
    ok(
      JsonValidator.validateByCommand('file_save_as', {
        fileId: 3,
        newFilename: 'my song.mid',
        midiData: validMidi
      })
    );
  });

  test('missing / bad fileId rejected', () => {
    errs(
      JsonValidator.validateByCommand('file_save_as', {
        newFilename: 'x.mid',
        midiData: validMidi
      }),
      ['fileId is required']
    );
    errs(
      JsonValidator.validateByCommand('file_save_as', {
        fileId: -2,
        newFilename: 'x.mid',
        midiData: validMidi
      }),
      ['fileId must be a positive number']
    );
  });

  test('filename with a path separator or traversal is rejected', () => {
    errs(
      JsonValidator.validateByCommand('file_save_as', {
        fileId: 1,
        newFilename: '../../etc/passwd',
        midiData: validMidi
      }),
      ['must not contain path separators']
    );
    errs(
      JsonValidator.validateByCommand('file_save_as', {
        fileId: 1,
        newFilename: 'a/b.mid',
        midiData: validMidi
      }),
      ['must not contain path separators']
    );
  });

  test('missing filename rejected', () => {
    errs(JsonValidator.validateByCommand('file_save_as', { fileId: 1, midiData: validMidi }), [
      'newFilename is required'
    ]);
  });

  test('oversized midiData is rejected before it reaches writeMidi (DoS cap)', () => {
    // Use well-formed events so the COUNT cap is what trips (audit D added
    // per-event validation that would otherwise reject a malformed placeholder
    // event first).
    const tracks = [
      Array.from({ length: 500001 }, () => ({
        deltaTime: 0,
        type: 'noteOn',
        channel: 0,
        noteNumber: 60,
        velocity: 1
      }))
    ];
    errs(
      JsonValidator.validateByCommand('file_save_as', {
        fileId: 1,
        newFilename: 'x.mid',
        midiData: { header: {}, tracks }
      }),
      ['exceeds 500000 events']
    );
  });

  test('non-object midiData rejected', () => {
    errs(
      JsonValidator.validateByCommand('file_save_as', {
        fileId: 1,
        newFilename: 'x.mid',
        midiData: 'nope'
      }),
      ['midiData must be an object']
    );
  });
});
