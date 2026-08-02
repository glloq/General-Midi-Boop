// tests/playback-scheduler-note-remapping.test.js
// Per-channel note remapping (e.g. GM drum substitution) is applied at
// runtime — after transposition — just before the device send, so it works
// even when playing the ORIGINAL file with no baked adapted copy. The same
// deterministic map is applied to the matching noteOff so the device sees a
// consistent on/off pair.

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

function makeState({ transposition = new Map(), remapping = new Map() } = {}) {
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
    channelTransposition: transposition,
    channelNoteRemapping: remapping,
    mutedChannels: new Set(),
    disconnectedPolicy: 'skip'
  };
}

describe('PlaybackScheduler — note remapping', () => {
  test('remaps a noteOn pitch per the channel map', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    // GM drum: 38 (acoustic snare) → 40 (electric snare).
    const state = makeState({ remapping: new Map([[9, { 38: 40 }]]) });
    const routing = { device: 'drum', targetChannel: 9 };

    scheduler.sendEvent(
      { type: 'noteOn', channel: 9, note: 38, velocity: 100 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('drum', 'noteon', {
      channel: 9,
      note: 40,
      velocity: 100
    });
  });

  test('mirrors the remap on the matching noteOff', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState({ remapping: new Map([[9, { 38: 40 }]]) });
    const routing = { device: 'drum', targetChannel: 9 };

    scheduler.sendEvent(
      { type: 'noteOff', channel: 9, note: 38, velocity: 0 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('drum', 'noteoff', {
      channel: 9,
      note: 40,
      velocity: 0
    });
  });

  test('applies remapping AFTER transposition (map keyed on the transposed note)', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    // Transpose +2 (60 → 62), then remap 62 → 70.
    const state = makeState({
      transposition: new Map([[0, 2]]),
      remapping: new Map([[0, { 62: 70 }]])
    });
    const routing = { device: 'dev', targetChannel: 0 };

    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 60, velocity: 90 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('dev', 'noteon', {
      channel: 0,
      note: 70,
      velocity: 90
    });
  });

  test('leaves notes without a mapping entry untouched', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState({ remapping: new Map([[9, { 38: 40 }]]) });
    const routing = { device: 'drum', targetChannel: 9 };

    scheduler.sendEvent(
      { type: 'noteOn', channel: 9, note: 36, velocity: 100 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('drum', 'noteon', {
      channel: 9,
      note: 36,
      velocity: 100
    });
  });

  test('no remapping map at all leaves pitches intact', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    const state = makeState();
    delete state.channelNoteRemapping; // defensive: absent field
    const routing = { device: 'dev', targetChannel: 0 };

    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 60, velocity: 100 },
      state,
      () => routing,
      {}
    );

    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith('dev', 'noteon', {
      channel: 0,
      note: 60,
      velocity: 100
    });
  });
});
