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
          'specific-device',
          'cc',
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

describe('PlaybackScheduler — velocity-0 note-on routes as a note-off (audit axis6-1)', () => {
  test('a velocity-0 note-on is passed to routing as "noteOff", not "noteOn"', (done) => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState();
    state.channelRouting.set(0, { device: 'd', targetChannel: 0 });

    const getOutputForChannel = jest.fn(() => ({ device: 'd', targetChannel: 0 }));
    // Running-status note-off: a note-on with velocity 0.
    const event = { time: 0.001, type: 'noteOn', channel: 0, note: 60, velocity: 0 };

    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    setTimeout(() => {
      try {
        expect(getOutputForChannel).toHaveBeenCalledWith(0, 60, 'noteOff');
        scheduler.stopScheduler();
        done();
      } catch (e) {
        scheduler.stopScheduler();
        done(e);
      }
    }, 50);
  });

  test('a real note-on (velocity > 0) is still passed as "noteOn"', (done) => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState();
    state.channelRouting.set(0, { device: 'd', targetChannel: 0 });

    const getOutputForChannel = jest.fn(() => ({ device: 'd', targetChannel: 0 }));
    const event = { time: 0.001, type: 'noteOn', channel: 0, note: 60, velocity: 100 };

    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});

    setTimeout(() => {
      try {
        expect(getOutputForChannel).toHaveBeenCalledWith(0, 60, 'noteOn');
        scheduler.stopScheduler();
        done();
      } catch (e) {
        scheduler.stopScheduler();
        done(e);
      }
    }, 50);
  });
});

describe('PlaybackScheduler — controller reset on backward seek/loop (audit axis6-4)', () => {
  test('resetControllers sends Reset-All-Controllers (CC121) to each routed channel', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const channelRouting = new Map([[0, { device: 'd', targetChannel: 2 }]]);

    scheduler.resetControllers('out', channelRouting, [], null);

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('d', 'cc', {
      channel: 2,
      controller: 121,
      value: 0
    });
  });

  test('sendAllNotesOff still sends All-Notes-Off (CC123) after the _broadcastCC refactor', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const channelRouting = new Map([[0, { device: 'd', targetChannel: 0 }]]);

    scheduler.sendAllNotesOff('out', channelRouting, [], null);

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('d', 'cc', {
      channel: 0,
      controller: 123,
      value: 0
    });
  });
});

describe('PlaybackScheduler — deferred note-off is bound to its note instance (audit axis6-5)', () => {
  test('a deferred note-off is skipped when the pitch was re-struck before it fires', (done) => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    scheduler._noteOffDeferMs = () => 40; // force a real deferral
    const sends = [];
    scheduler._send = (deviceId, type, data) => {
      sends.push({ deviceId, type, data });
      return { status: 'sent' };
    };

    const key = 'd:0:60';
    scheduler._noteInstance.set(key, 1);
    scheduler._sendNoteOff('d', 0, 60, 0); // captures instance 1, defers
    scheduler._noteInstance.set(key, 2); // retrigger → new instance supersedes it

    setTimeout(() => {
      try {
        expect(sends).toHaveLength(0); // stale release must NOT have fired
        scheduler.stopScheduler();
        done();
      } catch (e) {
        scheduler.stopScheduler();
        done(e);
      }
    }, 90);
  });

  test('a deferred note-off fires normally when the pitch is not re-struck', (done) => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    scheduler._noteOffDeferMs = () => 40;
    const sends = [];
    scheduler._send = (deviceId, type, data) => {
      sends.push({ deviceId, type, data });
      return { status: 'sent' };
    };

    scheduler._noteInstance.set('d:0:60', 1);
    scheduler._sendNoteOff('d', 0, 60, 0); // not re-struck

    setTimeout(() => {
      try {
        expect(sends).toHaveLength(1);
        scheduler.stopScheduler();
        done();
      } catch (e) {
        scheduler.stopScheduler();
        done(e);
      }
    }, 90);
  });
});
