// tests/services/generate-suggestions-concurrency.test.js
//
// Guards the concurrency contract of `generate_assignment_suggestions`
// after two perf changes:
//   - the channel × instrument scoring loop now yields cooperatively
//     (AutoAssigner), so the handler can be re-entered mid-compute;
//   - responses are cached.
// `applyScoringOverrides` mutates the GLOBAL ScoringConfig singleton, so
// the apply→compute→restore section MUST run exclusively, and concurrent
// identical requests must collapse onto a single compute via the cache.

import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { register } from '../../src/midi/playback/commands/PlaybackAnalysisCommands.js';
import ScoringConfig from '../../src/midi/adaptation/ScoringConfig.js';
import { SuggestionCacheService } from '../../src/midi/adaptation/SuggestionCacheService.js';

// Smallest valid Standard MIDI File: header + one empty track.
const MIN_MIDI = Buffer.from([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
  0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x04,
  0x00, 0xff, 0x2f, 0x00
]);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function buildApp() {
  const calls = [];
  const gates = [];
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const eventBus = { on: jest.fn() };
  const app = {
    logger,
    eventBus,
    suggestionCache: new SuggestionCacheService({ logger, eventBus }),
    fileRepository: { findById: () => ({ id: 1, content_hash: 'h1', blob_path: 'p1' }) },
    blobStore: { read: () => MIN_MIDI },
    instrumentRepository: { getCatalogFingerprint: () => 'cf1' },
    adaptationService: {
      generateSuggestions: jest.fn(() => {
        const g = deferred();
        gates.push(g);
        // Snapshot the GLOBAL scoring weight visible to THIS compute.
        calls.push({ noteRangeAtCompute: ScoringConfig.weights.noteRange });
        return g.promise.then(() => ({
          success: true,
          suggestions: {},
          lowScoreSuggestions: {},
          autoSelection: {},
          splitProposals: {},
          channelAnalyses: [],
          confidenceScore: 0,
          allInstruments: [],
          stats: {}
        }));
      })
    }
  };
  const handlers = {};
  register({ register: (name, fn) => { handlers[name] = fn; } }, app);
  return { app, handlers, calls, gates };
}

const ORIGINAL_NOTE_RANGE = ScoringConfig.weights.noteRange;

afterEach(() => {
  ScoringConfig.weights.noteRange = ORIGINAL_NOTE_RANGE;
});

const flush = () => new Promise((r) => setImmediate(r));

describe('generate_assignment_suggestions concurrency', () => {
  test('serialises the global-scoring critical section across concurrent requests', async () => {
    const { handlers, calls, gates } = buildApp();
    const h = handlers.generate_assignment_suggestions;

    // Two concurrent requests with DIFFERENT overrides (distinct cache
    // keys ⇒ no dedupe; both must actually compute, but not at once).
    const p1 = h({ fileId: 1, scoringOverrides: { weights: { noteRange: 11 } } });
    const p2 = h({ fileId: 1, scoringOverrides: { weights: { noteRange: 22 } } });

    await flush();
    // Only the first compute may have started; the second is queued
    // behind the lock.
    expect(calls.length).toBe(1);
    expect(calls[0].noteRangeAtCompute).toBe(11);

    // Finish request 1; request 2 is then dequeued and computes under
    // ITS OWN override — never under request 1's (no global leak/corruption).
    gates[0].resolve();
    await p1;
    await flush();
    expect(calls.length).toBe(2);
    expect(calls[1].noteRangeAtCompute).toBe(22);

    gates[1].resolve();
    await p2;

    // Both request-scoped overrides fully unwound afterwards.
    expect(ScoringConfig.weights.noteRange).toBe(ORIGINAL_NOTE_RANGE);
  });

  test('concurrent identical requests collapse onto a single compute (cache)', async () => {
    const { handlers, calls, gates } = buildApp();
    const h = handlers.generate_assignment_suggestions;

    const args = { fileId: 1, scoringOverrides: { weights: { noteRange: 33 } } };
    const p1 = h({ ...args });
    const p2 = h({ ...args });

    await flush();
    expect(calls.length).toBe(1); // p2 queued behind the lock

    gates[0].resolve();
    const r1 = await p1;
    await flush();
    const r2 = await p2;

    // p2 was served from the cache filled by p1 — compute ran once.
    expect(calls.length).toBe(1);
    expect(r1.success).toBe(true);
    expect(r2).toBe(r1);
  });
});
