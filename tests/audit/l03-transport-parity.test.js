/**
 * @file tests/audit/l03-transport-parity.test.js
 * @description Lot L03 — **systematic** inter-transport decode parity.
 *
 * The previous audit found F-08 by hand: `DeviceManager.handleRawMidi()`
 * dropped the System Common messages that `SerialMidiManager` handled, so the
 * SAME BYTES ON THE WIRE behaved differently depending on the cable. One case
 * was fixed; the class was never swept.
 *
 * This suite sweeps it. A single table of wire-byte streams is injected into
 * **every** decode path the product actually runs:
 *
 *   | Path   | Code under test                                            |
 *   |--------|------------------------------------------------------------|
 *   | USB    | `easymidi.Input` events → `DeviceManager.addInput()`        |
 *   | Serial | `SerialMidiManager._handleData()` byte-stream parser        |
 *   | BLE    | `BluetoothManager._handleIncomingMidi()` → `handleRawMidi()`|
 *   | RTP    | `RtpMidiSession.parseMidiPayload()` → `NetworkManager`      |
 *
 * Every path is terminated at the SAME funnel — `DeviceManager.handleMidiMessage`
 * — which is where routing, WS broadcast and the EventBus read from. Two
 * transports agree only when that funnel sees the same `(type, payload)`.
 *
 * The USB path cannot use the real `easymidi` here (no ALSA headers in CI, see
 * CLAUDE.md), so it is driven through a mocked module whose parser is a verbatim
 * replica of the installed `node_modules/easymidi/index.js`. A guard test reads
 * that file and fails if the replica ever drifts from it.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// easymidi mock (USB path). Records the events DeviceManager subscribes to.
// ---------------------------------------------------------------------------
const usbInputs = [];
class FakeEasymidiInput {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    usbInputs.push(this);
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  emit(event, msg) {
    for (const fn of this.listeners.get(event) || []) fn(msg);
  }
  /** Event names DeviceManager actually wired up. */
  subscribed() {
    return new Set(this.listeners.keys());
  }
  close() {}
  removeAllListeners() {
    this.listeners.clear();
  }
}
jest.unstable_mockModule('easymidi', () => ({
  default: {
    getInputs: () => ['USB-DEV'],
    getOutputs: () => ['USB-DEV'],
    Input: FakeEasymidiInput,
    Output: class {
      send() {}
      close() {}
    }
  }
}));

const { default: DeviceManager } = await import('../../src/midi/devices/DeviceManager.js');
const { default: SerialMidiManager } = await import('../../src/transports/SerialMidiManager.js');
const { default: BluetoothManager } = await import('../../src/transports/BluetoothManager.js');
const { default: InMemoryBleAdapter } =
  await import('../../src/midi/adapters/InMemoryBleAdapter.js');
const { default: NetworkManager } = await import('../../src/transports/NetworkManager.js');
const { default: RtpMidiSession } = await import('../../src/transports/RtpMidiSession.js');

