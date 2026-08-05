// tests/descriptor-protocol.test.js
// Pure core of the v2 descriptor protocol (docs/SYSEX_IDENTITY.md): block 0x10
// chunk reassembly (§3), descriptor structural validation (§5), and the §6
// override-arbitration diff. No MIDI stack / DB.

import { describe, test, expect } from '@jest/globals';
import {
  assembleChunks,
  validateDescriptor,
  diffOverrides
} from '../src/midi/instrument/DescriptorProtocol.js';

describe('assembleChunks (block 0x10 reassembly)', () => {
  test('empty input → incomplete', () => {
    expect(assembleChunks([])).toEqual({ complete: false, total: null, missing: [], json: null });
  });

  test('single-chunk transfer', () => {
    const r = assembleChunks([{ index: 0, total: 1, payload: '{"a":1}' }]);
    expect(r).toEqual({ complete: true, total: 1, missing: [], json: '{"a":1}' });
  });

  test('multi-chunk reassembles in index order regardless of arrival order', () => {
    const r = assembleChunks([
      { index: 2, total: 3, payload: '3' },
      { index: 0, total: 3, payload: '1' },
      { index: 1, total: 3, payload: '2' }
    ]);
    expect(r.complete).toBe(true);
    expect(r.json).toBe('123');
  });

  test('missing chunk → incomplete with the missing indices', () => {
    const r = assembleChunks([
      { index: 0, total: 3, payload: 'a' },
      { index: 2, total: 3, payload: 'c' }
    ]);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([1]);
    expect(r.json).toBeNull();
  });

  test('duplicate chunks are tolerated (last write wins)', () => {
    const r = assembleChunks([
      { index: 0, total: 2, payload: 'a' },
      { index: 1, total: 2, payload: 'b' },
      { index: 0, total: 2, payload: 'a' }
    ]);
    expect(r.complete).toBe(true);
    expect(r.json).toBe('ab');
  });

  test('inconsistent totals → rejected (restart the transfer)', () => {
    const r = assembleChunks([
      { index: 0, total: 2, payload: 'a' },
      { index: 1, total: 3, payload: 'b' }
    ]);
    expect(r.complete).toBe(false);
    expect(r.total).toBeNull();
  });
});

describe('validateDescriptor (§5)', () => {
  const minimal = { gmb_descriptor: 2, instruments: [{ channel: 0 }] };

  test('accepts a minimal descriptor', () => {
    expect(validateDescriptor(minimal)).toEqual({ valid: true, errors: [] });
  });

  test('accepts a full instrument entry', () => {
    const d = {
      gmb_descriptor: 2,
      revision: 42,
      device: { name: 'Atelier', model: 'Servo-Flute-GMB' },
      instruments: [
        {
          channel: 0,
          configured: true,
          name: 'Ukulele',
          gm_program: 24,
          type: 'guitar',
          subtype: 'nylon',
          notes: { mode: 'range', min: 60, max: 88 },
          physical: { family: 'strings', tuning: [67, 60, 64, 69] }
        }
      ]
    };
    expect(validateDescriptor(d).valid).toBe(true);
  });

  test('accepts discrete notes', () => {
    const d = {
      gmb_descriptor: 2,
      instruments: [{ channel: 3, notes: { mode: 'discrete', list: [36, 38, 40] } }]
    };
    expect(validateDescriptor(d).valid).toBe(true);
  });

  test('ignores unknown fields (extensibility rule)', () => {
    const d = {
      gmb_descriptor: 2,
      future_top_level: { anything: true },
      instruments: [{ channel: 0, future_field: 123, resources: [{ id: 'bow' }] }]
    };
    expect(validateDescriptor(d).valid).toBe(true);
  });

  test('rejects a non-object', () => {
    expect(validateDescriptor(null).valid).toBe(false);
    expect(validateDescriptor([]).valid).toBe(false);
    expect(validateDescriptor('x').valid).toBe(false);
  });

  test('rejects an unsupported version', () => {
    expect(validateDescriptor({ gmb_descriptor: 1, instruments: [{ channel: 0 }] }).valid).toBe(
      false
    );
  });

  test('rejects empty / oversized instrument lists', () => {
    expect(validateDescriptor({ gmb_descriptor: 2, instruments: [] }).valid).toBe(false);
    const many = Array.from({ length: 17 }, (_, i) => ({ channel: i % 16 }));
    expect(validateDescriptor({ gmb_descriptor: 2, instruments: many }).valid).toBe(false);
  });

  test('rejects a bad or duplicate channel', () => {
    expect(validateDescriptor({ gmb_descriptor: 2, instruments: [{ channel: 16 }] }).valid).toBe(
      false
    );
    expect(validateDescriptor({ gmb_descriptor: 2, instruments: [{ channel: -1 }] }).valid).toBe(
      false
    );
    expect(
      validateDescriptor({ gmb_descriptor: 2, instruments: [{ channel: 0 }, { channel: 0 }] }).valid
    ).toBe(false);
  });

  test('rejects malformed notes blocks', () => {
    expect(
      validateDescriptor({
        gmb_descriptor: 2,
        instruments: [{ channel: 0, notes: { mode: 'weird' } }]
      }).valid
    ).toBe(false);
    expect(
      validateDescriptor({
        gmb_descriptor: 2,
        instruments: [{ channel: 0, notes: { mode: 'range', min: 90, max: 60 } }]
      }).valid
    ).toBe(false);
    expect(
      validateDescriptor({
        gmb_descriptor: 2,
        instruments: [{ channel: 0, notes: { mode: 'discrete', list: [] } }]
      }).valid
    ).toBe(false);
  });
});

