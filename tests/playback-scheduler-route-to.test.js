// tests/playback-scheduler-route-to.test.js
// Regression test for the _routeTo override path added in Phase 1.5.
// When an event carries `_routeTo: { device, targetChannel }`, the
// scheduler must bypass the generic routing lookup and send the event
// directly to the named destination. This is the mechanism that keeps
// hand-position CCs for one split-routing segment from leaking to the
// other segments' devices.

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

function makeState() {
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
    disconnectedPolicy: 'skip'
  };
}

describe('PlaybackScheduler._routeTo override', () => {
  test('routes the event directly to the named device, bypassing getOutputForChannel', (done) => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState();

    const getOutputForChannel = jest.fn(() => {
      // If the bypass works, this must NOT be called for the _routeTo event.
      throw new Error('getOutputForChannel should not be invoked');
    });

    const event = {
      time: 0.001, // fire quickly
      type: 'controller',
      channel: 0,
      controller: 23,
      value: 40,
      _handInjected: true,
      _routeTo: { device: 'specific-device', targetChannel: 2 }
    };

    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    setTimeout(() => {
      try {
        expect(getOutputForChannel).not.toHaveBeenCalled();
        expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
          'specific-device', 'cc',
          expect.objectContaining({ channel: 2, controller: 23, value: 40 })
        );
        scheduler.stopScheduler();
        done();
      } catch (e) {
        scheduler.stopScheduler();
        done(e);
      }
    }, 50);
  });

  test('events without _routeTo use the normal routing path', (done) => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState();
    state.channelRouting.set(0, { device: 'default-device', targetChannel: 0 });

    const getOutputForChannel = jest.fn(() => ({ device: 'default-device', targetChannel: 0 }));
    const event = {
      time: 0.001,
      type: 'controller',
      channel: 0,
      controller: 7,
      value: 100
    };

    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    setTimeout(() => {
      try {
        expect(getOutputForChannel).toHaveBeenCalled();
        scheduler.stopScheduler();
        done();
      } catch (e) {
        scheduler.stopScheduler();
        done(e);
      }
    }, 50);
  });
});
