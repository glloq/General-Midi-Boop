// tests/capability-resolver.test.js
// CapabilityResolver.getTimingConstraints is the hot-path capability lookup the
// scheduler reads for every note. It had no direct test. Covers: the null
// defaults, the polyphony robustness (a stored 0/negative must disable the gate
// as `null`, not slip through), the octave_mode/scale_root exposure, and the
// discrete-only selectedNotes rule.

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { CapabilityResolver } from '../src/midi/instrument/CapabilityResolver.js';

let live = [];
function makeResolver(capRow) {
  const database = {
    instrumentCapabilitiesDB: { getInstrumentCapabilities: jest.fn(() => capRow) },
    stringInstrumentDB: { getStringInstrument: jest.fn(() => null) }
  };
  const eventBus = { on: jest.fn(), off: jest.fn() };
  const r = new CapabilityResolver({ database, eventBus });
  live.push(r);
  return r;
}
afterEach(() => {
  live.forEach((r) => r.destroy());
  live = [];
});

describe('CapabilityResolver.getTimingConstraints', () => {
  test('no capability record → all-null defaults (scaleRoot 0)', () => {
    const r = makeResolver(null);
    expect(r.getTimingConstraints('dev', 0)).toEqual({
      minNoteInterval: null,
      minNoteDuration: null,
      polyphony: null,
      noteRangeMin: null,
      noteRangeMax: null,
      selectedNotes: null,
      octaveMode: null,
      scaleRoot: 0,
      supportedCcs: null
    });
  });

  test('supported_ccs surface as a sanitized list, else null (P2-4)', () => {
    expect(
      makeResolver({ supported_ccs: [1, 7, 10, 200, -1, 64] }).getTimingConstraints('d', 0)
        .supportedCcs
    ).toEqual([1, 7, 10, 64]); // out-of-range 200/-1 dropped
    expect(makeResolver({ supported_ccs: [] }).getTimingConstraints('d', 0).supportedCcs).toBeNull();
    expect(makeResolver({}).getTimingConstraints('d', 0).supportedCcs).toBeNull();
  });

  test('polyphony: a valid positive value passes', () => {
    expect(makeResolver({ polyphony: 4 }).getTimingConstraints('d', 0).polyphony).toBe(4);
  });

  test('polyphony: 0 / negative / non-integer → null (gate disabled, not bypassed as a number)', () => {
    expect(makeResolver({ polyphony: 0 }).getTimingConstraints('d', 0).polyphony).toBeNull();
    expect(makeResolver({ polyphony: -3 }).getTimingConstraints('d', 0).polyphony).toBeNull();
    expect(makeResolver({ polyphony: 2.5 }).getTimingConstraints('d', 0).polyphony).toBeNull();
  });

  test('octave_mode / scale_root are exposed to the engine', () => {
    const c = makeResolver({ octave_mode: 'pentatonic', scale_root: 7 }).getTimingConstraints(
      'd',
      0
    );
    expect(c.octaveMode).toBe('pentatonic');
    expect(c.scaleRoot).toBe(7);
  });

  test('scale_root defaults to 0 when absent or non-integer', () => {
    expect(makeResolver({ octave_mode: 'diatonic' }).getTimingConstraints('d', 0).scaleRoot).toBe(
      0
    );
    expect(makeResolver({ scale_root: 'x' }).getTimingConstraints('d', 0).scaleRoot).toBe(0);
  });

  test('selectedNotes only surface in discrete mode with a non-empty list', () => {
    expect(
      makeResolver({
        note_selection_mode: 'discrete',
        selected_notes: [60, 64, 67]
      }).getTimingConstraints('d', 0).selectedNotes
    ).toEqual([60, 64, 67]);
    // range mode → ignored
    expect(
      makeResolver({ note_selection_mode: 'range', selected_notes: [60, 64] }).getTimingConstraints(
        'd',
        0
      ).selectedNotes
    ).toBeNull();
    // discrete but empty → null
    expect(
      makeResolver({ note_selection_mode: 'discrete', selected_notes: [] }).getTimingConstraints(
        'd',
        0
      ).selectedNotes
    ).toBeNull();
  });

  test('note range is passed through', () => {
    const c = makeResolver({ note_range_min: 55, note_range_max: 88 }).getTimingConstraints('d', 0);
    expect(c.noteRangeMin).toBe(55);
    expect(c.noteRangeMax).toBe(88);
  });
});

