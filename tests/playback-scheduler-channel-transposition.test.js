// tests/playback-scheduler-channel-transposition.test.js
// Channel-level transposition is applied at runtime to noteOn/noteOff
// pitches just before the device send, so the operator's transpose
// choice in the routing modal takes effect on the original file
// (no adapted-file generation required).
//
// Routing decisions still operate on the source-note range — the
// split's noteMin/noteMax mirror what the user sees in the modal —
// only the outgoing pitch is shifted.

import { describe, test, expect, jest } from '@jest/globals';
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';

function makeApp() {
  return {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    database: null,
    eventBus: { on: () => {} },
    wsServer: { broadcast: jest.fn() },
    deviceManager: { sendMessage: jest.fn(() => true) }
  };
}

function makeState({ transposition = new Map(), routing = new Map() } = {}) {
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
    channelRouting: routing,
    channelTransposition: transposition,
    mutedChannels: new Set(),
    disconnectedPolicy: 'skip'
  };
}

describe('PlaybackScheduler — channel transposition', () => {
  test('shifts noteOn pitches by the per-channel semitone offset', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState({ transposition: new Map([[0, 5]]) });
    const routing = { device: 'devA', targetChannel: 0 };

    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 60, velocity: 100 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('devA', 'noteon', {
      channel: 0,
      note: 65,
      velocity: 100
    });
  });

  test('mirrors the shift on the matching noteOff so the device receives the pair', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState({ transposition: new Map([[3, -7]]) });
    const routing = { device: 'devB', targetChannel: 4 };

    scheduler.sendEvent(
      { type: 'noteOff', channel: 3, note: 64, velocity: 0 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('devB', 'noteoff', {
      channel: 4,
      note: 57,
      velocity: 0
    });
  });

  test('clamps shifted pitches to [0, 127] so devices never see invalid bytes', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState({ transposition: new Map([[0, 36]]) });
    const routing = { device: 'devA', targetChannel: 0 };

    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 120, velocity: 90 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('devA', 'noteon', {
      channel: 0,
      note: 127,
      velocity: 90
    });
  });

  test('leaves CC and program-change events untouched', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState({ transposition: new Map([[2, 12]]) });
    const routing = { device: 'devA', targetChannel: 2 };

    scheduler.sendEvent(
      { type: 'controller', channel: 2, controller: 7, value: 100 },
      state,
      () => routing,
      {}
    );
    scheduler.sendEvent(
      { type: 'programChange', channel: 2, program: 25 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('devA', 'cc', {
      channel: 2, controller: 7, value: 100
    });
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('devA', 'program', {
      channel: 2, program: 25
    });
  });

  test('zero or missing transposition leaves the original pitch intact', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);

    // No channelTransposition map at all — defensive default.
    const state = makeState({ transposition: new Map() });
    const routing = { device: 'devA', targetChannel: 0 };

    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 60, velocity: 100 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('devA', 'noteon', {
      channel: 0, note: 60, velocity: 100
    });
  });

  test('split path (_sendEventToRouting) applies the same shift', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState({ transposition: new Map([[1, 3]]) });

    scheduler._sendEventToRouting(
      { type: 'noteOn', channel: 1, note: 60, velocity: 110 },
      { device: 'devSplit', targetChannel: 5 },
      state
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('devSplit', 'noteon', {
      channel: 5, note: 63, velocity: 110
    });
  });
});
