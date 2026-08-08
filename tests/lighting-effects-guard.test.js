// tests/lighting-effects-guard.test.js
// Audit B1: LightingEffectsEngine.startEffect must (a) refuse an invalid LED
// range instead of building a runaway 1ms interval, and (b) isolate a driver
// throw inside the tick so it stops the effect rather than crashing the app.

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import LightingEffectsEngine from '../src/lighting/LightingEffectsEngine.js';

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const engines = [];
function makeEngine() {
  const e = new LightingEffectsEngine(logger);
  engines.push(e);
  return e;
}
afterEach(() => {
  engines.forEach((e) => e.activeEffects.forEach((_v, k) => e.stopEffect(k)));
  engines.length = 0;
  jest.useRealTimers();
});

const driver = (impl = {}) => ({
  device: { led_count: 10 },
  setColor: impl.setColor || (() => {}),
  setRange: impl.setRange || (() => {})
});

describe('LightingEffectsEngine — LED range guard (audit B1 D2)', () => {
  test('an inverted range does not start an effect (no runaway timer)', () => {
    const e = makeEngine();
    e.startEffect('k', 'chase', driver(), { led_start: 5, led_end: 4 });
    expect(e.activeEffects.size).toBe(0);
  });

  test('a valid range starts exactly one effect', () => {
    const e = makeEngine();
    e.startEffect('k', 'rainbow', driver(), { led_start: 0, led_end: 4 });
    expect(e.activeEffects.size).toBe(1);
  });
});

describe('LightingEffectsEngine — tick isolation (audit B1 M1)', () => {
  test('a throwing driver stops the effect instead of escaping the timer', () => {
    jest.useFakeTimers();
    const e = makeEngine();
    e.startEffect(
      'boom',
      'rainbow',
      driver({
        setColor: () => {
          throw new Error('driver fault');
        }
      }),
      {
        led_start: 0,
        led_end: 4,
        speed: 100
      }
    );
    expect(e.activeEffects.size).toBe(1);
    // Advancing past one interval fires the tick; the throw must be caught and
    // the effect stopped, not propagated as an uncaughtException.
    expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    expect(e.activeEffects.size).toBe(0);
  });
});
