// tests/playback-scheduler-split-disconnect.test.js
// The split / broadcast send path (_sendEventToRouting) must apply the
// disconnect policy just like the main sendEvent path. Previously it ignored
// the dispatch result, so a disconnected split segment went undetected and
// the pause/mute/skip policy never fired (audit P2).

import { describe, test, expect, jest } from '@jest/globals';
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';

function makeApp(sendOk) {
  return {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    database: null,
    eventBus: { on: () => {} },
    wsServer: { broadcast: jest.fn() },
    // Boolean sendMessage → _send maps false to DISCONNECTED.
    deviceManager: { sendMessage: jest.fn(() => sendOk) }
  };
}

function makeState(policy = 'skip') {
  return {
    playing: true,
    channelRouting: new Map(),
    channelTransposition: new Map(),
    channelNoteRemapping: new Map(),
    mutedChannels: new Set(),
    disconnectedPolicy: policy
  };
}

const ccEvent = { type: 'controller', channel: 0, controller: 7, value: 100 };

describe('PlaybackScheduler — split-segment disconnect', () => {
  test('detects a dead split segment and broadcasts an error (skip policy)', () => {
    const app = makeApp(false); // send fails → DISCONNECTED
    const scheduler = new PlaybackScheduler(app);
    const state = makeState('skip');

    scheduler._sendEventToRouting(ccEvent, { device: 'devDead', targetChannel: 0 }, state, {});

    expect(scheduler._failedDevices.has('devDead')).toBe(true);
    expect(app.wsServer.broadcast).toHaveBeenCalledWith(
      'playback_device_error',
      expect.objectContaining({ deviceId: 'devDead' })
    );
  });

  test('pause policy invokes the onPause callback threaded through the split path', () => {
    const app = makeApp(false);
    const scheduler = new PlaybackScheduler(app);
    const state = makeState('pause');
    const onPause = jest.fn();

    scheduler._sendEventToRouting(ccEvent, { device: 'devDead', targetChannel: 0 }, state, { onPause });

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(app.wsServer.broadcast).toHaveBeenCalledWith(
      'playback_device_disconnected',
      expect.objectContaining({ deviceId: 'devDead', policy: 'pause' })
    );
  });

  test('a healthy split segment triggers no disconnect handling', () => {
    const app = makeApp(true); // send succeeds
    const scheduler = new PlaybackScheduler(app);
    const state = makeState('skip');

    scheduler._sendEventToRouting(ccEvent, { device: 'devOk', targetChannel: 0 }, state, {});

    expect(scheduler._failedDevices.has('devOk')).toBe(false);
    expect(app.wsServer.broadcast).not.toHaveBeenCalled();
  });
});
