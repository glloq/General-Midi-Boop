// tests/playback-assignment-hand-warnings.test.js
// D.2: applyAssignments emits a per-channel handPositionWarnings summary.
// Tests target the exported helper buildHandPositionWarnings so we can
// drive it with stub repositories without spinning up the full
// SQLite/file/blob machinery.

import { describe, test, expect, jest } from '@jest/globals';
import { buildHandPositionWarnings } from '../src/midi/playback/commands/PlaybackAssignmentCommands.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function makeApp({ caps = {}, analyses = {} } = {}) {
  return {
    logger: silentLogger,
    instrumentRepository: {
      getCapabilities: jest.fn((deviceId, channel) => caps[`${deviceId}:${channel}`] || null)
    },
    adaptationService: {
      analyzeChannel: jest.fn((midiData, channel) => analyses[String(channel)] || null)
    }
  };
}

const semitonesHands = {
  enabled: true,
  mode: 'semitones',
  hand_move_semitones_per_sec: 60,
  hands: [
    { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
  ]
};

const fretsHands = {
  enabled: true,
  mode: 'frets',
  hand_move_mm_per_sec: 250,
  hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, max_fingers: 4 }]
};

function analysis({ polyphonyMax = 4, rangeMin = 60, rangeMax = 72 } = {}) {
  return {
    noteRange: { min: rangeMin, max: rangeMax },
    polyphony: { max: polyphonyMax, avg: polyphonyMax }
  };
}

describe('buildHandPositionWarnings', () => {
  test('returns an empty array when no instrument repository is wired', () => {
    const out = buildHandPositionWarnings({ logger: silentLogger }, {}, { 0: { deviceId: 'd1' } });
    expect(out).toEqual([]);
  });

  test('emits one entry per non-split assignment', () => {
    const app = makeApp({
      caps: { 'piano-1:0': { hands_config: semitonesHands } },
      analyses: { '0': analysis() }
    });
    const out = buildHandPositionWarnings(app, {}, {
      0: { deviceId: 'piano-1', instrumentName: 'Grand Piano' }
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      channel: 0,
      deviceId: 'piano-1',
      instrumentName: 'Grand Piano',
      level: 'ok'
    });
  });

  test('emits one entry per segment for a split assignment', () => {
    const app = makeApp({
      caps: {
        'bass-1:0':   { hands_config: semitonesHands },
        'treble-1:0': { hands_config: semitonesHands }
      },
      analyses: { '0': analysis() }
    });
    const out = buildHandPositionWarnings(app, {}, {
      0: {
        split: true,
        segments: [
          { deviceId: 'bass-1',   instrumentName: 'Bass',   noteRange: { min: 0,  max: 59 } },
          { deviceId: 'treble-1', instrumentName: 'Treble', noteRange: { min: 60, max: 127 } }
        ]
      }
    });
    expect(out).toHaveLength(2);
    expect(out.map(e => e.deviceId).sort()).toEqual(['bass-1', 'treble-1']);
    // Segment label preserved so the UI can show "notes 0-59".
    expect(out.find(e => e.deviceId === 'bass-1').segmentLabel).toMatch(/0-59/);
  });

  test('emits level=infeasible when polyphony exceeds the hand finger budget', () => {
    const app = makeApp({
      caps: { 'guitar-1:0': { hands_config: fretsHands } },
      analyses: { '0': analysis({ polyphonyMax: 6, rangeMin: 50, rangeMax: 60 }) }
    });
    const out = buildHandPositionWarnings(app, {}, {
      0: { deviceId: 'guitar-1', instrumentName: 'Guitar' }
    });
    expect(out[0].level).toBe('infeasible');
    expect(out[0].message).toMatch(/finger/);
  });

  test('emits level=unknown when capabilities lookup fails', () => {
    const app = makeApp({
      caps: {}, // no caps row for this device
      analyses: { '0': analysis() }
    });
    const out = buildHandPositionWarnings(app, {}, {
      0: { deviceId: 'unknown-1', instrumentName: 'New device' }
    });
    expect(out[0].level).toBe('unknown');
  });

  test('emits level=unknown when analyzeChannel throws', () => {
    const app = {
      logger: silentLogger,
      instrumentRepository: { getCapabilities: () => ({ hands_config: semitonesHands }) },
      adaptationService: { analyzeChannel: () => { throw new Error('boom'); } }
    };
    const out = buildHandPositionWarnings(app, {}, {
      0: { deviceId: 'piano-1' }
    });
    expect(out[0].level).toBe('unknown');
  });

  test('does not throw when assignment has no deviceId (skipped silently)', () => {
    const app = makeApp({ caps: {}, analyses: { '0': analysis() } });
    const out = buildHandPositionWarnings(app, {}, {
      0: { /* no deviceId, no segments */ }
    });
    expect(out).toEqual([]);
  });

  test('memoizes channelAnalysis per channel', () => {
    const app = makeApp({
      caps: {
        'a:0': { hands_config: semitonesHands },
        'b:0': { hands_config: semitonesHands }
      },
      analyses: { '0': analysis() }
    });
    buildHandPositionWarnings(app, {}, {
      0: {
        split: true,
        segments: [
          { deviceId: 'a' },
          { deviceId: 'b' }
        ]
      }
    });
    // Both segments live on channel 0; analyzeChannel should run once.
    expect(app.adaptationService.analyzeChannel).toHaveBeenCalledTimes(1);
  });

  test('passes through the qualityScore from the matcher heuristic', () => {
    const app = makeApp({
      caps: { 'piano-1:0': { hands_config: semitonesHands } },
      analyses: { '0': analysis({ polyphonyMax: 4, rangeMin: 60, rangeMax: 72 }) }
    });
    const out = buildHandPositionWarnings(app, {}, {
      0: { deviceId: 'piano-1' }
    });
    expect(out[0].qualityScore).toBe(100);
  });
});
