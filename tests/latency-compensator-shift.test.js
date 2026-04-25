// tests/latency-compensator-shift.test.js
// Covers the shift-aware additions to LatencyCompensator:
//   - compensateTimestamp now takes an optional extra-latency argument
//     the caller uses to add hand-shift travel time on top of the static
//     device profile.
//   - shiftExtraMs extracts the required shortfall from a list of
//     `move_too_fast` warnings for a given event.

import { describe, test, expect } from '@jest/globals';
import LatencyCompensator from '../src/midi/adaptation/LatencyCompensator.js';

function makeApp() {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    database: {
      getAllLatencyProfiles: () => [],
      saveDeviceLatency: () => {},
      clearDeviceLatency: () => {},
      ensureDevice: () => {}
    },
    deviceManager: { getDeviceList: () => [], getDeviceInfo: () => null, sendMessage: () => {} },
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    wsServer: { broadcast: () => {} }
  };
}

describe('LatencyCompensator.compensateTimestamp — shift-aware', () => {
  test('without extra latency, behaves exactly as before (regression)', () => {
    const lc = new LatencyCompensator(makeApp());
    lc.setLatency('dev-1', 20);
    // 20 ms profile on a 10.000s event → 9.98s
    expect(lc.compensateTimestamp('dev-1', 10)).toBeCloseTo(9.98, 5);
  });

  test('adds extraLatencyMs on top of the device profile', () => {
    const lc = new LatencyCompensator(makeApp());
    lc.setLatency('dev-1', 40);
    // 40 ms profile + 160 ms shift → 200 ms total
    expect(lc.compensateTimestamp('dev-1', 1.0, 160)).toBeCloseTo(0.8, 5);
  });

  test('negative / NaN / undefined extraLatencyMs is ignored (clamped to 0)', () => {
    const lc = new LatencyCompensator(makeApp());
    lc.setLatency('dev-1', 30);
    const base = lc.compensateTimestamp('dev-1', 2.0);
    expect(lc.compensateTimestamp('dev-1', 2.0, -50)).toBe(base);
    expect(lc.compensateTimestamp('dev-1', 2.0, NaN)).toBe(base);
    expect(lc.compensateTimestamp('dev-1', 2.0, undefined)).toBe(base);
  });
});

describe('LatencyCompensator.shiftExtraMs', () => {
  const lc = new LatencyCompensator(makeApp());

  test('returns 0 for empty / non-array input', () => {
    expect(lc.shiftExtraMs(null, 1.0)).toBe(0);
    expect(lc.shiftExtraMs([], 1.0)).toBe(0);
    expect(lc.shiftExtraMs('not an array', 1.0)).toBe(0);
  });

  test('returns 0 when no move_too_fast warning matches the event time', () => {
    const warnings = [
      { code: 'move_too_fast', time: 5.0, requiredMs: 200, availableMs: 50 }
    ];
    expect(lc.shiftExtraMs(warnings, 1.0)).toBe(0);
  });

  test('returns the shortfall (required - available) for a matching warning', () => {
    const warnings = [
      { code: 'move_too_fast', time: 1.0, requiredMs: 200, availableMs: 50 }
    ];
    expect(lc.shiftExtraMs(warnings, 1.0)).toBe(150);
  });

  test('picks the largest shortfall when multiple warnings match', () => {
    const warnings = [
      { code: 'move_too_fast', time: 1.0, requiredMs: 120, availableMs: 40 }, // 80
      { code: 'move_too_fast', time: 1.0, requiredMs: 300, availableMs: 50 }  // 250
    ];
    expect(lc.shiftExtraMs(warnings, 1.0)).toBe(250);
  });

  test('filters warnings by channel when channel is provided', () => {
    const warnings = [
      { code: 'move_too_fast', time: 1.0, channel: 0, requiredMs: 300, availableMs: 50 },
      { code: 'move_too_fast', time: 1.0, channel: 1, requiredMs: 100, availableMs: 10 }
    ];
    expect(lc.shiftExtraMs(warnings, 1.0, 1)).toBe(90);
    expect(lc.shiftExtraMs(warnings, 1.0, 0)).toBe(250);
  });

  test('ignores non-move_too_fast codes', () => {
    const warnings = [
      { code: 'chord_span_exceeded', time: 1.0, spanMm: 200, handMm: 80 },
      { code: 'out_of_range',        time: 1.0 }
    ];
    expect(lc.shiftExtraMs(warnings, 1.0)).toBe(0);
  });

  test('no shortfall (required < available) returns 0', () => {
    const warnings = [
      { code: 'move_too_fast', time: 1.0, requiredMs: 30, availableMs: 100 }
    ];
    expect(lc.shiftExtraMs(warnings, 1.0)).toBe(0);
  });

  test('matches within a 10ms event-time tolerance', () => {
    const warnings = [
      { code: 'move_too_fast', time: 1.0, requiredMs: 200, availableMs: 50 }
    ];
    // Well within 10ms.
    expect(lc.shiftExtraMs(warnings, 1.005)).toBe(150);
    // Just outside 10ms.
    expect(lc.shiftExtraMs(warnings, 1.02)).toBe(0);
  });
});

describe('LatencyCompensator — end-to-end composition', () => {
  test('compensateTimestamp composes with shiftExtraMs from planner warnings', () => {
    const lc = new LatencyCompensator(makeApp());
    lc.setLatency('guitar-1', 25);
    const warnings = [
      { code: 'move_too_fast', time: 4.0, requiredMs: 180, availableMs: 40 }
    ];
    const extra = lc.shiftExtraMs(warnings, 4.0);
    expect(extra).toBe(140);
    // Device 25 ms + shift 140 ms = 165 ms shift back.
    expect(lc.compensateTimestamp('guitar-1', 4.0, extra)).toBeCloseTo(3.835, 5);
  });
});
