// tests/validate-routing-feasibility.test.js
// A.4: a pre-apply WS command that runs the matcher's hand-position
// heuristic for one (channel, instrument) pair and returns the same
// {level, summary, message} payload the apply path produces in D.2.
// We drive the exported helper directly with a stub `app` — no
// SQLite, no MIDI parsing.

import { describe, test, expect, jest } from '@jest/globals';
import { validateRoutingFeasibility } from '../src/api/commands/RoutingCommands.js';
import { ValidationError } from '../src/core/errors/index.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const semitonesHands = {
  enabled: true,
  mode: 'semitones',
  hand_move_semitones_per_sec: 60,
  hands: [
    { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
  ]
};

function analysis({ polyphonyMax = 4, rangeMin = 60, rangeMax = 72 } = {}) {
  return {
    noteRange: { min: rangeMin, max: rangeMax },
    polyphony: { max: polyphonyMax }
  };
}

function makeApp({ caps = null, analyzer = null, file = null, blobThrows = false } = {}) {
  return {
    logger: silentLogger,
    instrumentRepository: {
      getCapabilities: jest.fn(() => caps)
    },
    adaptationService: analyzer ? { analyzeChannel: jest.fn(analyzer) } : null,
    fileRepository: {
      findById: jest.fn(() => file)
    },
    blobStore: {
      read: jest.fn(() => {
        if (blobThrows) throw new Error('boom');
        // Return a tiny but not-totally-bogus MIDI header so parseMidi
        // doesn't blow up. The downstream analyzer is stubbed anyway.
        return Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96]);
      })
    }
  };
}

describe('validate_routing_feasibility — input validation', () => {
  test('throws when fileId is missing', async () => {
    await expect(validateRoutingFeasibility(makeApp(), { channel: 0, deviceId: 'p' }))
      .rejects.toThrow(ValidationError);
  });

  test('throws when deviceId is missing', async () => {
    await expect(validateRoutingFeasibility(makeApp(), { fileId: 1, channel: 0 }))
      .rejects.toThrow(ValidationError);
  });

  test('throws when channel is missing', async () => {
    await expect(validateRoutingFeasibility(makeApp(), { fileId: 1, deviceId: 'p' }))
      .rejects.toThrow(ValidationError);
  });

  test('throws when channel is out of range', async () => {
    await expect(validateRoutingFeasibility(makeApp(), { fileId: 1, deviceId: 'p', channel: 16 }))
      .rejects.toThrow(/0 and 15/);
  });
});

describe('validate_routing_feasibility — happy paths', () => {
  test('returns level=ok for a comfortable channel routed to a configured instrument', async () => {
    const app = makeApp({
      caps: { hands_config: semitonesHands },
      analyzer: () => analysis(),
      file: { blob_path: 'fake/path' }
    });
    const r = await validateRoutingFeasibility(app, {
      fileId: 1, deviceId: 'piano-1', channel: 0
    });
    expect(r.level).toBe('ok');
    expect(r.qualityScore).toBe(100);
    expect(r.summary.mode).toBe('semitones');
  });

  test('returns level=infeasible when polyphony exceeds the finger budget', async () => {
    const app = makeApp({
      caps: { hands_config: semitonesHands },
      analyzer: () => analysis({ polyphonyMax: 12 }),
      file: { blob_path: 'fake' }
    });
    const r = await validateRoutingFeasibility(app, {
      fileId: 1, deviceId: 'piano-1', channel: 0
    });
    expect(r.level).toBe('infeasible');
    expect(r.message).toMatch(/finger/);
  });

  test('honours targetChannel when provided', async () => {
    const getCaps = jest.fn(() => ({ hands_config: semitonesHands }));
    const app = {
      logger: silentLogger,
      instrumentRepository: { getCapabilities: getCaps },
      adaptationService: { analyzeChannel: () => analysis() },
      fileRepository: { findById: () => ({ blob_path: 'f' }) },
      blobStore: { read: () => Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96]) }
    };
    await validateRoutingFeasibility(app, {
      fileId: 1, deviceId: 'piano-1', channel: 3, targetChannel: 7
    });
    expect(getCaps).toHaveBeenCalledWith('piano-1', 7);
  });
});

describe('validate_routing_feasibility — degraded paths', () => {
  test('returns level=unknown when the instrument has no capabilities row', async () => {
    const app = makeApp({ caps: null, analyzer: () => analysis() });
    const r = await validateRoutingFeasibility(app, {
      fileId: 1, deviceId: 'unknown', channel: 0
    });
    expect(r.level).toBe('unknown');
    expect(r.message).toMatch(/No capabilities found/);
  });

  test('returns level=unknown when the file is missing', async () => {
    const app = makeApp({
      caps: { hands_config: semitonesHands },
      analyzer: () => analysis(),
      file: null
    });
    const r = await validateRoutingFeasibility(app, {
      fileId: 999, deviceId: 'piano-1', channel: 0
    });
    expect(r.level).toBe('unknown');
  });

  test('returns level=unknown when the blob read throws', async () => {
    const app = makeApp({
      caps: { hands_config: semitonesHands },
      analyzer: () => analysis(),
      file: { blob_path: 'fake' },
      blobThrows: true
    });
    const r = await validateRoutingFeasibility(app, {
      fileId: 1, deviceId: 'piano-1', channel: 0
    });
    expect(r.level).toBe('unknown');
  });

  test('returns level=unknown when the analyzer throws', async () => {
    const app = makeApp({
      caps: { hands_config: semitonesHands },
      analyzer: () => { throw new Error('analyzer down'); },
      file: { blob_path: 'fake' }
    });
    const r = await validateRoutingFeasibility(app, {
      fileId: 1, deviceId: 'piano-1', channel: 0
    });
    expect(r.level).toBe('unknown');
  });

  test('returns level=unknown when the instrument has no hands_config (instrument exists but no profile)', async () => {
    const app = makeApp({
      caps: { hands_config: null, gm_program: 0 },
      analyzer: () => analysis(),
      file: { blob_path: 'fake' }
    });
    const r = await validateRoutingFeasibility(app, {
      fileId: 1, deviceId: 'piano-1', channel: 0
    });
    expect(r.level).toBe('unknown');
  });
});
