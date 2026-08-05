// tests/descriptor-mapping.test.js
// descriptorToCapabilities maps a §5 descriptor instrument onto the capability
// store fields; descriptorLookaheadMs computes the §9 lookahead. Pure.

import { describe, test, expect } from '@jest/globals';
import {
  descriptorToCapabilities,
  descriptorToSettings,
  descriptorToOverrideView,
  descriptorLookaheadMs
} from '../src/midi/instrument/DescriptorProtocol.js';

describe('descriptorToCapabilities', () => {
  test('range notes → range mode + bounds; source defaults to auto', () => {
    const caps = descriptorToCapabilities({
      channel: 0,
      gm_program: 24,
      notes: { mode: 'range', min: 60, max: 88 }
    });
    // gm_program is a SETTINGS column, not a capability column — it must NOT be
    // emitted here (updateInstrumentCapabilities would drop it silently).
    expect(caps).toEqual({
      channel: 0,
      capabilities_source: 'auto',
      note_selection_mode: 'range',
      note_range_min: 60,
      note_range_max: 88
    });
    expect(caps.gm_program).toBeUndefined();
  });

  test('discrete notes → discrete mode + selected_notes', () => {
    const caps = descriptorToCapabilities({
      channel: 9,
      notes: { mode: 'discrete', list: [36, 38, 40] }
    });
    expect(caps.note_selection_mode).toBe('discrete');
    expect(caps.selected_notes).toEqual([36, 38, 40]);
  });

  test('polyphony.max and expression.cc are taken', () => {
    const caps = descriptorToCapabilities({
      channel: 0,
      polyphony: { max: 4, constraints: [{ type: 'one_note_per_voice' }] },
      expression: { cc: [1, 7, 11] }
    });
    expect(caps.polyphony).toBe(4);
    expect(caps.supported_ccs).toEqual([1, 7, 11]);
  });

  test('absent fields are omitted (unknown = left to the user)', () => {
    const caps = descriptorToCapabilities({ channel: 3 });
    expect(caps).toEqual({ channel: 3, capabilities_source: 'auto' });
  });

  test('source can be overridden (for when the CHECK allows descriptor)', () => {
    expect(descriptorToCapabilities({ channel: 0 }, 'descriptor').capabilities_source).toBe(
      'descriptor'
    );
  });

  test('a non-positive polyphony.max is not applied', () => {
    expect(
      descriptorToCapabilities({ channel: 0, polyphony: { max: 0 } }).polyphony
    ).toBeUndefined();
  });
});

describe('descriptorToSettings', () => {
  test('emits gm_program / type / subtype when declared', () => {
    expect(
      descriptorToSettings({ channel: 0, gm_program: 24, type: 'guitar', subtype: 'nylon' })
    ).toEqual({
      gm_program: 24,
      instrument_type: 'guitar',
      instrument_subtype: 'nylon'
    });
  });

  test('omits absent / empty fields; empty object when nothing declared', () => {
    expect(descriptorToSettings({ channel: 0, gm_program: 0 })).toEqual({ gm_program: 0 });
    expect(descriptorToSettings({ channel: 0, type: '' })).toEqual({});
    expect(descriptorToSettings({ channel: 0 })).toEqual({});
  });
});

describe('descriptorToOverrideView', () => {
  test('flattens capabilities + settings into one column-named bag (no bookkeeping keys)', () => {
    const view = descriptorToOverrideView({
      channel: 0,
      gm_program: 24,
      notes: { mode: 'range', min: 60, max: 88 },
      polyphony: { max: 4 }
    });
    expect(view).toEqual({
      note_selection_mode: 'range',
      note_range_min: 60,
      note_range_max: 88,
      polyphony: 4,
      gm_program: 24
    });
    expect(view.channel).toBeUndefined();
    expect(view.capabilities_source).toBeUndefined();
  });

  test('folds in strings geometry so tuning/frets are diffable', () => {
    const view = descriptorToOverrideView({
      channel: 0,
      physical: { family: 'strings', tuning: [67, 60, 64, 69], string_count: 4 }
    });
    expect(view).toMatchObject({ tuning: [67, 60, 64, 69], num_strings: 4 });
  });
});

describe('descriptorLookaheadMs', () => {
  test('max prepare.max_ms across instruments', () => {
    const d = {
      instruments: [
        { channel: 0, timing: { prepare: { max_ms: 120 } } },
        { channel: 1, timing: { prepare: { max_ms: 180 } } },
        { channel: 2, timing: { excite: { latency_ms: 12 } } }
      ]
    };
    expect(descriptorLookaheadMs(d)).toBe(180);
  });

  test('0 when nothing declares a prepare phase', () => {
    expect(descriptorLookaheadMs({ instruments: [{ channel: 0 }] })).toBe(0);
    expect(descriptorLookaheadMs({})).toBe(0);
  });
});