// ---------------------------------------------------------------------------
// easymidi's own parser, replicated from node_modules/easymidi/index.js.
// (see the guard test `easymidi replica matches the installed package`)
// ---------------------------------------------------------------------------
const EASYMIDI_INPUT_TYPES = {
  0x08: 'noteoff',
  0x09: 'noteon',
  0x0a: 'poly aftertouch',
  0x0b: 'cc',
  0x0c: 'program',
  0x0d: 'channel aftertouch',
  0x0e: 'pitch'
};
const EASYMIDI_EXTENDED_TYPES = {
  0xf0: 'sysex',
  0xf1: 'mtc',
  0xf2: 'position',
  0xf3: 'select',
  0xf6: 'tune',
  0xf7: 'sysex end',
  0xf8: 'clock',
  0xfa: 'start',
  0xfb: 'continue',
  0xfc: 'stop',
  0xfe: 'activesense',
  0xff: 'reset'
};
function easymidiParse(bytes) {
  const msg = {};
  let type = 'unknown';
  if (bytes[0] >= 0xf0) {
    type = EASYMIDI_EXTENDED_TYPES[bytes[0]];
  } else {
    type = EASYMIDI_INPUT_TYPES[bytes[0] >> 4];
    msg.channel = bytes[0] & 0x0f;
  }
  if (type === 'noteoff' || type === 'noteon') {
    msg.note = bytes[1];
    msg.velocity = bytes[2];
  }
  if (type === 'cc') {
    msg.controller = bytes[1];
    msg.value = bytes[2];
  }
  if (type === 'poly aftertouch') {
    msg.note = bytes[1];
    msg.pressure = bytes[2];
  }
  if (type === 'channel aftertouch') msg.pressure = bytes[1];
  if (type === 'program') msg.number = bytes[1];
  if (type === 'pitch' || type === 'position') msg.value = bytes[1] + bytes[2] * 128;
  if (type === 'sysex') msg.bytes = bytes;
  if (type === 'select') msg.song = bytes[1];
  if (type === 'mtc') {
    msg.type = (bytes[1] >> 4) & 0x07;
    msg.value = bytes[1] & 0x0f;
  }
  return { type, msg };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------
const noop = () => {};
const makeDeps = () => ({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  eventBus: { emit: noop, on: noop, off: noop, removeListener: noop },
  config: { get: () => undefined },
  database: null
});

/**
 * A real DeviceManager whose funnel runs for real; the OUTPUT of the funnel is
 * captured at the router boundary — the exact `(type, msg)` pair that reaches
 * `MidiRouter.routeMessage`, the EventBus `midi_message` event and the
 * `midi_event` WS broadcast. Parity is judged on that, not on an intermediate.
 */
function capturingManager() {
  const seen = [];
  const deps = makeDeps();
  deps.midiRouter = { routeMessage: (_device, type, msg) => seen.push({ type, msg }) };
  const dm = new DeviceManager(deps);
  return { dm, seen };
}

/** Split a byte stream into complete MIDI messages (for the framed paths). */
function frameMessages(bytes) {
  const out = [];
  let i = 0;
  let running = 0;
  const dataLen = (status) => {
    const hi = status & 0xf0;
    if (hi === 0xc0 || hi === 0xd0) return 1;
    if (hi < 0xf0) return 2;
    if (status === 0xf1 || status === 0xf3) return 1;
    if (status === 0xf2) return 2;
    return 0;
  };
  while (i < bytes.length) {
    const b = bytes[i];
    if (b >= 0xf8) {
      out.push([b]);
      i++;
      continue;
    }
    if (b === 0xf0) {
      const start = i;
      i++;
      while (i < bytes.length && bytes[i] !== 0xf7) i++;
      if (i < bytes.length) i++;
      out.push(bytes.slice(start, i));
      running = 0;
      continue;
    }
    let status;
    if (b >= 0x80) {
      status = b;
      i++;
      running = status <= 0xef ? status : 0;
    } else if (running) {
      status = running;
    } else {
      i++;
      continue;
    }
    const n = dataLen(status);
    out.push([status, ...bytes.slice(i, i + n)]);
    i += n;
  }
  return out;
}

// ---- USB -------------------------------------------------------------------
async function decodeUsb(bytes) {
  usbInputs.length = 0;
  const { dm, seen } = capturingManager();
  dm.addInput('USB-DEV');
  const input = usbInputs[usbInputs.length - 1];
  for (const frame of frameMessages(bytes)) {
    const { type, msg } = easymidiParse(frame);
    if (!type || type === 'unknown') continue;
    // RtMidi/easymidi only emits events; a listener that was never registered
    // means the message never reaches the application at all.
    input.emit(type, msg);
  }
  return seen;
}

/** The set of easymidi event names DeviceManager.addInput() subscribes to. */
function usbSubscribedEvents() {
  usbInputs.length = 0;
  const { dm } = capturingManager();
  dm.addInput('USB-DEV');
  return usbInputs[usbInputs.length - 1].subscribed();
}

// ---- Serial ----------------------------------------------------------------
function decodeSerial(bytes, chunks = null) {
  const { dm, seen } = capturingManager();
  const mgr = Object.create(SerialMidiManager.prototype);
  mgr.logger = makeDeps().logger;
  mgr.deviceManager = dm;
  mgr.openPorts = new Map([['/dev/ttyAMA0', { parserState: mgr._createParserState() }]]);
  for (const chunk of chunks || [bytes]) {
    mgr._handleData('/dev/ttyAMA0', Buffer.from(chunk));
  }
  return seen;
}

// ---- BLE -------------------------------------------------------------------
/** Wrap a byte stream in Apple BLE-MIDI framing (header + per-message ts). */
function bleFrame(bytes) {
  const pkt = [0x80];
  for (const msg of frameMessages(bytes)) {
    pkt.push(0x80, ...msg);
  }
  return Buffer.from(pkt);
}
async function decodeBle(bytes, packets = null) {
  const { dm, seen } = capturingManager();
  const ble = new BluetoothManager(
    { logger: makeDeps().logger },
    { port: new InMemoryBleAdapter() }
  );
  // Exactly the wiring Application.initialize installs.
  ble.on('midi:data', ({ address, data }) => dm.handleRawMidi(address, data));
  for (const pkt of packets || [bleFrame(bytes)]) {
    ble._handleIncomingMidi('AA:BB', Buffer.from(pkt));
  }
  await ble.cleanup();
  return seen;
}

// ---- RTP / network ---------------------------------------------------------
/**
 * RFC 6295 MIDI command section built from a byte stream: Z=0 (no delta-time
 * before the first command), a one-octet 0x00 delta-time before each following
 * command, and the long (2-octet) header once the section exceeds 15 octets.
 */
function rtpPayload(bytes) {
  const section = [];
  frameMessages(bytes).forEach((m, idx) => {
    if (idx > 0) section.push(0x00); // delta-time
    section.push(...m);
  });
  if (section.length <= 0x0f) return Buffer.from([section.length, ...section]);
  return Buffer.from([0x80 | ((section.length >> 8) & 0x0f), section.length & 0xff, ...section]);
}
function decodeRtp(bytes, payloads = null) {
  const { dm, seen } = capturingManager();
  const session = Object.create(RtpMidiSession.prototype);
  const nm = Object.create(NetworkManager.prototype);
  nm.logger = makeDeps().logger;
  const emitted = [];
  nm.emit = (_evt, payload) => emitted.push(payload);
  for (const p of payloads || [rtpPayload(bytes)]) {
    for (const cmd of session.parseMidiPayload(p)) {
      nm.handleMidiData('10.0.0.7', cmd);
    }
  }
  // Application.initialize's network wiring.
  for (const { type, data } of emitted) {
    if (Array.isArray(data)) dm.handleRawMidi('10.0.0.7', data);
    else if (type) dm.handleMidiMessage('10.0.0.7', type, data);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Guard: the replica must track the installed easymidi.
// ---------------------------------------------------------------------------
describe('L03 — harness integrity', () => {
  test('easymidi replica matches the installed package tables', () => {
    const src = readFileSync(path.join(REPO, 'node_modules/easymidi/index.js'), 'utf8');
    for (const [byte, name] of Object.entries(EASYMIDI_EXTENDED_TYPES)) {
      const hex = Number(byte).toString(16).toUpperCase().padStart(2, '0');
      expect(src).toMatch(new RegExp(`0x${hex}:\\s*'${name}'`, 'i'));
    }
    for (const [nibble, name] of Object.entries(EASYMIDI_INPUT_TYPES)) {
      const hex = Number(nibble).toString(16).toUpperCase().padStart(2, '0');
      expect(src).toMatch(new RegExp(`0x${hex}:\\s*'${name}'`, 'i'));
    }
  });
});

// ---------------------------------------------------------------------------
// 1. Channel voice — the four paths must agree, byte for byte, channel by
//    channel. This is the part that already worked; it is asserted so a future
//    change cannot break one transport without breaking this suite.
// ---------------------------------------------------------------------------
describe('L03/P1 — channel voice parity (0x80–0xEF, 16 channels)', () => {
  const shapes = [
    ['Note On', (ch) => [0x90 | ch, 60, 100], 'noteon', { note: 60, velocity: 100 }],
    ['Note Off', (ch) => [0x80 | ch, 60, 64], 'noteoff', { note: 60, velocity: 64 }],
    ['Poly AT', (ch) => [0xa0 | ch, 60, 90], 'poly aftertouch', { note: 60, pressure: 90 }],
    ['CC', (ch) => [0xb0 | ch, 74, 33], 'cc', { controller: 74, value: 33 }],
    ['Program', (ch) => [0xc0 | ch, 42], 'program', { number: 42 }],
    ['Channel AT', (ch) => [0xd0 | ch, 77], 'channel aftertouch', { pressure: 77 }]
  ];

  test.each(shapes)(
    '%s decodes identically on USB/Serial/BLE/RTP, ch 0..15',
    async (_label, build, type, payload) => {
      for (let ch = 0; ch < 16; ch++) {
        const bytes = build(ch);
        const expected = [{ type, msg: { channel: ch, ...payload } }];
        expect(await decodeUsb(bytes)).toEqual(expected);
        expect(decodeSerial(bytes)).toEqual(expected);
        expect(await decodeBle(bytes)).toEqual(expected);
        expect(decodeRtp(bytes)).toEqual(expected);
      }
    }
  );

  test('Note On velocity 0 becomes a Note Off on every transport', async () => {
    const bytes = [0x90 | 7, 60, 0];
    const expected = [{ type: 'noteoff', msg: { channel: 7, note: 60, velocity: 0 } }];
    expect(await decodeUsb(bytes)).toEqual(expected);
    expect(decodeSerial(bytes)).toEqual(expected);
    expect(await decodeBle(bytes)).toEqual(expected);
    expect(decodeRtp(bytes)).toEqual(expected);
  });

  test('note/velocity boundaries 0 and 127 survive every transport', async () => {
    for (const [note, vel] of [
      [0, 1],
      [127, 127],
      [0, 127],
      [127, 1]
    ]) {
      const bytes = [0x90, note, vel];
      const expected = [{ type: 'noteon', msg: { channel: 0, note, velocity: vel } }];
      expect(await decodeUsb(bytes)).toEqual(expected);
      expect(decodeSerial(bytes)).toEqual(expected);
      expect(await decodeBle(bytes)).toEqual(expected);
      expect(decodeRtp(bytes)).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. F-38 — the F-08 class, unswept: System Real-Time + System Common on USB.
// ---------------------------------------------------------------------------
describe('L03/F-38 — System Real-Time + System Common parity (0xF1–0xFF)', () => {
  const systemCases = [
    ['0xF1 MTC quarter frame', [0xf1, 0x25], 'mtc', { bytes: [0x25] }],
    ['0xF2 Song Position Pointer', [0xf2, 0x10, 0x00], 'position', { bytes: [0x10, 0x00] }],
    ['0xF3 Song Select', [0xf3, 0x02], 'select', { bytes: [0x02] }],
    ['0xF6 Tune Request', [0xf6], 'tune', { bytes: [] }],
    ['0xF8 Clock', [0xf8], 'clock', {}],
    ['0xFA Start', [0xfa], 'start', {}],
    ['0xFB Continue', [0xfb], 'continue', {}],
    ['0xFC Stop', [0xfc], 'stop', {}],
    ['0xFE Active Sensing', [0xfe], 'sensing', {}],
    ['0xFF System Reset', [0xff], 'reset', {}]
  ];

  test.each(systemCases)(
    '%s reaches the funnel identically on Serial / BLE / RTP',
    async (_label, bytes, type, payload) => {
      const expected = [{ type, msg: payload }];
      expect(decodeSerial(bytes)).toEqual(expected);
      expect(await decodeBle(bytes)).toEqual(expected);
      expect(decodeRtp(bytes)).toEqual(expected);
    }
  );

  // F-38 — the divergence this lot was sent to find. `DeviceManager.addInput()`
  // subscribes to a fixed list of easymidi events; every event NOT in that list
  // is emitted by easymidi and never observed, so the message dies at the
  // driver boundary. Before the fix, all ten cases above produced [] on USB.
  test.each(systemCases)('%s is NOT dropped on USB', async (_label, bytes, type, payload) => {
    expect(await decodeUsb(bytes)).toEqual([{ type, msg: payload }]);
  });

  test('addInput subscribes to every easymidi event the other transports honour', () => {
    const subscribed = usbSubscribedEvents();
    // 'tune' has no easymidi payload but is a real System Common message;
    // 'activesense' is easymidi's name for 0xFE (canonical type: 'sensing').
    for (const evt of [
      'noteon',
      'noteoff',
      'cc',
      'program',
      'pitch',
      'poly aftertouch',
      'channel aftertouch',
      'sysex',
      'mtc',
      'position',
      'select',
      'tune',
      'clock',
      'start',
      'continue',
      'stop',
      'activesense',
      'reset'
    ]) {
      expect([evt, subscribed.has(evt)]).toEqual([evt, true]);
    }
  });

  test('undefined status bytes are ignored identically everywhere', async () => {
    // 0xF4 / 0xF5 (undefined System Common), 0xF9 / 0xFD (undefined real-time)
    // and a stray 0xF7 outside a SysEx frame must all be swallowed silently.
    for (const b of [0xf4, 0xf5, 0xf9, 0xfd, 0xf7]) {
      expect(decodeSerial([b])).toEqual([]);
      expect(await decodeBle([b])).toEqual([]);
      expect(await decodeUsb([b])).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. F-39 / F-40 — same message, different payload SHAPE per transport.
// ---------------------------------------------------------------------------
describe('L03/F-39,F-40 — payload-shape parity at the funnel', () => {
  test('F-40 — pitch bend carries the same 14-bit value AND the same keys', async () => {
    for (const [lsb, msb, raw] of [
      [0x00, 0x00, 0],
      [0x00, 0x40, 8192],
      [0x7f, 0x7f, 16383],
      [0x01, 0x00, 1],
      [0x7f, 0x7e, 16255]
    ]) {
      const bytes = [0xe0 | 3, lsb, msb];
      const paths = {
        usb: await decodeUsb(bytes),
        serial: decodeSerial(bytes),
        ble: await decodeBle(bytes),
        rtp: decodeRtp(bytes)
      };
      for (const [name, ev] of Object.entries(paths)) {
        expect([name, ev.length]).toEqual([name, 1]);
        expect([name, ev[0].type]).toEqual([name, 'pitchbend']);
        // Both keys must be present and agree, whatever the transport, so a
        // consumer reading `.value` (UI / lighting rules / router filters) and
        // one reading `.value14` (encoders) see the same number.
        expect([name, ev[0].msg.value]).toEqual([name, raw]);
        expect([name, ev[0].msg.value14]).toEqual([name, raw]);
      }
    }
  });

  test('F-39 — SysEx payload shape still differs between USB and the rest', async () => {
    const gmReset = [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7];
    const usb = await decodeUsb(gmReset);
    const serial = decodeSerial(gmReset);
    expect(usb[0].type).toBe('sysex');
    expect(serial[0].type).toBe('sysex');
    // The BYTES agree…
    const bytesOf = (m) => (Array.isArray(m) ? m : m.bytes);
    expect(bytesOf(usb[0].msg)).toEqual(gmReset);
    expect(bytesOf(serial[0].msg)).toEqual(gmReset);
    // …but the SHAPE does not. `handleMidiMessage` copes internally, yet the
    // `midi_message` EventBus event and the `midi_event` WS broadcast forward
    // `msg` verbatim, so every downstream consumer must handle both forms.
    // Documented divergence — see 03_MIDI_CORE.md F-39.
    expect(Array.isArray(usb[0].msg)).toBe(false);
    expect(Array.isArray(serial[0].msg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. D02 — running status, on a REAL byte stream (never tested before).
// ---------------------------------------------------------------------------
describe('L03/D02 — running status on a real byte stream', () => {
  const noteOn = (n) => ({ type: 'noteon', msg: { channel: 0, note: n, velocity: 100 } });

  test('implicit status is reused across several messages (serial)', () => {
    expect(decodeSerial([0x90, 60, 100, 62, 100, 64, 100])).toEqual([
      noteOn(60),
      noteOn(62),
      noteOn(64)
    ]);
  });

  test('a System Real-Time byte mid-run does NOT break running status', () => {
    // 0xF8 may appear between any two bytes, including between the data bytes
    // of a running-status message (MIDI 1.0). It must be emitted and the latch
    // must survive.
    expect(decodeSerial([0x90, 60, 100, 0xf8, 62, 100])).toEqual([
      noteOn(60),
      { type: 'clock', msg: {} },
      noteOn(62)
    ]);
    expect(decodeSerial([0x90, 60, 0xf8, 100])).toEqual([{ type: 'clock', msg: {} }, noteOn(60)]);
  });

  test('a System Common byte CANCELS running status (MIDI 1.0)', () => {
    // After 0xF6 the trailing `62 100` are orphan data bytes and must NOT be
    // reassembled into a note.
    expect(decodeSerial([0x90, 60, 100, 0xf6, 62, 100])).toEqual([
      noteOn(60),
      { type: 'tune', msg: { bytes: [] } }
    ]);
    // Same rule for an undefined System Common (0xF4).
    expect(decodeSerial([0x90, 60, 100, 0xf4, 62, 100])).toEqual([noteOn(60)]);
  });

  test('SysEx cancels running status', () => {
    expect(decodeSerial([0x90, 60, 100, 0xf0, 0x7e, 0xf7, 62, 100])).toEqual([
      noteOn(60),
      { type: 'sysex', msg: [0xf0, 0x7e, 0xf7] }
    ]);
  });

  test('an orphan data byte at the head of the stream is discarded', () => {
    expect(decodeSerial([0x40, 0x90, 60, 100])).toEqual([noteOn(60)]);
  });

  test('a message truncated by the end of a buffer is completed by the next', () => {
    expect(decodeSerial(null, [[0x90, 60], [100]])).toEqual([noteOn(60)]);
    expect(decodeSerial(null, [[0x90], [60], [100]])).toEqual([noteOn(60)]);
    // …and stays pending, never half-emitted, while it is incomplete.
    expect(decodeSerial([0x90, 60])).toEqual([]);
  });

  test('running status survives a buffer boundary', () => {
    expect(
      decodeSerial(null, [
        [0x90, 60, 100],
        [62, 100]
      ])
    ).toEqual([noteOn(60), noteOn(62)]);
  });

  test('BLE honours running status inside a packet and drops it after System Common', async () => {
    expect(await decodeBle(null, [[0x80, 0x80, 0x90, 60, 100, 0x80, 62, 100]])).toEqual([
      noteOn(60),
      noteOn(62)
    ]);
    expect(await decodeBle(null, [[0x80, 0x80, 0x90, 60, 100, 0x80, 0xf6, 0x80, 62, 100]])).toEqual(
      [noteOn(60), { type: 'tune', msg: { bytes: [] } }]
    );
  });

  test('RTP honours running status and cancels it after System Common', () => {
    expect(decodeRtp(null, [Buffer.from([7, 0x90, 60, 100, 0x00, 62, 100])])).toEqual([
      noteOn(60),
      noteOn(62)
    ]);
    expect(decodeRtp(null, [Buffer.from([9, 0x90, 60, 100, 0x00, 0xf6, 0x00, 62, 100])])).toEqual([
      noteOn(60),
      { type: 'tune', msg: { bytes: [] } }
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. D03 — SysEx framing.
// ---------------------------------------------------------------------------
describe('L03/D03 — SysEx framing parity', () => {
  const yamahaXgReset = [0xf0, 0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7];
  const rolandGsReset = [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7];
  const gmReset = [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7];
  const identityRequest = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];

  test.each([
    ['GM System On', gmReset],
    ['GM Identity Request', identityRequest],
    ['Roland GS Reset', rolandGsReset],
    ['Yamaha XG Reset', yamahaXgReset]
  ])('%s is forwarded whole and unmodified on every transport', async (_label, frame) => {
    const bytesOf = (m) => (Array.isArray(m) ? m : m.bytes);
    for (const ev of [
      await decodeUsb(frame),
      decodeSerial(frame),
      await decodeBle(frame),
      decodeRtp(frame)
    ]) {
      expect(ev).toHaveLength(1);
      expect(ev[0].type).toBe('sysex');
      expect(bytesOf(ev[0].msg)).toEqual(frame);
    }
  });

  test('a SysEx fragmented across two chunks is reassembled on serial and BLE', async () => {
    expect(
      decodeSerial(null, [
        [0xf0, 0x43, 0x10],
        [0x4c, 0xf7]
      ])
    ).toEqual([{ type: 'sysex', msg: [0xf0, 0x43, 0x10, 0x4c, 0xf7] }]);
    expect(
      await decodeBle(null, [
        [0x80, 0x80, 0xf0, 0x43, 0x10],
        [0x80, 0x4c, 0x80, 0xf7]
      ])
    ).toEqual([{ type: 'sysex', msg: [0xf0, 0x43, 0x10, 0x4c, 0xf7] }]);
  });

  // F-41 — RTP-MIDI has NO cross-packet SysEx reassembly. RFC 6295 allows a
  // SysEx to be split across packets; serial and BLE both reassemble, RTP does
  // not: it emits the head as if it were a complete frame and loses the tail.
  // Owner: src/transports/RtpMidiSession.js → lot L04. Documented, not fixed.
  test('F-41 — RTP does NOT reassemble a SysEx split across two packets', () => {
    const got = decodeRtp(null, [Buffer.from([3, 0xf0, 0x43, 0x10]), Buffer.from([2, 0x4c, 0xf7])]);
    // A truncated, unterminated SysEx is delivered as if it were complete…
    expect(got).toEqual([{ type: 'sysex', msg: [0xf0, 0x43, 0x10] }]);
    // …and the continuation never produces a second, complete frame.
    expect(got.filter((e) => e.type === 'sysex')).toHaveLength(1);
  });

  test('a System Real-Time byte inside a SysEx is legal and breaks nothing', async () => {
    expect(decodeSerial([0xf0, 0x43, 0xf8, 0x10, 0xf7])).toEqual([
      { type: 'clock', msg: {} },
      { type: 'sysex', msg: [0xf0, 0x43, 0x10, 0xf7] }
    ]);
    expect(await decodeBle(null, [[0x80, 0x80, 0xf0, 0x43, 0xf8, 0x10, 0x80, 0xf7]])).toEqual([
      { type: 'clock', msg: {} },
      { type: 'sysex', msg: [0xf0, 0x43, 0x10, 0xf7] }
    ]);
  });

  test('a SysEx truncated by a new status byte is discarded, not emitted', () => {
    expect(decodeSerial([0xf0, 0x43, 0x10, 0x90, 60, 100])).toEqual([
      { type: 'noteon', msg: { channel: 0, note: 60, velocity: 100 } }
    ]);
  });

  test('an oversized SysEx is dropped rather than growing without bound', () => {
    // MAX_SYSEX_BUFFER_SIZE is 65 536 in SerialMidiManager.
    const huge = [0xf0, ...new Array(70000).fill(0x01), 0xf7];
    const got = decodeSerial(huge);
    expect(got).toEqual([]);
    // …and the parser recovers: the next well-formed message still decodes.
    expect(decodeSerial([...huge, 0x90, 60, 100])).toEqual([
      { type: 'noteon', msg: { channel: 0, note: 60, velocity: 100 } }
    ]);
  });

  test('a 4 KB SysEx below the cap survives intact on serial and BLE', async () => {
    const body = Array.from({ length: 4096 }, (_v, i) => i % 128);
    const frame = [0xf0, 0x7d, ...body, 0xf7];
    expect(decodeSerial(frame)).toEqual([{ type: 'sysex', msg: frame }]);
    // Same payload through BLE, chunked into 20-byte notifications.
    const packets = [];
    for (let i = 0; i < frame.length; i += 18) {
      packets.push([0x80, 0x80, ...frame.slice(i, i + 18)]);
    }
    const got = await decodeBle(null, packets);
    expect(got).toHaveLength(1);
    expect(got[0].msg).toEqual(frame);
  });
});

// ---------------------------------------------------------------------------
// 6. Under-covered channel messages: RPN / NRPN, 14-bit CC, bank select.
// ---------------------------------------------------------------------------
describe('L03/D01 — RPN, NRPN, 14-bit CC, bank select', () => {
  const ccPairs = (evts) => evts.map((e) => [e.type, e.msg.controller, e.msg.value]);

  test('a full RPN 0 (pitch-bend sensitivity) sequence survives every transport', async () => {
    // CC101/100 select the RPN, CC6/38 are the MSB/LSB data entry, CC101/100
    // = 127 is the null RPN that closes the sequence.
    const rpn = [
      0xb0, 101, 0, 0xb0, 100, 0, 0xb0, 6, 12, 0xb0, 38, 0, 0xb0, 101, 127, 0xb0, 100, 127
    ];
    const expected = [
      ['cc', 101, 0],
      ['cc', 100, 0],
      ['cc', 6, 12],
      ['cc', 38, 0],
      ['cc', 101, 127],
      ['cc', 100, 127]
    ];
    expect(ccPairs(await decodeUsb(rpn))).toEqual(expected);
    expect(ccPairs(decodeSerial(rpn))).toEqual(expected);
    expect(ccPairs(await decodeBle(rpn))).toEqual(expected);
    expect(ccPairs(decodeRtp(rpn))).toEqual(expected);
  });

  test('an NRPN sequence survives every transport, in order', async () => {
    const nrpn = [0xb0, 99, 1, 0xb0, 98, 20, 0xb0, 6, 64, 0xb0, 38, 5];
    const expected = [
      ['cc', 99, 1],
      ['cc', 98, 20],
      ['cc', 6, 64],
      ['cc', 38, 5]
    ];
    expect(ccPairs(await decodeUsb(nrpn))).toEqual(expected);
    expect(ccPairs(decodeSerial(nrpn))).toEqual(expected);
    expect(ccPairs(await decodeBle(nrpn))).toEqual(expected);
    expect(ccPairs(decodeRtp(nrpn))).toEqual(expected);
  });

  test('a 14-bit CC (MSB 0..31 + LSB 32..63) keeps both halves and their order', async () => {
    // CC7 volume MSB then CC39 (7+32) volume LSB.
    const stream = [0xb0, 7, 100, 0xb0, 39, 64];
    const expected = [
      ['cc', 7, 100],
      ['cc', 39, 64]
    ];
    expect(ccPairs(await decodeUsb(stream))).toEqual(expected);
    expect(ccPairs(decodeSerial(stream))).toEqual(expected);
    expect(ccPairs(await decodeBle(stream))).toEqual(expected);
    expect(ccPairs(decodeRtp(stream))).toEqual(expected);
  });

  test('bank select (CC0 + CC32) followed by Program Change keeps its order', async () => {
    const stream = [0xb0, 0, 1, 0xb0, 32, 3, 0xc0, 40];
    const expected = [
      { type: 'cc', msg: { channel: 0, controller: 0, value: 1 } },
      { type: 'cc', msg: { channel: 0, controller: 32, value: 3 } },
      { type: 'program', msg: { channel: 0, number: 40 } }
    ];
    expect(await decodeUsb(stream)).toEqual(expected);
    expect(decodeSerial(stream)).toEqual(expected);
    expect(await decodeBle(stream)).toEqual(expected);
    expect(decodeRtp(stream)).toEqual(expected);
  });

  test('channel vs poly aftertouch are never confused', async () => {
    const stream = [0xa1, 60, 90, 0xd1, 90];
    const expected = [
      { type: 'poly aftertouch', msg: { channel: 1, note: 60, pressure: 90 } },
      { type: 'channel aftertouch', msg: { channel: 1, pressure: 90 } }
    ];
    expect(await decodeUsb(stream)).toEqual(expected);
    expect(decodeSerial(stream)).toEqual(expected);
    expect(await decodeBle(stream)).toEqual(expected);
    expect(decodeRtp(stream)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// 7. handleRawMidi hardening (F-42): the shared raw entry must not manufacture
//    data the wire never carried.
// ---------------------------------------------------------------------------
describe('L03/F-42 — handleRawMidi robustness', () => {
  let dm, seen;
  beforeEach(() => {
    ({ dm, seen } = capturingManager());
  });

  test('a truncated channel-voice frame is rejected, not half-decoded', () => {
    // `{velocity: undefined}` used to flow through; MidiUtils.convertToMidiBytes
    // then re-encodes it as `(undefined ?? 127) & 0x7f` = **velocity 127**, i.e.
    // a truncated frame turned into a full-velocity note on every re-encoding
    // transport. Serial/BLE/RTP all withhold an incomplete frame.
    dm.handleRawMidi('d', [0x90, 60]);
    dm.handleRawMidi('d', [0xb0, 7]);
    dm.handleRawMidi('d', [0xe0, 0x00]);
    dm.handleRawMidi('d', [0xc0]);
    dm.handleRawMidi('d', [0xd0]);
    expect(seen).toEqual([]);
  });

  test('data bytes are masked to 7 bits like every other transport', () => {
    dm.handleRawMidi('d', [0x90, 200, 300]);
    expect(seen).toEqual([
      { type: 'noteon', msg: { channel: 0, note: 200 & 0x7f, velocity: 300 & 0x7f } }
    ]);
  });

  test('empty / non-array input is ignored without throwing', () => {
    expect(() => dm.handleRawMidi('d', [])).not.toThrow();
    expect(() => dm.handleRawMidi('d', null)).not.toThrow();
    expect(() => dm.handleRawMidi('d', undefined)).not.toThrow();
    expect(seen).toEqual([]);
  });

  test('documented precondition: exactly ONE message per call', () => {
    // Every caller (BLE parser, RTP parser, NetworkManager) frames its input
    // one message at a time. Passing two concatenated messages decodes only the
    // first — asserted so the precondition stays visible.
    dm.handleRawMidi('d', [0x90, 60, 100, 0x90, 62, 100]);
    expect(seen).toEqual([{ type: 'noteon', msg: { channel: 0, note: 60, velocity: 100 } }]);
  });
});
