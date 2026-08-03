// tests/playback-scheduler-hand-shift.test.js
// Opt-in hand-shift compensation: when enabled, a note-on whose actuator shift
// the planner flagged `move_too_fast` is dispatched early by the shortfall
// (requiredMs - availableMs). Default-off and non-matching events are untouched.

import { describe, test, expect } from '@jest/globals';
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';
import LatencyCompensator from '../src/midi/adaptation/LatencyCompensator.js';

// shiftExtraMs is pure (never touches `this`), so the real implementation can
// stand in as the scheduler's latencyCompensator without a full instance.
const latencyStub = { shiftExtraMs: LatencyCompensator.prototype.shiftExtraMs };

function makeScheduler(handShiftCompensation) {
  return new PlaybackScheduler({
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    database: null,
    eventBus: { on() {} },
    deviceManager: {
      sendMessage() {
        return true;
      }
    },
    latencyCompensator: latencyStub,
    config: { get: (k, d) => (k === 'playback.handShiftCompensation' ? handShiftCompensation : d) }
  });
}

// One impossible shift at t=2.0s on channel 0: needs 120ms, only 40 available.
const WARNINGS = [
  { code: 'move_too_fast', time: 2.0, channel: 0, requiredMs: 120, availableMs: 40 }
];

describe('PlaybackScheduler — hand-shift compensation', () => {
  test('disabled by default: no warnings retained, no shift', () => {
    const s = makeScheduler(false);
    s.setHandWarnings(WARNINGS);
    expect(s._handShiftEnabled).toBe(false);
    expect(s._handWarnings).toBeNull();
    expect(s._maxHandShiftMs).toBe(0);
    expect(s._handShiftMsFor({ type: 'noteOn', time: 2.0, channel: 0 })).toBe(0);
  });

  test('enabled: retains warnings and caches the max shortfall', () => {
    const s = makeScheduler(true);
    s.setHandWarnings(WARNINGS);
    expect(s._handShiftEnabled).toBe(true);
    expect(s._maxHandShiftMs).toBe(80); // 120 - 40
  });

  test('enabled: a matching note-on gets the shortfall (fires early)', () => {
    const s = makeScheduler(true);
    s.setHandWarnings(WARNINGS);
    expect(s._handShiftMsFor({ type: 'noteOn', time: 2.0, channel: 0 })).toBe(80);
  });

  test('note-off never gets compensation', () => {
    const s = makeScheduler(true);
    s.setHandWarnings(WARNINGS);
    expect(s._handShiftMsFor({ type: 'noteOff', time: 2.0, channel: 0 })).toBe(0);
  });

  test('a note-on on a different channel or time is untouched', () => {
    const s = makeScheduler(true);
    s.setHandWarnings(WARNINGS);
    expect(s._handShiftMsFor({ type: 'noteOn', time: 2.0, channel: 1 })).toBe(0);
    expect(s._handShiftMsFor({ type: 'noteOn', time: 5.0, channel: 0 })).toBe(0);
  });

  test('resetForPlayback clears retained warnings', () => {
    const s = makeScheduler(true);
    s.setHandWarnings(WARNINGS);
    s.resetForPlayback();
    expect(s._handWarnings).toBeNull();
    expect(s._maxHandShiftMs).toBe(0);
  });

  test('empty/null warnings disable the feature even when configured on', () => {
    const s = makeScheduler(true);
    s.setHandWarnings([]);
    expect(s._handWarnings).toBeNull();
    expect(s._handShiftMsFor({ type: 'noteOn', time: 2.0, channel: 0 })).toBe(0);
  });
});
