/**
 * @file tests/audit/l03-panic-conformance.test.js
 * @description Lot L03 — §D05 panic: what is actually sent, on which channels,
 * to which transports, and whether it is enough to silence an instrument that
 * has a sustain pedal latched.
 *
 * The 2026-08-22 audit checked the *plumbing* (the device rate limiter exempts
 * priority traffic) and delegated the WebSocket-level exemption to F-07 / lot
 * L01. What was never checked is the **content** of the panic burst. It is
 * checked here, byte by byte.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { register as registerMidiCommands } from '../../src/api/commands/MidiCommands.js';
import MidiUtils from '../../src/utils/MidiUtils.js';

const noop = () => {};

/** Capture every `(device, type, data)` the commands push at DeviceManager. */
function makeApp() {
  const sent = [];
  const app = {
    deviceManager: {
      sendMessage: jest.fn((device, type, data) => {
        sent.push({ device, type, ...data });
        return true;
      }),
      getDeviceList: () => [
        { id: 'usb-a', output: true, enabled: true },
        { id: 'ble-b', output: true, enabled: true },
        { id: 'in-only', output: false, enabled: true }
      ]
    },
    midiRouter: { resetNoteGate: jest.fn() }
  };
  return { app, sent };
}

/** Build the command registry exactly as CommandRegistry would. */
function makeRegistry(app) {
  const handlers = new Map();
  const registry = { register: (name, fn) => handlers.set(name, fn) };
  registerMidiCommands(registry, app);
  return (name, data) => handlers.get(name)(data);
}

describe('L03/D05 — midi_panic content', () => {
  let app, sent, call;
  beforeEach(() => {
    ({ app, sent } = makeApp());
    call = makeRegistry(app);
  });

  test('sends All Sound Off (120) + All Notes Off (123) on all 16 channels', async () => {
    await call('midi_panic', { deviceId: 'usb-a' });
    expect(sent).toHaveLength(32);
    for (let ch = 0; ch < 16; ch++) {
      const forCh = sent.filter((m) => m.channel === ch);
      expect([ch, forCh.map((m) => m.controller)]).toEqual([ch, [120, 123]]);
      expect(forCh.every((m) => m.type === 'cc' && m.value === 0)).toBe(true);
      expect(forCh.every((m) => m.device === 'usb-a')).toBe(true);
    }
  });

  test('the panic also clears the router note-gate (phantom-voice guard)', async () => {
    await call('midi_panic', { deviceId: 'usb-a' });
    expect(app.midiRouter.resetNoteGate).toHaveBeenCalledTimes(1);
  });

  // F-45 — the panic burst has no Reset All Controllers (CC 121).
  test('F-45 — panic does NOT send Reset All Controllers (121): a latched sustain survives', async () => {
    await call('midi_panic', { deviceId: 'usb-a' });
    const controllers = new Set(sent.map((m) => m.controller));
    expect(controllers.has(120)).toBe(true);
    expect(controllers.has(123)).toBe(true);
    // MIDI 1.0 recommended practice for a panic is 123 + 121 (+ 120): without
    // 121 a held CC64 (sustain) stays latched. On an instrument that
    // implements All Notes Off but not All Sound Off — the common case for the
    // DIY instruments this project targets — 123 is defined to be IGNORED
    // while sustain is on, so the panic is a no-op and the notes keep sounding.
    expect(controllers.has(121)).toBe(false);
  });

  test('F-45 — the sustain that hangs the notes is never cleared by the panic', async () => {
    // A pedal-down arrives, then the operator hits panic.
    await call('midi_send_cc', { deviceId: 'usb-a', channel: 0, controller: 64, value: 127 });
    sent.length = 0;
    await call('midi_panic', { deviceId: 'usb-a' });
    // Nothing in the burst releases CC64, and nothing resets controllers.
    expect(sent.some((m) => m.controller === 64 && m.value === 0)).toBe(false);
    expect(sent.some((m) => m.controller === 121)).toBe(false);
  });

  test('midi_all_notes_off is the gentle variant: 123 only, still all 16 channels', async () => {
    await call('midi_all_notes_off', { deviceId: 'usb-a' });
    expect(sent).toHaveLength(16);
    expect(new Set(sent.map((m) => m.controller))).toEqual(new Set([123]));
    expect(sent.map((m) => m.channel)).toEqual([...Array(16).keys()]);
  });

  // F-45 (second half) — no "panic everything" exists.
  test('F-45 — panic targets ONE device; there is no all-devices panic', async () => {
    // `midi_reset` broadcasts when deviceId is omitted…
    const res = await call('midi_reset', {});
    expect(res.targets).toBe(2); // the two output devices
    sent.length = 0;
    // …but `midi_panic` does not: with no deviceId it addresses `undefined`.
    await call('midi_panic', {});
    expect(new Set(sent.map((m) => m.device))).toEqual(new Set([undefined]));
  });

  test('midi_reset broadcasts System Reset to every enabled output, skipping inputs', async () => {
    const res = await call('midi_reset', {});
    expect(res).toEqual({ success: true, targets: 2 });
    expect(sent.map((m) => m.device)).toEqual(['usb-a', 'ble-b']);
    expect(new Set(sent.map((m) => m.type))).toEqual(new Set(['reset']));
  });
});

