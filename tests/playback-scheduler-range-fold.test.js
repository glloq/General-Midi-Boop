// tests/playback-scheduler-range-fold.test.js
// A note outside the instrument's declared playable range must be folded by
// octaves into range (pitch-class preserving) before it is sent, so an
// instrument that physically cannot produce the pitch never receives it
// verbatim (audit P1 — no range clamp by default). The GM drum channel is
// exempt, and instruments with no declared range are untouched.

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

// Inject a snapshot so the scheduler resolves a fixed note range.
function withRange(scheduler, min, max) {
  scheduler._snapshot = {
    getTimingConstraints: () => ({
      minNoteInterval: null,
      minNoteDuration: null,
      polyphony: null,
      noteRangeMin: min,
      noteRangeMax: max
    }),
    isStringCCAllowed: () => false
  };
}

describe('PlaybackScheduler — note range folding', () => {
  test('folds a too-high note down by octaves into range', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withRange(scheduler, 60, 72); // C4..C5
    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 84, velocity: 100 }, // C6
      makeState(),
      () => ({ device: 'dev', targetChannel: 0 }),
      {}
    );
    // 84 → 72 (C5), same pitch class, within range.
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'dev',
      'noteon',
      expect.objectContaining({ note: 72 })
    );
  });

  test('folds a too-low note up into range', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withRange(scheduler, 60, 72);
    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 48, velocity: 100 }, // C3
      makeState(),
      () => ({ device: 'dev', targetChannel: 0 }),
      {}
    );
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'dev',
      'noteon',
      expect.objectContaining({ note: 60 })
    );
  });

  test('leaves in-range notes untouched', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withRange(scheduler, 60, 72);
    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 65, velocity: 100 },
      makeState(),
      () => ({ device: 'dev', targetChannel: 0 }),
      {}
    );
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'dev',
      'noteon',
      expect.objectContaining({ note: 65 })
    );
  });

  test('does not fold the GM drum channel (9)', () => {
    const app = makeApp();
    const scheduler = new PlaybackScheduler(app);
    withRange(scheduler, 60, 72);
    scheduler.sendEvent(
      { type: 'noteOn', channel: 9, note: 35, velocity: 100 }, // kick, out of "range"
      makeState(),
      () => ({ device: 'drum', targetChannel: 9 }),
      {}
    );
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'drum',
      'noteon',
      expect.objectContaining({ note: 35 })
    );
  });

  test('_foldIntoRange clamps when range is narrower than an octave', () => {
    const scheduler = new PlaybackScheduler(makeApp());
    // range 60..64 (< octave); note 70 → 58 (fold) → clamp up to 60.
    expect(scheduler._foldIntoRange(70, 60, 64)).toBeGreaterThanOrEqual(60);
    expect(scheduler._foldIntoRange(70, 60, 64)).toBeLessThanOrEqual(64);
  });
});
