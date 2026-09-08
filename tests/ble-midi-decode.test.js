// tests/ble-midi-decode.test.js
// Direct coverage of the Apple BLE-MIDI inbound decoder
// (BluetoothManager._handleIncomingMidi). The decoder is self-contained
// (uses only _getBleParseState + emit), so we drive it via prototype-call with
// a minimal context — no DB / native BLE binding needed.
//
// Audit BLE#1: a SysEx aborted by a status byte (device sends a new message
// instead of 0xF7) must terminate the SysEx and emit the new message, not eat
// the status as a timestamp (which lost the message and stuck the SysEx open).

import { describe, test, expect } from '@jest/globals';
import BluetoothManager from '../src/transports/BluetoothManager.js';

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
    feed: (bytes) =>
      BluetoothManager.prototype._handleIncomingMidi.call(ctx, 'AA', Buffer.from(bytes)),
    emitted,
    sysex: () => states.get('AA')?.sysex ?? null
  };
}

const HDR = 0x80; // packet header (ts-high = 0)
const TS = 0x80; // per-message timestamp (ts-low = 0)

describe('BLE decoder — baseline (must keep working)', () => {
  test('single channel-voice message', () => {
    const d = makeDecoder();
    d.feed([HDR, TS, 0x90, 0x3c, 0x64]);
    expect(d.emitted).toEqual([[0x90, 0x3c, 0x64]]);
  });

  test('two messages in one packet', () => {
    const d = makeDecoder();
    d.feed([HDR, TS, 0x90, 0x3c, 0x64, TS, 0x80, 0x3c, 0x00]);
    expect(d.emitted).toEqual([
      [0x90, 0x3c, 0x64],
      [0x80, 0x3c, 0x00]
    ]);
  });

  test('running status within a packet', () => {
    const d = makeDecoder();
    d.feed([HDR, TS, 0x90, 0x3c, 0x64, TS, 0x3e, 0x64]);
    expect(d.emitted).toEqual([
      [0x90, 0x3c, 0x64],
      [0x90, 0x3e, 0x64]
    ]);
  });

  test('real-time byte between messages', () => {
    const d = makeDecoder();
    d.feed([HDR, TS, 0xf8, TS, 0x90, 0x3c, 0x64]);
    expect(d.emitted).toEqual([[0xf8], [0x90, 0x3c, 0x64]]);
  });

  test('cross-packet SysEx terminated by F7', () => {
    const d = makeDecoder();
    d.feed([HDR, TS, 0xf0, 0x7e, 0x00]); // open
    expect(d.sysex()).not.toBeNull();
    d.feed([HDR, 0x11, 0x22, TS, 0xf7]); // continuation data then [ts][F7]
    expect(d.emitted).toEqual([[0xf0, 0x7e, 0x00, 0x11, 0x22, 0xf7]]);
    expect(d.sysex()).toBeNull();
  });

  test('real-time byte inside a SysEx does NOT terminate it', () => {
    const d = makeDecoder();
    d.feed([HDR, TS, 0xf0, 0x43]); // open
    d.feed([HDR, TS, 0xf8]); // realtime mid-SysEx
    expect(d.emitted).toEqual([[0xf8]]);
    expect(d.sysex()).not.toBeNull();
    d.feed([HDR, TS, 0xf7]); // close
    expect(d.emitted).toEqual([[0xf8], [0xf0, 0x43, 0xf7]]);
    expect(d.sysex()).toBeNull();
  });
});

describe('BLE decoder — SysEx aborted by a status byte (audit BLE#1)', () => {
  test('a Note-On aborting an open SysEx is emitted (not lost); SysEx discarded', () => {
    const d = makeDecoder();
    d.feed([HDR, TS, 0xf0, 0x43, 0x10]); // open SysEx (no F7)
    expect(d.sysex()).not.toBeNull();
    d.feed([HDR, TS, 0x90, 0x3c, 0x64]); // device aborts with a Note-On instead of F7
    expect(d.emitted).toEqual([[0x90, 0x3c, 0x64]]); // note-on recovered
    expect(d.sysex()).toBeNull(); // SysEx discarded, not corrupted/stuck
  });

  test('abort within the same packet after SysEx data', () => {
    const d = makeDecoder();
    // [ts][F0][data][ts][90 3C 64] in one packet
    d.feed([HDR, TS, 0xf0, 0x43, TS, 0x90, 0x3c, 0x64]);
    expect(d.emitted).toEqual([[0x90, 0x3c, 0x64]]);
    expect(d.sysex()).toBeNull();
  });
});