// ---------------------------------------------------------------------------
// The panic burst must survive the device rate limiter, under load.
// ---------------------------------------------------------------------------
describe('L03/D05 — panic under load (device rate limiter)', () => {
  let DeviceManager;
  beforeEach(async () => {
    ({ default: DeviceManager } = await import('../../src/midi/devices/DeviceManager.js'));
  });

  function saturated() {
    const out = [];
    const dm = new DeviceManager({
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      eventBus: { on: noop, off: noop, emit: noop },
      config: { get: () => undefined },
      database: null
    });
    dm.outputs.set('dev', { send: (type, data) => out.push({ type, ...data }) });
    // 10 messages / second, the tightest limit the UI can configure.
    dm._rateLimitCache.set('dev', 10);
    return { dm, out };
  }

  test('a saturating note stream IS throttled (the limiter really is armed)', () => {
    const { dm } = saturated();
    let limited = 0;
    for (let i = 0; i < 200; i++) {
      if (
        dm.sendMessageEx('dev', 'noteon', { channel: 0, note: 60, velocity: 100 }).status ===
        'rate_limited'
      ) {
        limited++;
      }
    }
    expect(limited).toBeGreaterThan(150);
  });

  test('every message of a 32-message panic burst lands while the limiter is saturated', () => {
    const { dm, out } = saturated();
    for (let i = 0; i < 500; i++) {
      dm.sendMessageEx('dev', 'noteon', { channel: 0, note: 60, velocity: 100 });
    }
    const before = out.length;
    for (let ch = 0; ch < 16; ch++) {
      for (const controller of [120, 123]) {
        expect(dm.sendMessageEx('dev', 'cc', { channel: ch, controller, value: 0 }).status).toBe(
          'sent'
        );
      }
    }
    expect(out.length - before).toBe(32);
  });

  test('Note Off, reset and transport are exempt too, so nothing can hang', () => {
    const { dm } = saturated();
    for (let i = 0; i < 500; i++) {
      dm.sendMessageEx('dev', 'noteon', { channel: 0, note: 60, velocity: 100 });
    }
    for (const type of ['noteoff', 'reset', 'stop', 'clock', 'start', 'continue']) {
      expect([
        type,
        dm.sendMessageEx('dev', type, { channel: 0, note: 60, velocity: 0 }).status
      ]).toEqual([type, 'sent']);
    }
    // CC 121 would be exempt as well IF the panic ever sent it (see F-45):
    // the exemption keys on `controller >= 120`, not on a fixed list.
    expect(dm.sendMessageEx('dev', 'cc', { channel: 0, controller: 121, value: 0 }).status).toBe(
      'sent'
    );
    // An ordinary CC is NOT exempt.
    expect(dm.sendMessageEx('dev', 'cc', { channel: 0, controller: 7, value: 100 }).status).toBe(
      'rate_limited'
    );
  });

  test('a disabled device receives nothing, panic included', () => {
    const { dm, out } = saturated();
    dm.devices.set('dev', { id: 'dev', enabled: false });
    expect(dm.sendMessageEx('dev', 'cc', { channel: 0, controller: 123, value: 0 }).status).toBe(
      'disabled'
    );
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The panic must be encodable on every transport, not just USB.
// ---------------------------------------------------------------------------
describe('L03/D05 — panic on every transport', () => {
  test('the panic CCs encode to identical wire bytes for BLE / serial / RTP', () => {
    for (let ch = 0; ch < 16; ch++) {
      for (const controller of [120, 121, 123]) {
        expect(MidiUtils.convertToMidiBytes('cc', { channel: ch, controller, value: 0 })).toEqual([
          0xb0 | ch,
          controller,
          0x00
        ]);
      }
    }
  });

  test('the serial write queue treats every Channel Mode CC as priority', async () => {
    const { default: SerialMidiManager } =
      await import('../../src/transports/SerialMidiManager.js');
    const mgr = Object.create(SerialMidiManager.prototype);
    for (const controller of [120, 121, 123]) {
      expect([controller, mgr._isPrioritySerial('cc', { controller })]).toEqual([controller, true]);
    }
    expect(mgr._isPrioritySerial('cc', { controller: 7 })).toBe(false);
    expect(mgr._isPrioritySerial('noteoff', {})).toBe(true);
    // Documented gap: 122 (Local Control) / 124–127 (Omni/Mono/Poly) are also
    // Channel Mode messages and are NOT prioritised here, while the
    // DeviceManager limiter exempts everything >= 120. Harmless today (nothing
    // sends them) — noted so the two lists can be reconciled.
    expect(mgr._isPrioritySerial('cc', { controller: 126 })).toBe(false);
  });

  test('USB re-encodes the panic CCs through easymidi with the same values', async () => {
    const seen = [];
    const output = { send: (type, data) => seen.push({ type, ...data }) };
    // `_sendToOutput` is a plain method: borrow it without constructing a
    // manager (no native binding is touched by the encoding path).
    const { default: DM } = await import('../../src/midi/devices/DeviceManager.js');
    const dm = Object.create(DM.prototype);
    for (const controller of [120, 121, 123]) {
      dm._sendToOutput(output, 'cc', { channel: 9, controller, value: 0 });
    }
    expect(seen).toEqual([
      { type: 'cc', channel: 9, controller: 120, value: 0 },
      { type: 'cc', channel: 9, controller: 121, value: 0 },
      { type: 'cc', channel: 9, controller: 123, value: 0 }
    ]);
  });
});
