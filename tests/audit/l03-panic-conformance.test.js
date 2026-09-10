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

  // R18 (vague 4) — inverted: the burst is now 120 → 121 → 123.
  test('sends 120 + 121 + 123, in that order, on all 16 channels', async () => {
    await call('midi_panic', { deviceId: 'usb-a' });
    expect(sent).toHaveLength(48);
    for (let ch = 0; ch < 16; ch++) {
      const forCh = sent.filter((m) => m.channel === ch);
      expect([ch, forCh.map((m) => m.controller)]).toEqual([ch, [120, 121, 123]]);
      expect(forCh.every((m) => m.type === 'cc' && m.value === 0)).toBe(true);
      expect(forCh.every((m) => m.device === 'usb-a')).toBe(true);
    }
  });

  test('the panic also clears the router note-gate (phantom-voice guard)', async () => {
    await call('midi_panic', { deviceId: 'usb-a' });
    expect(app.midiRouter.resetNoteGate).toHaveBeenCalledTimes(1);
  });

  // F-45 — FIXED by R18. The burst now carries Reset All Controllers (121),
  // and it carries it BEFORE All Notes Off (123).
  test('F-45 — panic sends Reset All Controllers (121) on every channel', async () => {
    await call('midi_panic', { deviceId: 'usb-a' });
    const controllers = new Set(sent.map((m) => m.controller));
    expect(controllers).toEqual(new Set([120, 121, 123]));
    expect(sent.filter((m) => m.controller === 121)).toHaveLength(16);
  });

  test('F-45 — 121 precedes 123 on every channel, which is what makes 123 land', async () => {
    await call('midi_panic', { deviceId: 'usb-a' });
    for (let ch = 0; ch < 16; ch++) {
      const forCh = sent.filter((m) => m.channel === ch).map((m) => m.controller);
      // MIDI 1.0 defines All Notes Off as ignored (or deferred) while the
      // damper pedal is latched. A 123 sent while CC 64 is down does nothing,
      // and a 121 sent afterwards only releases a pedal whose note-offs were
      // already discarded — which is exactly why the old 120 + 123 burst was a
      // no-op on instruments implementing 123 but not 120 (the common DIY /
      // microcontroller case). 121 first, so 123 is honoured.
      expect([ch, forCh.indexOf(121) < forCh.indexOf(123)]).toEqual([ch, true]);
    }
  });

  test('F-45 — the sustain that hung the notes IS released by the panic', async () => {
    // A pedal-down arrives, then the operator hits panic.
    await call('midi_send_cc', { deviceId: 'usb-a', channel: 0, controller: 64, value: 127 });
    sent.length = 0;
    await call('midi_panic', { deviceId: 'usb-a' });
    // CC 64 is not released by name — Reset All Controllers is the standard
    // (and rate-limiter-exempt) way to unlatch it, and it is now sent on the
    // channel the pedal was pressed on, before the All Notes Off.
    const ch0 = sent.filter((m) => m.channel === 0).map((m) => m.controller);
    expect(ch0).toEqual([120, 121, 123]);
  });

  test('midi_all_notes_off is the gentle variant: 123 only, still all 16 channels', async () => {
    await call('midi_all_notes_off', { deviceId: 'usb-a' });
    expect(sent).toHaveLength(16);
    expect(new Set(sent.map((m) => m.controller))).toEqual(new Set([123]));
    expect(sent.map((m) => m.channel)).toEqual([...Array(16).keys()]);
  });

  // F-45 (second half) — FIXED by R18: omitting deviceId panics everything.
  test('F-45 — panic with no deviceId reaches EVERY enabled output', async () => {
    // `midi_reset` broadcasts when deviceId is omitted…
    const res = await call('midi_reset', {});
    expect(res.targets).toBe(2); // the two output devices
    sent.length = 0;
    // …and `midi_panic` now does the same, instead of addressing `undefined`.
    const panic = await call('midi_panic', {});
    expect(panic).toEqual({ success: true, targets: 2 });
    expect(new Set(sent.map((m) => m.device))).toEqual(new Set(['usb-a', 'ble-b']));
    expect(sent).toHaveLength(96); // 2 devices × 16 channels × 3 controllers
    // The input-only device is never addressed, and nothing goes to `undefined`.
    expect(sent.some((m) => m.device === 'in-only' || m.device === undefined)).toBe(false);
  });

  test('F-45 — all_notes_off with no deviceId is global too', async () => {
    const res = await call('midi_all_notes_off', {});
    expect(res).toEqual({ success: true, targets: 2 });
    expect(sent).toHaveLength(32); // 2 devices × 16 channels × 1 controller
    expect(new Set(sent.map((m) => m.controller))).toEqual(new Set([123]));
  });

  test('F-45 — a global panic still clears the router note-gate exactly once', async () => {
    await call('midi_panic', {});
    expect(app.midiRouter.resetNoteGate).toHaveBeenCalledTimes(1);
  });

  test('F-45 — a disabled output is skipped by the global panic', async () => {
    app.deviceManager.getDeviceList = () => [
      { id: 'usb-a', output: true, enabled: true },
      { id: 'muted', output: true, enabled: false }
    ];
    const res = await call('midi_panic', {});
    expect(res.targets).toBe(1);
    expect(new Set(sent.map((m) => m.device))).toEqual(new Set(['usb-a']));
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

  test('every message of the 48-message panic burst lands while the limiter is saturated', () => {
    const { dm, out } = saturated();
    for (let i = 0; i < 500; i++) {
      dm.sendMessageEx('dev', 'noteon', { channel: 0, note: 60, velocity: 100 });
    }
    const before = out.length;
    for (let ch = 0; ch < 16; ch++) {
      for (const controller of [120, 121, 123]) {
        expect(dm.sendMessageEx('dev', 'cc', { channel: ch, controller, value: 0 }).status).toBe(
          'sent'
        );
      }
    }
    expect(out.length - before).toBe(48);
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
    // CC 121 is exempt too — the exemption keys on `controller >= 120`, not on
    // a fixed list, so the R18 burst is covered without touching the limiter.
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
    // R18 — the documented gap is closed: 122 (Local Control) and 124–127
    // (Omni/Mono/Poly) are Channel Mode messages too, and the serial queue now
    // keys on `controller >= 120` exactly like the DeviceManager limiter, so
    // one Channel Mode CC cannot be prioritised on USB and deprioritised on
    // the UART.
    for (const controller of [122, 124, 125, 126, 127]) {
      expect([controller, mgr._isPrioritySerial('cc', { controller })]).toEqual([controller, true]);
    }
    expect(mgr._isPrioritySerial('cc', { controller: 119 })).toBe(false);
    // The typed priorities are the very same set the limiter exempts.
    for (const type of ['noteoff', 'reset', 'clock', 'start', 'stop', 'continue']) {
      expect([type, mgr._isPrioritySerial(type, {})]).toEqual([type, true]);
    }
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
