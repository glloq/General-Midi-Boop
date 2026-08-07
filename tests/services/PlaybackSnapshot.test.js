import { describe, test, expect } from '@jest/globals';
import { PlaybackSnapshot } from '../../src/midi/playback/PlaybackSnapshot.js';

function makeResolver(initial = {}) {
  let stringCC = new Map(Object.entries(initial.stringCC || {}));
  let timing = new Map(Object.entries(initial.timing || {}));
  return {
    calls: { stringCC: 0, timing: 0 },
    isStringCCAllowed(device, channel) {
      this.calls.stringCC++;
      const v = stringCC.get(`${device}:${channel}`);
      return v === undefined ? false : v;
    },
    getTimingConstraints(device, channel) {
      this.calls.timing++;
      return (
        timing.get(`${device}:${channel}`) || {
          minNoteInterval: null,
          minNoteDuration: null,
          polyphony: null
        }
      );
    },
    // Mutators (these would normally be triggered by DB writes).
    setStringCC(device, channel, v) {
      stringCC.set(`${device}:${channel}`, v);
    },
    setTiming(device, channel, v) {
      timing.set(`${device}:${channel}`, v);
    }
  };
}

function makeCompensation(initial = {}) {
  let comp = new Map(Object.entries(initial));
  return {
    calls: 0,
    getDelay(device, channel) {
      this.calls++;
      const v = comp.get(channel !== undefined ? `${device}:${channel}` : device);
      return v ?? 0;
    },
    setDelay(device, channel, v) {
      comp.set(channel !== undefined ? `${device}:${channel}` : device, v);
    }
  };
}

