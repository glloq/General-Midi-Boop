// tests/frontend/routing-summary-assignment-builder.test.js
//
// Unit tests for the pure state → apply_assignments payload transformation
// extracted in P2-F.3. The builder lives in
// public/js/features/auto-assign/RoutingSummaryAssignmentBuilder.js
// and is exposed on `window.RoutingSummaryAssignmentBuilder`.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Evaluate the constants + builder IIFEs so their `window.*` exports are live.
const ctx = { window: {} };
ctx.globalThis = ctx;

function loadScript(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const fn = new Function('window', src);
  fn(ctx.window);
}

beforeAll(() => {
  loadScript('../../public/js/features/auto-assign/RoutingSummaryConstants.js');
  loadScript('../../public/js/features/auto-assign/RoutingSummaryAssignmentBuilder.js');
});

function builder() {
  return ctx.window.RoutingSummaryAssignmentBuilder;
}

function baseState(overrides = {}) {
  return {
    selectedAssignments: {},
    splitAssignments: {},
    splitChannels: new Set(),
    skippedChannels: new Set(),
    adaptationSettings: {},
    ccRemapping: {},
    ccSegmentMute: {},
    autoAdaptation: false,
    getInstrumentPolyphony: () => null,
    getChannelVolume: () => 100,
    ...overrides
  };
}

describe('buildAssignmentsPayload — non-split channels', () => {
  it('returns empty result when no assignments', () => {
    const out = builder().buildAssignmentsPayload(baseState());
    expect(out.assignments).toEqual({});
    expect(out.hasAssignment).toBe(false);
    expect(out.hasSplit).toBe(false);
  });

  it('skips channels without deviceId', () => {
    const state = baseState({
      selectedAssignments: { 0: { instrumentName: 'Piano' } }
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(out.hasAssignment).toBe(false);
  });

  it('builds a minimal payload for a single assigned channel', () => {
    const state = baseState({
      selectedAssignments: {
        0: { deviceId: 'out-1', instrumentId: 42, instrumentName: 'Piano', gmProgram: 0 }
      }
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(out.hasAssignment).toBe(true);
    expect(out.hasSplit).toBe(false);
    expect(out.assignments['0']).toMatchObject({
      deviceId: 'out-1',
      instrumentId: 42,
      instrumentName: 'Piano',
      transposition: { semitones: 0 },
      suppressOutOfRange: false,
      noteCompression: false,
      polyReduction: false,
      maxPolyphony: null,
      channelVolume: 100
    });
  });

  it('ignores skipped channels', () => {
    const state = baseState({
      selectedAssignments: {
        0: { deviceId: 'out-1' },
        1: { deviceId: 'out-2' }
      },
      skippedChannels: new Set([1])
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(Object.keys(out.assignments)).toEqual(['0']);
  });

  it('applies transposition when autoAdaptation is on', () => {
    const state = baseState({
      autoAdaptation: true,
      selectedAssignments: { 0: { deviceId: 'out-1', gmProgram: 0 } },
      adaptationSettings: { 0: { transpositionSemitones: 12, oorHandling: 'suppress' } }
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(out.assignments['0'].transposition.semitones).toBe(12);
    expect(out.assignments['0'].suppressOutOfRange).toBe(true);
  });

  it('resolves poly target from instrument polyphony when manual not set', () => {
    const state = baseState({
      autoAdaptation: true,
      selectedAssignments: { 0: { deviceId: 'out-1', gmProgram: 0 } },
      adaptationSettings: { 0: { polyReduction: 'shorten' } },
      getInstrumentPolyphony: () => 8
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(out.assignments['0'].polyReduction).toBe(true);
    expect(out.assignments['0'].maxPolyphony).toBe(8);
    expect(out.assignments['0'].polyStrategy).toBe('shorten');
  });

  it('uses the GM default polyphony when no instrument override', () => {
    const state = baseState({
      autoAdaptation: true,
      selectedAssignments: { 0: { deviceId: 'out-1', gmProgram: 0 } }, // program 0 = Piano → 16
      adaptationSettings: { 0: { polyReduction: 'shorten' } }
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(out.assignments['0'].maxPolyphony).toBe(16);
  });
});

describe('buildAssignmentsPayload — split channels', () => {
  it('emits segments and flags hasSplit', () => {
    const state = baseState({
      splitChannels: new Set([0]),
      splitAssignments: {
        0: {
          type: 'range',
          quality: 90,
          segments: [
            { deviceId: 'd1', instrumentChannel: 10, noteRange: { min: 0, max: 59 } },
            { deviceId: 'd2', instrumentChannel: 11, noteRange: { min: 60, max: 127 } }
          ]
        }
      }
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(out.hasSplit).toBe(true);
    expect(out.assignments['0'].split).toBe(true);
    expect(out.assignments['0'].segments).toHaveLength(2);
    expect(out.assignments['0'].segments[0].deviceId).toBe('d1');
  });

  it('serialises the ccSegmentMute Sets to arrays', () => {
    const state = baseState({
      splitChannels: new Set([0]),
      splitAssignments: { 0: { type: 'range', segments: [{ deviceId: 'd1' }] } },
      ccSegmentMute: { 0: { cc7: new Set([0, 1]) } }
    });
    const out = builder().buildAssignmentsPayload(state);
    expect(out.assignments['0'].ccSegmentMute).toEqual({ cc7: [0, 1] });
  });
});

describe('computeModificationFlags', () => {
  it('flags hasTransposition when any semitone is non-zero', () => {
    const flags = builder().computeModificationFlags({
      0: { transposition: { semitones: 0 } },
      1: { transposition: { semitones: 3 } }
    }, false);
    expect(flags.hasTransposition).toBe(true);
    expect(flags.needsFileModification).toBe(true);
  });

  it('flags hasCCRemap when any channel has a non-empty ccRemapping', () => {
    const flags = builder().computeModificationFlags({
      0: { ccRemapping: { cc1: 2 } }
    }, false);
    expect(flags.hasCCRemap).toBe(true);
  });

  it('flags hasVolumeChange when any channelVolume differs from 100', () => {
    const flags = builder().computeModificationFlags({
      0: { channelVolume: 80 }
    }, false);
    expect(flags.hasVolumeChange).toBe(true);
  });

  it('returns needsFileModification = true when hasSplit alone', () => {
    const flags = builder().computeModificationFlags({}, true);
    expect(flags.needsFileModification).toBe(true);
  });

  it('returns needsFileModification = false when no flag set', () => {
    const flags = builder().computeModificationFlags({
      0: { transposition: { semitones: 0 }, channelVolume: 100 }
    }, false);
    expect(flags.needsFileModification).toBe(false);
  });
});
