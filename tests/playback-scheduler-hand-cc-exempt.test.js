// tests/playback-scheduler-hand-cc-exempt.test.js
// Regression guard for the audit MAJOR finding: the supported_ccs filter must
// NOT drop the instrument's own hand-position control CCs (cc_position_number).
// Otherwise a descriptor-declared supported_ccs like [1,7,11] silently dropped
// the engine's injected/baked hand CCs (e.g. 22/23/24) and the actuator never
// moved, landing notes out of position.

import { describe, test, expect, jest } from '@jest/globals';
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';

function makeScheduler() {
  return new PlaybackScheduler({
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    database: null,
    eventBus: { on: () => {} },
    wsServer: { broadcast: jest.fn() },
    deviceManager: { sendMessage: jest.fn(() => true) }
  });
}

describe('PlaybackScheduler._isCCSupported — hand-position CC exemption', () => {
  const s = makeScheduler();
  const constraints = { supportedCcs: [1, 7, 11], handCcs: [22, 23, 24] };

  test('a declared supported CC passes', () => {
    expect(s._isCCSupported(1, constraints)).toBe(true);
  });

  test('an undeclared musical CC is still dropped', () => {
    expect(s._isCCSupported(5, constraints)).toBe(false);
  });

  test('a hand-position CC passes even though it is NOT in supported_ccs', () => {
    expect(s._isCCSupported(22, constraints)).toBe(true);
    expect(s._isCCSupported(24, constraints)).toBe(true);
  });

  test('safety CCs (>=120) and bank select always pass', () => {
    expect(s._isCCSupported(120, constraints)).toBe(true);
    expect(s._isCCSupported(0, constraints)).toBe(true);
  });

  test('no declared supported_ccs → allow all (no regression)', () => {
    expect(s._isCCSupported(5, { supportedCcs: null, handCcs: null })).toBe(true);
  });

  test('handCcs absent → behaves exactly as before', () => {
    expect(s._isCCSupported(22, { supportedCcs: [1, 7, 11] })).toBe(false);
  });
});
