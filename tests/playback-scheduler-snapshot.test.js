import { describe, test, expect, jest } from '@jest/globals';
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';
import { PlaybackSnapshot } from '../src/midi/playback/PlaybackSnapshot.js';

function makeDeps() {
  return {
    logger: {
      _levelNum: 1,
      info() {},
      warn() {},
      debug() {},
      error() {},
      isDebugEnabled() {
        return false;
      },
      isWarnEnabled() {
        return true;
      },
      isInfoEnabled() {
        return true;
      }
    },
    database: {},
    eventBus: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
    deviceManager: { sendMessage: jest.fn(() => true), getDeviceList: () => [] },
    compensationService: {
      _delay: 10,
      calls: 0,
      getDelay() {
        this.calls++;
        return this._delay;
      }
    },
    capabilityResolver: {
      _stringCC: false,
      _timing: { minNoteInterval: null, minNoteDuration: null, polyphony: null },
      calls: { stringCC: 0, timing: 0 },
      isStringCCAllowed() {
        this.calls.stringCC++;
        return this._stringCC;
      },
      getTimingConstraints() {
        this.calls.timing++;
        return this._timing;
      }
    }
  };
}

describe('PlaybackScheduler — snapshot integration', () => {
  test('without snapshot: _getSyncDelay calls compensationService each time', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    scheduler._getSyncDelay('dev-1', 0);
    scheduler._getSyncDelay('dev-1', 0);
    expect(deps.compensationService.calls).toBe(2);
  });

  test('with snapshot: _getSyncDelay reads through snapshot cache', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const snap = new PlaybackSnapshot({
      compensationService: deps.compensationService,
      capabilityResolver: deps.capabilityResolver
    });
    scheduler.setSnapshot(snap);

    expect(scheduler._getSyncDelay('dev-1', 0)).toBe(10);
    expect(scheduler._getSyncDelay('dev-1', 0)).toBe(10);
    expect(scheduler._getSyncDelay('dev-1', 0)).toBe(10);
    // First lookup hits the service once via the snapshot; subsequent
    // lookups are served from the snapshot's frozen cache.
    expect(deps.compensationService.calls).toBe(1);
  });

  test('snapshot insulates from mid-playback mutation', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const snap = new PlaybackSnapshot({
      compensationService: deps.compensationService,
      capabilityResolver: deps.capabilityResolver
    });
    scheduler.setSnapshot(snap);

    expect(scheduler._getSyncDelay('dev-1', 0)).toBe(10);
    // Service value changes (e.g. UI updated sync_delay) ...
    deps.compensationService._delay = 999;
    // ... scheduler still sees the original.
    expect(scheduler._getSyncDelay('dev-1', 0)).toBe(10);
  });

  test('clearSnapshot reverts to live service lookups', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const snap = new PlaybackSnapshot({
      compensationService: deps.compensationService,
      capabilityResolver: deps.capabilityResolver
    });
    scheduler.setSnapshot(snap);
    scheduler._getSyncDelay('dev-1', 0); // 10, cached in snapshot

    deps.compensationService._delay = 42;
    scheduler.clearSnapshot();
    expect(scheduler._getSyncDelay('dev-1', 0)).toBe(42);
  });

  test('snapshot path used for timing constraints and stringCC', () => {
    const deps = makeDeps();
    deps.capabilityResolver._stringCC = true;
    deps.capabilityResolver._timing = { minNoteInterval: 100, minNoteDuration: 20, polyphony: 2 };
    const scheduler = new PlaybackScheduler(deps);
    const snap = new PlaybackSnapshot({
      compensationService: deps.compensationService,
      capabilityResolver: deps.capabilityResolver
    });
    scheduler.setSnapshot(snap);
    expect(scheduler._isStringCCAllowed('dev-1', 0)).toBe(true);
    expect(scheduler._isStringCCAllowed('dev-1', 0)).toBe(true);
    expect(scheduler._getTimingConstraints('dev-1', 0).minNoteInterval).toBe(100);
    // Each via the resolver only on first hit.
    expect(deps.capabilityResolver.calls.stringCC).toBe(1);
    expect(deps.capabilityResolver.calls.timing).toBe(1);
  });
});