describe('CapabilityResolver string-geometry range derivation (T1.2)', () => {
  function makeStringResolver(capRow, stringRow) {
    const database = {
      instrumentCapabilitiesDB: { getInstrumentCapabilities: jest.fn(() => capRow) },
      stringInstrumentDB: { getStringInstrument: jest.fn(() => stringRow) }
    };
    const eventBus = { on: jest.fn(), off: jest.fn() };
    const r = new CapabilityResolver({ database, eventBus });
    live.push(r);
    return r;
  }

  test('fretted instrument with no note_range derives [min tuning, max tuning + num_frets]', () => {
    const c = makeStringResolver(null, {
      is_fretless: false,
      num_frets: 20,
      tuning: [40, 45, 50, 55, 59, 64]
    }).getTimingConstraints('d', 0);
    expect(c.noteRangeMin).toBe(40);
    expect(c.noteRangeMax).toBe(84); // 64 + 20
  });

  test('explicit note_range wins over string geometry', () => {
    const c = makeStringResolver(
      { note_range_min: 48, note_range_max: 72 },
      { is_fretless: false, num_frets: 20, tuning: [40, 45, 50, 55, 59, 64] }
    ).getTimingConstraints('d', 0);
    expect(c.noteRangeMin).toBe(48);
    expect(c.noteRangeMax).toBe(72);
  });

  test('fretless instrument is not clamped by derivation (no discrete last fret)', () => {
    const c = makeStringResolver(null, {
      is_fretless: true,
      num_frets: 0,
      tuning: [48, 55, 62, 69]
    }).getTimingConstraints('d', 0);
    expect(c.noteRangeMin).toBeNull();
    expect(c.noteRangeMax).toBeNull();
  });

  test('per-string fret counts raise the upper bound to the highest reach', () => {
    const c = makeStringResolver(null, {
      is_fretless: false,
      num_frets: 12,
      tuning: [40, 45, 50, 55, 59, 64],
      frets_per_string: [12, 12, 12, 12, 12, 22]
    }).getTimingConstraints('d', 0);
    expect(c.noteRangeMax).toBe(86); // 64 + 22
  });
});

describe('CapabilityResolver cache invalidation', () => {
  function makeBus() {
    const handlers = new Map();
    return {
      on(e, h) {
        if (!handlers.has(e)) handlers.set(e, []);
        handlers.get(e).push(h);
      },
      off() {},
      emit(e) {
        (handlers.get(e) || []).forEach((h) => h());
      }
    };
  }

  test('an applied descriptor (instruments_configured) drops the enforcement cache', () => {
    // A block 0x11 hot-change re-fetch narrows capabilities via DescriptorService,
    // which emits `instruments_configured`. Enforcement must see the new values
    // immediately, not stay stale until the periodic sweep.
    const getCaps = jest.fn(() => ({ note_range_min: 60, note_range_max: 72 }));
    const database = {
      instrumentCapabilitiesDB: { getInstrumentCapabilities: getCaps },
      stringInstrumentDB: { getStringInstrument: jest.fn(() => null) }
    };
    const bus = makeBus();
    const r = new CapabilityResolver({ database, eventBus: bus });
    live.push(r);

    r.getTimingConstraints('d', 0);
    r.getTimingConstraints('d', 0);
    expect(getCaps).toHaveBeenCalledTimes(1); // second read served from cache

    bus.emit('instruments_configured');

    r.getTimingConstraints('d', 0);
    expect(getCaps).toHaveBeenCalledTimes(2); // cache dropped → DB re-read
  });
});
