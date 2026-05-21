/**
 * @file tests/application-di-late-binding.test.js
 * @description Regression guard for the DI hardening pass (PR 2,
 * docs/audit/ROADMAP_DI_2026-05-21.md). LatencyCompensator and
 * CompensationService each capture a sibling registered only a few
 * lines apart in `Application.initialize()` — `deviceManager` and
 * `latencyCompensator` respectively. The roadmap requires these to be
 * exposed as lazy getters so a future re-ordering of `_registerService`
 * calls cannot silently freeze `undefined` / `null`.
 *
 * Pattern mirrors `tests/playback-scheduler-late-bound-deps.test.js`.
 */
import { describe, test, expect } from '@jest/globals';
import LatencyCompensator from '../src/midi/adaptation/LatencyCompensator.js';
import { CompensationService } from '../src/midi/compensation/CompensationService.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe('LatencyCompensator late-bound deps (DI hardening)', () => {
  function makeDeps() {
    return {
      logger: noopLogger,
      database: {
        getAllLatencyProfiles: () => [],
        saveDeviceLatency: () => {},
        clearDeviceLatency: () => {},
        ensureDevice: () => {}
      },
      eventBus: { on() {}, off() {}, emit() {} }
      // deviceManager and wsServer are deliberately absent at construction.
    };
  }

  test('reflects deviceManager injected AFTER construction', () => {
    const deps = makeDeps();
    const lc = new LatencyCompensator(deps);
    expect(lc.deviceManager).toBeNull();

    const deviceManager = {
      getDeviceList: () => [{ id: 'd1', input: true, output: true }],
      getDeviceInfo: () => null,
      sendMessage: () => {}
    };
    deps.deviceManager = deviceManager;

    expect(lc.deviceManager).toBe(deviceManager);
    // And exercise a method that reads through the getter.
    expect(lc.getRecommendedCalibrations()).toEqual([
      { deviceId: 'd1', reason: 'missing' }
    ]);
  });

  test('reflects wsServer injected AFTER construction', () => {
    const deps = makeDeps();
    const lc = new LatencyCompensator(deps);
    expect(lc.wsServer).toBeNull();

    const wsServer = { broadcast() {} };
    deps.wsServer = wsServer;

    expect(lc.wsServer).toBe(wsServer);
  });
});

describe('CompensationService late-bound latencyCompensator (DI hardening)', () => {
  function makeDeps() {
    return {
      logger: noopLogger,
      database: { getInstrumentSettings: () => ({ sync_delay: 10 }) },
      eventBus: { on() {}, off() {}, emit() {} }
      // latencyCompensator deliberately absent.
    };
  }

  test('_compute uses latencyCompensator registered AFTER construction', () => {
    const deps = makeDeps();
    const svc = new CompensationService(deps);

    // No hardware compensator yet → only sync_delay (10 ms) contributes.
    expect(svc.getDelay('dev-1', 0)).toBe(10);

    // Late-register a compensator returning 25 ms; clear cache and re-query.
    deps.latencyCompensator = { getLatency: () => 25 };
    svc.invalidate();

    expect(svc.getDelay('dev-1', 0)).toBe(35);

    svc.destroy();
  });

  test('still works when latencyCompensator is never registered', () => {
    const deps = makeDeps();
    const svc = new CompensationService(deps);
    expect(svc.getDelay('dev-1', 0)).toBe(10);
    svc.destroy();
  });
});
