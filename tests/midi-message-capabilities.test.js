import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import DescriptorService from '../src/midi/instrument/DescriptorService.js';
import InstrumentRepository from '../src/repositories/InstrumentRepository.js';
import {
  allowsMidiMessage,
  deriveMidiMessageSupport,
  validateMidiMessageCapabilities
} from '../src/midi/instrument/MidiMessageCapabilities.js';

describe('MidiMessageCapabilities', () => {
  test('derives conservative support from legacy v2 notes/expression fields', () => {
    const support = deriveMidiMessageSupport({
      channel: 0,
      notes: { mode: 'range', min: 48, max: 84 },
      expression: {
        cc: [1, 7, 11],
        velocity: true,
        pitch_bend: { supported: true, range_semitones: 2 },
        channel_aftertouch: true,
        poly_aftertouch: false
      }
    });

    expect(support).toEqual({
      note_on: true,
      note_off: true,
      control_change: true,
      pitch_bend: true,
      channel_aftertouch: true,
      poly_aftertouch: false,
      velocity: true,
      pitch_bend_range_semitones: 2
    });
    // Program/realtime are unknown, never guessed false.
    expect(support).not.toHaveProperty('program_change');
    expect(support).not.toHaveProperty('clock');
  });

  test('explicit messages override legacy inference and preserve explicit false', () => {
    const support = deriveMidiMessageSupport({
      notes: { mode: 'range', min: 0, max: 127 },
      messages: {
        note_on: true,
        note_off: true,
        control_change: false,
        pitch_bend: false,
        program_change: true,
        stop: true
      },
      expression: {
        cc: [7, 11],
        pitch_bend: { supported: true, range_semitones: 12 }
      }
    });

    expect(support.control_change).toBe(false);
    expect(support.pitch_bend).toBe(false);
    expect(support.program_change).toBe(true);
    expect(support.stop).toBe(true);
    // Range metadata remains useful even when the active configuration says
    // pitch bend is currently disabled.
    expect(support.pitch_bend_range_semitones).toBe(12);
  });

  test('validates known message keys but tolerates future unknown keys', () => {
    expect(validateMidiMessageCapabilities({ messages: { pitch_bend: true, future_midi2: 'x' } })).toEqual([]);
    expect(validateMidiMessageCapabilities({ messages: { pitch_bend: 1 } })).toEqual([
      'messages.pitch_bend must be a boolean'
    ]);
    expect(validateMidiMessageCapabilities({ messages: [] })).toEqual(['messages must be an object']);
  });

  test('runtime policy suppresses only explicit false', () => {
    expect(allowsMidiMessage(null, 'pitch_bend')).toBe(true);
    expect(allowsMidiMessage({}, 'pitch_bend')).toBe(true);
    expect(allowsMidiMessage({ pitch_bend: true }, 'pitch_bend')).toBe(true);
    expect(allowsMidiMessage({ pitch_bend: false }, 'pitch_bend')).toBe(false);
  });
});

describe('DescriptorService MIDI capability integration', () => {
  test('persists semantic support after applying legacy-compatible descriptor fields', () => {
    const repo = {
      updateCapabilities: jest.fn(),
      updateSettings: jest.fn(),
      saveMidiMessageSupport: jest.fn()
    };
    const service = new DescriptorService({ instrumentRepository: repo });
    const descriptor = {
      gmb_descriptor: 2,
      revision: 3,
      instruments: [
        {
          channel: 0,
          configured: true,
          notes: { mode: 'range', min: 60, max: 72 },
          expression: {
            cc: [1, 7, 11],
            velocity: true,
            pitch_bend: { supported: false },
            channel_aftertouch: false,
            poly_aftertouch: false
          }
        }
      ]
    };

    const result = service.applyDescriptor('dev', descriptor);

    expect(result.applied).toBe(true);
    expect(repo.updateCapabilities).toHaveBeenCalledTimes(1);
    expect(repo.saveMidiMessageSupport).toHaveBeenCalledWith('dev', 0, {
      note_on: true,
      note_off: true,
      control_change: true,
      pitch_bend: false,
      channel_aftertouch: false,
      poly_aftertouch: false,
      velocity: true
    });
  });

  test('rejects malformed known message declarations before touching persistence', () => {
    const repo = {
      updateCapabilities: jest.fn(),
      saveMidiMessageSupport: jest.fn()
    };
    const service = new DescriptorService({ instrumentRepository: repo });
    const result = service.applyDescriptor('dev', {
      gmb_descriptor: 2,
      instruments: [{ channel: 0, messages: { program_change: 'sometimes' } }]
    });

    expect(result.applied).toBe(false);
    expect(result.errors).toContain('instruments[0].messages.program_change must be a boolean');
    expect(repo.updateCapabilities).not.toHaveBeenCalled();
    expect(repo.saveMidiMessageSupport).not.toHaveBeenCalled();
  });
});

describe('InstrumentRepository MIDI message persistence', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE instruments_latency (
        device_id TEXT NOT NULL,
        channel INTEGER NOT NULL,
        midi_message_support TEXT,
        pitch_bend_enabled INTEGER NOT NULL DEFAULT 0,
        capabilities_updated_at TEXT,
        PRIMARY KEY (device_id, channel)
      );
      INSERT INTO instruments_latency (device_id, channel) VALUES ('dev', 2);
    `);
    repo = new InstrumentRepository({ db });
  });

  afterEach(() => db.close());

  test('round-trips JSON and mirrors explicit pitch bend support', () => {
    repo.saveMidiMessageSupport('dev', 2, {
      note_on: true,
      note_off: true,
      pitch_bend: true,
      pitch_bend_range_semitones: 2,
      channel_aftertouch: false
    });

    expect(repo.getMidiMessageSupport('dev', 2)).toEqual({
      note_on: true,
      note_off: true,
      pitch_bend: true,
      pitch_bend_range_semitones: 2,
      channel_aftertouch: false
    });
    expect(
      db.prepare('SELECT pitch_bend_enabled FROM instruments_latency WHERE device_id = ? AND channel = ?')
        .get('dev', 2).pitch_bend_enabled
    ).toBe(1);
  });

  test('unknown pitch bend support does not overwrite the legacy UI flag', () => {
    db.prepare('UPDATE instruments_latency SET pitch_bend_enabled = 1 WHERE device_id = ? AND channel = ?')
      .run('dev', 2);
    repo.saveMidiMessageSupport('dev', 2, { note_on: true, note_off: true });

    expect(
      db.prepare('SELECT pitch_bend_enabled FROM instruments_latency WHERE device_id = ? AND channel = ?')
        .get('dev', 2).pitch_bend_enabled
    ).toBe(1);
  });
});
