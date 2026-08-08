// tests/midi-file-validator-verdict.test.js
//
// Audit B2/B3: handleUpload now ENFORCES the validator's blocking verdict
// (rejects when valid=false). That is only safe because validate() marks
// valid=false ONLY for a structurally-unusable file (missing header / zero
// tracks) and treats everything else (orphan notes, out-of-range values, odd
// tempo) as a NON-blocking warning. These tests pin that contract so a future
// change can't turn a messy-but-usable upload into a hard rejection.

import { describe, test, expect } from '@jest/globals';
import MidiFileValidator from '../src/files/MidiFileValidator.js';

const noopLogger = { error() {}, info() {}, debug() {}, warn() {} };
const v = new MidiFileValidator(noopLogger);
const header = { format: 1, ticksPerBeat: 480 };

describe('MidiFileValidator blocking verdict (upload enforcement contract)', () => {
  test('valid=false when the header is missing (blocking)', () => {
    const r = v.validate({ tracks: [[]] });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('valid=false when there are zero tracks (blocking)', () => {
    const r = v.validate({ header, tracks: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/tracks/i);
  });

  test('valid=true for a normal file with notes', () => {
    const midi = {
      header,
      tracks: [
        [
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 0, type: 'endOfTrack' }
        ]
      ]
    };
    expect(v.validate(midi).valid).toBe(true);
  });

  test('valid=true (warnings only) for a messy-but-parseable file — NOT blocked', () => {
    const midi = {
      header,
      tracks: [
        [
          // out-of-range note (warning) + a noteOn never closed (orphan warning)
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 200, velocity: 100 },
          { deltaTime: 0, type: 'endOfTrack' }
        ]
      ]
    };
    const r = v.validate(midi);
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('valid=true for a file with a single empty track (warning, not blocking)', () => {
    const r = v.validate({ header, tracks: [[]] });
    expect(r.valid).toBe(true);
    expect(r.stats.emptyTracks).toBe(1);
  });
});
