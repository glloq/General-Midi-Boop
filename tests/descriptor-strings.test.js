// tests/descriptor-strings.test.js
// Strings-family application (§5.9): descriptorToStringConfig maps a `physical`
// block onto string_instruments columns, and DescriptorService upserts it as a
// PARTIAL update (preserving user-set fields the descriptor omits). Pure mapper
// + service tested with a mock string repository (no DB).

import { describe, test, expect, jest } from '@jest/globals';
import { descriptorToStringConfig } from '../src/midi/instrument/DescriptorProtocol.js';
import { DescriptorService } from '../src/midi/instrument/DescriptorService.js';

describe('descriptorToStringConfig', () => {
  test('maps declared fields; booleans as 0/1; selection → cc fields', () => {
    const cfg = descriptorToStringConfig({
      family: 'strings',
      string_count: 4,
      fret_count: 12,
      frets_per_string: [12, 12, 12, 12],
      fretless: false,
      capo: 2,
      tuning: [67, 60, 64, 69],
      selection: { mode: 'hybrid', cc_string: 20, cc_fret: 21 }
    });
    expect(cfg).toEqual({
      num_strings: 4,
      num_frets: 12,
      frets_per_string: [12, 12, 12, 12],
      is_fretless: 0,
      capo_fret: 2,
      tuning: [67, 60, 64, 69],
      cc_string_number: 20,
      cc_fret_number: 21,
      cc_enabled: 1
    });
  });

  test('fretless true → is_fretless 1; no selection → no cc fields', () => {
    const cfg = descriptorToStringConfig({
      family: 'strings',
      tuning: [55, 62, 69, 76],
      fretless: true
    });
    expect(cfg.is_fretless).toBe(1);
    expect(cfg.cc_enabled).toBeUndefined();
    expect(cfg.cc_string_number).toBeUndefined();
  });

  test('nothing mappable → null', () => {
    expect(descriptorToStringConfig({ family: 'strings' })).toBeNull();
    expect(descriptorToStringConfig(null)).toBeNull();
  });
});

function makeService(stringRepo) {
  const repo = { updateCapabilities: jest.fn() };
  const svc = new DescriptorService({
    instrumentRepository: repo,
    stringInstrumentRepository: stringRepo,
    eventBus: { emit: jest.fn() },
    logger: { info() {}, warn() {}, debug() {} }
  });
  return { svc, repo };
}

const stringsDesc = {
  gmb_descriptor: 2,
  instruments: [
    {
      channel: 0,
      configured: true,
      type: 'guitar',
      notes: { mode: 'range', min: 60, max: 88 },
      physical: {
        family: 'strings',
        string_count: 4,
        fret_count: 12,
        fretless: false,
        capo: 0,
        tuning: [67, 60, 64, 69],
        selection: { cc_string: 20, cc_fret: 21 }
      }
    }
  ]
};

describe('DescriptorService — strings geometry', () => {
  test('updates an existing string row (partial, preserves other fields)', () => {
    const stringRepo = {
      findByDeviceChannel: jest.fn(() => ({ id: 'sid1' })),
      update: jest.fn(),
      save: jest.fn()
    };
    const { svc, repo } = makeService(stringRepo);
    const res = svc.applyDescriptor('dev', stringsDesc);

    expect(repo.updateCapabilities).toHaveBeenCalledWith('dev', 0, expect.any(Object));
    expect(stringRepo.update).toHaveBeenCalledWith(
      'sid1',
      expect.objectContaining({ tuning: [67, 60, 64, 69], num_frets: 12, cc_string_number: 20 })
    );
    expect(stringRepo.save).not.toHaveBeenCalled();
    expect(res.instruments[0].stringConfigApplied).toBe(true);
  });

  test('creates a new string row when none exists', () => {
    const stringRepo = {
      findByDeviceChannel: jest.fn(() => null),
      update: jest.fn(),
      save: jest.fn()
    };
    const { svc } = makeService(stringRepo);
    svc.applyDescriptor('dev', stringsDesc);
    expect(stringRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ device_id: 'dev', channel: 0, tuning: [67, 60, 64, 69] })
    );
    expect(stringRepo.update).not.toHaveBeenCalled();
  });

  test('non-strings instruments touch no string repo', () => {
    const stringRepo = { findByDeviceChannel: jest.fn(), update: jest.fn(), save: jest.fn() };
    const { svc } = makeService(stringRepo);
    svc.applyDescriptor('dev', {
      gmb_descriptor: 2,
      instruments: [{ channel: 0, configured: true, notes: { mode: 'range', min: 60, max: 72 } }]
    });
    expect(stringRepo.findByDeviceChannel).not.toHaveBeenCalled();
  });

  test('a string-config failure does not undo the capability apply', () => {
    const stringRepo = {
      findByDeviceChannel: jest.fn(() => {
        throw new Error('db down');
      }),
      update: jest.fn(),
      save: jest.fn()
    };
    const { svc } = makeService(stringRepo);
    const res = svc.applyDescriptor('dev', stringsDesc);
    expect(res.instruments[0].applied).toBe(true);
    expect(res.instruments[0].stringConfigApplied).toBe(false);
  });

  test('no string repo wired → capabilities apply, no string handling', () => {
    const { svc } = makeService(undefined);
    const res = svc.applyDescriptor('dev', stringsDesc);
    expect(res.instruments[0].applied).toBe(true);
    expect(res.instruments[0].stringConfigApplied).toBeUndefined();
  });
});
