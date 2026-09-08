/**
 * @file tests/lighting/shutdown-safe-state.test.js
 * @description L02 — "return to a safe state": `Application.stop()` must leave
 * every fixture dark. It calls `lightingManager.shutdown()`
 * (Application.js:657) inside an isolating `step()` wrapper that swallows
 * throws, so a shutdown that throws early is INVISIBLE in the logs except for
 * one line — and the lights stay on.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import EventBus from '../../src/core/EventBus.js';
import LightingManager from '../../src/lighting/LightingManager.js';
import { FakeLightingDriver, makeDatabase, makeLogger, rule, hardStop } from './l02-fakes.js';

const DEV = { id: 1, name: 'par', type: 'fake', led_count: 8, enabled: true };

let managers = [];
function build(rules = []) {
  const logger = makeLogger();
  const bus = new EventBus(logger);
  const manager = new LightingManager({
    logger,
    database: makeDatabase({ rules }),
    eventBus: bus,
    wsServer: null
  });
  const driver = new FakeLightingDriver(DEV, logger);
  manager.drivers.set(DEV.id, driver);
  managers.push(manager);
  return { manager, bus, logger, driver };
}

afterEach(() => {
  managers.forEach(hardStop);
  managers = [];
});

describe('L02 F-30 — shutdown() must actually darken the rig', () => {
  test('EventBus exposes off() / removeAllListeners() but NOT removeListener()', () => {
    const bus = new EventBus();
    expect(typeof bus.off).toBe('function');
    expect(typeof bus.removeAllListeners).toBe('function');
    // The bug: LightingManager._removeEventListeners() called `removeListener`,
    // which this EventBus has never implemented, so shutdown() threw on its
    // very first statement and never reached allOff().
    expect(typeof bus.removeListener).toBe('undefined');
  });

  test('shutdown() resolves instead of throwing', async () => {
    const { manager } = build();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  test('every fixture is switched off and disconnected', async () => {
    const { manager, driver } = build();
    driver.reset();
    await manager.shutdown();
    expect(driver.of('allOff').length).toBeGreaterThanOrEqual(1);
    expect(driver.disconnectCalls).toBe(1);
    expect(manager.drivers.size).toBe(0);
  });

  test('the health-check timer and both MIDI listeners are released', async () => {
    const { manager, bus, driver } = build([rule({ condition_config: { trigger: 'any' } })]);
    expect(bus.listenerCount('midi_message')).toBe(1);
    await manager.shutdown();

    expect(manager._healthCheckInterval).toBeNull();
    expect(bus.listenerCount('midi_message')).toBe(0);
    expect(bus.listenerCount('midi_routed')).toBe(0);
    driver.reset();
    bus.emit('midi_message', { type: 'noteon', data: { channel: 0, note: 60, velocity: 100 } });
    expect(driver.calls.length).toBe(0); // a stopped manager drives nothing
  });

  test("Application.stop()'s isolating step() logs nothing for lighting", async () => {
    const { manager, logger, driver } = build();
    // Verbatim shape of Application.js:635-641.
    const step = async (label, fn) => {
      try {
        await fn();
      } catch (err) {
        logger.error(`Stop step "${label}" failed (continuing): ${err.message}`);
      }
    };
    await step('lightingManager', () => manager.shutdown());
    expect(logger._rec.error.join('\n')).not.toMatch(/Stop step "lightingManager" failed/);
    expect(driver.of('allOff').length).toBeGreaterThanOrEqual(1);
  });

  test('shutdown() is idempotent', async () => {
    const { manager } = build();
    await manager.shutdown();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

describe('L02 — the safe-state primitives themselves are correct (once reached)', () => {
  test('allOff() stops effects, cancels fades, darkens every connected driver', () => {
    const { manager, driver } = build();
    manager.effectsEngine.startEffect('e1', 'rainbow', driver, {
      led_start: 0,
      led_end: 7,
      speed: 500
    });
    manager._fadeIn(driver, 0, 7, 255, 0, 0, 255, 500);
    expect(manager.effectsEngine.activeEffects.size).toBe(1);
    expect(manager.activeFades.size).toBe(1);

    driver.reset();
    manager.allOff();

    expect(manager.effectsEngine.activeEffects.size).toBe(0);
    expect(manager.activeFades.size).toBe(0);
    expect(driver.of('allOff').length).toBe(1);
    expect(manager.activeNotes.size).toBe(0);
  });

  test('blackout() does the same and is idempotent', () => {
    const { manager, driver } = build();
    manager.blackout();
    manager.blackout();
    expect(driver.of('allOff').length).toBe(2);
  });

  test('a disconnected driver is not written to during allOff()', () => {
    const { manager, driver } = build();
    driver.connected = false;
    driver.reset();
    manager.allOff();
    expect(driver.calls.length).toBe(0);
  });

  test('setSystemEnabled(false) darkens everything immediately', () => {
    const { manager, driver } = build();
    driver.reset();
    manager.setSystemEnabled(false);
    expect(driver.of('allOff').length).toBe(1);
    expect(manager.getSystemEnabled()).toEqual({ success: true, enabled: false });
  });

  test("disconnectDevice() stops that device's effects and drops the driver", async () => {
    const { manager, driver } = build();
    manager.effectsEngine.startEffect('k', 'rainbow', driver, {
      led_start: 0,
      led_end: 7,
      speed: 500
    });
    await manager.disconnectDevice(DEV.id);
    expect(manager.drivers.has(DEV.id)).toBe(false);
    expect(driver.disconnectCalls).toBe(1);
    expect(manager.effectsEngine.activeEffects.size).toBe(0);
  });

  test('a driver whose disconnect() throws does not abort disconnectDevice()', async () => {
    const { manager, driver } = build();
    driver._doDisconnect = async () => {
      throw new Error('socket already gone');
    };
    await expect(manager.disconnectDevice(DEV.id)).resolves.toBeUndefined();
    expect(manager.drivers.has(DEV.id)).toBe(false);
  });
});

// ==========================================================================
// The 4th `removeListener` site (L01 F-27 hand-off). Unlike the three that
// threw, this one is an OPTIONAL call — `eventBus?.removeListener?.(...)` —
// so it fails SILENTLY: no error, no log, and the listener simply stays
// attached for the life of the process.
// ==========================================================================

describe('L02 F-30c — InstrumentLightManager.shutdown() must actually detach its listener', () => {
  async function build() {
    const { default: InstrumentLightManager } =
      await import('../../src/lighting/instrument/InstrumentLightManager.js');
    const logger = makeLogger();
    const bus = new EventBus(logger);
    const database = {
      getAllInstrumentLightStates: () => [],
      getInstrumentSettings: () => null,
      saveInstrumentLightState: () => {}
    };
    const m = new InstrumentLightManager({
      logger,
      database,
      eventBus: bus,
      deviceManager: null,
      wsServer: null
    });
    return { m, bus, logger };
  }

  test('the listener is attached at construction', async () => {
    const { bus } = await build();
    expect(bus.listenerCount('instrument_settings_changed')).toBe(1);
  });

  test('shutdown() releases it', async () => {
    const { m, bus } = await build();
    await m.shutdown();
    expect(bus.listenerCount('instrument_settings_changed')).toBe(0);
    expect(m.controllers.size).toBe(0);
  });

  test('a restart cycle does not accumulate listeners', async () => {
    // Application.restart() = stop() → initialize() → start(); the maintenance
    // command exposes it. Each cycle used to leave one more listener behind,
    // and EventBus warns past 50.
    const { default: InstrumentLightManager } =
      await import('../../src/lighting/instrument/InstrumentLightManager.js');
    const logger = makeLogger();
    const bus = new EventBus(logger);
    const deps = {
      logger,
      eventBus: bus,
      deviceManager: null,
      wsServer: null,
      database: {
        getAllInstrumentLightStates: () => [],
        getInstrumentSettings: () => null,
        saveInstrumentLightState: () => {}
      }
    };
    for (let i = 0; i < 60; i++) {
      const m = new InstrumentLightManager(deps);
      await m.shutdown();
    }
    expect(bus.listenerCount('instrument_settings_changed')).toBe(0);
    expect(logger._rec.warn.join(' ')).not.toMatch(/possible memory leak/);
  });
});