describe('diffOverrides (§6 arbitration)', () => {
  test('first descriptor (no previous) keeps every override', () => {
    const next = { channel: 0, tuning: [67, 60, 64, 69], configured: true };
    expect(diffOverrides(null, next, ['tuning', 'polyphony'])).toEqual({
      purge: [],
      keep: ['tuning', 'polyphony']
    });
  });

  test('configured=false keeps every override', () => {
    const prev = { channel: 0, tuning: [67, 60, 64, 69] };
    const next = { channel: 0, tuning: [60, 60, 60, 60], configured: false };
    expect(diffOverrides(prev, next, ['tuning']).purge).toEqual([]);
  });

  test('device changed a field → that override is purged', () => {
    const prev = { channel: 0, gm_program: 24 };
    const next = { channel: 0, gm_program: 25 };
    const r = diffOverrides(prev, next, ['gm_program']);
    expect(r.purge).toEqual(['gm_program']);
    expect(r.keep).toEqual([]);
  });

  test('field unchanged by the device → override kept', () => {
    const prev = { channel: 0, gm_program: 24 };
    const next = { channel: 0, gm_program: 24 };
    expect(diffOverrides(prev, next, ['gm_program']).keep).toEqual(['gm_program']);
  });

  test('field went from declared to absent → override kept', () => {
    const prev = { channel: 0, gm_program: 24 };
    const next = { channel: 0 };
    expect(diffOverrides(prev, next, ['gm_program']).keep).toEqual(['gm_program']);
  });

  test('tuning compared as a whole: one string change purges the tuning override', () => {
    const prev = { channel: 0, tuning: [67, 60, 64, 69] };
    const nextSame = { channel: 0, tuning: [67, 60, 64, 69] };
    const nextOneChanged = { channel: 0, tuning: [67, 60, 64, 70] };
    expect(diffOverrides(prev, nextSame, ['tuning']).purge).toEqual([]);
    expect(diffOverrides(prev, nextOneChanged, ['tuning']).purge).toEqual(['tuning']);
  });

  test('mixed fields: only the ones the device moved are purged', () => {
    const prev = { channel: 0, gm_program: 24, tuning: [1, 2], name: 'A' };
    const next = { channel: 0, gm_program: 24, tuning: [1, 3], name: 'A' };
    const r = diffOverrides(prev, next, ['gm_program', 'tuning', 'name']);
    expect(r.purge).toEqual(['tuning']);
    expect(new Set(r.keep)).toEqual(new Set(['gm_program', 'name']));
  });
});