describe('PlaybackSnapshot', () => {
  describe('lookup forwarding', () => {
    test('first lookup hits the underlying resolver', () => {
      const resolver = makeResolver({ stringCC: { 'dev-1:0': true } });
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      expect(snap.isStringCCAllowed('dev-1', 0)).toBe(true);
      expect(resolver.calls.stringCC).toBe(1);
    });

    test('subsequent lookups use the cache (no resolver hit)', () => {
      const resolver = makeResolver({ stringCC: { 'dev-1:0': true } });
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      snap.isStringCCAllowed('dev-1', 0);
      snap.isStringCCAllowed('dev-1', 0);
      snap.isStringCCAllowed('dev-1', 0);
      expect(resolver.calls.stringCC).toBe(1);
    });

    test('different (device, channel) pairs are cached independently', () => {
      const resolver = makeResolver({
        stringCC: { 'dev-1:0': true, 'dev-1:1': false }
      });
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      expect(snap.isStringCCAllowed('dev-1', 0)).toBe(true);
      expect(snap.isStringCCAllowed('dev-1', 1)).toBe(false);
      expect(resolver.calls.stringCC).toBe(2);
    });

    test('timing constraints frozen after first capture', () => {
      const resolver = makeResolver({
        timing: { 'dev-1:0': { minNoteInterval: 50, minNoteDuration: 10, polyphony: 1 } }
      });
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      const first = snap.getTimingConstraints('dev-1', 0);
      expect(first.minNoteInterval).toBe(50);
      // Mutate the underlying source ...
      resolver.setTiming('dev-1', 0, { minNoteInterval: 999, minNoteDuration: 10, polyphony: 1 });
      // ... snapshot is unaffected.
      expect(snap.getTimingConstraints('dev-1', 0).minNoteInterval).toBe(50);
      expect(resolver.calls.timing).toBe(1);
    });

    test('compensation cached after first lookup', () => {
      const comp = makeCompensation({ 'dev-1:0': 12 });
      const snap = new PlaybackSnapshot({ compensationService: comp });
      expect(snap.getCompensationMs('dev-1', 0)).toBe(12);
      comp.setDelay('dev-1', 0, 999);
      expect(snap.getCompensationMs('dev-1', 0)).toBe(12);
      expect(comp.calls).toBe(1);
    });

    test('compensation accepts device-only key', () => {
      const comp = makeCompensation({ 'dev-1': 7 });
      const snap = new PlaybackSnapshot({ compensationService: comp });
      expect(snap.getCompensationMs('dev-1')).toBe(7);
    });
  });

  describe('fallbacks', () => {
    test('no resolver => isStringCCAllowed returns false', () => {
      const snap = new PlaybackSnapshot({});
      expect(snap.isStringCCAllowed('dev-1', 0)).toBe(false);
    });

    test('no resolver => timing constraints are all null', () => {
      const snap = new PlaybackSnapshot({});
      const tc = snap.getTimingConstraints('dev-1', 0);
      expect(tc).toEqual({
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

    test('no compensation service => 0', () => {
      const snap = new PlaybackSnapshot({});
      expect(snap.getCompensationMs('dev-1', 0)).toBe(0);
    });

    test('non-finite compensation normalised to 0', () => {
      const broken = { getDelay: () => NaN };
      const snap = new PlaybackSnapshot({ compensationService: broken });
      expect(snap.getCompensationMs('dev-1', 0)).toBe(0);
    });
  });

  describe('immutability', () => {
    test('returned constraints object is frozen', () => {
      const resolver = makeResolver({
        timing: { 'dev-1:0': { minNoteInterval: 50, minNoteDuration: 10, polyphony: 1 } }
      });
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      const tc = snap.getTimingConstraints('dev-1', 0);
      expect(() => {
        tc.minNoteInterval = 999;
      }).toThrow(TypeError);
    });
  });

  describe('warmup', () => {
    test('pre-resolves every (device, channel) in a flat routing map', () => {
      const resolver = makeResolver({
        stringCC: { 'dev-A:0': true, 'dev-B:5': false },
        timing: {
          'dev-A:0': { minNoteInterval: 30, minNoteDuration: 5, polyphony: 1 },
          'dev-B:5': { minNoteInterval: null, minNoteDuration: null, polyphony: 6 }
        }
      });
      const comp = makeCompensation({ 'dev-A:0': 7, 'dev-B:5': 12 });
      const snap = new PlaybackSnapshot({
        capabilityResolver: resolver,
        compensationService: comp
      });
      const routing = new Map([
        [0, { device: 'dev-A', targetChannel: 0 }],
        [5, { device: 'dev-B', targetChannel: 5 }]
      ]);
      const warmed = snap.warmup(routing);
      expect(warmed).toBe(2);
      // After warmup the service is never re-hit during real playback.
      const baselineCalls = resolver.calls.stringCC + resolver.calls.timing + comp.calls;
      snap.isStringCCAllowed('dev-A', 0);
      snap.getTimingConstraints('dev-A', 0);
      snap.getCompensationMs('dev-A', 0);
      snap.isStringCCAllowed('dev-B', 5);
      snap.getTimingConstraints('dev-B', 5);
      snap.getCompensationMs('dev-B', 5);
      expect(resolver.calls.stringCC + resolver.calls.timing + comp.calls).toBe(baselineCalls);
    });

    test('walks split routings recursively', () => {
      const resolver = makeResolver({});
      const comp = makeCompensation({});
      const snap = new PlaybackSnapshot({
        capabilityResolver: resolver,
        compensationService: comp
      });
      const routing = new Map([
        [
          0,
          {
            split: true,
            segments: [
              { device: 'dev-A', targetChannel: 0 },
              { device: 'dev-B', targetChannel: 1 }
            ]
          }
        ]
      ]);
      expect(snap.warmup(routing)).toBe(2);
      expect(snap.getStats().comp).toBe(2);
    });

    test('deduplicates repeated (device, channel) pairs', () => {
      const resolver = makeResolver({});
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      const routing = new Map([
        [0, { device: 'dev-A', targetChannel: 0 }],
        [1, { device: 'dev-A', targetChannel: 0 }],
        [2, { device: 'dev-A', targetChannel: 0 }]
      ]);
      expect(snap.warmup(routing)).toBe(1);
    });

    test('skips entries with null device', () => {
      const resolver = makeResolver({});
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      const routing = new Map([
        [0, { device: null, targetChannel: 0 }],
        [1, null],
        [2, { device: 'dev-A', targetChannel: 0 }]
      ]);
      expect(snap.warmup(routing)).toBe(1);
    });

    test('returns 0 for a non-Map argument (defensive)', () => {
      const snap = new PlaybackSnapshot({});
      expect(snap.warmup(null)).toBe(0);
      expect(snap.warmup({})).toBe(0);
      expect(snap.warmup([])).toBe(0);
    });
  });

  describe('lifecycle', () => {
    test('getStats reports cache sizes', () => {
      const resolver = makeResolver({ stringCC: { 'dev-1:0': true } });
      const comp = makeCompensation({ 'dev-1:0': 5 });
      const snap = new PlaybackSnapshot({
        capabilityResolver: resolver,
        compensationService: comp
      });
      snap.isStringCCAllowed('dev-1', 0);
      snap.getTimingConstraints('dev-1', 0);
      snap.getCompensationMs('dev-1', 0);
      expect(snap.getStats()).toEqual({ stringCC: 1, timing: 1, comp: 1 });
    });

    test('destroy() empties internal caches', () => {
      const resolver = makeResolver({ stringCC: { 'dev-1:0': true } });
      const snap = new PlaybackSnapshot({ capabilityResolver: resolver });
      snap.isStringCCAllowed('dev-1', 0);
      snap.destroy();
      expect(snap.getStats()).toEqual({ stringCC: 0, timing: 0, comp: 0 });
    });
  });
});
