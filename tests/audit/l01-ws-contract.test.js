/**
 * @file tests/audit/l01-ws-contract.test.js
 * @description Audit L01 — WebSocket contract regressions.
 *
 * Every test here encodes a defect that was reproduced live against a running
 * server on 2026-09-07 (see docs/audit/2026-09-07/01_API_CONTRACT.md).
 */
import { jest } from '@jest/globals';
import EventBus from '../../src/core/EventBus.js';
import JsonValidator from '../../src/utils/JsonValidator.js';
import { register as registerLighting } from '../../src/api/commands/LightingCommands.js';

/** Minimal registry standing in for CommandRegistry. */
function makeRegistry() {
  const handlers = {};
  return { handlers, register: (name, fn) => (handlers[name] = fn) };
}

/** Application facade with a REAL EventBus — the point of the F-18 test. */
function makeApp() {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    eventBus: new EventBus(),
    lightingManager: {
      effectsEngine: { setBpm: () => {}, getBpm: () => 120, tapTempo: () => 120 },
      drivers: new Map(),
      reloadRules: () => {}
    },
    lightingRepository: {
      findAllRules: () => [],
      findAllDevices: () => [],
      findDeviceById: () => null
    }
  };
}

describe('L01 / F-18 — lighting_midi_learn must not crash the process', () => {
  // EventBus exposes on/off/once/emit — NOT the Node EventEmitter
  // `removeListener`. The handler used to call `removeListener`, so the
  // 10 s timeout callback threw a TypeError from a timer: uncatchable by
  // the dispatcher, escalated to `uncaughtException`, and Application's
  // handler shut the whole server down. One WS frame = remote kill.
  it('EventBus does not implement removeListener (the trap)', () => {
    const bus = new EventBus();
    expect(typeof bus.off).toBe('function');
    expect(bus.removeListener).toBeUndefined();
  });

  it('resolves with a timeout result instead of throwing from the timer', async () => {
    jest.useFakeTimers();
    const app = makeApp();
    const registry = makeRegistry();
    registerLighting(registry, app);

    const promise = registry.handlers['lighting_midi_learn']({});
    // Fire the 10 s one-shot timeout. If the callback throws, Jest surfaces it.
    expect(() => jest.advanceTimersByTime(10_000)).not.toThrow();
    await expect(promise).resolves.toMatchObject({ success: false, error: 'timeout' });
    // The one-shot listener must actually be detached.
    expect(app.eventBus.listenerCount('midi_message')).toBe(0);
    jest.useRealTimers();
  });

  it('detaches the listener on the happy path too (no leak on the MIDI hot path)', async () => {
    jest.useFakeTimers();
    const app = makeApp();
    const registry = makeRegistry();
    registerLighting(registry, app);

    const promise = registry.handlers['lighting_midi_learn']({});
    expect(app.eventBus.listenerCount('midi_message')).toBe(1);
    app.eventBus.emit('midi_message', { data: { type: 'noteon', note: 60, channel: 0 } });
    await expect(promise).resolves.toMatchObject({ success: true });
    expect(app.eventBus.listenerCount('midi_message')).toBe(0);
    jest.useRealTimers();
  });
});

// F-03/F-19 — CLOSED by wave 1 / R3 (see tests/audit/r3-fail-closed.test.js
// for the full contract). The two tests below were the regression witnesses of
// the fail-OPEN default; they are kept, inverted, so the defect cannot come
// back unnoticed. The five commands named here were the audit's own examples.
describe('L01 / F-03 — validateByCommand no longer fails open', () => {
  it('rejects the payloads that used to sail through those five commands', () => {
    // One hostile frame per command, of the shape the fuzzing campaign sent.
    // Every one of these answered `{valid:true, errors:[]}` before R3.
    const hostile = [
      ['lighting_rule_add', { device_id: {}, priority: 'high' }],
      ['playback_set_tempo', { bpm: 1e308 }],
      ['playlist_create', { name: {} }],
      ['system_logs', { lines: 'all' }],
      ['string_instrument_create', { device_id: {}, channel: 99 }]
    ];
    for (const [cmd, data] of hostile) {
      expect(JsonValidator.validateByCommand(cmd, data).valid).toBe(false);
    }
  });

  it('an unknown command name is refused at the validation layer too', () => {
    const r = JsonValidator.validateByCommand('no_such_command_xyz', { x: 1 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/fail-closed/);
    // The dispatcher still answers ERR_NOT_FOUND for an unknown name: it looks
    // the handler up BEFORE validating the payload (CommandRegistry.handle).
  });
});
