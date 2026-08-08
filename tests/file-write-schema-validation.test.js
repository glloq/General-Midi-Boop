// tests/file-write-schema-validation.test.js
//
// Audit D — the editor SAVE path (file_write / file_save_as) serialises a
// client-supplied `midiData` straight through the midi-file writer and stores
// the bytes. HTTP/WS auth is waived for LAN clients, so the payload is
// untrusted. These schema validators are the untrusted boundary; they must
// reject the DoS and corruption vectors BEFORE the handler runs:
//   CRITICAL-1  deltaTime ≥ 2³¹ → writeVarInt spins forever (OOM the Pi)
//   CRITICAL-2  a flood of text/sysEx metas → O(n²) writeBytes stall
//   MEDIUM-3    unknown event type → bare-string throw masked as 500
//   MEDIUM-5    out-of-range channel/note/etc → corrupt/injected .mid

import { describe, test, expect } from '@jest/globals';
import { file_write, file_save_as } from '../src/api/commands/schemas/file.schemas.js';

const withEvents = (events) => ({
  fileId: 1,
  midiData: { header: { format: 1, numTracks: 1, ticksPerBeat: 480 }, tracks: [events] }
});

describe('file_write midiData validation (audit D)', () => {
  test('accepts a well-formed editor payload (every event type it emits)', () => {
    const errs = file_write.custom(
      withEvents([
        { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
        { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 40 },
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
        { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
        { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 100 },
        { deltaTime: 0, type: 'pitchBend', channel: 0, value: -2048 },
        { deltaTime: 0, type: 'channelAftertouch', channel: 0, amount: 64 },
        { deltaTime: 0, type: 'noteAftertouch', channel: 0, noteNumber: 60, amount: 64 },
        { deltaTime: 0, type: 'endOfTrack' }
      ])
    );
    expect(errs).toEqual([]);
  });

  test('CRITICAL-1: rejects an out-of-VLQ deltaTime (writeVarInt infinite loop)', () => {
    const errs = file_write.custom(
      withEvents([
        { deltaTime: 2147483648, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 1 }
      ])
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/deltaTime/);
  });

  test('rejects a negative deltaTime', () => {
    const errs = file_write.custom(
      withEvents([{ deltaTime: -1, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 1 }])
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  test('MEDIUM-3: rejects an unknown event type (would throw a bare string in writeMidi)', () => {
    const errs = file_write.custom(withEvents([{ deltaTime: 0, type: 'hackerman' }]));
    expect(errs.some((e) => /unknown event type/.test(e))).toBe(true);
  });

  test('rejects an event with a missing type', () => {
    const errs = file_write.custom(withEvents([{ deltaTime: 0 }]));
    expect(errs.length).toBeGreaterThan(0);
  });

  test('MEDIUM-5: rejects an out-of-nibble channel (0x90|112 = 0xF0 sysEx-status injection)', () => {
    const errs = file_write.custom(
      withEvents([{ deltaTime: 0, type: 'noteOn', channel: 112, noteNumber: 60, velocity: 100 }])
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  test('MEDIUM-5: rejects an out-of-range noteNumber (would be stored as note & 0xFF)', () => {
    const errs = file_write.custom(
      withEvents([{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 300, velocity: 100 }])
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  test('MEDIUM-5: rejects out-of-range pitchBend', () => {
    const errs = file_write.custom(
      withEvents([{ deltaTime: 0, type: 'pitchBend', channel: 0, value: 50000 }])
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  test('rejects a fractional (non-integer) value', () => {
    const errs = file_write.custom(
      withEvents([{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60.5, velocity: 100 }])
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  test('CRITICAL-2: rejects an excessive count of text/sysEx meta events (O(n²) writeBytes)', () => {
    const metas = [];
    for (let i = 0; i < 5001; i++) metas.push({ deltaTime: 0, type: 'marker', text: 'x' });
    const errs = file_write.custom(withEvents(metas));
    expect(errs.some((e) => /meta events/.test(e))).toBe(true);
  });

  test('still enforces the overall track and event caps', () => {
    const tooManyTracks = { fileId: 1, midiData: { header: {}, tracks: [] } };
    for (let i = 0; i < 257; i++) tooManyTracks.midiData.tracks.push([]);
    expect(file_write.custom(tooManyTracks).some((e) => /tracks/.test(e))).toBe(true);
  });

  test('rejects a non-object midiData / missing tracks', () => {
    expect(file_write.custom({ fileId: 1, midiData: 42 }).length).toBeGreaterThan(0);
    expect(file_write.custom({ fileId: 1, midiData: { header: {} } }).length).toBeGreaterThan(0);
  });
});

describe('file_save_as validation (audit D)', () => {
  test('applies the same event validation as file_write', () => {
    const bad = {
      fileId: 1,
      newFilename: 'ok.mid',
      midiData: {
        header: {},
        tracks: [[{ deltaTime: 2 ** 31, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 1 }]]
      }
    };
    expect(file_save_as.custom(bad).length).toBeGreaterThan(0);
  });

  test('still requires a valid filename', () => {
    const noName = withEvents([{ deltaTime: 0, type: 'endOfTrack' }]);
    expect(file_save_as.custom(noName).some((e) => /filename/i.test(e))).toBe(true);
  });
});
