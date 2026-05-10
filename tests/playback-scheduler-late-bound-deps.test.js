/**
 * @file tests/playback-scheduler-late-bound-deps.test.js
 * @description Regression guard for AUDIT 2026-05-10 §12. PlaybackScheduler
 * is constructed inside MidiPlayer (which itself runs in Application
 * .initialize() before compensationService / capabilityResolver / wsServer
 * are registered). The scheduler must therefore re-resolve those deps on
 * each access rather than capturing them eagerly — otherwise it freezes a
 * `null` reference and silently disables every consumer.
 */
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';

describe('PlaybackScheduler late-bound deps (#12)', () => {
  const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

  function makeDeps() {
    const eventBus = { on() {}, off() {}, emit() {} };
    return {
      logger: noopLogger,
      database: {},
      eventBus,
      deviceManager: {},
      // The four late-bound deps are deliberately absent at construction
      // time, just like during real boot.
      // wsServer: undefined
      // compensationService: undefined
      // capabilityResolver: undefined
      // eventLoopMonitor: undefined
    };
  }

  test('reflects compensationService injected AFTER construction', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    expect(scheduler.compensationService).toBeNull();

    const compensationService = { getDelay: () => 0, invalidate() {} };
    deps.compensationService = compensationService;

    expect(scheduler.compensationService).toBe(compensationService);
  });

  test('reflects capabilityResolver / wsServer / eventLoopMonitor injected later', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);

    expect(scheduler.capabilityResolver).toBeNull();
    expect(scheduler.wsServer).toBeNull();
    expect(scheduler.eventLoopMonitor).toBeNull();

    deps.capabilityResolver = { isStringCCAllowed: () => true };
    deps.wsServer = { broadcast() {} };
    deps.eventLoopMonitor = { currentLag: 0 };

    expect(scheduler.capabilityResolver).toBe(deps.capabilityResolver);
    expect(scheduler.wsServer).toBe(deps.wsServer);
    expect(scheduler.eventLoopMonitor).toBe(deps.eventLoopMonitor);
  });

  test('eager-captured deps stay stable (deviceManager, midiClockGenerator)', () => {
    const deps = makeDeps();
    const deviceManager = deps.deviceManager;
    const scheduler = new PlaybackScheduler(deps);

    // Replacing deps.deviceManager after construction must NOT change the
    // scheduler's reference: the dep was guaranteed to exist before MidiPlayer
    // builds the scheduler, so it's intentionally frozen.
    deps.deviceManager = { somethingElse: true };
    expect(scheduler.deviceManager).toBe(deviceManager);
  });
});
