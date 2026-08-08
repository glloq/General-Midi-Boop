// tests/ble-midi-encode.test.js
// Apple BLE-MIDI packet framing: channel-voice messages are a single
// [header, timestamp, ...data] packet; SysEx carries a timestamp before F0 and
// before F7 and is fragmented across MTU-sized packets (audit P2).

import { describe, test, expect } from '@jest/globals';
import BluetoothManager from '../src/transports/BluetoothManager.js';

const enc = (data, mtu) => BluetoothManager.encodeBleMidiPackets(data, mtu);

describe('BLE-MIDI packet encoding', () => {
  test('note-on → one packet: header, timestamp, then the 3 MIDI bytes', () => {
    const packets = enc([0x90, 60, 100]);
    expect(packets).toHaveLength(1);
    const p = packets[0];
    expect(p).toHaveLength(5);
    expect(p[0] & 0x80).toBe(0x80); // header high bit
    expect(p[1] & 0x80).toBe(0x80); // timestamp high bit
    expect(Array.from(p.slice(2))).toEqual([0x90, 60, 100]);
  });

  test('short SysEx: timestamp precedes both F0 and F7, single packet', () => {
    // Universal Identity Request: F0 7E 7F 06 01 F7
    const packets = enc([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
    expect(packets).toHaveLength(1);
    const p = Array.from(packets[0]);
    // header, ts, F0, 7E, 7F, 06, 01, ts, F7
    expect(p[0] & 0x80).toBe(0x80); // header
    expect(p[1] & 0x80).toBe(0x80); // ts before F0
    expect(p[2]).toBe(0xf0);
    expect(p[p.length - 1]).toBe(0xf7);
    expect(p[p.length - 2] & 0x80).toBe(0x80); // ts before F7
  });

  test('long SysEx is fragmented to the MTU, every packet prefixed with a header', () => {
    const big = [0xf0, ...new Array(60).fill(0x01), 0xf7];
    const packets = enc(big, 10);
    expect(packets.length).toBeGreaterThan(1);
    for (const p of packets) {
      expect(p.length).toBeLessThanOrEqual(10);
      expect(p[0] & 0x80).toBe(0x80); // running header on each packet
    }
    // The very last byte across the stream is the terminating F7.
    const last = packets[packets.length - 1];
    expect(last[last.length - 1]).toBe(0xf7);
  });

  test('empty input yields no packets', () => {
    expect(enc([])).toEqual([]);
  });
});

// --- Audit BLE#3: the terminating timestamp must never be split from 0xF7 ---
//
// Under the old flat chunking, a SysEx whose raw length is 18/37/56/… placed the
// 0xF7 at the start of a fresh packet, stranding its timestamp in the previous
// one. Assert same-packet adjacency, MTU compliance, and encode→decode fidelity.

function sysexOfLength(total) {
  const mid = [];
  for (let i = 0; i < total - 2; i++) mid.push(i % 0x80);
  return [0xf0, ...mid, 0xf7];
}

function makeDecoder() {
  const emitted = [];
  const states = new Map();
  const ctx = {
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    _getBleParseState(addr) {
      if (!states.has(addr)) states.set(addr, { sysex: null });
      return states.get(addr);
    },
    emit(ev, payload) {
      if (ev === 'midi:data') emitted.push(payload.data);
    }
  };
  return {
    feedFrame: (frame) =>
      BluetoothManager.prototype._handleIncomingMidi.call(ctx, 'AA', Buffer.from(frame)),
    emitted
  };
}

describe('BLE-MIDI encoding — timestamp never split from F7 (audit BLE#3)', () => {
  for (const len of [17, 18, 19, 36, 37, 38, 55, 56, 57]) {
    test(`SysEx length ${len}: F7 keeps its timestamp in the same packet`, () => {
      const packets = enc(sysexOfLength(len), 20);
      const last = packets[packets.length - 1];
      expect(last[last.length - 1]).toBe(0xf7);
      expect(last[last.length - 2] & 0x80).toBe(0x80); // ts immediately before F7
      expect(last.length).toBeGreaterThanOrEqual(3); // header + ts + F7
      for (const p of packets) {
        expect(p.length).toBeLessThanOrEqual(20);
        // 0xF7 is never the first payload byte (that would strand its timestamp).
        for (let i = 1; i < p.length; i++) {
          if (p[i] === 0xf7) expect(i).toBeGreaterThan(1);
        }
      }
    });
  }

  test('encode→decode round-trips SysEx of many lengths (incl. old split cases)', () => {
    for (const len of [3, 5, 17, 18, 19, 37, 40, 56, 64]) {
      const original = sysexOfLength(len);
      const d = makeDecoder();
      enc(original, 20).forEach((p) => d.feedFrame(p));
      expect(d.emitted).toEqual([original]);
    }
  });
});
