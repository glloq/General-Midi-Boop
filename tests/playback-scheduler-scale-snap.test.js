// tests/playback-scheduler-scale-snap.test.js
// A range-mode instrument whose octave_mode restricts it to a diatonic/
// pentatonic scale must have out-of-scale notes snapped to the nearest in-scale
// pitch by the engine — not only when the settings editor materialised the set
// into selected_notes (audit P2-5: octave_mode had no backend consumer).
// Explicit selected_notes keep priority; chromatic mode is a no-op.

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

function withConstraints(scheduler, c) {
  scheduler._snapshot = {
    getTimingConstraints: () => ({
      minNoteInterval: null,
      minNoteDuration: null,
      polyphony: null,
      noteRangeMin: null,
      noteRangeMax: null,
      selectedNotes: null,
      octaveMode: null,
      scaleRoot: 0,
      ...c
    }),
    isStringCCAllowed: () => false
  };
}

function sentNote(app) {
  const call = app.deviceManager.sendMessage.mock.calls.find((a) => a[1] === 'noteon');
  return call ? call[2].note : undefined;
}

function play(scheduler, note) {
  scheduler.sendEvent(
    { type: 'noteOn', channel: 0, note, velocity: 100 },
    makeState(),
    () => ({ device: 'dev', targetChannel: 0 }),
    {}
  );
}

describe('PlaybackScheduler — octave_mode / scale snapping', () => {
  test('diatonic C major snaps an out-of-scale note to the nearest scale tone', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withConstraints(scheduler, {
      noteRangeMin: 60,
      noteRangeMax: 72,
      octaveMode: 'diatonic',
      scaleRoot: 0
    });
    play(scheduler, 61); // C#4: not in C major; equidistant to C(60)/D(62) → ties down → 60
    expect(sentNote(app)).toBe(60);
  });

  test('leaves an in-scale note untouched', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withConstraints(scheduler, {
      noteRangeMin: 60,
      noteRangeMax: 72,
      octaveMode: 'diatonic',
      scaleRoot: 0
    });
    play(scheduler, 65); // F4 — in C major
    expect(sentNote(app)).toBe(65);
  });

  test('range fold happens before the scale snap', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withConstraints(scheduler, {
      noteRangeMin: 60,
      noteRangeMax: 72,
      octaveMode: 'diatonic',
      scaleRoot: 0
    });
    play(scheduler, 85); // C#6 → fold into range → 73>72 so 61 → snap → 60
    expect(sentNote(app)).toBe(60);
  });

  test('explicit selected_notes take priority over octave_mode', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withConstraints(scheduler, {
      noteRangeMin: 60,
      noteRangeMax: 72,
      octaveMode: 'diatonic',
      scaleRoot: 0,
      selectedNotes: [66] // F#, out of C major — but explicit sets win
    });
    play(scheduler, 61);
    expect(sentNote(app)).toBe(66);
  });

  test('chromatic mode does not snap', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withConstraints(scheduler, {
      noteRangeMin: 60,
      noteRangeMax: 72,
      octaveMode: 'chromatic',
      scaleRoot: 0
    });
    play(scheduler, 61);
    expect(sentNote(app)).toBe(61);
  });

  test('no snap when the instrument declares no range', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withConstraints(scheduler, { octaveMode: 'diatonic', scaleRoot: 0 }); // no range
    play(scheduler, 61);
    expect(sentNote(app)).toBe(61);
  });
});
