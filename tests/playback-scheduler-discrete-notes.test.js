// tests/playback-scheduler-discrete-notes.test.js
// Discrete instruments (kalimba/handpan/tuned percussion) declare a
// `selectedNotes` set — the only pitches they can physically produce. A played
// note off that set must be snapped to the nearest available pitch rather than
// sent verbatim (unplayable). Drum channel is exempt.

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
    channelRouting: new Map(),
    channelTransposition: new Map(),
    channelNoteRemapping: new Map(),
    mutedChannels: new Set(),
    disconnectedPolicy: 'skip'
  };
}
function withSelected(scheduler, selectedNotes) {
  scheduler._snapshot = {
    getTimingConstraints: () => ({
      minNoteInterval: null,
      minNoteDuration: null,
      polyphony: null,
      noteRangeMin: null,
      noteRangeMax: null,
      selectedNotes
    }),
    isStringCCAllowed: () => false
  };
}

describe('PlaybackScheduler — discrete note snapping', () => {
  test('snaps an off-set note to the nearest available pitch', () => {
    const app = makeApp();
    const s = new PlaybackScheduler(app);
    withSelected(s, [60, 62, 64, 67, 69]); // C major pentatonic
    s.sendEvent(
      { type: 'noteOn', channel: 0, note: 61, velocity: 100 },
      makeState(),
      () => ({ device: 'kalimba', targetChannel: 0 }),
      {}
    );
    // 61 is equidistant to 60 and 62 → tie breaks downward → 60.
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'kalimba',
      'noteon',
      expect.objectContaining({ note: 60 })
    );
  });

  test('leaves an available note untouched', () => {
    const app = makeApp();
    const s = new PlaybackScheduler(app);
    withSelected(s, [60, 62, 64, 67, 69]);
    s.sendEvent(
      { type: 'noteOn', channel: 0, note: 67, velocity: 100 },
      makeState(),
      () => ({ device: 'kalimba', targetChannel: 0 }),
      {}
    );
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'kalimba',
      'noteon',
      expect.objectContaining({ note: 67 })
    );
  });

  test('does not snap the GM drum channel (9)', () => {
    const app = makeApp();
    const s = new PlaybackScheduler(app);
    withSelected(s, [60, 62, 64]);
    s.sendEvent(
      { type: 'noteOn', channel: 9, note: 38, velocity: 100 },
      makeState(),
      () => ({ device: 'drum', targetChannel: 9 }),
      {}
    );
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'drum',
      'noteon',
      expect.objectContaining({ note: 38 })
    );
  });

  test('_snapToSelected picks the nearest, ties downward', () => {
    const s = new PlaybackScheduler(makeApp());
    expect(s._snapToSelected(70, [60, 72])).toBe(72);
    expect(s._snapToSelected(66, [60, 72])).toBe(60); // tie → lower
  });
});
