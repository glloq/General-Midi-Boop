// tests/playback-scheduler-tickless.test.js
// Exercises the tickless emit path introduced in Phase D of the realtime
// refactor. Near-due events fire synchronously from scheduleEvent(),
// while far-due events still go through a single per-event setTimeout.

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';
import { TIMING } from '../src/core/constants.js';

const { EMIT_AHEAD_MS } = TIMING;

function makeDeps() {
  return {
    logger: {
      _levelNum: 1,
      info() {}, warn() {}, debug() {}, error() {},
      isDebugEnabled() { return false; },
      isWarnEnabled() { return true; },
      isInfoEnabled() { return true; }
    },
    database: null,
    eventBus: { on: () => {} },
    wsServer: { broadcast: jest.fn() },
    deviceManager: { sendMessage: jest.fn(() => true) }
  };
}

function makeState(overrides = {}) {
  return {
    playing: true,
    paused: false,
    position: 0,
    duration: 10,
    events: [],
    currentEventIndex: 0,
    startTime: 0,
    playbackRate: 1,
    loop: false,
    channelRouting: new Map(),
    mutedChannels: new Set(),
    disconnectedPolicy: 'skip',
    ...overrides
  };
}

describe('PlaybackScheduler — tickless emit (Phase D)', () => {
  let setTimeoutSpy;
  beforeEach(() => {
    setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
  });
  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  test('event within EMIT_AHEAD window fires synchronously (no setTimeout)', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const state = makeState();
    const routing = { device: 'dev-1', targetChannel: 0 };
    const getOutputForChannel = jest.fn(() => routing);

    const event = { time: 0.002, type: 'controller', channel: 0, controller: 7, value: 100 };
    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    // Synchronous send — no setTimeout scheduled.
    expect(deps.deviceManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(scheduler.pendingTimeouts.size).toBe(0);
  });

  test('event far in the future uses one setTimeout', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const state = makeState();
    const routing = { device: 'dev-1', targetChannel: 0 };
    const getOutputForChannel = jest.fn(() => routing);

    // 50 ms ahead, well above EMIT_AHEAD_MS=5
    const event = { time: 0.05, type: 'controller', channel: 0, controller: 7, value: 50 };
    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    expect(deps.deviceManager.sendMessage).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    // Residual delay (ms) is roughly 50 ms.
    const callArgs = setTimeoutSpy.mock.calls[0];
    expect(callArgs[1]).toBeCloseTo(50, 0);
    expect(scheduler.pendingTimeouts.size).toBe(1);
  });

  test('compensation pulls a far event into the emit window', () => {
    const deps = makeDeps();
    // 60 ms of sync compensation
    deps.compensationService = { getDelay: () => 60 };
    const scheduler = new PlaybackScheduler(deps);
    const state = makeState();
    const routing = { device: 'dev-1', targetChannel: 0 };
    const getOutputForChannel = jest.fn(() => routing);

    // Event 50 ms in the future, but compensation subtracts 60 → fires now.
    const event = { time: 0.05, type: 'controller', channel: 0, controller: 7, value: 50 };
    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    expect(deps.deviceManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test('split routing schedules each segment independently', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const state = makeState();
    const segments = [
      { device: 'dev-A', targetChannel: 0 },
      { device: 'dev-B', targetChannel: 1 }
    ];
    const getOutputForChannel = jest.fn(() => segments);

    const event = { time: 0.001, type: 'controller', channel: 0, controller: 7, value: 50 };
    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    expect(deps.deviceManager.sendMessage).toHaveBeenCalledTimes(2);
    expect(deps.deviceManager.sendMessage).toHaveBeenCalledWith(
      'dev-A', 'cc', expect.objectContaining({ channel: 0 })
    );
    expect(deps.deviceManager.sendMessage).toHaveBeenCalledWith(
      'dev-B', 'cc', expect.objectContaining({ channel: 1 })
    );
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test('_routeTo override hits the tickless fast path', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const state = makeState();
    const getOutputForChannel = jest.fn(() => {
      throw new Error('should not be invoked when _routeTo is set');
    });

    const event = {
      time: 0.002,
      type: 'controller',
      channel: 0,
      controller: 23,
      value: 40,
      _routeTo: { device: 'specific-device', targetChannel: 2 }
    };
    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    expect(deps.deviceManager.sendMessage).toHaveBeenCalledWith(
      'specific-device', 'cc',
      expect.objectContaining({ channel: 2, controller: 23, value: 40 })
    );
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test('EMIT_AHEAD_MS is the boundary: residual just over the threshold uses setTimeout', () => {
    const deps = makeDeps();
    const scheduler = new PlaybackScheduler(deps);
    const state = makeState();
    const routing = { device: 'dev-1', targetChannel: 0 };
    const getOutputForChannel = jest.fn(() => routing);

    // Residual is (EMIT_AHEAD_MS + 1) ms — just outside the fast path.
    const event = { time: (EMIT_AHEAD_MS + 1) / 1000, type: 'controller', channel: 0, controller: 7, value: 1 };
    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(deps.deviceManager.sendMessage).not.toHaveBeenCalled();
  });
});
